//! 单一 lilyco 命令注册表：CLI/TUI/MCP 与 Web API 共用同一套 schema + handler。
use crate::danmu::DanmuHub;
use crate::state::AppState;
use crate::util::mask;
use lilyco::prelude::*;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone)]
pub struct CommandContext {
    pub state: AppState,
    pub danmu: DanmuHub,
}

impl CommandContext {
    pub fn new(state: AppState, danmu: DanmuHub) -> Self {
        Self { state, danmu }
    }
}

fn v(args: &Value, key: &str) -> Value {
    args.get(key).cloned().unwrap_or(Value::Null)
}
fn text(args: &Value, key: &str) -> String {
    v(args, key).as_str().unwrap_or("").to_string()
}
fn number(args: &Value, key: &str) -> Option<i64> {
    v(args, key)
        .as_i64()
        .or_else(|| v(args, key).as_f64().map(|n| n as i64))
}
fn ok() -> Value {
    json!({"ok": true})
}
fn api_error(err: impl std::fmt::Display) -> AppError {
    AppError::Runtime(err.to_string())
}

pub fn dispatch(ctx: &CommandContext, name: &str, args: &Value) -> anyhow::Result<Value> {
    let state = &ctx.state;
    let api = state.api();
    match name {
        "health" => Ok(
            json!({"ok": true, "name": "lyblive", "version": env!("CARGO_PKG_VERSION"), "backend": "lilyco"}),
        ),
        "session" => Ok(state.public_session()),
        "login-qrcode" => state.qrcode(),
        "login-poll" => state.poll_qrcode(&text(args, "key")),
        "login-logout" => {
            state.logout()?;
            Ok(ok())
        }
        "room" => state.room(),
        "partitions" => state.partitions(),
        "title" => {
            let title = text(args, "title");
            if title.trim().is_empty() {
                anyhow::bail!("标题不能为空");
            }
            let (cookie, _) = state.require_csrf()?;
            state.require_login()?;
            let room = state.room_id(None)?;
            api.update_title(&cookie, room, &title)?;
            Ok(ok())
        }
        "area" => {
            let area = number(args, "area-id").unwrap_or(0);
            if area <= 0 {
                anyhow::bail!("分区 ID 无效");
            }
            let (cookie, _) = state.require_csrf()?;
            let room = state.room_id(None)?;
            api.update_area(&cookie, room, area)?;
            Ok(ok())
        }
        "announcement" => {
            let content = text(args, "content");
            let (cookie, _) = state.require_csrf()?;
            let uid = state.require_login()?.uid;
            let room = state.room_id(None)?;
            api.update_announcement(&cookie, room, uid, &content)?;
            Ok(ok())
        }
        "live-start" => {
            let mut area = number(args, "area-id").unwrap_or(0);
            if area <= 0 {
                let _ = state.require_csrf()?;
                let room = state.room_id(None)?;
                let info = api.room_info(room)?;
                area = crate::util::i64_val(&info, "area_id");
                if area <= 0 {
                    area = crate::util::i64_val(&info, "area_v2_id");
                }
            }
            if area <= 0 {
                anyhow::bail!("无法确定直播分区，请显式传入 area-id");
            }
            let (cookie, _) = state.require_csrf()?;
            let room = state.room_id(None)?;
            let (addr, code) = api.start_live(&cookie, room, area)?;
            state.set_rtmp(addr.clone(), code.clone());
            Ok(
                json!({"ok": true, "rtmp": {"addr": addr, "code": mask(&code), "provider": "bilibili"}}),
            )
        }
        "live-stop" => {
            let (cookie, _) = state.require_csrf()?;
            let room = state.room_id(None)?;
            api.stop_live(&cookie, room)?;
            Ok(ok())
        }
        "stream-key" => {
            let reveal = v(args, "reveal").as_bool().unwrap_or(false);
            match state.rtmp() {
                Some(rtmp) => {
                    state.require_login()?;
                    let code = if reveal {
                        rtmp.code.clone()
                    } else {
                        mask(&rtmp.code)
                    };
                    Ok(json!({"ok": true, "addr": rtmp.addr, "code": code, "masked": !reveal}))
                }
                None => Ok(json!({"ok": true, "addr": "", "code": "", "masked": true})),
            }
        }
        "danmu-start" => {
            let room = ctx.danmu.start(number(args, "room-id"))?;
            Ok(json!({"ok": true, "roomId": room}))
        }
        "danmu-stop" => {
            ctx.danmu.stop();
            Ok(ok())
        }
        "danmu-status" => Ok(ctx.danmu.status()),
        "danmu-send" => {
            ctx.danmu.send(&text(args, "msg"))?;
            Ok(ok())
        }
        "config" => Ok(json!({"ok": true, "config": state.config().public()})),
        "config-set" => {
            let remember = v(args, "remember-login").as_bool().unwrap_or(false);
            state.set_remember_login(remember)?;
            Ok(ok())
        }
        "commands" => Ok(json!({"ok": true, "commands": describe_commands()})),
        _ => anyhow::bail!("未知命令: {name}"),
    }
}

fn describe_commands() -> Value {
    let registry = schema_registry();
    let mut out: Vec<Value> = registry
        .iter()
        .map(|cmd| {
            let args: Vec<Value> = cmd
                .schema
                .args
                .iter()
                .map(|a| {
                    let ty = serde_json::to_value(&a.kind)
                        .ok()
                        .and_then(|v| v.get("type").and_then(Value::as_str).map(String::from))
                        .unwrap_or_else(|| "text".into());
                    json!({"name": a.name, "type": ty, "required": a.required})
                })
                .collect();
            let safety = serde_json::to_value(cmd.schema.safety)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| "read_only".into());
            json!({"name": cmd.name, "about": cmd.schema.about, "safety": safety, "args": args})
        })
        .collect();
    out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Value::Array(out)
}

fn make_handler(ctx: CommandContext, name: &'static str) -> Handler {
    Arc::new(move |_progress_ctx, args| dispatch(&ctx, name, args).map_err(api_error))
}
fn add(
    reg: &mut Registry,
    ctx: &Option<CommandContext>,
    name: &'static str,
    about: &'static str,
    tier: SafetyTier,
    args: Vec<ArgSchema>,
) {
    let schema = CommandSchema {
        name: name.into(),
        about: about.into(),
        args,
        subcommands: vec![],
        safety: tier,
    };
    let mut cmd = RegisteredCommand::new(name, schema).hidden(name == "commands");
    if let Some(shared) = ctx {
        cmd = cmd.with_handler(make_handler(shared.clone(), name));
    }
    reg.register(cmd)
        .unwrap_or_else(|e| panic!("注册命令 {name} 失败: {e}"));
}
fn text_arg(name: &str, about: &str, required: bool) -> ArgSchema {
    ArgSchema {
        name: name.into(),
        about: about.into(),
        kind: ArgKind::Text,
        required,
        default: None,
    }
}
fn num_arg(name: &str, about: &str, required: bool) -> ArgSchema {
    ArgSchema {
        name: name.into(),
        about: about.into(),
        kind: ArgKind::Number {
            min: None,
            max: None,
        },
        required,
        default: None,
    }
}
fn flag_arg(name: &str, about: &str) -> ArgSchema {
    ArgSchema {
        name: name.into(),
        about: about.into(),
        kind: ArgKind::Flag,
        required: false,
        default: None,
    }
}
fn none() -> Vec<ArgSchema> {
    vec![]
}

fn schema_registry() -> Registry {
    let mut reg = Registry::new();
    register_all(&mut reg, &None);
    reg
}
pub fn build_registry(ctx: CommandContext, policy: Arc<dyn SafetyPolicy>) -> Registry {
    let mut reg = Registry::new().with_policy(policy);
    let shared = Some(ctx);
    register_all(&mut reg, &shared);
    reg
}

fn register_all(reg: &mut Registry, ctx: &Option<CommandContext>) {
    let t0 = SafetyTier::ReadOnly;
    let t1 = SafetyTier::Confirm;
    add(reg, ctx, "health", "查看服务健康状态", t0, none());
    add(
        reg,
        ctx,
        "session",
        "查看当前登录会话（不返回凭据）",
        t0,
        none(),
    );
    add(
        reg,
        ctx,
        "login-qrcode",
        "获取 B 站扫码登录二维码",
        t1,
        none(),
    );
    add(
        reg,
        ctx,
        "login-poll",
        "轮询扫码登录结果",
        t1,
        vec![text_arg("key", "二维码 key", true)],
    );
    add(
        reg,
        ctx,
        "login-logout",
        "退出登录并清除本地凭据",
        t1,
        none(),
    );
    add(reg, ctx, "room", "查看直播间状态、标题与分区", t0, none());
    add(reg, ctx, "partitions", "查看直播分区列表", t0, none());
    add(
        reg,
        ctx,
        "title",
        "修改直播间标题",
        t1,
        vec![text_arg("title", "直播间标题", true)],
    );
    add(
        reg,
        ctx,
        "area",
        "修改直播间分区",
        t1,
        vec![num_arg("area-id", "二级分区 ID", true)],
    );
    add(
        reg,
        ctx,
        "announcement",
        "修改直播间公告",
        t1,
        vec![text_arg("content", "公告内容", true)],
    );
    add(
        reg,
        ctx,
        "live-start",
        "开始直播并返回打码后的推流信息",
        t1,
        vec![num_arg("area-id", "可选二级分区 ID", false)],
    );
    add(reg, ctx, "live-stop", "停止直播", t1, none());
    add(
        reg,
        ctx,
        "stream-key",
        "查看推流地址与密钥（默认打码）",
        t0,
        vec![flag_arg("reveal", "是否显示明文")],
    );
    add(
        reg,
        ctx,
        "danmu-start",
        "启动弹幕监听",
        t1,
        vec![num_arg("room-id", "可选房间号", false)],
    );
    add(reg, ctx, "danmu-stop", "停止弹幕监听", t1, none());
    add(
        reg,
        ctx,
        "danmu-status",
        "查看弹幕统计与最近消息",
        t0,
        none(),
    );
    add(
        reg,
        ctx,
        "danmu-send",
        "发送一条弹幕（高风控）",
        t1,
        vec![text_arg("msg", "弹幕文本", true)],
    );
    add(reg, ctx, "config", "查看本地配置（不返回凭据）", t0, none());
    add(
        reg,
        ctx,
        "config-set",
        "设置是否记住登录（凭据以 0600 保存）",
        t1,
        vec![flag_arg("remember-login", "是否记住登录")],
    );
    add(
        reg,
        ctx,
        "commands",
        "列出全部命令及其参数和安全级别",
        t0,
        none(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bili::{BiliApi, RawResponse, Transport};
    use crate::danmu::DanmuHub;
    use crate::settings::{DiskConfig, SharedConfig};
    use crate::state::AppState;
    use std::sync::{Arc, Mutex, RwLock};

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
    fn context() -> CommandContext {
        let dir = std::env::temp_dir().join(format!("lyblive-command-test-{}", std::process::id()));
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
        CommandContext::new(state, danmu)
    }

    #[test]
    fn stream_key_without_login_returns_masked_empty_value() {
        let out = dispatch(&context(), "stream-key", &json!({})).unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["masked"], true);
        assert_eq!(out["code"], "");
    }

    #[test]
    fn schema_contains_all_agent_visible_commands() {
        let reg = schema_registry();
        assert_eq!(reg.iter().count(), 20);
        assert!(reg.get("health").is_some());
        assert!(reg.get("commands").unwrap().hidden);
    }

    /// 单一注册表驱动的穷举契约：白名单、分级、Agent 策略、文档常量同步，
    /// 防止将来新增/改名/降级命令时静默扩大 AI 可执行面。
    #[test]
    fn agent_whitelist_matches_registry_tiers_and_gate() {
        use crate::policy::{Agent, AGENT_ALLOWED};
        use lilyco::prelude::{GateDecision, GateRequest, SafetyPolicy};
        use std::collections::BTreeSet;

        let reg = schema_registry();
        let args = json!({});
        let decide = |name: &str, tier: SafetyTier| {
            Agent.check(GateRequest {
                command: name,
                tier,
                args: &args,
            })
        };
        let allowed: BTreeSet<&str> = AGENT_ALLOWED.iter().copied().collect();
        assert_eq!(
            allowed.len(),
            AGENT_ALLOWED.len(),
            "AGENT_ALLOWED has duplicate names"
        );
        let mut confirm_names = BTreeSet::new();
        for cmd in reg.iter() {
            let name = cmd.name.as_str();
            let tier = cmd.schema.safety;
            match tier {
                SafetyTier::ReadOnly => assert!(
                    matches!(decide(name, tier), GateDecision::Allow),
                    "T0 {name} must be allowed"
                ),
                SafetyTier::Confirm => {
                    confirm_names.insert(name);
                    assert!(
                        !cmd.hidden,
                        "whitelisted T1 command {name} must not be hidden"
                    );
                    if allowed.contains(name) {
                        assert!(
                            matches!(decide(name, tier), GateDecision::Allow),
                            "whitelisted T1 {name} must be allowed"
                        );
                    } else {
                        assert!(
                            matches!(decide(name, tier), GateDecision::Deny(_)),
                            "non-whitelisted T1 {name} must be denied"
                        );
                    }
                }
                other => panic!("unexpected tier {other:?} on {name}; Agent must fail closed"),
            }
        }
        let missing: Vec<&str> = allowed.difference(&confirm_names).copied().collect();
        assert!(
            missing.is_empty(),
            "AGENT_ALLOWED names absent or not T1: {missing:?}"
        );
        let extra: Vec<&str> = confirm_names.difference(&allowed).copied().collect();
        assert_eq!(
            extra.len(),
            5,
            "Agent-denied T1 set changed; update docs/smoke: {extra:?}"
        );
        assert_eq!(
            allowed.len(),
            7,
            "explicit Agent write whitelist size changed"
        );
        for tier in [SafetyTier::Token, SafetyTier::NeverAuto] {
            assert!(
                matches!(decide("future-command", tier), GateDecision::Deny(_)),
                "Agent must deny {tier:?}"
            );
            for name in AGENT_ALLOWED {
                assert!(
                    matches!(decide(name, tier), GateDecision::Deny(_)),
                    "whitelist must not override {tier:?} for {name}"
                );
            }
        }
    }
    fn unique_context(tag: &str) -> (CommandContext, std::path::PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "lyblive-handler-policy-{}-{}-{}",
            std::process::id(),
            tag,
            nanos
        ));
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
        (CommandContext::new(state, danmu), dir)
    }

    #[test]
    fn registered_handlers_enforce_runtime_policy_for_local_and_agent() {
        use crate::policy::{Agent, Local};
        use lilyco::prelude::{AppError, Context};

        let (local_ctx, local_dir) = unique_context("local");
        let (agent_ctx, agent_dir) = unique_context("agent");
        let local = build_registry(local_ctx, Arc::new(Local));
        let agent = build_registry(agent_ctx, Arc::new(Agent));
        assert_eq!(local.iter().count(), 20);
        assert_eq!(agent.iter().count(), 20);
        for cmd in local.iter().chain(agent.iter()) {
            assert!(
                cmd.handler.is_some(),
                "runtime registry lost handler: {}",
                cmd.name
            );
        }

        let (tx, _rx) = std::sync::mpsc::channel();
        let ctx = Context::new_test(tx);
        let args = json!({});
        let invoke = |reg: &Registry, name: &str| -> Result<Value, AppError> {
            let handler = reg
                .get(name)
                .and_then(|cmd| cmd.handler.clone())
                .unwrap_or_else(|| panic!("missing handler: {name}"));
            handler(&ctx, &args)
        };

        // T0 与白名单 T1：Local/Agent 的实际 handler 都进入 dispatch。
        for reg in [&local, &agent] {
            assert_eq!(invoke(reg, "health").unwrap()["ok"], json!(true));
            assert_eq!(invoke(reg, "danmu-stop").unwrap(), ok());
        }
        // 非白名单 T1：Local handler 到达 dispatch（隔离目录内清理凭据），
        // Agent handler 在 register() 包装的安全门处提前拒绝，绝不执行内层逻辑。
        assert_eq!(invoke(&local, "login-logout").unwrap(), ok());
        assert!(
            local_dir.join("config.json").exists(),
            "Local T1 handler did not reach commands::dispatch"
        );
        for name in [
            "live-start",
            "live-stop",
            "danmu-send",
            "config-set",
            "login-logout",
        ] {
            match invoke(&agent, name) {
                Err(AppError::Safety(msg)) => {
                    assert!(
                        msg.contains("Agent 调用面未放行"),
                        "unexpected gate reason: {msg}"
                    );
                    assert!(msg.contains(name), "gate reason omitted command: {msg}");
                }
                other => panic!("Agent {name} handler must be denied before dispatch: {other:?}"),
            }
        }
        assert!(
            !agent_dir.join("config.json").exists(),
            "Agent-denied handler unexpectedly reached credential-clearing dispatch"
        );
        let _ = std::fs::remove_dir_all(local_dir);
        let _ = std::fs::remove_dir_all(agent_dir);
    }
}
