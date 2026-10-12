//! Bridge to syshelper.exe (port of main/system.js): media sessions, volume,
//! playback devices, brightness, Bluetooth, processes, windows and the
//! controller. The helper is a long-running child process that speaks one
//! JSON object per line over stdin/stdout. It exits by itself (resuming any
//! paused game first) as soon as its stdin closes, so the launcher dying
//! never leaves a game suspended.

use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::oneshot;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;
type Coalesce = Mutex<HashMap<String, (u64, Arc<tokio::sync::Mutex<()>>)>>;
pub type EventHandler = Arc<dyn Fn(&str, Value) + Send + Sync>;

struct Proc {
    child: Child,
    stdin: ChildStdin,
}

pub struct SystemBridge {
    exe: PathBuf,
    proc: Mutex<Option<Proc>>,
    pending: Pending,
    next_id: AtomicU64,
    failures: Arc<AtomicUsize>,
    on_event: Mutex<Option<EventHandler>>,
    /// Re-sent when the helper (re)starts.
    pub forward: AtomicBool,
    pub keep_forward: AtomicBool,
    pub passthrough_args: Mutex<Option<Value>>,
    /// Coalesced setters: name -> newest request number.
    coalesce: Coalesce,
    art: Mutex<(Option<String>, Option<Value>)>,
}

impl SystemBridge {
    pub fn new(exe: PathBuf) -> Self {
        Self {
            exe,
            proc: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            failures: Arc::new(AtomicUsize::new(0)),
            on_event: Mutex::new(None),
            forward: AtomicBool::new(false),
            keep_forward: AtomicBool::new(false),
            passthrough_args: Mutex::new(None),
            coalesce: Mutex::new(HashMap::new()),
            art: Mutex::new((None, None)),
        }
    }

    pub fn available(&self) -> bool {
        self.exe.exists()
    }

    /// Unsolicited helper events ({ event: 'guide' }, { event: 'pad', action }…).
    pub fn set_event_handler(&self, f: EventHandler) {
        *self.on_event.lock().unwrap() = Some(f);
    }

    pub fn start(self: &Arc<Self>) {
        let mut guard = self.proc.lock().unwrap();
        if guard.is_some() || !self.available() {
            return;
        }
        let Ok(mut child) = Command::new(&self.exe)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
        else {
            self.failures.fetch_add(1, Ordering::SeqCst);
            return;
        };
        let stdout = child.stdout.take().unwrap();
        let stdin = child.stdin.take().unwrap();
        *guard = Some(Proc { child, stdin });
        drop(guard);

        let me = self.clone();
        std::thread::Builder::new()
            .name("syshelper-out".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                    if let Some(event) = msg.get("event").and_then(|e| e.as_str()) {
                        let handler = me.on_event.lock().unwrap().clone();
                        if let Some(h) = handler {
                            h(event, msg.clone());
                        }
                        continue;
                    }
                    let Some(id) = msg.get("id").and_then(|i| i.as_u64()) else { continue };
                    if let Some(tx) = me.pending.lock().unwrap().remove(&id) {
                        let r = if msg["ok"] == true {
                            Ok(msg.get("data").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(msg["error"].as_str().unwrap_or("helper error").to_string())
                        };
                        let _ = tx.send(r);
                    }
                }
                // The helper exited.
                *me.proc.lock().unwrap() = None;
                for (_, tx) in me.pending.lock().unwrap().drain() {
                    let _ = tx.send(Err("helper exited".into()));
                }
                me.failures.fetch_add(1, Ordering::SeqCst);
            })
            .ok();

        // Settings the helper keeps in memory.
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            if me.forward.load(Ordering::SeqCst) || me.keep_forward.load(Ordering::SeqCst) {
                me.set_pad_forward(me.forward.load(Ordering::SeqCst)).await;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
            let pt = me.passthrough_args.lock().unwrap().clone();
            if let Some(args) = pt {
                let _ = me.request("passthrough", args, 15000).await;
            }
        });
    }

    pub async fn request(self: &Arc<Self>, cmd: &str, args: Value, timeout_ms: u64) -> Result<Value, String> {
        if !self.available() {
            return Err("System helper is not available".into());
        }
        if self.proc.lock().unwrap().is_none() {
            if self.failures.load(Ordering::SeqCst) > 5 {
                return Err("System helper keeps crashing".into());
            }
            self.start();
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        // id last: an argument must never overwrite the request id.
        let mut msg: Map<String, Value> = args.as_object().cloned().unwrap_or_default();
        msg.insert("id".into(), json!(id));
        msg.insert("cmd".into(), json!(cmd));
        let line = format!("{}\n", Value::Object(msg));
        let written = {
            let mut guard = self.proc.lock().unwrap();
            match guard.as_mut() {
                Some(p) => p.stdin.write_all(line.as_bytes()).and_then(|_| p.stdin.flush()).map_err(|e| e.to_string()),
                None => Err("System helper is not running".into()),
            }
        };
        if let Err(e) = written {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("helper exited".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("{cmd} timed out"))
            }
        }
    }

    /// Run setters one at a time and only send the newest value (sliders fire
    /// a lot); calls overtaken by a newer one return null without being sent.
    async fn coalesced(self: &Arc<Self>, name: &str, cmd: &str, args: Value, timeout_ms: u64) -> Result<Value, String> {
        let (n, lock) = {
            let mut map = self.coalesce.lock().unwrap();
            let e = map.entry(name.to_string()).or_insert_with(|| (0, Arc::new(tokio::sync::Mutex::new(()))));
            e.0 += 1;
            (e.0, e.1.clone())
        };
        let _turn = lock.lock().await;
        if self.coalesce.lock().unwrap().get(name).map(|e| e.0) != Some(n) {
            return Ok(Value::Null);
        }
        self.request(cmd, args, timeout_ms).await
    }

    /* ---------------------------------------------------------------- */

    /// Now playing, with cover art only when it changed (knownKey).
    pub async fn media(self: &Arc<Self>, app: &str, known_key: &str) -> Result<Value, String> {
        let mut state = self.request("media", json!({ "app": app }), 8000).await?;
        if state["active"] != true {
            return Ok(if state.is_null() { json!({ "active": false, "sessions": [] }) } else { state });
        }
        let art_key = format!("{}|{}", state["app"].as_str().unwrap_or(""), state["key"].as_str().unwrap_or(""));
        let cached = self.art.lock().unwrap().0.clone();
        if cached.as_deref() != Some(art_key.as_str()) {
            let data = self
                .request("media", json!({ "app": state["app"], "art": true }), 8000)
                .await
                .ok()
                .and_then(|w| w.get("art").cloned())
                .filter(|a| !a.is_null());
            *self.art.lock().unwrap() = (Some(art_key.clone()), data);
        }
        let art = self.art.lock().unwrap().1.clone();
        state["artKey"] = if art.is_some() { json!(art_key) } else { Value::Null };
        if known_key != art_key {
            if let Some(a) = art {
                state["art"] = a;
            }
        }
        Ok(state)
    }

    pub async fn set_volume(self: &Arc<Self>, v: f64) -> Result<Value, String> {
        self.coalesced("volume", "setVolume", json!({ "value": v.round() as i64 }), 8000).await
    }

    pub async fn set_brightness(self: &Arc<Self>, v: f64, index: i64) -> Result<Value, String> {
        self.coalesced(&format!("brightness:{index}"), "setBrightness", json!({ "value": v.round() as i64, "index": index }), 15000).await
    }

    pub async fn set_pad_forward(self: &Arc<Self>, on: bool) {
        self.forward.store(on, Ordering::SeqCst);
        let value = on || self.keep_forward.load(Ordering::SeqCst);
        let _ = self.request("padForward", json!({ "value": value }), 8000).await;
    }

    pub async fn foreground(self: &Arc<Self>) -> Option<Value> {
        self.request("fgGet", json!({}), 3000).await.ok().filter(|v| !v.is_null())
    }

    pub async fn focus_window(self: &Arc<Self>, hwnd: isize) -> bool {
        if hwnd == 0 {
            return false;
        }
        self.request("fgSet", json!({ "hwnd": hwnd }), 3000).await.ok().and_then(|v| v.as_bool()).unwrap_or(false)
    }

    /// Closing stdin makes the helper resume any paused game and exit by itself.
    pub fn stop(&self) {
        if let Some(mut p) = self.proc.lock().unwrap().take() {
            drop(p.stdin);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                let _ = p.child.kill();
            });
        }
    }
}

/// Where syshelper.exe is: next to the sources while developing, installed
/// next to the launcher (a bundled resource) in release builds.
pub fn helper_path() -> PathBuf {
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("main").join("native").join("syshelper.exe")
    } else {
        std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("syshelper.exe"))).unwrap_or_default()
    }
}
