//! 用户级设置与凭据：默认只在内存；显式开启才写 0600 文件。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

pub const APP_NAME: &str = "lyblive";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Settings {
    /// 是否把登录凭据持久化到磁盘（默认 false，凭据永不落盘）
    pub remember_login: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct DiskConfig {
    pub settings: Settings,
    /// 仅在 remember_login=true 且用户扫码确认后写入
    pub credential: Option<Credential>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Credential {
    pub cookie: String,
    pub csrf: String,
    pub uid: i64,
}

#[derive(Clone)]
pub struct SharedConfig {
    pub dir: PathBuf,
    pub file: PathBuf,
    pub inner: Arc<RwLock<DiskConfig>>,
}

impl SharedConfig {
    pub fn load() -> Self {
        let dir = config_dir();
        let file = dir.join("config.json");
        let mut cfg = read_file(&file);
        if !cfg.settings.remember_login {
            cfg.credential = None;
        }
        Self {
            dir,
            file,
            inner: Arc::new(RwLock::new(cfg)),
        }
    }

    pub fn settings(&self) -> Settings {
        self.inner
            .read()
            .map(|c| c.settings.clone())
            .unwrap_or_default()
    }

    pub fn credential(&self) -> Option<Credential> {
        self.inner.read().ok().and_then(|c| c.credential.clone())
    }

    pub fn save_credential(&self, cred: &Credential) -> anyhow::Result<bool> {
        let s = self.settings();
        let mut guard = self
            .inner
            .write()
            .map_err(|_| anyhow::anyhow!("配置锁已损坏"))?;
        if !s.remember_login {
            return Ok(false);
        }
        guard.credential = Some(cred.clone());
        write_file(&self.file, &guard)?;
        Ok(true)
    }

    pub fn clear_credential(&self) -> anyhow::Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| anyhow::anyhow!("配置锁已损坏"))?;
        guard.credential = None;
        write_file(&self.file, &guard)
    }

    pub fn set_remember(&self, on: bool) -> anyhow::Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| anyhow::anyhow!("配置锁已损坏"))?;
        guard.settings.remember_login = on;
        if !on {
            guard.credential = None;
        }
        write_file(&self.file, &guard)
    }

    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({
            "rememberLogin": self.settings().remember_login,
            "configDir": self.dir.display().to_string(),
            "configFile": self.file.display().to_string(),
        })
    }
}

pub fn config_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("LYBLIVE_CONFIG_HOME") {
        let path = PathBuf::from(p);
        if path.is_absolute() {
            return path;
        }
    }
    directories::BaseDirs::new()
        .map(|b| b.config_dir().join(APP_NAME))
        .unwrap_or_else(|| PathBuf::from(".config").join(APP_NAME))
}

fn read_file(file: &Path) -> DiskConfig {
    fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_file(file: &Path, cfg: &DiskConfig) -> anyhow::Result<()> {
    fs::create_dir_all(file.parent().unwrap_or(Path::new(".")))?;
    let text = serde_json::to_string_pretty(cfg)?;
    let mut opts = fs::OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(file)?;
    f.write_all(text.as_bytes())?;
    f.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(file, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_never_persists() {
        assert!(!Settings::default().remember_login);
    }

    #[test]
    fn config_file_is_private() {
        let td = tempfile::tempdir().unwrap();
        let file = td.path().join("config.json");
        write_file(&file, &DiskConfig::default()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
