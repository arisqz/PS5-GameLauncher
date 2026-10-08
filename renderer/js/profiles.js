// Local user profiles (name + avatar) for the welcome screen. The active
// profile is mirrored into the profileName / avatar / avatarImage settings, so
// the rest of the UI only ever reads those.

import { api, state, on, emit } from './state.js';

const uid = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function fromSettings(s) {
  return { id: s.profileId || 'p1', name: s.profileName || 'Player', avatar: s.avatar || 0, image: s.avatarImage || null };
}

export function profiles() {
  const s = state.settings;
  const list = Array.isArray(s.profiles) && s.profiles.length ? s.profiles.map((p) => ({ ...p })) : [fromSettings(s)];
  // The active profile's fields live in the flat settings; keep them authoritative.
  const active = fromSettings(s);
  const i = list.findIndex((p) => p.id === active.id);
  if (i >= 0) list[i] = active;
  else list.unshift(active);
  return list;
}

export function activeProfileId() {
  return state.settings.profileId || profiles()[0].id;
}

async function save(patch) {
  state.settings = { ...state.settings, ...patch };
  state.settings = await api.setSettings(patch);
  emit('settings', null);
}

/** Make a profile the active one. */
export async function useProfile(id) {
  const list = profiles();
  const p = list.find((x) => x.id === id);
  if (!p) return;
  await save({ profiles: list, profileId: p.id, profileName: p.name, avatar: p.avatar, avatarImage: p.image || null });
}

export async function addProfile(name) {
  const list = profiles();
  const p = { id: uid(), name: name || 'Player', avatar: list.length % 8, image: null };
  list.push(p);
  await save({ profiles: list, profileId: state.settings.profileId || list[0].id });
  return p;
}

export async function updateProfile(id, patch) {
  const list = profiles().map((p) => (p.id === id ? { ...p, ...patch } : p));
  const extra = {};
  if (id === activeProfileId()) {
    const p = list.find((x) => x.id === id);
    Object.assign(extra, { profileName: p.name, avatar: p.avatar, avatarImage: p.image || null });
  }
  await save({ profiles: list, ...extra });
}

export async function removeProfile(id) {
  const list = profiles();
  if (list.length < 2) return;
  const gone = list.find((p) => p.id === id);
  const rest = list.filter((p) => p.id !== id);
  if (gone && gone.image) api.removeProfileImage(gone.image).catch(() => {});
  if (id === activeProfileId()) {
    const p = rest[0];
    await save({ profiles: rest, profileId: p.id, profileName: p.name, avatar: p.avatar, avatarImage: p.image || null });
  } else await save({ profiles: rest });
}

/** Ask for a picture file; returns its app:// URL or null. */
export async function pickProfileImage(id) {
  const url = await api.pickProfileImage();
  if (!url) return null;
  const old = profiles().find((p) => p.id === id);
  await updateProfile(id, { image: url });
  if (old && old.image && old.image !== url) api.removeProfileImage(old.image).catch(() => {});
  return url;
}

// Settings edits to the active profile (Settings › Users and Accounts) are
// copied back into the list.
on('settings', (k) => {
  if (!['profileName', 'avatar', 'avatarImage'].includes(k)) return;
  const s = state.settings;
  if (!Array.isArray(s.profiles) || !s.profiles.length) return;
  const list = profiles();
  api.setSettings({ profiles: list }).then((saved) => (state.settings = saved)).catch(() => {});
});
