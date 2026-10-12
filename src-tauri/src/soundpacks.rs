//! Sound themes (port of main/soundpacks.js): Steam Deck "Audio Loader" packs
//! from deckthemes.com or a local .zip / folder. A pack is a folder with a
//! pack.json and sound files named after the Steam Deck UI sounds
//! (deck_ui_navigation.wav, …); music packs carry a menu_music.mp3. Installed
//! packs live in <data>/soundpacks, one folder per pack, and are served to the
//! UI as app://sounds/<id>/<file>.

use crate::util::encode_uri_component;
use serde_json::{json, Map, Value};
use std::{fs, path::Path};

const API: &str = "https://api.deckthemes.com";

fn is_sound(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    [".wav", ".mp3", ".ogg", ".m4a", ".flac"].iter().any(|e| n.ends_with(e))
}

pub fn read(dir: &Path, id: &str) -> Option<Value> {
    let root = dir.join(id);
    let meta: Value = fs::read_to_string(root.join("pack.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_else(|| json!({}));
    let mut files: Vec<String> = fs::read_dir(&root)
        .ok()?
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|f| is_sound(f))
        .collect();
    if files.is_empty() {
        return None;
    }
    files.sort();
    let text = |k: &str| meta.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let name = meta.get("name").and_then(|v| v.as_str()).filter(|n| !n.is_empty()).unwrap_or(id).replace('_', " ");
    let music = meta.get("music").and_then(|v| v.as_bool()).unwrap_or(false)
        || files.iter().any(|f| f.to_ascii_lowercase().starts_with("menu_music."));
    let ignore: Vec<Value> = meta
        .get("ignore")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().map(|v| Value::String(v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))).collect())
        .unwrap_or_default();
    let mappings = meta.get("mappings").filter(|v| v.is_object()).cloned().unwrap_or_else(|| Value::Object(Map::new()));
    Some(json!({
        "id": id,
        "name": name,
        "author": text("author"),
        "version": text("version"),
        "music": music,
        "ignore": ignore,
        "mappings": mappings,
        "files": files,
    }))
}

pub fn list(dir: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<Value> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter_map(|id| read(dir, &id))
        .collect();
    out.sort_by_key(|p| p["name"].as_str().unwrap_or("").to_lowercase());
    out
}

/* ---------------- Installing ---------------- */

/// Minimal ZIP reader (stored and deflated entries), enough for theme packs.
pub fn unzip(buf: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let u16_at = |i: usize| buf.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize);
    let u32_at = |i: usize| buf.get(i..i + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize);
    let damaged = || "Damaged zip file".to_string();
    let lowest = buf.len().saturating_sub(65557);
    let last = buf.len().checked_sub(22).ok_or("Not a zip file")?;
    let eocd = (lowest..=last).rev().find(|&i| u32_at(i) == Some(0x0605_4b50)).ok_or("Not a zip file")?;
    let count = u16_at(eocd + 10).ok_or_else(damaged)?;
    let mut p = u32_at(eocd + 16).ok_or_else(damaged)?;
    let mut files = Vec::new();
    for _ in 0..count {
        if u32_at(p) != Some(0x0201_4b50) {
            return Err(damaged());
        }
        let method = u16_at(p + 10).ok_or_else(damaged)?;
        let csize = u32_at(p + 20).ok_or_else(damaged)?;
        let name_len = u16_at(p + 28).ok_or_else(damaged)?;
        let extra_len = u16_at(p + 30).ok_or_else(damaged)?;
        let comment_len = u16_at(p + 32).ok_or_else(damaged)?;
        let local = u32_at(p + 42).ok_or_else(damaged)?;
        let name = String::from_utf8_lossy(buf.get(p + 46..p + 46 + name_len).ok_or_else(damaged)?).replace('\\', "/");
        p += 46 + name_len + extra_len + comment_len;
        if name.ends_with('/') {
            continue;
        }
        let start = local + 30 + u16_at(local + 26).ok_or_else(damaged)? + u16_at(local + 28).ok_or_else(damaged)?;
        let raw = buf.get(start..start + csize).ok_or_else(damaged)?;
        let data = match method {
            0 => raw.to_vec(),
            8 => miniz_oxide::inflate::decompress_to_vec(raw).map_err(|_| damaged())?,
            _ => continue,
        };
        files.push((name, data));
    }
    Ok(files)
}

/// Keep a path inside its folder (no "..", no drive letters).
fn safe_rel(name: &str) -> String {
    name.split('/')
        .filter(|s| !s.is_empty() && *s != "." && *s != ".." && !s.contains([':', '<', '>', '|', '?', '*', '"']))
        .collect::<Vec<_>>()
        .join("\\")
}

fn keep_file(name: &str) -> bool {
    let n = name.to_lowercase();
    is_sound(&n) || n.ends_with("pack.json") || n.contains("copyright") || n.contains("license")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Write extracted files into <dir>/<id>, flattening to the folder that holds pack.json.
pub fn install_files(dir: &Path, id: &str, files: Vec<(String, Vec<u8>)>) -> Result<Value, String> {
    let base = files
        .iter()
        .map(|(n, _)| n)
        .find(|n| n.to_lowercase() == "pack.json" || n.to_lowercase().ends_with("/pack.json"))
        .map(|n| n[..n.len() - "pack.json".len()].to_string())
        .unwrap_or_default();
    let keep: Vec<&(String, Vec<u8>)> = files.iter().filter(|(n, _)| n.starts_with(&base) && keep_file(n)).collect();
    if !keep.iter().any(|(n, _)| is_sound(n)) {
        return Err("This pack has no sound files.".into());
    }
    let root = dir.join(id);
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    for (name, data) in keep {
        let rel = safe_rel(&name[base.len()..]);
        if rel.is_empty() || rel.contains('\\') {
            continue; // packs are flat
        }
        fs::write(root.join(rel), data).map_err(|e| e.to_string())?;
    }
    read(dir, id).ok_or_else(|| "This pack has no sound files.".into())
}

/// Install a pack from deckthemes.com.
pub async fn download(dir: &Path, theme: &Value) -> Result<Value, String> {
    let s = |k: &str| match &theme[k] {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    };
    let (id, download_id) = (s("id"), s("downloadId"));
    if !valid_id(&id) || !valid_id(&download_id) {
        return Err("Unknown theme".into());
    }
    let res = crate::metadata::client().get(format!("{API}/blobs/{download_id}")).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Download failed ({})", res.status().as_u16()));
    }
    let buf = res.bytes().await.map_err(|e| e.to_string())?;
    let dir = dir.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || install_files(&dir, &id, unzip(&buf)?)).await.map_err(|e| e.to_string())?
}

/// Install from a local .zip or a folder that contains a pack.
pub fn install_local(dir: &Path, source: &Path) -> Result<Value, String> {
    let stem = source.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut clean = String::new();
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            clean.push(c);
        } else if !clean.ends_with('_') {
            clean.push('_');
        }
    }
    let id = format!("local-{}", clean.chars().take(40).collect::<String>());
    if source.is_dir() {
        fn walk(d: &Path, rel: &str, depth: u32, out: &mut Vec<(String, Vec<u8>)>) {
            let Ok(rd) = fs::read_dir(d) else { return };
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
                let path = e.path();
                if path.is_dir() && depth < 3 {
                    walk(&path, &r, depth + 1, out);
                } else if path.is_file() {
                    if let Ok(data) = fs::read(&path) {
                        out.push((r, data));
                    }
                }
            }
        }
        let mut files = Vec::new();
        walk(source, "", 0, &mut files);
        return install_files(dir, &id, files);
    }
    let buf = fs::read(source).map_err(|e| e.to_string())?;
    install_files(dir, &id, unzip(&buf)?)
}

pub fn remove(dir: &Path, id: &str) {
    if valid_id(id) {
        let _ = fs::remove_dir_all(dir.join(id));
    }
}

/* ---------------- Theme store (deckthemes.com) ---------------- */

/// Browse deckthemes.com. kind: "Audio" (UI sounds) or "Music".
pub async fn browse(q: &Value) -> Result<Value, String> {
    let page = q["page"].as_u64().unwrap_or(1);
    let order = q["order"].as_str().unwrap_or("Most Downloaded");
    let filters = if q["kind"] == "Music" { "AUDIO.Music" } else { "AUDIO.Audio" };
    let mut url = format!("{API}/themes?page={page}&perPage=24&filters={}&order={}", encode_uri_component(filters), encode_uri_component(order));
    if let Some(search) = q["search"].as_str().filter(|s| !s.is_empty()) {
        url.push_str(&format!("&search={}", encode_uri_component(search)));
    }
    let res = crate::metadata::client().get(url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("deckthemes.com answered {}", res.status().as_u16()));
    }
    let j: Value = res.json().await.map_err(|e| e.to_string())?;
    let items: Vec<Value> = j["items"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|t| {
                    let name = t["displayName"].as_str().filter(|s| !s.is_empty()).or(t["name"].as_str()).unwrap_or("").replace('_', " ");
                    let author = t["specifiedAuthor"].as_str().filter(|s| !s.is_empty()).or(t["author"]["username"].as_str()).unwrap_or("");
                    let music = t["targets"].as_array().is_some_and(|ts| ts.iter().any(|x| x == "Music")) || t["target"] == "Music";
                    json!({
                        "id": t["id"],
                        "name": name,
                        "author": author,
                        "version": t["version"].as_str().unwrap_or(""),
                        "image": t["images"][0]["id"].as_str().map(|id| format!("{API}/blobs/{id}")),
                        "downloadId": t["download"]["id"],
                        "downloads": t["download"]["downloadCount"].as_u64().unwrap_or(0),
                        "stars": t["starCount"].as_u64().unwrap_or(0),
                        "music": music,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({ "total": j["total"].as_u64().unwrap_or(0), "items": items }))
}
