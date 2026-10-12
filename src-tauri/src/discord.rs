//! Discord voice control and messages over Discord's local RPC pipe
//! (\\.\pipe\discord-ipc-N) - port of main/discord.js.
//!
//! Voice control needs the `rpc` OAuth scopes, which Discord only grants to an
//! application's own developers. So the user creates an application in the
//! Discord Developer Portal and enters its Application ID + Client Secret
//! once; Discord then shows an "Authorize" prompt and we keep the token
//! (protected with DPAPI, see secure.rs).
//!
//! Messages: with rpc.notifications.read Discord reports every notification
//! (DMs, mentions); with messages.read the launcher can load a channel's
//! recent messages and follow new ones. Discord's local RPC has no way to send
//! messages, so replying opens the conversation in Discord itself.

use crate::secure;
use crate::util::{now_ms, send};
use crate::Launcher;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, WriteHalf},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
    sync::oneshot,
};

const OP_HANDSHAKE: i32 = 0;
const OP_FRAME: i32 = 1;
const OP_CLOSE: i32 = 2;
const OP_PING: i32 = 3;
const OP_PONG: i32 = 4;
const SCOPES: [&str; 5] = ["rpc", "rpc.voice.read", "rpc.voice.write", "rpc.notifications.read", "messages.read"];
const MESSAGE_SCOPES: [&str; 2] = ["rpc.notifications.read", "messages.read"];
const REDIRECT_URI: &str = "http://localhost";
const TOKEN_URL: &str = "https://discord.com/api/oauth2/token";

type Reply = Result<Value, String>;

pub struct Discord {
    file: PathBuf,
    creds: Mutex<Value>,
    state: Mutex<Value>,
    writer: tokio::sync::Mutex<Option<WriteHalf<NamedPipeClient>>>,
    reader: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
    ready: Mutex<Option<oneshot::Sender<Reply>>>,
    conn_gen: AtomicU64,
    connecting: tokio::sync::Mutex<()>,
    retry_gen: AtomicU64,
    push_gen: AtomicU64,
    channel_subs: Mutex<Option<String>>,
    chat_channel: Mutex<Option<String>>,
    nonce: AtomicU64,
}

struct AuthError {
    message: String,
    needs_auth: bool,
}

fn auth_err(message: impl Into<String>) -> AuthError {
    AuthError { message: message.into(), needs_auth: true }
}

fn discord(app: &AppHandle) -> &Discord {
    &app.state::<Launcher>().inner().discord
}

impl Discord {
    pub fn new(file: PathBuf) -> Self {
        let creds: Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).filter(|v: &Value| v.is_object()).unwrap_or_else(|| json!({}));
        let configured = has(&creds, "clientId") && !creds["secret"].is_null();
        let state = json!({
            "configured": configured,
            "clientId": creds["clientId"].as_str().unwrap_or(""),
            "authorized": !creds["access"].is_null(),
            "status": if configured { "idle" } else { "setup" }, // idle | setup | connecting | offline | authorizing | needs-auth | ready | error
            "error": null,
            "user": null,
            "voice": null,        // { mute, deaf, input, output }
            "messages": false,    // Discord allowed message notifications / reading
            "conversations": [],  // recent conversations seen this session
            "channel": null,      // { id, name, guild }
            "members": [],        // [{ id, name, avatar, mute, deaf, speaking, volume, self }]
        });
        Self {
            file,
            creds: Mutex::new(creds),
            state: Mutex::new(state),
            writer: tokio::sync::Mutex::new(None),
            reader: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            ready: Mutex::new(None),
            conn_gen: AtomicU64::new(0),
            connecting: tokio::sync::Mutex::new(()),
            retry_gen: AtomicU64::new(0),
            push_gen: AtomicU64::new(0),
            channel_subs: Mutex::new(None),
            chat_channel: Mutex::new(None),
            nonce: AtomicU64::new(0),
        }
    }

    fn save_creds(&self) {
        let text = serde_json::to_string_pretty(&*self.creds.lock().unwrap()).unwrap_or_default();
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(e) = std::fs::write(&self.file, text) {
            eprintln!("[discord] failed to save credentials {e}");
        }
    }

    pub fn public_state(&self) -> Value {
        self.state.lock().unwrap().clone()
    }

    fn set(&self, f: impl FnOnce(&mut Map<String, Value>)) {
        if let Some(m) = self.state.lock().unwrap().as_object_mut() {
            f(m);
        }
    }

    fn status(&self) -> String {
        self.state.lock().unwrap()["status"].as_str().unwrap_or("").to_string()
    }
}

fn has(v: &Value, k: &str) -> bool {
    v[k].as_str().is_some_and(|s| !s.is_empty())
}

/// discord:state, debounced (40 ms) like the Electron version.
fn push(app: &AppHandle) {
    let d = discord(app);
    let gen = d.push_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(40)).await;
        let d = discord(&app);
        if d.push_gen.load(Ordering::SeqCst) == gen {
            send(&app, "discord:state", d.public_state());
        }
    });
}

fn set_status(app: &AppHandle, status: &str, error: Option<String>) {
    discord(app).set(|s| {
        s.insert("status".into(), json!(status));
        s.insert("error".into(), json!(error));
    });
    push(app);
}

/* -------------------------------------------------------------- */
/* Credentials                                                    */
/* -------------------------------------------------------------- */

pub fn setup(app: &AppHandle, data: &Value) -> Result<Value, String> {
    let d = discord(app);
    {
        let mut c = d.creds.lock().unwrap();
        if let Some(id) = data.get("clientId").filter(|v| !v.is_null()) {
            let id = match id {
                Value::String(s) => s.trim().to_string(),
                other => other.to_string(),
            };
            static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{15,22}$").unwrap());
            if !id.is_empty() && !ID.is_match(&id) {
                return Err("The Application ID is the long number on the app’s General Information page.".into());
            }
            if c["clientId"].as_str() != Some(id.as_str()) {
                c["access"] = Value::Null;
                c["refresh"] = Value::Null;
            }
            c["clientId"] = json!(id);
        }
        if let Some(secret) = data.get("secret").and_then(|s| s.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
            c["secret"] = secure::seal(secret);
        }
    }
    d.save_creds();
    let (configured, client_id, authorized) = {
        let c = d.creds.lock().unwrap();
        (has(&c, "clientId") && !c["secret"].is_null(), c["clientId"].as_str().unwrap_or("").to_string(), !c["access"].is_null())
    };
    d.set(|s| {
        s.insert("configured".into(), json!(configured));
        s.insert("clientId".into(), json!(client_id));
        s.insert("authorized".into(), json!(authorized));
    });
    if !configured {
        set_status(app, "setup", None);
    } else if d.status() == "setup" {
        set_status(app, "idle", None);
    }
    push(app);
    Ok(d.public_state())
}

pub async fn forget(app: &AppHandle) -> Value {
    close(app).await;
    let d = discord(app);
    *d.creds.lock().unwrap() = json!({});
    d.save_creds();
    d.set(|s| {
        for (k, v) in [
            ("configured", json!(false)),
            ("clientId", json!("")),
            ("authorized", json!(false)),
            ("user", Value::Null),
            ("voice", Value::Null),
            ("channel", Value::Null),
            ("members", json!([])),
            ("error", Value::Null),
        ] {
            s.insert(k.into(), v);
        }
    });
    set_status(app, "setup", None);
    d.public_state()
}

/* -------------------------------------------------------------- */
/* Pipe transport                                                 */
/* -------------------------------------------------------------- */

fn frame(op: i32, payload: &Value) -> Vec<u8> {
    let body = payload.to_string().into_bytes();
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(&op.to_le_bytes());
    out.extend_from_slice(&(body.len() as i32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

async fn write(app: &AppHandle, op: i32, payload: &Value) -> Result<(), String> {
    let mut w = discord(app).writer.lock().await;
    let Some(pipe) = w.as_mut() else { return Err("Not connected to Discord".into()) };
    pipe.write_all(&frame(op, payload)).await.map_err(|e| e.to_string())
}

async fn request(app: &AppHandle, cmd: &str, args: Value, evt: Option<&str>, timeout_ms: u64) -> Reply {
    let d = discord(app);
    if d.writer.lock().await.is_none() {
        return Err("Not connected to Discord".into());
    }
    let n = format!("{:x}-{}", now_ms(), d.nonce.fetch_add(1, Ordering::SeqCst) + 1);
    let (tx, rx) = oneshot::channel();
    d.pending.lock().unwrap().insert(n.clone(), tx);
    let mut payload = json!({ "cmd": cmd, "args": args, "nonce": n });
    if let Some(e) = evt {
        payload["evt"] = json!(e);
    }
    if let Err(e) = write(app, OP_FRAME, &payload).await {
        d.pending.lock().unwrap().remove(&n);
        return Err(e);
    }
    match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("Disconnected".into()),
        Err(_) => {
            d.pending.lock().unwrap().remove(&n);
            Err(format!("{cmd} timed out"))
        }
    }
}

async fn req(app: &AppHandle, cmd: &str, args: Value) -> Reply {
    request(app, cmd, args, None, 10000).await
}

/// Fire and forget (subscriptions).
fn send_req(app: &AppHandle, cmd: &'static str, args: Value, evt: &'static str) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = request(&app, cmd, args, Some(evt), 10000).await;
    });
}

async fn open_pipe() -> Option<NamedPipeClient> {
    for i in 0..10 {
        if let Ok(p) = ClientOptions::new().open(format!(r"\\?\pipe\discord-ipc-{i}")) {
            return Some(p);
        }
    }
    None
}

pub async fn close(app: &AppHandle) {
    let d = discord(app);
    d.retry_gen.fetch_add(1, Ordering::SeqCst);
    d.conn_gen.fetch_add(1, Ordering::SeqCst);
    if let Some(h) = d.reader.lock().unwrap().take() {
        h.abort();
    }
    *d.writer.lock().await = None;
    for (_, tx) in d.pending.lock().unwrap().drain() {
        let _ = tx.send(Err("Disconnected".into()));
    }
    *d.channel_subs.lock().unwrap() = None;
}

async fn read_loop(app: AppHandle, mut rd: tokio::io::ReadHalf<NamedPipeClient>, gen: u64) {
    let mut head = [0u8; 8];
    loop {
        if rd.read_exact(&mut head).await.is_err() {
            break;
        }
        let op = i32::from_le_bytes(head[0..4].try_into().unwrap());
        let len = i32::from_le_bytes(head[4..8].try_into().unwrap()).max(0) as usize;
        let mut body = vec![0u8; len];
        if rd.read_exact(&mut body).await.is_err() {
            break;
        }
        let msg: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        on_message(&app, op, msg).await;
    }
    // The pipe closed.
    let d = discord(&app);
    if d.conn_gen.load(Ordering::SeqCst) != gen {
        return;
    }
    *d.writer.lock().await = None;
    d.set(|s| {
        s.insert("channel".into(), Value::Null);
        s.insert("members".into(), json!([]));
    });
    set_status(&app, "offline", Some("Lost the connection to Discord.".into()));
    schedule_retry(&app);
}

async fn on_message(app: &AppHandle, op: i32, msg: Value) {
    let d = discord(app);
    if op == OP_PING {
        let _ = write(app, OP_PONG, &msg).await;
        return;
    }
    if op == OP_CLOSE {
        let reason = msg["message"].as_str().unwrap_or("Discord closed the connection").to_string();
        close(app).await;
        static BAD_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)client id|invalid").unwrap());
        let text = if BAD_ID.is_match(&reason) { "Discord rejected the Application ID. Check it in Settings.".to_string() } else { reason };
        set_status(app, "error", Some(text));
        return;
    }
    if msg.is_null() {
        return;
    }
    if let Some(n) = msg["nonce"].as_str() {
        if let Some(tx) = d.pending.lock().unwrap().remove(n) {
            let r = if msg["evt"] == "ERROR" { Err(msg["data"]["message"].as_str().unwrap_or("Discord error").to_string()) } else { Ok(msg["data"].clone()) };
            let _ = tx.send(r);
            return;
        }
    }
    if msg["cmd"] == "DISPATCH" {
        on_event(app, msg["evt"].as_str().unwrap_or(""), msg.get("data").cloned().unwrap_or(json!({})));
    }
}

/* -------------------------------------------------------------- */
/* Connect / authorize                                            */
/* -------------------------------------------------------------- */

/// interactive: allowed to show Discord's "Authorize" prompt.
pub async fn connect(app: &AppHandle, interactive: bool) -> Value {
    let d = discord(app);
    if d.state.lock().unwrap()["configured"] != true {
        set_status(app, "setup", None);
        return d.public_state();
    }
    let _one = match d.connecting.try_lock() {
        Ok(g) => g,
        Err(_) => {
            let _wait = d.connecting.lock().await;
            return d.public_state();
        }
    };
    connect_inner(app, interactive).await;
    d.public_state()
}

async fn connect_inner(app: &AppHandle, interactive: bool) {
    close(app).await;
    set_status(app, "connecting", None);
    let Some(pipe) = open_pipe().await else {
        set_status(app, "offline", Some("Discord isn’t running.".into()));
        schedule_retry(app);
        return;
    };
    let d = discord(app);
    let gen = d.conn_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let (rd, wr) = tokio::io::split(pipe);
    *d.writer.lock().await = Some(wr);
    let (tx, rx) = oneshot::channel();
    *d.ready.lock().unwrap() = Some(tx);
    let h = tauri::async_runtime::spawn(read_loop(app.clone(), rd, gen));
    *d.reader.lock().unwrap() = Some(h);

    let client_id = d.creds.lock().unwrap()["clientId"].as_str().unwrap_or("").to_string();
    let _ = write(app, OP_HANDSHAKE, &json!({ "v": 1, "client_id": client_id })).await;
    match tokio::time::timeout(Duration::from_secs(8), rx).await {
        Ok(Ok(Ok(data))) => {
            if data["user"].is_object() {
                let u = describe_user(&data["user"]);
                d.set(|s| {
                    s.insert("user".into(), u);
                });
            }
        }
        Ok(Ok(Err(e))) => {
            if d.status() == "connecting" {
                set_status(app, "error", Some(e));
            }
            return;
        }
        _ => {
            if d.status() == "connecting" {
                set_status(app, "error", Some("Discord did not answer".into()));
            }
            return;
        }
    }

    if let Err(e) = authenticate(app, interactive).await {
        set_status(app, if e.needs_auth { "needs-auth" } else { "error" }, Some(e.message));
        return;
    }
    set_status(app, "ready", None);
    after_auth(app).await;
}

fn schedule_retry(app: &AppHandle) {
    let d = discord(app);
    let gen = d.retry_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let ok = d.state.lock().unwrap()["configured"] == true && !d.creds.lock().unwrap()["access"].is_null();
    if !ok {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        if discord(&app).retry_gen.load(Ordering::SeqCst) == gen {
            connect(&app, false).await;
        }
    });
}

/// Authorized before messages were supported: Discord has to ask once more.
fn needs_message_scopes(app: &AppHandle) -> bool {
    let c = discord(app).creds.lock().unwrap();
    let have: Vec<&str> = c["scopes"].as_array().map(|a| a.iter().filter_map(|s| s.as_str()).collect()).unwrap_or_default();
    !MESSAGE_SCOPES.iter().all(|s| have.contains(s))
}

async fn authenticate(app: &AppHandle, interactive: bool) -> Result<(), AuthError> {
    let d = discord(app);
    let (access, expires) = {
        let c = d.creds.lock().unwrap();
        (secure::open(&c["access"]), c["expires"].as_i64())
    };
    let mut token = if interactive && needs_message_scopes(app) { None } else { access };
    if token.is_some() && expires.is_some_and(|e| now_ms() > e - 60_000) {
        token = refresh_token(app).await;
    }
    if let Some(t) = token {
        if req(app, "AUTHENTICATE", json!({ "access_token": t })).await.is_ok() {
            return Ok(());
        }
        if let Some(t) = refresh_token(app).await {
            if req(app, "AUTHENTICATE", json!({ "access_token": t })).await.is_ok() {
                return Ok(());
            }
        }
    }
    if !interactive {
        return Err(auth_err("Connect the launcher to Discord in Settings."));
    }

    set_status(app, "authorizing", None);
    let client_id = d.creds.lock().unwrap()["clientId"].as_str().unwrap_or("").to_string();
    let res = request(app, "AUTHORIZE", json!({ "client_id": client_id, "scopes": SCOPES }), None, 120_000).await.map_err(|e| {
        static DECLINED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)cancel|denied|closed").unwrap());
        auth_err(if DECLINED.is_match(&e) { "The request was declined in Discord.".to_string() } else { e })
    })?;
    let code = res["code"].as_str().filter(|c| !c.is_empty()).ok_or_else(|| auth_err("Discord did not return an authorization code."))?.to_string();
    let token = exchange(app, &[("grant_type", "authorization_code"), ("code", &code)]).await?;
    req(app, "AUTHENTICATE", json!({ "access_token": token })).await.map_err(|e| AuthError { message: e, needs_auth: false })?;
    Ok(())
}

fn form(params: &[(&str, &str)]) -> String {
    params.iter().map(|(k, v)| format!("{}={}", crate::util::encode_uri_component(k), crate::util::encode_uri_component(v))).collect::<Vec<_>>().join("&")
}

async fn exchange(app: &AppHandle, params: &[(&str, &str)]) -> Result<String, AuthError> {
    let d = discord(app);
    let (client_id, secret) = {
        let c = d.creds.lock().unwrap();
        (c["clientId"].as_str().unwrap_or("").to_string(), secure::open(&c["secret"]))
    };
    let secret = secret.ok_or_else(|| auth_err("Enter the Client Secret in Settings."))?;
    let is_code = params.iter().any(|(k, v)| *k == "grant_type" && *v == "authorization_code");
    let attempt = |with_redirect: bool| {
        let mut p: Vec<(&str, &str)> = vec![("client_id", client_id.as_str()), ("client_secret", secret.as_str())];
        p.extend_from_slice(params);
        if with_redirect && is_code {
            p.push(("redirect_uri", REDIRECT_URI));
        }
        let body = form(&p);
        async move {
            let res = crate::metadata::client()
                .post(TOKEN_URL)
                .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(body)
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| auth_err(e.to_string()))?;
            let ok = res.status().is_success();
            let j: Value = res.json().await.unwrap_or(json!({}));
            Ok::<_, AuthError>((ok, j))
        }
    };
    let (mut ok, mut j) = attempt(true).await?;
    if !ok && is_code && j.to_string().to_lowercase().contains("redirect") {
        (ok, j) = attempt(false).await?;
    }
    if !ok {
        let msg = j["error_description"].as_str().or(j["error"].as_str()).unwrap_or("Discord refused the token request").to_string();
        return Err(auth_err(if msg.to_lowercase().contains("client") { "Discord rejected the Client Secret. Check it in Settings.".to_string() } else { msg }));
    }
    let access = j["access_token"].as_str().unwrap_or("").to_string();
    {
        let mut c = d.creds.lock().unwrap();
        c["access"] = secure::seal(&access);
        if let Some(r) = j["refresh_token"].as_str() {
            c["refresh"] = secure::seal(r);
        }
        c["expires"] = json!(now_ms() + j["expires_in"].as_i64().unwrap_or(604_800) * 1000);
        if let Some(scope) = j["scope"].as_str() {
            c["scopes"] = json!(scope.split_whitespace().collect::<Vec<_>>());
        }
    }
    d.save_creds();
    d.set(|s| {
        s.insert("authorized".into(), json!(true));
    });
    Ok(access)
}

async fn refresh_token(app: &AppHandle) -> Option<String> {
    let refresh = secure::open(&discord(app).creds.lock().unwrap()["refresh"])?;
    exchange(app, &[("grant_type", "refresh_token"), ("refresh_token", &refresh)]).await.ok()
}

pub async fn disconnect(app: &AppHandle) -> Value {
    close(app).await;
    discord(app).set(|s| {
        s.insert("channel".into(), Value::Null);
        s.insert("members".into(), json!([]));
        s.insert("voice".into(), Value::Null);
    });
    set_status(app, "idle", None);
    discord(app).public_state()
}

/* -------------------------------------------------------------- */
/* Voice state                                                    */
/* -------------------------------------------------------------- */

async fn after_auth(app: &AppHandle) {
    for evt in ["VOICE_SETTINGS_UPDATE", "VOICE_CHANNEL_SELECT", "VOICE_CONNECTION_STATUS"] {
        send_req(app, "SUBSCRIBE", json!({}), evt);
    }
    discord(app).set(|s| {
        s.insert("messages".into(), json!(false));
    });
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        let ok = request(&a, "SUBSCRIBE", json!({}), Some("NOTIFICATION_CREATE"), 10000).await.is_ok();
        discord(&a).set(|s| {
            s.insert("messages".into(), json!(ok));
        });
        push(&a);
    });
    if let Ok(v) = req(app, "GET_VOICE_SETTINGS", json!({})).await {
        apply_voice_settings(app, &v);
    }
    load_channel(app).await;
}

fn apply_voice_settings(app: &AppHandle, v: &Value) {
    if !v.is_object() {
        return;
    }
    let vol = |k: &str| v[k]["volume"].as_f64().map(|n| n.round() as i64).unwrap_or(100);
    let voice = json!({ "mute": v["mute"] == true, "deaf": v["deaf"] == true, "input": vol("input"), "output": vol("output") });
    discord(app).set(|s| {
        s.insert("voice".into(), voice);
    });
    push(app);
}

async fn load_channel(app: &AppHandle) {
    let ch = req(app, "GET_SELECTED_VOICE_CHANNEL", json!({})).await.ok().filter(|c| c.is_object());
    switch_channel_subs(app, ch.as_ref().and_then(|c| c["id"].as_str()).map(str::to_string));
    let Some(ch) = ch else {
        discord(app).set(|s| {
            s.insert("channel".into(), Value::Null);
            s.insert("members".into(), json!([]));
        });
        push(app);
        return;
    };
    let mut guild = Value::Null;
    if let Some(gid) = ch["guild_id"].as_str() {
        if let Ok(g) = req(app, "GET_GUILD", json!({ "guild_id": gid, "timeout": 5 })).await {
            guild = g["name"].clone();
        }
    }
    let members: Vec<Value> = ch["voice_states"].as_array().map(|a| a.iter().map(|vs| describe_member(app, vs)).collect()).unwrap_or_default();
    let channel = json!({ "id": ch["id"], "name": ch["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("Voice channel"), "guild": guild, "dm": ch["guild_id"].is_null() });
    discord(app).set(|s| {
        s.insert("channel".into(), channel);
        s.insert("members".into(), Value::Array(members));
    });
    push(app);
}

fn switch_channel_subs(app: &AppHandle, channel_id: Option<String>) {
    const EVTS: [&str; 5] = ["VOICE_STATE_CREATE", "VOICE_STATE_UPDATE", "VOICE_STATE_DELETE", "SPEAKING_START", "SPEAKING_STOP"];
    let prev = discord(app).channel_subs.lock().unwrap().clone();
    if let Some(old) = prev.as_ref().filter(|o| Some(*o) != channel_id.as_ref()) {
        for evt in EVTS {
            send_req(app, "UNSUBSCRIBE", json!({ "channel_id": old }), evt);
        }
    }
    if let Some(id) = channel_id.as_ref().filter(|id| Some(*id) != prev.as_ref()) {
        for evt in EVTS {
            send_req(app, "SUBSCRIBE", json!({ "channel_id": id }), evt);
        }
    }
    *discord(app).channel_subs.lock().unwrap() = channel_id;
}

fn describe_user(u: &Value) -> Value {
    if !u.is_object() {
        return Value::Null;
    }
    let id = u["id"].as_str().unwrap_or("");
    let name = u["global_name"].as_str().filter(|s| !s.is_empty()).or(u["username"].as_str()).unwrap_or("");
    let avatar = u["avatar"].as_str().map(|a| format!("https://cdn.discordapp.com/avatars/{id}/{a}.png?size=96"));
    json!({ "id": id, "name": name, "avatar": avatar })
}

fn self_id(app: &AppHandle) -> Option<String> {
    discord(app).state.lock().unwrap()["user"]["id"].as_str().map(str::to_string)
}

fn describe_member(app: &AppHandle, vs: &Value) -> Value {
    let mut u = describe_user(&vs["user"]);
    if u.is_null() {
        u = json!({ "id": "?", "name": "Unknown", "avatar": null });
    }
    let id = u["id"].as_str().unwrap_or("").to_string();
    let s = &vs["voice_state"];
    let speaking = discord(app).state.lock().unwrap()["members"]
        .as_array()
        .and_then(|m| m.iter().find(|m| m["id"].as_str() == Some(&id)).map(|m| m["speaking"] == true))
        .unwrap_or(false);
    let t = |v: &Value| v == &json!(true);
    if let Some(nick) = vs["nick"].as_str().filter(|n| !n.is_empty()) {
        u["name"] = json!(nick);
    }
    u["mute"] = json!(t(&s["self_mute"]) || t(&s["mute"]) || t(&vs["mute"]));
    u["deaf"] = json!(t(&s["self_deaf"]) || t(&s["deaf"]));
    u["volume"] = json!(vs["volume"].as_f64().map(|v| v.round() as i64).unwrap_or(100));
    u["speaking"] = json!(speaking);
    u["self"] = json!(self_id(app).as_deref() == Some(id.as_str()));
    u
}

fn on_event(app: &AppHandle, evt: &str, data: Value) {
    let d = discord(app);
    match evt {
        "READY" => {
            if let Some(tx) = d.ready.lock().unwrap().take() {
                let _ = tx.send(Ok(data));
            }
        }
        "ERROR" => {
            if let Some(tx) = d.ready.lock().unwrap().take() {
                let _ = tx.send(Err(data["message"].as_str().unwrap_or("Discord error").to_string()));
            }
        }
        "VOICE_SETTINGS_UPDATE" => apply_voice_settings(app, &data),
        "VOICE_CHANNEL_SELECT" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { load_channel(&app).await });
        }
        "VOICE_STATE_CREATE" | "VOICE_STATE_UPDATE" => {
            let m = describe_member(app, &data);
            d.set(|s| {
                if let Some(list) = s.get_mut("members").and_then(|v| v.as_array_mut()) {
                    match list.iter().position(|x| x["id"] == m["id"]) {
                        Some(i) => list[i] = m,
                        None => list.push(m),
                    }
                }
            });
            push(app);
        }
        "VOICE_STATE_DELETE" => {
            let id = data["user"]["id"].clone();
            let me = self_id(app);
            d.set(|s| {
                if let Some(list) = s.get_mut("members").and_then(|v| v.as_array_mut()) {
                    list.retain(|x| x["id"] != id);
                }
                if me.is_some() && id.as_str() == me.as_deref() {
                    s.insert("channel".into(), Value::Null);
                }
            });
            push(app);
        }
        "NOTIFICATION_CREATE" => on_notification(app, &data),
        "MESSAGE_CREATE" => {
            let current = d.chat_channel.lock().unwrap().clone();
            if data["channel_id"].as_str().is_some() && data["channel_id"].as_str() == current.as_deref() && data["message"].is_object() {
                send(app, "discord:chat", json!({ "channelId": data["channel_id"], "message": describe_message(app, &data["message"]) }));
            }
        }
        "SPEAKING_START" | "SPEAKING_STOP" => {
            let uid = data["user_id"].clone();
            let mut changed = false;
            d.set(|s| {
                if let Some(m) = s.get_mut("members").and_then(|v| v.as_array_mut()).and_then(|l| l.iter_mut().find(|x| x["id"] == uid)) {
                    m["speaking"] = json!(evt == "SPEAKING_START");
                    changed = true;
                }
            });
            if changed {
                push(app);
            }
        }
        _ => {}
    }
}

/* -------------------------------------------------------------- */
/* Messages                                                       */
/* -------------------------------------------------------------- */

fn avatar_url(u: &Value) -> Value {
    match (u["id"].as_str(), u["avatar"].as_str()) {
        (Some(id), Some(a)) => json!(format!("https://cdn.discordapp.com/avatars/{id}/{a}.png?size=128")),
        _ => Value::Null,
    }
}

/// "2026-10-11T21:04:05.123000+00:00" -> epoch milliseconds (Date.parse).
fn parse_time(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, mo, da) = (d.next()??, d.next()??, d.next()??);
    let (time, offset) = match rest.find(['Z', '+', '-']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "Z"),
    };
    let mut t = time.split(':');
    let (h, mi) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
    let sec: f64 = t.next().unwrap_or("0").parse().ok()?;
    let off_min = if offset == "Z" {
        0
    } else {
        let sign = if offset.starts_with('-') { -1 } else { 1 };
        let mut o = offset[1..].split(':');
        sign * (o.next()?.parse::<i64>().ok()? * 60 + o.next().unwrap_or("0").parse::<i64>().ok()?)
    };
    // Days from civil (Howard Hinnant).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86400 + h * 3600 + mi * 60 - off_min * 60) as f64 * 1000.0 + sec * 1000.0) as i64)
}

fn describe_message(app: &AppHandle, m: &Value) -> Value {
    let a = &m["author"];
    let att = m["attachments"].as_array().map_or(0, |x| x.len());
    let emb = m["embeds"].as_array().map_or(0, |x| x.len());
    let mut content = m["content"].as_str().unwrap_or("").to_string();
    if content.is_empty() && att > 0 {
        content = if att == 1 { "[attachment]".into() } else { format!("[{att} attachments]") };
    } else if content.is_empty() && emb > 0 {
        content = "[embed]".into();
    }
    let pick = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_string);
    let author = pick(&a["global_name"]).or(pick(&a["nick"])).or(pick(&m["nick"])).or(pick(&a["username"])).unwrap_or_else(|| "Unknown".into());
    json!({
        "id": m["id"],
        "author": author,
        "authorId": a.get("id").cloned().unwrap_or(Value::Null),
        "avatar": avatar_url(a),
        "self": a["id"].as_str().is_some() && a["id"].as_str() == self_id(app).as_deref(),
        "content": content,
        "time": m["timestamp"].as_str().and_then(parse_time).unwrap_or_else(now_ms),
    })
}

fn on_notification(app: &AppHandle, d: &Value) {
    let Some(channel_id) = d["channel_id"].as_str().map(str::to_string) else { return };
    let msg = d["message"].is_object().then(|| describe_message(app, &d["message"]));
    if msg.as_ref().is_some_and(|m| m["self"] == true) {
        return;
    }
    let pick = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_string);
    let name = pick(&d["title"]).or_else(|| msg.as_ref().and_then(|m| pick(&m["author"]))).unwrap_or_else(|| "Discord".into());
    let icon = pick(&d["icon_url"]).map(Value::String).or_else(|| msg.as_ref().map(|m| m["avatar"].clone())).unwrap_or(Value::Null);
    let body = pick(&d["body"]).or_else(|| msg.as_ref().and_then(|m| pick(&m["content"]))).unwrap_or_default();
    discord(app).set(|s| {
        let list = s.get("conversations").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let prev_unread = list.iter().find(|c| c["channelId"] == channel_id.as_str()).and_then(|c| c["unread"].as_i64()).unwrap_or(0);
        let mut next: Vec<Value> = vec![json!({ "channelId": channel_id, "name": name, "icon": icon, "last": body, "time": now_ms(), "unread": prev_unread + 1 })];
        next.extend(list.into_iter().filter(|c| c["channelId"] != channel_id.as_str()));
        next.truncate(12);
        s.insert("conversations".into(), Value::Array(next));
    });
    push(app);
    send(app, "discord:message", json!({ "channelId": channel_id, "title": name, "body": body, "icon": icon }));
}

/// Recent messages of a channel; new ones follow as discord:chat events.
pub async fn open_chat(app: &AppHandle, channel_id: &str) -> Result<Value, String> {
    if channel_id.is_empty() || !channel_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Unknown conversation".into());
    }
    let d = discord(app);
    let prev = d.chat_channel.lock().unwrap().replace(channel_id.to_string());
    if let Some(old) = prev.filter(|o| o != channel_id) {
        send_req(app, "UNSUBSCRIBE", json!({ "channel_id": old }), "MESSAGE_CREATE");
    }
    let ch = req(app, "GET_CHANNEL", json!({ "channel_id": channel_id })).await?;
    send_req(app, "SUBSCRIBE", json!({ "channel_id": channel_id }), "MESSAGE_CREATE");
    let mut conv_name: Option<String> = None;
    d.set(|s| {
        if let Some(c) = s.get_mut("conversations").and_then(|v| v.as_array_mut()).and_then(|l| l.iter_mut().find(|c| c["channelId"] == channel_id)) {
            c["unread"] = json!(0);
            conv_name = c["name"].as_str().map(str::to_string);
        }
    });
    push(app);
    let mut messages: Vec<Value> = ch["messages"].as_array().map(|a| a.iter().map(|m| describe_message(app, m)).collect()).unwrap_or_default();
    messages.sort_by_key(|m| m["time"].as_i64().unwrap_or(0));
    let name = ch["name"].as_str().filter(|n| !n.is_empty()).map(str::to_string).or(conv_name).unwrap_or_else(|| "Discord".into());
    Ok(json!({ "channelId": channel_id, "guildId": ch.get("guild_id").cloned().unwrap_or(Value::Null), "name": name, "messages": messages }))
}

pub fn close_chat(app: &AppHandle) {
    if let Some(id) = discord(app).chat_channel.lock().unwrap().take() {
        send_req(app, "UNSUBSCRIBE", json!({ "channel_id": id }), "MESSAGE_CREATE");
    }
}

/// Open the conversation in Discord (where replies are written).
pub fn open_in_discord(app: &AppHandle, channel_id: &str, guild_id: &Value) -> bool {
    if channel_id.is_empty() || !channel_id.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let g = match guild_id {
        Value::String(g) if !g.is_empty() && g.chars().all(|c| c.is_ascii_digit()) => g.clone(),
        _ => "@me".into(),
    };
    let _ = app.opener().open_url(format!("discord://-/channels/{g}/{channel_id}"), None::<&str>);
    true
}

/* -------------------------------------------------------------- */
/* Commands                                                       */
/* -------------------------------------------------------------- */

pub async fn command(app: &AppHandle, name: &str, value: &Value, extra: &Value) -> Result<Value, String> {
    if discord(app).status() != "ready" {
        return Err("Not connected to Discord".into());
    }
    let num = |lo: f64, hi: f64| value.as_f64().unwrap_or(0.0).clamp(lo, hi);
    let truthy = !matches!(value, Value::Null | Value::Bool(false)) && value != &json!(0) && value != &json!("");
    match name {
        "mute" | "deaf" | "input" | "output" => {
            let args = match name {
                "mute" => json!({ "mute": truthy }),
                "deaf" => json!({ "deaf": truthy }),
                "input" => json!({ "input": { "volume": num(0.0, 100.0) } }),
                _ => json!({ "output": { "volume": num(0.0, 200.0) } }),
            };
            let v = req(app, "SET_VOICE_SETTINGS", args).await?;
            apply_voice_settings(app, &v);
            Ok(Value::Null)
        }
        "leave" => {
            req(app, "SELECT_VOICE_CHANNEL", json!({ "channel_id": null, "force": true })).await?;
            discord(app).set(|s| {
                s.insert("channel".into(), Value::Null);
                s.insert("members".into(), json!([]));
            });
            switch_channel_subs(app, None);
            push(app);
            Ok(json!(true))
        }
        "userVolume" => {
            let uid = match extra {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            let res = req(app, "SET_USER_VOICE_SETTINGS", json!({ "user_id": uid, "volume": num(0.0, 200.0) })).await?;
            let vol = res["volume"].as_f64().unwrap_or(num(0.0, 200.0)).round() as i64;
            discord(app).set(|s| {
                if let Some(m) = s.get_mut("members").and_then(|v| v.as_array_mut()).and_then(|l| l.iter_mut().find(|x| x["id"] == uid.as_str())) {
                    m["volume"] = json!(vol);
                }
            });
            push(app);
            Ok(json!(true))
        }
        "userMute" => {
            let uid = match extra {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            req(app, "SET_USER_VOICE_SETTINGS", json!({ "user_id": uid, "mute": truthy })).await?;
            Ok(json!(true))
        }
        _ => Err(format!("Unknown command {name}")),
    }
}

/// Called once at startup: reconnect silently if we were authorized before.
pub fn start(app: &AppHandle) {
    let d = discord(app);
    let go = d.state.lock().unwrap()["configured"] == true && !d.creds.lock().unwrap()["access"].is_null();
    if go {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(2500)).await;
            connect(&app, false).await;
        });
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_discord_timestamps() {
        assert_eq!(super::parse_time("1970-01-01T00:00:00+00:00"), Some(0));
        assert_eq!(super::parse_time("2026-10-11T21:04:05.123000+00:00"), Some(1_791_752_645_123));
        assert_eq!(super::parse_time("2026-10-11T23:04:05.123+02:00"), Some(1_791_752_645_123));
    }
}
