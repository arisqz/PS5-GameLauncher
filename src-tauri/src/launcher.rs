//! Starting games (port of main/launcher.js).
//!
//! How a game starts:
//!  - "direct": its own .exe, no store client involved (Xbox games are always
//!    started directly by Windows);
//!  - "store": through its store client, kept hidden where the store allows it
//!    (Steam starts silently in the tray, Epic with silent=true).
//!
//! game.launchMode is the per-game choice ("auto" | "direct" | "store").
//! "auto" goes direct for games that are known to run without their store
//! when "Start Games Directly" is on.

use crate::system::SystemBridge;
use crate::util::{dirname, exists};
use crate::{library, scanner};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

fn can_direct(g: &Value) -> bool {
    g["direct"]["target"].as_str().is_some_and(|t| !t.is_empty()) || (g["source"] == "steam" && g["installDir"].as_str().is_some_and(|d| !d.is_empty()))
}

pub fn launch_mode(g: &Value, prefer_direct: bool) -> &'static str {
    let want = g["launchMode"].as_str().unwrap_or("auto");
    if want == "direct" && can_direct(g) {
        return "direct";
    }
    if want == "store" {
        return "store";
    }
    if prefer_direct && g["directSafe"] == true && can_direct(g) {
        return "direct";
    }
    "store"
}

/// The game's own executable for a direct start (found and remembered on
/// first use for Steam).
async fn direct_target(app: &AppHandle, g: &Value) -> Result<Value, String> {
    if g["direct"]["target"].as_str().is_some_and(exists) {
        return Ok(g["direct"].clone());
    }
    if let Some(dir) = g["installDir"].as_str().filter(|d| exists(d)).map(str::to_string) {
        let name = g["name"].as_str().unwrap_or("").to_string();
        if let Ok(Some(best)) = tauri::async_runtime::spawn_blocking(move || scanner::find_best_exe(&dir, &name)).await {
            let direct = json!({ "target": best.file, "args": "", "cwd": dirname(&best.file) });
            library::set_field(app, g["id"].as_str().unwrap_or(""), "direct", direct.clone());
            return Ok(direct);
        }
    }
    Err("Couldn't find the game's executable. Choose Launch Method › Through the Store instead.".into())
}

async fn helper_launch(sys: &Arc<SystemBridge>, file: &str, args: &str, cwd: &str) -> Result<Value, String> {
    sys.request("launch", json!({ "file": file, "args": args, "cwd": cwd }), 30000).await.map_err(|e| {
        if e.to_lowercase().contains("cancel") {
            "The launch was cancelled.".to_string()
        } else {
            e
        }
    })
}

/// Launch a game. Play time, "running" state and returning to the launcher
/// are handled by the game monitor, which also sees games started through
/// Steam / Epic.
pub async fn launch_game(app: &AppHandle, sys: &Arc<SystemBridge>, g: &Value, prefer_direct: bool) -> Result<Value, String> {
    let launch_args = g["launchArgs"].as_str().unwrap_or("");
    let mut l = g["launch"].clone();
    let kind = l["type"].as_str().unwrap_or("").to_string();
    if launch_mode(g, prefer_direct) == "direct" && kind != "exe" && kind != "aumid" {
        let d = direct_target(app, g).await?;
        let args = format!("{} {launch_args}", d["args"].as_str().unwrap_or("")).trim().to_string();
        l = json!({ "type": "exe", "target": d["target"], "args": args, "cwd": d["cwd"] });
    }
    let target = l["target"].as_str().unwrap_or("").to_string();
    let helper = sys.available();
    match l["type"].as_str().unwrap_or("") {
        // Xbox / Microsoft Store games: Windows starts the package by its app id.
        "aumid" => {
            let shell_target = format!("shell:AppsFolder\\{target}");
            let windir = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
            if helper {
                helper_launch(sys, "explorer.exe", &shell_target, &windir).await?;
            } else {
                app.opener().open_path(shell_target, None::<&str>).map_err(|e| e.to_string())?;
            }
            Ok(json!({ "tracked": false }))
        }
        // Steam: steam.exe -silent -applaunch starts the game without ever
        // showing the Steam window (Steam itself stays in the tray, which games need).
        "steam" => {
            let steam_exe = l["steamExe"].as_str().unwrap_or("");
            if helper && exists(steam_exe) {
                let args = format!("-silent -applaunch {}{}", l["appid"].as_str().unwrap_or(""), if launch_args.is_empty() { String::new() } else { format!(" {launch_args}") });
                helper_launch(sys, steam_exe, &args, &dirname(steam_exe)).await?;
            } else {
                app.opener().open_url(target, None::<&str>).map_err(|e| e.to_string())?;
            }
            Ok(json!({ "tracked": false }))
        }
        // Executables start through the Windows shell (via the helper): the game
        // inherits nothing from the launcher and UAC prompts work normally.
        "exe" => {
            if !exists(&target) {
                return Err(format!("Executable not found: {target}"));
            }
            let cwd = l["cwd"].as_str().filter(|c| exists(c)).map(str::to_string).unwrap_or_else(|| dirname(&target));
            if helper {
                let pid = helper_launch(sys, &target, l["args"].as_str().unwrap_or(""), &cwd).await?;
                return Ok(json!({ "tracked": false, "pid": pid }));
            }
            app.opener().open_path(target, None::<&str>).map_err(|e| e.to_string())?;
            Ok(json!({ "tracked": false }))
        }
        "uri" => {
            app.opener().open_url(target, None::<&str>).map_err(|e| e.to_string())?;
            Ok(json!({ "tracked": false }))
        }
        "shell" => {
            app.opener().open_path(target, None::<&str>).map_err(|e| e.to_string())?;
            Ok(json!({ "tracked": false }))
        }
        _ => Err("This entry has no launch target.".into()),
    }
}
