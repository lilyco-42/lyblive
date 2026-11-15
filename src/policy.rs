//! 安全分级：本地交互放行 T0/T1；MCP Agent 只放行 T0 与白名单写命令。

use lilyco::prelude::{GateDecision, GateRequest, SafetyPolicy, SafetyTier};

pub struct Local;
impl SafetyPolicy for Local {
    fn check(&self, req: GateRequest<'_>) -> GateDecision {
        match req.tier {
            SafetyTier::ReadOnly | SafetyTier::Confirm => GateDecision::Allow,
            other => GateDecision::Deny(format!(
                "命令 {} 分级为 {}：本地只放行 T0/T1",
                req.command,
                other.tag()
            )),
        }
    }
}

pub struct Agent;
/// 允许 Agent 调用的写操作；开播/停播/发送弹幕刻意排除，需人类在 Web/CLI 执行。
pub const AGENT_ALLOWED: &[&str] = &[
    "login-qrcode",
    "login-poll",
    "danmu-start",
    "danmu-stop",
    "title",
    "area",
    "announcement",
];
impl SafetyPolicy for Agent {
    fn check(&self, req: GateRequest<'_>) -> GateDecision {
        match req.tier {
            SafetyTier::ReadOnly => GateDecision::Allow,
            SafetyTier::Confirm if AGENT_ALLOWED.contains(&req.command) => GateDecision::Allow,
            other => GateDecision::Deny(format!(
                "命令 {} 分级为 {}：Agent 调用面未放行（请用 Web 或 CLI）",
                req.command,
                other.tag()
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn decide<P: SafetyPolicy>(p: &P, cmd: &str, tier: SafetyTier) -> GateDecision {
        let args = serde_json::json!({});
        p.check(GateRequest {
            command: cmd,
            tier,
            args: &args,
        })
    }
    #[test]
    fn agent_denies_live_start() {
        assert!(matches!(
            decide(&Agent, "live-start", SafetyTier::Confirm),
            GateDecision::Deny(_)
        ));
    }
    #[test]
    fn agent_allows_readonly() {
        assert!(matches!(
            decide(&Agent, "room", SafetyTier::ReadOnly),
            GateDecision::Allow
        ));
    }
    #[test]
    fn local_allows_confirm() {
        assert!(matches!(
            decide(&Local, "live-start", SafetyTier::Confirm),
            GateDecision::Allow
        ));
    }
}
