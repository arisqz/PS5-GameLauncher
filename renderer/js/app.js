import { $, h } from './util.js';
import { state, on, emit, loadState, api, pushNotification } from './state.js';
import { setHandler, externalAction, setGamepadPolling, setGamepadProbe } from './input.js';
import { sfx, configureSound, setAmbient, unlockAudio, resetAudio, setSoundPacks } from './sound.js';
import { background } from './background.js';
import { heroBg } from './ui/herobg.js';
import { topOverlay } from './ui/overlay.js';
import { initToasts } from './ui/toast.js';
import { HomeView } from './views/home.js';
import { LibraryView } from './views/library.js';
import { SettingsView } from './views/settings.js';
import { HubView } from './views/hub.js';
import { QuickMenu } from './views/quickmenu.js';
import { openSearch } from './views/search.js';
import { runBoot } from './views/boot.js';
import { loadDiscord } from './discord.js';
import { setLanguage, t, language } from './i18n.js';

const viewsRoot = $('#views');

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export const router = {
  views: {},
  stack: [],
  register(view) {
    this.views[view.name] = view;
    viewsRoot.append(view.el);
  },
  get current() {
    return this.views[this.stack[this.stack.length - 1]] || null;
  },
  open(name, params = {}) {
    const prev = this.current;
    if (prev && prev.name === name) {
      prev.show(params, 'same');
      return;
    }
    const idx = this.stack.indexOf(name);
    if (idx >= 0) this.stack.length = idx + 1;
    else this.stack.push(name);
    transition(prev, this.current, params, idx >= 0 ? 'back' : 'forward');
  },
  back() {
    if (this.stack.length <= 1) return false;
    const prev = this.current;
    this.stack.pop();
    transition(prev, this.current, {}, 'back');
    return true;
  },
  home(params = {}) {
    if (this.current && this.current.name === 'home') {
      this.current.show(params, 'same');
      return;
    }
    const prev = this.current;
    this.stack = ['home'];
    transition(prev, this.current, params, 'back');
  },
  openSearch() {
    openSearch(router);
  },
};

function transition(from, to, params, dir) {
  if (from) {
    from.hide();
    const el = from.el;
    el.classList.remove('active', 'anim-in', 'anim-back-in');
    el.classList.add(dir === 'back' ? 'anim-back-out' : 'anim-out');
    setTimeout(() => el.classList.remove('anim-out', 'anim-back-out'), 320);
  }
  if (!to) return;
  to.el.classList.remove('anim-out', 'anim-back-out', 'anim-in', 'anim-back-in');
  void to.el.offsetWidth;
  to.el.classList.add('active', dir === 'back' ? 'anim-back-in' : 'anim-in');
  if (!to.usesHero) heroBg.hide();
  background.setVisible(to.usesCanvas !== false);
  to.show(params, dir);
}

/* ------------------------------------------------------------------ */
/* Settings → UI                                                       */
/* ------------------------------------------------------------------ */

let appliedLanguage = null;
let packsKey = null;
// Menu music waits until the user has picked their profile.
let ambientReady = false;

// Another app is playing media (Spotify, a video…): the menu music waits.
let otherMedia = false;
let mediaTimer = null;

function updateAmbient() {
  const s = state.settings;
  const want = ambientReady && !!s.ambient && state.window.focused !== false;
  setAmbient(want && !otherMedia, (s.ambientVolume ?? 35) / 100);
  // Watch Windows media sessions only while the music would play.
  if (want && !mediaTimer) {
    mediaTimer = setInterval(checkOtherMedia, 2000);
    checkOtherMedia();
  } else if (!want && mediaTimer) {
    clearInterval(mediaTimer);
    mediaTimer = null;
  }
}

async function checkOtherMedia() {
  let playing = false;
  try {
    playing = !!(await api.mediaPlaying());
  } catch {}
  if (playing === otherMedia) return;
  otherMedia = playing;
  updateAmbient();
}

/** Load the chosen sound / music packs when they change. */
async function applySoundPacks(force = false) {
  const s = state.settings;
  const key = `${s.soundPack || ''}|${s.musicPack || ''}`;
  if (!force && key === packsKey) return;
  packsKey = key;
  try {
    await setSoundPacks(await api.soundPacks(), s.soundPack, s.musicPack);
  } catch {}
  // The menu music switches to the newly loaded track by itself.
  updateAmbient();
}
on('soundpacks', () => applySoundPacks(true));

function applySettings() {
  const s = state.settings;
  // A new language rebuilds the whole interface: reload, then come back to
  // the Language setting (without the welcome screen).
  if (appliedLanguage !== null && (s.language || 'auto') !== appliedLanguage) {
    try {
      sessionStorage.setItem('reopen', JSON.stringify({ category: 'system', section: 'Language and Font' }));
    } catch {}
    location.reload();
    return;
  }
  document.documentElement.style.setProperty('--ui-scale', String((s.uiScale || 100) / 100));
  document.body.classList.toggle('reduce-motion', !!s.reduceMotion);
  document.documentElement.classList.toggle('font-sst', s.font === 'sst');
  configureSound(s);
  applySoundPacks();
  updateAmbient();
  background.setMode(s.reduceMotion && s.background === 'animated' ? 'static' : s.background);
  heroBg.setMotion(s.heroMotion !== false && !s.reduceMotion);
  updateClocks();
}

function updateClocks() {
  const s = state.settings;
  const now = new Date();
  const text = now.toLocaleTimeString(language(), { hour: 'numeric', minute: '2-digit', hour12: !s.clock24 });
  document.querySelectorAll('[data-clock]').forEach((el) => {
    el.textContent = text;
    el.style.visibility = s.showClock === false ? 'hidden' : '';
  });
}

let awaySince = 0;

function applyWindow() {
  // Back from a game (or anything else that kept the launcher in the background
  // for a while): start with a fresh audio output.
  if (state.window.focused === false) awaySince = awaySince || Date.now();
  else if (awaySince) {
    if (Date.now() - awaySince > 5000) resetAudio();
    awaySince = 0;
  }
  const windowed = !state.window.fullscreen;
  document.documentElement.classList.toggle('windowed', windowed);
  document.body.classList.toggle('windowed', windowed);
  // Pause the ambient music while another app (e.g. a game) has focus.
  updateAmbient();
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

let booting = true;
let bootHandler = null;
let quick = null;

async function main() {
  await loadState();
  appliedLanguage = state.settings.language || 'auto';
  setLanguage(appliedLanguage);
  let reopen = null;
  try {
    reopen = JSON.parse(sessionStorage.getItem('reopen') || 'null');
    sessionStorage.removeItem('reopen');
  } catch {}
  loadDiscord();
  applySettings();
  applyWindow();
  background.init();
  initToasts();

  const home = new HomeView(router);
  router.register(home);
  router.register(new LibraryView(router));
  router.register(new SettingsView(router));
  router.register(new HubView(router));
  quick = new QuickMenu(router);

  setHandler((action, meta) => {
    if (booting) {
      // Dialogs opened from the welcome screen (Options, Power…) come first.
      const o = topOverlay();
      if (o) o.handle(action, meta);
      else if (bootHandler) bootHandler(action, meta);
      return;
    }
    unlockAudio();
    if (action === 'guide') {
      quick.toggle();
      return;
    }
    const o = topOverlay();
    if (o) {
      o.handle(action, meta);
      return;
    }
    const v = router.current;
    if (v && v.handle(action, meta)) return;
    if (action === 'back' && router.back()) sfx.back();
  });

  on('settings', applySettings);
  on('window', applyWindow);
  on('clock', updateClocks);
  setInterval(updateClocks, 5000);

  // Guide button read natively (works for every controller type).
  api.on('pad:action', (a) => {
    const action = typeof a === 'string' ? a : a && a.action;
    if (action === 'guide') {
      if (!booting) externalAction('guide');
    } else if (action && ((state.passthrough && state.passthrough.enabled) || padFallback)) externalAction(action, { repeat: !!(a && a.repeat) });
  });
  // Passthrough just went off: until the browser sees the real controller
  // again (it reconnects), keep reading it through the helper.
  let padFallback = false;
  const setPadFallback = (on) => {
    if (padFallback === on) return;
    padFallback = on;
    api.padFallback(on).catch(() => {});
  };

  // Controller passthrough: the browser would only see the (muted) virtual
  // controller, so read the real one through the helper instead.
  const applyPassthrough = (st) => {
    const was = !!(state.passthrough && state.passthrough.enabled);
    state.passthrough = st || null;
    const now = !!(st && st.enabled);
    if (now) {
      setGamepadProbe(null);
      setGamepadPolling(false);
      setPadFallback(false);
    } else if (was) {
      // Keep using the helper until the browser delivers a press itself.
      setPadFallback(true);
      setGamepadProbe(() => {
        setPadFallback(false);
        setGamepadPolling(true);
      });
    } else if (!padFallback) setGamepadPolling(true);
    emit('passthrough');
  };
  api.on('passthrough:state', applyPassthrough);
  api.passthroughStatus().then(applyPassthrough).catch(() => {});
  // Requests from the in-game overlay ("Home", "Game Library", closing a game…).
  api.on('navigate', (nav) => {
    if (!nav || booting) return;
    while (topOverlay()) topOverlay().close();
    if (nav.view === 'home') router.home(nav.params || {});
    else if (nav.view === 'search') {
      router.home();
      router.openSearch();
    } else router.open(nav.view, nav.params || {});
  });

  on('game-exited', (e) => {
    const g = state.games.find((x) => x.id === e.id);
    if (!g || e.shortLived) return;
    pushNotification({ title: g.name, body: e.minutes ? t(e.minutes === 1 ? 'You played for 1 minute.' : 'You played for {n} minutes.', { n: e.minutes }) : 'Session ended.', icon: 'gamepad', kind: 'game' });
  });
  on('gamepad', (e) => controllerNotice(e));

  setupDragDrop();
  window.__app = { router, state };

  router.stack = ['home'];
  document.body.classList.add('booting');
  home.el.classList.add('active');
  home.refresh(true);
  // Shown (hidden behind the boot stage) right away, so the hero art has
  // loaded by the time the stage fades.
  home.show({});

  await runBoot({
    welcome: state.settings.welcomeScreen !== false && !reopen,
    setHandler: (fn) => {
      bootHandler = fn;
    },
    intro: (stage) => home.playBootIntro(stage),
  });
  booting = false;
  bootHandler = null;
  ambientReady = true;
  updateAmbient();
  if (reopen) router.open('settings', reopen);
}

/*
 * Controller connected / disconnected pop-ups. Controller passthrough swaps
 * the real pad for a virtual one (and briefly reconnects it), so: a pad that
 * comes back within a few seconds isn't announced at all, nothing is
 * announced while passthrough is switching, and at most one pop-up shows
 * every few seconds.
 */
const padNotice = { pending: new Map(), lastShown: 0, quietUntil: 0, recent: new Map() };
on('passthrough', () => {
  padNotice.quietUntil = Date.now() + 8000;
});
function controllerNotice(e) {
  if (booting) return;
  const name = e.pad.id.replace(/\s*\(.*\)\s*$/, '') || 'Gamepad';
  const now = Date.now();
  if (now < padNotice.quietUntil) return;
  const pending = padNotice.pending.get(name);
  if (pending) {
    // Disconnected and back again (or the other way round): say nothing.
    clearTimeout(pending.timer);
    padNotice.pending.delete(name);
    if (pending.connected !== e.connected) return;
  }
  const timer = setTimeout(() => {
    padNotice.pending.delete(name);
    const t0 = Date.now();
    if (t0 < padNotice.quietUntil) return;
    // The same news about the same pad twice in a row isn't worth repeating.
    const key = `${name}|${e.connected}`;
    if (t0 - (padNotice.recent.get(key) || 0) < 30000) return;
    if (t0 - padNotice.lastShown < 4000) return;
    padNotice.recent.set(key, t0);
    padNotice.lastShown = t0;
    pushNotification({ title: e.connected ? 'Controller connected' : 'Controller disconnected', body: name, icon: 'gamepad', kind: 'controller' });
  }, 3000);
  padNotice.pending.set(name, { connected: e.connected, timer });
}

function setupDragDrop() {
  let depth = 0;
  const hint = h('div', { class: 'drop-hint', html: `<div><b>${t('Drop to add games')}</b><span>${t('Shortcuts, executables or folders')}</span></div>` });
  document.body.append(hint);
  const importDropped = async (paths) => {
    if (!paths.length) return;
    sfx.select();
    const n = await api.importPaths(paths);
    if (!n) pushNotification({ title: 'Nothing new to add', body: 'Those items are already in your library.', icon: 'info' });
  };
  // Tauri: the window reports dropped files with their paths.
  if (api.onFileDrop) {
    api.onFileDrop({
      enter: () => hint.classList.add('show'),
      leave: () => hint.classList.remove('show'),
      drop: (paths) => {
        hint.classList.remove('show');
        importDropped(paths);
      },
    });
    return;
  }
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    hint.classList.add('show');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) hint.classList.remove('show');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    hint.classList.remove('show');
    await importDropped([...(e.dataTransfer?.files || [])].map((f) => api.pathForFile(f)).filter(Boolean));
  });
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="color:#f88;padding:40px;font-size:16px;white-space:pre-wrap">${String(err && err.stack ? err.stack : err)}</pre>`;
});
