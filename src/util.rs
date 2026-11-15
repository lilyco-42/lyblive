//! 公共小工具：时间、JSON 柔取值、脱敏、URL 表单编码。

use md5::{Digest, Md5};
use serde_json::Value;

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn md5_hex(s: &str) -> String {
    let mut h = Md5::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

pub fn form_encode(pairs: &[(String, String)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

pub fn mask(s: &str) -> String {
    let n = s.chars().count();
    if n <= 8 {
        return "***".into();
    }
    let head: String = s.chars().take(4).collect();
    let tail: String = s.chars().skip(n - 4).collect();
    format!("{head}***{tail}")
}

pub fn str_val(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

pub fn i64_val(v: &Value, key: &str) -> i64 {
    let x = v.get(key).unwrap_or(&Value::Null);
    if let Some(n) = x.as_i64() {
        return n;
    }
    if let Some(n) = x.as_u64() {
        return n as i64;
    }
    if let Some(n) = x.as_f64() {
        return n as i64;
    }
    if let Some(s) = x.as_str() {
        return s.parse().unwrap_or(0);
    }
    0
}

pub fn obj<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or(&Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn md5_known_vector() {
        assert_eq!(md5_hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
    }
    #[test]
    fn mask_keeps_only_ends() {
        assert_eq!(mask("abcdefghij"), "abcd***ghij");
        assert_eq!(mask("short"), "***");
    }
    #[test]
    fn form_encode_escapes() {
        assert_eq!(form_encode(&[("a b".into(), "x&y".into())]), "a%20b=x%26y");
    }
}
