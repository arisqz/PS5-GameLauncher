// A SteamGridDB API key going into the launcher (the setup picks it up from
// SteamGridDB's page; Settings › Library › Artwork takes one typed or pasted).

import { state, api, setSetting, pushNotification } from '../state.js';

/**
 * Does SteamGridDB take the key in the settings? true, false (it turned the
 * key down) or null (no answer: offline, SteamGridDB down), with its message.
 */
export async function checkSgdbKey() {
  if (!state.settings.sgdbKey) return { ok: false, error: null };
  try {
    await api.sgdbSearch('Portal');
    return { ok: true, error: null };
  } catch (err) {
    const error = String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    return { ok: /rejected/i.test(error) ? false : null, error };
  }
}

/**
 * A key SteamGridDB took is in: SteamGridDB becomes the preferred source of
 * artwork, and a notification (top right) says so, during the setup too.
 */
export async function sgdbKeyAdded() {
  if (state.settings.artSource !== 'sgdb') await setSetting('artSource', 'sgdb');
  pushNotification({
    title: 'SteamGridDB API Key Added',
    body: 'Artwork now comes from SteamGridDB first.',
    icon: 'image',
    kind: 'system',
    duringSetup: document.body.classList.contains('in-setup'),
  });
}

/** After a key was typed or pasted in: check it, then the same as above (or say it was turned down). */
export async function sgdbKeyEntered(value) {
  if (!value) return;
  const { ok, error } = await checkSgdbKey();
  if (ok) await sgdbKeyAdded();
  else if (ok === false) pushNotification({ title: 'SteamGridDB Didn’t Accept This Key', body: error || 'Check the key on SteamGridDB’s API page.', icon: 'image', kind: 'system', duringSetup: document.body.classList.contains('in-setup') });
}
