//! The app:// protocol (port of the protocol.handle('app') block in main.js).
//! WebView2 reaches it as http://app.localhost/<root>/<file>:
//!   art/    cached artwork
//!   avatar/ profile pictures
//!   sounds/ installed sound packs

use crate::data::Dirs;
use std::{fs, path::Path};
use tauri::http::{header, Request, Response, StatusCode};

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("m4a") => "audio/mp4",
        Some("flac") => "audio/flac",
        _ => "application/octet-stream",
    }
}

/// %XX decoding (the renderer builds these paths with encodeURIComponent).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*").body(Vec::new()).unwrap()
}

pub fn handle(dirs: &Dirs, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = percent_decode(req.uri().path());
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let root = parts.next().unwrap_or("");
    let rel = parts.next().unwrap_or("");
    let base = match root {
        "art" => &dirs.art,
        "avatar" => &dirs.avatars,
        "sounds" => &dirs.sounds,
        _ => return status(StatusCode::NOT_FOUND),
    };
    // Plain relative paths only: no "..", drive letters or backslashes.
    if rel.is_empty() || rel.split('/').any(|seg| seg.is_empty() || seg == "." || seg == ".." || seg.contains(['\\', ':'])) {
        return status(StatusCode::FORBIDDEN);
    }
    let mut file = base.join(rel);
    // Artwork saved as another format than library.json says (hero.png for
    // hero.jpg): serve whichever file has that name.
    if root == "art" && !file.exists() {
        if let (Some(dir), Some(stem)) = (file.parent(), file.file_stem().map(|s| s.to_os_string())) {
            let other = fs::read_dir(dir).ok().and_then(|rd| rd.flatten().map(|e| e.path()).find(|p| p.file_stem() == Some(stem.as_os_str())));
            if let Some(other) = other {
                file = other;
            }
        }
    }
    match fs::read(&file) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime(&file))
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CACHE_CONTROL, "max-age=31536000")
            .body(bytes)
            .unwrap(),
        Err(_) => status(StatusCode::NOT_FOUND),
    }
}
