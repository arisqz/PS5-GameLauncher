//! The controller side of main/main.js: the Guide / PS button (from the
//! helper) and the keyboard shortcut, controller buttons for the overlay, and
//! controller passthrough (HidHide + VIIPER).

use crate::util::{now_ms, send};
use crate::{games, library, overlay, Launcher};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicI64, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

#[derive(Default)]
pub struct ControllerState {
    /// Games get a virtual DualSense the launcher feeds from the real one.
    pub enabled: AtomicBool,
    pub state: Mutex<Value>,
    /// Passthrough just went off and the launcher window doesn't see the
    /// controller again yet, so it keeps getting it through the helper.
    pub fallback: AtomicBool,
    want: Mutex<Option<bool>>,
    last_mute: Mutex<Option<bool>>,
    last_guide: AtomicI64,
}

fn launcher(app: &AppHandle) -> tauri::State<'_, Launcher> {
    app.state::<Launcher>()
}

fn setting(app: &AppHandle, k: &str) -> Value {
    launcher(app).settings.lock().unwrap().data[k].clone()
}

fn main_active(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)) && games::main_focused(app)
}

/// Unsolicited helper events.
pub fn on_helper_event(app: &AppHandle, event: &str, msg: Value) {
    match event {
        "guide" => on_guide(app),
        "pad" => {
            let Some(action) = msg["action"].as_str() else { return };
            let payload = json!({ "action": action, "repeat": msg["repeat"] == true });
            if overlay::visible(app) {
                overlay::send(app, "pad:action", payload);
            } else {
                // With controller passthrough the launcher reads the real
                // controller through the helper too (the virtual one is muted
                // while it is in front).
                let c = &launcher(app).controller;
                if (c.enabled.load(Ordering::SeqCst) || c.fallback.load(Ordering::SeqCst)) && main_active(app) {
                    let _ = app.emit_to("main", "pad:action", payload);
                }
            }
        }
        "passthrough" => {
            *launcher(app).controller.state.lock().unwrap() = msg["state"].clone();
            send(app, "passthrough:state", msg["state"].clone());
        }
        _ => {}
    }
}

/// Guide / PS button and Ctrl+Alt+Home.
pub fn on_guide(app: &AppHandle) {
    let c = &launcher(app).controller;
    let now = now_ms();
    if now - c.last_guide.swap(now, Ordering::SeqCst) < 250 {
        return;
    }
    if overlay::visible(app) {
        overlay::request_close(app);
        return;
    }
    if main_active(app) {
        let _ = app.emit_to("main", "pad:action", "guide");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if setting(&app, "overlay") == false {
            games::show_launcher(&app, None).await;
        } else {
            overlay::show(&app, overlay::open_info(&app)).await;
        }
    });
}

/// Ctrl+Alt+Home opens the quick menu (Settings › Overlay Hotkey).
pub fn apply_hotkey(app: &AppHandle) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if setting(app, "overlayHotkey") != false {
        let _ = gs.register(hotkey());
    }
}

pub fn hotkey() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Home)
}

/* ---------------- Controller passthrough (HidHide + VIIPER) ----------------
   Games get a virtual DualSense that the launcher feeds from the real one.
   Whenever the launcher or the quick menu is in front it is muted, so the
   game can't react to the menu's button presses. */

/// A running game set to use the real controller (DualSense features):
/// passthrough is off meanwhile.
fn real_controller_game(app: &AppHandle) -> Option<Value> {
    let list = launcher(app).monitor.list();
    list.as_array()?.iter().filter_map(|r| r["id"].as_str()).filter_map(|id| library::find(app, id)).find(|g| g["controllerMode"] == "real")
}

pub async fn keep_pad_forward(app: &AppHandle, on: bool) {
    let sys = launcher(app).system.clone();
    sys.keep_forward.store(on, Ordering::SeqCst);
    sys.set_pad_forward(sys.forward.load(Ordering::SeqCst)).await;
}

pub async fn apply_passthrough(app: &AppHandle, force: bool) -> Value {
    let l = launcher(app);
    let on = setting(app, "controllerPassthrough") == true;
    let real = if on { real_controller_game(app) } else { None };
    let want = on && real.is_none();
    {
        let mut prev = l.controller.want.lock().unwrap();
        if !force && *prev == Some(want) {
            return l.controller.state.lock().unwrap().clone();
        }
        *prev = Some(want);
    }
    let mode = setting(app, "passthroughEmulation").as_str().unwrap_or("dualsense").to_string();
    let args = json!({ "value": want, "mode": mode });
    *l.system.passthrough_args.lock().unwrap() = want.then(|| args.clone());
    let mut st = l.system.request("passthrough", args, 15000).await.unwrap_or_else(|e| json!({ "enabled": false, "error": e }));
    if let Some(g) = real {
        st["realGame"] = g["name"].clone();
    }
    let enabled = st["enabled"] == true;
    l.controller.enabled.store(enabled, Ordering::SeqCst);
    *l.controller.state.lock().unwrap() = st.clone();
    keep_pad_forward(app, enabled || l.controller.fallback.load(Ordering::SeqCst)).await;
    send(app, "passthrough:state", st.clone());
    *l.controller.last_mute.lock().unwrap() = None;
    update_passthrough_mute(app);
    st
}

/// The virtual controller goes quiet while the launcher or the quick menu is in front.
pub fn update_passthrough_mute(app: &AppHandle) {
    let l = launcher(app);
    if !l.controller.enabled.load(Ordering::SeqCst) {
        return;
    }
    let muted = overlay::visible(app) || (games::main_focused(app) && app.get_webview_window("main").is_some_and(|w| !w.is_minimized().unwrap_or(false)));
    {
        let mut last = l.controller.last_mute.lock().unwrap();
        if *last == Some(muted) {
            return;
        }
        *last = Some(muted);
    }
    let sys = l.system.clone();
    tauri::async_runtime::spawn(async move {
        let _ = sys.request("passthroughMute", json!({ "value": muted }), 8000).await;
    });
}

pub async fn status(app: &AppHandle) -> Value {
    let st = launcher(app).controller.state.lock().unwrap().clone();
    if !st.is_null() {
        return st;
    }
    launcher(app).system.request("passthroughStatus", json!({}), 3000).await.unwrap_or(Value::Null)
}

pub async fn set_fallback(app: &AppHandle, on: bool) {
    let c = &launcher(app).controller;
    c.fallback.store(on, Ordering::SeqCst);
    let keep = c.enabled.load(Ordering::SeqCst) || on;
    keep_pad_forward(app, keep).await;
}
