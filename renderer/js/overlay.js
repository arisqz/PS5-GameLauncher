// The in-game overlay window: the same quick menu as the launcher, drawn in a
// transparent always-on-top window above the game. Navigation targets
// (Home, Library, Settings…) are opened in the launcher window instead.

import { state, on, loadState, api } from './state.js';
import { setHandler, setGamepadPolling, externalAction } from './input.js';
import { configureSound, unlockAudio } from './sound.js';
import { topOverlay } from './ui/overlay.js';
import { QuickMenu } from './views/quickmenu.js';
import { loadDiscord } from './discord.js';
import { setLanguage, language } from './i18n.js';

const router = {
  home: (params) => api.overlayNavigate({ view: 'home', params }),
  open: (view, params) => api.overlayNavigate({ view, params }),
  openSearch: () => api.overlayNavigate({ view: 'search' }),
};

function applySettings() {
  const s = state.settings;
  document.documentElement.style.setProperty('--ui-scale', String((s.uiScale || 100) / 100));
  document.body.classList.toggle('reduce-motion', !!s.reduceMotion);
  configureSound(s);
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
  applySettings();
  // Controller input comes from the native helper (the browser only sees
  // gamepads while this window is focused, which a game may not allow).
  setGamepadPolling(false);

  const quick = new QuickMenu(router, { overlay: true });
  quick.onClosed = () => {
    if (!quick.ctl) api.overlayClosed();
  };

  setHandler((action, meta) => {
    unlockAudio();
    if (action === 'guide') {
      if (quick.ctl) quick.close();
      else api.overlayClosed();
      return;
    }
    const o = topOverlay();
    if (o) o.handle(action, meta);
  });

  api.on('overlay:open', () => {
    if (!quick.ctl) quick.open();
    updateClock();
  });
  api.on('overlay:close', () => {
    if (quick.ctl) quick.close();
    else api.overlayClosed();
  });
  api.on('pad:action', (a) => {
    if (!a) return;
    if (typeof a === 'string') externalAction(a);
    else externalAction(a.action, { repeat: !!a.repeat });
  });

  on('settings', applySettings);
  on('clock', updateClock);
  setInterval(updateClock, 5000);
}

main().catch((err) => console.error(err));
