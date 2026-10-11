//! Where the launcher keeps its files.
//!
//! Release builds use the same folder as the Electron version
//! (%APPDATA%\PS5 Game Launcher), so switching over keeps the library,
//! settings and artwork. Debug builds use their own folder and fill it once
//! with a copy of the Electron data, so development never touches the real
//! files.

use std::{
    fs,
    path::{Path, PathBuf},
};

fn appdata() -> PathBuf {
    PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default())
}

pub fn data_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        appdata().join("PS5 Game Launcher (Tauri dev)")
    } else {
        appdata().join("PS5 Game Launcher")
    }
}

pub struct Dirs {
    pub data: PathBuf,
    pub art: PathBuf,
    pub avatars: PathBuf,
    pub sounds: PathBuf,
}

impl Dirs {
    pub fn new(data: PathBuf) -> Self {
        Self {
            art: data.join("artwork"),
            avatars: data.join("avatars"),
            sounds: data.join("soundpacks"),
            data,
        }
    }
}

/// Debug builds only: copy the Electron version's data the first time.
pub fn import_electron_data(dir: &Path) {
    if !cfg!(debug_assertions) || dir.exists() {
        return;
    }
    let src = appdata().join("PS5 Game Launcher");
    let _ = fs::create_dir_all(dir);
    if !src.exists() {
        return;
    }
    for f in ["settings.json", "library.json", "discord.json"] {
        let _ = fs::copy(src.join(f), dir.join(f));
    }
    for d in ["artwork", "avatars", "soundpacks"] {
        copy_dir(&src.join(d), &dir.join(d));
    }
}

fn copy_dir(from: &Path, to: &Path) {
    let Ok(entries) = fs::read_dir(from) else { return };
    let _ = fs::create_dir_all(to);
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            copy_dir(&p, &to.join(e.file_name()));
        } else {
            let _ = fs::copy(&p, to.join(e.file_name()));
        }
    }
}
