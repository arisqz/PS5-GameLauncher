//! Installed sound packs (port of SoundPacks.list / read in main/soundpacks.js).
//! Browsing, downloading and installing are still to come.

use serde_json::{json, Map, Value};
use std::{fs, path::Path};

fn is_sound(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    [".wav", ".mp3", ".ogg", ".m4a", ".flac"].iter().any(|e| n.ends_with(e))
}

fn read(dir: &Path, id: &str) -> Option<Value> {
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
    let name = meta.get("name").and_then(|v| v.as_str()).unwrap_or(id).replace('_', " ");
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
