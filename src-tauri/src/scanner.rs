//! Finding installed games (port of main/scanner.js): shortcut folders,
//! Steam, Epic Games, Ubisoft Connect and Xbox / Microsoft Store games.
//! Everything here is blocking (file system, registry, COM, PowerShell), so
//! it runs on a blocking thread.
//!
//! Records are JSON objects with the same keys the Electron scanner produced,
//! so library.json stays interchangeable between the two versions.

use crate::util::{basename, dirname, encode_uri_component, exists, extname, hash_id, join, normalize, resolve, stem, tidy_name};
use crate::{vdf, winapi};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::{collections::HashMap, fs, os::windows::process::CommandExt, path::Path, process::Command, sync::LazyLock};
use winreg::{enums::*, RegKey};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub static EXE_SKIP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(unins|uninstall|setup|install|crash|report|redist|vcredist|vc_redist|dxsetup|dotnet|directx|helper|updater|update|patcher|prereq|easyanticheat|eac_|be_service|battleye|cefprocess|webhelper|notification|overlay|benchmark|config|settings|server|editor|console|dump|7z|python|java|unity ?crash)").unwrap()
});
static SKIP_DIRS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(redist|_commonredist|directx|support|tools|docs?|engine|__installer|crashreport)").unwrap());
static SHORTCUT_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\s*-\s*(shortcut|verknüpfung|raccourci|acceso directo|collegamento|atalho)$").unwrap());
static STEAM_EXCLUDED_NAMES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(steamworks common redistributables|steam linux runtime.*|proton.*|steamvr.*|steam audio.*|spacewar|.*dedicated server.*|.*\bsdk\b.*|.*soundtrack.*)$").unwrap()
});
const STEAM_EXCLUDED_IDS: [&str; 21] = [
    "228980", "1070560", "1391110", "1628350", "1493710", "2180100", "961940", "1161040", "1826330", "2348590", "2805730", "858280", "250820", "1054830",
    "1113280", "1245040", "1420170", "1580130", "1887720", "2230260", "3658110",
];

fn name_from_file(file: &str) -> String {
    let n = stem(file);
    let n = SHORTCUT_SUFFIX.replace(&n, "");
    tidy_name(&n.replace('_', " "))
}

fn steam_id_from_string(s: &str) -> Option<String> {
    static URI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)steam://(?:rungameid|run|launch)/(\d+)").unwrap());
    static APPLAUNCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)-applaunch\s+(\d+)").unwrap());
    URI.captures(s).or_else(|| APPLAUNCH.captures(s)).map(|c| c[1].to_string())
}

fn read_text(file: &str) -> Option<String> {
    fs::read(file).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn reg_value(hive: winreg::HKEY, key: &str, value: &str) -> Option<String> {
    RegKey::predef(hive).open_subkey(key).ok()?.get_value::<String, _>(value).ok().filter(|s| !s.is_empty())
}

fn launch_exe(target: &str, args: &str, cwd: &str) -> Value {
    json!({ "type": "exe", "target": target, "args": args, "cwd": cwd })
}

/* ------------------------------------------------------------------ */
/* Shortcut folders                                                    */
/* ------------------------------------------------------------------ */

/// describeFile: a .lnk / .url / .exe / .bat / .cmd file as a library record.
/// `extra` is merged in like `{ ...base, ...extra }` (folder or source).
pub fn describe_file(file: &str, extra: &Map<String, Value>) -> Option<Value> {
    let ext = extname(file);
    let mut g = Map::new();
    g.insert("name".into(), json!(name_from_file(file)));
    g.insert("path".into(), json!(file));
    g.insert("source".into(), json!("folder"));
    for (k, v) in extra {
        g.insert(k.clone(), v.clone());
    }
    match ext.as_str() {
        ".url" => {
            static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?im)^\s*URL\s*=\s*(.+)$").unwrap());
            let text = read_text(file).unwrap_or_default();
            let url = URL.captures(&text)?[1].trim().to_string();
            let steam = steam_id_from_string(&url);
            g.insert("id".into(), json!(hash_id("lnk", file)));
            g.insert("steamAppId".into(), json!(steam));
            let target = steam.as_ref().map(|id| format!("steam://rungameid/{id}")).unwrap_or(url);
            g.insert("launch".into(), json!({ "type": "uri", "target": target }));
        }
        ".lnk" => {
            let link = winapi::read_shortcut(Path::new(file));
            let target = link.as_ref().map(|l| l.target.clone()).unwrap_or_default();
            let args = link.as_ref().map(|l| l.args.clone()).unwrap_or_default();
            g.insert("id".into(), json!(hash_id("lnk", file)));
            if let Some(steam) = steam_id_from_string(&args).or_else(|| steam_id_from_string(&target)) {
                g.insert("steamAppId".into(), json!(steam));
                g.insert("launch".into(), json!({ "type": "uri", "target": format!("steam://rungameid/{steam}") }));
            } else if !target.is_empty() && target.to_lowercase().ends_with(".exe") && exists(&target) {
                let cwd = link.as_ref().map(|l| l.cwd.clone()).filter(|c| !c.is_empty()).unwrap_or_else(|| dirname(&target));
                g.insert("exe".into(), json!(target));
                g.insert("launch".into(), launch_exe(&target, &args, &cwd));
            } else {
                // Store apps, advertised shortcuts etc. - let the shell handle it.
                g.insert("exe".into(), if target.is_empty() { Value::Null } else { json!(target) });
                g.insert("launch".into(), json!({ "type": "shell", "target": file }));
            }
        }
        ".exe" => {
            g.insert("id".into(), json!(hash_id("exe", file)));
            g.insert("exe".into(), json!(file));
            g.insert("launch".into(), launch_exe(file, "", &dirname(file)));
        }
        ".bat" | ".cmd" => {
            g.insert("id".into(), json!(hash_id("lnk", file)));
            g.insert("launch".into(), json!({ "type": "shell", "target": file }));
        }
        _ => return None,
    }
    Some(Value::Object(g))
}

/// scanner.js similarity: 1 for equal, 0.8 for containment, else bigram Dice.
pub fn similarity(a: &str, b: &str) -> f64 {
    let norm = |s: &str| s.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>();
    let (x, y) = (norm(a), norm(b));
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    if x == y {
        return 1.0;
    }
    if x.contains(&y) || y.contains(&x) {
        return 0.8;
    }
    fn grams(s: &str) -> HashMap<&str, usize> {
        let mut m: HashMap<&str, usize> = HashMap::new();
        for i in 0..s.len().saturating_sub(1) {
            *m.entry(&s[i..i + 2]).or_default() += 1;
        }
        m
    }
    let (gx, gy) = (grams(&x), grams(&y));
    let hit: usize = gx.iter().map(|(g, n)| (*n).min(*gy.get(g).unwrap_or(&0))).sum();
    let denom = (x.len() + y.len()) as f64 - 2.0;
    2.0 * hit as f64 / if denom == 0.0 { 1.0 } else { denom }
}

pub struct BestExe {
    pub file: String,
    score: f64,
}

/// Find the most plausible game executable inside an install directory.
pub fn find_best_exe(dir: &str, folder_name: &str) -> Option<BestExe> {
    let mut budget = 0usize;
    best_exe_in(dir, folder_name, 0, &mut budget)
}

fn best_exe_in(dir: &str, folder_name: &str, depth: u32, budget: &mut usize) -> Option<BestExe> {
    let entries = fs::read_dir(dir).ok()?;
    let mut best: Option<BestExe> = None;
    for e in entries.flatten() {
        *budget += 1;
        if *budget > 4000 {
            break;
        }
        let Ok(name) = e.file_name().into_string() else { continue };
        let Ok(ft) = e.file_type() else { continue };
        let full = join(&[dir, &name]);
        if ft.is_file() && name.to_lowercase().ends_with(".exe") && !EXE_SKIP.is_match(&name) {
            let size = e.metadata().map(|m| m.len()).unwrap_or(0) as f64;
            let score = similarity(&stem(&name), folder_name) * 3.0 + (size / 50e6).min(1.0) - depth as f64 * 0.5;
            if best.as_ref().is_none_or(|b| score > b.score) {
                best = Some(BestExe { file: full, score });
            }
        } else if ft.is_dir() && depth < 2 && !SKIP_DIRS.is_match(&name) {
            if let Some(sub) = best_exe_in(&full, folder_name, depth + 1, budget) {
                if best.as_ref().is_none_or(|b| sub.score > b.score) {
                    best = Some(sub);
                }
            }
        }
    }
    best
}

/// Scan a folder for game shortcuts (.lnk/.url/.exe/.bat). Sub-folders that
/// contain shortcuts are scanned too; sub-folders without shortcuts are treated
/// as game install folders and the best executable inside is picked.
pub fn scan_folder(folder: &str) -> Vec<Value> {
    let mut games = Vec::new();
    let Ok(read) = fs::read_dir(folder) else { return games };
    let entries: Vec<(String, fs::FileType)> = read.flatten().filter_map(|e| Some((e.file_name().into_string().ok()?, e.file_type().ok()?))).collect();
    let mut extra = Map::new();
    extra.insert("folder".into(), json!(folder));

    for (name, ft) in &entries {
        let ext = extname(name);
        if !ft.is_file() || ![".lnk", ".url", ".exe", ".bat", ".cmd"].contains(&ext.as_str()) {
            continue;
        }
        if ext == ".exe" && EXE_SKIP.is_match(name) {
            continue;
        }
        if let Some(g) = describe_file(&join(&[folder, name]), &extra) {
            games.push(g);
        }
    }

    for (name, ft) in &entries {
        if !ft.is_dir() || name.starts_with('.') || name.starts_with('$') {
            continue;
        }
        let full = join(&[folder, name]);
        let Ok(sub) = fs::read_dir(&full) else { continue };
        let shortcuts: Vec<String> = sub
            .flatten()
            .filter(|s| s.file_type().is_ok_and(|t| t.is_file()))
            .filter_map(|s| s.file_name().into_string().ok())
            .filter(|n| matches!(extname(n).as_str(), ".lnk" | ".url"))
            .collect();
        if !shortcuts.is_empty() {
            for s in shortcuts {
                if let Some(g) = describe_file(&join(&[&full, &s]), &extra) {
                    games.push(g);
                }
            }
            continue;
        }
        if let Some(best) = find_best_exe(&full, name) {
            games.push(json!({
                "id": hash_id("dir", &full),
                "name": tidy_name(name),
                "path": full,
                "folder": folder,
                "source": "folder",
                "exe": best.file,
                "installDir": full,
                "launch": launch_exe(&best.file, "", &dirname(&best.file)),
            }));
        }
    }
    games
}

/* ------------------------------------------------------------------ */
/* Steam                                                               */
/* ------------------------------------------------------------------ */

pub fn find_steam_path() -> Option<String> {
    let reg = reg_value(HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath");
    let candidates = [reg, Some(r"C:\Program Files (x86)\Steam".into()), Some(r"C:\Program Files\Steam".into())];
    candidates.into_iter().flatten().map(|c| normalize(&c)).find(|p| Path::new(&join(&[p, "steamapps"])).exists())
}

#[derive(Default)]
pub struct SteamUser {
    pub persona: Option<String>,
    /// appid -> (minutes, lastPlayed ms)
    pub playtime: HashMap<String, (i64, i64)>,
}

fn num(v: Option<&str>) -> i64 {
    v.and_then(|s| s.trim().parse::<f64>().ok()).filter(|n| n.is_finite()).map(|n| n as i64).unwrap_or(0)
}

pub fn read_steam_user(steam_path: &str) -> SteamUser {
    let mut out = SteamUser::default();
    let mut account_id: Option<String> = None;
    if let Some(lu) = read_text(&join(&[steam_path, "config", "loginusers.vdf"])) {
        let root = vdf::parse(&lu);
        if let Some(users) = vdf::get_ci(&root, &["users"]).and_then(|u| u.as_object()) {
            let mut pick: Option<(&String, &Value)> = None;
            for (id64, u) in users {
                if pick.is_none() || vdf::str_ci(u, &["MostRecent"]) == Some("1") {
                    pick = Some((id64, u));
                }
            }
            if let Some((id64, u)) = pick {
                if let Ok(n) = id64.parse::<u64>() {
                    account_id = n.checked_sub(76561197960265728).map(|a| a.to_string());
                }
                out.persona = vdf::str_ci(u, &["PersonaName"]).map(str::to_string);
            }
        }
    }

    let mut file = account_id.map(|a| join(&[steam_path, "userdata", &a, "config", "localconfig.vdf"]));
    if !file.as_deref().is_some_and(exists) {
        // Fall back to the most recently written localconfig.
        let mut newest = std::time::SystemTime::UNIX_EPOCH;
        if let Ok(dirs) = fs::read_dir(join(&[steam_path, "userdata"])) {
            for d in dirs.flatten() {
                let f = join(&[steam_path, "userdata", &d.file_name().to_string_lossy(), "config", "localconfig.vdf"]);
                if let Ok(m) = fs::metadata(&f).and_then(|m| m.modified()) {
                    if m > newest {
                        newest = m;
                        file = Some(f);
                    }
                }
            }
        }
    }
    if let Some(text) = file.as_deref().and_then(read_text) {
        let root = vdf::parse(&text);
        if let Some(apps) = vdf::get_ci(&root, &["UserLocalConfigStore", "Software", "Valve", "Steam", "apps"]).and_then(|a| a.as_object()) {
            for (appid, a) in apps {
                if !a.is_object() {
                    continue;
                }
                let minutes = num(vdf::str_ci(a, &["Playtime"]));
                let last = num(vdf::str_ci(a, &["LastPlayed"])) * 1000;
                if minutes != 0 || last != 0 {
                    out.playtime.insert(appid.clone(), (minutes, last));
                }
            }
        }
    }
    out
}

pub struct SteamScan {
    pub path: String,
    pub persona: Option<String>,
    pub games: Vec<Value>,
}

pub fn scan_steam() -> Option<SteamScan> {
    let steam_path = find_steam_path()?;
    let mut libs = vec![steam_path.clone()];
    if let Some(lf) = read_text(&join(&[&steam_path, "steamapps", "libraryfolders.vdf"])) {
        let root = vdf::parse(&lf);
        if let Some(folders) = vdf::get_ci(&root, &["libraryfolders"]).and_then(|v| v.as_object()) {
            for v in folders.values() {
                let p = match v {
                    Value::Object(_) => vdf::str_ci(v, &["path"]).map(str::to_string),
                    Value::String(s) if s.contains(['\\', '/']) => Some(s.clone()),
                    _ => None,
                };
                if let Some(p) = p.map(|p| normalize(&p)) {
                    if !libs.contains(&p) {
                        libs.push(p);
                    }
                }
            }
        }
    }

    let user = read_steam_user(&steam_path);
    let steam_exe = join(&[&steam_path, "steam.exe"]);
    let mut games = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for lib in &libs {
        let dir = join(&[lib, "steamapps"]);
        let Ok(files) = fs::read_dir(&dir) else { continue };
        let mut names: Vec<String> = files.flatten().filter_map(|f| f.file_name().into_string().ok()).collect();
        names.sort();
        for f in names {
            let lower = f.to_lowercase();
            if !(lower.starts_with("appmanifest_") && lower.ends_with(".acf") && lower[12..lower.len() - 4].chars().all(|c| c.is_ascii_digit())) {
                continue;
            }
            let Some(text) = read_text(&join(&[&dir, &f])) else { continue };
            let root = vdf::parse(&text);
            let Some(st) = vdf::get_ci(&root, &["AppState"]) else { continue };
            let appid = vdf::str_ci(st, &["appid"]).unwrap_or("").to_string();
            let name = tidy_name(vdf::str_ci(st, &["name"]).unwrap_or(""));
            if appid.is_empty() || name.is_empty() || seen.contains(&appid) {
                continue;
            }
            if STEAM_EXCLUDED_IDS.contains(&appid.as_str()) || STEAM_EXCLUDED_NAMES.is_match(&name) {
                continue;
            }
            seen.insert(appid.clone());
            let (minutes, last) = user.playtime.get(&appid).copied().unwrap_or((0, 0));
            let manifest_last = num(vdf::str_ci(st, &["LastPlayed"])) * 1000;
            games.push(json!({
                "id": format!("steam-{appid}"),
                "name": name,
                "source": "steam",
                "steamAppId": appid,
                "installDir": join(&[&dir, "common", vdf::str_ci(st, &["installdir"]).unwrap_or("")]),
                "sizeOnDisk": num(vdf::str_ci(st, &["SizeOnDisk"])),
                "launch": { "type": "steam", "appid": appid, "steamExe": steam_exe, "target": format!("steam://rungameid/{appid}") },
                "steamPlaytime": minutes,
                "steamLastPlayed": if last != 0 { last } else { manifest_last },
            }));
        }
    }
    Some(SteamScan { path: steam_path, persona: user.persona, games })
}

/* ------------------------------------------------------------------ */
/* Epic Games                                                          */
/* ------------------------------------------------------------------ */

pub fn scan_epic() -> Option<Vec<Value>> {
    let mut dir = r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests".to_string();
    if let Some(reg) = reg_value(HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Epic Games\EpicGamesLauncher", "AppDataPath") {
        let m = join(&[&reg, "Manifests"]);
        if exists(&m) {
            dir = m;
        }
    }
    let files = fs::read_dir(&dir).ok()?;
    let mut names: Vec<String> = files.flatten().filter_map(|f| f.file_name().into_string().ok()).collect();
    names.sort();
    let mut games = Vec::new();
    for f in names {
        if !f.to_lowercase().ends_with(".item") {
            continue;
        }
        let Some(text) = read_text(&join(&[&dir, &f])) else { continue };
        let Ok(j) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else { continue };
        let s = |k: &str| j.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let cats = j.get("AppCategories").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        if !cats.iter().any(|c| c == "games") || j.get("bIsIncompleteInstall").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let app_name = s("AppName");
        let main = s("MainGameAppName");
        if !main.is_empty() && main != app_name {
            continue; // DLC
        }
        let loc = s("InstallLocation");
        if loc.is_empty() || !exists(&loc) {
            continue;
        }
        let uri = format!(
            "com.epicgames.launcher://apps/{}%3A{}%3A{}?action=launch&silent=true",
            encode_uri_component(&s("CatalogNamespace")),
            encode_uri_component(&s("CatalogItemId")),
            encode_uri_component(&app_name)
        );
        let launch_exe = s("LaunchExecutable");
        let exe = (!launch_exe.is_empty()).then(|| join(&[&loc, &launch_exe]));
        // Started without the Epic launcher, the game gets the arguments Epic
        // would pass, minus the sign-in. Fine for games that run offline.
        let direct = exe.as_ref().map(|e| {
            json!({
                "target": e,
                "args": format!("{} -epicapp={app_name} -epicenv=Prod -EpicPortal", s("LaunchCommand").trim()).trim().to_string(),
                "cwd": dirname(e),
            })
        });
        let owner_token = match j.get("OwnershipToken") {
            Some(Value::String(t)) => t.clone(),
            Some(Value::Bool(b)) => b.to_string(),
            _ => String::new(),
        };
        games.push(json!({
            "id": format!("epic-{app_name}"),
            "name": tidy_name(&s("DisplayName")),
            "source": "epic",
            "installDir": loc,
            "exe": exe,
            "launch": { "type": "uri", "target": uri },
            "direct": direct,
            "directSafe": j.get("bCanRunOffline").and_then(|v| v.as_bool()).unwrap_or(false) && owner_token != "true",
        }));
    }
    Some(games)
}

/* ------------------------------------------------------------------ */
/* Ubisoft Connect                                                     */
/* ------------------------------------------------------------------ */

/// (found, games)
pub fn scan_ubisoft() -> (bool, Vec<Value>) {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut installs: Vec<(String, String)> = Vec::new();
    for root in [r"SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs", r"SOFTWARE\Ubisoft\Launcher\Installs"] {
        let Ok(key) = hklm.open_subkey(root) else { continue };
        for id in key.enum_keys().flatten() {
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) || installs.iter().any(|(i, _)| *i == id) {
                continue;
            }
            if let Ok(dir) = key.open_subkey(&id).and_then(|k| k.get_value::<String, _>("InstallDir")) {
                if !dir.is_empty() {
                    installs.push((id, normalize(&dir)));
                }
            }
        }
    }
    if installs.is_empty() {
        let client = reg_value(HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Ubisoft\Launcher", "InstallDir");
        return (client.is_some(), Vec::new());
    }
    // Display names live in the uninstall entries ("Uplay Install <id>").
    let mut names: HashMap<String, String> = HashMap::new();
    if let Ok(un) = hklm.open_subkey(r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall") {
        for k in un.enum_keys().flatten() {
            let Some(id) = k.strip_prefix("Uplay Install ").filter(|id| id.chars().all(|c| c.is_ascii_digit())) else { continue };
            if let Ok(name) = un.open_subkey(&k).and_then(|s| s.get_value::<String, _>("DisplayName")) {
                names.insert(id.to_string(), name);
            }
        }
    }
    let mut games = Vec::new();
    for (id, dir) in installs {
        let dir = dir.trim_end_matches(['\\', '/']).to_string();
        if !exists(&dir) {
            continue;
        }
        let name = tidy_name(names.get(&id).map(String::as_str).unwrap_or(&basename(&dir)));
        static TOM_CLANCY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^tom clancy'?s\s+").unwrap());
        let best = find_best_exe(&dir, &TOM_CLANCY.replace(&name, ""));
        games.push(json!({
            "id": format!("ubisoft-{id}"),
            "name": name,
            "source": "ubisoft",
            "installDir": dir,
            "exe": best.as_ref().map(|b| b.file.clone()),
            "launch": { "type": "uri", "target": format!("uplay://launch/{id}/0") },
            "direct": best.as_ref().map(|b| json!({ "target": b.file, "args": "", "cwd": dirname(&b.file) })),
            "directSafe": false, // Ubisoft games always need Ubisoft Connect running
        }));
    }
    (true, games)
}

/* ------------------------------------------------------------------ */
/* Xbox / Microsoft Store (PC Game Pass)                               */
/* ------------------------------------------------------------------ */

// Installed packages that ship a MicrosoftGame.config are games. The package
// folder under WindowsApps is usually a junction into <drive>:\XboxGames.
const XBOX_PS: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out = @()
foreach ($p in Get-AppxPackage) {
  $loc = $p.InstallLocation
  if (-not $loc) { continue }
  $cfg = Join-Path $loc 'MicrosoftGame.config'
  if (-not (Test-Path -LiteralPath $cfg)) { continue }
  $m = Get-AppxPackageManifest $p
  $apps = @($m.Package.Applications.Application | ForEach-Object { $_.Id })
  $real = (Get-Item -LiteralPath $loc).Target
  if ($real -is [array]) { $real = $real[0] }
  $out += [pscustomobject]@{ family = $p.PackageFamilyName; pkg = $p.Name; apps = $apps; loc = $loc; real = $real; config = [IO.File]::ReadAllText($cfg) }
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
"#;

pub fn powershell(script: &str) -> String {
    use base64::Engine;
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let enc = base64::engine::general_purpose::STANDARD.encode(utf16);
    Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &enc])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

fn xml_attr(xml: &str, tag: &str, attr: &str) -> Option<String> {
    let re = Regex::new(&format!(r#"(?i)<{tag}\b[^>]*\b{attr}="([^"]*)""#)).ok()?;
    re.captures(xml).map(|c| c[1].to_string())
}

/// (found, games)
pub fn scan_xbox() -> (bool, Vec<Value>) {
    let raw = powershell(XBOX_PS);
    let list = match serde_json::from_str::<Value>(raw.trim().trim_start_matches('\u{feff}')) {
        Ok(Value::Array(a)) => a,
        Ok(v @ Value::Object(_)) => vec![v],
        Ok(_) => Vec::new(),
        Err(_) if raw.trim().is_empty() => Vec::new(),
        Err(_) => return (false, Vec::new()),
    };
    static EXE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<Executable\b([^>]*)/?>").unwrap());
    static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\bName="([^"]+)""#).unwrap());
    static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\bId="([^"]+)""#).unwrap());
    static STORE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<StoreId>([^<]+)</StoreId>").unwrap());
    static CAMEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([a-z])([A-Z])").unwrap());
    let mut games = Vec::new();
    for it in &list {
        let s = |k: &str| it.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let (family, xml) = (s("family"), s("config"));
        if family.is_empty() || xml.is_empty() {
            continue;
        }
        let exes: Vec<(Option<String>, Option<String>)> = EXE
            .captures_iter(&xml)
            .map(|m| (NAME.captures(&m[1]).map(|c| c[1].to_string()), ID.captures(&m[1]).map(|c| c[1].to_string())))
            .collect();
        let apps: Vec<String> = match it.get("apps") {
            Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
            Some(Value::String(a)) if !a.is_empty() => vec![a.clone()],
            _ => Vec::new(),
        };
        let exe = exes.iter().find(|(_, id)| id.as_ref().is_some_and(|i| apps.contains(i))).or(exes.first());
        let exe_id = exe.and_then(|e| e.1.clone());
        let app_id = match exe_id {
            Some(id) if apps.contains(&id) => Some(id),
            _ => apps.first().cloned(),
        };
        let Some(app_id) = app_id else { continue };
        let mut name = xml_attr(&xml, "ShellVisuals", "DefaultDisplayName").unwrap_or_default();
        if name.is_empty() || name.to_lowercase().starts_with("ms-resource:") {
            let pkg = s("pkg");
            name = CAMEL.replace_all(pkg.rsplit('.').next().unwrap_or(""), "$1 $2").into_owned();
        }
        let (real, loc) = (s("real"), s("loc"));
        let dir = resolve(if !real.is_empty() && exists(&real) { &real } else { &loc });
        let alt: Vec<String> = if !loc.is_empty() && resolve(&loc) != dir { vec![resolve(&loc)] } else { Vec::new() };
        let pkg_or_family = if s("pkg").is_empty() { family.clone() } else { s("pkg") };
        games.push(json!({
            "id": format!("xbox-{}", pkg_or_family.to_lowercase()),
            "name": tidy_name(&name),
            "source": "xbox",
            "installDir": dir,
            // Package processes can report either path.
            "altDirs": alt,
            "exe": exe.and_then(|e| e.0.as_ref()).map(|n| join(&[&dir, n])),
            "storeId": STORE_ID.captures(&xml).map(|c| c[1].to_string()),
            // Packaged games are started by Windows itself: no Xbox app involved.
            "launch": { "type": "aumid", "target": format!("{family}!{app_id}") },
        }));
    }
    (true, games)
}
