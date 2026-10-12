//! The game library (port of main/library.js): scanning and merging, artwork
//! and metadata, and the per-game actions. Games are kept as JSON objects in
//! library.json exactly like the Electron version, so both read the same file.
//!
//! Locking: the library store is only locked for short reads and writes,
//! never across a network request or a file system scan.

use crate::util::{basename, exists, now_ms, send};
use crate::{metadata, scanner, winapi, Launcher};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
};
use tauri::{AppHandle, Manager};
use tokio::sync::Semaphore;

const ART_KEYS: [&str; 6] = ["hero", "logo", "capsule", "banner", "grid", "icon"];

/// Library state that isn't saved (scan lock, store detection results).
#[derive(Default)]
pub struct LibState {
    pub scan: tokio::sync::Mutex<()>,
    pub publish_gen: std::sync::atomic::AtomicU64,
    pub info: std::sync::Mutex<Info>,
    pub last_playtime_refresh: std::sync::Mutex<Option<std::time::Instant>>,
}

#[derive(Default, Clone)]
pub struct Info {
    pub steam: Option<Value>,
    pub epic: bool,
    pub xbox: bool,
    pub ubisoft: bool,
}

fn launcher(app: &AppHandle) -> tauri::State<'_, Launcher> {
    app.state::<Launcher>()
}

pub fn art_path(app: &AppHandle, id: &str) -> PathBuf {
    let safe: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    launcher(app).dirs.art.join(safe)
}

fn s<'a>(g: &'a Value, k: &str) -> &'a str {
    g.get(k).and_then(|v| v.as_str()).unwrap_or("")
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(_) => true,
    }
}

/// A copy of every game.
pub fn games(app: &AppHandle) -> Vec<Value> {
    launcher(app).library.lock().unwrap().data["games"].as_array().cloned().unwrap_or_default()
}

pub fn find(app: &AppHandle, id: &str) -> Option<Value> {
    games(app).into_iter().find(|g| s(g, "id") == id)
}

/// Change one game in place (under the lock). Returns the result of `f`.
fn with_game<R>(app: &AppHandle, id: &str, f: impl FnOnce(&mut Map<String, Value>) -> R) -> Option<R> {
    let l = launcher(app);
    let mut lib = l.library.lock().unwrap();
    let g = lib.data["games"].as_array_mut()?.iter_mut().find(|g| s(g, "id") == id)?;
    g.as_object_mut().map(f)
}

/* ---------------------------------------------------------------- */

/// library:changed, debounced like the Electron version (250 ms), or now.
pub fn publish(app: &AppHandle, now: bool) {
    let l = launcher(app);
    let gen = l.lib.publish_gen.fetch_add(1, Ordering::SeqCst) + 1;
    if now {
        send(app, "library:changed", games(app));
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        metadata::sleep(250).await;
        if launcher(&app).lib.publish_gen.load(Ordering::SeqCst) == gen {
            send(&app, "library:changed", games(&app));
        }
    });
}

fn save_now(app: &AppHandle) {
    let _ = launcher(app).library.lock().unwrap().save();
}

/// library.js save(): write and tell the windows (soon).
pub fn save(app: &AppHandle) {
    save_now(app);
    publish(app, false);
}

fn progress(app: &AppHandle, p: Value) {
    send(app, "scan:progress", p);
}

fn notify(app: &AppHandle, title: &str, body: &str, icon: &str) {
    send(app, "notify", json!({ "title": title, "body": body, "icon": icon }));
}

fn new_game(r: &Value) -> Value {
    let mut g = r.as_object().cloned().unwrap_or_default();
    for (k, v) in [
        ("addedAt", json!(now_ms())),
        ("lastPlayed", json!(0)),
        ("playtime", json!(0)),
        ("launchCount", json!(0)),
        ("favorite", json!(false)),
        ("hidden", json!(false)),
        ("category", json!("game")),
        ("art", json!({})),
        ("artVersion", json!(0)),
        ("meta", json!({})),
        ("screenshots", json!([])),
        ("metaStatus", json!("pending")),
    ] {
        g.insert(k.into(), v);
    }
    Value::Object(g)
}

fn delete_art(app: &AppHandle, id: &str) {
    let dir = art_path(app, id);
    std::thread::spawn(move || {
        let _ = std::fs::remove_dir_all(dir);
    });
}

/* ---------------------------------------------------------------- */
/* Scanning                                                          */
/* ---------------------------------------------------------------- */

/// Scan every enabled store and folder, merge, then fetch missing artwork.
/// A second call while a scan runs waits for it instead of scanning again.
pub async fn scan(app: &AppHandle, silent: bool) -> Value {
    let l = launcher(app);
    let guard = match l.lib.scan.try_lock() {
        Ok(g) => g,
        Err(_) => {
            let _wait = l.lib.scan.lock().await;
            return json!({ "added": 0, "total": games(app).len() });
        }
    };
    let result = scan_inner(app, silent).await;
    drop(guard);
    result
}

async fn scan_inner(app: &AppHandle, silent: bool) -> Value {
    let settings = launcher(app).settings.lock().unwrap().data.clone();
    progress(app, json!({ "active": true, "label": "Scanning for games…", "current": 0, "total": 0 }));

    let flag = |k: &str, default: bool| settings.get(k).and_then(|v| v.as_bool()).unwrap_or(default);
    let (scan_steam, scan_epic) = (flag("scanSteam", true), flag("scanEpic", true));
    let (scan_xbox, scan_ubi) = (settings.get("scanXbox") != Some(&json!(false)), settings.get("scanUbisoft") != Some(&json!(false)));
    let folders: Vec<String> = settings["folders"].as_array().map(|a| a.iter().filter_map(|f| f.as_str().map(str::to_string)).collect()).unwrap_or_default();

    let app2 = app.clone();
    let (found, info) = tauri::async_runtime::spawn_blocking(move || {
        let mut found = Vec::new();
        let mut info = Info::default();
        if scan_steam {
            if let Some(st) = scanner::scan_steam() {
                info.steam = Some(json!({ "path": st.path, "persona": st.persona, "count": st.games.len() }));
                found.extend(st.games);
            }
        }
        if scan_epic {
            if let Some(epic) = scanner::scan_epic() {
                info.epic = true;
                found.extend(epic);
            }
        }
        if scan_xbox {
            let (ok, games) = scanner::scan_xbox();
            info.xbox = ok && !games.is_empty();
            found.extend(games);
        }
        if scan_ubi {
            let (ok, games) = scanner::scan_ubisoft();
            info.ubisoft = ok;
            found.extend(games);
        }
        for folder in &folders {
            let name = basename(folder);
            progress(&app2, json!({ "active": true, "label": format!("Scanning {}…", if name.is_empty() { folder.as_str() } else { name.as_str() }), "current": 0, "total": 0 }));
            found.extend(scanner::scan_folder(folder));
        }
        (found, info)
    })
    .await
    .unwrap_or_default();
    *launcher(app).lib.info.lock().unwrap() = info;

    let added = merge(app, &settings, found);
    save_now(app);
    publish(app, true);

    let pending: Vec<String> = games(app)
        .iter()
        .filter(|g| matches!(s(g, "metaStatus"), "pending" | "error"))
        .map(|g| s(g, "id").to_string())
        .collect();
    if !pending.is_empty() {
        fetch_metadata(app, pending, false).await;
    }

    progress(app, json!({ "active": false }));
    let total = games(app).len();
    if !added.is_empty() {
        let names: Vec<&str> = added.iter().take(3).map(|g| s(g, "name")).collect();
        let title = if added.len() == 1 { "New game added".to_string() } else { format!("{} new games added", added.len()) };
        notify(app, &title, &format!("{}{}", names.join(", "), if added.len() > 3 { "…" } else { "" }), "library");
    } else if !silent {
        notify(app, "Library is up to date", &format!("{total} games in your library"), "check");
    }
    json!({ "added": added.len(), "total": total })
}

/// Merge scan results into the library. Returns the newly added games.
fn merge(app: &AppHandle, settings: &Value, found: Vec<Value>) -> Vec<Value> {
    let l = launcher(app);
    let mut lib = l.library.lock().unwrap();
    let excluded: HashSet<String> = lib.data["excluded"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let mut list: Vec<Value> = lib.data["games"].as_array().cloned().unwrap_or_default();
    for g in list.iter_mut().filter_map(|g| g.as_object_mut()) {
        for k in ["update", "updateRequested", "manifest", "steamRoot"] {
            g.remove(k);
        }
    }
    let steam_ids: HashSet<String> = found.iter().filter(|r| s(r, "source") == "steam").map(|r| s(r, "steamAppId").to_string()).collect();
    let mut index: HashMap<String, usize> = list.iter().enumerate().map(|(i, g)| (s(g, "id").to_string(), i)).collect();
    let mut seen = HashSet::new();
    let mut added = Vec::new();

    for r in &found {
        let id = s(r, "id").to_string();
        if excluded.contains(&id) || seen.contains(&id) {
            continue;
        }
        if s(r, "source") == "folder" && !s(r, "steamAppId").is_empty() && steam_ids.contains(s(r, "steamAppId")) {
            continue;
        }
        seen.insert(id.clone());
        if let Some(&i) = index.get(&id) {
            let g = list[i].as_object_mut().unwrap();
            for k in ["launch", "direct", "directSafe", "storeId", "altDirs", "path", "folder", "installDir", "exe", "sizeOnDisk", "steamPlaytime", "steamLastPlayed"] {
                if let Some(v) = r.get(k) {
                    g.insert(k.into(), v.clone());
                }
            }
            let has_title = g.get("meta").and_then(|m| m.get("title")).is_some_and(|t| truthy(Some(t)));
            if !truthy(g.get("nameLocked")) && !has_title {
                g.insert("name".into(), r["name"].clone());
            }
            if !truthy(g.get("steamAppId")) && truthy(r.get("steamAppId")) && !truthy(g.get("noSteamMatch")) {
                g.insert("steamAppId".into(), r["steamAppId"].clone());
                g.insert("metaStatus".into(), json!("pending"));
            }
        } else {
            let ng = new_game(r);
            index.insert(id, list.len());
            list.push(ng.clone());
            added.push(ng);
        }
    }

    let folders: HashSet<&str> = settings["folders"].as_array().map(|a| a.iter().filter_map(|f| f.as_str()).collect()).unwrap_or_default();
    let flag = |k: &str, default: bool| settings.get(k).and_then(|v| v.as_bool()).unwrap_or(default);
    let mut removed = Vec::new();
    list.retain(|g| {
        let id = s(g, "id");
        let keep = match s(g, "source") {
            "steam" => flag("scanSteam", true) && seen.contains(id),
            "epic" => flag("scanEpic", true) && seen.contains(id),
            "xbox" => settings.get("scanXbox") != Some(&json!(false)) && seen.contains(id),
            "ubisoft" => settings.get("scanUbisoft") != Some(&json!(false)) && seen.contains(id),
            "folder" => folders.contains(s(g, "folder")) && seen.contains(id),
            _ => true,
        };
        if !keep {
            removed.push(id.to_string());
        }
        keep
    });
    lib.data["games"] = Value::Array(list);
    drop(lib);
    for id in removed {
        delete_art(app, &id);
    }
    added
}

/// Add dropped / picked files and folders. Returns how many entries came in.
pub async fn import_paths(app: &AppHandle, paths: Vec<String>) -> usize {
    let mut found = Vec::new();
    let mut add_folders = Vec::new();
    for p in paths {
        match std::fs::metadata(&p) {
            Ok(m) if m.is_dir() => add_folders.push(p),
            Ok(_) => {
                let mut extra = Map::new();
                extra.insert("source".into(), json!("manual"));
                let file = p.clone();
                if let Ok(Some(g)) = tauri::async_runtime::spawn_blocking(move || scanner::describe_file(&file, &extra)).await {
                    found.push(g);
                }
            }
            Err(_) => {}
        }
    }
    let mut added = Vec::new();
    {
        let l = launcher(app);
        let mut lib = l.library.lock().unwrap();
        for r in found {
            let id = s(&r, "id").to_string();
            let list = lib.data["games"].as_array().cloned().unwrap_or_default();
            if list.iter().any(|g| s(g, "id") == id) {
                continue;
            }
            let steam = s(&r, "steamAppId");
            if !steam.is_empty() && list.iter().any(|g| s(g, "steamAppId") == steam) {
                continue;
            }
            if let Some(ex) = lib.data["excluded"].as_array_mut() {
                ex.retain(|x| x.as_str() != Some(&id));
            }
            let ng = new_game(&r);
            if let Some(games) = lib.data["games"].as_array_mut() {
                games.push(ng.clone());
            }
            added.push(ng);
        }
    }
    if !add_folders.is_empty() {
        let saved = {
            let l = launcher(app);
            let mut st = l.settings.lock().unwrap();
            let mut folders: Vec<Value> = st.data["folders"].as_array().cloned().unwrap_or_default();
            for f in &add_folders {
                if !folders.iter().any(|x| x.as_str() == Some(f)) {
                    folders.push(json!(f));
                }
            }
            st.data["folders"] = Value::Array(folders);
            let _ = st.save();
            st.data.clone()
        };
        send(app, "settings:changed", saved);
    }
    save_now(app);
    publish(app, true);
    if !add_folders.is_empty() {
        let r = scan(app, false).await;
        return added.len() + r["added"].as_u64().unwrap_or(0) as usize + add_folders.len();
    }
    if !added.is_empty() {
        let ids = added.iter().map(|g| s(g, "id").to_string()).collect();
        fetch_metadata(app, ids, false).await;
        let names: Vec<&str> = added.iter().map(|g| s(g, "name")).collect();
        let title = if added.len() == 1 { "Game added".to_string() } else { format!("{} games added", added.len()) };
        notify(app, &title, &names.join(", "), "library");
    }
    added.len()
}

/* ---------------------------------------------------------------- */
/* Artwork and metadata                                              */
/* ---------------------------------------------------------------- */

pub async fn fetch_metadata(app: &AppHandle, ids: Vec<String>, force: bool) {
    if ids.is_empty() {
        return;
    }
    let settings = launcher(app).settings.lock().unwrap().data.clone();
    let total = ids.len();
    progress(app, json!({ "active": true, "label": "Finding artwork…", "current": 0, "total": total }));

    // 1. Resolve Steam app ids by name for non-Steam entries.
    for id in &ids {
        let Some(g) = find(app, id) else { continue };
        if truthy(g.get("steamAppId")) || truthy(g.get("noSteamMatch")) {
            continue;
        }
        progress(app, json!({ "active": true, "label": format!("Matching {}…", s(&g, "name")), "current": 0, "total": total }));
        match metadata::resolve_steam_app_id(s(&g, "name")).await {
            Ok(Some(m)) => {
                with_game(app, id, |g| {
                    g.insert("steamAppId".into(), json!(m.appid));
                    g.insert("matchedName".into(), json!(m.name));
                });
            }
            Ok(None) => {}
            Err(_) => {
                with_game(app, id, |g| {
                    g.insert("metaStatus".into(), json!("error"));
                });
            }
        }
        metadata::sleep(150).await;
    }

    // 2. Batch store lookups.
    let appids: Vec<String> = ids.iter().filter_map(|id| find(app, id)).map(|g| s(&g, "steamAppId").to_string()).collect();
    let items = Arc::new(metadata::fetch_store_items(&appids).await);

    // 3. Artwork downloads, four at a time.
    let done = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let sem = Arc::new(Semaphore::new(4));
    let settings = Arc::new(settings);
    let mut tasks = tokio::task::JoinSet::new();
    for id in ids {
        let (app, items, done, sem, settings) = (app.clone(), items.clone(), done.clone(), sem.clone(), settings.clone());
        tasks.spawn(async move {
            let _permit = sem.acquire().await;
            let Some(g) = find(&app, &id) else { return };
            let label = format!("Downloading artwork · {}", s(&g, "name"));
            progress(&app, json!({ "active": true, "label": label, "current": done.load(Ordering::SeqCst), "total": total }));
            let item = items.get(s(&g, "steamAppId"));
            fetch_art_for(&app, &g, item, force, &settings).await;
            let n = done.fetch_add(1, Ordering::SeqCst) + 1;
            progress(&app, json!({ "active": true, "label": label, "current": n, "total": total }));
            save(&app);
        });
    }
    while tasks.join_next().await.is_some() {}
    save_now(app);
    publish(app, true);
    progress(app, json!({ "active": false }));
}

async fn fetch_art_for(app: &AppHandle, g: &Value, item: Option<&Value>, force: bool, settings: &Value) {
    let id = s(g, "id").to_string();
    let dir = art_path(app, &id);
    let _ = tokio::fs::create_dir_all(&dir).await;
    if force {
        if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
            while let Ok(Some(e)) = rd.next_entry().await {
                if !e.file_name().to_string_lossy().starts_with("custom-") {
                    if let Err(_err) = tokio::fs::remove_file(e.path()).await {
                        #[cfg(debug_assertions)]
                        eprintln!("[art] couldn't remove {:?}: {_err}", e.path());
                    }
                }
            }
        }
    }

    // Custom artwork the user picked stays.
    let mut art: Map<String, Value> = Map::new();
    for k in ART_KEYS {
        if truthy(g.get("customArt").and_then(|c| c.get(k))) {
            if let Some(v) = g.get("art").and_then(|a| a.get(k)).filter(|v| truthy(Some(v))) {
                art.insert(k.into(), v.clone());
            }
        }
    }

    let appid = s(g, "steamAppId").to_string();
    let steam = (!appid.is_empty()).then(|| metadata::steam_candidates(&appid, item));
    let key = settings["sgdbKey"].as_str().unwrap_or("");
    let sg = if key.is_empty() { None } else { metadata::sgdb_candidates(key, (!appid.is_empty()).then_some(appid.as_str()), s(g, "name")).await };
    let prefer_sg = settings["artSource"] == "sgdb";
    let order = |k: &str| -> Vec<String> {
        let a = steam.as_ref().map(|c| c.get(k).to_vec()).unwrap_or_default();
        let b = sg.as_ref().map(|c| c.get(k).to_vec()).unwrap_or_default();
        if prefer_sg {
            [b, a].concat()
        } else {
            [a, b].concat()
        }
    };

    let want = |art: &Map<String, Value>, k: &str| !art.contains_key(k);
    let (hero, logo, capsule, banner) = (order("hero"), order("logo"), order("capsule"), order("banner"));
    let get = |k: &'static str, list: Vec<String>, skip: bool| {
        let dest = dir.join(k);
        async move {
            if skip || list.is_empty() {
                return (k, None);
            }
            (k, metadata::download(&list, &dest).await)
        }
    };
    let results = tokio::join!(
        get("hero", hero, !want(&art, "hero")),
        get("logo", logo, !want(&art, "logo")),
        get("capsule", capsule, !want(&art, "capsule")),
        get("banner", banner, !want(&art, "banner")),
    );
    for (k, file) in [results.0, results.1, results.2, results.3] {
        if let Some(f) = file {
            art.insert(k.into(), json!(f));
        }
    }
    if let Some(grid) = sg.as_ref().map(|c| c.grid.clone()).filter(|g| !g.is_empty()) {
        if want(&art, "grid") {
            if let Some(f) = metadata::download(&grid[..grid.len().min(3)], &dir.join("grid")).await {
                art.insert("grid".into(), json!(f));
            }
        }
    }

    // Steam's own library cache (newer games keep logos under hashed paths
    // that the public store API does not expose).
    if !appid.is_empty() && ["logo", "hero", "capsule", "banner"].iter().any(|k| want(&art, k)) {
        for (k, file) in steam_local_assets(&appid) {
            if !want(&art, k) {
                continue;
            }
            let ext = Path::new(&file).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let name = format!("{k}.{ext}");
            if tokio::fs::copy(&file, dir.join(&name)).await.is_ok() {
                art.insert(k.into(), json!(name));
            }
        }
    }
    if want(&art, "hero") {
        if let Some(backdrop) = steam.as_ref().map(|c| c.backdrop.clone()).filter(|b| !b.is_empty()) {
            if let Some(f) = metadata::download(&backdrop, &dir.join("hero")).await {
                art.insert("hero".into(), json!(f));
            }
        }
    }

    // Executable icon as a last-resort tile.
    let launch = g.get("launch").cloned().unwrap_or(Value::Null);
    let exe = Some(s(g, "exe")).filter(|e| !e.is_empty()).map(str::to_string).or_else(|| (launch["type"] == "exe").then(|| launch["target"].as_str().unwrap_or("").to_string()));
    if want(&art, "icon") {
        if let Some(exe) = exe.filter(|e| exists(e)) {
            let out = dir.join("icon.png");
            let made = tauri::async_runtime::spawn_blocking(move || winapi::exe_icon_png(Path::new(&exe)).and_then(|png| std::fs::write(&out, png).ok()))
                .await
                .ok()
                .flatten();
            if made.is_some() {
                art.insert("icon".into(), json!("icon.png"));
            }
        }
    }

    let found_sg = sg.is_some();
    with_game(app, &id, |g| {
        g.insert("art".into(), Value::Object(art));
        g.insert("artVersion".into(), json!(now_ms()));
        if let Some(item) = item {
            g.insert("meta".into(), metadata::steam_meta(item));
            g.insert("screenshots".into(), metadata::steam_screenshots(item));
        } else if !truthy(g.get("steamAppId")) {
            g.insert("meta".into(), json!({}));
            g.insert("screenshots".into(), json!([]));
        }
        let ok = truthy(g.get("steamAppId")) || found_sg;
        g.insert("metaStatus".into(), json!(if ok { "ok" } else { "notfound" }));
    });
}

fn steam_local_assets(appid: &str) -> Vec<(&'static str, String)> {
    let Some(steam) = scanner::find_steam_path() else { return Vec::new() };
    let base = Path::new(&steam).join("appcache").join("librarycache");
    let app_dir = base.join(appid);
    let subdirs: Vec<PathBuf> = std::fs::read_dir(&app_dir)
        .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).map(|e| e.path()).collect())
        .unwrap_or_default();
    let wanted: [(&str, &[&str]); 4] = [
        ("logo", &["logo.png"]),
        ("hero", &["library_hero.jpg"]),
        ("capsule", &["library_600x900.jpg", "library_capsule.jpg"]),
        ("banner", &["header.jpg", "library_header.jpg"]),
    ];
    let mut out = Vec::new();
    for (k, names) in wanted {
        for n in names {
            let mut candidates = vec![base.join(format!("{appid}_{n}")), app_dir.join(n)];
            candidates.extend(subdirs.iter().map(|d| d.join(n)));
            if let Some(hit) = candidates.into_iter().find(|f| f.exists()) {
                out.push((k, hit.to_string_lossy().into_owned()));
                break;
            }
        }
    }
    out
}

/* ---------------------------------------------------------------- */
/* Per-game actions                                                  */
/* ---------------------------------------------------------------- */

pub async fn set_match(app: &AppHandle, id: &str, appid: Option<String>) -> Value {
    let found = with_game(app, id, |g| {
        match &appid {
            Some(a) => {
                g.insert("steamAppId".into(), json!(a));
                g.insert("noSteamMatch".into(), json!(false));
            }
            None => {
                if g.get("source").and_then(|v| v.as_str()) != Some("steam") {
                    g.insert("steamAppId".into(), Value::Null);
                }
                g.insert("noSteamMatch".into(), json!(true));
            }
        }
        g.insert("customArt".into(), json!({}));
    });
    if found.is_none() {
        return Value::Null;
    }
    fetch_metadata(app, vec![id.to_string()], true).await;
    find(app, id).unwrap_or(Value::Null)
}

pub async fn set_custom_art(app: &AppHandle, id: &str, kind: &str, file: &Path) -> Value {
    if find(app, id).is_none() || !ART_KEYS.contains(&kind) {
        return Value::Null;
    }
    let dir = art_path(app, id);
    let _ = tokio::fs::create_dir_all(&dir).await;
    if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            if e.file_name().to_string_lossy().starts_with(&format!("custom-{kind}.")) {
                let _ = tokio::fs::remove_file(e.path()).await;
            }
        }
    }
    let ext = file.extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase())).unwrap_or_else(|| ".png".into());
    let name = format!("custom-{kind}{ext}");
    if tokio::fs::copy(file, dir.join(&name)).await.is_err() {
        return Value::Null;
    }
    with_game(app, id, |g| {
        let mut art = g.get("art").and_then(|a| a.as_object()).cloned().unwrap_or_default();
        art.insert(kind.into(), json!(name));
        g.insert("art".into(), Value::Object(art));
        let mut custom = g.get("customArt").and_then(|a| a.as_object()).cloned().unwrap_or_default();
        custom.insert(kind.into(), json!(true));
        g.insert("customArt".into(), Value::Object(custom));
        g.insert("artVersion".into(), json!(now_ms()));
    });
    save(app);
    find(app, id).unwrap_or(Value::Null)
}

pub fn update(app: &AppHandle, id: &str, patch: &Value) -> Value {
    let Some(p) = patch.as_object() else { return Value::Null };
    let done = with_game(app, id, |g| {
        for k in ["name", "favorite", "hidden", "category", "lastPlayed", "launchCount", "playtime", "pauseMode", "launchMode", "controllerMode"] {
            if let Some(v) = p.get(k) {
                g.insert(k.into(), v.clone());
            }
        }
        if p.contains_key("name") {
            g.insert("nameLocked".into(), json!(true));
        }
        if let Some(args) = p.get("launchArgs") {
            let exe_launch = g.get("launch").and_then(|l| l.get("type")).and_then(|t| t.as_str()) == Some("exe");
            if exe_launch {
                if let Some(l) = g.get_mut("launch").and_then(|l| l.as_object_mut()) {
                    l.insert("args".into(), args.clone());
                }
            } else {
                g.insert("launchArgs".into(), args.clone()); // added to store and direct starts
            }
        }
        Value::Object(g.clone())
    });
    save(app);
    done.unwrap_or(Value::Null)
}

/// Remember something about a game (e.g. the executable found for a direct start).
pub fn set_field(app: &AppHandle, id: &str, key: &str, value: Value) {
    with_game(app, id, |g| {
        g.insert(key.into(), value);
    });
}

/// The launcher is starting this game.
pub fn note_launch(app: &AppHandle, id: &str) {
    with_game(app, id, |g| {
        let n = g.get("launchCount").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
        g.insert("lastPlayed".into(), json!(now_ms()));
        g.insert("launchCount".into(), json!(n));
    });
    save(app);
}

/// A session ended (the game monitor counts it, however the game was started).
pub fn add_playtime(app: &AppHandle, id: &str, minutes: i64) {
    let found = with_game(app, id, |g| {
        let total = g.get("playtime").and_then(|v| v.as_i64()).unwrap_or(0) + minutes;
        g.insert("playtime".into(), json!(total));
    });
    if found.is_some() {
        save(app);
    }
}

pub fn remove(app: &AppHandle, id: &str) {
    {
        let l = launcher(app);
        let mut lib = l.library.lock().unwrap();
        let Some(list) = lib.data["games"].as_array_mut() else { return };
        let before = list.len();
        list.retain(|g| s(g, "id") != id);
        if list.len() == before {
            return;
        }
        if let Some(ex) = lib.data["excluded"].as_array_mut() {
            if !ex.iter().any(|x| x.as_str() == Some(id)) {
                ex.push(json!(id));
            }
        }
    }
    delete_art(app, id);
    save(app);
}

pub fn restore_excluded(app: &AppHandle) -> usize {
    let l = launcher(app);
    let mut lib = l.library.lock().unwrap();
    let n = lib.data["excluded"].as_array().map_or(0, |a| a.len());
    lib.data["excluded"] = json!([]);
    let _ = lib.save();
    n
}

pub async fn reset(app: &AppHandle) {
    {
        let l = launcher(app);
        let mut lib = l.library.lock().unwrap();
        lib.data["games"] = json!([]);
        lib.data["excluded"] = json!([]);
        let _ = lib.save();
    }
    let _ = tokio::fs::remove_dir_all(&launcher(app).dirs.art).await;
    publish(app, true);
}

pub async fn cache_size(app: &AppHandle) -> u64 {
    let dir = launcher(app).dirs.art.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fn walk(d: &Path) -> u64 {
            std::fs::read_dir(d)
                .map(|rd| rd.flatten().map(|e| if e.path().is_dir() { walk(&e.path()) } else { e.metadata().map(|m| m.len()).unwrap_or(0) }).sum())
                .unwrap_or(0)
        }
        walk(&dir)
    })
    .await
    .unwrap_or(0)
}

/// Pick up play time and last played from Steam (it counts games started
/// anywhere). Throttled to once every 30 s when called on focus.
pub async fn refresh_steam_playtime(app: &AppHandle) {
    if launcher(app).settings.lock().unwrap().data["scanSteam"] == false {
        return;
    }
    let Ok(Some(user)) = tauri::async_runtime::spawn_blocking(|| scanner::find_steam_path().map(|p| scanner::read_steam_user(&p))).await else { return };
    let changed = {
        let l = launcher(app);
        let mut lib = l.library.lock().unwrap();
        let mut changed = false;
        for g in lib.data["games"].as_array_mut().into_iter().flatten() {
            let via_steam = s(g, "source") == "steam" || g["launch"]["target"].as_str().unwrap_or("").starts_with("steam://");
            let appid = s(g, "steamAppId").to_string();
            if !via_steam || appid.is_empty() {
                continue;
            }
            let Some(&(minutes, last)) = user.playtime.get(&appid) else { continue };
            if g["steamPlaytime"].as_i64() != Some(minutes) || g["steamLastPlayed"].as_i64() != Some(last) {
                g["steamPlaytime"] = json!(minutes);
                g["steamLastPlayed"] = json!(last);
                changed = true;
            }
        }
        changed
    };
    if changed {
        save(app);
    }
}

pub fn info(app: &AppHandle) -> Info {
    launcher(app).lib.info.lock().unwrap().clone()
}
