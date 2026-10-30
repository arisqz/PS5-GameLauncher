// Game theme music, as on the PS5: when a game stays selected for a moment,
// its theme fades in behind its hub, and fades out once it isn't. The main
// process finds and downloads it (main/thememusic.js, YouTube with yt-dlp),
// sound.js plays it. It stays quiet while another app plays media, a game
// runs or starts, or the launcher is in the background; the menu music waits
// while it plays.

import { api, state, on, emit } from './state.js';
import { playTheme, stopTheme, pauseTheme, setThemeVolume, setThemeLostHandler } from './sound.js';

const SETTLE = 600; // ms a game stays selected before its music is even looked up (scrolling past costs nothing)
const LINGER = 1500; // ms the menu music keeps waiting after theme music stops (the next game's may follow)

let wanted = null; // the selected game's id
let preview = null; // a track tried out in Options › Theme Music (goes first)
let pending = null; // request key starting
let playing = null; // request key playing
let playingKey = null; // its track's key
let timer = null;
let job = 0;
let ready = false; // after the boot / welcome screen
let otherMedia = false;
let held = false; // a game is starting
let paused = 0; // a game's options menu is open (counts nested ones)
let resume = null; // { req, key, offset }: where the paused theme was
let active = false;
let activeTimer = null;

const volume = () => ((state.settings.themeMusicVolume ?? 50) / 100) * 0.8;

function allowed() {
  return ready && !held && !otherMedia && state.settings.themeMusic === true && state.window.focused !== false && !state.asleep && state.running.size === 0;
}

/**
 * yt-dlp (main/ytdlp.js): installed, its version, a download in progress; the
 * downloaded songs' size; and getting every installed game's theme ahead of time.
 */
export const ytdlp = { state: null, cacheSize: null, fetch: null };

api.on('ytdlp:state', (s) => {
  ytdlp.state = s;
  emit('ytdlp');
});

api.on('theme:fetch', async (f) => {
  ytdlp.fetch = f;
  if (!f.running) ytdlp.cacheSize = await api.themeCacheSize().catch(() => ytdlp.cacheSize);
  emit('ytdlp');
});

export async function loadYtdlp() {
  try {
    ytdlp.state = await api.ytdlpState();
    ytdlp.cacheSize = await api.themeCacheSize();
    ytdlp.fetch = await api.themeFetchState();
  } catch {}
  emit('ytdlp');
}

function request() {
  if (preview) return { key: `t:${preview.key}`, track: preview };
  if (wanted && !paused) return { key: `g:${wanted}`, id: wanted };
  return null;
}

// The last few songs, as blob: URLs (a few MB each), so going back to a game starts it at once.
const urls = new Map(); // track key -> blob URL

function keepUrl(key, bytes) {
  const url = URL.createObjectURL(new Blob([bytes]));
  urls.set(key, url);
  while (urls.size > 8) {
    const [old, oldUrl] = urls.entries().next().value;
    urls.delete(old);
    // Still playing (or fading out) through an audio element: let go of it a little later.
    setTimeout(() => URL.revokeObjectURL(oldUrl), 10000);
  }
  return url;
}

/** The track's audio: { key, url } or null. */
async function load(req) {
  try {
    const info = req.track || (await api.themeFind(req.id));
    if (!info) return null;
    let url = urls.get(info.key);
    if (url) {
      urls.delete(info.key); // most recent last
      urls.set(info.key, url);
    } else {
      const bytes = req.track ? await api.themeTrackAudio(req.track) : await api.themeAudio(req.id);
      if (!bytes) return null;
      url = keepUrl(info.key, bytes);
    }
    return { key: info.key, url };
  } catch {
    return null;
  }
}

/** Theme music is (about to be) playing: the menu music waits. */
function setActive(on) {
  clearTimeout(activeTimer);
  if (on) {
    if (!active) emit('theme-music', (active = true));
  } else {
    activeTimer = setTimeout(() => active && emit('theme-music', (active = false)), LINGER);
  }
}

function update(delay = SETTLE) {
  const req = allowed() ? request() : null;
  const key = req && req.key;
  if (key && (key === playing || key === pending)) return;
  // Whatever was starting is out of date now, even if its download is still running.
  const my = ++job;
  clearTimeout(timer);
  pending = null;
  if (playing) {
    // An options menu opened over it: remember where it was, and keep the menu music waiting.
    if (paused && !preview && playing.startsWith('g:')) resume = { req: playing, key: playingKey, offset: pauseTheme() };
    else {
      stopTheme();
      setActive(false);
    }
    playing = playingKey = null;
  }
  if (!req) {
    // Nothing paused to come back to any more (the menu closed elsewhere): the menu music may play.
    if (!paused && resume) {
      resume = null;
      setActive(false);
    }
    return;
  }
  const back = resume && resume.req === key ? resume : null;
  // A tried-out video (Options › Theme Music) keeps the paused theme's place;
  // another game drops it (and lets the menu music back if that one has none).
  if (back) resume = null;
  else if (resume && key.startsWith('g:')) {
    resume = null;
    setActive(false);
  }
  // Look it up only once the selection has settled, so holding a direction
  // through the row doesn't search, download and decode every game passed.
  pending = key;
  timer = setTimeout(async () => {
    const a = await load(req);
    if (my !== job) return;
    pending = null;
    if (!a || !allowed()) return;
    setActive(true);
    playTheme(a.key, a.url, volume(), back && back.key === a.key ? { offset: back.offset, fadeIn: 0.5 } : {});
    playing = key;
    playingKey = a.key;
  }, back ? 120 : delay);
}

/** The game selected on Home or in a game hub (null: none). */
export function themeFocus(game) {
  const id = game ? game.id : null;
  if (id === wanted) return;
  wanted = id;
  update();
}

/** Try a track from Options › Theme Music (null: back to the selected game's). */
export function themePreview(track) {
  preview = track || null;
  update(preview ? 600 : SETTLE);
}

/** A game's theme music choice changed: play its new one. */
export function themeChanged(id) {
  if (id !== wanted) return;
  if (playing === `g:${id}`) {
    stopTheme();
    playing = playingKey = null;
  }
  if (resume && resume.req === `g:${id}`) resume = null;
  pending = null;
  job++;
  update(300);
}

/** A game is starting: the music fades out (and stays off while it runs). */
export function themeHold(on) {
  held = !!on;
  update();
}

/** A game's options menu is open: its theme pauses, and picks up where it was once the menu closes. */
export function themePause(on) {
  paused = Math.max(0, paused + (on ? 1 : -1));
  update();
}

export function themeActive() {
  return active;
}

/** What theme music is doing right now (for checking it from the dev tools). */
export function themeNow() {
  return { playing, pending, paused, resume: resume && { req: resume.req, offset: Math.round(resume.offset * 10) / 10 }, active, allowed: allowed() };
}

/** From app.js: past the welcome screen, and whether another app plays media. */
export function setThemeConditions(c) {
  if (c.ready === ready && c.otherMedia === otherMedia) return;
  ready = !!c.ready;
  otherMedia = !!c.otherMedia;
  update();
}

on('settings', (k) => {
  if (k === 'themeMusicVolume' || k === null) setThemeVolume(volume());
  update();
});
on('window', () => update());
on('running', () => update());
on('sleep', () => update());
// The audio output was rebuilt (back from a game, new device): start again.
setThemeLostHandler(() => {
  playing = playingKey = null;
  update(0);
});
