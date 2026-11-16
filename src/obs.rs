//! OBS 集成：把 lyblive 的 Web 控制台注册为 OBS 的「自定义浏览器停靠窗口」。
//!
//! 这不是 OBS 原生插件（.so/.dll），而是 OBS 内置 browser dock 的配置管理：
//! 执行一次 `lyblive --obs-install`，写入 `~/.config/obs-studio/user.ini`，
//! OBS 下次启动就会出现 lyblive 面板，且不会被挤成 80px 窄条。
//!
//! 选择 dock 而不是原生插件的原因：
//! - 零插件依赖，跨平台（Linux/Windows/macOS 同一套 Web UI）；
//! - 不随 OBS 版本升级失效；
//! - 原生插件需要按 OBS 版本编译、单独分发，维护成本远高于收益。

use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DOCK_TITLE: &str = "lyblive";
pub const DOCK_UUID: &str = "b97b70613a63e6fcef5524e1dd810528";
/// 与用户级 systemd 单元 `LYBLIVE_PORT=8768` 保持一致
pub const DEFAULT_OBS_PORT: u16 = 8768;

pub fn port_from_env() -> u16 {
    std::env::var("LYBLIVE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_OBS_PORT)
}

pub fn dock_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

pub fn dock_line(port: u16) -> String {
    format!(
        "ExtraBrowserDocks=[{{\"title\": \"{DOCK_TITLE}\", \"url\": \"{}\", \"uuid\": \"{DOCK_UUID}\"}}]",
        dock_url(port)
    )
}

pub fn config_file() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_else(|| PathBuf::from(".config"));
    base.join("obs-studio").join("user.ini")
}

/// 扫描 /proc 判断 OBS 是否在运行（OBS 退出时会覆写 user.ini，必须先关）。
pub fn obs_running() -> bool {
    let Ok(entries) = fs::read_dir("/proc") else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        if let Ok(comm) = fs::read_to_string(entry.path().join("comm")) {
            if comm.trim() == "obs" {
                return true;
            }
        }
    }
    false
}

/// 纯函数：重写 user.ini 文本。返回 (新文本, 是否有改动, 是否重置了 DockState)。
pub fn rewrite(text: &str, port: u16) -> (String, bool, bool) {
    let desired = dock_line(port);
    let mut out: Vec<String> = Vec::new();
    let mut has_dock = false;
    let mut reset_dock_state = false;
    let mut section = String::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed.to_string();
        }
        if trimmed.starts_with("DockState=") {
            reset_dock_state = true;
            continue;
        }
        if trimmed.starts_with("ExtraBrowserDocks=") {
            if !has_dock {
                out.push(desired.clone());
                has_dock = true;
            }
            continue;
        }
        out.push(line.to_string());
        if section == "[BasicWindow]" && trimmed.starts_with("DocksLocked=") && !has_dock {
            out.push(desired.clone());
            has_dock = true;
        }
    }

    let mut new_text = out.join("\n");
    if !new_text.ends_with('\n') {
        new_text.push('\n');
    }
    (new_text.clone(), new_text != text, reset_dock_state)
}

pub struct Status {
    pub config: PathBuf,
    pub exists: bool,
    pub configured: bool,
    pub obs_running: bool,
}

pub fn status() -> Status {
    let config = config_file();
    let text = fs::read_to_string(&config).unwrap_or_default();
    Status {
        exists: config.exists(),
        configured: text.contains("ExtraBrowserDocks=") && text.contains(DOCK_TITLE),
        obs_running: obs_running(),
        config,
    }
}

pub fn install(port: u16) -> Result<String> {
    if obs_running() {
        anyhow::bail!("检测到 OBS 正在运行，请先完全退出 OBS（含托盘）再安装");
    }
    let path = config_file();
    let text = fs::read_to_string(&path).with_context(|| {
        format!(
            "读取 {} 失败：请先启动一次 OBS，让它生成 user.ini",
            path.display()
        )
    })?;
    let (new_text, changed, reset) = rewrite(&text, port);
    if !changed {
        return Ok(format!(
            "已是目标配置，无需修改：{}（面板地址 {}）",
            path.display(),
            dock_url(port)
        ));
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = path.with_extension(format!("ini.bak-obs-{stamp}"));
    fs::copy(&path, &backup).with_context(|| format!("备份 {} 失败", path.display()))?;
    fs::write(&path, new_text).with_context(|| format!("写入 {} 失败", path.display()))?;
    let mut notes = vec![format!("已写入 {}", path.display())];
    notes.push(format!("面板地址 {}", dock_url(port)));
    notes.push(format!("备份 {}", backup.display()));
    notes.push(if reset {
        "已重置 DockState（避免面板被恢复成窄条）".to_string()
    } else {
        "DockState 无需重置".to_string()
    });
    notes.push("现在打开 OBS，右侧应出现 lyblive 面板；可拖左边界调整宽度".to_string());
    Ok(notes.join("\n"))
}

pub fn uninstall() -> Result<String> {
    if obs_running() {
        anyhow::bail!("检测到 OBS 正在运行，请先完全退出 OBS（含托盘）再卸载");
    }
    let path = config_file();
    let text =
        fs::read_to_string(&path).with_context(|| format!("读取 {} 失败", path.display()))?;
    let filtered: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim_start().starts_with("ExtraBrowserDocks="))
        .collect();
    if filtered.len() == text.lines().count() {
        return Ok("未配置 lyblive 停靠面板，无需卸载".to_string());
    }
    let mut out = filtered.join("\n");
    out.push('\n');
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = path.with_extension(format!("ini.bak-obs-{stamp}"));
    fs::copy(&path, &backup)?;
    fs::write(&path, out)?;
    Ok(format!(
        "已移除 lyblive 停靠面板配置\n备份 {}",
        backup.display()
    ))
}

pub fn report(status: &Status) -> String {
    let state = if status.configured {
        "已配置"
    } else if status.exists {
        "未配置"
    } else {
        "未找到 user.ini（尚未启动过 OBS）"
    };
    format!(
        "配置文件: {}\n面板状态: {}\nOBS 进程: {}",
        status.config.display(),
        state,
        if status.obs_running {
            "运行中（修改前需退出）"
        } else {
            "未运行"
        }
    )
}

pub fn run_install(port: u16) -> Result<()> {
    println!("{}", install(port)?);
    Ok(())
}

pub fn run_status() -> Result<()> {
    println!("{}", report(&status()));
    Ok(())
}

pub fn run_uninstall() -> Result<()> {
    println!("{}", uninstall()?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "[General]\nFirstRun=true\n\n[BasicWindow]\nDocksLocked=false\nExtraBrowserDocks=[{\"title\": \"old\", \"url\": \"http://x/\", \"uuid\": \"u\"}]\nDockState=AAAA\n\n[Appearance]\nFontScale=10\n";

    #[test]
    fn rewrite_replaces_dock_and_resets_state() {
        let (out, changed, reset) = rewrite(BASE, 8768);
        assert!(changed);
        assert!(reset);
        assert_eq!(out.matches("ExtraBrowserDocks=").count(), 1);
        assert!(out.contains("127.0.0.1:8768"));
        assert!(!out.contains("DockState="));
        assert!(out.contains("FontScale=10"));
    }

    #[test]
    fn rewrite_is_idempotent() {
        let (once, _, _) = rewrite(BASE, 8768);
        let (twice, changed, reset) = rewrite(&once, 8768);
        assert_eq!(once, twice);
        assert!(!changed);
        assert!(!reset);
    }

    #[test]
    fn rewrite_inserts_when_missing() {
        let text = "[BasicWindow]\nDocksLocked=false\n";
        let (out, changed, _) = rewrite(text, 9000);
        assert!(changed);
        assert_eq!(out.matches("ExtraBrowserDocks=").count(), 1);
        assert!(out.contains("127.0.0.1:9000"));
    }

    #[test]
    fn rewrite_keeps_single_line_when_duplicated() {
        let dup = format!("{BASE}ExtraBrowserDocks=[{{\"title\": \"dup\"}}]\n");
        let (out, _, _) = rewrite(&dup, 8768);
        assert_eq!(out.matches("ExtraBrowserDocks=").count(), 1);
    }

    #[test]
    fn dock_line_is_valid_json_array() {
        let line = dock_line(8768);
        let json = line.trim_start_matches("ExtraBrowserDocks=");
        let value: serde_json::Value = serde_json::from_str(json).expect("必须是合法 JSON");
        assert_eq!(value[0]["title"], DOCK_TITLE);
        assert_eq!(value[0]["uuid"], DOCK_UUID);
    }
}
