// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod controller;
mod data;
mod discord;
mod games;
mod ipc;
mod launcher;
mod library;
mod metadata;
mod monitor;
mod overlay;
mod protocol;
mod scanner;
mod secure;
mod soundpacks;
mod startup;
mod store;
mod system;
mod util;
mod vdf;
mod winapi;

use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use store::JsonStore;
use tauri::{Manager, RunEvent, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// Shared launcher state (the counterpart of the stores and managers that
/// main/main.js keeps in its closure).
pub struct Launcher {
    pub dirs: Arc<data::Dirs>,
    pub settings: Mutex<JsonStore>,
    pub library: Mutex<JsonStore>,
    pub lib: library::LibState,
    pub system: Arc<system::SystemBridge>,
    pub monitor: monitor::GameMonitor,
    pub games: games::GamesState,
    pub overlay: overlay::OverlayState,
    pub controller: controller::ControllerState,
    pub discord: discord::Discord,
}

/// Never navigate away from the app's own pages.
pub fn stay_in_app(url: &tauri::Url) -> bool {
    matches!(url.host_str(), Some("tauri.localhost") | Some("localhost")) || url.scheme() == "tauri"
}

/// WebView2 settings every window must share (they live in one browser
/// environment). Debug builds add the DevTools protocol on port 9334.
pub fn browser_args<'a, R: Runtime, M: Manager<R>>(b: WebviewWindowBuilder<'a, R, M>) -> WebviewWindowBuilder<'a, R, M> {
    if cfg!(debug_assertions) {
        b.additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9334")
    } else {
        b
    }
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

    let discord_file = dirs.data.join("discord.json");
    let proto_dirs = dirs.clone();
    tauri::Builder::default()
        // A second start brings the running launcher forward instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { games::show_launcher(&app, None).await });
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed && *shortcut == controller::hotkey() {
                        controller::on_guide(app);
                    }
                })
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("app", move |_ctx, request, responder| {
            let dirs = proto_dirs.clone();
            std::thread::spawn(move || responder.respond(protocol::handle(&dirs, &request)));
        })
        .manage(Launcher {
            dirs,
            settings: Mutex::new(settings),
            library: Mutex::new(library),
            lib: library::LibState::default(),
            system: Arc::new(system::SystemBridge::new(system::helper_path())),
            monitor: monitor::GameMonitor::new(monitor::Hooks { on_change: Box::new(games::on_change), on_ended: Box::new(games::on_ended) }),
            games: games::GamesState::default(),
            overlay: overlay::OverlayState::default(),
            controller: controller::ControllerState::default(),
            discord: discord::Discord::new(discord_file),
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
                // Frameless: in windowed mode the UI draws a slim title strip with
                // the window buttons (Electron used titleBarOverlay for this).
                .decorations(false)
                .background_color(tauri::window::Color(0, 0, 0, 255))
                .on_navigation(stay_in_app);
            let win = browser_args(builder).build()?;

            let handle = app.handle().clone();
            let w = win.clone();
            win.on_window_event(move |e| match e {
                WindowEvent::Resized(_) => util::send(&handle, "window:state", ipc::window_state(&handle, &w)),
                // The overlay window would keep the app alive otherwise.
                WindowEvent::Destroyed => handle.exit(0),
                _ => {}
            });
            // Focus (and with it pausing, play time refresh, window:state).
            games::start_focus_watch(app.handle());

            // The native helper (controller events go to controller.rs), the
            // game monitor, the in-game overlay and its keyboard shortcut.
            let h = app.handle().clone();
            app.state::<Launcher>().system.set_event_handler(Arc::new(move |event, msg| controller::on_helper_event(&h, event, msg)));
            app.state::<Launcher>().system.start();
            monitor::GameMonitor::start(app.handle());
            overlay::create(app.handle());
            controller::apply_hotkey(app.handle());
            discord::start(app.handle());
            // Always: when it is off this also undoes hiding left over from a crash.
            let h = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                metadata::sleep(1200).await;
                controller::apply_passthrough(&h, true).await;
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
        .build(tauri::generate_context!())
        .expect("error while building the launcher")
        .run(|app, event| {
            // Closing the helper's stdin makes it resume a paused game and exit.
            if let RunEvent::Exit = event {
                app.state::<Launcher>().system.stop();
            }
        });
}
