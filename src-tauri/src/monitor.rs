//! Detects which library game is running, however it was started (launcher,
//! Steam, Epic, a desktop shortcut…) (port of main/gamemonitor.js). Works from
//! the system process list: process names first, then the full image path of
//! the few candidates, both read through the helper without opening a handle
//! to any game process.
//!
//! Several library entries can share one executable (e.g. Switch games that
//! all start the same emulator). A process is only ever counted for ONE game,
//! chosen by: the game the launcher just started, then the window title (the
//! emulator shows the game name), then the most recently played candidate.

use crate::scanner::EXE_SKIP;
use crate::system::SystemBridge;
use crate::util::{dirname, normalize, now_ms, stem};
use crate::{library, Launcher};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager};

const TICK_MS: u64 = 3000;
// Matched against folder names and program files only (.exe/.dll/.sys), never
// art or data files - a skin called "Vanguard" is not Riot Vanguard.
static ANTI_CHEAT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)easy.?anti.?cheat|battl.?eye|^beservice|anti.?cheat|xigncode|nprotect|gameguard|punkbuster|pnkbstr|^equ8|faceit|mhyprot|acebase|sguard|^vgk|riot.?vanguard").unwrap()
});
static SKIP_DIRS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(redist|_commonredist|directx|__installer|support|\.git)$").unwrap());

fn anti_cheat_name(name: &str, is_dir: bool) -> bool {
    let program = matches!(crate::util::extname(name).as_str(), ".exe" | ".dll" | ".sys");
    (is_dir || program) && ANTI_CHEAT.is_match(name)
}

fn norm_words(s: &str) -> String {
    let lower = s.to_lowercase().replace(['™', '®', '©'], "");
    let cleaned: String = lower.chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { ' ' }).collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// How well a window title matches a game name (0..1).
pub fn title_score(title: &str, name: &str) -> f64 {
    let t = format!(" {} ", norm_words(title));
    let normalized = norm_words(name);
    let words: Vec<&str> = normalized.split(' ').filter(|w| w.len() > 1 || w.chars().any(|c| c.is_ascii_digit())).collect();
    if words.is_empty() {
        return 0.0;
    }
    if t.contains(&format!(" {} ", words.join(" "))) {
        return 1.0;
    }
    let hit = words.iter().filter(|w| t.contains(&format!(" {w} "))).count();
    hit as f64 / words.len() as f64
}

#[derive(Clone)]
struct Entry {
    names: HashSet<String>,
    dir: Option<String>,
    alt: Vec<String>,
    exe: Option<String>,
    sig: String,
    anti_cheat: bool,
}

#[derive(Clone, Copy)]
pub struct Running {
    pub pid: u32,
    pub since: i64,
}

#[derive(Default)]
struct State {
    index: HashMap<String, Entry>,
    pid_paths: HashMap<u32, String>,
    pid_seen: HashMap<u32, i64>,
    running: Vec<(String, Running)>,
    launches: HashMap<String, i64>,
}

type OnChange = Box<dyn Fn(&AppHandle, Value) + Send + Sync>;
type OnEnded = Box<dyn Fn(&AppHandle, &str, i64) + Send + Sync>;

/// Callbacks into main: running list changed / a game ended (id, minutes).
pub struct Hooks {
    pub on_change: OnChange,
    pub on_ended: OnEnded,
}

pub struct GameMonitor {
    state: Mutex<State>,
    ticking: tokio::sync::Mutex<()>,
    hooks: Hooks,
}

/// Exe names in a game folder (files before sub-folders) + anti-cheat check.
fn scan_dir(dir: &str) -> (HashSet<String>, bool) {
    let mut names = HashSet::new();
    let mut anti_cheat = false;
    let mut budget: i64 = 6000;
    let mut queue = VecDeque::from([(dir.to_string(), 0u32)]);
    while let Some((d, depth)) = queue.pop_front() {
        if budget <= 0 {
            break;
        }
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            budget -= 1;
            if budget < 0 {
                break;
            }
            let Ok(name) = e.file_name().into_string() else { continue };
            let Ok(ft) = e.file_type() else { continue };
            if anti_cheat_name(&name, ft.is_dir()) {
                anti_cheat = true;
            }
            if ft.is_file() && name.to_lowercase().ends_with(".exe") && !EXE_SKIP.is_match(&name) {
                names.insert(name[..name.len() - 4].to_lowercase());
            } else if ft.is_dir() && depth < 4 && !SKIP_DIRS.is_match(&name) {
                queue.push_back((crate::util::join(&[&d, &name]), depth + 1));
            }
        }
    }
    // Anti-cheat often lives next to the binaries folder: also peek at parents.
    let mut p = dir.to_string();
    for _ in 0..3 {
        if anti_cheat {
            break;
        }
        let up = dirname(&p);
        if up == p {
            break;
        }
        p = up;
        if let Ok(rd) = fs::read_dir(&p) {
            if rd.flatten().any(|e| e.file_name().into_string().is_ok_and(|n| anti_cheat_name(&n, e.file_type().is_ok_and(|t| t.is_dir())))) {
                anti_cheat = true;
            }
        }
    }
    (names, anti_cheat)
}

fn with_sep(p: &str) -> String {
    let n = normalize(p).to_lowercase();
    if n.ends_with('\\') {
        n
    } else {
        n + "\\"
    }
}

fn index_for(g: &Value, cached: Option<&Entry>) -> Entry {
    let launch = &g["launch"];
    let exe = g["exe"]
        .as_str()
        .filter(|e| !e.is_empty())
        .map(str::to_string)
        .or_else(|| (launch["type"] == "exe").then(|| launch["target"].as_str().unwrap_or("").to_string()).filter(|e| !e.is_empty()));
    // Shortcut games: the exe's folder is the install folder (catches games
    // that start through a small launcher exe in the same folder).
    let dir = g["installDir"].as_str().filter(|d| !d.is_empty()).map(str::to_string).or_else(|| exe.as_deref().map(dirname));
    let alt: Vec<String> = g["altDirs"].as_array().map(|a| a.iter().filter_map(|d| d.as_str()).map(with_sep).collect()).unwrap_or_default();
    let sig = format!("{}|{}|{}", exe.as_deref().unwrap_or("null"), dir.as_deref().unwrap_or("null"), alt.join("|"));
    if let Some(c) = cached.filter(|c| c.sig == sig) {
        return c.clone();
    }
    let (mut names, anti_cheat) = match &dir {
        Some(d) => scan_dir(d),
        None => (HashSet::new(), true),
    };
    if let Some(e) = exe.as_deref().filter(|e| e.to_lowercase().ends_with(".exe")) {
        names.insert(stem(e).to_lowercase());
    }
    Entry {
        names,
        dir: dir.as_deref().map(with_sep),
        alt,
        exe: exe.as_deref().map(|e| normalize(e).to_lowercase()),
        sig,
        anti_cheat,
    }
}

fn matches(entry: &Entry, image: &str) -> bool {
    if image.is_empty() {
        return false;
    }
    entry.exe.as_deref() == Some(image) || entry.dir.as_deref().is_some_and(|d| image.starts_with(d)) || entry.alt.iter().any(|d| image.starts_with(d.as_str()))
}

impl GameMonitor {
    pub fn new(hooks: Hooks) -> Self {
        Self { state: Mutex::new(State::default()), ticking: tokio::sync::Mutex::new(()), hooks }
    }

    pub fn start(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            loop {
                tick(&app).await;
                tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
            }
        });
    }

    pub fn list(&self) -> Value {
        let st = self.state.lock().unwrap();
        Value::Array(st.running.iter().map(|(id, r)| json!({ "id": id, "pid": r.pid, "since": r.since })).collect())
    }

    pub fn get(&self, id: &str) -> Option<Running> {
        self.state.lock().unwrap().running.iter().find(|(i, _)| i == id).map(|(_, r)| *r)
    }

    /// Most recently started running game.
    pub fn current(&self) -> Option<(String, Running)> {
        self.state.lock().unwrap().running.iter().max_by_key(|(_, r)| r.since).cloned()
    }

    /// The launcher is starting this game: it wins any "which game is it?" question.
    pub fn note_launch(&self, id: &str) {
        self.state.lock().unwrap().launches.insert(id.to_string(), now_ms());
    }

    /// Unknown games count as having anti-cheat (never paused).
    pub fn has_anti_cheat(&self, id: &str) -> bool {
        self.state.lock().unwrap().index.get(id).is_none_or(|e| e.anti_cheat)
    }
}

fn monitor(app: &AppHandle) -> &GameMonitor {
    &app.state::<Launcher>().inner().monitor
}

fn system(app: &AppHandle) -> Arc<SystemBridge> {
    app.state::<Launcher>().system.clone()
}

/// Make the next tick come sooner (e.g. right after a launch).
pub fn poke(app: &AppHandle, delay_ms: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        tick(&app).await;
    });
}

async fn path_of(app: &AppHandle, pid: u32) -> String {
    if let Some(p) = monitor(app).state.lock().unwrap().pid_paths.get(&pid) {
        return p.clone();
    }
    let p = system(app).request("procPath", json!({ "pid": pid }), 4000).await.ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
    let p = if p.is_empty() { String::new() } else { normalize(&p).to_lowercase() };
    monitor(app).state.lock().unwrap().pid_paths.insert(pid, p.clone());
    p
}

/// Pick one game for a process that several library entries could be.
async fn resolve(app: &AppHandle, pid: u32, ids: &[String]) -> Option<String> {
    if ids.len() == 1 {
        return Some(ids[0].clone());
    }
    let (first_seen, launches) = {
        let st = monitor(app).state.lock().unwrap();
        (st.pid_seen.get(&pid).copied().unwrap_or_else(now_ms), st.launches.clone())
    };
    // 1. Started from the launcher shortly before the process appeared.
    let mut best: Option<&String> = None;
    for id in ids {
        if let Some(&t) = launches.get(id) {
            if t >= first_seen - 120_000 && best.is_none_or(|b| t > launches[b]) {
                best = Some(id);
            }
        }
    }
    if let Some(b) = best {
        return Some(b.clone());
    }
    // 2. The window title names the game (emulators do this).
    let titles: Vec<String> = system(app)
        .request("windowTitles", json!({ "pid": pid }), 3000)
        .await
        .ok()
        .and_then(|v| v.as_array().map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect()))
        .unwrap_or_default();
    let mut top: Option<String> = None;
    let mut top_score = 0.0;
    for id in ids {
        let Some(g) = library::find(app, id) else { continue };
        let name = g["name"].as_str().unwrap_or("");
        let score = titles.iter().map(|t| title_score(t, name)).fold(0.0, f64::max);
        if score > top_score {
            top_score = score;
            top = Some(id.clone());
        }
    }
    if top.is_some() && top_score >= 0.6 {
        return top;
    }
    // 3. Still ambiguous after a while: the most recently played candidate.
    if now_ms() - first_seen > 20_000 {
        let mut games: Vec<Value> = ids.iter().filter_map(|id| library::find(app, id)).collect();
        games.sort_by_key(|g| -g["lastPlayed"].as_i64().unwrap_or(0));
        return games.first().and_then(|g| g["id"].as_str().map(str::to_string));
    }
    None
}

pub async fn tick(app: &AppHandle) {
    let m = monitor(app);
    let Ok(_guard) = m.ticking.try_lock() else { return };
    let sys = system(app);
    if !sys.available() {
        return;
    }
    let Ok(procs) = sys.request("procs", json!({}), 8000).await else { return }; // helper not ready yet
    let procs: Vec<(u32, String)> = procs
        .as_array()
        .map(|a| a.iter().filter_map(|p| Some((p["pid"].as_u64()? as u32, p["name"].as_str()?.to_lowercase()))).collect())
        .unwrap_or_default();
    let mut by_name: HashMap<&str, Vec<u32>> = HashMap::new();
    for (pid, name) in &procs {
        by_name.entry(name.as_str()).or_default().push(*pid);
    }
    let alive: HashSet<u32> = procs.iter().map(|(p, _)| *p).collect();
    let games = library::games(app);
    let known: HashSet<&str> = games.iter().filter_map(|g| g["id"].as_str()).collect();

    let (mut found, mut taken, cached_index) = {
        let mut st = m.state.lock().unwrap();
        st.pid_paths.retain(|p, _| alive.contains(p));
        st.pid_seen.retain(|p, _| alive.contains(p));
        // Keep following games we already know (one process = one game).
        let found: Vec<(String, Running)> = st.running.iter().filter(|(id, r)| alive.contains(&r.pid) && known.contains(id.as_str())).cloned().collect();
        let taken: HashSet<u32> = found.iter().map(|(_, r)| r.pid).collect();
        (found, taken, st.index.clone())
    };

    // Index the library (folder scans run on a blocking thread, cached by signature).
    let to_index: Vec<Value> = games.iter().filter(|g| g["category"] != "media").cloned().collect();
    let index = tauri::async_runtime::spawn_blocking(move || {
        to_index
            .iter()
            .map(|g| {
                let id = g["id"].as_str().unwrap_or("").to_string();
                let e = index_for(g, cached_index.get(&id));
                (id, e)
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    {
        let mut st = m.state.lock().unwrap();
        for (id, e) in &index {
            st.index.insert(id.clone(), e.clone());
        }
    }

    // Collect candidate games for each new process.
    let mut candidates: Vec<(u32, Vec<String>)> = Vec::new();
    for (id, entry) in &index {
        if found.iter().any(|(f, _)| f == id) || entry.names.is_empty() {
            continue;
        }
        for name in &entry.names {
            // Process names come without ".exe", like the index.
            for pid in by_name.get(name.as_str()).cloned().unwrap_or_default() {
                if taken.contains(&pid) || !matches(entry, &path_of(app, pid).await) {
                    continue;
                }
                m.state.lock().unwrap().pid_seen.entry(pid).or_insert_with(now_ms);
                match candidates.iter_mut().find(|(p, _)| *p == pid) {
                    Some((_, ids)) if !ids.contains(id) => ids.push(id.clone()),
                    Some(_) => {}
                    None => candidates.push((pid, vec![id.clone()])),
                }
            }
        }
    }
    for (pid, ids) in candidates {
        let open: Vec<String> = ids.into_iter().filter(|id| !found.iter().any(|(f, _)| f == id)).collect();
        if open.is_empty() || taken.contains(&pid) {
            continue;
        }
        let Some(id) = resolve(app, pid, &open).await else { continue };
        let since = m.state.lock().unwrap().pid_seen.get(&pid).copied().unwrap_or_else(now_ms);
        found.push((id.clone(), Running { pid, since }));
        taken.insert(pid);
        m.state.lock().unwrap().launches.remove(&id);
    }

    let (ended, changed) = {
        let mut st = m.state.lock().unwrap();
        let ended: Vec<(String, i64)> = st
            .running
            .iter()
            .filter(|(id, _)| !found.iter().any(|(f, _)| f == id))
            .map(|(id, r)| (id.clone(), ((now_ms() - r.since) as f64 / 60000.0).round() as i64))
            .collect();
        let added = found.iter().any(|(id, _)| !st.running.iter().any(|(r, _)| r == id));
        st.running = found;
        (ended.clone(), !ended.is_empty() || added)
    };
    for (id, minutes) in ended {
        (m.hooks.on_ended)(app, &id, minutes);
    }
    if changed {
        (m.hooks.on_change)(app, m.list());
    }
}

/// Close a running game: ask its windows to close, then end the process.
pub async fn close(app: &AppHandle, id: &str) -> bool {
    let Some(r) = monitor(app).get(id) else {
        #[cfg(debug_assertions)]
        eprintln!("[close] {id}: not running");
        return false;
    };
    let sys = system(app);
    let t0 = std::time::Instant::now();
    // A paused game can't react to the close request.
    let _resumed = sys.request("resume", json!({ "pid": r.pid }), 8000).await;
    let _asked = sys.request("closeWindows", json!({ "pid": r.pid }), 8000).await;
    #[cfg(debug_assertions)]
    eprintln!("[close] {id} pid {}: resume {:?}, closeWindows {:?}", r.pid, _resumed, _asked);
    let gone = || async {
        sys.request("procs", json!({}), 8000)
            .await
            .ok()
            .and_then(|v| v.as_array().map(|a| !a.iter().any(|p| p["pid"].as_u64() == Some(r.pid as u64))))
            .unwrap_or(false)
    };
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if gone().await {
            break;
        }
    }
    if !gone().await {
        let pid = r.pid.to_string();
        let _killed = tauri::async_runtime::spawn_blocking(move || {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("taskkill").args(["/PID", &pid, "/T", "/F"]).creation_flags(0x0800_0000).output()
        })
        .await;
        #[cfg(debug_assertions)]
        if let Ok(Ok(o)) = &_killed {
            eprintln!("[close] {id}: still running after {:?}, taskkill {} {}", t0.elapsed(), o.status, String::from_utf8_lossy(&o.stderr).trim());
        }
    } else {
        #[cfg(debug_assertions)]
        eprintln!("[close] {id}: closed after {:?}", t0.elapsed());
    }
    tick(app).await;
    true
}
