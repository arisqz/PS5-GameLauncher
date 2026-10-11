// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod data;
mod ipc;
mod library;
mod metadata;
mod protocol;
mod scanner;
mod soundpacks;
mod store;
mod util;
mod vdf;
mod winapi;

use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use store::JsonStore;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// Shared launcher state (the counterpart of the stores and managers that
/// main/main.js keeps in its closure).
pub struct Launcher {
    pub dirs: Arc<data::Dirs>,
    pub settings: Mutex<JsonStore>,
    pub library: Mutex<JsonStore>,
    pub lib: library::LibState,
}

#[tauri::command]
async fn ipc(app: tauri::AppHandle, window: WebviewWindow, channel: String, args: Vec<Value>) -> Result<Value, String> {
    ipc::dispatch(app, window, &channel, args).await
}

fn main() {
    let data_dir = data::data_dir();
    data::import_electron_data(&data_dir);
    let dirs = Arc::new(data::Dirs::new(data_dir));
    let defaults: Value = serde_json::from_str(include_str!("default_settings.json")).expect("default_settings.json");
    let settings = JsonStore::load(dirs.data.join("settings.json"), defaults);
    let mut library = JsonStore::load(dirs.data.join("library.json"), json!({ "games": [], "excluded": [] }));
    for k in ["games", "excluded"] {
        if !library.data[k].is_array() {
            library.data[k] = json!([]);
        }
    }

    let proto_dirs = dirs.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("app", move |_ctx, request, responder| {
            let dirs = proto_dirs.clone();
            std::thread::spawn(move || responder.respond(protocol::handle(&dirs, &request)));
        })
        .manage(Launcher {
            dirs,
            settings: Mutex::new(settings),
            library: Mutex::new(library),
            lib: library::LibState::default(),
        })
        .invoke_handler(tauri::generate_handler![ipc])
        .setup(|app| {
            let (fullscreen, rescan) = {
                let l = app.state::<Launcher>();
                let s = l.settings.lock().unwrap();
                let empty = l.library.lock().unwrap().data["games"].as_array().is_none_or(|g| g.is_empty());
                (
                    s.data["fullscreen"].as_bool().unwrap_or(false) && !std::env::args().any(|a| a == "--windowed"),
                    s.data["rescanOnStartup"].as_bool().unwrap_or(true) || empty,
                )
            };
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("PS5 Game Launcher")
                .inner_size(1600.0, 900.0)
                .min_inner_size(960.0, 540.0)
                .fullscreen(fullscreen)
                .background_color(tauri::window::Color(0, 0, 0, 255));
            // Debug builds: DevTools protocol on port 9334 (Tauri's own defaults kept).
            #[cfg(debug_assertions)]
            let builder = builder.additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9334");
            let win = builder.build()?;

            let handle = app.handle().clone();
            let w = win.clone();
            win.on_window_event(move |e| match e {
                WindowEvent::Focused(focused) => {
                    util::send(&handle, "window:state", ipc::window_state(&w));
                    // Back in the launcher: pick up Steam play time (at most every 30 s).
                    if *focused {
                        let l = handle.state::<Launcher>();
                        let mut last = l.lib.last_playtime_refresh.lock().unwrap();
                        if last.is_none_or(|t| t.elapsed().as_secs() > 30) {
                            *last = Some(std::time::Instant::now());
                            let h = handle.clone();
                            tauri::async_runtime::spawn(async move { library::refresh_steam_playtime(&h).await });
                        }
                    }
                }
                WindowEvent::Resized(_) => util::send(&handle, "window:state", ipc::window_state(&w)),
                _ => {}
            });

            // Look for new games shortly after start.
            if rescan {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    metadata::sleep(1800).await;
                    library::scan(&h, true).await;
                    library::refresh_steam_playtime(&h).await;
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the launcher");
}
