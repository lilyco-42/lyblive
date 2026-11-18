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

/// OBS 的配置根目录是平台相关的：Windows 在 `%APPDATA%`，Linux/macOS 在
/// `$XDG_CONFIG_HOME`（或 `~/.config`）。抽成纯函数便于三平台单测。
pub fn config_root_from(
    appdata: Option<&str>,
    xdg_config_home: Option<&str>,
    home: Option<&str>,
    windows: bool,
) -> PathBuf {
    if windows {
        if let Some(appdata) = appdata.filter(|value| !value.is_empty()) {
            return PathBuf::from(appdata);
        }
    }
    if let Some(xdg) = xdg_config_home.filter(|value| !value.is_empty()) {
        return PathBuf::from(xdg);
    }
    match home.filter(|value| !value.is_empty()) {
        Some(home) => PathBuf::from(home).join(".config"),
        None => PathBuf::from(".config"),
    }
}

pub fn config_file() -> PathBuf {
    let appdata = std::env::var("APPDATA").ok();
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let home = std::env::var("HOME").ok();
    config_root_from(
        appdata.as_deref(),
        xdg.as_deref(),
        home.as_deref(),
        cfg!(windows),
    )
    .join("obs-studio")
    .join("user.ini")
}

/// 判断 OBS 是否在运行（OBS 退出时会覆写 user.ini，必须先关）。
/// Linux/macOS 扫 /proc；Windows 查 tasklist（进程名 obs64.exe / obs.exe）。
pub fn obs_running() -> bool {
    // 冒烟测试用：CI/脚本里没有真实 OBS，也不该被本机正在运行的 OBS 挡住
    if std::env::var_os("LYBLIVE_OBS_SMOKE").is_some() {
        return false;
    }
    obs_running_probe(cfg!(windows))
}

fn obs_running_probe(windows: bool) -> bool {
    if windows {
        for image in ["obs64.exe", "obs.exe"] {
            let output = std::process::Command::new("tasklist")
                .args(["/FI", &format!("IMAGENAME eq {image}"), "/NH"])
                .output();
            if let Ok(output) = output {
                if String::from_utf8_lossy(&output.stdout).contains(image) {
                    return true;
                }
            }
        }
        return false;
    }

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

/// 纯函数：重写 user.ini 文本。返回 (新文本, 是否有改动)。
/// 注意：**保留 DockState**（删除它会让 OBS 的 restoreState 隐藏 lyblive 面板）。
pub fn rewrite(text: &str, port: u16) -> (String, bool) {
    let desired = dock_line(port);
    let mut out: Vec<String> = Vec::new();
    let mut has_dock = false;
    let mut section = String::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed.to_string();
        }
        // 保留 DockState：OBS 的 restoreState 会隐藏 state 里不存在的 dock，
        // 删掉它反而让 lyblive 面板不可见。只补 ExtraBrowserDocks。
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
    (new_text.clone(), new_text != text)
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
    let (new_text, changed) = rewrite(&text, port);
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
    notes.push(
        "已保留 DockState；若面板仍不可见，请在 OBS 菜单「停靠窗口」里勾选 lyblive 一次"
            .to_string(),
    );
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

/* ---------------- DockState 修复（浮动态才保留宽高） ---------------- */

/// 浮动态（与 OBS 的 statsDock 相同 flag），宽高才会被 Qt 保留。
const FLOAT_FLAG: u8 = 2;
const FLOAT_RECT: (i32, i32, i32, i32) = (1900, 120, 360, 760);
const DOCK_OBJECT_NAME: &str = "lyblive_extraBrowser";

fn utf16be(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .flat_map(|unit| unit.to_be_bytes())
        .collect()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|win| win == needle)
}

fn read_rect(buf: &[u8], offset: usize) -> Option<(i32, i32, i32, i32)> {
    let slice = buf.get(offset..offset + 16)?;
    let mut rect = [0i32; 4];
    for (index, slot) in rect.iter_mut().enumerate() {
        let start = index * 4;
        *slot = i32::from_be_bytes([
            slice[start],
            slice[start + 1],
            slice[start + 2],
            slice[start + 3],
        ]);
    }
    Some((rect[0], rect[1], rect[2], rect[3]))
}

fn encode_rect(rect: (i32, i32, i32, i32)) -> [u8; 16] {
    let mut out = [0u8; 16];
    for (index, value) in [rect.0, rect.1, rect.2, rect.3].iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&value.to_be_bytes());
    }
    out
}

/// 纯函数：把 user.ini 文本里 lyblive 的 dock 记录改成浮动态。
/// 返回 (新文本, 是否有改动)。DockState 缺失或没有 lyblive 记录时原样返回。
pub fn rewrite_dock_state(text: &str) -> Result<(String, bool)> {
    use base64::Engine;

    let engine = base64::engine::general_purpose::STANDARD;
    let Some(state) = text
        .lines()
        .find_map(|line| line.strip_prefix("DockState="))
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok((text.to_string(), false));
    };

    let mut raw = engine
        .decode(state)
        .context("DockState 不是合法 base64，无法修复")?;
    let name = utf16be(DOCK_OBJECT_NAME);
    let Some(position) = find_subslice(&raw, &name) else {
        return Ok((text.to_string(), false));
    };
    let cursor = position + name.len();
    let Some(old_rect) = read_rect(&raw, cursor + 1) else {
        anyhow::bail!("DockState 结构异常：lyblive 记录不完整");
    };
    let old_flag = raw[cursor];
    if old_flag == FLOAT_FLAG && old_rect == FLOAT_RECT {
        return Ok((text.to_string(), false));
    }

    raw[cursor] = FLOAT_FLAG;
    raw[cursor + 1..cursor + 17].copy_from_slice(&encode_rect(FLOAT_RECT));

    let new_state = engine.encode(&raw);
    let mut out: Vec<String> = Vec::new();
    let mut replaced = false;
    for line in text.lines() {
        if !replaced && line.starts_with("DockState=") {
            out.push(format!("DockState={new_state}"));
            replaced = true;
        } else {
            out.push(line.to_string());
        }
    }
    Ok((out.join("\n") + "\n", true))
}

/// 让 OBS 下次启动时把 lyblive 面板以 360×760 浮动态显示。
/// 必须在 OBS 退出时执行：运行中的 OBS 会在退出时回写 DockState 覆盖本次修改。
pub fn fix_dock() -> Result<String> {
    if obs_running() {
        anyhow::bail!("OBS 正在运行：请先完全退出（退出时回写会覆盖本次修复）");
    }
    let path = config_file();
    let text = fs::read_to_string(&path)
        .with_context(|| format!("读取 {} 失败：请先启动一次 OBS 生成配置", path.display()))?;
    let (new_text, changed) = rewrite_dock_state(&text)?;
    if !changed {
        return Ok(format!(
            "DockState 无需修复（已是浮动 {:?} 或没有 lyblive 记录）：{}",
            FLOAT_RECT,
            path.display()
        ));
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = path.with_file_name(format!("user.ini.bak-dockfix-cli-{stamp}"));
    fs::copy(&path, &backup).with_context(|| format!("备份 {} 失败", path.display()))?;
    fs::write(&path, new_text).with_context(|| format!("写入 {} 失败", path.display()))?;
    Ok(format!(
        "已把 lyblive 面板改为浮动 {:?}\n备份：{}",
        FLOAT_RECT,
        backup.display()
    ))
}

pub fn run_fix_dock() -> Result<()> {
    println!("{}", fix_dock()?);
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
    fn rewrite_replaces_dock_and_keeps_state() {
        let (out, changed) = rewrite(BASE, 8768);
        assert!(changed);
        assert_eq!(out.matches("ExtraBrowserDocks=").count(), 1);
        assert!(out.contains("127.0.0.1:8768"));
        // DockState 必须保留，删除它会让 OBS 隐藏 lyblive 面板
        assert!(out.contains("DockState=AAAA"));
        assert!(out.contains("FontScale=10"));
    }

    #[test]
    fn rewrite_is_idempotent() {
        let (once, _) = rewrite(BASE, 8768);
        let (twice, changed) = rewrite(&once, 8768);
        assert_eq!(once, twice);
        assert!(!changed);
    }

    #[test]
    fn rewrite_inserts_when_missing() {
        let text = "[BasicWindow]\nDocksLocked=false\n";
        let (out, changed) = rewrite(text, 9000);
        assert!(changed);
        assert_eq!(out.matches("ExtraBrowserDocks=").count(), 1);
        assert!(out.contains("127.0.0.1:9000"));
    }

    #[test]
    fn rewrite_keeps_single_line_when_duplicated() {
        let dup = format!("{BASE}ExtraBrowserDocks=[{{\"title\": \"dup\"}}]\n");
        let (out, _) = rewrite(&dup, 8768);
        assert_eq!(out.matches("ExtraBrowserDocks=").count(), 1);
    }

    #[test]
    fn rewrite_dock_state_flips_to_float() {
        use base64::Engine;
        let engine = base64::engine::general_purpose::STANDARD;
        let name = utf16be(DOCK_OBJECT_NAME);
        let mut raw: Vec<u8> = vec![0x00, 0x00, 0x00, 0xfd, 0x00, 0x00, 0x00, 0x03];
        raw.extend_from_slice(&name);
        raw.push(1); // 停靠态：宽高会被 Qt 压回 80px
        raw.extend_from_slice(&encode_rect((27, 781, 80, 16777215)));
        let text = format!(
            "[BasicWindow]\nDockState={}\n[Appearance]\nFontScale=10\n",
            engine.encode(&raw)
        );

        let (out, changed) = rewrite_dock_state(&text).expect("应能修复");
        assert!(changed);
        let state = out
            .lines()
            .find_map(|line| line.strip_prefix("DockState="))
            .expect("DockState 仍在");
        let decoded = engine.decode(state).expect("输出仍是合法 base64");
        let position = find_subslice(&decoded, &name).expect("记录仍在");
        let cursor = position + name.len();
        assert_eq!(decoded[cursor], FLOAT_FLAG, "应改成浮动态");
        assert_eq!(read_rect(&decoded, cursor + 1), Some(FLOAT_RECT));
        assert!(out.contains("FontScale=10"), "其它配置不能被改写");
    }

    #[test]
    fn rewrite_dock_state_is_idempotent() {
        use base64::Engine;
        let engine = base64::engine::general_purpose::STANDARD;
        let name = utf16be(DOCK_OBJECT_NAME);
        let mut raw: Vec<u8> = vec![0, 0, 0, 0xfd];
        raw.extend_from_slice(&name);
        raw.push(FLOAT_FLAG);
        raw.extend_from_slice(&encode_rect(FLOAT_RECT));
        let text = format!("[BasicWindow]\nDockState={}\n", engine.encode(&raw));

        let (out, changed) = rewrite_dock_state(&text).expect("应能解析");
        assert!(!changed, "已是目标形态时不应改动");
        assert_eq!(out, text);
    }

    #[test]
    fn rewrite_dock_state_without_lyblive_is_noop() {
        let text = "[BasicWindow]\nDockState=AAAA\n";
        let (out, changed) = rewrite_dock_state(text).expect("坏 base64 不 panic");
        assert!(!changed);
        assert_eq!(out, text);
    }

    #[test]
    fn rewrite_dock_state_without_state_is_noop() {
        let text = "[BasicWindow]\nDocksLocked=false\n";
        let (out, changed) = rewrite_dock_state(text).expect("无 state 不报错");
        assert!(!changed);
        assert_eq!(out, text);
    }

    #[test]
    fn config_root_prefers_appdata_on_windows() {
        let root = config_root_from(
            Some(r"C:\Users\me\AppData\Roaming"),
            None,
            Some(r"C:\Users\me"),
            true,
        );
        assert_eq!(root, PathBuf::from(r"C:\Users\me\AppData\Roaming"));
        assert!(root
            .join("obs-studio")
            .join("user.ini")
            .to_string_lossy()
            .contains("AppData"));
    }

    #[test]
    fn config_root_uses_xdg_on_unix() {
        let root = config_root_from(
            Some("/ignored/appdata"),
            Some("/home/me/.config"),
            Some("/home/me"),
            false,
        );
        assert_eq!(root, PathBuf::from("/home/me/.config"));
    }

    #[test]
    fn config_root_falls_back_to_home_dot_config() {
        assert_eq!(
            config_root_from(None, None, Some("/home/me"), false),
            PathBuf::from("/home/me/.config")
        );
        assert_eq!(
            config_root_from(None, None, Some("/home/me"), true),
            PathBuf::from("/home/me/.config"),
            "Windows 上没有 APPDATA 时也要回落到 .config，而不是 panic"
        );
    }

    #[test]
    fn config_root_ignores_empty_env_values() {
        assert_eq!(
            config_root_from(Some(""), Some(""), None, false),
            PathBuf::from(".config")
        );
    }

    #[test]
    fn config_file_targets_obs_user_ini() {
        let normalized = config_file().to_string_lossy().replace('\\', "/");
        assert!(normalized.ends_with("obs-studio/user.ini"), "{normalized}");
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
