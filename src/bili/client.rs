//! B 站 Web API 的薄 Rust 适配层（签名、Cookie、二维码、房间、推流）。
//! 不在日志、错误或 JSON 中回传 cookie / csrf / 推流密钥。

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderMap, HeaderValue, COOKIE, SET_COOKIE};
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
                ("platform".into(), "pc_link".into()),
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
                ("platform".into(), "pc_link".into()),
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

fn check_response(body: Value) -> Result<Value> {
    let code = i64_val(&body, "code");
    let data = body.get("data").cloned().unwrap_or(Value::Null);
    if code == 0 {
        Ok(data)
    } else {
        let mut msg = str_val(&body, "message");
        if msg.is_empty() {
            msg = str_val(&body, "msg");
        }
        Err(anyhow!(
            "B 站接口返回 code {}{}",
            code,
            if msg.is_empty() {
                String::new()
            } else {
                format!(": {msg}")
            }
        ))
    }
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
    fn api_errors_never_return_data() {
        assert!(
            check_response(serde_json::json!({"code": -101, "message": "账号未登录"})).is_err()
        );
    }
}
