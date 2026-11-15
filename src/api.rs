//! 本地 Web 控制台 HTTP 层：所有业务动作都复用 commands::dispatch 单一命令面。
use crate::commands::{self, CommandContext};
use crate::danmu::DanmuHub;
use axum::{
    body::to_bytes,
    extract::{Query, Request, State},
    http::Method,
    http::{header, HeaderValue, StatusCode, Uri},
    middleware::{self, Next},
    response::sse::{Event, KeepAlive},
    response::{IntoResponse, Response, Sse},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::{collections::HashMap, net::SocketAddr};

const MAX_BODY: usize = 1024 * 1024;
#[derive(Clone)]
pub struct ApiState {
    pub ctx: CommandContext,
    pub danmu: DanmuHub,
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}
impl ApiError {
    fn bad(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: msg.into(),
        }
    }
    fn not_found(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: msg.into(),
        }
    }
    fn internal(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: msg.into(),
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"ok": false, "error": self.message})),
        )
            .into_response()
    }
}
type ApiResult = Result<Json<Value>, ApiError>;

async fn call(State(st): State<ApiState>, name: &'static str, args: Value) -> ApiResult {
    let ctx = st.ctx.clone();
    tokio::task::spawn_blocking(move || commands::dispatch(&ctx, name, &args))
        .await
        .map_err(|e| ApiError::internal(format!("命令执行线程异常: {e}")))?
        .map(Json)
        .map_err(|e| ApiError::bad(e.to_string()))
}

fn map_arg(v: &Value, key: &str, target: &str) -> Value {
    let mut out = json!({});
    if let Some(x) = v.get(key) {
        out[target] = x.clone();
    }
    out
}

async fn body_json(req: Request) -> Result<Value, ApiError> {
    let bytes = to_bytes(req.into_body(), MAX_BODY)
        .await
        .map_err(|e| ApiError::bad(format!("请求体过大或读取失败: {e}")))?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes).map_err(|e| ApiError::bad(format!("请求体不是合法 JSON: {e}")))
}

// Host is a URI authority and Origin is a serialized origin (scheme + authority
// only). Be strict: DNS suffixes such as 127.evil.example must never be mistaken
// for 127.0.0.0/8, and malformed ports or userinfo must not be silently ignored.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        return false;
    }
    let mut bracketed = false;
    let (h, port) = if let Some(rest) = host.strip_prefix('[') {
        bracketed = true;
        let Some((inside, tail)) = rest.split_once(']') else {
            return false;
        };
        if tail.is_empty() {
            (inside, None)
        } else if let Some(port) = tail.strip_prefix(':') {
            (inside, Some(port))
        } else {
            return false;
        }
    } else if let Some((h, port)) = host.split_once(':') {
        if port.contains(':') {
            return false;
        }
        (h, Some(port))
    } else {
        (host.as_str(), None)
    };
    if let Some(port) = port {
        if port.is_empty()
            || port.len() > 5
            || !port.bytes().all(|b| b.is_ascii_digit())
            || port.parse::<u16>().is_err()
        {
            return false;
        }
    }
    h == "localhost" || (bracketed && h == "::1") || is_loopback_ipv4(h)
}

fn is_loopback_ipv4(h: &str) -> bool {
    let mut parts = h.split('.');
    let (Some(first), Some(second), Some(third), Some(fourth), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return false;
    };
    first == "127"
        && [first, second, third, fourth].iter().all(|part| {
            !part.is_empty()
                && part.len() <= 3
                && part.bytes().all(|b| b.is_ascii_digit())
                && part.parse::<u8>().is_ok()
        })
}

fn origin_host(origin: &str) -> Option<&str> {
    let s = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))?;
    let forbidden = ['/', '?', '#', '@', '\\'];
    if s.is_empty()
        || s.contains(&forbidden[..])
        || s.chars().any(char::is_whitespace)
        || s.starts_with('[') && !s.contains(']')
    {
        return None;
    }
    Some(s)
}
async fn security_mw(request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if !is_loopback_host(&host) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"ok": false, "error": "仅允许本机访问"})),
        )
            .into_response();
    }
    if request.method() == Method::POST {
        if let Some(o) = origin {
            let oh = origin_host(&o).unwrap_or("");
            if !is_loopback_host(oh) {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({"ok": false, "error": "跨站 POST 已拒绝"})),
                )
                    .into_response();
            }
        }
    }
    next.run(request).await
}

pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/session", get(session))
        .route("/api/login/qrcode", post(login_qrcode))
        .route("/api/login/poll", get(login_poll))
        .route("/api/login/logout", post(login_logout))
        .route("/api/room", get(room))
        .route("/api/partitions", get(partitions))
        .route("/api/title", post(title))
        .route("/api/area", post(area))
        .route("/api/announcement", post(announcement))
        .route("/api/live/start", post(live_start))
        .route("/api/live/stop", post(live_stop))
        .route("/api/stream-key", get(stream_key))
        .route("/api/danmu/status", get(danmu_status))
        .route("/api/danmu/start", post(danmu_start))
        .route("/api/danmu/stop", post(danmu_stop))
        .route("/api/danmu/send", post(danmu_send))
        .route("/api/danmu/events", get(danmu_events))
        .route("/api/commands", get(commands))
        .route("/api/config", get(config).post(config_set))
        .with_state(state)
        .fallback(static_file)
        // 安全层放在 fallback 之后，确保静态资源与未知 /api/ 路径也受保护。
        .layer(middleware::from_fn(security_mw))
}

macro_rules! get0 {
    ($fn:ident, $cmd:literal) => {
        async fn $fn(State(st): State<ApiState>) -> ApiResult {
            call(State(st), $cmd, json!({})).await
        }
    };
}
get0!(health, "health");
get0!(session, "session");
get0!(room, "room");
get0!(partitions, "partitions");
get0!(danmu_status, "danmu-status");
get0!(danmu_stop, "danmu-stop");
get0!(commands, "commands");
get0!(config, "config");

macro_rules! post0 {
    ($fn:ident, $cmd:literal) => {
        async fn $fn(State(st): State<ApiState>, req: Request) -> ApiResult {
            let _ = body_json(req).await?;
            call(State(st), $cmd, json!({})).await
        }
    };
}
post0!(login_qrcode, "login-qrcode");
post0!(login_logout, "login-logout");
post0!(live_stop, "live-stop");

async fn login_poll(
    State(st): State<ApiState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult {
    let key = q.get("key").cloned().unwrap_or_default();
    if key.is_empty() {
        return Err(ApiError::bad("缺少 key"));
    }
    call(State(st), "login-poll", json!({"key": key})).await
}
async fn title(State(st): State<ApiState>, req: Request) -> ApiResult {
    let b = body_json(req).await?;
    let a = map_arg(&b, "title", "title");
    call(State(st), "title", a).await
}
async fn area(State(st): State<ApiState>, req: Request) -> ApiResult {
    let b = body_json(req).await?;
    let a = map_arg(&b, "areaId", "area-id");
    call(State(st), "area", a).await
}
async fn announcement(State(st): State<ApiState>, req: Request) -> ApiResult {
    let b = body_json(req).await?;
    let a = map_arg(&b, "content", "content");
    call(State(st), "announcement", a).await
}
async fn live_start(State(st): State<ApiState>, req: Request) -> ApiResult {
    let b = body_json(req).await?;
    let a = map_arg(&b, "areaId", "area-id");
    call(State(st), "live-start", a).await
}
async fn stream_key(
    State(st): State<ApiState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult {
    let reveal = q
        .get("reveal")
        .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    call(State(st), "stream-key", json!({"reveal": reveal})).await
}
async fn danmu_start(State(st): State<ApiState>, req: Request) -> ApiResult {
    let b = body_json(req).await?;
    let a = map_arg(&b, "roomId", "room-id");
    call(State(st), "danmu-start", a).await
}
async fn danmu_send(State(st): State<ApiState>, req: Request) -> ApiResult {
    let b = body_json(req).await?;
    let a = map_arg(&b, "msg", "msg");
    call(State(st), "danmu-send", a).await
}
async fn config_set(State(st): State<ApiState>, req: Request) -> ApiResult {
    let b = body_json(req).await?;
    let a = map_arg(&b, "rememberLogin", "remember-login");
    call(State(st), "config-set", a).await
}

async fn danmu_events(
    State(st): State<ApiState>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, std::convert::Infallible>>>, ApiError>
{
    let mut rx = st.danmu.subscribe();
    let stream = async_stream::stream! {
        while let Some(item) = rx.recv().await {
            let text = serde_json::to_string(&item).unwrap_or_else(|_| "{}".into());
            yield Ok(Event::default().data(text));
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn static_file(uri: Uri) -> Response {
    let path = uri.path();
    if path.starts_with("/api/") {
        return ApiError::not_found("未知接口").into_response();
    }
    let Some(file) = crate::assets::get(path) else {
        return ApiError::not_found("页面不存在").into_response();
    };
    let mime = if std::path::Path::new(path).extension().is_none() {
        mime_guess::mime::TEXT_HTML_UTF_8.to_string()
    } else {
        mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string()
    };
    let cache = if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut resp = (StatusCode::OK, file.contents().to_vec()).into_response();
    if let Ok(v) = HeaderValue::from_str(&mime) {
        resp.headers_mut().insert(header::CONTENT_TYPE, v);
    }
    if let Ok(v) = HeaderValue::from_str(cache) {
        resp.headers_mut().insert(header::CACHE_CONTROL, v);
    }
    resp
}

pub async fn serve(state: ApiState, port: u16, open_browser: bool) -> anyhow::Result<()> {
    if !crate::assets::embedded() {
        anyhow::bail!("Web 控制台静态资源未嵌入，请先在 web/ 执行 pnpm build");
    }
    let app = router(state);
    let mut listener = None;
    let mut bound_port = port;
    for p in port..port.saturating_add(20) {
        let addr = SocketAddr::from(([127, 0, 0, 1], p));
        if let Ok(l) = tokio::net::TcpListener::bind(addr).await {
            listener = Some(l);
            bound_port = p;
            break;
        }
    }
    let listener = listener.ok_or_else(|| anyhow::anyhow!("127.0.0.1:{port} 附近无可用端口"))?;
    let url = format!("http://127.0.0.1:{bound_port}/");
    tracing::info!("lyblive Web 控制台: {url}");
    println!("{url}");
    #[cfg(all(
        feature = "browser",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    if open_browser {
        let _ = webbrowser::open(&url);
    }
    #[cfg(not(all(
        feature = "browser",
        not(any(target_os = "android", target_os = "ios"))
    )))]
    let _ = open_browser;
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;

    #[test]
    fn loopback_host_accepts_strict_ports_and_ipv6_brackets() {
        for host in [
            "localhost",
            "LOCALHOST:8765",
            "127.0.0.1:8765",
            "127.9.9.9:9000",
            "127.255.255.255:1",
            "[::1]",
            "[::1]:8765",
        ] {
            assert!(is_loopback_host(host), "expected loopback: {host}");
        }
        for host in [
            "example.com",
            "localhost.example.com:8765",
            "127.evil.example",
            "127.0.0.1.evil.example:8765",
            "127..0.1",
            "127.256.0.1:8765",
            "127.0.0.1:",
            "127.0.0.1:99999",
            "127.0.0.1:80x",
            "127.0.0.1:80:90",
            "[2001:db8::1]:8765",
            "[::1]junk",
            "[::1]:80x",
            "user@127.0.0.1:8765",
            "::1",
            "::1:8765",
        ] {
            assert!(!is_loopback_host(host), "expected rejection: {host}");
        }
    }

    #[test]
    fn origin_host_requires_scheme_and_complete_loopback_authority() {
        for (origin, expected) in [
            ("http://localhost:8765", "localhost:8765"),
            ("https://127.0.0.1:8765", "127.0.0.1:8765"),
            ("http://127.9.9.9:9000", "127.9.9.9:9000"),
            ("http://[::1]:8765", "[::1]:8765"),
        ] {
            assert_eq!(origin_host(origin), Some(expected));
            assert!(
                is_loopback_host(expected),
                "expected loopback Origin: {origin}"
            );
        }
        for origin in [
            "null",
            "//localhost:8765",
            "http://localhost:8765/",
            "http://localhost:8765/path?q=1",
            "http://localhost:8765#frag",
            "http://127.evil.example",
            "http://127.0.0.1.evil.example:8765",
            "http://user@127.0.0.1:8765",
            "http://127.0.0.1:80x",
            "http://[::1",
            "ftp://localhost:8765",
            "",
        ] {
            assert!(
                !origin_host(origin).is_some_and(is_loopback_host),
                "expected Origin rejection: {origin}"
            );
        }
    }

    #[test]
    fn camel_case_arguments_map_to_kebab_case() {
        let body = json!({"areaId": 123, "rememberLogin": true});
        assert_eq!(map_arg(&body, "areaId", "area-id"), json!({"area-id": 123}));
        assert_eq!(
            map_arg(&body, "rememberLogin", "remember-login"),
            json!({"remember-login": true})
        );
        assert_eq!(map_arg(&body, "missing", "x"), json!({}));
    }

    #[tokio::test]
    async fn body_json_accepts_empty_body_but_rejects_invalid_json() {
        let empty = body_json(Request::new(Body::empty())).await.unwrap();
        assert_eq!(empty, json!({}));
        let err = body_json(Request::new(Body::from("{not-json")))
            .await
            .unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert!(err.message.contains("不是合法 JSON"));
    }

    #[test]
    fn api_error_body_uses_frontend_contract() {
        let err = ApiError::bad("中文错误");
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    use crate::bili::{BiliApi, RawResponse, Transport};
    use crate::settings::{DiskConfig, SharedConfig};
    use crate::state::AppState;
    use std::sync::{Arc, Mutex, RwLock};
    use tower::ServiceExt;

    struct Fake(Mutex<Vec<String>>);
    impl Transport for Fake {
        fn call(
            &self,
            _m: &str,
            url: &str,
            _q: &[(String, String)],
            _f: Option<&[(String, String)]>,
            _c: Option<&str>,
        ) -> anyhow::Result<RawResponse> {
            self.0.lock().unwrap().push(url.to_string());
            Ok(RawResponse {
                body: json!({"code": 0, "data": {}}),
                set_cookies: vec![],
            })
        }
    }
    fn state_in(dir: std::path::PathBuf) -> ApiState {
        let config = SharedConfig {
            dir: dir.clone(),
            file: dir.join("config.json"),
            inner: Arc::new(RwLock::new(DiskConfig::default())),
        };
        let state = AppState::new(
            BiliApi::with_transport(Arc::new(Fake(Mutex::new(vec![])))),
            config,
        );
        let danmu = DanmuHub::new(state.clone());
        ApiState {
            ctx: CommandContext::new(state, danmu.clone()),
            danmu,
        }
    }

    fn test_state() -> ApiState {
        state_in(std::env::temp_dir().join(format!("lyblive-api-test-{}", std::process::id())))
    }

    async fn guarded(
        method: Method,
        uri: &str,
        host: &str,
        origin: Option<&str>,
        body: Option<&'static str>,
    ) -> Response {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, host);
        if let Some(origin) = origin {
            builder = builder.header(header::ORIGIN, origin);
        }
        let req = builder.body(Body::from(body.unwrap_or(""))).unwrap();
        router(test_state()).oneshot(req).await.unwrap()
    }
    async fn json_body(resp: Response) -> Value {
        let bytes = to_bytes(resp.into_body(), MAX_BODY).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn security_middleware_guards_api_routes_and_fallback() {
        for path in [
            "/",
            "/favicon.svg",
            "/assets/index-BtM6KFmi.js",
            "/api/health",
            "/api/does-not-exist",
        ] {
            let resp = guarded(Method::GET, path, "evil.example", None, None).await;
            assert_eq!(resp.status(), StatusCode::FORBIDDEN, "path {path}");
            assert_eq!(
                json_body(resp).await,
                json!({"ok": false, "error": "仅允许本机访问"})
            );
        }
        let resp = guarded(
            Method::POST,
            "/api/login/qrcode",
            "evil.example",
            Some("https://evil.example"),
            Some("{}"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert!(resp.headers().get(header::CONTENT_TYPE).is_some());
        assert_eq!(
            json_body(resp).await,
            json!({"ok": false, "error": "仅允许本机访问"})
        );
    }

    #[tokio::test]
    async fn security_middleware_rejects_cross_site_posts_but_allows_loopback() {
        for (host, origin) in [
            ("127.0.0.1:8765", "https://evil.example"),
            ("127.evil.example:8765", "http://127.0.0.1:8765"),
            ("127.0.0.1:8765", "http://127.evil.example"),
            ("127.0.0.1:8765", "http://127.0.0.1.evil.example:8765"),
            ("127.0.0.1:8765", "http://user@127.0.0.1:8765"),
            ("127.0.0.1:8765", "http://127.0.0.1:80x"),
            ("127.0.0.1:8765", "http://127.0.0.1:8765/path"),
            ("127.0.0.1:80x", "http://127.0.0.1:8765"),
        ] {
            let resp = guarded(
                Method::POST,
                "/api/login/qrcode",
                host,
                Some(origin),
                Some("{}"),
            )
            .await;
            assert_eq!(
                resp.status(),
                StatusCode::FORBIDDEN,
                "host={host} origin={origin}"
            );
            let expected = if is_loopback_host(host) {
                "跨站 POST 已拒绝"
            } else {
                "仅允许本机访问"
            };
            assert_eq!(
                json_body(resp).await,
                json!({"ok": false, "error": expected}),
                "host={host} origin={origin}"
            );
        }

        let ipv6_origin = guarded(
            Method::POST,
            "/api/danmu/stop",
            "[::1]:8765",
            Some("http://[::1]:8765"),
            Some("{}"),
        )
        .await;
        assert_eq!(ipv6_origin.status(), StatusCode::OK);
        assert_eq!(json_body(ipv6_origin).await["ok"], true);

        let root = guarded(Method::GET, "/", "127.0.0.1:8765", None, None).await;
        assert_eq!(root.status(), StatusCode::OK);
        let html = to_bytes(root.into_body(), MAX_BODY).await.unwrap();
        assert!(String::from_utf8_lossy(&html).contains("id=\"root\""));

        let health = guarded(Method::GET, "/api/health", "[::1]:8765", None, None).await;
        assert_eq!(health.status(), StatusCode::OK);
        assert_eq!(json_body(health).await["ok"], true);

        let stop = guarded(
            Method::POST,
            "/api/danmu/stop",
            "127.0.0.1:8765",
            Some("http://127.9.9.9:9000"),
            Some("{}"),
        )
        .await;
        assert_eq!(stop.status(), StatusCode::OK);
        assert_eq!(json_body(stop).await["ok"], true);
    }
    struct TempConfigDir(std::path::PathBuf);
    impl Drop for TempConfigDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn loopback_web_route_runs_agent_denied_t1_without_registry_gate() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "lyblive-web-policy-{}-{}",
            std::process::id(),
            nanos
        ));
        let _cleanup = TempConfigDir(dir.clone());
        let state = state_in(dir);

        // Web 刻意不经过 lilyco Registry 的 Agent 安全门：本机 loopback T1
        // 由人在控制台二次确认后执行。这里用 Agent 明确拒绝的 config-set 验证。
        let post = Request::builder()
            .method(Method::POST)
            .uri("/api/config")
            .header(header::HOST, "127.0.0.1:8765")
            .header(header::ORIGIN, "http://127.0.0.1:8765")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"rememberLogin":false}"#))
            .unwrap();
        let resp = router(state.clone()).oneshot(post).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(json_body(resp).await, json!({"ok": true}));

        let get = Request::builder()
            .method(Method::GET)
            .uri("/api/config")
            .header(header::HOST, "127.0.0.1:8765")
            .body(Body::empty())
            .unwrap();
        let config = json_body(router(state).oneshot(get).await.unwrap()).await;
        assert_eq!(config["ok"], json!(true));
        assert_eq!(config["config"]["rememberLogin"], json!(false));
    }
}
