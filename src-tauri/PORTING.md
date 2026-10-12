# Tauri port

The `tauri-port` branch moves the launcher from Electron to Tauri 2 (Rust).
The interface in `renderer/` is shared and stays almost unchanged.

## How it fits together

| Electron (`main/`)                     | Tauri (`src-tauri/`)                              |
| -------------------------------------- | ------------------------------------------------- |
| `preload.js` exposes `window.api`      | `renderer/js/bridge.js` builds the same `window.api` |
| `ipcMain.handle('channel', …)`         | a `match` arm in `src/ipc.rs` (same channel names) |
| `webContents.send('event', …)`         | `window.emit("event", …)` / `app.emit(…)`          |
| `protocol.handle('app')`               | `src/protocol.rs` (WebView2 sees `http://app.localhost/…`) |
| `store.js` (`JsonStore`)               | `src/store.rs`                                     |
| `DEFAULT_SETTINGS` in `main.js`        | `src/default_settings.json`                        |

Renderer code builds `app://…` URLs through `window.appUrl()`, which is a
no-op in Electron and rewrites them for Tauri.

## Running

```
npm run tauri:dev      # debug build + window (DevTools protocol on port 9334)
npm run tauri:build    # release build + NSIS installer
npm start              # the Electron version, still here as the reference
```

Debug builds leave out debug info for dependencies (`[profile.dev]` in Cargo.toml), which keeps
`target/` around 2 GB instead of 8+ GB.

Debug builds keep their data in `%APPDATA%\PS5 Game Launcher (Tauri dev)`,
copied once from the Electron folder. Release builds use the real
`%APPDATA%\PS5 Game Launcher`, so users keep their library when they switch.

Channels the UI calls that aren't ported yet are printed as
`[ipc] not ported yet: …` in the debug console.

## Status

Phase 1 – runs on the shared UI
- [x] Window, fullscreen, window state events
- [x] `state:get`, `info:get`, `settings:set`, `window:action`
- [x] app:// protocol (artwork, avatars, sound files)
- [x] `sounds:list`

Phase 2 – logic in Rust
- [x] Library + store scanners (`library.rs`, `scanner.rs`, `vdf.rs`): Steam, Epic, Xbox, Ubisoft, shortcut folders.
      Checked against the Electron scan: same 24 games, ids and launch data.
- [x] Artwork / metadata (`metadata.rs`): Steam store, SteamGridDB, Steam's local cache, exe icons (`winapi.rs`)
- [x] Library actions: add/remove folder, add files, import, remove/restore, reset, custom art, re-match, refresh, cache size, Steam play time
- [x] File dialogs (`tauri-plugin-dialog`), open folders / links (`tauri-plugin-opener`), profile pictures
- [x] Launching + game monitor (`launcher.rs`, `monitor.rs`, `games.rs`): Starting… cover, anti-cheat splash handling,
      continue, close, pausing while the launcher is in front. Tested with a dummy game: detected, paused, resumed, closed.
- [x] Native helper (`system.rs`): syshelper.exe as a child process (bundled as a resource in release);
      media, volume, outputs, brightness, night light, Bluetooth, power
- [x] Controller (`controller.rs`): Guide / PS button and Ctrl+Alt+Home (`tauri-plugin-global-shortcut`), buttons forwarded
      to the overlay, passthrough (`passthrough:*`, `pad:fallback`). Tested: shortcut opens / closes the quick menu.
      Not tested yet with a real controller or with passthrough on (needs HidHide, admin).
- Note: launcher focus comes from the foreground window (checked every 250 ms), not Tauri's Focused event,
  which misses the window coming back because WebView2's child window takes the focus.
- [x] In-game overlay window (`overlay.rs`): transparent, always on top, on the game's monitor, takes focus and gives it
      back, click-through pop-ups. Shown and hidden with plain Win32 calls (no activation), not Tauri's show/hide.
- [x] Discord RPC (`discord.rs`): named pipe, OAuth + token refresh, voice, notifications, chats.
      Tested: pipe + handshake with the running Discord. Sign-in / voice need a person to approve in Discord.
      Secrets (`secure.rs`): new ones with DPAPI; Electron's safeStorage values are still read (tested).
- [x] Sound store (`soundpacks.rs`): browse, download, unzip, install from file/folder, remove. Tested: browse, download, remove.
- [x] Start with Windows (`startup.rs`, HKCU Run key) and single instance (`tauri-plugin-single-instance`). Tested.
- [x] Drag-and-drop of games onto the window (Tauri drop events via `api.onFileDrop`). Not tested by hand yet.
- [x] Frameless window: the title strip gets Windows-style buttons and is draggable (`data-tauri-drag-region`);
      F11 full screen; closing the window quits (the overlay would keep the app alive). Tested.

Phase 3 – finish
- [ ] Replace the C# helper with Rust (`windows` crate), optional
- [x] NSIS installer, icons, version info (Aris): `npm run tauri:build` →
      `src-tauri/target/release/bundle/nsis/PS5 Game Launcher_1.0.0_x64-setup.exe` (3.2 MB; Electron's was ~100 MB)
- [ ] Remove `main/`, Electron and electron-builder
