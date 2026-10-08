// Now-playing media, system volume and display brightness, backed by the
// native helper in the main process. Media is only polled while something on
// screen is watching it.

import { api, emit, pushNotification } from './state.js';
import { t } from './i18n.js';

export const sys = {
  media: null, // last media state from the helper
  mediaApp: null, // session the user picked (null = automatic)
  art: null, // cover art data URL
  artKey: null,
  volume: null,
  muted: false,
  outputs: null, // playback devices [{ id, name, desc, adapter, default }]
  displays: null, // [{ name, percent, method }]
  nightLight: null, // true / false, null = unknown or unsupported
  bt: null, // { available, on, devices: [...] }
  btScan: null, // { scanning, devices: [...] }
};

/* ------------------------------------------------------------------ */
/* Playback clock                                                      */
/* ------------------------------------------------------------------ */

// Apps only refresh their timeline now and then, and right after a play/pause
// they keep reporting the old position for a moment. We run our own clock and
// only accept a reported position once the app has published a fresh one.
const clock = { key: null, pos: 0, at: 0, playing: false, changedAt: 0 };
let pending = null; // expected status after one of our own commands

function clockNow() {
  return clock.pos + (clock.playing ? (Date.now() - clock.at) / 1000 : 0);
}

function syncClock(st) {
  if (!st || !st.active) return;
  const now = Date.now();
  const key = `${st.app}|${st.key}`;
  const playing = st.status === 'Playing';
  const reported = (st.position || 0) + (playing && st.updated && st.updated <= now ? (now - st.updated) / 1000 : 0);
  if (clock.key === null || key !== clock.key) {
    const first = clock.key === null;
    // On a track change the app may still report the previous track's timeline.
    const stale = !first && (!st.updated || now - st.updated > 2500);
    Object.assign(clock, { key, pos: stale ? 0 : reported, at: now, playing, changedAt: stale ? now : 0 });
    return;
  }
  if (playing !== clock.playing) {
    // Status changed outside the launcher; the app's timeline may already be
    // from around the moment it happened, so allow a little slack.
    Object.assign(clock, { pos: clockNow(), at: now, playing, changedAt: now - 1500 });
  }
  const fresh = st.updated && st.updated > clock.changedAt;
  if (fresh && Math.abs(reported - clockNow()) > 0.8) Object.assign(clock, { pos: reported, at: now });
}

/** Jump the local clock (used while seeking). */
export function seekLocal(sec) {
  Object.assign(clock, { pos: Math.max(0, sec), at: Date.now(), changedAt: Date.now() });
  emit('media', sys.media);
}

let watchers = 0;
let timer = null;
let polling = false;

export async function pollMedia() {
  if (polling) return sys.media;
  polling = true;
  try {
    const st = await api.media(sys.mediaApp, sys.artKey);
    st.receivedAt = Date.now();
    // Our own play/pause may not have reached the app yet — keep showing it.
    if (pending && st.active) {
      if (Date.now() > pending.until || st.status === pending.status) pending = null;
      else st.status = pending.status;
    }
    syncClock(st);
    if (st.art) sys.art = st.art;
    if ((st.artKey || null) !== sys.artKey) {
      sys.artKey = st.artKey || null;
      if (!st.artKey) sys.art = null;
    }
    delete st.art;
    sys.media = st;
    emit('media', st);
  } catch {
    sys.media = { active: false, sessions: [], error: true };
    emit('media', sys.media);
  } finally {
    polling = false;
  }
  return sys.media;
}

/** Start polling while the returned function has not been called. */
export function watchMedia() {
  watchers++;
  if (watchers === 1) {
    pollMedia();
    timer = setInterval(pollMedia, 1000);
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    watchers = Math.max(0, watchers - 1);
    if (!watchers) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function mediaPosition() {
  const m = sys.media;
  if (!m || !m.active) return 0;
  const pos = clockNow();
  return Math.max(0, m.duration > 0 ? Math.min(pos, m.duration) : pos);
}

export async function mediaCommand(action, value) {
  const m = sys.media;
  if (!m || !m.active) return;
  if (action === 'toggle') {
    // Optimistic update so the button responds instantly; the clock simply
    // freezes / resumes where it is.
    m.status = m.status === 'Playing' ? 'Paused' : 'Playing';
    const now = Date.now();
    Object.assign(clock, { pos: clockNow(), at: now, playing: m.status === 'Playing', changedAt: now });
    pending = { status: m.status, until: now + 2500 };
    emit('media', m);
  } else if (action === 'seek') {
    seekLocal(value);
  }
  try {
    await api.mediaCommand(m.app, action, value);
  } catch {}
  setTimeout(pollMedia, action === 'toggle' ? 400 : 700);
}

export function selectSession(appId) {
  sys.mediaApp = appId;
  sys.artKey = null;
  sys.art = null;
  return pollMedia();
}

export function appName(id) {
  if (!id) return 'Media';
  const known = {
    'spotify.exe': 'Spotify',
    spotify: 'Spotify',
    chrome: 'Google Chrome',
    msedge: 'Microsoft Edge',
    brave: 'Brave',
    opera: 'Opera',
    '308046b0af4a39cb': 'Firefox',
    'vlc.exe': 'VLC',
    'tidal.exe': 'TIDAL',
    'amazon music.exe': 'Amazon Music',
  };
  const low = id.toLowerCase();
  if (known[low]) return known[low];
  if (low.includes('zunemusic')) return 'Media Player';
  if (low.includes('zunevideo')) return 'Movies & TV';
  if (low.includes('applemusic')) return 'Apple Music';
  if (low.includes('spotify')) return 'Spotify';
  const base = id.split('!').pop().split('\\').pop().replace(/\.exe$/i, '');
  return base.replace(/^[A-Za-z0-9]+\./, '').replace(/_[a-z0-9]{10,}$/i, '') || id;
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/* ------------------------------------------------------------------ */
/* Volume                                                              */
/* ------------------------------------------------------------------ */

export async function loadVolume() {
  try {
    const v = await api.getVolume();
    sys.volume = v.volume;
    sys.muted = v.muted;
  } catch {
    sys.volume = null;
  }
  emit('volume');
  return sys.volume;
}

export function setVolume(v) {
  sys.volume = Math.max(0, Math.min(100, Math.round(v)));
  if (sys.muted && v > 0) setMute(false);
  emit('volume');
  return api.setVolume(sys.volume).catch(() => {});
}

export function setMute(m) {
  sys.muted = !!m;
  emit('volume');
  return api.setMute(sys.muted).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Playback device                                                     */
/* ------------------------------------------------------------------ */

export async function loadOutputs() {
  try {
    sys.outputs = await api.audioOutputs();
  } catch {
    sys.outputs = [];
  }
  emit('outputs');
  return sys.outputs;
}

export function currentOutput() {
  return (sys.outputs || []).find((d) => d.default) || null;
}

/** "Speakers" + "Realtek(R) Audio" from "Speakers (Realtek(R) Audio)". */
export function outputLabel(d) {
  return { name: d.desc || d.name, sub: d.adapter || '' };
}

export function outputIcon(d) {
  const t = `${d.desc} ${d.name} ${d.adapter}`.toLowerCase();
  if (/head(phone|set)|earphone|airpods|buds|hands-free/.test(t)) return 'headphones';
  if (/^\d+ - |hdmi|displayport|monitor|\btv\b|nvidia high definition|amd high definition|intel\(r\) display audio/.test(t)) return 'display';
  return 'speaker';
}

export async function setOutput(id) {
  const prev = sys.outputs;
  if (prev) sys.outputs = prev.map((d) => ({ ...d, default: d.id === id }));
  emit('outputs');
  try {
    await api.setAudioOutput(id);
  } catch (err) {
    sys.outputs = prev;
    emit('outputs');
    throw err;
  }
  // Volume and mute belong to the device, so read them again.
  loadVolume();
}

/* ------------------------------------------------------------------ */
/* Brightness                                                          */
/* ------------------------------------------------------------------ */

export async function loadBrightness() {
  try {
    sys.displays = await api.getBrightness();
  } catch {
    sys.displays = [];
  }
  emit('brightness');
  return sys.displays;
}

export function setBrightness(index, v) {
  v = Math.max(0, Math.min(100, Math.round(v)));
  if (!sys.displays) return;
  if (index < 0) sys.displays.forEach((d) => (d.percent = v));
  else if (sys.displays[index]) sys.displays[index].percent = v;
  emit('brightness');
  return api.setBrightness(v, index).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Night Light                                                         */
/* ------------------------------------------------------------------ */

export async function loadNightLight() {
  try {
    const r = await api.getNightLight();
    sys.nightLight = r && r.available ? !!r.on : null;
  } catch {
    sys.nightLight = null;
  }
  emit('nightlight');
  return sys.nightLight;
}

export async function setNightLight(on) {
  sys.nightLight = !!on;
  emit('nightlight');
  try {
    await api.setNightLight(!!on);
  } catch (err) {
    pushNotification({ title: 'Night light', body: cleanError(err), icon: 'moon' });
    await loadNightLight();
  }
}

/* ------------------------------------------------------------------ */
/* Bluetooth                                                           */
/* ------------------------------------------------------------------ */

function cleanError(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

let btLoading = null;

export function loadBluetooth() {
  if (btLoading) return btLoading;
  btLoading = api
    .btState()
    .then((st) => {
      // Keep "busy" flags for devices we are working on.
      const busy = new Map(((sys.bt && sys.bt.devices) || []).filter((d) => d.busy).map((d) => [d.id, d.busy]));
      st.devices = (st.devices || []).map((d) => (busy.has(d.id) ? { ...d, busy: busy.get(d.id) } : d));
      st.devices.sort((a, b) => b.connected - a.connected || a.name.localeCompare(b.name));
      sys.bt = st;
    })
    .catch((err) => {
      sys.bt = { available: false, on: false, devices: [], error: cleanError(err) };
    })
    .finally(() => {
      btLoading = null;
      emit('bluetooth');
    });
  return btLoading;
}

/** Re-read a few times while Windows finishes connecting / pairing. */
function followUp(times = [1500, 4000, 8000]) {
  times.forEach((t) => setTimeout(loadBluetooth, t));
}

export async function setBluetooth(on) {
  if (sys.bt) {
    sys.bt.on = !!on;
    emit('bluetooth');
  }
  try {
    const res = await api.btRadio(!!on);
    if (res && res !== 'Allowed') pushNotification({ title: 'Bluetooth', body: t("Windows didn't allow this ({reason}).", { reason: res }), icon: 'bluetooth' });
  } catch (err) {
    pushNotification({ title: 'Bluetooth', body: cleanError(err), icon: 'bluetooth' });
  }
  followUp([800, 2500]);
}

function markBusy(dev, label) {
  const d = sys.bt && sys.bt.devices.find((x) => x.id === dev.id);
  if (d) d.busy = label;
  emit('bluetooth');
}

export async function connectDevice(dev, connect = true) {
  markBusy(dev, connect ? 'Connecting…' : 'Disconnecting…');
  try {
    await api.btConnect(dev.address, connect);
  } catch (err) {
    pushNotification({ title: dev.name, body: cleanError(err), icon: 'bluetooth' });
  }
  // The request is asynchronous on Windows' side — watch the status settle.
  setTimeout(() => markBusy(dev, null), 9000);
  followUp([1500, 3500, 6000, 9500]);
}

export async function unpairDevice(dev) {
  markBusy(dev, 'Removing…');
  try {
    const res = await api.btUnpair(dev.id);
    pushNotification({ title: dev.name, body: res === 'Unpaired' ? 'Device removed.' : `Couldn't remove the device (${res}).`, icon: 'bluetooth' });
  } catch (err) {
    pushNotification({ title: dev.name, body: cleanError(err), icon: 'bluetooth' });
  }
  markBusy(dev, null);
  loadBluetooth();
}

let scanTimer = null;

export async function startScan() {
  sys.btScan = { scanning: true, devices: [] };
  emit('btscan');
  try {
    await api.btScan('start');
  } catch (err) {
    sys.btScan = { scanning: false, devices: [], error: cleanError(err) };
    emit('btscan');
    return;
  }
  clearInterval(scanTimer);
  scanTimer = setInterval(async () => {
    try {
      const r = await api.btScan('results');
      const pairing = new Map(((sys.btScan && sys.btScan.devices) || []).filter((d) => d.busy).map((d) => [d.id, d.busy]));
      r.devices = (r.devices || []).map((d) => (pairing.has(d.id) ? { ...d, busy: pairing.get(d.id) } : d));
      sys.btScan = r;
      emit('btscan');
      if (!r.scanning) clearInterval(scanTimer);
    } catch {}
  }, 1500);
}

export function stopScan() {
  clearInterval(scanTimer);
  scanTimer = null;
  if (sys.btScan && sys.btScan.scanning) {
    sys.btScan.scanning = false;
    emit('btscan');
  }
  api.btScan('stop').catch(() => {});
}

export async function pairDevice(dev) {
  const d = sys.btScan && sys.btScan.devices.find((x) => x.id === dev.id);
  if (d) d.busy = 'Pairing…';
  emit('btscan');
  try {
    const res = await api.btPair(dev.id);
    const ok = res === 'Paired' || res === 'AlreadyPaired';
    pushNotification({ title: dev.name, body: ok ? 'Paired and ready to use.' : t('Pairing failed ({reason}). Make sure the device is in pairing mode.', { reason: res }), icon: 'bluetooth' });
    if (ok && sys.btScan) sys.btScan.devices = sys.btScan.devices.filter((x) => x.id !== dev.id);
  } catch (err) {
    pushNotification({ title: dev.name, body: cleanError(err), icon: 'bluetooth' });
  }
  if (d) d.busy = null;
  emit('btscan');
  followUp([500, 3000, 7000]);
}

export function deviceIcon(dev) {
  const n = (dev.name || '').toLowerCase();
  if (dev.kind === 'audio') return /speaker|charge|flip|boom|soundbar|xtreme|pulse|go\b|sound/.test(n) ? 'speaker' : 'headphones';
  return { gamepad: 'gamepad', keyboard: 'keyboard', mouse: 'mouse', phone: 'phone', computer: 'display', input: 'gamepad' }[dev.kind] || 'bluetooth';
}

export function deviceStatus(dev) {
  if (dev.busy) return dev.busy;
  return dev.connected ? 'Connected' : 'Not connected';
}
