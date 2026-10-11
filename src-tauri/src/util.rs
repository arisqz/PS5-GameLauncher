//! Small helpers that keep the Rust side byte-for-byte compatible with what the
//! Electron version wrote (paths, ids, URL encoding, timestamps).

use serde::Serialize;
use sha1::{Digest, Sha1};
use std::path::Path;
use tauri::{AppHandle, Emitter};

/// Events that only the launcher window gets (the rest also go to the overlay).
const MAIN_ONLY: [&str; 5] = ["window:state", "notify", "scan:progress", "navigate", "discord:message"];

/// The counterpart of main.js `send(channel, payload)`.
pub fn send<S: Serialize + Clone>(app: &AppHandle, channel: &str, payload: S) {
    let _ = if MAIN_ONLY.contains(&channel) {
        app.emit_to("main", channel, payload)
    } else {
        app.emit(channel, payload)
    };
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Node's path.win32.normalize: "/" -> "\", no doubled separators, "." and
/// ".." resolved, drive / UNC prefix kept, a trailing separator kept.
pub fn normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let s = p.replace('/', "\\");
    let (prefix, rest) = if let Some(unc) = s.strip_prefix("\\\\") {
        // \\server\share
        let parts: Vec<&str> = unc.splitn(3, '\\').collect();
        if parts.len() >= 2 {
            (format!("\\\\{}\\{}\\", parts[0], parts[1]), parts.get(2).copied().unwrap_or("").to_string())
        } else {
            (String::new(), s.clone())
        }
    } else if s.len() >= 2 && s.as_bytes()[1] == b':' {
        let abs = s.as_bytes().get(2) == Some(&b'\\');
        (format!("{}{}", &s[..2], if abs { "\\" } else { "" }), s[2..].to_string())
    } else if let Some(rest) = s.strip_prefix('\\') {
        ("\\".to_string(), rest.to_string())
    } else {
        (String::new(), s.clone())
    };
    let absolute = prefix.ends_with('\\');
    let mut out: Vec<&str> = Vec::new();
    for seg in rest.split('\\') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|l| *l != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    let mut res = prefix + &out.join("\\");
    if res.is_empty() {
        res = ".".into();
    } else if s.ends_with('\\') && !res.ends_with('\\') {
        res.push('\\');
    }
    res
}

/// Node's path.join.
pub fn join(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    normalize(&joined.join("\\"))
}

/// Node's path.resolve for an already absolute path (no trailing separator).
pub fn resolve(p: &str) -> String {
    let n = normalize(p);
    let root_len = if n.len() >= 3 && n.as_bytes()[1] == b':' { 3 } else { 0 };
    if n.len() > root_len.max(1) {
        n.trim_end_matches('\\').to_string()
    } else {
        n
    }
}

pub fn dirname(p: &str) -> String {
    let n = p.trim_end_matches(['\\', '/']);
    match n.rfind(['\\', '/']) {
        Some(0) => "\\".into(),
        Some(i) if i == 2 && n.as_bytes()[1] == b':' => n[..3].to_string(),
        Some(i) => n[..i].to_string(),
        None => ".".into(),
    }
}

pub fn basename(p: &str) -> String {
    let n = p.trim_end_matches(['\\', '/']);
    n.rsplit(['\\', '/']).next().unwrap_or("").to_string()
}

/// Lower-case extension with the dot (".lnk"), or "".
pub fn extname(p: &str) -> String {
    let b = basename(p);
    match b.rfind('.') {
        Some(i) if i > 0 => b[i..].to_lowercase(),
        _ => String::new(),
    }
}

/// basename without its extension (path.basename(file, path.extname(file))).
pub fn stem(p: &str) -> String {
    let b = basename(p);
    match b.rfind('.') {
        Some(i) if i > 0 => b[..i].to_string(),
        _ => b,
    }
}

pub fn exists(p: &str) -> bool {
    !p.is_empty() && Path::new(p).exists()
}

/// JavaScript's encodeURIComponent.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// scanner.js hashId: prefix + first 12 hex chars of sha1(lowercased string).
pub fn hash_id(prefix: &str, s: &str) -> String {
    let digest = Sha1::digest(s.to_lowercase().as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{prefix}-{}", &hex[..12])
}

/// scanner.js tidyName.
pub fn tidy_name(name: &str) -> String {
    let no_marks: String = name.chars().filter(|c| !matches!(c, '™' | '®' | '©')).collect();
    no_marks.split_whitespace().collect::<Vec<_>>().join(" ")
}
