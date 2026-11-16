use crate::bili::{cookie_value, cookies_from_headers, qr_svg, BiliApi, WbiKeys};
use crate::settings::{Credential, SharedConfig};
use crate::util::{i64_val, mask, now_secs, obj, str_val};
use serde_json::{json, Value};
use std::sync::{Arc, RwLock};

const QR_TTL_SECS: i64 = 180;

#[derive(Clone, Debug)]
pub struct Profile {
    pub uid: i64,
    pub uname: String,
    pub face: String,
    pub level: i64,
    #[allow(dead_code)]
    pub room_id: i64,
}

#[derive(Clone, Debug)]
pub struct LoginSession {
    pub cookie: String,
    pub csrf: String,
    pub uid: i64,
    pub room_id: i64,
    pub profile: Option<Profile>,
    pub persisted: bool,
}

#[derive(Clone, Debug)]
pub struct RtmpInfo {
    pub addr: String,
    pub code: String,
    #[allow(dead_code)]
    pub provider: String,
    #[allow(dead_code)]
    pub updated_at: i64,
}

#[derive(Clone, Debug)]
pub struct PendingQr {
    pub key: String,
    pub url: String,
    pub qr_svg: String,
    pub created_at: i64,
}

struct Core {
    api: BiliApi,
    config: SharedConfig,
    login: Option<LoginSession>,
    pending_qr: Option<PendingQr>,
    rtmp: Option<RtmpInfo>,
    wbi: Option<WbiKeys>,
    profile_error: Option<String>,
    profile_attempt_at: i64,
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<RwLock<Core>>,
}

impl AppState {
    pub fn new(api: BiliApi, config: SharedConfig) -> Self {
        let login = config.credential().map(|cred| LoginSession {
            cookie: cred.cookie,
            csrf: cred.csrf,
            uid: cred.uid,
            room_id: 0,
            profile: None,
            persisted: true,
        });
        Self {
            inner: Arc::new(RwLock::new(Core {
                api,
                config,
                login,
                pending_qr: None,
                rtmp: None,
                wbi: None,
                profile_error: None,
                profile_attempt_at: 0,
            })),
        }
    }

    pub fn api(&self) -> BiliApi {
        self.inner.read().unwrap().api.clone()
    }

    pub fn config(&self) -> SharedConfig {
        self.inner.read().unwrap().config.clone()
    }

    pub fn session(&self) -> Option<LoginSession> {
        self.inner.read().unwrap().login.clone()
    }

    pub fn require_login(&self) -> anyhow::Result<LoginSession> {
        self.session()
            .ok_or_else(|| anyhow::anyhow!("尚未登录 B 站"))
    }

    pub fn require_csrf(&self) -> anyhow::Result<(String, String)> {
        let s = self.require_login()?;
        if s.csrf.trim().is_empty() {
            anyhow::bail!("登录会话缺少 bili_jct，请重新扫码登录");
        }
        Ok((s.cookie, s.csrf))
    }

    pub fn room_id(&self, explicit: Option<i64>) -> anyhow::Result<i64> {
        if let Some(id) = explicit {
            if id > 0 {
                return Ok(id);
            }
            anyhow::bail!("room_id 必须大于 0");
        }
        let mut core = self.inner.write().unwrap();
        let api = core.api.clone();
        let login = core
            .login
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("尚未登录 B 站"))?;
        if login.room_id <= 0 {
            let uid = login.uid;
            let cookie = login.cookie.clone();
            let id = match api.room_id_by_uid(&cookie, uid) {
                Ok(id) if id > 0 => id,
                _ => {
                    let nav = api.nav(&cookie)?;
                    let id = i64_val(obj(&nav, "live_room"), "roomid");
                    if id > 0 {
                        id
                    } else {
                        anyhow::bail!("账号没有可用的直播间，请先在 B 站开通");
                    }
                }
            };
            login.room_id = id;
        }
        Ok(login.room_id)
    }

    pub fn wbi_keys(&self) -> anyhow::Result<WbiKeys> {
        {
            let core = self.inner.read().unwrap();
            if let Some(keys) = &core.wbi {
                return Ok(keys.clone());
            }
        }
        let (cookie, api) = {
            let core = self.inner.read().unwrap();
            (
                core.login.as_ref().map(|s| s.cookie.clone()),
                core.api.clone(),
            )
        };
        let nav = api.nav(&cookie.unwrap_or_default())?;
        let keys = WbiKeys::from_nav(&nav)?;
        let mut core = self.inner.write().unwrap();
        core.wbi = Some(keys.clone());
        Ok(keys)
    }

    pub fn public_session(&self) -> Value {
        let core = self.inner.read().unwrap();
        let Some(s) = &core.login else {
            return json!({"loggedIn": false, "persisted": false, "csrfPresent": false});
        };
        let p = s.profile.as_ref();
        json!({
            "loggedIn": true,
            "persisted": s.persisted,
            "user": {
                "uid": p.map(|x| x.uid).unwrap_or(s.uid),
                "uname": p.map(|x| x.uname.clone()).unwrap_or_default(),
                "face": p.map(|x| x.face.clone()).unwrap_or_default(),
                "level": p.map(|x| x.level).unwrap_or(0),
            },
            "roomId": if s.room_id > 0 { Value::from(s.room_id) } else { Value::Null },
            "csrfPresent": !s.csrf.trim().is_empty(),
            "profileError": core.profile_error.clone(),
        })
    }

    /// 拉取昵称、头像与等级。失败时把原因留在 `profileError`，供前端提示与重试，
    /// 而不是静默返回空字符串让用户看到「未知昵称 / 等级 0」。
    pub fn enrich_profile(&self) -> Option<String> {
        let (cookie, uid, api) = {
            let core = self.inner.read().unwrap();
            let s = core.login.as_ref()?;
            (s.cookie.clone(), s.uid, core.api.clone())
        };
        {
            let mut core = self.inner.write().unwrap();
            core.profile_attempt_at = now_secs();
        }
        let nav = match api.nav(&cookie) {
            Ok(v) => v,
            Err(e) => {
                let msg = format!("昵称/头像拉取失败：{e}（B 站可能要求重新登录或触发了风控）");
                if let Some(s) = self.inner.write().unwrap().login.as_mut() {
                    if s.uid == uid {
                        s.profile = None;
                    }
                }
                self.inner.write().unwrap().profile_error = Some(msg.clone());
                return Some(msg);
            }
        };
        if let Some(is_login) = nav.get("isLogin").and_then(Value::as_bool) {
            if !is_login {
                let msg = "昵称/头像拉取失败：B 站返回未登录状态，请重新扫码登录".to_string();
                self.inner.write().unwrap().profile_error = Some(msg.clone());
                return Some(msg);
            }
        }
        let room_id = i64_val(obj(&nav, "live_room"), "roomid");
        let profile = Profile {
            uid,
            uname: str_val(&nav, "uname"),
            face: str_val(&nav, "face"),
            level: i64_val(obj(&nav, "level_info"), "current_level"),
            room_id,
        };
        let mut core = self.inner.write().unwrap();
        if let Some(s) = core.login.as_mut() {
            if s.uid == uid {
                if s.room_id <= 0 {
                    s.room_id = room_id;
                }
                s.profile = Some(profile);
            }
        }
        core.profile_error = None;
        None
    }

    /// 会话读取时的惰性补拉：只在缺少资料且距上次尝试超过 30 秒时触发一次，
    /// 避免 `/api/session` 被前端轮询时反复打 B 站接口。
    pub fn refresh_profile_if_needed(&self) {
        let now = now_secs();
        let need = {
            let core = self.inner.read().unwrap();
            core.login.is_some()
                && core.login.as_ref().is_some_and(|s| s.profile.is_none())
                && now.saturating_sub(core.profile_attempt_at) >= 30
        };
        if need {
            let _ = self.enrich_profile();
        }
    }

    pub fn qrcode(&self) -> anyhow::Result<Value> {
        let (url, key) = self.api().qrcode()?;
        if url.is_empty() || key.is_empty() {
            anyhow::bail!("二维码接口返回数据不完整");
        }
        let svg = qr_svg(&url)?;
        let out = json!({"ok": true, "key": key, "url": url, "qrSvg": svg, "expiresIn": 180});
        let mut core = self.inner.write().unwrap();
        core.pending_qr = Some(PendingQr {
            key,
            url,
            qr_svg: svg,
            created_at: now_secs(),
        });
        Ok(out)
    }

    pub fn poll_qrcode(&self, key: &str) -> anyhow::Result<Value> {
        if key.trim().is_empty() {
            anyhow::bail!("qrcode_key 不能为空");
        }
        let (pending_key, pending_age, url_len, svg_len) = {
            let core = self.inner.read().unwrap();
            match &core.pending_qr {
                None => anyhow::bail!("请先获取二维码"),
                Some(q) => (
                    q.key.clone(),
                    now_secs().saturating_sub(q.created_at),
                    q.url.len(),
                    q.qr_svg.len(),
                ),
            }
        };
        if pending_key != key {
            anyhow::bail!("二维码 key 不匹配，请重新获取二维码");
        }
        if pending_age > QR_TTL_SECS {
            anyhow::bail!("二维码已过期，请重新获取二维码");
        }
        tracing::debug!("二维码待确认：url {} 字符，SVG {} 字符", url_len, svg_len);
        let (code, raw) = self.api().poll_qrcode(key)?;
        let d = obj(&raw.body, "data");
        let message = {
            let m = str_val(d, "message");
            if m.is_empty() {
                str_val(d, "msg")
            } else {
                m
            }
        };
        let status = match code {
            0 => "confirmed",
            86038 => "expired",
            86090 => "scanned",
            86101 => "pending",
            c if c < 0 => "error",
            _ => "pending",
        };
        if code == 0 {
            let cookie = cookies_from_headers(&raw.set_cookies);
            if cookie.is_empty() {
                anyhow::bail!("扫码成功但未拿到登录 Cookie");
            }
            let csrf = cookie_value(&cookie, "bili_jct").unwrap_or_default();
            let uid_text = cookie_value(&cookie, "DedeUserID").unwrap_or_default();
            let uid = uid_text.parse::<i64>().unwrap_or(0);
            if csrf.is_empty() || uid <= 0 {
                anyhow::bail!("扫码成功但 Cookie 缺少 bili_jct 或 DedeUserID");
            }
            let remember = self.config().settings().remember_login;
            let persisted = if remember {
                self.config().save_credential(&Credential {
                    cookie: cookie.clone(),
                    csrf: csrf.clone(),
                    uid,
                })?
            } else {
                false
            };
            {
                let mut core = self.inner.write().unwrap();
                core.login = Some(LoginSession {
                    cookie,
                    csrf,
                    uid,
                    room_id: 0,
                    profile: None,
                    persisted,
                });
                core.pending_qr = None;
                core.wbi = None;
                core.profile_error = None;
                core.profile_attempt_at = 0;
            }
            let _ = self.enrich_profile();
            return Ok(
                json!({"ok": true, "status": status, "message": message, "session": self.public_session()}),
            );
        }
        Ok(json!({
            "ok": true,
            "status": status,
            "message": if message.is_empty() { status.to_string() } else { message },
        }))
    }

    pub fn logout(&self) -> anyhow::Result<()> {
        {
            let mut core = self.inner.write().unwrap();
            core.login = None;
            core.pending_qr = None;
            core.wbi = None;
            core.rtmp = None;
            core.profile_error = None;
            core.profile_attempt_at = 0;
        }
        self.config().clear_credential()?;
        Ok(())
    }

    pub fn set_remember_login(&self, on: bool) -> anyhow::Result<()> {
        let config = self.config();
        config.set_remember(on)?;
        let persisted = if let Some(s) = self.session() {
            if on {
                config.save_credential(&Credential {
                    cookie: s.cookie,
                    csrf: s.csrf,
                    uid: s.uid,
                })?
            } else {
                false
            }
        } else {
            false
        };
        let mut core = self.inner.write().unwrap();
        if let Some(s) = core.login.as_mut() {
            s.persisted = persisted;
        }
        Ok(())
    }

    pub fn set_rtmp(&self, addr: String, code: String) {
        tracing::info!("保存推流地址 {} 与密钥 {}", addr, mask(&code));
        let mut core = self.inner.write().unwrap();
        core.rtmp = Some(RtmpInfo {
            addr,
            code,
            provider: "bilibili".to_string(),
            updated_at: now_secs(),
        });
    }

    pub fn rtmp(&self) -> Option<RtmpInfo> {
        self.inner.read().unwrap().rtmp.clone()
    }

    pub fn room(&self) -> anyhow::Result<Value> {
        let rid = self.room_id(None)?;
        let uid = self.session().map(|s| s.uid).unwrap_or(0);
        let info = self.api().room_info(rid)?;
        let news = self.api().room_news(rid, uid).unwrap_or_default();
        let live_status = i64_val(&info, "live_status");
        let status_text = match live_status {
            0 => "未开播",
            1 => "直播中",
            2 => "轮播中",
            _ => "未知",
        };
        let area_id = {
            let x = i64_val(&info, "area_id");
            if x > 0 {
                x
            } else {
                i64_val(&info, "area_v2_id")
            }
        };
        let area_name = {
            let x = str_val(&info, "area_name");
            if x.is_empty() {
                str_val(&info, "area_v2_name")
            } else {
                x
            }
        };
        let parent_name = {
            let x = str_val(&info, "parent_area_name");
            if x.is_empty() {
                str_val(&info, "parent_area_v2_name")
            } else {
                x
            }
        };
        Ok(json!({
            "ok": true,
            "room": {
                "roomId": i64_val(&info, "room_id"), "shortId": i64_val(&info, "short_id"),
                "uid": i64_val(&info, "uid"), "title": str_val(&info, "title"),
                "liveStatus": live_status, "liveStatusText": status_text,
                "areaId": area_id, "areaName": area_name,
                "parentAreaId": i64_val(&info, "parent_area_id"), "parentAreaName": parent_name,
                "online": i64_val(&info, "online"), "description": news,
                "keyframe": str_val(&info, "keyframe"),
            }
        }))
    }

    pub fn partitions(&self) -> anyhow::Result<Value> {
        let v = self.api().area_list()?;
        let empty: Vec<Value> = Vec::new();
        let list = v.as_array().unwrap_or(&empty);
        let areas: Vec<Value> = list.iter().map(|p| {
            let subs: Vec<Value> = obj(p, "list").as_array().unwrap_or(&empty).iter().map(|s| json!({
                "id": i64_val(s, "id"), "name": str_val(s, "name"), "parentId": i64_val(p, "id"),
            })).collect();
            json!({"id": i64_val(p, "id"), "name": str_val(p, "name"), "list": subs})
        }).collect();
        Ok(json!({"ok": true, "areas": areas}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bili::{RawResponse, Transport};
    use crate::settings::DiskConfig;
    use std::sync::Mutex;

    struct Fake(Mutex<Vec<(String, String)>>);
    impl Transport for Fake {
        fn call(
            &self,
            method: &str,
            url: &str,
            _q: &[(String, String)],
            _f: Option<&[(String, String)]>,
            _c: Option<&str>,
        ) -> anyhow::Result<RawResponse> {
            self.0
                .lock()
                .unwrap()
                .push((method.to_string(), url.to_string()));
            let body = if url.contains("qrcode/generate") {
                json!({"code": 0, "data": {"url": "https://example.com/q", "qrcode_key": "key123"}})
            } else {
                json!({"code": 0, "data": {}})
            };
            Ok(RawResponse {
                body,
                set_cookies: vec![],
            })
        }
    }
    fn cfg(dir: &std::path::Path) -> SharedConfig {
        SharedConfig {
            dir: dir.to_path_buf(),
            file: dir.join("config.json"),
            inner: Arc::new(RwLock::new(DiskConfig::default())),
        }
    }

    #[test]
    fn qrcode_requires_no_login_and_logout_clears_state() {
        let tmp = tempfile::tempdir().unwrap();
        let config = cfg(tmp.path());
        let api = BiliApi::with_transport(Arc::new(Fake(Mutex::new(vec![]))));
        let st = AppState::new(api, config);
        assert_eq!(st.public_session()["loggedIn"], false);
        let qr = st.qrcode().unwrap();
        assert_eq!(qr["ok"], true);
        assert!(qr["qrSvg"].as_str().unwrap().starts_with("<svg"));
        assert_eq!(st.public_session()["loggedIn"], false);
        st.logout().unwrap();
        assert_eq!(st.public_session()["loggedIn"], false);
    }

    #[test]
    fn poll_rejects_unknown_key_before_network_call() {
        let tmp = tempfile::tempdir().unwrap();
        let transport = Arc::new(Fake(Mutex::new(vec![])));
        let st = AppState::new(BiliApi::with_transport(transport.clone()), cfg(tmp.path()));
        let qr = st.qrcode().unwrap();
        let key = qr["key"].as_str().unwrap().to_string();
        let err = st.poll_qrcode("wrong-key").unwrap_err().to_string();
        assert!(err.contains("不匹配"));
        assert!(!transport
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|(_, u)| u.contains("qrcode/poll")));
        assert_eq!(key, "key123");
    }

    #[test]
    fn poll_rejects_expired_key_before_network_call() {
        let tmp = tempfile::tempdir().unwrap();
        let transport = Arc::new(Fake(Mutex::new(vec![])));
        let st = AppState::new(BiliApi::with_transport(transport.clone()), cfg(tmp.path()));
        let qr = st.qrcode().unwrap();
        st.inner
            .write()
            .unwrap()
            .pending_qr
            .as_mut()
            .unwrap()
            .created_at = now_secs() - QR_TTL_SECS - 1;
        let err = st
            .poll_qrcode(qr["key"].as_str().unwrap())
            .unwrap_err()
            .to_string();
        assert!(err.contains("过期"));
        assert!(!transport
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|(_, u)| u.contains("qrcode/poll")));
    }
}
