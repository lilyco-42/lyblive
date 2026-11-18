//! B 站 Web API 的薄 Rust 适配层（签名、Cookie、二维码、房间、推流）。
//! 不在日志、错误或 JSON 中回传 cookie / csrf / 推流密钥。

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderMap, HeaderValue, COOKIE, REFERER, SET_COOKIE};
use serde_json::Value;

use crate::util::{form_encode, i64_val, mask, md5_hex, now_secs, obj, str_val};

const APP_KEY: &str = "aae92bc66f3edfab";
const APP_SEC: &str = "af125a0d5279fd576c1b4418a3e8276d";
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MIXIN_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

pub trait Transport: Send + Sync {
    fn call(
        &self,
        method: &str,
        url: &str,
        query: &[(String, String)],
        form: Option<&[(String, String)]>,
        cookie: Option<&str>,
    ) -> Result<RawResponse>;
}

#[derive(Debug, Clone)]
pub struct RawResponse {
    pub body: Value,
    pub set_cookies: Vec<String>,
}

#[derive(Clone)]
pub struct HttpTransport {
    client: Client,
}

/// 按目标域名选择 Referer；B 站风控会校验来源页与域名是否匹配。
pub fn referer_for(url: &str) -> &'static str {
    if url.contains("live.bilibili.com") {
        "https://live.bilibili.com/"
    } else if url.contains("passport.bilibili.com") {
        "https://passport.bilibili.com/"
    } else {
        "https://www.bilibili.com/"
    }
}

impl HttpTransport {
    pub fn new() -> Result<Self> {
        let mut h = HeaderMap::new();
        h.insert(reqwest::header::USER_AGENT, HeaderValue::from_static(UA));
        h.insert(
            reqwest::header::ACCEPT,
            HeaderValue::from_static("application/json, text/plain, */*"),
        );
        h.insert(
            reqwest::header::ACCEPT_LANGUAGE,
            HeaderValue::from_static("zh-CN,zh;q=0.9"),
        );
        let client = Client::builder()
            .default_headers(h)
            .timeout(std::time::Duration::from_secs(15))
            .build()?;
        Ok(Self { client })
    }
}

impl Transport for HttpTransport {
    fn call(
        &self,
        method: &str,
        url: &str,
        query: &[(String, String)],
        form: Option<&[(String, String)]>,
        cookie: Option<&str>,
    ) -> Result<RawResponse> {
        let mut b = self.client.request(method.parse()?, url).query(&query);
        // 缺少来源页时 nav / live 接口会走风控分支，登录后仍拿不到昵称、头像与等级。
        b = b.header(REFERER, referer_for(url));
        if let Some(c) = cookie {
            b = b.header(COOKIE, c);
        }
        if let Some(f) = form {
            b = b
                .header(
                    reqwest::header::CONTENT_TYPE,
                    "application/x-www-form-urlencoded; charset=UTF-8",
                )
                .body(form_encode(f));
        }
        let resp: Response = b.send()?.error_for_status()?;
        let set_cookies = resp
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok().map(str::to_string))
            .collect();
        let body: Value = resp.json().unwrap_or(Value::Null);
        Ok(RawResponse { body, set_cookies })
    }
}

#[derive(Clone)]
pub struct BiliApi {
    pub transport: Arc<dyn Transport>,
}

impl BiliApi {
    pub fn new() -> Self {
        Self {
            transport: Arc::new(HttpTransport::new().expect("HTTP client")),
        }
    }
    /// 测试与后续 adapter 替换用的注入点；生产入口使用 BiliApi::new()。
    #[allow(dead_code)]
    pub fn with_transport(t: Arc<dyn Transport>) -> Self {
        Self { transport: t }
    }

    fn call(
        &self,
        method: &str,
        url: &str,
        query: &[(String, String)],
        form: Option<&[(String, String)]>,
        cookie: Option<&str>,
    ) -> Result<RawResponse> {
        self.transport.call(method, url, query, form, cookie)
    }
    fn data(
        &self,
        method: &str,
        url: &str,
        query: &[(String, String)],
        form: Option<&[(String, String)]>,
        cookie: Option<&str>,
    ) -> Result<Value> {
        let raw = self.call(method, url, query, form, cookie)?;
        check_response(raw.body)
    }

    pub fn qrcode(&self) -> Result<(String, String)> {
        let d = self.data(
            "GET",
            "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
            &[],
            None,
            None,
        )?;
        Ok((str_val(&d, "url"), str_val(&d, "qrcode_key")))
    }

    pub fn poll_qrcode(&self, key: &str) -> Result<(i64, RawResponse)> {
        let raw = self.call(
            "GET",
            "https://passport.bilibili.com/x/passport-login/web/qrcode/poll",
            &[("qrcode_key".into(), key.into())],
            None,
            None,
        )?;
        let d = obj(&raw.body, "data");
        Ok((i64_val(d, "code"), raw))
    }

    pub fn nav(&self, cookie: &str) -> Result<Value> {
        self.data(
            "GET",
            "https://api.bilibili.com/x/web-interface/nav",
            &[],
            None,
            Some(cookie),
        )
    }

    pub fn room_id_by_uid(&self, cookie: &str, uid: i64) -> Result<i64> {
        let d = self.data(
            "GET",
            "https://api.live.bilibili.com/room/v2/Room/room_id_by_uid",
            &[("uid".into(), uid.to_string())],
            None,
            Some(cookie),
        )?;
        Ok(i64_val(&d, "room_id"))
    }

    pub fn area_list(&self) -> Result<Value> {
        self.data(
            "GET",
            "https://api.live.bilibili.com/room/v1/Area/getList",
            &[("show_pinyin".into(), "1".into())],
            None,
            None,
        )
    }

    pub fn room_info(&self, room_id: i64) -> Result<Value> {
        self.data(
            "GET",
            "https://api.live.bilibili.com/room/v1/Room/get_info",
            &[("room_id".into(), room_id.to_string())],
            None,
            None,
        )
    }

    pub fn room_info_live(&self, room_id: i64) -> Result<Value> {
        let d = self.data(
            "GET",
            "https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom",
            &[("room_id".into(), room_id.to_string())],
            None,
            None,
        )?;
        Ok(obj(&d, "room_info").clone())
    }

    pub fn room_news(&self, room_id: i64, uid: i64) -> Result<String> {
        let d = self.data(
            "GET",
            "https://api.live.bilibili.com/xlive/app-blink/v1/index/getRoomNews",
            &[
                ("room_id".into(), room_id.to_string()),
                ("uid".into(), uid.to_string()),
            ],
            None,
            None,
        )?;
        Ok(str_val(&d, "content"))
    }

    fn csrf_form(
        &self,
        cookie: &str,
        mut pairs: Vec<(String, String)>,
    ) -> Result<Vec<(String, String)>> {
        let csrf =
            cookie_value(cookie, "bili_jct").ok_or_else(|| anyhow!("登录态缺少 bili_jct"))?;
        pairs.push(("csrf_token".into(), csrf.clone()));
        pairs.push(("csrf".into(), csrf));
        Ok(pairs)
    }

    pub fn update_title(&self, cookie: &str, room_id: i64, title: &str) -> Result<()> {
        let f = self.csrf_form(
            cookie,
            vec![
                ("room_id".into(), room_id.to_string()),
                ("platform".into(), "web".into()),
                ("title".into(), title.into()),
            ],
        )?;
        self.data(
            "POST",
            "https://api.live.bilibili.com/room/v1/Room/update",
            &[],
            Some(&f),
            Some(cookie),
        )
        .map(|_| ())
    }

    pub fn update_area(&self, cookie: &str, room_id: i64, area_id: i64) -> Result<()> {
        let f = self.csrf_form(
            cookie,
            vec![
                ("room_id".into(), room_id.to_string()),
                ("area_id".into(), area_id.to_string()),
                ("platform".into(), "web".into()),
            ],
        )?;
        self.data(
            "POST",
            "https://api.live.bilibili.com/room/v1/Room/update",
            &[],
            Some(&f),
            Some(cookie),
        )
        .map(|_| ())
    }

    pub fn update_announcement(
        &self,
        cookie: &str,
        room_id: i64,
        uid: i64,
        content: &str,
    ) -> Result<()> {
        let f = self.csrf_form(
            cookie,
            vec![
                ("room_id".into(), room_id.to_string()),
                ("uid".into(), uid.to_string()),
                ("content".into(), content.into()),
            ],
        )?;
        self.data(
            "POST",
            "https://api.live.bilibili.com/xlive/app-blink/v1/index/updateRoomNews",
            &[],
            Some(&f),
            Some(cookie),
        )
        .map(|_| ())
    }

    pub fn start_live(&self, cookie: &str, room_id: i64, area_id: i64) -> Result<(String, String)> {
        let now = self.data(
            "GET",
            "https://api.bilibili.com/x/report/click/now",
            &[],
            None,
            Some(cookie),
        )?;
        let ts = i64_val(&now, "now");
        let version = self.data("GET", "https://api.live.bilibili.com/xlive/app-blink/v1/liveVersionInfo/getHomePageLiveVersion", &appsign_pairs(&[("system_version".into(), "2".into()), ("ts".into(), ts.to_string())]), None, Some(cookie))?;
        let build = value_string(version.get("build").unwrap_or(&Value::Null));
        let curr_version = value_string(version.get("curr_version").unwrap_or(&Value::Null));
        let f = appsign_pairs(&self.csrf_form(
            cookie,
            vec![
                ("room_id".into(), room_id.to_string()),
                ("platform".into(), "pc_link".into()),
                ("area_v2".into(), area_id.to_string()),
                ("backup_stream".into(), "0".into()),
                ("build".into(), build),
                ("version".into(), curr_version),
                ("ts".into(), ts.to_string()),
            ],
        )?);
        let d = self.data(
            "POST",
            "https://api.live.bilibili.com/room/v1/Room/startLive",
            &[],
            Some(&f),
            Some(cookie),
        )?;
        let rtmp = obj(&d, "rtmp");
        let addr = str_val(rtmp, "addr");
        let code = str_val(rtmp, "code");
        if addr.is_empty() || code.is_empty() {
            return Err(anyhow!("开播成功但接口未返回推流地址"));
        }
        tracing::info!("startLive 返回推流码 {}", mask(&code));
        Ok((addr, code))
    }

    pub fn stop_live(&self, cookie: &str, room_id: i64) -> Result<()> {
        let f = self.csrf_form(
            cookie,
            vec![
                ("room_id".into(), room_id.to_string()),
                ("platform".into(), "pc_link".into()),
            ],
        )?;
        self.data(
            "POST",
            "https://api.live.bilibili.com/room/v1/Room/stopLive",
            &[],
            Some(&f),
            Some(cookie),
        )
        .map(|_| ())
    }

    pub fn send_danmu(&self, cookie: &str, room_id: i64, msg: &str, wbi: &WbiKeys) -> Result<()> {
        let query = wbi.sign(&[("web_location".into(), "444.8".into())]);
        let f = self.csrf_form(
            cookie,
            vec![
                ("color".into(), "16777215".into()),
                ("fontsize".into(), "25".into()),
                ("mode".into(), "1".into()),
                ("bubble".into(), "0".into()),
                ("msg".into(), msg.into()),
                ("roomid".into(), room_id.to_string()),
                ("rnd".into(), now_secs().to_string()),
            ],
        )?;
        self.data(
            "POST",
            "https://api.live.bilibili.com/msg/send",
            &query,
            Some(&f),
            Some(cookie),
        )
        .map(|_| ())
    }

    pub fn danmu_info(
        &self,
        cookie: &str,
        room_id: i64,
        wbi: &WbiKeys,
    ) -> Result<(String, String, i64)> {
        let query = wbi.sign(&[
            ("id".into(), room_id.to_string()),
            ("type".into(), "0".into()),
        ]);
        let d = self.data(
            "GET",
            "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo",
            &query,
            None,
            Some(cookie),
        )?;
        let token = str_val(&d, "token");
        let hosts = d
            .get("host_list")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let host = hosts
            .first()
            .map(|h| str_val(h, "host"))
            .unwrap_or_default();
        let port = hosts.first().map(|h| i64_val(h, "wss_port")).unwrap_or(443);
        if token.is_empty() || host.is_empty() {
            return Err(anyhow!("弹幕服务信息不完整"));
        }
        Ok((token, format!("wss://{host}:{port}/sub"), port))
    }

    pub fn buvid3(&self) -> Result<String> {
        let d = self.data(
            "GET",
            "https://api.bilibili.com/x/frontend/finger/spi",
            &[],
            None,
            None,
        )?;
        Ok(str_val(&d, "b_3"))
    }
}

/// B 站开播返回 60043 且带可展示的验证入口时抛出。
/// `qr` 已归一为可直接编码的内容（优先 data.qr，其次 notice 里的跳转地址）。
#[derive(Debug, Clone)]
pub struct FaceAuthRequired {
    pub message: String,
    pub qr: String,
    pub notice: Option<NoticeInfo>,
    /// notice 的结构摘要（键=类型），用于在拿不到地址时定位真实字段
    pub notice_shape: Option<String>,
}

/// data.notice 里的展示信息：标题、说明、按钮文案与跳转地址。
#[derive(Debug, Clone, Default)]
pub struct NoticeInfo {
    pub title: String,
    pub msg: String,
    pub button_text: String,
    pub button_url: String,
}

impl NoticeInfo {
    fn is_empty(&self) -> bool {
        self.title.is_empty()
            && self.msg.is_empty()
            && self.button_text.is_empty()
            && self.button_url.is_empty()
    }
}

impl std::fmt::Display for FaceAuthRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for FaceAuthRequired {}

/// 宽容取值：字符串、数字、布尔、数组首元素，或嵌套对象里的 text/url/value/content。
/// B 站不同版本把这些字段包在不同层级，严格的 `as_str` 会整体漏掉。
pub fn loose_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| loose_text(Some(item)))
            .find(|text| !text.is_empty())
            .unwrap_or_default(),
        Some(Value::Object(map)) => {
            const INNER: [&str; 8] = [
                "text", "url", "value", "content", "msg", "title", "link", "str",
            ];
            for key in INNER {
                let text = loose_text(map.get(key));
                if !text.is_empty() {
                    return text;
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn first_text(notice: &serde_json::Map<String, Value>, keys: &[&str]) -> String {
    for key in keys {
        let text = loose_text(notice.get(*key));
        if !text.is_empty() {
            return text;
        }
    }
    String::new()
}

fn value_kind(value: Option<&Value>) -> String {
    match value {
        None => "missing".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(flag)) => format!("bool({flag})"),
        Some(Value::Number(number)) => format!("num({number})"),
        Some(Value::String(text)) => format!("str(len={})", text.chars().count()),
        Some(Value::Array(items)) => format!("array(len={})", items.len()),
        Some(Value::Object(map)) => format!(
            "object[{}]",
            map.keys().cloned().collect::<Vec<_>>().join("|")
        ),
    }
}

/// 解析 data.notice；B 站的验证入口（实名/人脸/风险校验）通常放在这里。
/// 同时返回结构摘要，便于在字段名或层级变化时快速定位。
pub fn parse_notice(data: &Value) -> (Option<NoticeInfo>, Option<String>) {
    let Some(notice) = data.get("notice").and_then(Value::as_object) else {
        return (None, None);
    };
    let info = NoticeInfo {
        title: first_text(notice, &["title", "header", "name"]),
        msg: first_text(
            notice,
            &["msg", "message", "content", "desc", "description"],
        ),
        button_text: first_text(notice, &["button_text", "button", "action_text", "text"]),
        button_url: first_text(
            notice,
            &[
                "button_url",
                "url",
                "link",
                "jump_url",
                "action_url",
                "redirect_url",
                "qr_url",
            ],
        ),
    };
    let shape = format!(
        "title={}, msg={}, button_text={}, button_url={}",
        value_kind(notice.get("title")),
        value_kind(notice.get("msg")),
        value_kind(notice.get("button_text")),
        value_kind(notice.get("button_url"))
    );
    if info.is_empty() {
        return (None, Some(shape));
    }
    (Some(info), Some(shape))
}

/// B 站官方人脸验证页（与官方直播姬 / LiveHime 同款）。
/// 凭证来自 60043 响应里的 `data.risk_extra.v_voucher`；手机端已登录同一账号即可完成核身。
pub fn face_auth_url(data: &Value) -> Option<String> {
    let voucher = data
        .get("risk_extra")
        .and_then(|extra| extra.get("v_voucher"))
        .map(|value| loose_text(Some(value)))
        .unwrap_or_default();
    if voucher.is_empty() {
        return None;
    }
    Some(format!(
        "https://live.bilibili.com/p/html/bilili-page-face-auth/index.html?is_live_webview=1&app_common=open&pc_ui=500,428,17181a,2&v_voucher={}",
        percent_encode(&voucher)
    ))
}

fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 从 60043 的 data 中取认证二维码载荷：`qr` 可能是字符串，也可能是含 url 的对象。
pub fn extract_qr_payload(data: &Value) -> Option<String> {
    const KEYS: [&str; 4] = ["qr", "qr_url", "qrcode", "qr_content"];
    for key in KEYS {
        if let Some(value) = data.get(key) {
            if let Some(text) = qr_value_to_string(value) {
                return Some(text);
            }
        }
    }
    None
}

fn qr_value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Object(map) => {
            const INNER: [&str; 6] = ["url", "qr_url", "qrcode", "content", "value", "str"];
            for key in INNER {
                if let Some(inner) = map.get(key) {
                    if let Some(text) = qr_value_to_string(inner) {
                        return Some(text);
                    }
                }
            }
            None
        }
        // 少数版本把二维码放在数组里（如 [{"url": ...}]）
        Value::Array(items) => items.iter().find_map(qr_value_to_string),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn check_response(body: Value) -> Result<Value> {
    let code = i64_val(&body, "code");
    let data = body.get("data").cloned().unwrap_or(Value::Null);
    if code == 0 {
        return Ok(data);
    }
    let mut msg = str_val(&body, "message");
    if msg.is_empty() {
        msg = str_val(&body, "msg");
    }
    let mut text = format!("B 站接口返回 code {}", code);
    if !msg.is_empty() {
        text.push_str(": ");
        text.push_str(&msg);
    }
    // 60043 is a platform-side face-verification gate. lyblive cannot perform
    // biometric verification; guide the user to the official client without
    // asking for credentials or changing the local room state automatically.
    if code == 60043 {
        text.push_str(concat!(
            "；B 站要求开播前完成验证（可能是实名/人脸/风险校验）。lyblive 不能代做核身，",
            "请按下方提示用官方渠道完成；完成后回到这里重新点「开始直播」。",
            "不要反复点击以免触发「开播太频繁」；lyblive 不会索取或保存账号凭据",
        ));
        let (notice, notice_shape) = parse_notice(&data);
        // 优先级：data.qr > 官方人脸验证页（risk_extra.v_voucher）> notice 里的跳转地址
        let qr = extract_qr_payload(&data)
            .or_else(|| face_auth_url(&data))
            .or_else(|| {
                notice
                    .as_ref()
                    .map(|info| info.button_url.clone())
                    .filter(|url| !url.is_empty())
            });
        if qr.is_some() || notice.is_some() || notice_shape.is_some() {
            return Err(anyhow!(FaceAuthRequired {
                message: text,
                qr: qr.unwrap_or_default(),
                notice,
                notice_shape,
            }));
        }
        if let Some(hint) = verification_hint(&data) {
            text.push_str("；B 站返回的字段：");
            text.push_str(&hint);
        }
    }
    Err(anyhow!("{text}"))
}

/// 60043 的 `data` 结构诊断：逐个字段回报**类型**（敏感字段不报内容），
/// 并对 qr / notice 等可能的认证入口给出脱敏预览，便于判断二维码从哪来。
fn verification_hint(data: &Value) -> Option<String> {
    let map = data.as_object()?;
    if map.is_empty() {
        return None;
    }
    const SENSITIVE: [&str; 6] = [
        "live_key",
        "sub_session_key",
        "rtmp",
        "rtmp_backup",
        "protocols",
        "protocols_backup",
    ];
    const PREVIEW: [&str; 6] = ["qr", "qr_url", "qrcode", "url", "notice", "risk_extra"];

    let mut parts = Vec::with_capacity(map.len());
    for (key, value) in map {
        let rendered = if SENSITIVE.contains(&key.as_str()) {
            shape_only(value)
        } else if PREVIEW.contains(&key.as_str()) {
            preview(value)
        } else {
            shape_only(value)
        };
        parts.push(format!("{key}={rendered}"));
    }
    Some(parts.join(", "))
}

fn shape_only(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => format!("bool({flag})"),
        Value::Number(number) => format!("num({number})"),
        Value::String(text) => format!("str(len={})", text.chars().count()),
        Value::Array(items) => format!("array(len={})", items.len()),
        Value::Object(map) => format!(
            "object[{}]",
            map.keys().cloned().collect::<Vec<_>>().join("|")
        ),
    }
}

fn preview(value: &Value) -> String {
    match value {
        Value::String(text) if !text.trim().is_empty() => {
            // URL 去掉 query（一次性令牌），其余文本保留前面一段便于识别
            let cleaned = if text.starts_with("http") {
                strip_query(text)
            } else {
                text.clone()
            };
            format!(
                "str(len={}) \"{}\"",
                text.chars().count(),
                truncate_chars(&cleaned, 120)
            )
        }
        Value::Array(items) => {
            let first = items.first().map(shape_only).unwrap_or_default();
            format!("array(len={}, first={first})", items.len())
        }
        Value::Object(map) => format!(
            "object[{}]",
            map.keys().cloned().collect::<Vec<_>>().join("|")
        ),
        other => shape_only(other),
    }
}

fn strip_query(text: &str) -> String {
    text.split(['?', '#']).next().unwrap_or(text).to_string()
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

pub fn value_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

pub fn cookie_value(cookie: &str, key: &str) -> Option<String> {
    cookie
        .split(';')
        .filter_map(|p| p.trim().split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v.to_string())
}

pub fn cookies_from_headers(headers: &[String]) -> String {
    let mut out = BTreeMap::new();
    for h in headers {
        if let Some(pair) = h.split(';').next() {
            if let Some((k, v)) = pair.trim().split_once('=') {
                out.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }
    out.into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

pub fn appsign_pairs(pairs: &[(String, String)]) -> Vec<(String, String)> {
    let mut m = BTreeMap::new();
    for (k, v) in pairs {
        m.insert(k.clone(), v.clone());
    }
    m.insert("appkey".into(), APP_KEY.into());
    let q = form_encode(
        &m.iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect::<Vec<_>>(),
    );
    let sign = md5_hex(&format!("{q}{APP_SEC}"));
    let mut out: Vec<(String, String)> = m.into_iter().collect();
    out.push(("sign".into(), sign));
    out
}

#[derive(Debug, Clone)]
pub struct WbiKeys {
    mixin_key: String,
}
impl WbiKeys {
    pub fn from_nav(nav: &Value) -> Result<Self> {
        let img = str_val(obj(nav, "wbi_img"), "img_url");
        let sub = str_val(obj(nav, "wbi_img"), "sub_url");
        let stem = |u: &str| {
            u.rsplit('/')
                .next()
                .unwrap_or("")
                .split('.')
                .next()
                .unwrap_or("")
                .to_string()
        };
        Self::from_img_sub(&stem(&img), &stem(&sub))
    }
    pub fn from_img_sub(img: &str, sub: &str) -> Result<Self> {
        let orig = format!("{img}{sub}");
        let chars: Vec<char> = orig.chars().collect();
        if chars.len() < 64 {
            return Err(anyhow!("WBI 密钥长度异常"));
        }
        let mixin_key: String = MIXIN_TAB
            .iter()
            .take(32)
            .filter_map(|&i| chars.get(i).copied())
            .collect();
        Ok(Self { mixin_key })
    }
    pub fn sign(&self, pairs: &[(String, String)]) -> Vec<(String, String)> {
        let mut m = BTreeMap::new();
        for (k, v) in pairs {
            m.insert(
                k.clone(),
                v.chars()
                    .filter(|c| !"!'()*".contains(*c))
                    .collect::<String>(),
            );
        }
        m.insert("wts".into(), now_secs().to_string());
        let q = form_encode(
            &m.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<Vec<_>>(),
        );
        let mut out: Vec<(String, String)> = m.into_iter().collect();
        out.push(("w_rid".into(), md5_hex(&format!("{q}{}", self.mixin_key))));
        out
    }
}

pub fn qr_svg(text: &str) -> Result<String> {
    let qr = qrcodegen::QrCode::encode_text(text, qrcodegen::QrCodeEcc::Medium)
        .map_err(|e| anyhow!("二维码生成失败: {e:?}"))?;
    let n = qr.size();
    let mut paths = String::new();
    for y in 0..n {
        for x in 0..n {
            if qr.get_module(x, y) {
                paths.push_str(&format!("M{x} {y}h1v1h-1z"));
            }
        }
    }
    Ok(format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"-2 -2 {} {}\" width=\"220\" height=\"220\" role=\"img\" aria-label=\"B 站登录二维码\"><rect x=\"-2\" y=\"-2\" width=\"{}\" height=\"{}\" fill=\"white\"/><path d=\"{paths}\" fill=\"black\"/></svg>", n + 4, n + 4, n + 4, n + 4))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct LastForm(std::sync::Mutex<Vec<(String, String)>>);

    impl Transport for LastForm {
        fn call(
            &self,
            _method: &str,
            _url: &str,
            _query: &[(String, String)],
            form: Option<&[(String, String)]>,
            _cookie: Option<&str>,
        ) -> Result<RawResponse> {
            if let Some(f) = form {
                *self.0.lock().unwrap() = f.to_vec();
            }
            Ok(RawResponse {
                body: serde_json::json!({"code": 0, "data": {}}),
                set_cookies: vec![],
            })
        }
    }

    #[test]
    fn update_title_sends_web_platform_with_csrf() {
        let t = Arc::new(LastForm(std::sync::Mutex::new(vec![])));
        let api = BiliApi::with_transport(t.clone());
        api.update_title("SESSDATA=s; bili_jct=csrf123", 42, "新标题")
            .unwrap();
        let f: BTreeMap<_, _> = t.0.lock().unwrap().iter().cloned().collect();
        assert_eq!(f["room_id"], "42");
        assert_eq!(f["title"], "新标题");
        assert_eq!(f["platform"], "web");
        assert_eq!(f["csrf"], "csrf123");
        assert_eq!(f["csrf_token"], "csrf123");
    }

    #[test]
    fn wbi_mixin_key_matches_upstream_vector() {
        let k = WbiKeys::from_img_sub(
            "7cd084941338484aae1ad9425b84077c",
            "4932caff0ff746eab6f07bf9cfa8ba3c",
        )
        .unwrap();
        assert_eq!(k.mixin_key, "ea1db124af3ca062474693fa704f4ff8");
    }
    #[test]
    fn appsign_sorted_and_signed() {
        let p = appsign_pairs(&[("b".into(), "2".into()), ("a".into(), "1".into())]);
        let m: BTreeMap<_, _> = p.iter().cloned().collect();
        assert_eq!(m["appkey"], APP_KEY);
        assert_eq!(
            m["sign"],
            md5_hex(&format!("a=1&appkey={APP_KEY}&b=2{APP_SEC}"))
        );
    }
    #[test]
    fn cookie_parsing_is_exact() {
        assert_eq!(
            cookie_value("a=1; bili_jct=xyz; c=3", "bili_jct").as_deref(),
            Some("xyz")
        );
        assert_eq!(
            cookies_from_headers(&[
                "SESSDATA=s; Path=/; HttpOnly".into(),
                "bili_jct=c; Path=/".into()
            ]),
            "SESSDATA=s; bili_jct=c"
        );
    }
    #[test]
    fn qr_svg_is_standalone() {
        let s = qr_svg("https://example.com/?x=1").unwrap();
        assert!(s.starts_with("<svg") && s.ends_with("</svg>") && s.contains("220"));
    }
    #[test]
    fn referer_tracks_target_host() {
        assert_eq!(
            referer_for("https://api.bilibili.com/x/web-interface/nav"),
            "https://www.bilibili.com/"
        );
        assert_eq!(
            referer_for("https://api.live.bilibili.com/room/v1/Room/get_info"),
            "https://live.bilibili.com/"
        );
        assert_eq!(
            referer_for("https://passport.bilibili.com/x/passport-login/web/qrcode/generate"),
            "https://passport.bilibili.com/"
        );
        assert_eq!(
            referer_for("https://live.bilibili.com/p/html/live-app-face/index.html"),
            "https://live.bilibili.com/"
        );
    }
    #[test]
    fn code_60043_builds_face_auth_url_from_risk_voucher() {
        let err = check_response(serde_json::json!({
            "code": 60043,
            "message": "本次开播需要身份验证",
            "data": {
                "need_face_auth": false,
                "qr": "",
                "risk_extra": {"v_voucher": "abc123"},
                "notice": {"title": "", "msg": "", "button_text": "", "button_url": ""}
            }
        }))
        .unwrap_err();
        let face = err
            .downcast_ref::<FaceAuthRequired>()
            .expect("应带人脸验证入口");
        assert!(face.qr.contains("bilili-page-face-auth"), "{}", face.qr);
        assert!(face.qr.contains("v_voucher=abc123"), "{}", face.qr);
    }
    #[test]
    fn code_60043_encodes_voucher_special_chars() {
        let err = check_response(serde_json::json!({
            "code": 60043,
            "message": "需要验证",
            "data": {"risk_extra": {"v_voucher": "a+b/c="}}
        }))
        .unwrap_err();
        let face = err.downcast_ref::<FaceAuthRequired>().unwrap();
        assert!(face.qr.contains("v_voucher=a%2Bb%2Fc%3D"), "{}", face.qr);
    }
    #[test]
    fn code_60043_notice_nested_values_are_extracted() {
        // B 站不同版本把文案包在对象里，严格的 as_str 会整体漏掉
        let err = check_response(serde_json::json!({
            "code": 60043,
            "message": "需要验证",
            "data": {
                "need_face_auth": false,
                "qr": "",
                "notice": {
                    "title": {"text": "实名认证"},
                    "msg": {"content": "请先完成实名认证"},
                    "button_text": {"text": "去认证"},
                    "button_url": {"url": "https://example.com/verify"}
                }
            }
        }))
        .unwrap_err();
        let face = err
            .downcast_ref::<FaceAuthRequired>()
            .expect("嵌套 notice 也要结构化");
        assert_eq!(face.qr, "https://example.com/verify");
        let notice = face.notice.as_ref().expect("notice");
        assert_eq!(notice.title, "实名认证");
        assert_eq!(notice.msg, "请先完成实名认证");
        assert_eq!(notice.button_text, "去认证");
    }
    #[test]
    fn code_60043_notice_shape_is_reported_when_empty() {
        let err = check_response(serde_json::json!({
            "code": 60043,
            "message": "需要验证",
            "data": {"notice": {"title": null, "msg": null, "button_url": null}}
        }))
        .unwrap_err();
        let face = err
            .downcast_ref::<FaceAuthRequired>()
            .expect("空 notice 也要带回结构");
        assert!(face.qr.is_empty());
        let shape = face.notice_shape.as_deref().unwrap_or_default();
        assert!(shape.contains("title=null"), "{shape}");
        assert!(shape.contains("button_url=null"), "{shape}");
    }
    #[test]
    fn code_60043_notice_becomes_structured_verification() {
        let err = check_response(serde_json::json!({
            "code": 60043,
            "message": "本次开播需要身份验证",
            "data": {
                "need_face_auth": false,
                "qr": "",
                "notice": {
                    "title": "实名认证",
                    "msg": "请先完成实名认证后开播",
                    "button_text": "去认证",
                    "button_url": "https://example.com/verify?t=1",
                    "status": 0,
                    "type": 1
                }
            }
        }))
        .unwrap_err();
        let face = err
            .downcast_ref::<FaceAuthRequired>()
            .expect("notice 应转成结构化验证");
        // qr 为空时回退到 notice.button_url，可直接生成二维码
        assert_eq!(face.qr, "https://example.com/verify?t=1");
        let notice = face.notice.as_ref().expect("notice 应保留");
        assert_eq!(notice.title, "实名认证");
        assert_eq!(notice.msg, "请先完成实名认证后开播");
        assert_eq!(notice.button_text, "去认证");
    }
    #[test]
    fn code_60043_with_qr_returns_face_auth_error() {
        let err = check_response(serde_json::json!({
            "code": 60043,
            "message": "本次开播需要身份验证",
            "data": {"need_face_auth": true, "qr": "https://example.com/face?token=abc"}
        }))
        .unwrap_err();
        let face = err
            .downcast_ref::<FaceAuthRequired>()
            .expect("带 qr 的 60043 应转为 FaceAuthRequired");
        assert_eq!(face.qr, "https://example.com/face?token=abc");
        assert!(face.message.contains("60043"), "{}", face.message);
    }
    #[test]
    fn code_60043_qr_object_payload_is_extracted() {
        let err = check_response(serde_json::json!({
            "code": 60043,
            "message": "需要验证",
            "data": {"qr": {"url": "https://example.com/qr", "expires": 120}}
        }))
        .unwrap_err();
        assert_eq!(
            err.downcast_ref::<FaceAuthRequired>()
                .map(|f| f.qr.as_str()),
            Some("https://example.com/qr")
        );
    }
    #[test]
    fn code_60043_without_qr_stays_plain_error() {
        let err = check_response(serde_json::json!({
            "code": 60043,
            "message": "需要验证",
            "data": {"need_face_auth": true}
        }))
        .unwrap_err();
        assert!(err.downcast_ref::<FaceAuthRequired>().is_none());
        assert!(
            err.to_string().contains("need_face_auth=bool(true)"),
            "{err}"
        );
    }
    #[test]
    fn code_60043_surfaces_verification_url_from_data() {
        let e = check_response(serde_json::json!({
            "code": 60043,
            "message": "本次开播需要身份验证",
            "data": {"url": "https://live.bilibili.com/p/html/live-app-face/index.html?token=x"}
        }))
        .unwrap_err()
        .to_string();
        assert!(e.contains("B 站返回的字段"), "{e}");
        assert!(e.contains("live-app-face"), "{e}");
        assert!(!e.contains("token=x"), "令牌值不应被透出：{e}");
    }
    #[test]
    fn code_60043_reports_data_field_names_without_values() {
        let e = check_response(serde_json::json!({
            "code": 60043,
            "message": "需要验证",
            "data": {"app_id": 1, "verify_type": "face", "secret": "s3cr3t"}
        }))
        .unwrap_err()
        .to_string();
        assert!(e.contains("verify_type=str(len=4)"), "{e}");
        assert!(!e.contains("s3cr3t"), "字段值不应被透出：{e}");
    }
    #[test]
    fn code_60043_reports_qr_null_type() {
        let e = check_response(serde_json::json!({
            "code": 60043,
            "message": "需要验证",
            "data": {"need_face_auth": true, "qr": null, "notice": "请在关播时唤起认证"}
        }))
        .unwrap_err()
        .to_string();
        assert!(e.contains("qr=null"), "{e}");
        assert!(e.contains("notice=str(len=9)"), "{e}");
        assert!(e.contains("请在关播时唤起认"), "{e}");
    }
    #[test]
    fn code_60043_without_data_stays_clean() {
        let e = check_response(serde_json::json!({"code": 60043, "message": "需要验证"}))
            .unwrap_err()
            .to_string();
        assert!(e.contains("B 站接口返回 code 60043"), "{e}");
        assert!(!e.contains("B 站返回的验证信息"), "{e}");
    }
    #[test]
    fn code_60043_message_guides_to_official_verification() {
        let e = check_response(serde_json::json!({
            "code": 60043,
            "message": "本次开播需要身份验证，请在关播时点击开播唤起人脸认证"
        }))
        .unwrap_err()
        .to_string();
        assert!(e.contains("B 站接口返回 code 60043"), "{e}");
        assert!(e.contains("本次开播需要身份验证"), "{e}");
        assert!(e.contains("B 站要求开播前完成验证"), "{e}");
        assert!(e.contains("官方渠道完成"), "{e}");
        assert!(e.contains("不要反复点击"), "{e}");
        assert!(e.contains("不会索取或保存账号凭据"), "{e}");
    }
    #[test]
    fn unrelated_api_codes_do_not_claim_face_verification() {
        let e = check_response(serde_json::json!({"code": -101, "message": "账号未登录"}))
            .unwrap_err()
            .to_string();
        assert!(e.contains("code -101: 账号未登录"), "{e}");
        assert!(!e.contains("人脸认证"), "{e}");
    }
    #[test]
    fn api_errors_never_return_data() {
        assert!(
            check_response(serde_json::json!({"code": -101, "message": "账号未登录"})).is_err()
        );
    }
}
