// Central app state + a tiny event bus. Everything that talks to the main
// process goes through window.api (see main/preload.js).

import { t } from './i18n.js';

export const api = window.api;

export const state = {
  settings: {},
  games: [],
  info: {},
  running: new Set(),
  runningSince: {}, // gameId -> timestamp the session started
  notifications: [],
  scan: { active: false },
  window: { fullscreen: true, focused: true },
};

const listeners = new Map();

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}

export function emit(evt, data) {
  for (const fn of listeners.get(evt) || []) {
    try {
      fn(data);
    } catch (err) {
      console.error(`[bus] ${evt} handler failed`, err);
    }
  }
}

export async function loadState() {
  const s = await api.getState();
  state.settings = s.settings;
  state.games = s.games;
  state.info = s.info;
  setRunning(s.running || []);
  if (s.window) state.window = s.window;

  api.on('library:changed', (games) => {
    state.games = games;
    emit('games');
  });
  api.on('settings:changed', (settings) => {
    state.settings = settings;
    emit('settings', null);
  });
  api.on('scan:progress', (p) => {
    state.scan = p;
    emit('scan', p);
  });
  api.on('game:running', (list) => {
    setRunning(list);
    emit('running');
  });
  api.on('window:state', (w) => {
    state.window = w;
    emit('window', w);
  });
  api.on('notify', (n) => pushNotification(n));
  api.on('game:exited', (e) => emit('game-exited', e));
}

function setRunning(list) {
  const items = (list || []).map((x) => (typeof x === 'string' ? { id: x, since: Date.now() } : x));
  state.running = new Set(items.map((x) => x.id));
  state.runningSince = Object.fromEntries(items.map((x) => [x.id, x.since]));
}

/** The game that is running now (most recently started), or null. */
export function currentGame() {
  let best = null;
  for (const id of state.running) {
    const g = state.games.find((x) => x.id === id);
    if (g && (!best || (state.runningSince[id] || 0) > (state.runningSince[best.id] || 0))) best = g;
  }
  return best;
}

export async function refreshInfo() {
  const info = await api.getInfo();
  Object.assign(state.info, info);
  return state.info;
}

export async function setSetting(key, value) {
  state.settings = { ...state.settings, [key]: value };
  emit('settings', key);
  const saved = await api.setSettings({ [key]: value });
  state.settings = saved;
}

export function pushNotification(n) {
  const item = { id: Math.random().toString(36).slice(2), time: Date.now(), read: false, icon: 'bell', ...n };
  state.notifications.unshift(item);
  state.notifications = state.notifications.slice(0, 40);
  emit('notifications', item);
  if (!n.silent) emit('toast', item);
  return item;
}

/* ------------------------------------------------------------------ */
/* Game helpers                                                        */
/* ------------------------------------------------------------------ */

export function artUrl(game, key) {
  const f = game && game.art && game.art[key];
  if (!f) return null;
  return `app://art/${encodeURIComponent(game.id.replace(/[^a-z0-9_-]/gi, '_'))}/${encodeURIComponent(f)}?v=${game.artVersion || 0}`;
}

export function lastActive(g) {
  return Math.max(g.lastPlayed || 0, g.steamLastPlayed || 0);
}

export function playtimeOf(g) {
  return Math.max(g.steamPlaytime || 0, g.playtime || 0);
}

export function sourceLabel(g) {
  if (g.source === 'steam') return 'STEAM';
  if (g.source === 'epic') return 'EPIC';
  if (g.source === 'xbox') return 'XBOX';
  if (g.source === 'ubisoft') return 'UBISOFT';
  if (g.launch && /^steam:/.test(g.launch.target || '')) return 'STEAM';
  return 'PC';
}

export function sourceName(g) {
  return t({ steam: 'Steam', epic: 'Epic Games', xbox: 'Xbox', ubisoft: 'Ubisoft Connect', folder: 'Shortcut folder', manual: 'Added manually' }[g.source] || 'PC');
}

export function gamesIn(category) {
  return state.games.filter((g) => (g.category || 'game') === category);
}

export function sortGames(list, mode) {
  const arr = list.slice();
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  if (mode === 'name') arr.sort(byName);
  else if (mode === 'added') arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0) || byName(a, b));
  else if (mode === 'playtime') arr.sort((a, b) => playtimeOf(b) - playtimeOf(a) || byName(a, b));
  else arr.sort((a, b) => lastActive(b) - lastActive(a) || (b.addedAt || 0) - (a.addedAt || 0) || byName(a, b));
  return arr;
}

export function homeGames(category) {
  const list = gamesIn(category).filter((g) => !g.hidden);
  return sortGames(list, state.settings.homeSort || 'recent').slice(0, state.settings.homeCount || 12);
}

export function findGame(id) {
  return state.games.find((g) => g.id === id);
}
