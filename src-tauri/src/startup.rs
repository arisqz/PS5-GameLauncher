//! "Start with Windows" (Settings › System › Startup): the per-user Run key,
//! like Electron's app.setLoginItemSettings.

use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const NAME: &str = "PS5 Game Launcher";

pub fn set(enabled: bool) -> Result<(), String> {
    let (run, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN).map_err(|e| e.to_string())?;
    // Release builds: an entry the Electron version left behind (other name,
    // same program) would start the old launcher too.
    if !cfg!(debug_assertions) {
        for (name, value) in run.enum_values().flatten() {
            if name != NAME && value.to_string().to_lowercase().contains("ps5 game launcher.exe") {
                let _ = run.delete_value(&name);
            }
        }
    }
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        run.set_value(NAME, &format!("\"{}\"", exe.display())).map_err(|e| e.to_string())
    } else {
        match run.delete_value(NAME) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}
