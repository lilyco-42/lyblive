//! 桌面常驻形态（Linux）：托盘 + 桌面悬浮弹幕层，关闭主界面后仍在。
use anyhow::Result;

pub mod float;
pub mod tray;
pub mod wayland;

/// KWin 会把 X11 的 DOCK/ABOVE 窗口压在全屏窗口之下；Wayland 会话优先走 layer-shell。
fn wayland_session() -> bool {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return true;
    }
    let Ok(runtime) = std::env::var("XDG_RUNTIME_DIR") else {
        return false;
    };
    for name in ["wayland-1", "wayland-0"] {
        if std::path::Path::new(&runtime).join(name).exists() {
            std::env::set_var("WAYLAND_DISPLAY", name);
            return true;
        }
    }
    false
}

pub fn run(port: u16) -> Result<()> {
    if wayland_session() {
        match wayland::run(port) {
            Ok(()) => return Ok(()),
            Err(err) => tracing::warn!("Wayland 浮层启动失败，回退 GTK/X11: {err}"),
        }
    }
    float::run(port)
}
