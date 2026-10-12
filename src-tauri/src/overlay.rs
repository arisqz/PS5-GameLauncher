//! In-game overlay (port of main/overlay.js): a transparent, always-on-top
//! window that shows the quick menu above whatever is in the foreground. It is
//! a normal separate window - nothing is injected into or read from the game.

use crate::{controller, games, winapi, Launcher};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LABEL: &str = "overlay";

#[derive(Default)]
pub struct OverlayState {
    prev_foreground: Mutex<Option<i64>>,
    hide_gen: AtomicU64,
    focus_gen: AtomicU64,
    toast_gen: AtomicU64,
    toast_shown: AtomicBool,
}

fn launcher(app: &AppHandle) -> tauri::State<'_, Launcher> {
    app.state::<Launcher>()
}

pub fn visible(app: &AppHandle) -> bool {
    launcher(app).games.overlay_visible.load(Ordering::SeqCst)
}

/// Create the (hidden) overlay window, so its page is ready before it is needed.
pub fn create(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("overlay.html".into()))
        .title("PS5 Game Launcher Overlay")
        .visible(false)
        .focused(false)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .on_navigation(crate::stay_in_app);
    crate::browser_args(builder).build().ok()
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL).or_else(|| create(app))
}

/// Something only the overlay page gets.
pub fn send(app: &AppHandle, channel: &str, payload: Value) {
    let _ = app.emit_to(LABEL, channel, payload);
}

/// The monitor of the current foreground window (the game), else the primary.
async fn target_rect(app: &AppHandle) -> ((i32, i32, i32, i32), Option<i64>) {
    let fg = launcher(app).system.foreground().await;
    let n = |v: &Value, k: &str| v[k].as_i64().unwrap_or(0) as i32;
    match fg {
        Some(f) if n(&f, "w") > 0 => (winapi::monitor_rect(n(&f, "x"), n(&f, "y"), n(&f, "w"), n(&f, "h")), f["hwnd"].as_i64().filter(|h| *h != 0)),
        Some(f) => (winapi::monitor_rect(0, 0, 1, 1), f["hwnd"].as_i64().filter(|h| *h != 0)),
        None => (winapi::monitor_rect(0, 0, 1, 1), None),
    }
}

/// A notification over the game: the window is shown without focus and lets
/// every click through, so the game keeps running as before.
pub async fn popup(app: &AppHandle, n: Value) {
    let Some(win) = window(app) else { return };
    send(app, "overlay:toast", n.clone());
    if visible(app) {
        return;
    }
    let o = &launcher(app).overlay;
    if !o.toast_shown.load(Ordering::SeqCst) {
        let (rect, _) = target_rect(app).await;
        let _ = win.set_ignore_cursor_events(true);
        winapi::show_topmost_at(games::hwnd_of(&win), rect);
        o.toast_shown.store(true, Ordering::SeqCst);
    }
    let gen = o.toast_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let wait = n["duration"].as_u64().unwrap_or(5000) + 900;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(wait)).await;
        let o = &launcher(&app).overlay;
        if o.toast_gen.load(Ordering::SeqCst) != gen {
            return;
        }
        o.toast_shown.store(false, Ordering::SeqCst);
        if let Some(win) = app.get_webview_window(LABEL) {
            if !visible(&app) {
                winapi::hide_window(games::hwnd_of(&win));
            }
            let _ = win.set_ignore_cursor_events(false);
        }
    });
}

/// Show the quick menu over the game, on the game's monitor.
pub async fn show(app: &AppHandle, info: Value) {
    let Some(win) = window(app) else { return };
    let l = launcher(app);
    if l.games.overlay_visible.swap(true, Ordering::SeqCst) {
        return;
    }
    let o = &l.overlay;
    o.hide_gen.fetch_add(1, Ordering::SeqCst);
    o.toast_gen.fetch_add(1, Ordering::SeqCst);
    o.toast_shown.store(false, Ordering::SeqCst);
    let _ = win.set_ignore_cursor_events(false);
    let (rect, prev) = target_rect(app).await;
    *o.prev_foreground.lock().unwrap() = prev;
    send(app, "overlay:open", info);
    let hwnd = games::hwnd_of(&win);
    winapi::show_topmost_at(hwnd, rect);
    l.system.set_pad_forward(true).await;
    on_visibility(app, true).await;
    // Take focus so the game stops reacting to input while the menu is open
    // (games read the controller only while they are the foreground window).
    // Fullscreen games sometimes take it straight back, so keep claiming it.
    if !l.system.focus_window(hwnd).await {
        let _ = win.set_focus();
    }
    let token = o.focus_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let l = launcher(&app);
            if !visible(&app) || l.overlay.focus_gen.load(Ordering::SeqCst) != token {
                return;
            }
            let fg = l.system.foreground().await;
            if visible(&app) && fg.is_some_and(|f| f["hwnd"].as_i64() != Some(hwnd as i64)) {
                l.system.focus_window(hwnd).await;
                winapi::raise_topmost(hwnd);
            }
        }
    });
}

/// Ask the overlay page to play its closing animation (it calls hide_now after).
pub fn request_close(app: &AppHandle) {
    if !visible(app) {
        return;
    }
    send(app, "overlay:close", Value::Null);
    let gen = launcher(app).overlay.hide_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(900)).await;
        if launcher(&app).overlay.hide_gen.load(Ordering::SeqCst) == gen {
            hide_now(&app, true).await;
        }
    });
}

pub async fn hide_now(app: &AppHandle, restore_focus: bool) {
    let l = launcher(app);
    l.overlay.hide_gen.fetch_add(1, Ordering::SeqCst);
    if !l.games.overlay_visible.swap(false, Ordering::SeqCst) {
        return;
    }
    l.overlay.focus_gen.fetch_add(1, Ordering::SeqCst);
    l.system.set_pad_forward(false).await;
    // Shown with a plain Win32 call (no activation), so hidden the same way.
    if let Some(win) = app.get_webview_window(LABEL) {
        winapi::hide_window(games::hwnd_of(&win));
    }
    // Resume a paused game before it gets focus back.
    on_visibility(app, false).await;
    let prev = l.overlay.prev_foreground.lock().unwrap().take();
    if restore_focus {
        if let Some(h) = prev {
            l.system.focus_window(h as isize).await;
        }
    }
}

pub async fn toggle(app: &AppHandle, info: Value) {
    if visible(app) {
        request_close(app);
    } else {
        show(app, info).await;
    }
}

/// main.js onVisibility: mute the virtual controller, pause / resume the game.
async fn on_visibility(app: &AppHandle, shown: bool) {
    controller::update_passthrough_mute(app);
    if shown {
        games::schedule_pause(app);
    } else {
        games::update_pause(app).await;
    }
}

/// What the quick menu needs when it opens.
pub fn open_info(app: &AppHandle) -> Value {
    json!({ "running": launcher(app).monitor.list() })
}
