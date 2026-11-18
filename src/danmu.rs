use std::collections::{BTreeMap, VecDeque};
use std::io::Read;
use std::net::TcpStream;
use std::sync::{Arc, RwLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::util::now_ms;

use anyhow::{anyhow, Result};
use base64::Engine as _;
use brotli::Decompressor as BrotliDecompressor;
use flate2::read::ZlibDecoder;
use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::header::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message, WebSocket};

use crate::state::AppState;
use crate::util::{i64_val, now_secs, obj, str_val};

#[derive(Clone, Debug)]
pub struct DanmuItem {
    pub ts: u64,
    pub kind: String,
    pub user: String,
    /// 头像 URL（B 站 CDN）；老格式消息可能为空
    pub face: String,
    pub text: String,
    /// 礼物原名（仅 gift 消息）
    pub gift_name: String,
    /// 礼物数量（仅 gift 消息，至少 1）
    pub gift_num: i64,
    /// 礼物图标 URL（仅 gift 消息）
    pub gift_icon: String,
}

/// 解析后的原始消息；非礼物类消息的 gift_* 字段为空。
#[derive(Default)]
struct Parsed {
    kind: String,
    user: String,
    text: String,
    face: String,
    gift_name: String,
    gift_num: i64,
    gift_icon: String,
}

#[derive(Default)]
struct PbInteract {
    uname: String,
    msg_type: i64,
    face: String,
}

fn read_varint(buf: &[u8], i: &mut usize) -> Option<u64> {
    let mut r = 0u64;
    let mut shift = 0u32;
    loop {
        let b = *buf.get(*i)?;
        *i += 1;
        r |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Some(r);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

fn walk_pb(buf: &[u8], mut f: impl FnMut(u64, u64, &[u8])) {
    let mut i = 0usize;
    while i < buf.len() {
        let Some(key) = read_varint(buf, &mut i) else {
            return;
        };
        match key & 7 {
            0 => {
                let Some(v) = read_varint(buf, &mut i) else {
                    return;
                };
                f(key >> 3, v, &[]);
            }
            2 => {
                let Some(len) = read_varint(buf, &mut i) else {
                    return;
                };
                let Some(end) = i.checked_add(len as usize) else {
                    return;
                };
                if end > buf.len() {
                    return;
                }
                f(key >> 3, 0, &buf[i..end]);
                i = end;
            }
            1 => i += 8,
            5 => i += 4,
            _ => return,
        }
    }
}

// INTERACT_WORD_V2 只给 `data.pb`（base64 protobuf），用户名/类型/头像都在里面。
fn decode_interact_pb(b64: &str) -> Option<PbInteract> {
    let buf = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let mut out = PbInteract::default();
    let mut base: Option<Vec<u8>> = None;
    walk_pb(&buf, |field, v, bytes| match field {
        2 => out.uname = String::from_utf8_lossy(bytes).into_owned(),
        5 => out.msg_type = v as i64,
        22 => walk_pb(bytes, |f2, _, b2| {
            if f2 == 2 {
                base = Some(b2.to_vec());
            }
        }),
        _ => {}
    });
    if let Some(b) = base {
        walk_pb(&b, |field, _, bytes| match field {
            1 => {
                if out.uname.is_empty() {
                    out.uname = String::from_utf8_lossy(bytes).into_owned();
                }
            }
            2 => out.face = String::from_utf8_lossy(bytes).into_owned(),
            _ => {}
        });
    }
    Some(out)
}

#[derive(Clone, Debug)]
pub struct Stats {
    pub danmu: u64,
    pub gift: u64,
    pub enter: u64,
    pub popularity: u64,
    pub words: BTreeMap<String, u64>,
    pub recent: VecDeque<DanmuItem>,
}

impl Default for Stats {
    fn default() -> Self {
        Self {
            danmu: 0,
            gift: 0,
            enter: 0,
            popularity: 0,
            words: BTreeMap::new(),
            recent: VecDeque::with_capacity(300),
        }
    }
}

struct Runtime {
    running: bool,
    room_id: i64,
    started_at: i64,
    stop: bool,
    generation: u64,
    worker: Option<JoinHandle<()>>,
    stats: Stats,
    subscribers: Vec<tokio::sync::mpsc::UnboundedSender<Value>>,
}

#[derive(Clone)]
pub struct DanmuHub {
    state: AppState,
    inner: Arc<RwLock<Runtime>>,
}

impl DanmuHub {
    pub fn new(state: AppState) -> Self {
        Self {
            state,
            inner: Arc::new(RwLock::new(Runtime {
                running: false,
                room_id: 0,
                started_at: 0,
                stop: false,
                generation: 0,
                worker: None,
                stats: Stats::default(),
                subscribers: Vec::new(),
            })),
        }
    }

    pub fn status(&self) -> Value {
        let r = self.inner.read().unwrap();
        let recent: Vec<Value> = r
            .stats
            .recent
            .iter()
            .rev()
            .take(50)
            .map(|x| {
                json!({
                    "ts": x.ts, "kind": x.kind, "user": x.user, "face": x.face, "text": x.text,
                    "giftName": x.gift_name, "giftNum": x.gift_num, "giftIcon": x.gift_icon,
                })
            })
            .collect();
        let mut top: Vec<(String, u64)> =
            r.stats.words.iter().map(|(k, v)| (k.clone(), *v)).collect();
        top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        top.truncate(10);
        let keywords: Vec<Value> = top
            .into_iter()
            .map(|(word, count)| json!({"word": word, "count": count}))
            .collect();
        json!({
            "ok": true,
            "running": r.running,
            "roomId": r.room_id,
            "startedAt": if r.started_at > 0 { Value::from(r.started_at) } else { Value::Null },
            "stats": {
                "danmu": r.stats.danmu, "gift": r.stats.gift,
                "enter": r.stats.enter, "popularity": r.stats.popularity,
                "topKeywords": keywords,
            },
            "recent": recent,
        })
    }

    pub fn subscribe(&self) -> tokio::sync::mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let mut r = self.inner.write().unwrap();
        r.subscribers.retain(|s| !s.is_closed());
        r.subscribers.push(tx);
        rx
    }

    pub fn start(&self, explicit_room: Option<i64>) -> Result<i64> {
        if let Some(id) = explicit_room {
            if id <= 0 {
                anyhow::bail!("room_id 必须大于 0");
            }
        }
        let room_id = self.state.room_id(explicit_room)?;
        let session = self.state.require_login()?;
        let wbi = self.state.wbi_keys()?;
        let api = self.state.api();
        let (token, url, _port) = api.danmu_info(&session.cookie, room_id, &wbi)?;
        let buvid = api.buvid3().unwrap_or_default();
        let hub = self.clone();
        let mut r = self.inner.write().unwrap();
        self.request_stop_locked(&mut r);
        r.generation = r.generation.wrapping_add(1);
        let generation = r.generation;
        r.stop = false;
        r.running = true;
        r.room_id = room_id;
        r.started_at = now_secs();
        r.stats = Stats::default();
        let worker = thread::Builder::new()
            .name("lyblive-danmu".into())
            .spawn(move || {
                hub.run_ws(room_id, session.uid, &token, &url, &buvid, generation);
            })
            .map_err(|e| anyhow!("启动弹幕线程失败: {e}"))?;
        r.worker = Some(worker);
        Ok(room_id)
    }

    pub fn stop(&self) {
        let mut r = self.inner.write().unwrap();
        self.request_stop_locked(&mut r);
        r.running = false;
        self.broadcast_locked(&r, json!({"running": false, "kind": "system", "text": "弹幕连接已停止", "ts": now_ms(), "user": ""}));
    }

    pub fn send(&self, msg: &str) -> Result<()> {
        let text = msg.trim();
        if text.is_empty() {
            anyhow::bail!("弹幕内容不能为空");
        }
        if text.chars().count() > 20 {
            anyhow::bail!("弹幕最多 20 个字符");
        }
        let room_id = {
            let r = self.inner.read().unwrap();
            if r.running && r.room_id > 0 {
                r.room_id
            } else {
                0
            }
        };
        let room_id = if room_id > 0 {
            room_id
        } else {
            self.state.room_id(None)?
        };
        let (cookie, _csrf) = self.state.require_csrf()?;
        let wbi = self.state.wbi_keys()?;
        self.state.api().send_danmu(&cookie, room_id, text, &wbi)?;
        Ok(())
    }

    fn request_stop_locked(&self, r: &mut Runtime) {
        r.stop = true;
        r.running = false;
    }

    fn broadcast_locked(&self, r: &Runtime, payload: Value) {
        r.subscribers.iter().for_each(|tx| {
            let _ = tx.send(payload.clone());
        });
    }

    pub fn push(&self, item: DanmuItem) {
        let mut r = self.inner.write().unwrap();
        match item.kind.as_str() {
            "danmu" => r.stats.danmu += 1,
            "gift" => r.stats.gift += 1,
            "enter" => r.stats.enter += 1,
            _ => {}
        }
        if item.kind == "danmu" {
            for word in item.text.split_whitespace() {
                let w: String = word
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .take(16)
                    .collect();
                if w.chars().count() >= 2 {
                    *r.stats.words.entry(w).or_insert(0) += 1;
                }
            }
        }
        r.stats.recent.push_back(item.clone());
        while r.stats.recent.len() > 300 {
            r.stats.recent.pop_front();
        }
        let payload = json!({
            "ts": item.ts, "kind": item.kind, "user": item.user, "face": item.face, "text": item.text,
            "giftName": item.gift_name, "giftNum": item.gift_num, "giftIcon": item.gift_icon,
            "running": r.running, "popularity": r.stats.popularity,
        });
        self.broadcast_locked(&r, payload);
    }

    pub fn set_popularity(&self, value: u64) {
        let mut r = self.inner.write().unwrap();
        r.stats.popularity = value;
    }

    fn generation_active(&self, generation: u64) -> bool {
        let r = self.inner.read().unwrap();
        !r.stop && r.generation == generation
    }

    fn run_ws(&self, room_id: i64, uid: i64, token: &str, url: &str, buvid: &str, generation: u64) {
        let mut attempt: u32 = 0;
        while self.generation_active(generation) {
            attempt += 1;
            match self.connect_once(room_id, uid, token, url, buvid, generation) {
                Ok(_) => {}
                Err(e) => tracing::warn!("弹幕连接断开: {e}"),
            }
            if !self.generation_active(generation) {
                break;
            }
            let wait = 5u64
                .saturating_mul(1u64 << attempt.saturating_sub(1).min(6))
                .min(60);
            for _ in 0..wait {
                if !self.generation_active(generation) {
                    return;
                }
                thread::sleep(Duration::from_secs(1));
            }
        }
        tracing::info!("弹幕监听线程已结束，room={room_id}");
    }

    fn connect_once(
        &self,
        room_id: i64,
        uid: i64,
        token: &str,
        url: &str,
        buvid: &str,
        generation: u64,
    ) -> Result<()> {
        // 必须让 tungstenite 生成完整握手（Sec-WebSocket-Key / Upgrade / Connection）；
        // 手写 http::Request 会缺这些头，B 站直接拒绝升级（"Missing ... Sec-WebSocket-Key"）。
        let mut req = url
            .into_client_request()
            .map_err(|e| anyhow!("WebSocket 请求构造失败: {e}"))?;
        {
            let headers = req.headers_mut();
            headers.insert(
                "User-Agent",
                HeaderValue::from_static(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
                ),
            );
            headers.insert(
                "Origin",
                HeaderValue::from_static("https://live.bilibili.com"),
            );
            headers.insert(
                "Cookie",
                HeaderValue::from_str(&format!("buvid3={buvid}; DedeUserID={uid}"))
                    .map_err(|e| anyhow!("Cookie 头非法: {e}"))?,
            );
        }
        let (mut ws, _resp) = connect(req).map_err(|e| anyhow!("WebSocket 握手失败: {e}"))?;
        set_read_timeout(&mut ws, Duration::from_secs(31))?;
        let auth = json!({"uid": uid, "roomid": room_id, "protover": 3, "platform": "web", "type": 2, "key": token});
        ws.send(Message::Binary(
            packet(7, auth.to_string().as_bytes()).into(),
        ))
        .map_err(|e| anyhow!("发送认证包失败: {e}"))?;
        ws.send(Message::Binary(packet(2, b"[object Object]").into()))
            .map_err(|e| anyhow!("发送心跳包失败: {e}"))?;
        let mut last_heartbeat = std::time::Instant::now();
        loop {
            if !self.generation_active(generation) {
                break;
            }
            match ws.read() {
                Ok(Message::Binary(data)) => {
                    for item in self.decode_frames(&data, 0)? {
                        if let Some(v) = item {
                            self.push(DanmuItem {
                                ts: now_ms(),
                                kind: v.kind,
                                user: v.user,
                                face: v.face,
                                text: v.text,
                                gift_name: v.gift_name,
                                gift_num: v.gift_num,
                                gift_icon: v.gift_icon,
                            });
                        } else { /* popularity or ack handled inside decode */
                        }
                    }
                }
                Ok(Message::Text(text)) => tracing::debug!("弹幕文本帧: {}", text),
                Ok(Message::Ping(v)) => {
                    let _ = ws.send(Message::Pong(v));
                }
                Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {}
                Ok(Message::Close(_)) => break,
                Err(tungstenite::Error::Io(ref e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(e) => return Err(anyhow!("WebSocket 读取失败: {e}")),
            }
            if last_heartbeat.elapsed() >= Duration::from_secs(30) {
                ws.send(Message::Binary(packet(2, b"[object Object]").into()))
                    .map_err(|e| anyhow!("发送心跳包失败: {e}"))?;
                last_heartbeat = std::time::Instant::now();
            }
        }
        let _ = ws.close(None);
        Ok(())
    }

    fn decode_frames(&self, bytes: &[u8], depth: u8) -> Result<Vec<Option<Parsed>>> {
        if depth > 4 {
            return Ok(vec![]);
        }
        let mut out: Vec<Option<Parsed>> = Vec::new();
        let mut offset = 0usize;
        while offset + 16 <= bytes.len() {
            let len = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            let header = u16::from_be_bytes(bytes[offset + 4..offset + 6].try_into().unwrap());
            let proto = u16::from_be_bytes(bytes[offset + 6..offset + 8].try_into().unwrap());
            let op = u32::from_be_bytes(bytes[offset + 8..offset + 12].try_into().unwrap());
            if len < 16 || header != 16 || offset + len > bytes.len() {
                break;
            }
            let body = &bytes[offset + 16..offset + len];
            offset += len;
            match proto {
                2 => {
                    let mut buf = Vec::new();
                    ZlibDecoder::new(body)
                        .read_to_end(&mut buf)
                        .map_err(|e| anyhow!("zlib 解压失败: {e}"))?;
                    out.extend(self.decode_frames(&buf, depth + 1)?);
                }
                3 => {
                    let mut buf = Vec::new();
                    BrotliDecompressor::new(body, 4096)
                        .read_to_end(&mut buf)
                        .map_err(|e| anyhow!("brotli 解压失败: {e}"))?;
                    out.extend(self.decode_frames(&buf, depth + 1)?);
                }
                _ => {
                    if op == 3 && body.len() >= 4 {
                        self.set_popularity(
                            u32::from_be_bytes(body[..4].try_into().unwrap()) as u64
                        );
                    } else if op == 5 {
                        if let Ok(v) = serde_json::from_slice::<Value>(body) {
                            out.push(self.parse_command(&v));
                        }
                    }
                }
            }
        }
        Ok(out)
    }

    fn parse_command(&self, v: &Value) -> Option<Parsed> {
        let cmd = str_val(v, "cmd");
        // B 站命令存在多种变体：DANMU_MSG:4:0:2:2:2:0、INTERACT_WORD_V2、
        // COMBO_SEND:... —— 必须用前缀匹配，精确比较会把观众消息整批丢掉。
        if cmd.starts_with("DANMU_MSG") {
            let info = obj(v, "info");
            let arr = info.as_array()?;
            if tracing::enabled!(tracing::Level::DEBUG) {
                let raw = serde_json::to_string(&info).unwrap_or_default();
                tracing::debug!(raw = %raw.chars().take(1500).collect::<String>(), "DANMU_MSG raw");
            }
            let text = arr.get(1)?.as_str().unwrap_or_default().to_string();
            let user_info = arr.get(2)?.as_array()?;
            let mut user = user_info.get(1)?.as_str().unwrap_or_default().to_string();
            let mut face = String::new();
            // 用户资料在 info[0] 里的一段对象中（不同版本位置会变，逐项扫描最稳）。
            if let Some(first) = arr.first().and_then(|v| v.as_array()) {
                for entry in first {
                    let Some(user_obj) = entry.get("user") else {
                        continue;
                    };
                    let base = user_obj.get("base").unwrap_or(user_obj);
                    if user.is_empty() {
                        user = str_val(base, "name");
                    }
                    let candidate = str_val(base, "face");
                    if !candidate.is_empty() {
                        face = candidate;
                        break;
                    }
                }
                if tracing::enabled!(tracing::Level::DEBUG) {
                    tracing::debug!(
                        len = first.len(),
                        face_found = !face.is_empty(),
                        "DANMU_MSG info0 scan"
                    );
                }
            }
            return Some(Parsed {
                kind: "danmu".into(),
                user,
                text,
                face,
                ..Parsed::default()
            });
        }

        if cmd.starts_with("SEND_GIFT") {
            let d = obj(v, "data");
            let mut gift_name = str_val(d, "giftName");
            if gift_name.is_empty() {
                gift_name = str_val(d, "gift_name");
            }
            let mut num = i64_val(d, "num");
            if num <= 0 {
                num = i64_val(d, "batch_combo_num");
            }
            if num <= 0 {
                num = i64_val(d, "combo_num");
            }
            if num <= 0 {
                num = 1;
            }
            // 不同版本把图标放在 giftInfo / gift_info / 顶层，逐层回退最稳。
            let info = obj(d, "giftInfo");
            let legacy = obj(d, "gift_info");
            let mut gift_icon = str_val(info, "img_basic");
            for candidate in [
                str_val(info, "webp"),
                str_val(info, "gif"),
                str_val(legacy, "img_basic"),
                str_val(legacy, "webp"),
                str_val(legacy, "gif"),
                str_val(d, "img_basic"),
                str_val(d, "giftIcon"),
            ] {
                if !gift_icon.is_empty() {
                    break;
                }
                gift_icon = candidate;
            }
            let text = if gift_name.is_empty() {
                format!("礼物 ×{num}")
            } else if num > 1 {
                format!("{gift_name} ×{num}")
            } else {
                gift_name.clone()
            };
            return Some(Parsed {
                kind: "gift".into(),
                user: str_val(d, "uname"),
                text,
                face: str_val(d, "face"),
                gift_name,
                gift_num: num,
                gift_icon,
            });
        }

        if cmd.starts_with("INTERACT_WORD")
            || cmd.starts_with("ENTRY_EFFECT")
            || cmd.starts_with("COMBO_SEND")
        {
            let d = obj(v, "data");
            if tracing::enabled!(tracing::Level::DEBUG) {
                tracing::debug!(
                    cmd = %cmd,
                    raw = %v.to_string().chars().take(1200).collect::<String>(),
                    "interact raw"
                );
            }
            let mut user = str_val(d, "uname");
            let mut face = str_val(d, "face");
            let mut msg_type = i64_val(d, "msg_type");
            let pb = str_val(d, "pb");
            if !pb.is_empty() {
                if let Some(info) = decode_interact_pb(&pb) {
                    if user.is_empty() {
                        user = info.uname;
                    }
                    if msg_type == 0 {
                        msg_type = info.msg_type;
                    }
                    if face.is_empty() {
                        face = info.face;
                    }
                }
            }
            if user.is_empty() {
                user = str_val(obj(d, "uinfo"), "uname");
            }
            if face.is_empty() {
                face = str_val(obj(d, "uinfo"), "face");
            }
            let text = if cmd.starts_with("INTERACT_WORD") {
                match msg_type {
                    1 => "进入直播间",
                    2 => "关注了直播间",
                    3 => "分享了直播间",
                    4 => "特别关注",
                    _ => "互动",
                }
                .to_string()
            } else if cmd.starts_with("ENTRY_EFFECT") {
                str_val(d, "copy_writing")
                    .replace("<%", "")
                    .replace("%>", "")
            } else {
                format!("连击 x{}", i64_val(d, "combo_num"))
            };
            return Some(Parsed {
                kind: "enter".into(),
                user,
                text,
                face,
                ..Parsed::default()
            });
        }

        tracing::debug!(cmd = %cmd, "未处理的弹幕命令");
        None
    }
}

fn set_read_timeout(
    ws: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    timeout: Duration,
) -> Result<()> {
    match ws.get_mut() {
        MaybeTlsStream::Plain(s) => s.set_read_timeout(Some(timeout))?,
        MaybeTlsStream::Rustls(s) => s.get_mut().set_read_timeout(Some(timeout))?,
        _ => {}
    }
    Ok(())
}

fn packet(op: u32, body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(16 + body.len());
    v.extend_from_slice(&((16 + body.len()) as u32).to_be_bytes());
    v.extend_from_slice(&16u16.to_be_bytes());
    v.extend_from_slice(&1u16.to_be_bytes());
    v.extend_from_slice(&op.to_be_bytes());
    v.extend_from_slice(&1u32.to_be_bytes());
    v.extend_from_slice(body);
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bili::{BiliApi, RawResponse, Transport};
    use crate::settings::{DiskConfig, SharedConfig};
    use std::io::Write;
    use std::sync::Mutex;

    struct Fake(Mutex<Vec<String>>);
    impl Transport for Fake {
        fn call(
            &self,
            _m: &str,
            url: &str,
            _q: &[(String, String)],
            _f: Option<&[(String, String)]>,
            _c: Option<&str>,
        ) -> Result<RawResponse> {
            self.0.lock().unwrap().push(url.to_string());
            Ok(RawResponse {
                body: json!({"code": 0, "data": {}}),
                set_cookies: vec![],
            })
        }
    }
    fn state() -> AppState {
        let dir = std::env::temp_dir().join(format!("lyblive-danmu-test-{}", std::process::id()));
        AppState::new(
            BiliApi::with_transport(Arc::new(Fake(Mutex::new(vec![])))),
            SharedConfig {
                dir: dir.clone(),
                file: dir.join("config.json"),
                inner: Arc::new(RwLock::new(DiskConfig::default())),
            },
        )
    }

    #[test]
    fn packet_header_and_stats_are_bounded() {
        let p = packet(7, b"abc");
        assert_eq!(p.len(), 19);
        assert_eq!(u32::from_be_bytes(p[0..4].try_into().unwrap()), 19);
        assert_eq!(u32::from_be_bytes(p[8..12].try_into().unwrap()), 7);
        let hub = DanmuHub::new(state());
        for i in 0..305 {
            hub.push(DanmuItem {
                ts: 1000 + i,

                kind: "danmu".into(),
                user: "u".into(),
                face: String::new(),
                text: format!("关键词{i} 测试"),
                gift_name: String::new(),
                gift_num: 0,
                gift_icon: String::new(),
            });
        }
        let s = hub.status();
        assert_eq!(s["stats"]["danmu"], 305);
        assert_eq!(s["recent"].as_array().unwrap().len(), 50);
    }

    #[test]
    fn parses_face_url_from_user_base() {
        let hub = DanmuHub::new(state());
        let dm = json!({
            "cmd": "DANMU_MSG:4:0:2:2:2:0",
            "info": [
                [null, null, null, null, null, null, null, null,
                 null, null, null, null, null, null, null,
                 {"user": {"base": {"name": "小明", "face": "https://i2.hdslb.com/bfs/face/x.jpg"}}}],
                "带脸",
                [123, "小明", 0]
            ]
        });
        let got = hub.parse_command(&dm).unwrap();
        assert_eq!(got.user, "小明");
        assert_eq!(got.face, "https://i2.hdslb.com/bfs/face/x.jpg");
    }

    #[test]
    fn decodes_interact_word_v2_pb() {
        let hub = DanmuHub::new(state());
        let v = json!({
            "cmd": "INTERACT_WORD_V2",
            "data": {
                "dmscore": 3,
                "pb": "CK+WgLftsqYGEgd6aHl1dWthIgEBKAEwtOj83AY4noj31wZA7qyY+p40YgB4sticre+oy/QYmgEAsgFmCK+WgLftsqYGElUKB3poeXV1a2ESSmh0dHBzOi8vaTEuaGRzbGIuY29tL2Jmcy9mYWNlL2Y5YjcyMjVkYmM2NTYzMTM5NTA4YmIxYmZjOGY2YjAzYmM0Y2IzNjQuanBnIgIIBzIAugEAwgEA"
            }
        });
        let got = hub.parse_command(&v).unwrap();
        assert_eq!(got.kind, "enter");
        assert_eq!(got.user, "zhyuuka");
        assert_eq!(got.text, "进入直播间");
        assert!(got.face.starts_with("https://i1.hdslb.com/bfs/face/"));
    }

    #[test]
    fn interact_word_legacy_fields_still_work() {
        let hub = DanmuHub::new(state());
        let v = json!({
            "cmd": "INTERACT_WORD",
            "data": {"uname": "小明", "msg_type": 2, "uinfo": {"face": "https://x/f.jpg"}}
        });
        let got = hub.parse_command(&v).unwrap();
        assert_eq!(got.user, "小明");
        assert_eq!(got.text, "关注了直播间");
        assert_eq!(got.face, "https://x/f.jpg");
    }

    #[test]
    fn status_carries_face_for_avatar_rendering() {
        let hub = DanmuHub::new(state());
        hub.push(DanmuItem {
            ts: 1,
            kind: "danmu".into(),
            user: "u".into(),
            face: "https://x/f.jpg".into(),
            text: "hi".into(),
            gift_name: String::new(),
            gift_num: 0,
            gift_icon: String::new(),
        });
        let s = hub.status();
        assert_eq!(s["recent"][0]["face"], "https://x/f.jpg");
    }

    #[test]
    fn parses_danmu_and_gift_commands() {
        let hub = DanmuHub::new(state());
        let dm = json!({"cmd": "DANMU_MSG", "info": ["", "你好 世界", [123, "小明", 0]]});
        let got = hub.parse_command(&dm).unwrap();
        assert_eq!(got.kind, "danmu");
        assert_eq!(got.user, "小明");
        assert_eq!(got.text, "你好 世界");

        let gift = json!({
            "cmd": "SEND_GIFT",
            "data": {
                "giftName": "辣条", "uname": "小红", "num": 3,
                "face": "https://i0.hdslb.com/bfs/face/g.jpg",
                "giftInfo": {"img_basic": "https://i0.hdslb.com/bfs/gift/latiao.png"}
            }
        });
        let got = hub.parse_command(&gift).unwrap();
        assert_eq!(got.kind, "gift");
        assert_eq!(got.user, "小红");
        assert_eq!(got.gift_name, "辣条");
        assert_eq!(got.gift_num, 3);
        assert_eq!(got.gift_icon, "https://i0.hdslb.com/bfs/gift/latiao.png");
        assert_eq!(got.text, "辣条 ×3");
        assert_eq!(got.face, "https://i0.hdslb.com/bfs/face/g.jpg");

        let combo = json!({
            "cmd": "SEND_GIFT",
            "data": {"giftName": "辣条", "num": 0, "batch_combo_num": 5, "uname": "u"}
        });
        assert_eq!(hub.parse_command(&combo).unwrap().gift_num, 5);
    }

    #[test]
    fn decodes_brotli_compressed_frames() {
        let hub = DanmuHub::new(state());
        let inner = packet(5, br#"{"cmd":"DANMU_MSG","info":["","hello",[1,"u",0]]}"#);
        let mut compressed = Vec::new();
        {
            let mut w = brotli::CompressorWriter::new(&mut compressed, 4096, 5, 22);
            w.write_all(&inner).unwrap();
        }
        let outer = packet(5, &compressed);
        assert_eq!(outer.len(), compressed.len() + 16);
        let mut framed = outer[0..6].to_vec();
        framed.extend_from_slice(&3u16.to_be_bytes());
        framed.extend_from_slice(&outer[8..]);
        let got = hub.decode_frames(&framed, 0).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].as_ref().unwrap().text, "hello");
    }
}
