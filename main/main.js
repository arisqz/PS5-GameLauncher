const { app, BrowserWindow, ipcMain, protocol, net, shell, Menu, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const { JsonStore } = require('./store');
const { Library } = require('./library');
const { launchGame } = require('./launcher');
const { searchSteam } = require('./metadata');
const sgdb = require('./sgdb');
const { ThemeMusic, sanitizeChoice: themeChoice } = require('./thememusic');
const { YtDlp } = require('./ytdlp');
const { SystemBridge } = require('./system');
const { DiscordBridge } = require('./discord');
const { SteamFriends } = require('./steamfriends');
const { Updater } = require('./updater');
const { OverlayManager } = require('./overlay');
const { GameMonitor } = require('./gamemonitor');
const { SoundPacks } = require('./soundpacks');
const { ObsBridge } = require('./obs');
const { SteamDownloads } = require('./steamdownloads');
const { Storage } = require('./storage');
const files = require('./files');
const { gpuPreference } = require('./gpu');
const emulators = require('./emulators');

const DEFAULT_SETTINGS = {
  // Library
  folders: [],
  // Emulators, by platform: { switch: { exe, fullscreen } } (main/emulators.js)
  emulators: {},
  scanSteam: true,
  scanEpic: true,
  scanXbox: true,
  scanUbisoft: true,
  preferDirect: false,
  rescanOnStartup: true,
  // Steam updates start as soon as one is out, instead of on Steam's own schedule
  steamAutoUpdate: false,
  // Steam games the account owns but hasn't installed show in the library (to download)
  steamOwned: true,
  sgdbKey: '',
  artSource: 'steam',
  tileStyle: 'auto',
  // Home
  homeCount: 12,
  homeSort: 'recent',
  showStore: true,
  background: 'animated',
  heroMotion: true,
  showClock: true,
  clock24: false,
  // Sound
  uiSounds: true,
  uiVolume: 60,
  ambient: false,
  ambientVolume: 35,
  themeMusic: null, // null: on when yt-dlp is installed (see YtDlp)
  themeMusicVolume: 50,
  themeMusicNewGames: true,
  // Screen
  hardwareAcceleration: true,
  fullscreen: true,
  uiScale: 100,
  reduceMotion: false,
  // Controllers
  prompts: 'auto',
  vibration: true,
  // System
  autoUpdateCheck: true,
  launchAtStartup: false,
  onLaunch: 'minimize',
  overlay: true,
  overlayHotkey: true,
  pauseGames: true,
  qmHidden: [],
  restoreOnExit: true,
  welcomeScreen: true,
  // Controller passthrough: games get a virtual DualSense (needs HidHide + usbip-win2)
  controllerPassthrough: false,
  // What the DualSense is shown to games as: dualsense | dualshock4 | xbox360
  passthroughEmulation: 'dualsense',
  // Polling rate games get from the virtual pad, in Hz (0 = the controller's own)
  padRateUsb: 0,
  padRateBt: 0,
  // Interface typeface: system (Segoe UI) | sst (PlayStation's SST, from renderer/fonts/sst)
  font: 'system',
  // Sound themes (deckthemes.com audio packs): installed pack ids, or null for the built-in sounds
  soundPack: null,
  musicPack: null,
  // Notifications
  notifPopups: true,
  notifPreview: true,
  notifDuration: 'default',
  notif_discord: 'always',
  notif_party: 'always',
  notif_controller: 'always',
  notif_game: 'always',
  notif_library: 'notInGame',
  notif_system: 'always',
  notif_capture: 'always',
  notif_downloads: 'always',
  // Captures (recording through OBS Studio, see main/obs.js)
  captureEnabled: false,
  captureDir: '', // '' = Videos\PS5 Game Launcher
  captureClipLength: 60, // seconds kept for "Save Recent Gameplay"
  captureResolution: 1080, // output height; 0 = same as the screen
  captureFps: 60,
  captureEncoder: 'auto', // auto | nvenc | amd | qsv | x264
  captureQuality: 'high', // standard (bitrate) | high | best
  captureBitrate: 20000, // kbps, for "standard"
  captureFormat: 'mp4', // mp4 | mkv
  captureShotFormat: 'png', // png | jpg
  captureMic: false,
  captureGameAudioOnly: true,
  captureCreateButton: true, // DualSense Create button opens the capture menu
  language: 'auto',
  // Profile
  profileName: 'Player',
  avatar: 0,
  avatarImage: null,
  profiles: [],
  profileId: null,
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
};

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// The launcher's own sound (game theme music, clips) isn't media for Windows:
// no entry in its media controls, media keys stay with the player apps, and
// the "another app is playing media" check doesn't see the launcher itself.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');

/**
 * The launcher used to be called "ClaudeLauncher" and kept its data in
 * %APPDATA%\ClaudeLauncher. Move that folder to the new name once, before
 * Chromium opens anything in it (the whole folder moves, so the encrypted
 * Discord sign-in still decrypts).
 */
function migrateDataDir() {
  try {
    const dir = app.getPath('userData');
    const old = path.join(app.getPath('appData'), 'ClaudeLauncher');
    if (path.resolve(old) === path.resolve(dir) || !fs.existsSync(path.join(old, 'settings.json'))) return;
    if (fs.existsSync(path.join(dir, 'settings.json')) || fs.existsSync(path.join(dir, 'library.json'))) return;
    if (!fs.existsSync(dir)) {
      try {
        fs.renameSync(old, dir);
        return;
      } catch {}
    }
    // The folder is in use (or the new one exists already): move/copy what matters.
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['settings.json', 'library.json', 'discord.json', 'steamfriends.json', 'Local State', 'artwork', 'avatars']) {
      const from = path.join(old, name);
      const to = path.join(dir, name);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      try {
        fs.renameSync(from, to);
      } catch {
        try {
          fs.cpSync(from, to, { recursive: true });
        } catch {}
      }
    }
  } catch (err) {
    console.error('Could not move the old data folder:', err);
  }
}
migrateDataDir();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  const dataDir = app.getPath('userData');
  const artDir = path.join(dataDir, 'artwork');
  const avatarDir = path.join(dataDir, 'avatars');
  const packs = new SoundPacks(path.join(dataDir, 'soundpacks'));
  const settings = new JsonStore(path.join(dataDir, 'settings.json'), DEFAULT_SETTINGS);
  // Electron requires this before app readiness and before any windows exist.
  // Enabling again uses Electron's default GPU acceleration on the next launch.
  if (settings.data.hardwareAcceleration === false) app.disableHardwareAcceleration();
  const libStore = new JsonStore(path.join(dataDir, 'library.json'), { games: [], excluded: [] });

  /** @type {BrowserWindow | null} */
  let win = null;
  let overlay = null;
  // Most state goes to both the launcher and the in-game overlay window.
  const MAIN_ONLY = new Set(['window:state', 'notify', 'scan:progress', 'navigate', 'discord:message']);
  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    if (!MAIN_ONLY.has(channel) && overlay) overlay.send(channel, payload);
  };
  // Library changes also tell game theme music about newly installed games (set up below).
  let onLibraryChanged = null;
  const librarySend = (channel, payload) => {
    send(channel, payload);
    if (channel === 'library:changed' && onLibraryChanged) onLibraryChanged(payload);
  };
  const library = new Library({ store: libStore, settings, artDir, send: librarySend });
  const system = new SystemBridge();
  const discord = new DiscordBridge({ file: path.join(dataDir, 'discord.json'), send });
  const steamFriends = new SteamFriends({ file: path.join(dataDir, 'steamfriends.json'), send, system });
  const updater = new Updater({ send, settings });
  const ytdlp = new YtDlp({ dataDir, settings, send });
  const themeMusic = new ThemeMusic({ dataDir, ytdlp, send });
  // Game theme music starts on when setup installed yt-dlp (its Extras page);
  // otherwise turning it on in Settings downloads yt-dlp first.
  if (settings.data.themeMusic == null) {
    settings.data.themeMusic = ytdlp.installed();
    settings.saveSoon();
  }
  // A newer yt-dlp every couple of days, quietly (YouTube changes break old ones).
  const ytdlpUpdate = () => settings.data.themeMusic && ytdlp.updateIfDue();
  setTimeout(ytdlpUpdate, 60 * 1000);
  setInterval(ytdlpUpdate, 6 * 60 * 60 * 1000);
  // A game that appears installed (a scan found it, a download finished) gets
  // its theme right away (Settings › Sound › Get Theme Music for New Games).
  const themeGame = (g) => g.installed !== false && g.category !== 'media';
  const knownGames = new Set(library.games.filter(themeGame).map((g) => g.id));
  onLibraryChanged = (games) => {
    const fresh = (games || []).filter((g) => themeGame(g) && !knownGames.has(g.id));
    fresh.forEach((g) => knownGames.add(g.id));
    if (fresh.length && settings.data.themeMusic === true && settings.data.themeMusicNewGames !== false && ytdlp.installed()) themeMusic.fetchNew(fresh);
  };
  const obs = new ObsBridge({ dataDir, settings, send, system, defaultDir: () => path.join(app.getPath('videos'), 'PS5 Game Launcher') });
  overlay = new OverlayManager({
    system,
    onVisibility: (visible) => {
      updatePassthroughMute();
      updateSleep();
      return visible ? schedulePause() : updatePause();
    },
    onBeforeShow: () => setSleep(false),
    onIdle: () => updateSleep(),
  });

  /* ---- In game: the launcher steps aside --------------------------
     While a game is in front (launcher minimized or behind it, no menu or
     notification over the game) the launcher's renderer, GPU and service
     processes run in Windows' efficiency mode at a lower priority, all of
     its memory is trimmed, and both pages drop their audio output and
     polling. It all comes back the moment the launcher, a menu or a
     notification needs it (setSleep(false) runs before anything shows). */
  let asleep = false;
  let sleepTimer = null;
  const launcherInFront = () => !!(win && win.isVisible() && !win.isMinimized() && win.isFocused());
  function updateSleep() {
    clearTimeout(sleepTimer);
    const idle = monitor.list().length > 0 && !launcherInFront() && !overlay.visible && !overlay.toastShown;
    if (!idle) return setSleep(false);
    // Give the game a moment to take over (and the launcher to minimize) first.
    sleepTimer = setTimeout(() => setSleep(true), 5000);
  }
  function setSleep(on) {
    if (!on) clearTimeout(sleepTimer);
    if (on === asleep) return;
    asleep = on;
    const metrics = app.getAppMetrics();
    const helpers = metrics.filter((m) => m.type !== 'Browser').map((m) => m.pid);
    system.request('procQos', { pids: helpers, eco: on, lower: on, trim: on }).catch(() => {});
    // The main process keeps its priority (it reacts to the PS button); only its memory is trimmed.
    if (on) system.request('procQos', { pids: [process.pid], eco: false, trim: true }).catch(() => {});
    send('app:sleep', on);
  }

  /* ---- Pausing the game while a menu is in front ------------------
     Windows has no safe way to stop a game from reading the controller, so
     while the quick menu (or the home screen) is in front of a running game we
     suspend the game process — but only for games without anti-cheat files.
     The helper resumes everything if the launcher ever goes away. */
  let pausedPid = null;
  let pauseTimer = null;
  let closingPid = null; // a game being closed is never paused again
  function schedulePause() {
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(updatePause, 120);
  }
  async function updatePause() {
    const cur = monitor.list().sort((a, b) => b.since - a.since)[0];
    const launcherFront = !!(win && win.isVisible() && !win.isMinimized() && win.isFocused());
    const age = cur ? Date.now() - cur.since : 0;
    const settled = cur && age > 15000; // never pause a game that is still starting
    if (cur && !settled) pauseTimer = setTimeout(updatePause, 15000 - age + 200);
    let want = null;
    const curGame = cur && library.find(cur.id);
    const realPad = !!(curGame && curGame.controllerMode === 'real' && settings.data.controllerPassthrough);
    // The capture menu never pauses the game (clips must keep recording).
    const menuOpen = overlay.visible && overlay.mode !== 'capture';
    if ((settings.data.pauseGames !== false || realPad) && cur && settled && cur.pid !== closingPid && !monitor.hasAntiCheat(cur.id) && (menuOpen || launcherFront)) {
      const g = curGame;
      const mode = realPad ? 'always' : (g && g.pauseMode) || 'auto';
      if (mode === 'always') want = cur.pid;
      else if (mode === 'auto') {
        // Connected to a server? Pausing would disconnect it, so let it run.
        const conns = cur.pid === pausedPid ? 0 : await system.request('netConns', { pid: cur.pid }, 3000).catch(() => 1);
        if (!conns) want = cur.pid;
      }
    }
    // wait: the helper first waits for all controller buttons to be released,
    // so the game never wakes up with a button stuck down.
    if (pausedPid && pausedPid !== want) {
      await system.request('resume', { pid: pausedPid, wait: true }, 5000).catch(() => {});
      pausedPid = null;
    }
    if (want && want !== pausedPid) {
      const ok = await system.request('suspend', { pid: want, wait: true }, 5000).catch(() => false);
      if (ok) pausedPid = want;
    }
  }
  async function resumeNow() {
    clearTimeout(pauseTimer);
    if (pausedPid) {
      await system.request('resume', { pid: pausedPid, wait: true }, 5000).catch(() => {});
      pausedPid = null;
    }
  }

  /** Bring the launcher to the front, optionally navigating somewhere. */
  async function showLauncher(nav) {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    const ok = await system.focusWindow(overlay.hwndOf(win));
    if (!ok) win.focus();
    if (nav) send('navigate', nav);
  }

  const monitor = new GameMonitor({
    library,
    system,
    onChange: (list) => {
      send('game:running', list);
      schedulePause();
      updateSleep();
      if (settings.data.controllerPassthrough) applyPassthrough(false);
      // Recording follows the game: OBS's replay buffer runs while one is open.
      obs.onRunning(list, (id) => library.find(id)).catch(() => {});
    },
    onEnded: (id, minutes) => {
      // It quit while still starting: stop keeping the launcher on top for it. The
      // watch itself goes on for a moment, in case a launcher process handed over.
      if (launchWatchId === id) {
        launchEndedAt = Date.now();
        setCover(false);
      }
      const g = library.find(id);
      if (g && minutes > 0) {
        g.playtime = (g.playtime || 0) + minutes;
        library.save();
      }
      send('game:exited', { id, minutes, shortLived: minutes < 1 });
      const wasInLauncher = !!(win && win.isVisible() && !win.isMinimized() && win.isFocused()) && !overlay.visible;
      if (overlay.visible) overlay.hideNow({ restoreFocus: false });
      if (settings.data.restoreOnExit && !wasInLauncher) showLauncher({ view: 'home' });
    },
  });

  // Steam downloads: games needing an update, and update progress (main/steamdownloads.js).
  // While Steam is asked to update a game it shows its window: the launcher stays in front of it.
  let dlCover = false;
  const downloads = new SteamDownloads({
    library,
    system,
    monitor,
    settings,
    send,
    hooks: {
      cover: (on) => {
        if (!win || win.isDestroyed()) return;
        if (on) {
          dlCover = launcherInFront();
          if (dlCover) win.setAlwaysOnTop(true, 'screen-saver');
        } else if (dlCover) {
          dlCover = false;
          if (!coverOn) win.setAlwaysOnTop(false);
          system.focusWindow(overlay.hwndOf(win)).catch(() => {});
        }
      },
      // Steam's install dialog is answered: back to the launcher (if it was the one in use).
      focus: () => {
        if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && !monitor.list().length) system.focusWindow(overlay.hwndOf(win)).catch(() => {});
      },
      // A game finished installing: the library picks it up as installed.
      installed: () => library.scan({ silent: true }).catch(() => {}),
    },
  });

  // Guide / PS button (from the helper) and the keyboard shortcut.
  let lastGuide = 0;
  function onGuide() {
    const now = Date.now();
    if (now - lastGuide < 250) return;
    lastGuide = now;
    if (overlay.visible) {
      overlay.requestClose();
      return;
    }
    const launcherActive = win && win.isVisible() && !win.isMinimized() && win.isFocused();
    if (launcherActive) {
      win.webContents.send('pad:action', 'guide');
      return;
    }
    if (settings.data.overlay === false) {
      showLauncher();
      return;
    }
    overlay.show({ running: monitor.list() });
  }
  system.on('guide', onGuide);

  /* ---- Captures: the Create button opens the capture menu ----------
     A bar over the game (Save Recent Gameplay, Take Screenshot, Start
     Recording…). Unlike the quick menu it never pauses the game. */
  let lastShare = 0;
  function onShare() {
    const now = Date.now();
    if (now - lastShare < 300) return;
    lastShare = now;
    if (!settings.data.captureEnabled) return;
    if (overlay.visible) {
      if (overlay.mode === 'capture') overlay.requestClose();
      return;
    }
    if (!monitor.list().length) return; // only games are captured
    overlay.show({ mode: 'capture', running: monitor.list(), capture: obs.publicState() });
  }
  system.on('share', () => {
    if (settings.data.captureCreateButton !== false) onShare();
  });
  // While recording is on, the Create button belongs to the capture menu
  // (the virtual controller of controller passthrough doesn't pass it on).
  const applyCaptureButton = () => {
    // Remembered so a restarted helper gets it again.
    system.captureButton = !!settings.data.captureEnabled && settings.data.captureCreateButton !== false;
    return system.request('captureButton', { value: system.captureButton }).catch(() => {});
  };
  system.on('pad', (e) => {
    if (!e.action) return;
    if (overlay.visible) overlay.send('pad:action', { action: e.action, repeat: !!e.repeat, kind: e.kind });
    // With controller passthrough the launcher reads the real controller
    // through the helper too (the virtual one is muted while it is in front).
    else if ((passthrough.enabled || passthrough.fallback || passthrough.starting) && win && win.isFocused() && !win.isMinimized()) win.webContents.send('pad:action', { action: e.action, repeat: !!e.repeat, kind: e.kind });
  });

  /* ---- Controller passthrough (HidHide + libVIIPER) ----------------
     Games get a virtual DualSense that the launcher feeds from the real one
     (the helper makes it with libVIIPER, see main/native/syshelper.cs).
     Whenever the launcher or the quick menu is in front it is muted, so the
     game can't react to the menu's button presses. */
  // fallback: passthrough just went off and the launcher window doesn't see
  // the controller again yet, so it keeps getting it through the helper.
  // starting: it is being switched on at startup; the launcher window reads the
  // controller through the helper meanwhile (it doesn't read it itself then).
  const passthrough = { enabled: false, state: null, fallback: false, starting: false };
  system.on('passthrough', (e) => {
    passthrough.state = e.state;
    send('passthrough:state', e.state);
  });

  /* DualSense info for Settings › Accessories and the quick menu's battery:
     the helper reads it from the controllers it already listens to. */
  let dualsense = [];
  system.on('dualsense', (e) => {
    dualsense = e.pads || [];
    send('dualsense:state', dualsense);
  });
  // refresh: read firmware and MAC from the controllers again.
  ipcMain.handle('dualsense:info', async (_e, refresh) => {
    if (!refresh && dualsense.length) return dualsense;
    dualsense = (await system.request('dualsenseInfo', { refresh: !!refresh }, 5000).catch(() => null)) || dualsense;
    return dualsense;
  });
  /** A running game set to use the real controller (DualSense features): passthrough is off meanwhile. */
  function realControllerGame() {
    for (const r of monitor.list()) {
      const g = library.find(r.id);
      if (g && g.controllerMode === 'real') return g;
    }
    return null;
  }
  /* What the virtual controller is: the running game's own choice (Options ›
     Emulated Controller), else Settings › Controllers. A game being started
     counts already, so its controller is in place before it looks for one. */
  let launchingPad = null; // { id, until }
  function emulationFor() {
    const own = (g) => (g && ['dualsense', 'dualshock4', 'xbox360'].includes(g.padEmulation) ? g.padEmulation : null);
    for (const r of monitor.list().sort((a, b) => b.since - a.since)) {
      const g = library.find(r.id);
      if (g) return own(g) || settings.data.passthroughEmulation || 'dualsense';
    }
    if (launchingPad && Date.now() < launchingPad.until) {
      const g = library.find(launchingPad.id);
      if (own(g)) return own(g);
    }
    return settings.data.passthroughEmulation || 'dualsense';
  }
  let appliedEmulation = null;
  function applyEmulation() {
    const mode = emulationFor();
    if (system.passthroughArgs) system.passthroughArgs = { ...system.passthroughArgs, mode };
    if (!passthrough.enabled || mode === appliedEmulation) return;
    appliedEmulation = mode;
    system.request('passthroughConfig', { mode }).catch(() => {});
  }

  let passthroughWant = null;
  async function applyPassthrough(force = true) {
    const real = settings.data.controllerPassthrough ? realControllerGame() : null;
    const want = !!settings.data.controllerPassthrough && !real;
    if (!force && want === passthroughWant) {
      applyEmulation();
      return passthrough.state;
    }
    passthroughWant = want;
    const args = { value: want, mode: emulationFor(), rateUsb: Number(settings.data.padRateUsb) || 0, rateBt: Number(settings.data.padRateBt) || 0 };
    appliedEmulation = args.mode;
    system.passthroughArgs = want ? args : null;
    let st = await system.request('passthrough', args, 15000).catch((err) => ({ enabled: false, error: err.message }));
    if (real) st = { ...st, realGame: real.name };
    passthrough.enabled = !!(st && st.enabled);
    passthrough.state = st;
    passthrough.starting = false;
    system.keepPadForward(passthrough.enabled || passthrough.fallback);
    send('passthrough:state', st);
    lastMute = null;
    updatePassthroughMute();
    return st;
  }
  let lastMute = null;
  function updatePassthroughMute() {
    if (!passthrough.enabled) return;
    const muted = !!(overlay.visible || (win && win.isFocused() && !win.isMinimized()));
    if (muted === lastMute) return;
    lastMute = muted;
    system.request('passthroughMute', { value: muted }).catch(() => {});
  }

  function applyHotkey() {
    globalShortcut.unregisterAll();
    if (settings.data.overlayHotkey !== false) {
      try {
        globalShortcut.register('Control+Alt+Home', onGuide);
        globalShortcut.register('Control+Alt+End', onShare);
      } catch {}
    }
  }

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  function createWindow() {
    const s = settings.data;
    win = new BrowserWindow({
      width: 1600,
      height: 900,
      minWidth: 960,
      minHeight: 540,
      show: false,
      backgroundColor: '#000000',
      title: 'PS5 Game Launcher',
      icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
      fullscreen: !!s.fullscreen && !process.argv.includes('--windowed'),
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#05070d', symbolColor: '#e8ecf5', height: 34 },
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    Menu.setApplicationMenu(null);
    win.loadURL('app://ui/index.html');
    win.once('ready-to-show', () => win.show());

    const pushState = () => win && send('window:state', { fullscreen: win.isFullScreen(), focused: win.isFocused() });
    // isFullScreen() can lag the event on Windows, so re-check shortly after.
    const pushSoon = () => {
      pushState();
      setTimeout(pushState, 250);
      setTimeout(pushState, 800);
    };
    win.on('enter-full-screen', pushSoon);
    win.on('leave-full-screen', pushSoon);
    win.on('resize', pushSoon);
    win.on('blur', () => {
      setTimeout(updatePassthroughMute, 0);
      pushState();
      schedulePause();
      updateSleep();
    });
    win.on('minimize', updateSleep);
    win.on('restore', updateSleep);
    let lastPlaytimeRefresh = 0;
    win.on('focus', () => {
      setSleep(false);
      updatePassthroughMute();
      pushState();
      schedulePause();
      if (Date.now() - lastPlaytimeRefresh > 30000) {
        lastPlaytimeRefresh = Date.now();
        library.refreshSteamPlaytime().catch(() => {});
      }
    });

    win.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F11') {
        const fs = !win.isFullScreen();
        win.setFullScreen(fs);
        send('window:state', { fullscreen: fs, focused: win.isFocused() });
        e.preventDefault();
      } else if (input.key === 'F12' && process.argv.includes('--dev')) {
        win.webContents.toggleDevTools();
      } else if (input.key.toLowerCase() === 'r' && input.control && process.argv.includes('--dev')) {
        win.webContents.reload();
        e.preventDefault();
      }
    });
    // Never navigate away from the app (dev reloads stay on app://ui).
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('app://ui/')) e.preventDefault();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => {
      win = null;
      // The overlay window keeps the app alive otherwise.
      overlay.destroy();
      app.quit();
    });
  }

  app.whenReady().then(() => {
    const rendererDir = path.join(__dirname, '..', 'renderer');
    // app://ui/... -> renderer files, app://art/... -> cached artwork,
    // app://avatar/... -> profile pictures
    // app://captures/... -> clips and screenshots, app://capthumbs/... -> their thumbnails
    const roots = { ui: rendererDir, art: artDir, avatar: avatarDir, sounds: packs.dir };
    const rootOf = (host) => (host === 'captures' ? obs.dir : host === 'capthumbs' ? obs.thumbDir : roots[host]);
    protocol.handle('app', async (req) => {
      const u = new URL(req.url);
      const base = rootOf(u.hostname) || null;
      if (!base) return new Response('not found', { status: 404 });
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.normalize(path.join(base, rel));
      // Inside the root (also when the root is a drive like D:\).
      const inside = path.relative(base, file);
      if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return new Response('forbidden', { status: 403 });
      try {
        const headers = {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'access-control-allow-origin': '*',
          'cache-control': u.hostname === 'ui' || u.hostname === 'captures' ? 'no-cache' : 'max-age=31536000',
          'accept-ranges': 'bytes',
        };
        // Byte ranges are answered here (a file:// fetch sends the whole file
        // for them): without a 206, a video counts as not seekable until it has
        // loaded completely, and jumping in a long clip snaps back to the start.
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
        if (range) {
          const { size } = await fs.promises.stat(file);
          let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0));
          let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
          headers['content-range'] = `bytes ${start}-${end}/${size}`;
          headers['content-length'] = String(end - start + 1);
          return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206, headers });
        }
        const res = await net.fetch(pathToFileURL(file).toString());
        if (res.headers.get('content-length')) headers['content-length'] = res.headers.get('content-length');
        return new Response(res.body, { status: res.status, headers });
      } catch {
        return new Response('not found', { status: 404 });
      }
    });

    createWindow();
    system.start();
    // Right away, so the controller's one restart (see the helper's Hide) falls
    // in the boot screen. Always: when it is off this also undoes hiding left
    // over from a crash.
    if (settings.data.controllerPassthrough) {
      passthrough.starting = true;
      system.keepPadForward(true);
    }
    applyPassthrough();
    discord.start();
    setTimeout(() => steamFriends.start(), 4000);
    updater.start();
    overlay.create();
    monitor.start();
    setTimeout(() => downloads.start().catch((err) => console.warn('[downloads]', err)), 2500);
    applyHotkey();
    applyCaptureButton();
    obs.onSettings().catch(() => {});

    if (settings.data.rescanOnStartup || libStore.data.games.length === 0) {
      setTimeout(() => library.scan({ silent: true }).then(() => library.refreshSteamPlaytime()).catch(console.error), 1800);
    } else {
      const pending = library.games.filter((g) => g.metaStatus === 'pending');
      if (pending.length) setTimeout(() => library.fetchMetadata(pending), 1800);
    }
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  let obsClosed = false;
  app.on('before-quit', (e) => {
    if (pausedPid) system.request('resume', { pid: pausedPid }).catch(() => {});
    // Close OBS cleanly first (it was started by the launcher, in the tray).
    if (!obsClosed && obs.ws) {
      e.preventDefault();
      obsClosed = true;
      obs.shutdown().finally(() => app.quit());
    }
  });

  app.on('window-all-closed', () => {
    monitor.stop();
    downloads.stop();
    system.stop();
    discord.close();
    steamFriends.stop();
    updater.stop();
    settings.saveNow();
    libStore.saveNow();
    app.quit();
  });

  /* ---------------------------------------------------------------- */
  /* IPC                                                              */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('state:get', () => ({
    window: win ? { fullscreen: win.isFullScreen(), focused: win.isFocused() } : null,
    settings: settings.data,
    games: library.games,
    running: monitor.list(),
    info: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform} ${process.getSystemVersion()}`,
      dataDir,
      steam: library.steamInfo,
      epic: library.epicFound,
      xbox: library.xboxFound,
      ubisoft: library.ubisoftFound,
      excluded: libStore.data.excluded.length,
    },
  }));

  ipcMain.handle('gpu:getPreference', () => gpuPreference());
  ipcMain.handle('gpu:setPreference', (_e, preference) => gpuPreference(preference));

  ipcMain.handle('settings:set', async (e, patch) => {
    const s = settings.data;
    const prev = { ...s };
    Object.assign(s, patch);
    settings.saveNow();
    // Keep the other window (launcher <-> overlay) in sync.
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents !== e.sender && !w.isDestroyed()) w.webContents.send('settings:changed', s);
    }
    if ('overlayHotkey' in patch) applyHotkey();
    if ('pauseGames' in patch) schedulePause();
    if (Object.keys(patch).some((k) => k.startsWith('capture'))) {
      obs.onSettings().catch(() => {});
      applyCaptureButton();
    }
    if ('controllerPassthrough' in patch) applyPassthrough();
    else if ('passthroughEmulation' in patch) applyEmulation();
    if ('padRateUsb' in patch || 'padRateBt' in patch) {
      const rate = { usb: Number(s.padRateUsb) || 0, bt: Number(s.padRateBt) || 0 };
      if (system.passthroughArgs) Object.assign(system.passthroughArgs, { rateUsb: rate.usb, rateBt: rate.bt });
      system.request('passthroughRate', rate).catch(() => {});
    }

    if ('fullscreen' in patch && win) {
      win.setFullScreen(!!patch.fullscreen);
      send('window:state', { fullscreen: !!patch.fullscreen, focused: win.isFocused() });
    }
    if ('launchAtStartup' in patch) {
      try {
        const opts = { openAtLogin: !!patch.launchAtStartup };
        // When running from source, start Electron with this app's folder.
        if (!app.isPackaged) Object.assign(opts, { path: process.execPath, args: [path.resolve(app.getAppPath())] });
        app.setLoginItemSettings(opts);
      } catch {}
    }
    const rescanKeys = ['scanSteam', 'scanEpic', 'scanXbox', 'scanUbisoft', 'steamOwned'];
    if (rescanKeys.some((k) => k in patch && patch[k] !== prev[k])) library.scan({ silent: true });
    return s;
  });

  ipcMain.handle('info:get', () => ({
    steam: library.steamInfo,
    epic: library.epicFound,
    xbox: library.xboxFound,
    ubisoft: library.ubisoftFound,
    excluded: libStore.data.excluded.length,
  }));

  ipcMain.handle('library:scan', () => library.scan({ silent: false }));
  ipcMain.handle('library:refreshAll', () => library.fetchMetadata(library.games.slice(), { force: true }));

  // Paths come from the launcher's own file browser (renderer/js/ui/filebrowser.js).
  ipcMain.handle('library:addFolder', async (_e, picked) => {
    if ((await files.kind(picked)) !== 'dir') return null;
    const folder = path.resolve(picked);
    const s = settings.data;
    if (!s.folders.includes(folder)) s.folders.push(folder);
    settings.saveNow();
    send('settings:changed', s);
    library.scan({ silent: false });
    return folder;
  });

  ipcMain.handle('library:removeFolder', async (_e, folder) => {
    const s = settings.data;
    s.folders = s.folders.filter((f) => f !== folder);
    settings.saveNow();
    send('settings:changed', s);
    await library.scan({ silent: true });
    return s.folders;
  });

  ipcMain.handle('library:import', (_e, paths) => library.importPaths(Array.isArray(paths) ? paths : []));
  ipcMain.handle('library:addFiles', (_e, paths) => library.importPaths((Array.isArray(paths) ? paths : []).filter((p) => /\.(lnk|url|exe|bat|cmd)$/i.test(String(p)))));
  ipcMain.handle('library:restoreExcluded', async () => {
    const n = library.restoreExcluded();
    await library.scan({ silent: true });
    return n;
  });
  ipcMain.handle('library:reset', () => library.reset());

  ipcMain.handle('game:update', (_e, id, patch) => {
    const r = library.update(id, patch || {});
    // Switching a running game to / from the real controller (or its kind of
    // virtual controller) applies right away.
    if (patch && 'controllerMode' in patch && settings.data.controllerPassthrough) applyPassthrough(false);
    else if (patch && 'padEmulation' in patch) applyEmulation();
    return r;
  });
  ipcMain.handle('game:remove', (_e, id) => library.remove(id));
  ipcMain.handle('game:refreshArt', (_e, id) => {
    const g = library.find(id);
    return g ? library.fetchMetadata([g], { force: true }) : null;
  });
  ipcMain.handle('game:setMatch', (_e, id, appid) => library.setMatch(id, appid));
  // Game theme music (main/thememusic.js, from YouTube with yt-dlp): what
  // plays for a game, its audio, and videos to choose from in Options › Theme Music.
  ipcMain.handle('theme:find', async (_e, id) => {
    const tr = await themeMusic.find(library.find(id)).catch(() => null);
    return tr && { key: tr.key, source: tr.source, title: tr.title, channel: tr.channel };
  });
  ipcMain.handle('theme:audio', async (_e, id) => themeMusic.audio(await themeMusic.find(library.find(id))));
  ipcMain.handle('theme:candidates', (_e, term, isGame) => themeMusic.candidates(String(term || '').slice(0, 200), !!isGame));
  ipcMain.handle('theme:trackAudio', (_e, track) => {
    const c = themeChoice({ ...track, mode: 'track' });
    return c ? themeMusic.audio(c, { preview: true }) : null;
  });
  ipcMain.handle('theme:cacheSize', () => themeMusic.cacheSize());
  ipcMain.handle('theme:clearCache', () => themeMusic.clearCache());
  // Every installed game's theme, ahead of time (Settings › Sound › Game Theme Music).
  ipcMain.handle('theme:fetchAll', () => themeMusic.fetchAll(library.games.filter((g) => g.installed !== false && g.category !== 'media')));
  ipcMain.handle('theme:fetchState', () => ({ ...themeMusic.fetch }));
  ipcMain.handle('theme:stopFetch', () => themeMusic.stopFetch());
  ipcMain.handle('ytdlp:state', () => ytdlp.state());
  ipcMain.handle('ytdlp:install', async () => {
    await ytdlp.install();
    return ytdlp.state();
  });
  ipcMain.handle('ytdlp:remove', async () => {
    await ytdlp.remove();
    return ytdlp.state();
  });
  ipcMain.handle('sgdb:search', (_e, term) => sgdb.search(settings.data.sgdbKey, term));
  ipcMain.handle('sgdb:list', (_e, gameId, kind, page) => sgdb.list(settings.data.sgdbKey, gameId, kind, page));
  ipcMain.handle('sgdb:apply', (_e, id, kind, artworkId) => library.setSteamGridDBArt(id, kind, artworkId));
  const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
  ipcMain.handle('game:customArt', async (_e, id, kind, file) => {
    if (!IMAGE.test(String(file)) || (await files.kind(file)) !== 'file') return null;
    return library.setCustomArt(id, kind, file);
  });
  // Profile pictures are copied into the data folder under a new name, so
  // replacing one never shows a stale cached image.
  ipcMain.handle('profile:pickImage', async (_e, src) => {
    if (!IMAGE.test(String(src)) || (await files.kind(src)) !== 'file') return null;
    const name = `${Date.now().toString(36)}${path.extname(src).toLowerCase()}`;
    await fs.promises.mkdir(avatarDir, { recursive: true });
    await fs.promises.copyFile(src, path.join(avatarDir, name));
    return `app://avatar/${name}`;
  });
  ipcMain.handle('profile:removeImage', async (_e, url) => {
    const m = /^app:\/\/avatar\/([\w.-]+)$/.exec(String(url || ''));
    if (m) await fs.promises.rm(path.join(avatarDir, m[1]), { force: true }).catch(() => {});
  });
  // Where a game is on disk, for the file browser: its folder, with its file picked out.
  ipcMain.handle('game:location', (_e, id) => {
    const g = library.find(id);
    if (!g) return null;
    if (g.source === 'steam' && g.installDir && fs.existsSync(g.installDir)) return { dir: g.installDir, file: null };
    const target = g.path || g.exe || g.installDir;
    if (target && fs.existsSync(target)) return fs.statSync(target).isDirectory() ? { dir: target, file: null } : { dir: path.dirname(target), file: path.basename(target) };
    if (g.installDir && fs.existsSync(g.installDir)) return { dir: g.installDir, file: null };
    return null;
  });

  /* ---- The launcher's file browser (main/files.js) ---------------- */
  ipcMain.handle('fs:list', (_e, dir, opts) => files.list(dir, opts || {}));
  ipcMain.handle('fs:places', async () => files.places(await storage.drives().catch(() => [])));
  ipcMain.handle('fs:icon', (_e, file) => files.iconOf(String(file || '')));
  ipcMain.handle('fs:mkdir', (_e, dir, name) => files.mkdir(dir, name));
  ipcMain.handle('fs:kind', (_e, p) => files.kind(p));
  // The way out to Windows: the item in File Explorer, or a file opened with its program.
  ipcMain.handle('fs:showInExplorer', async (_e, p) => {
    const k = await files.kind(p);
    if (k === 'file') shell.showItemInFolder(path.resolve(p));
    else if (k === 'dir') await shell.openPath(path.resolve(p));
  });
  ipcMain.handle('fs:open', async (_e, p) => ((await files.kind(p)) === 'file' ? shell.openPath(path.resolve(p)) : 'not a file'));

  /* ---- Emulators (main/emulators.js) ------------------------------ */
  async function emulatorInfo() {
    const conf = (settings.data.emulators || {}).switch;
    if (!conf || !conf.exe) return { switch: null };
    const info = await emulators.detectSwitch(conf.exe);
    const count = library.games.filter((g) => g.source === 'emulator' && g.platform === 'switch').length;
    return { switch: { ...info, fullscreen: conf.fullscreen !== false, count, players: conf.players || [] } };
  }
  ipcMain.handle('emulators:info', () => emulatorInfo());
  // The controllers connected now, for the players' choices.
  ipcMain.handle('emulators:pads', async () => emulators.describePads(await system.request('gamepads', {}, 4000).catch(() => [])));

  /**
   * Right before a Switch game starts: the players get the controllers chosen
   * in Settings › Library › Emulators, as the emulator will see them (with
   * controller passthrough, the launcher's virtual pads). Returns a note for
   * players whose controller isn't there.
   */
  async function applySwitchPlayers(g) {
    const conf = (settings.data.emulators || {}).switch;
    const wanted = (conf && conf.players) || [];
    if (!wanted.some(Boolean)) return null;
    const info = await emulators.detectSwitch(conf.exe);
    if (!info.userDir) return null;
    // Running already: it would write its own settings back over these when it closes.
    const running = await new Promise((res) => execFile('tasklist', ['/FI', `IMAGENAME eq ${path.basename(conf.exe)}`, '/NH'], { windowsHide: true }, (err, out) => res(!err && out.toLowerCase().includes(path.basename(conf.exe).toLowerCase()))));
    if (running) return 'The emulator was already open, so its players weren’t changed.';
    const pads = emulators.describePads(await system.request('gamepads', {}, 4000).catch(() => []));
    const pass = settings.data.controllerPassthrough && passthrough.enabled && g.controllerMode !== 'real' ? { emulation: emulationFor() } : null;
    const players = {};
    const ports = new Map();
    const missing = [];
    wanted.forEach((w, n) => {
      if (!w) return;
      if (w === 'off') {
        players[n] = 'off';
        return;
      }
      const pad = pads.find((p) => p.id === w.id);
      if (!pad) return missing.push(n + 1);
      const guid = emulators.edenGuid(pad, pass);
      const port = ports.get(guid) || 0;
      ports.set(guid, port + 1);
      players[n] = { guid, port };
    });
    await emulators.writeSwitchPlayers(info.userDir, players);
    return missing.length ? 'A player’s controller isn’t connected, so the emulator’s own setting is used for that player.' : null;
  }
  // Set (or change) an emulator: checked first, then its games are scanned in.
  ipcMain.handle('emulators:set', async (_e, platform, conf) => {
    if (platform !== 'switch' || !conf) return emulatorInfo();
    const cur = (settings.data.emulators || {}).switch || {};
    const next = {
      ...cur,
      exe: conf.exe !== undefined ? String(conf.exe || '') : cur.exe,
      fullscreen: conf.fullscreen !== undefined ? !!conf.fullscreen : cur.fullscreen !== false,
    };
    // Players 1-8: null (as the emulator has it), 'off' or { id, name } of a controller.
    if (Array.isArray(conf.players)) {
      next.players = Array.from({ length: 8 }, (_, i) => {
        const p = conf.players[i];
        return p === 'off' ? 'off' : p && p.id ? { id: String(p.id), name: String(p.name || '') } : null;
      });
    }
    if (conf.players !== undefined && conf.exe === undefined && conf.fullscreen === undefined) {
      settings.data.emulators = { ...(settings.data.emulators || {}), switch: next };
      settings.saveNow();
      send('settings:changed', settings.data);
      return emulatorInfo();
    }
    if (conf.exe !== undefined) {
      const info = await emulators.detectSwitch(next.exe);
      if (!info.userDir) return { switch: { ...info, count: 0 }, rejected: true };
    }
    settings.data.emulators = { ...(settings.data.emulators || {}), switch: next };
    settings.saveNow();
    send('settings:changed', settings.data);
    await library.scan({ silent: conf.exe === undefined });
    return emulatorInfo();
  });
  ipcMain.handle('emulators:remove', async (_e, platform) => {
    const all = { ...(settings.data.emulators || {}) };
    delete all[platform];
    settings.data.emulators = all;
    settings.saveNow();
    send('settings:changed', settings.data);
    await library.scan({ silent: true });
    return emulatorInfo();
  });

  ipcMain.handle('game:launch', async (_e, id) => {
    const g = library.find(id);
    if (!g) throw new Error('Game not found');
    // Already running: bring it back instead of starting a second copy.
    if (monitor.get(id)) return continueGame(id);
    monitor.noteLaunch(id);
    launchingPad = { id, until: Date.now() + 90000 };
    applyEmulation();
    if (g.source === 'emulator' && g.platform === 'switch') {
      const note = await applySwitchPlayers(g).catch((err) => (console.warn('[switch players]', err), 'The emulator’s players couldn’t be set up.'));
      if (note) send('notify', { title: g.name, body: note, icon: 'gamepad', kind: 'game' });
    }
    setTimeout(applyEmulation, 91000); // it never showed up: back to the usual controller
    g.lastPlayed = Date.now();
    g.launchCount = (g.launchCount || 0) + 1;
    library.save();
    const s = settings.data;
    // Play time, "running" state and returning to the launcher are handled by
    // the game monitor, which also sees games started through Steam / Epic.
    const result = await launchGame(g, () => monitor.poke(300), { system, preferDirect: !!s.preferDirect });
    library.save(); // a direct start may have remembered the game's executable
    monitor.poke(300);
    whenGameShows(id, () => {
      send('game:started', { id });
      if (!win) return;
      if (s.onLaunch === 'minimize') win.minimize();
      else if (s.onLaunch === 'close') app.quit();
    });
    return result;
  });

  /* Minimizing (or quitting) waits until the game is actually on screen, so
     the launcher never drops to the desktop while a game is still loading.
     Multiplayer games often show a small anti-cheat window first (Easy
     Anti-Cheat, EA Javelin, BattlEye); those don't count. A game window
     counts once it covers a good part of its screen, or has been up at a
     normal size for a while. Meanwhile the launcher's Starting… screen stays
     on top, so the anti-cheat splash opens behind it and is never seen. */
  const BOOTSTRAP = /easyanticheat|^eac|eac_|_eac|start_protected_game|eaanticheat|anticheat|battleye|_be$|^be(service|_)|gamelaunchhelper|crashreport|splash/i;
  let launchWatch = 0;
  let launchWatchId = null; // the game being watched
  let launchEndedAt = 0; // it exited while still starting (a crash, or a launcher process handing over)
  let coverOn = false;
  function setCover(on) {
    if (!win || win.isDestroyed() || on === coverOn) return;
    coverOn = on;
    if (on) {
      if (!win.isVisible() || win.isMinimized()) return;
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    } else win.setAlwaysOnTop(false);
  }
  function stopWatch() {
    launchWatch++;
    launchWatchId = null;
    setCover(false);
  }
  ipcMain.handle('game:launchCancel', () => stopWatch());

  function whenGameShows(id, then) {
    const token = ++launchWatch;
    launchWatchId = id;
    launchEndedAt = 0;
    const t0 = Date.now();
    const g = library.find(id) || {};
    const exe = g.exe || (g.launch && g.launch.type === 'exe' ? g.launch.target : null);
    const dirs = [g.installDir, ...(g.altDirs || [])].filter(Boolean);
    if (!dirs.length && exe) dirs.push(path.dirname(exe));
    const firstSeen = new Map(); // hwnd -> time first seen
    let bigSince = 0;
    let foreignSince = 0;
    let awaySince = 0;
    setCover(true);
    const finish = (gaveUp, hwnd) => {
      if (token !== launchWatch) return;
      stopWatch();
      if (hwnd) system.focusWindow(hwnd);
      if (gaveUp) send('game:started', { id, gaveUp: true });
      else then();
    };
    const step = async () => {
      if (token !== launchWatch || !win || win.isDestroyed()) return;
      const now = Date.now();
      if (now - t0 > 180000) return finish(true); // never showed up: leave the launcher alone
      if (launchEndedAt && !monitor.get(id) && now - launchEndedAt > 15000) return finish(true); // it quit and didn't come back
      if (now - t0 > 90000) setCover(false);
      const focused = win.isFocused() && !win.isMinimized();
      awaySince = focused ? 0 : awaySince || now;
      const fg = await system.foreground();
      let game = null;
      if (dirs.length) {
        const wins = await system.request('dirWindows', { dirs }, 4000).catch(() => []);
        const real = (wins || []).filter((w) => !BOOTSTRAP.test(w.name) && w.w >= 320 && w.h >= 200);
        for (const w of real) if (!firstSeen.has(w.hwnd)) firstSeen.set(w.hwnd, now);
        const big = real.find((w) => w.w * w.h >= 0.35 * (w.mw || 1920) * (w.mh || 1080));
        bigSince = big ? bigSince || now : 0;
        // A big window that stays for a moment, or a normal-sized one that stays a while (windowed games).
        if (big && now - bigSince >= 900) game = big;
        else game = real.find((w) => now - firstSeen.get(w.hwnd) >= 8000 && w.w >= 640 && w.h >= 360) || null;
        // Something outside the game is asking for attention (a store sign-in,
        // an update, an anti-cheat error): stop covering it.
        const ours = fg && win && Number(fg.hwnd) === Number(overlay.hwndOf(win));
        const foreign = fg && !ours && !game && !BOOTSTRAP.test(fg.name || '') && fg.w >= 300 && fg.h >= 200;
        foreignSince = foreign ? foreignSince || now : 0;
        if (foreignSince && now - foreignSince > 3000) setCover(false);
      } else if (awaySince && now - awaySince > 5000) {
        // Nothing to look for (some store apps): something else has been in
        // front for a while, so that is the game.
        return finish(false);
      }
      if (token !== launchWatch) return;
      if (game) return finish(false, game.hwnd);
      monitor.poke(0);
      setTimeout(step, 450);
    };
    setTimeout(step, 600);
  }

  // In-game overlay
  ipcMain.handle('overlay:closed', () => overlay.hideNow());
  ipcMain.handle('overlay:navigate', async (_e, nav) => {
    await overlay.hideNow({ restoreFocus: false });
    await showLauncher(nav);
  });
  ipcMain.handle('overlay:toggle', () => overlay.toggle({ running: monitor.list() }));
  // Sound themes
  ipcMain.handle('sounds:list', () => packs.list());
  ipcMain.handle('sounds:browse', (_e, q) => packs.browse(q || {}));
  ipcMain.handle('sounds:download', (_e, theme) => packs.download(theme));
  ipcMain.handle('sounds:remove', async (_e, id) => {
    await packs.remove(id);
    const s = settings.data;
    const patch = {};
    if (s.soundPack === id) patch.soundPack = null;
    if (s.musicPack === id) patch.musicPack = null;
    if (Object.keys(patch).length) {
      Object.assign(s, patch);
      settings.saveNow();
      send('settings:changed', s);
    }
    return true;
  });
  ipcMain.handle('sounds:installLocal', async (_e, kind, picked) => {
    const k = await files.kind(picked);
    if (kind === 'folder' ? k !== 'dir' : k !== 'file' || !/\.zip$/i.test(String(picked))) return null;
    return packs.installLocal(path.resolve(picked));
  });

  ipcMain.handle('pad:fallback', (_e, on) => {
    passthrough.fallback = !!on;
    system.keepPadForward(passthrough.enabled || passthrough.fallback);
  });
  // live: straight from the helper (its output counters), not the last state it announced.
  ipcMain.handle('passthrough:status', (_e, live) => (!live && passthrough.state) || system.request('passthroughStatus', {}, 3000).catch(() => null));

  /* Captures (OBS) */
  const captureNote = (n) => send('notify', { icon: 'camera', kind: 'capture', ...n });
  const captureLength = (s) => {
    const n = Math.round(Number(s) || 0);
    const m = Math.floor(n / 60);
    return m ? `${m} min${n % 60 ? ` ${n % 60} s` : ''}` : `${n} s`;
  };
  const captureError = (title, err) => captureNote({ title, body: String((err && err.message) || err), icon: 'info' });
  // The newest capture, for the quick menu's card (both windows: the overlay doesn't get notifications).
  let lastCapture = null;
  const captureSaved = (n) => {
    lastCapture = { ...n, time: Date.now() };
    send('capture:saved', lastCapture);
  };
  ipcMain.handle('capture:last', () => lastCapture);
  ipcMain.handle('capture:state', () => obs.publicState());
  ipcMain.handle('capture:encoders', () => obs.encoderInfo());
  ipcMain.handle('capture:list', () => obs.list());
  // One file, or several (Media Gallery › Select Media).
  ipcMain.handle('capture:delete', async (_e, file) => {
    if (!Array.isArray(file)) return obs.remove(file);
    let n = 0;
    for (const f of file) if (await obs.remove(f).catch(() => false)) n++;
    return n;
  });
  ipcMain.handle('capture:favorite', (_e, file, on) => obs.setFavorite(file, !!on));
  // The captures folder (made if needed), for the file browser.
  ipcMain.handle('capture:dir', async () => {
    await fs.promises.mkdir(obs.dir, { recursive: true }).catch(() => {});
    return obs.dir;
  });
  ipcMain.handle('capture:pickDir', async (_e, dir) => {
    if ((await files.kind(dir)) !== 'dir') return null;
    settings.data.captureDir = path.resolve(dir);
    settings.saveNow();
    send('settings:changed', settings.data);
    obs.onSettings().catch(() => {});
    return settings.data.captureDir;
  });
  ipcMain.handle('capture:open', () => onShare());
  ipcMain.handle('capture:action', async (_e, kind) => {
    const game = obs.game ? obs.game.name : '';
    try {
      if (kind === 'clip') {
        const c = await obs.saveClip();
        captureNote({ title: 'Recent gameplay saved', body: c.seconds ? `${game} · ${captureLength(c.seconds)}` : game, image: c.thumbUrl, icon: 'clipRecent' });
        captureSaved({ kind: 'clip', title: 'Recent gameplay saved', game, image: c.thumbUrl || null, url: c.url || null });
        return c;
      }
      if (kind === 'screenshot') {
        const c = await obs.screenshot();
        captureNote({ title: 'Screenshot saved', body: game, image: c.url, icon: 'camera' });
        captureSaved({ kind: 'screenshot', title: 'Screenshot saved', game, image: c.url || null, url: c.url || null });
        return c;
      }
      if (kind === 'record') {
        const r = await obs.toggleRecording();
        if (r.started) captureNote({ title: 'Recording started', body: game, icon: 'record' });
        else {
          captureNote({ title: 'Recording saved', body: r.capture && r.capture.seconds ? `${game} · ${captureLength(r.capture.seconds)}` : game, image: r.capture && r.capture.thumbUrl, icon: 'record' });
          captureSaved({ kind: 'recording', title: 'Recording saved', game, image: (r.capture && r.capture.thumbUrl) || null, url: (r.capture && r.capture.url) || null });
        }
        return r;
      }
    } catch (err) {
      captureError(kind === 'clip' ? "Couldn't save the clip" : kind === 'screenshot' ? "Couldn't take the screenshot" : "Couldn't record", err);
      throw err;
    }
    return null;
  });

  ipcMain.handle('notify:popup', (_e, n) => {
    if (!n || typeof n !== 'object') return;
    overlay.popup({ title: String(n.title || ''), body: String(n.body || ''), icon: String(n.icon || 'bell'), image: n.image ? String(n.image) : null, duration: Math.min(15000, Number(n.duration) || 5000), kind: String(n.kind || 'system') });
  });
  ipcMain.handle('games:running', () => monitor.list());
  async function continueGame(id) {
    const r = monitor.get(id);
    if (!r) return { continued: false };
    await resumeNow();
    if (overlay.visible) await overlay.hideNow({ restoreFocus: false });
    const ok = await system.request('focusProc', { pid: r.pid }, 4000).catch(() => false);
    if (ok && win && settings.data.onLaunch === 'minimize') setTimeout(() => win && !win.isFocused() && win.minimize(), 300);
    return { continued: !!ok };
  }
  ipcMain.handle('game:continue', (_e, id) => continueGame(id));

  ipcMain.handle('game:close', async (e, id) => {
    const fromOverlay = !!(overlay.win && e.sender === overlay.win.webContents);
    const r = monitor.get(id);
    closingPid = r ? r.pid : null;
    try {
      if (pausedPid) await resumeNow();
      if (fromOverlay) {
        // Put the home screen up in front of the game first and close the game
        // behind it, so the desktop never shows in between.
        await showLauncher({ view: 'home' });
        await new Promise((res) => setTimeout(res, 350));
        await overlay.hideNow({ restoreFocus: false });
      }
      return await monitor.close(id);
    } finally {
      closingPid = null;
    }
  });

  // Media, volume and brightness (native helper)
  ipcMain.handle('sys:available', () => system.available());
  ipcMain.handle('sys:media', (_e, appId, knownKey) => system.media(appId, knownKey));
  ipcMain.handle('sys:mediaPlaying', () => system.request('mediaPlaying', {}, 3000).catch(() => false));
  ipcMain.handle('sys:mediaCmd', (_e, appId, action, value) => system.mediaCommand(appId, action, value));
  ipcMain.handle('sys:volume', () => system.volume());
  ipcMain.handle('sys:setVolume', (_e, v) => system.setVolume(v));
  ipcMain.handle('sys:setMute', (_e, m) => system.setMute(m));
  ipcMain.handle('sys:audioOutputs', () => system.audioOutputs());
  ipcMain.handle('sys:setAudioOutput', (_e, id) => system.setAudioOutput(id));
  ipcMain.handle('sys:brightness', () => system.brightness());
  ipcMain.handle('sys:setBrightness', (_e, v, index) => system.setBrightness(v, index));
  ipcMain.handle('sys:nightLight', () => system.nightLight());
  ipcMain.handle('sys:setNightLight', (_e, on) => system.setNightLight(on));
  ipcMain.handle('sys:hdr', () => system.hdr());
  ipcMain.handle('sys:setHdr', (_e, on, index) => system.setHdr(on, Number.isInteger(index) ? index : -1));
  ipcMain.handle('bt:state', () => system.bluetooth());
  ipcMain.handle('bt:radio', (_e, on) => system.bluetoothRadio(on));
  ipcMain.handle('bt:connect', (_e, address, connect) => system.bluetoothConnect(address, connect));
  ipcMain.handle('bt:pair', (_e, id) => system.bluetoothPair(id));
  ipcMain.handle('bt:unpair', (_e, id) => system.bluetoothUnpair(id));
  ipcMain.handle('bt:scan', (_e, action) => system.bluetoothScan(action));

  // Discord party (voice) controls
  ipcMain.handle('update:state', () => updater.publicState());
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:download', () => updater.download());
  ipcMain.handle('update:install', () => updater.install(() => app.quit()));
  ipcMain.handle('steamfriends:get', (_e, opts) => steamFriends.get(opts || {}));
  ipcMain.handle('steamfriends:setKey', (_e, data) => steamFriends.setKey(data || {}));
  ipcMain.handle('steamfriends:forget', () => steamFriends.forget());
  ipcMain.handle('steamfriends:open', (_e, kind, id) => steamFriends.open(kind, id));
  ipcMain.handle('discord:state', () => discord.publicState());
  ipcMain.handle('discord:setup', (_e, data) => discord.setup(data || {}));
  ipcMain.handle('discord:connect', () => discord.connect({ interactive: true }));
  ipcMain.handle('discord:disconnect', () => discord.disconnect());
  ipcMain.handle('discord:forget', () => discord.forget());
  ipcMain.handle('discord:cmd', (_e, name, value, extra) => discord.command(name, value, extra));
  ipcMain.handle('discord:guilds', (_e, opts) => discord.guilds(opts || {}));
  ipcMain.handle('discord:voiceChannels', (_e, guildId) => discord.voiceChannels(guildId));
  ipcMain.handle('discord:directChats', () => discord.directChats());
  ipcMain.handle('discord:openChat', (_e, id) => discord.openChat(id));
  ipcMain.handle('discord:closeChat', () => discord.closeChat());
  ipcMain.handle('discord:openInDiscord', (_e, id, guild) => discord.openInDiscord(id, guild));

  ipcMain.handle('downloads:state', () => downloads.publicState());
  // Update a Steam game now (by library id or Steam app id).
  ipcMain.handle('downloads:update', (_e, id) => {
    const g = library.find(String(id || ''));
    const appid = g ? g.steamAppId : id;
    if (!appid) throw new Error('This game has no Steam app id.');
    return downloads.update(appid);
  });
  // Install a Steam game the account owns (Steam's install dialog opens).
  // library: the Steam library folder picked in the launcher (no Steam dialog); without it Steam's own dialog opens.
  ipcMain.handle('downloads:install', (_e, id, library) => {
    const g = library_(id);
    return library ? downloads.installTo(g.steamAppId, library, { name: g.name, gameId: g.id }) : downloads.install(g.steamAppId, { name: g.name, gameId: g.id });
  });
  ipcMain.handle('downloads:installInfo', (_e, id) => downloads.installInfo(library_(id).steamAppId));
  function library_(id) {
    const g = library.find(String(id || ''));
    if (!g || !g.steamAppId) throw new Error('This game has no Steam app id.');
    return g;
  }
  ipcMain.handle('downloads:openSteam', () => shell.openExternal('steam://open/downloads'));

  /* Settings › Storage › Games and Apps: drives, installed games, deleting them. */
  const storage = new Storage({ library, system, steam: downloads, monitor, settings, dataDir, send });
  ipcMain.handle('storage:info', () => storage.info());
  ipcMain.handle('storage:delete', (_e, ids) => storage.remove(Array.isArray(ids) ? ids : [ids]));

  ipcMain.handle('steam:search', (_e, term) => searchSteam(String(term || '')).catch(() => []));

  ipcMain.handle('cache:size', () => library.cacheSize());
  ipcMain.handle('app:dataDir', () => dataDir);
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^(steam:\/\/|discord:\/\/|https:\/\/(store\.steampowered\.com|www\.steamgriddb\.com|discord\.com\/developers|steamcommunity\.com\/dev\/apikey|github\.com\/nefarius\/HidHide|github\.com\/Alia5\/VIIPER|obsproject\.com)\/?)/.test(String(url))) {
      return shell.openExternal(url);
    }
    return null;
  });

  ipcMain.handle('window:action', (_e, action) => {
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'close') app.quit();
    else if (action === 'toggleFullscreen') {
      const fs = !win.isFullScreen();
      win.setFullScreen(fs);
      send('window:state', { fullscreen: fs, focused: win.isFocused() });
      return { fullscreen: fs };
    }
    return { fullscreen: win.isFullScreen() };
  });

  ipcMain.handle('power:action', (_e, action) => {
    const run = (cmd, args) => execFile(cmd, args, { windowsHide: true }, () => {});
    if (action === 'shutdown') run('shutdown', ['/s', '/t', '0']);
    else if (action === 'restart') run('shutdown', ['/r', '/t', '0']);
    else if (action === 'sleep') {
      run('powershell', [
        '-NoProfile',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState("Suspend", $false, $false)',
      ]);
    }
  });
}

