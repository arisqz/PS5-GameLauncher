//! Running games, the counterpart of the launch / pause / close parts of
//! main/main.js: game:launch with the "Starting…" cover, continuing and
//! closing games, pausing a game while a menu is in front of it, and what
//! happens when a game ends.

use crate::util::{now_ms, send};
use crate::{launcher, library, monitor, Launcher};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        LazyLock, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Default)]
pub struct GamesState {
    /// The game process suspended while a menu is in front, and the one being closed.
    paused_pid: Mutex<Option<u32>>,
    closing_pid: Mutex<Option<u32>>,
    pause_gen: AtomicU64,
    pause_lock: tokio::sync::Mutex<()>,
    launch_watch: AtomicU64,
    cover_on: AtomicBool,
    /// Set by the in-game overlay once it is ported.
    pub overlay_visible: AtomicBool,
    /// From the window's focus events (is_focused() can lag behind them).
    pub main_focused: AtomicBool,
}

/// Is the launcher window the active window?
pub fn main_focused(app: &AppHandle) -> bool {
    launcher_state(app).games.main_focused.load(Ordering::SeqCst)
}

/// Follow which window is in front. Tauri's Focused event misses the launcher
/// coming back (Windows hands focus straight to the WebView2 child window),
/// so the foreground window is checked four times a second instead.
pub fn start_focus_watch(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Some(win) = main_window(&app) {
                let fg = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
                let focused = fg.0 as isize == hwnd_of(&win) && hwnd_of(&win) != 0;
                if launcher_state(&app).games.main_focused.swap(focused, Ordering::SeqCst) != focused {
                    on_focus_change(&app, &win, focused);
                }
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    });
}

fn on_focus_change(app: &AppHandle, win: &WebviewWindow, focused: bool) {
    send(app, "window:state", crate::ipc::window_state(app, win));
    crate::controller::update_passthrough_mute(app);
    // The launcher in front of a running game pauses it (and back).
    schedule_pause(app);
    // Back in the launcher: pick up Steam play time (at most every 30 s).
    if focused {
        let l = launcher_state(app);
        let mut last = l.lib.last_playtime_refresh.lock().unwrap();
        if last.is_none_or(|t| t.elapsed().as_secs() > 30) {
            *last = Some(std::time::Instant::now());
            let app = app.clone();
            tauri::async_runtime::spawn(async move { library::refresh_steam_playtime(&app).await });
        }
    }
}

fn launcher_state(app: &AppHandle) -> tauri::State<'_, Launcher> {
    app.state::<Launcher>()
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

pub fn hwnd_of(win: &WebviewWindow) -> isize {
    win.hwnd().map(|h| h.0 as isize).unwrap_or(0)
}

fn launcher_front(app: &AppHandle) -> bool {
    main_window(app).is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)) && main_focused(app)
}

fn setting(app: &AppHandle, k: &str) -> Value {
    launcher_state(app).settings.lock().unwrap().data[k].clone()
}

/* ---------------------------------------------------------------- */
/* Pausing the game while a menu is in front                         */
/* ---------------------------------------------------------------- */
// Windows has no safe way to stop a game from reading the controller, so
// while the quick menu (or the home screen) is in front of a running game we
// suspend the game process - but only for games without anti-cheat files.
// The helper resumes everything if the launcher ever goes away.

pub fn schedule_pause(app: &AppHandle) {
    schedule_pause_in(app, 120);
}

fn schedule_pause_in(app: &AppHandle, ms: u64) {
    let l = launcher_state(app);
    let gen = l.games.pause_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        if launcher_state(&app).games.pause_gen.load(Ordering::SeqCst) == gen {
            update_pause(&app).await;
        }
    });
}

pub async fn update_pause(app: &AppHandle) {
    let l = launcher_state(app);
    let _one_at_a_time = l.games.pause_lock.lock().await;
    let cur = l.monitor.current();
    let overlay = l.games.overlay_visible.load(Ordering::SeqCst);
    let mut want: Option<u32> = None;
    if let Some((id, r)) = &cur {
        let age = now_ms() - r.since;
        let settled = age > 15000; // never pause a game that is still starting
        if !settled {
            schedule_pause_in(app, (15000 - age + 200).max(0) as u64);
        }
        let g = library::find(app, id);
        let real_pad = g.as_ref().is_some_and(|g| g["controllerMode"] == "real") && setting(app, "controllerPassthrough") == true;
        let closing = *l.games.closing_pid.lock().unwrap();
        let paused = *l.games.paused_pid.lock().unwrap();
        if (setting(app, "pauseGames") != false || real_pad) && settled && closing != Some(r.pid) && !l.monitor.has_anti_cheat(id) && (overlay || launcher_front(app)) {
            let mode = if real_pad { "always".to_string() } else { g.as_ref().and_then(|g| g["pauseMode"].as_str()).unwrap_or("auto").to_string() };
            if mode == "always" {
                want = Some(r.pid);
            } else if mode == "auto" {
                // Connected to a server? Pausing would disconnect it, so let it run.
                let conns = if paused == Some(r.pid) {
                    0
                } else {
                    l.system.request("netConns", json!({ "pid": r.pid }), 3000).await.ok().and_then(|v| v.as_i64()).unwrap_or(1)
                };
                if conns == 0 {
                    want = Some(r.pid);
                }
            }
        }
    }
    // wait: the helper first waits for all controller buttons to be released,
    // so the game never wakes up with a button stuck down.
    let paused = *l.games.paused_pid.lock().unwrap();
    if let Some(p) = paused.filter(|p| Some(*p) != want) {
        let _ = l.system.request("resume", json!({ "pid": p, "wait": true }), 5000).await;
        *l.games.paused_pid.lock().unwrap() = None;
    }
    if let Some(w) = want.filter(|w| Some(*w) != *l.games.paused_pid.lock().unwrap()) {
        let ok = l.system.request("suspend", json!({ "pid": w, "wait": true }), 5000).await.ok().and_then(|v| v.as_bool()).unwrap_or(false);
        if ok {
            *l.games.paused_pid.lock().unwrap() = Some(w);
        }
    }
}

pub async fn resume_now(app: &AppHandle) {
    let l = launcher_state(app);
    l.games.pause_gen.fetch_add(1, Ordering::SeqCst);
    // A pause still being applied (the helper first waits for the buttons to
    // be released) must finish before we look, or the game stays frozen.
    let _one_at_a_time = l.games.pause_lock.lock().await;
    let paused = l.games.paused_pid.lock().unwrap().take();
    if let Some(p) = paused {
        let _ = l.system.request("resume", json!({ "pid": p, "wait": true }), 5000).await;
    }
}

/* ---------------------------------------------------------------- */

/// Bring the launcher to the front, optionally navigating somewhere.
pub async fn show_launcher(app: &AppHandle, nav: Option<Value>) {
    let Some(win) = main_window(app) else { return };
    if win.is_minimized().unwrap_or(false) {
        let _ = win.unminimize();
    }
    let _ = win.show();
    if !launcher_state(app).system.focus_window(hwnd_of(&win)).await {
        let _ = win.set_focus();
    }
    if let Some(nav) = nav {
        send(app, "navigate", nav);
    }
}

/// Monitor hook: the running list changed.
pub fn on_change(app: &AppHandle, list: Value) {
    send(app, "game:running", list);
    schedule_pause(app);
    // A game that uses the real controller started or ended.
    if setting(app, "controllerPassthrough") == true {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            crate::controller::apply_passthrough(&app, false).await;
        });
    }
}

/// Monitor hook: a game ended after `minutes`.
pub fn on_ended(app: &AppHandle, id: &str, minutes: i64) {
    if minutes > 0 {
        library::add_playtime(app, id, minutes);
    }
    send(app, "game:exited", json!({ "id": id, "minutes": minutes, "shortLived": minutes < 1 }));
    let overlay = launcher_state(app).games.overlay_visible.load(Ordering::SeqCst);
    let was_in_launcher = launcher_front(app) && !overlay;
    let restore = setting(app, "restoreOnExit") == true && !was_in_launcher;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if overlay {
            crate::overlay::hide_now(&app, false).await;
        }
        if restore {
            show_launcher(&app, Some(json!({ "view": "home" }))).await;
        }
    });
}

/* ---------------------------------------------------------------- */
/* Launching                                                         */
/* ---------------------------------------------------------------- */

pub async fn continue_game(app: &AppHandle, id: &str) -> Value {
    let l = launcher_state(app);
    let Some(r) = l.monitor.get(id) else { return json!({ "continued": false }) };
    resume_now(app).await;
    if crate::overlay::visible(app) {
        crate::overlay::hide_now(app, false).await;
    }
    let ok = l.system.request("focusProc", json!({ "pid": r.pid }), 4000).await.ok().and_then(|v| v.as_bool()).unwrap_or(false);
    if ok && setting(app, "onLaunch") == "minimize" {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            if let Some(w) = main_window(&app) {
                if !main_focused(&app) {
                    let _ = w.minimize();
                }
            }
        });
    }
    json!({ "continued": ok })
}

pub async fn launch(app: &AppHandle, id: &str) -> Result<Value, String> {
    let l = launcher_state(app);
    if library::find(app, id).is_none() {
        return Err("Game not found".into());
    }
    // Already running: bring it back instead of starting a second copy.
    if l.monitor.get(id).is_some() {
        return Ok(continue_game(app, id).await);
    }
    l.monitor.note_launch(id);
    library::note_launch(app, id);
    let g = library::find(app, id).unwrap_or(Value::Null);
    let prefer_direct = setting(app, "preferDirect") == true;
    let result = launcher::launch_game(app, &l.system, &g, prefer_direct).await?;
    library::save(app); // a direct start may have remembered the game's executable
    monitor::poke(app, 300);
    let app2 = app.clone();
    let id2 = id.to_string();
    when_game_shows(app, id, move || {
        send(&app2, "game:started", json!({ "id": id2 }));
        let Some(win) = main_window(&app2) else { return };
        match setting(&app2, "onLaunch").as_str() {
            Some("minimize") => {
                let _ = win.minimize();
            }
            Some("close") => app2.exit(0),
            _ => {}
        }
    });
    Ok(result)
}

/* Minimizing (or quitting) waits until the game is actually on screen, so
   the launcher never drops to the desktop while a game is still loading.
   Multiplayer games often show a small anti-cheat window first (Easy
   Anti-Cheat, EA Javelin, BattlEye); those don't count. A game window
   counts once it covers a good part of its screen, or has been up at a
   normal size for a while. Meanwhile the launcher's Starting… screen stays
   on top, so the anti-cheat splash opens behind it and is never seen. */
static BOOTSTRAP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)easyanticheat|^eac|eac_|_eac|start_protected_game|eaanticheat|anticheat|battleye|_be$|^be(service|_)|gamelaunchhelper|crashreport|splash").unwrap()
});

fn set_cover(app: &AppHandle, on: bool) {
    let l = launcher_state(app);
    let Some(win) = main_window(app) else { return };
    if l.games.cover_on.swap(on, Ordering::SeqCst) == on {
        return;
    }
    if on {
        if !win.is_visible().unwrap_or(false) || win.is_minimized().unwrap_or(false) {
            return;
        }
        let _ = win.set_always_on_top(true);
    } else {
        let _ = win.set_always_on_top(false);
    }
}

pub fn stop_watch(app: &AppHandle) {
    launcher_state(app).games.launch_watch.fetch_add(1, Ordering::SeqCst);
    set_cover(app, false);
}

fn num(v: &Value, k: &str) -> f64 {
    v[k].as_f64().unwrap_or(0.0)
}

fn when_game_shows(app: &AppHandle, id: &str, then: impl FnOnce() + Send + 'static) {
    let l = launcher_state(app);
    let token = l.games.launch_watch.fetch_add(1, Ordering::SeqCst) + 1;
    let g = library::find(app, id).unwrap_or(Value::Null);
    let exe = g["exe"].as_str().filter(|e| !e.is_empty()).map(str::to_string).or_else(|| (g["launch"]["type"] == "exe").then(|| g["launch"]["target"].as_str().unwrap_or("").to_string()));
    let mut dirs: Vec<String> = std::iter::once(g["installDir"].clone())
        .chain(g["altDirs"].as_array().cloned().unwrap_or_default())
        .filter_map(|d| d.as_str().filter(|s| !s.is_empty()).map(str::to_string))
        .collect();
    if dirs.is_empty() {
        if let Some(e) = exe.filter(|e| !e.is_empty()) {
            dirs.push(crate::util::dirname(&e));
        }
    }
    set_cover(app, true);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let l = launcher_state(&app);
        let current = || l.games.launch_watch.load(Ordering::SeqCst) == token;
        let t0 = now_ms();
        let mut first_seen: HashMap<i64, i64> = HashMap::new();
        let (mut big_since, mut foreign_since, mut away_since) = (0i64, 0i64, 0i64);
        let mut then = Some(then);
        tokio::time::sleep(Duration::from_millis(600)).await;
        loop {
            let Some(win) = main_window(&app) else { return };
            if !current() {
                return;
            }
            let now = now_ms();
            if now - t0 > 180_000 {
                // Never showed up: leave the launcher alone.
                stop_watch(&app);
                send(&app, "game:started", json!({ "id": g["id"], "gaveUp": true }));
                return;
            }
            if now - t0 > 90_000 {
                set_cover(&app, false);
            }
            let focused = main_focused(&app) && !win.is_minimized().unwrap_or(false);
            away_since = if focused { 0 } else if away_since == 0 { now } else { away_since };
            let fg = l.system.foreground().await;
            let mut game: Option<Value> = None;
            if !dirs.is_empty() {
                let wins = l.system.request("dirWindows", json!({ "dirs": dirs }), 4000).await.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
                let real: Vec<Value> = wins.into_iter().filter(|w| !BOOTSTRAP.is_match(w["name"].as_str().unwrap_or("")) && num(w, "w") >= 320.0 && num(w, "h") >= 200.0).collect();
                for w in &real {
                    first_seen.entry(w["hwnd"].as_i64().unwrap_or(0)).or_insert(now);
                }
                let big = real
                    .iter()
                    .find(|w| {
                        let mw = if num(w, "mw") > 0.0 { num(w, "mw") } else { 1920.0 };
                        let mh = if num(w, "mh") > 0.0 { num(w, "mh") } else { 1080.0 };
                        num(w, "w") * num(w, "h") >= 0.35 * mw * mh
                    })
                    .cloned();
                big_since = if big.is_some() { if big_since == 0 { now } else { big_since } } else { 0 };
                // A big window that stays for a moment, or a normal-sized one that stays a while (windowed games).
                game = if big.is_some() && now - big_since >= 900 {
                    big
                } else {
                    real.iter()
                        .find(|w| now - first_seen.get(&w["hwnd"].as_i64().unwrap_or(0)).copied().unwrap_or(now) >= 8000 && num(w, "w") >= 640.0 && num(w, "h") >= 360.0)
                        .cloned()
                };
                // Something outside the game is asking for attention (a store
                // sign-in, an update, an anti-cheat error): stop covering it.
                let ours = fg.as_ref().is_some_and(|f| f["hwnd"].as_i64() == Some(hwnd_of(&win) as i64));
                let foreign = fg.as_ref().is_some_and(|f| !ours && game.is_none() && !BOOTSTRAP.is_match(f["name"].as_str().unwrap_or("")) && num(f, "w") >= 300.0 && num(f, "h") >= 200.0);
                foreign_since = if foreign { if foreign_since == 0 { now } else { foreign_since } } else { 0 };
                if foreign_since != 0 && now - foreign_since > 3000 {
                    set_cover(&app, false);
                }
            } else if away_since != 0 && now - away_since > 5000 {
                // Nothing to look for (some store apps): something else has been
                // in front for a while, so that is the game.
                stop_watch(&app);
                if let Some(f) = then.take() {
                    f();
                }
                return;
            }
            if !current() {
                return;
            }
            if let Some(w) = game {
                stop_watch(&app);
                l.system.focus_window(w["hwnd"].as_i64().unwrap_or(0) as isize).await;
                if let Some(f) = then.take() {
                    f();
                }
                return;
            }
            monitor::poke(&app, 0);
            tokio::time::sleep(Duration::from_millis(450)).await;
        }
    });
}

pub async fn close(app: &AppHandle, id: &str, from_overlay: bool) -> bool {
    let l = launcher_state(app);
    *l.games.closing_pid.lock().unwrap() = l.monitor.get(id).map(|r| r.pid);
    if l.games.paused_pid.lock().unwrap().is_some() {
        resume_now(app).await;
    }
    if from_overlay {
        // Put the home screen up in front of the game first and close the game
        // behind it, so the desktop never shows in between.
        show_launcher(app, Some(json!({ "view": "home" }))).await;
        tokio::time::sleep(Duration::from_millis(350)).await;
        crate::overlay::hide_now(app, false).await;
    }
    let pid = *l.games.closing_pid.lock().unwrap();
    let r = monitor::close(app, id).await;
    // Some games take a while to shut down after the close request (saving,
    // a quit prompt). Never pause them meanwhile: keep the guard until the
    // process is gone (at most 30 s).
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        for _ in 0..60 {
            if launcher_state(&app).monitor.get(&id).is_none_or(|r| Some(r.pid) != pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let l = launcher_state(&app);
        let mut closing = l.games.closing_pid.lock().unwrap();
        if *closing == pid {
            *closing = None;
        }
    });
    r
}
