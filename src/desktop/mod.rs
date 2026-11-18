//! 桌面常驻形态（Linux/GTK3）：托盘 + 桌面悬浮弹幕层，关闭主界面后仍在。
use anyhow::Result;

pub mod float;
pub mod tray;

pub fn run(port: u16) -> Result<()> {
    float::run(port)
}
