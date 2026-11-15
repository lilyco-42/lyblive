//! web/dist 静态产物嵌入：单文件分发时也能打开 shadcn Web 控制台。
use include_dir::{include_dir, Dir, File};

static DIST: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/web/dist");

/// 按相对 dist 根的路径取文件；拒绝任何路径穿越。
pub fn get(path: &str) -> Option<&'static File<'static>> {
    let clean = path.trim_start_matches('/');
    if clean.is_empty() {
        return DIST.get_file("index.html");
    }
    if clean.split('/').any(|c| c == ".." || c.is_empty()) {
        return None;
    }
    if let Some(f) = DIST.get_file(clean) {
        return Some(f);
    }
    if std::path::Path::new(clean).extension().is_none() {
        return DIST.get_file("index.html");
    }
    None
}

pub fn embedded() -> bool {
    DIST.get_file("index.html").is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_and_spa_paths_resolve_to_index() {
        assert!(get("/").is_some());
        assert!(get("/room").is_some());
        assert!(embedded());
    }

    #[test]
    fn path_traversal_and_empty_segments_are_rejected() {
        assert!(get("/../Cargo.toml").is_none());
        assert!(get("/assets//app.js").is_none());
        assert!(get("/missing.css").is_none());
    }
}
