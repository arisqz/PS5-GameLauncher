const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog, Menu, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { JsonStore } = require('./store');
const { Library } = require('./library');
const { launchGame } = require('./launcher');
const { searchSteam } = require('./metadata');
const { SystemBridge } = require('./system');
const { DiscordBridge } = require('./discord');
const { OverlayManager } = require('./overlay');
const { GameMonitor } = require('./gamemonitor');

const DEFAULT_SETTINGS = {
  // Library
  folders: [],
  scanSteam: true,
  scanEpic: true,
  scanXbox: true,
  scanUbisoft: true,
  preferDirect: false,
  rescanOnStartup: true,
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
  // Screen
  fullscreen: true,
  uiScale: 100,
  reduceMotion: false,
  // Controllers
  prompts: 'auto',
  vibration: true,
  // System
  launchAtStartup: false,
  onLaunch: 'minimize',
  overlay: true,
  overlayHotkey: true,
  pauseGames: true,
  qmHidden: [],
  restoreOnExit: true,
  welcomeScreen: true,
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
};

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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
    for (const name of ['settings.json', 'library.json', 'discord.json', 'Local State', 'artwork', 'avatars']) {
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
  const settings = new JsonStore(path.join(dataDir, 'settings.json'), DEFAULT_SETTINGS);
  const libStore = new JsonStore(path.join(dataDir, 'library.json'), { games: [], excluded: [] });

  /** @type {BrowserWindow | null} */
  let win = null;
  let overlay = null;
  // Most state goes to both the launcher and the in-game overlay window.
  const MAIN_ONLY = new Set(['window:state', 'notify', 'scan:progress', 'navigate']);
  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    if (!MAIN_ONLY.has(channel) && overlay) overlay.send(channel, payload);
  };
  const library = new Library({ store: libStore, settings, artDir, send });
  const system = new SystemBridge();
  const discord = new DiscordBridge({ file: path.join(dataDir, 'discord.json'), send });
  overlay = new OverlayManager({ system, onVisibility: (visible) => (visible ? schedulePause() : updatePause()) });

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
    if (settings.data.pauseGames !== false && cur && settled && cur.pid !== closingPid && !monitor.hasAntiCheat(cur.id) && (overlay.visible || launcherFront)) {
      const g = library.find(cur.id);
      const mode = (g && g.pauseMode) || 'auto';
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
    },
    onEnded: (id, minutes) => {
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
  system.on('pad', (e) => {
    if (overlay.visible && e.action) overlay.send('pad:action', { action: e.action, repeat: !!e.repeat });
  });

  function applyHotkey() {
    globalShortcut.unregisterAll();
    if (settings.data.overlayHotkey !== false) {
      try {
        globalShortcut.register('Control+Alt+Home', onGuide);
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
      pushState();
      schedulePause();
    });
    let lastPlaytimeRefresh = 0;
    win.on('focus', () => {
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
    const roots = { ui: rendererDir, art: artDir, avatar: avatarDir };
    protocol.handle('app', async (req) => {
      const u = new URL(req.url);
      const base = roots[u.hostname] || null;
      if (!base) return new Response('not found', { status: 404 });
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.normalize(path.join(base, rel));
      if (!file.startsWith(base + path.sep)) return new Response('forbidden', { status: 403 });
      try {
        const res = await net.fetch(pathToFileURL(file).toString());
        return new Response(res.body, {
          status: res.status,
          headers: {
            'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'access-control-allow-origin': '*',
            'cache-control': u.hostname === 'ui' ? 'no-cache' : 'max-age=31536000',
          },
        });
      } catch {
        return new Response('not found', { status: 404 });
      }
    });

    createWindow();
    system.start();
    discord.start();
    overlay.create();
    monitor.start();
    applyHotkey();

    if (settings.data.rescanOnStartup || libStore.data.games.length === 0) {
      setTimeout(() => library.scan({ silent: true }).then(() => library.refreshSteamPlaytime()).catch(console.error), 1800);
    } else {
      const pending = library.games.filter((g) => g.metaStatus === 'pending');
      if (pending.length) setTimeout(() => library.fetchMetadata(pending), 1800);
    }
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.on('before-quit', () => {
    if (pausedPid) system.request('resume', { pid: pausedPid }).catch(() => {});
  });

  app.on('window-all-closed', () => {
    monitor.stop();
    system.stop();
    discord.close();
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
    const rescanKeys = ['scanSteam', 'scanEpic', 'scanXbox', 'scanUbisoft'];
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

  ipcMain.handle('library:addFolder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a folder with game shortcuts',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const folder = r.filePaths[0];
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
  ipcMain.handle('library:addFiles', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add games',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Games & shortcuts', extensions: ['lnk', 'url', 'exe', 'bat', 'cmd'] }],
    });
    if (r.canceled) return 0;
    return library.importPaths(r.filePaths);
  });
  ipcMain.handle('library:restoreExcluded', async () => {
    const n = library.restoreExcluded();
    await library.scan({ silent: true });
    return n;
  });
  ipcMain.handle('library:reset', () => library.reset());

  ipcMain.handle('game:update', (_e, id, patch) => library.update(id, patch || {}));
  ipcMain.handle('game:remove', (_e, id) => library.remove(id));
  ipcMain.handle('game:refreshArt', (_e, id) => {
    const g = library.find(id);
    return g ? library.fetchMetadata([g], { force: true }) : null;
  });
  ipcMain.handle('game:setMatch', (_e, id, appid) => library.setMatch(id, appid));
  ipcMain.handle('game:customArt', async (_e, id, kind) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose an image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return library.setCustomArt(id, kind, r.filePaths[0]);
  });
  // Profile pictures are copied into the data folder under a new name, so
  // replacing one never shows a stale cached image.
  ipcMain.handle('profile:pickImage', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a profile picture',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const src = r.filePaths[0];
    const name = `${Date.now().toString(36)}${path.extname(src).toLowerCase()}`;
    await fs.promises.mkdir(avatarDir, { recursive: true });
    await fs.promises.copyFile(src, path.join(avatarDir, name));
    return `app://avatar/${name}`;
  });
  ipcMain.handle('profile:removeImage', async (_e, url) => {
    const m = /^app:\/\/avatar\/([\w.-]+)$/.exec(String(url || ''));
    if (m) await fs.promises.rm(path.join(avatarDir, m[1]), { force: true }).catch(() => {});
  });
  ipcMain.handle('game:openLocation', (_e, id) => {
    const g = library.find(id);
    if (!g) return;
    const target = g.path || g.exe || g.installDir;
    if (target && fs.existsSync(target)) shell.showItemInFolder(target);
    else if (g.installDir && fs.existsSync(g.installDir)) shell.openPath(g.installDir);
  });

  ipcMain.handle('game:launch', async (_e, id) => {
    const g = library.find(id);
    if (!g) throw new Error('Game not found');
    // Already running: bring it back instead of starting a second copy.
    if (monitor.get(id)) return continueGame(id);
    monitor.noteLaunch(id);
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
    setCover(false);
  }
  ipcMain.handle('game:launchCancel', () => stopWatch());

  function whenGameShows(id, then) {
    const token = ++launchWatch;
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
  ipcMain.handle('bt:state', () => system.bluetooth());
  ipcMain.handle('bt:radio', (_e, on) => system.bluetoothRadio(on));
  ipcMain.handle('bt:connect', (_e, address, connect) => system.bluetoothConnect(address, connect));
  ipcMain.handle('bt:pair', (_e, id) => system.bluetoothPair(id));
  ipcMain.handle('bt:unpair', (_e, id) => system.bluetoothUnpair(id));
  ipcMain.handle('bt:scan', (_e, action) => system.bluetoothScan(action));

  // Discord party (voice) controls
  ipcMain.handle('discord:state', () => discord.publicState());
  ipcMain.handle('discord:setup', (_e, data) => discord.setup(data || {}));
  ipcMain.handle('discord:connect', () => discord.connect({ interactive: true }));
  ipcMain.handle('discord:disconnect', () => discord.disconnect());
  ipcMain.handle('discord:forget', () => discord.forget());
  ipcMain.handle('discord:cmd', (_e, name, value, extra) => discord.command(name, value, extra));

  ipcMain.handle('steam:search', (_e, term) => searchSteam(String(term || '')).catch(() => []));

  ipcMain.handle('cache:size', () => library.cacheSize());
  ipcMain.handle('app:openData', () => shell.openPath(dataDir));
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^(steam:\/\/|discord:\/\/|https:\/\/(store\.steampowered\.com|www\.steamgriddb\.com|discord\.com\/developers)\/)/.test(String(url))) {
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
