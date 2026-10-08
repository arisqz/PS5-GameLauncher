# PS5 Game Launcher

A controller-first game launcher for Windows with a PS5-style interface: the welcome screen, the home carousel, the quick menu, the in-game overlay and the settings pages all look and move like the console's. It finds your Steam, Epic and shortcut-folder games, fetches their artwork, and starts them full screen.

Built with Electron and plain HTML, CSS and JavaScript (no framework, no build step), plus a small native helper for the Windows features a browser can't reach.

> Not affiliated with or endorsed by Sony Interactive Entertainment. "PlayStation" and "PS5" are trademarks of Sony Interactive Entertainment Inc. Game artwork belongs to its respective owners.

## Features

- **Welcome screen**: a spotlight with drifting particles, "Welcome Back", and a row of users to pick from. Choosing a user clears the scene and the home screen builds itself: the tiles grow out of the middle, the game art fades in, and the top bar drops into place.
- **Home carousel**: the selected game tile is enlarged, its art fills the screen, and the logo, description, **Play Game**, **…** (options) and activity cards sit below it.
- **Game Library**: the last tile on the carousel, with Your Collection, Favorites, Media and Hidden tabs, sorting and filtering.
- **Quick menu** on the controller's Guide / PS button (or Home / F1): the current game, now playing, notifications, and panels for Sound, Screen, Bluetooth, Accessories, Party, Power and more. **Customize** chooses what it shows.
- **In-game overlay**: the same quick menu on top of a running game, with **Close Game**. While it's open, games without anti-cheat are paused.
- **Continue**: when a game is running, Play becomes Continue and brings it back to the front. Only one game runs at a time.
- **Settings**: a two-pane page per category, PS5 style, over the animated theme background. It starts with a **User Guide** that walks through connecting Discord, setting up SteamGridDB artwork, and what to do when a monitor doesn't show up in Brightness.
- **Languages**: English, Deutsch, Español, Português and Français (**Settings › System › Language**). By default it follows the Windows language.
- **Windows controls**:
  - media playing anywhere on the PC, with cover art;
  - system volume and mute;
  - the **output device** (Windows playback device);
  - monitor brightness over DDC/CI, listed by monitor name;
  - Night Light;
  - Bluetooth: pairing, connecting and removing devices.
- **Party (Discord)**: see who's in your voice call, mute, deafen, leave, and set volumes.
- **Focus effects**: the selected item gets a ring with a light travelling around it, and a glint sweeps across it after a moment.
- Synthesized UI sounds, an optional ambient music track, and an on-screen keyboard.

## Download

Get the latest build from the **Releases** page:

- `PS5-Game-Launcher-Setup-x.y.z.exe`: an installer with Start menu and desktop shortcuts. Recommended.
- `PS5-Game-Launcher-x.y.z-win-x64.zip`: no installation. Unzip it anywhere and run `PS5 Game Launcher.exe`.

It runs on Windows 10 and 11 (64-bit). The builds aren't code-signed, so Windows SmartScreen may say *"Windows protected your PC"* the first time. Choose **More info › Run anyway**.

## Building from source

You need [Node.js](https://nodejs.org) 20 or newer on Windows.

```bash
npm install
npm start
```

- `npm run dev` adds DevTools (F12) and Ctrl+R reload. Append `-- --windowed` to start in a window instead of full screen.
- `npm run dist` builds the installer and the zip into `dist/`.
- `npm run dist:dir` builds just the unpacked app (`dist/win-unpacked`), which is quicker for testing.

The native helper (`main/native/syshelper.exe`) is compiled automatically from `syshelper.cs` before `start`, `dev` and `dist`. It uses the C# compiler that ships with Windows, so no Visual Studio or .NET SDK is needed. To rebuild it by hand, run `npm run build:native`.

## Adding games

Games come from five places. All of them are rescanned at startup, and you can turn each one on or off in **Settings › Library**.

| Source | How it is found |
| --- | --- |
| **Shortcut folders** | **Settings › Library › Add Folder…** (or drag a folder onto the window). Picks up `.lnk`, `.url` (including `steam://rungameid/…`), `.exe`, `.bat` and `.cmd` files. A sub-folder without shortcuts is treated as an install folder, and the most likely game `.exe` inside it is used. |
| **Steam** | Reads the install path from the registry, then `libraryfolders.vdf` and every `appmanifest_*.acf`. Play time and last played come from your Steam `localconfig.vdf`. |
| **Epic Games** | Reads the launcher's `.item` manifests. |
| **Xbox / Microsoft Store** | Finds installed game packages (PC Game Pass and Store games, the ones with a `MicrosoftGame.config`) through Windows. |
| **Ubisoft Connect** | Reads Ubisoft Connect's install list from the registry. |

You can also drag and drop shortcuts or executables anywhere on the window.

### Artwork

For each game the launcher looks up the matching Steam app (directly for Steam games, otherwise by searching the Steam store by name). From it, it downloads:

- the hero (the full-screen background);
- the logo;
- the banner and box art;
- the description, developer, publisher, release date and screenshots.

These come from Steam's public store API and CDN, so no account or key is needed.

Optional: add a free [SteamGridDB](https://www.steamgriddb.com/profile/preferences/api) API key in **Settings › Library › Artwork**. It gives better art for games that aren't on Steam.

If a game matched the wrong title, use **… › Change Artwork › Find on Steam…** to pick the right one. You can also set a custom tile, background or logo from an image file.

## Controls

| Action | Controller (Xbox / PlayStation) | Keyboard |
| --- | --- | --- |
| Move | D-pad / left stick | Arrow keys |
| Select | A / ✕ | Enter |
| Back | B / ○ | Esc / Backspace |
| Options (…) | Menu / Options | O or right-click |
| Quick menu | Guide / PS button | Home or F1 |
| In-game overlay | Guide / PS button | Ctrl+Alt+Home |
| Switch Games / Media tab | LB / RB, L1 / R1 | Q / E |
| Search | — | S |
| Full screen | — | F11 |

The mouse works too: click to select, the wheel scrolls the carousel, and right-click opens options.

## Users

The welcome screen lists your users. **Add User** creates another one, and **Options** on a user lets you rename it, choose a picture, change its colour or delete it. Users only have their own name and picture; games and settings are shared. You can turn the welcome screen off in **Settings › System**.

## When a game starts

**How games are started.** The launcher starts games as directly as each store allows:

- **Xbox / Microsoft Store:** Windows starts the game package itself, so the Xbox app doesn't open. Windows still checks for game updates first, and shows its own update window when one is needed.
- **Steam:** `steam.exe -silent -applaunch` starts the game. Steam has to run for its games, but it stays hidden in the tray and its window never opens.
- **Epic Games:** Epic's silent launch. The Epic launcher runs in the background without showing a window, so games still get their Epic sign-in.
- **Ubisoft Connect:** through Ubisoft Connect, which Ubisoft games need.
- **Shortcuts and executables:** started directly.

Each Steam, Epic or Ubisoft game also has **… › Launch Method**: *Automatic*, *Directly* (the game's own executable, without its store) or *Through the store*. **Settings › System › Game Launch › Start Games Directly** makes *Automatic* start Epic games that run offline directly. Online games usually need their store for sign-in, and some games restart themselves through their store. Fully direct Epic starts with sign-in, like Heroic does, would need you to log in to Epic inside the launcher; that isn't supported.


**Settings › System › Game Launch** chooses what the launcher does: minimize, stay open, or close. It waits until the game's window is actually on screen, so you never drop to the desktop while a game is still loading. When the game closes, the launcher comes back to the front (this can be turned off).

Many multiplayer games first show a small anti-cheat window (Easy Anti-Cheat, EA Javelin, BattlEye). Those don't count as the game. The Starting… screen stays on top until the real game window is up, so the anti-cheat window opens behind it. If something else needs you meanwhile, such as a store sign-in, an update or an anti-cheat error, the Starting… screen steps aside after a few seconds. Press Back to close it at any time.

## The native helper

The things Electron can't do on its own are handled by `main/native/syshelper.exe`, a small C# program that talks to the app over stdin/stdout:

- **Media:** Windows media sessions, the same source as the volume flyout.
- **Volume and output device:** Core Audio. Choosing an output device makes it the Windows default playback device.
- **Brightness:** DDC/CI, with WMI for laptop panels.
- **Night Light:** the same setting Windows' own toggle writes.
- **Bluetooth:** the Windows radio, pairing and audio-connection APIs.
- **Controllers:** the Guide / PS button, read passively through XInput and HID.
- **Games:** finding the running game, pausing it while a menu is open, bringing it to the front, and closing it.

If brightness shows "Not supported", turn on **DDC/CI** in your monitor's on-screen menu. It also doesn't work through some docks and KVM switches.

## In-game overlay

The overlay is a separate, transparent, always-on-top window. It is **not injected into the game**, and it never reads game memory or opens a handle to the game's process:

- the Guide button is read the way any controller utility reads it;
- the running game is found from the Windows process list;
- **Close Game** asks the game's windows to close, the same as clicking ✕, and ends the game only if it is still running five seconds later.

It shows over borderless and windowed games, and over most "fullscreen" games on Windows 10/11. Games in true exclusive fullscreen may minimize while it's open.

**Pausing.** Windows has no safe way to stop a game from reading the controller. So while a menu is in front of a running game, the launcher suspends the game's process and resumes it when you return. Games are never paused when:

- the game folder contains **anti-cheat** files (Easy Anti-Cheat, BattlEye, …);
- the game is **connected to a server** at that moment;
- the game started **less than 15 seconds** ago.

You can change this per game (**… › Pause in Menus**) or turn it off in Settings. If the launcher ever crashes, the helper resumes the game before it exits.

**Games that keep reacting to the controller.** While the menu is open, the overlay holds keyboard and window focus, so games that only read input while they are in front stop reacting. Some games read the controller even in the background. If such a game isn't paused (anti-cheat, online, or Pause in Menus set to Never), it still receives button presses: Windows has no way to hide a controller from one program without a driver. For emulators, use their own option to pause when the window is in the background, if they have one.

If the Guide button does nothing in games, check that Steam Input or the Xbox Game Bar isn't capturing it.

## Discord party setup

Discord only lets an application control your voice if you own that application, so you create your own once. It's free and takes about two minutes.

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Any name works.
2. Under **OAuth2**, copy the **Client ID**, reset and copy the **Client Secret**, and add the redirect `http://localhost`.
3. In the launcher, go to **Settings › Users and Accounts › Discord**, enter both values, and choose **Connect to Discord**.
4. Accept the **Authorize** prompt in Discord.

The secret and the sign-in token are stored encrypted for your Windows account.

## Your data

Settings, the library, cached artwork and profile pictures are kept in `%APPDATA%\PS5 Game Launcher`. **Settings › Storage** opens the folder.

If you used the launcher when it was still called *ClaudeLauncher*, its data folder is moved over automatically the first time you start this version.

## Troubleshooting

- **Nothing happens when I start it.** Check Task Manager for a running `PS5 Game Launcher.exe`. Only one copy runs at a time, and starting it again brings the running one to the front. If your antivirus quarantined `syshelper.exe`, restore it or add an exception. Media, volume, brightness, Bluetooth and the overlay need it.
- **"Windows protected your PC."** The builds aren't signed. Choose **More info › Run anyway**.
- **The window is off-screen or too big.** Press F11 to switch between full screen and a window.

## Project layout

```
main/                 Electron main process
  main.js             window, app:// protocol, IPC, launching and pausing games
  library.js          scanning → merge → metadata/artwork pipeline
  scanner.js          shortcut folders, Steam, Epic
  metadata.js         Steam store search, assets, SteamGridDB, downloads
  launcher.js         starting games
  gamemonitor.js      finds the running game, play time, closing games
  overlay.js          the in-game overlay window
  system.js           bridge to native/syshelper.exe
  discord.js          Discord voice control over Discord's local RPC pipe
  vdf.js              Valve KeyValues parser
  native/             syshelper.cs + build.cmd
renderer/
  index.html          the launcher
  overlay.html        the in-game overlay (js/overlay.js)
  css/                base, home, library, settings, quickmenu, overlays, boot
  js/app.js           router, input routing, settings → UI
  js/views/           boot (welcome), home, library, hub, settings (+ guide), quickmenu, search
  js/ui/              dialogs, on-screen keyboard, tiles, hero art, boot stage, toasts
  js/input.js         keyboard / gamepad / mouse → actions
  js/i18n.js          translations (js/locales/: de, es, fr, pt)
  js/system.js        media, volume, output device, brightness, Bluetooth state
  js/profiles.js      users on the welcome screen
  js/sound.js         synthesized UI sounds and ambient music
scripts/
  build-native.js     compiles the native helper when needed
```

## Translations

Interface text is written in English in the code and looked up by its English wording in `renderer/js/locales/<code>.js`. Anything without a translation falls back to English. To add a language, copy one of the locale files, translate the values, and add it to `TABLES` and `LANGUAGES` in `renderer/js/i18n.js`.

## License

[MIT](LICENSE)
