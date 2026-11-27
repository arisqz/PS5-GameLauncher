// Discord party state for the UI (the connection lives in main/discord.js).

import { api, emit, pushNotification } from './state.js';
import { t } from './i18n.js';

export const party = { state: null };

function clean(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

api.on('discord:state', (s) => {
  const prev = party.state;
  party.state = s;
  emit('discord');
  if (prev && prev.status !== 'ready' && s.status === 'ready' && prev.status === 'authorizing') {
    pushNotification({ title: 'Discord connected', body: s.user ? t('Signed in as {name}', { name: s.user.name }) : '', icon: 'party', duringSetup: document.body.classList.contains('in-setup') });
  }
});

// A new Discord message (DM or mention): a notification with the sender's picture.
api.on('discord:message', (n) => {
  if (!n) return;
  pushNotification({ title: n.title || 'Discord', body: n.body || '', image: n.icon || null, icon: 'chat', kind: 'discord', channelId: n.channelId });
});

/** Recent conversations (newest first) seen since Discord connected. */
export function conversations() {
  return (party.state && party.state.conversations) || [];
}

export async function loadDiscord() {
  try {
    party.state = await api.discordState();
  } catch {
    party.state = null;
  }
  emit('discord');
  return party.state;
}

export async function discordSetup(data) {
  try {
    party.state = await api.discordSetup(data);
    emit('discord');
    return true;
  } catch (err) {
    pushNotification({ title: 'Discord', body: clean(err), icon: 'party', duringSetup: document.body.classList.contains('in-setup') });
    return false;
  }
}

export async function discordConnect() {
  try {
    await api.discordConnect();
  } catch (err) {
    pushNotification({ title: 'Discord', body: clean(err), icon: 'party', duringSetup: document.body.classList.contains('in-setup') });
  }
}

export const discordDisconnect = () => api.discordDisconnect().catch(() => {});
export const discordForget = () => api.discordForget().catch(() => {});

// Volume sliders fire many events; only send the newest value.
const queues = new Map();
function coalesce(key, run) {
  let q = queues.get(key);
  if (!q) queues.set(key, (q = { busy: false, next: null }));
  q.next = run;
  const pump = async () => {
    if (q.busy || !q.next) return;
    const fn = q.next;
    q.next = null;
    q.busy = true;
    try {
      await fn();
    } catch (err) {
      pushNotification({ title: 'Discord', body: clean(err), icon: 'party', duringSetup: document.body.classList.contains('in-setup') });
    }
    q.busy = false;
    pump();
  };
  pump();
}

export function discordCmd(name, value, extra) {
  const st = party.state;
  // Optimistic UI so buttons and sliders respond immediately.
  if (st && st.voice) {
    if (name === 'mute') st.voice.mute = !!value;
    if (name === 'deaf') st.voice.deaf = !!value;
    if (name === 'input') st.voice.input = value;
    if (name === 'output') st.voice.output = value;
  }
  if (st && name === 'userVolume') {
    const m = st.members.find((x) => x.id === extra);
    if (m) m.volume = value;
  }
  emit('discord');
  coalesce(`${name}:${extra || ''}`, () => api.discordCmd(name, value, extra));
}

export function statusText(st) {
  if (!st) return 'Not set up';
  switch (st.status) {
    case 'setup':
      return 'Not set up';
    case 'idle':
      return st.authorized ? 'Not connected' : 'Not connected yet';
    case 'connecting':
      return 'Connecting…';
    case 'offline':
      return 'Discord isn’t running';
    case 'authorizing':
      return 'Approve the request in Discord';
    case 'needs-auth':
      return 'Needs authorization';
    case 'ready':
      return st.user ? t('Connected as {name}', { name: st.user.name }) : t('Connected');
    case 'error':
      return st.error || 'Something went wrong';
  }
  return '';
}

export function inCall() {
  const st = party.state;
  return !!(st && st.status === 'ready' && st.channel);
}


/* Voice chats to join (the Game Base's Discord tab) ----------------------- */

/** The servers, each with who is in voice on it (kept by main for 20 s; fresh: ask again). */
export function discordGuilds(fresh = false) {
  return api.discordGuilds({ fresh });
}

/** A server's voice channels with who is in each. */
export function discordVoiceChannels(guildId) {
  return api.discordVoiceChannels(guildId);
}

/** Direct (and group) chats the launcher knows of, with who is in each one's call. */
export function discordDirectChats() {
  return api.discordDirectChats();
}

/** Join a voice channel or a direct chat's call (Discord does it). */
export async function joinVoice(channelId) {
  try {
    await api.discordCmd('join', channelId);
    return true;
  } catch (err) {
    pushNotification({ title: 'Discord', body: clean(err), icon: 'party', duringSetup: document.body.classList.contains('in-setup') });
    return false;
  }
}
