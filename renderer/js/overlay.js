// The in-game overlay window: the same quick menu as the launcher, drawn in a
// transparent always-on-top window above the game. Navigation targets
// (Home, Library, Settings…) are opened in the launcher window instead.

import { state, on, emit, loadState, api } from './state.js';
import { initDualsense } from './dualsense.js';
import { setHandler, setGamepadPolling, externalAction } from './input.js';
import { configureSound, unlockAudio, setSoundPacks, resetAudio } from './sound.js';
import { topOverlay } from './ui/overlay.js';
import { watchFocusRings } from './ui/focusfx.js';
import { QuickMenu } from './views/quickmenu.js';
import { loadDiscord } from './discord.js';
import { loadFriends } from './steamfriends.js';
import { setLanguage, language } from './i18n.js';
import { toast } from './ui/toast.js';
import { openCaptureBar } from './ui/capturebar.js';

const router = {
  home: (params) => api.overlayNavigate({ view: 'home', params }),
  open: (view, params) => api.overlayNavigate({ view, params }),
  openSearch: () => api.overlayNavigate({ view: 'search' }),
};

let packsKey = null;

function applySettings() {
  const s = state.settings;
  document.documentElement.style.setProperty('--ui-scale', String((s.uiScale || 100) / 100));
  document.body.classList.toggle('reduce-motion', !!s.reduceMotion);
  document.documentElement.classList.toggle('font-sst', s.font === 'sst');
  configureSound(s);
  const key = `${s.soundPack || ''}|${s.musicPack || ''}`;
  if (key !== packsKey) {
    packsKey = key;
    api.soundPacks().then((list) => setSoundPacks(list, s.soundPack, null)).catch(() => {});
  }
  updateClock();
}

function updateClock() {
  const s = state.settings;
  const text = new Date().toLocaleTimeString(language(), { hour: 'numeric', minute: '2-digit', hour12: !s.clock24 });
  document.querySelectorAll('[data-clock]').forEach((el) => {
    el.textContent = text;
    el.style.visibility = s.showClock === false ? 'hidden' : '';
  });
}

async function main() {
  await loadState();
  const lang = state.settings.language || 'auto';
  setLanguage(lang);
  // The launcher changed the language: rebuild this window too.
  on('settings', () => (state.settings.language || 'auto') !== lang && location.reload());
  loadDiscord();
  loadFriends();
  applySettings();
  // Controller input comes from the native helper (the browser only sees
  // gamepads while this window is focused, which a game may not allow).
  setGamepadPolling(false);

  const quick = new QuickMenu(router, { overlay: true });
  quick.onClosed = () => {
    if (!quick.ctl) api.overlayClosed();
  };

  // The capture menu (Create button) is the other thing this window shows.
  let capture = null;
  const closeCapture = () => {
    if (capture) capture.close();
    else api.overlayClosed();
  };

  setHandler((action, meta) => {
    unlockAudio();
    if (action === 'guide' && !capture) {
      if (quick.ctl) quick.close();
      else api.overlayClosed();
      return;
    }
    const o = topOverlay();
    if (o) o.handle(action, meta);
  });

  api.on('overlay:open', (info) => {
    if (info && info.mode === 'capture') {
      if (!capture && !quick.ctl) {
        capture = openCaptureBar({
          capture: info.capture,
          navigate: (nav) => api.overlayNavigate(nav),
          onClosed: () => {
            capture = null;
            // After the closing animation, like the quick menu.
            setTimeout(() => !quick.ctl && !capture && api.overlayClosed(), 280);
          },
        });
      }
      return;
    }
    if (!quick.ctl) quick.open();
    updateClock();
  });
  api.on('overlay:toast', (n) => toast({ ...n, sound: true }));
  // Controller passthrough (the quick menu's controller rows show it).
  const setPassthrough = (st) => {
    state.passthrough = st || null;
    emit('passthrough');
  };
  api.on('passthrough:state', setPassthrough);
  api.passthroughStatus().then(setPassthrough).catch(() => {});
  initDualsense();
  watchFocusRings();
  // In-game sleep: close the audio output until the next menu or notification.
  on('sleep', (asleep) => asleep && resetAudio());
  // The window was hidden without the page closing its menu (it opened the
  // launcher, or the game ended): close what is left, quietly.
  api.on('overlay:hidden', () => {
    if (capture) capture.close();
    if (quick.ctl) quick.close({ quiet: true });
  });
  api.on('overlay:close', () => {
    if (capture) closeCapture();
    else if (quick.ctl) quick.close();
    else api.overlayClosed();
  });
  api.on('pad:action', (a) => {
    if (!a) return;
    if (typeof a === 'string') externalAction(a);
    else externalAction(a.action, { repeat: !!a.repeat, kind: a.kind });
  });

  on('settings', applySettings);
  on('clock', updateClock);
  setInterval(updateClock, 5000);
}

main().catch((err) => console.error(err));
