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
- [ ] Launching + game monitor (`launcher.js`, `gamemonitor.js`): starting screen, anti-cheat splash handling, pausing
- [ ] Native helper (`system.js` + `native/syshelper.exe`): run as a sidecar first; media, volume, outputs, brightness, night light, Bluetooth, controller, passthrough
- [ ] In-game overlay window (`overlay.js`): transparent, always on top, focus handling, pop-ups
- [ ] Discord RPC (`discord.js`): named pipe, OAuth, voice, notifications, messages
- [ ] Sound store (`soundpacks.js`): browse, download, unzip, install from file/folder, remove
- [ ] Global shortcut, autostart, single instance, power actions
- [ ] Drag-and-drop of games onto the window
- [ ] Custom title bar (Electron's `titleBarOverlay`)

Phase 3 – finish
- [ ] Replace the C# helper with Rust (`windows` crate), optional
- [ ] NSIS installer, icons, version info (Aris)
- [ ] Remove `main/`, Electron and electron-builder
