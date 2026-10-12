//! One entry point for every `window.api` call (see renderer/js/bridge.js).
//! Channels keep the Electron names from main/main.js, so each handler there
//! has its counterpart here. Channels without one yet answer with an error the
//! renderer already handles like any failed call.

use crate::util::{exists, send};
use crate::{controller, discord, games, library, metadata, overlay, soundpacks, Launcher};
use regex::Regex;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::LazyLock};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

fn arg(args: &[Value], i: usize) -> Value {
    args.get(i).cloned().unwrap_or(Value::Null)
}

fn arg_str(args: &[Value], i: usize) -> String {
    args.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// What the renderer gets as `state.window`.
pub fn window_state(app: &AppHandle, win: &WebviewWindow) -> Value {
    json!({
        "fullscreen": win.is_fullscreen().unwrap_or(false),
        "focused": games::main_focused(app),
        "maximized": win.is_maximized().unwrap_or(false),
    })
}

fn info(app: &AppHandle, l: &Launcher) -> Value {
    let i = library::info(app);
    json!({
        "version": app.package_info().version.to_string(),
        "tauri": tauri::VERSION,
        "webview": tauri::webview_version().unwrap_or_default(),
        "platform": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "dataDir": l.dirs.data.to_string_lossy(),
        "steam": i.steam,
        "epic": i.epic,
        "xbox": i.xbox,
        "ubisoft": i.ubisoft,
        "excluded": l.library.lock().unwrap().data["excluded"].as_array().map_or(0, |a| a.len()),
    })
}

/* ---------------- Native dialogs ---------------- */

async fn pick_folder(app: &AppHandle, win: &WebviewWindow, title: &str) -> Option<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_parent(win).set_title(title).pick_folder(move |p| {
        let _ = tx.send(p);
    });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok())
}

async fn pick_file(app: &AppHandle, win: &WebviewWindow, title: &str, filter: &str, exts: &[&str]) -> Option<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_parent(win).set_title(title).add_filter(filter, exts).pick_file(move |p| {
        let _ = tx.send(p);
    });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok())
}

async fn pick_files(app: &AppHandle, win: &WebviewWindow, title: &str, filter: &str, exts: &[&str]) -> Vec<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_parent(win).set_title(title).add_filter(filter, exts).pick_files(move |p| {
        let _ = tx.send(p);
    });
    rx.await.ok().flatten().unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect()
}

const IMAGES: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];

/// Settings that changed outside settings:set (folders) go to every window.
fn set_folders(app: &AppHandle, l: &Launcher, f: impl FnOnce(&mut Vec<Value>)) -> Value {
    let saved = {
        let mut st = l.settings.lock().unwrap();
        let mut folders = st.data["folders"].as_array().cloned().unwrap_or_default();
        f(&mut folders);
        st.data["folders"] = Value::Array(folders);
        let _ = st.save();
        st.data.clone()
    };
    send(app, "settings:changed", saved.clone());
    saved
}

pub async fn dispatch(app: AppHandle, win: WebviewWindow, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    let l = app.state::<Launcher>();
    match channel {
        /* ---------------- State and settings ---------------- */
        "state:get" => {
            let main = app.get_webview_window("main");
            Ok(json!({
                "window": main.as_ref().map(|w| window_state(&app, w)),
                "settings": l.settings.lock().unwrap().data.clone(),
                "games": l.library.lock().unwrap().data["games"].clone(),
                "running": l.monitor.list(),
                "info": info(&app, &l),
            }))
        }
        "info:get" => {
            let mut i = info(&app, &l);
            if let Value::Object(m) = &mut i {
                for k in ["version", "tauri", "webview", "platform", "dataDir"] {
                    m.remove(k);
                }
            }
            Ok(i)
        }
        "settings:set" => {
            let patch = arg(&args, 0);
            let (prev, saved) = {
                let mut s = l.settings.lock().unwrap();
                let prev = s.data.clone();
                s.merge(&patch);
                s.save()?;
                (prev, s.data.clone())
            };
            // Keep the other window (launcher <-> overlay) in sync.
            for (label, _) in app.webview_windows() {
                if label != win.label() {
                    let _ = tauri::Emitter::emit_to(&app, label.as_str(), "settings:changed", &saved);
                }
            }
            if let Some(fs) = patch.get("fullscreen").and_then(|v| v.as_bool()) {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.set_fullscreen(fs);
                    send(&app, "window:state", json!({ "fullscreen": fs, "focused": games::main_focused(&app) }));
                }
            }
            if let Some(on) = patch.get("launchAtStartup") {
                if let Err(e) = crate::startup::set(on == &json!(true)) {
                    eprintln!("[startup] {e}");
                }
            }
            if patch.get("overlayHotkey").is_some() {
                controller::apply_hotkey(&app);
            }
            if patch.get("pauseGames").is_some() {
                games::schedule_pause(&app);
            }
            if patch.get("controllerPassthrough").is_some() {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    controller::apply_passthrough(&app, true).await;
                });
            } else if let Some(mode) = patch.get("passthroughEmulation") {
                let mode = mode.as_str().unwrap_or("dualsense").to_string();
                if let Some(a) = l.system.passthrough_args.lock().unwrap().as_mut() {
                    a["mode"] = json!(mode);
                }
                let sys = l.system.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = sys.request("passthroughConfig", json!({ "mode": mode }), 8000).await;
                });
            }
            // A store switched on or off: scan again.
            if ["scanSteam", "scanEpic", "scanXbox", "scanUbisoft"].iter().any(|k| patch.get(*k).is_some_and(|v| Some(v) != prev.get(*k))) {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    library::scan(&app, true).await;
                });
            }
            Ok(saved)
        }

        /* ---------------- Library ---------------- */
        "library:scan" => Ok(library::scan(&app, false).await),
        "library:refreshAll" => {
            let ids = library::games(&app).iter().filter_map(|g| g["id"].as_str().map(str::to_string)).collect();
            library::fetch_metadata(&app, ids, true).await;
            Ok(Value::Null)
        }
        "library:addFolder" => {
            let Some(folder) = pick_folder(&app, &win, "Choose a folder with game shortcuts").await else { return Ok(Value::Null) };
            let folder = folder.to_string_lossy().into_owned();
            let f = folder.clone();
            set_folders(&app, &l, |list| {
                if !list.iter().any(|x| x.as_str() == Some(&f)) {
                    list.push(json!(f));
                }
            });
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                library::scan(&app2, false).await;
            });
            Ok(json!(folder))
        }
        "library:removeFolder" => {
            let folder = arg_str(&args, 0);
            let saved = set_folders(&app, &l, |list| list.retain(|x| x.as_str() != Some(&folder)));
            library::scan(&app, true).await;
            Ok(saved["folders"].clone())
        }
        "library:import" => {
            let paths = arg(&args, 0).as_array().map(|a| a.iter().filter_map(|p| p.as_str().map(str::to_string)).collect()).unwrap_or_default();
            Ok(json!(library::import_paths(&app, paths).await))
        }
        "library:addFiles" => {
            let files = pick_files(&app, &win, "Add games", "Games & shortcuts", &["lnk", "url", "exe", "bat", "cmd"]).await;
            if files.is_empty() {
                return Ok(json!(0));
            }
            let paths = files.iter().map(|p| p.to_string_lossy().into_owned()).collect();
            Ok(json!(library::import_paths(&app, paths).await))
        }
        "library:restoreExcluded" => {
            let n = library::restore_excluded(&app);
            library::scan(&app, true).await;
            Ok(json!(n))
        }
        "library:reset" => {
            library::reset(&app).await;
            Ok(Value::Null)
        }
        "cache:size" => Ok(json!(library::cache_size(&app).await)),
        "steam:search" => Ok(json!(metadata::search_steam(&arg_str(&args, 0)).await.unwrap_or_default())),

        /* ---------------- Games ---------------- */
        "game:update" => {
            let patch = arg(&args, 1);
            let r = library::update(&app, &arg_str(&args, 0), &patch);
            // Switching a running game to / from the real controller applies right away.
            if patch.get("controllerMode").is_some() && l.settings.lock().unwrap().data["controllerPassthrough"] == true {
                controller::apply_passthrough(&app, false).await;
            }
            Ok(r)
        }
        "game:remove" => {
            library::remove(&app, &arg_str(&args, 0));
            Ok(Value::Null)
        }
        "game:refreshArt" => {
            let id = arg_str(&args, 0);
            if library::find(&app, &id).is_some() {
                library::fetch_metadata(&app, vec![id], true).await;
            }
            Ok(Value::Null)
        }
        "game:setMatch" => {
            let appid = match arg(&args, 1) {
                Value::String(s) if !s.is_empty() => Some(s),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            };
            Ok(library::set_match(&app, &arg_str(&args, 0), appid).await)
        }
        "game:customArt" => {
            let Some(file) = pick_file(&app, &win, "Choose an image", "Images", &IMAGES).await else { return Ok(Value::Null) };
            Ok(library::set_custom_art(&app, &arg_str(&args, 0), &arg_str(&args, 1), &file).await)
        }
        "game:openLocation" => {
            let Some(g) = library::find(&app, &arg_str(&args, 0)) else { return Ok(Value::Null) };
            let field = |k: &str| g.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
            let target = field("path").or_else(|| field("exe")).or_else(|| field("installDir"));
            if let Some(t) = target.filter(|t| exists(t)) {
                let _ = app.opener().reveal_item_in_dir(t);
            } else if let Some(dir) = field("installDir").filter(|d| exists(d)) {
                let _ = app.opener().open_path(dir, None::<&str>);
            }
            Ok(Value::Null)
        }

        /* ---------------- Profile pictures ---------------- */
        // Copied into the data folder under a new name, so replacing one never
        // shows a stale cached image.
        "profile:pickImage" => {
            let Some(src) = pick_file(&app, &win, "Choose a profile picture", "Images", &IMAGES).await else { return Ok(Value::Null) };
            let ext = src.extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase())).unwrap_or_default();
            let name = format!("{}{ext}", radix36(crate::util::now_ms() as u64));
            tokio::fs::create_dir_all(&l.dirs.avatars).await.map_err(|e| e.to_string())?;
            tokio::fs::copy(&src, l.dirs.avatars.join(&name)).await.map_err(|e| e.to_string())?;
            Ok(json!(format!("app://avatar/{name}")))
        }
        "profile:removeImage" => {
            static AVATAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^app://avatar/([\w.-]+)$").unwrap());
            if let Some(c) = AVATAR.captures(&arg_str(&args, 0)) {
                let _ = tokio::fs::remove_file(l.dirs.avatars.join(&c[1])).await;
            }
            Ok(Value::Null)
        }

        /* ---------------- App ---------------- */
        "app:openData" => {
            let _ = app.opener().open_path(l.dirs.data.to_string_lossy(), None::<&str>);
            Ok(Value::Null)
        }
        "app:openExternal" => {
            static ALLOWED: LazyLock<Regex> = LazyLock::new(|| {
                Regex::new(r"^(steam://|discord://|https://(store\.steampowered\.com|www\.steamgriddb\.com|discord\.com/developers|github\.com/nefarius/HidHide|github\.com/Alia5/VIIPER)/?)").unwrap()
            });
            let url = arg_str(&args, 0);
            if ALLOWED.is_match(&url) {
                let _ = app.opener().open_url(url, None::<&str>);
            }
            Ok(Value::Null)
        }
        "window:action" => {
            let Some(main) = app.get_webview_window("main") else { return Ok(Value::Null) };
            match arg(&args, 0).as_str() {
                Some("minimize") => {
                    let _ = main.minimize();
                }
                Some("close") => app.exit(0),
                Some("toggleMaximize") => {
                    if main.is_maximized().unwrap_or(false) {
                        let _ = main.unmaximize();
                    } else {
                        let _ = main.maximize();
                    }
                }
                Some("toggleFullscreen") => {
                    let fs = !main.is_fullscreen().unwrap_or(false);
                    let _ = main.set_fullscreen(fs);
                    send(&app, "window:state", json!({ "fullscreen": fs, "focused": games::main_focused(&app) }));
                    return Ok(json!({ "fullscreen": fs }));
                }
                _ => {}
            }
            Ok(json!({ "fullscreen": main.is_fullscreen().unwrap_or(false) }))
        }
        /* ---------------- Running games ---------------- */
        "games:running" => Ok(l.monitor.list()),
        "game:launch" => games::launch(&app, &arg_str(&args, 0)).await,
        "game:continue" => Ok(games::continue_game(&app, &arg_str(&args, 0)).await),
        "game:close" => Ok(json!(games::close(&app, &arg_str(&args, 0), win.label() == "overlay").await)),

        /* ---------------- In-game overlay and controller ---------------- */
        "overlay:closed" => {
            overlay::hide_now(&app, true).await;
            Ok(Value::Null)
        }
        "overlay:navigate" => {
            overlay::hide_now(&app, false).await;
            games::show_launcher(&app, Some(arg(&args, 0))).await;
            Ok(Value::Null)
        }
        "overlay:toggle" => {
            overlay::toggle(&app, overlay::open_info(&app)).await;
            Ok(Value::Null)
        }
        "notify:popup" => {
            let n = arg(&args, 0);
            if n.is_object() {
                let s = |k: &str, d: &str| n[k].as_str().map(str::to_string).unwrap_or_else(|| d.to_string());
                let duration = n["duration"].as_f64().filter(|d| *d > 0.0).unwrap_or(5000.0).min(15000.0) as u64;
                let payload = json!({
                    "title": s("title", ""), "body": s("body", ""), "icon": s("icon", "bell"),
                    "image": n["image"].as_str(), "duration": duration, "kind": s("kind", "system"),
                });
                overlay::popup(&app, payload).await;
            }
            Ok(Value::Null)
        }
        "passthrough:status" => Ok(controller::status(&app).await),
        "pad:fallback" => {
            controller::set_fallback(&app, arg(&args, 0) == true).await;
            Ok(Value::Null)
        }
        "game:launchCancel" => {
            games::stop_watch(&app);
            Ok(Value::Null)
        }

        /* ---------------- Media, volume, displays, Bluetooth (helper) ---------------- */
        "sys:available" => Ok(json!(l.system.available())),
        "sys:media" => l.system.media(&arg_str(&args, 0), &arg_str(&args, 1)).await,
        "sys:mediaPlaying" => Ok(l.system.request("mediaPlaying", json!({}), 3000).await.unwrap_or(json!(false))),
        "sys:mediaCmd" => {
            let value = args.get(2).and_then(|v| v.as_f64()).unwrap_or(0.0);
            l.system.request("mediaCmd", json!({ "app": arg_str(&args, 0), "action": arg_str(&args, 1), "value": value as i64 }), 8000).await
        }
        "sys:volume" => l.system.request("volume", json!({}), 8000).await,
        "sys:setVolume" => l.system.set_volume(args.first().and_then(|v| v.as_f64()).unwrap_or(50.0)).await,
        "sys:setMute" => l.system.request("setMute", json!({ "value": arg(&args, 0) == true }), 8000).await,
        "sys:audioOutputs" => l.system.request("audioOutputs", json!({}), 8000).await,
        "sys:setAudioOutput" => l.system.request("setAudioOutput", json!({ "device": arg_str(&args, 0) }), 8000).await,
        "sys:brightness" => l.system.request("brightness", json!({}), 15000).await,
        "sys:setBrightness" => {
            let index = args.get(1).and_then(|v| v.as_i64()).unwrap_or(-1);
            l.system.set_brightness(args.first().and_then(|v| v.as_f64()).unwrap_or(50.0), index).await
        }
        "sys:nightLight" => l.system.request("nightLight", json!({}), 8000).await,
        "sys:setNightLight" => l.system.request("setNightLight", json!({ "value": arg(&args, 0) == true }), 8000).await,
        "bt:state" => l.system.request("bt", json!({}), 20000).await,
        "bt:radio" => l.system.request("btRadio", json!({ "value": arg(&args, 0) == true }), 20000).await,
        "bt:connect" => {
            let cmd = if arg(&args, 1) == true { "btConnect" } else { "btDisconnect" };
            l.system.request(cmd, json!({ "address": arg(&args, 0) }), 15000).await
        }
        "bt:pair" => l.system.request("btPair", json!({ "device": arg(&args, 0) }), 70000).await,
        "bt:unpair" => l.system.request("btUnpair", json!({ "device": arg(&args, 0) }), 35000).await,
        "bt:scan" => {
            let cmd = match arg_str(&args, 0).as_str() {
                "start" => "btScanStart",
                "stop" => "btScanStop",
                _ => "btScan",
            };
            l.system.request(cmd, json!({}), 10000).await
        }
        "power:action" => {
            use std::os::windows::process::CommandExt;
            let run = |cmd: &str, a: &[&str]| {
                let _ = std::process::Command::new(cmd).args(a).creation_flags(0x0800_0000).spawn();
            };
            match arg_str(&args, 0).as_str() {
                "shutdown" => run("shutdown", &["/s", "/t", "0"]),
                "restart" => run("shutdown", &["/r", "/t", "0"]),
                "sleep" => run(
                    "powershell",
                    &["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState(\"Suspend\", $false, $false)"],
                ),
                _ => {}
            }
            Ok(Value::Null)
        }
        /* ---------------- Sound themes ---------------- */
        "sounds:list" => Ok(Value::Array(soundpacks::list(&l.dirs.sounds))),
        "sounds:browse" => soundpacks::browse(&arg(&args, 0)).await,
        "sounds:download" => soundpacks::download(&l.dirs.sounds, &arg(&args, 0)).await,
        "sounds:remove" => {
            let id = arg_str(&args, 0);
            soundpacks::remove(&l.dirs.sounds, &id);
            // A removed pack that was in use goes back to the built-in sounds.
            let saved = {
                let mut st = l.settings.lock().unwrap();
                let mut changed = false;
                for k in ["soundPack", "musicPack"] {
                    if st.data[k].as_str() == Some(id.as_str()) {
                        st.data[k] = Value::Null;
                        changed = true;
                    }
                }
                if changed {
                    let _ = st.save();
                }
                changed.then(|| st.data.clone())
            };
            if let Some(s) = saved {
                send(&app, "settings:changed", s);
            }
            Ok(json!(true))
        }
        "sounds:installLocal" => {
            let source = if arg_str(&args, 0) == "folder" {
                pick_folder(&app, &win, "Choose a sound pack").await
            } else {
                pick_file(&app, &win, "Choose a sound pack", "Sound pack", &["zip"]).await
            };
            let Some(source) = source else { return Ok(Value::Null) };
            let dir = l.dirs.sounds.clone();
            tauri::async_runtime::spawn_blocking(move || soundpacks::install_local(&dir, &source)).await.map_err(|e| e.to_string())?
        }

        /* ---------------- Discord ---------------- */
        "discord:state" => Ok(l.discord.public_state()),
        "discord:setup" => discord::setup(&app, &arg(&args, 0)),
        "discord:connect" => Ok(discord::connect(&app, true).await),
        "discord:disconnect" => Ok(discord::disconnect(&app).await),
        "discord:forget" => Ok(discord::forget(&app).await),
        "discord:cmd" => discord::command(&app, &arg_str(&args, 0), &arg(&args, 1), &arg(&args, 2)).await,
        "discord:openChat" => {
            let id = match arg(&args, 0) {
                Value::String(s) => s,
                Value::Number(n) => n.to_string(),
                _ => String::new(),
            };
            discord::open_chat(&app, &id).await
        }
        "discord:closeChat" => {
            discord::close_chat(&app);
            Ok(Value::Null)
        }
        "discord:openInDiscord" => {
            let id = match arg(&args, 0) {
                Value::String(s) => s,
                Value::Number(n) => n.to_string(),
                _ => String::new(),
            };
            Ok(json!(discord::open_in_discord(&app, &id, &arg(&args, 1))))
        }
        _ => {
            #[cfg(debug_assertions)]
            eprintln!("[ipc] not ported yet: {channel}");
            Err(format!("{channel} isn't available in the Tauri version yet"))
        }
    }
}

/// Date.now().toString(36)
fn radix36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}
