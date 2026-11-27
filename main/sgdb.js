// Interactive SteamGridDB browsing. Credentials stay in the main process.
// The key is the user's own (Settings › Library › Artwork, or picked up by the
// first-time setup from SteamGridDB's API page).

const API = 'https://www.steamgriddb.com/api/v2';

/** The user's key ('' when there is none). */
function keyFor(userKey) {
  return (typeof userKey === 'string' && userKey.trim()) || '';
}
const TYPES = { grid: 'grids', capsule: 'grids', hero: 'heroes', logo: 'logos' };

function assetUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^cdn\d*\.steamgriddb\.com$/i.test(u.hostname) && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}

function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid SteamGridDB ID.');
  return id;
}

function typeFor(kind) {
  if (!Object.hasOwn(TYPES, kind)) throw new Error('Unsupported artwork type.');
  return TYPES[kind];
}

async function request(key, endpoint) {
  key = keyFor(key);
  if (!key) throw new Error('Add a SteamGridDB API key in Settings first.');
  let response;
  try {
    response = await fetch(API + endpoint, {
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal: AbortSignal.timeout(20000),
    });
  } catch { throw new Error('Could not reach SteamGridDB. Check your connection and try again.'); }
  if (response.status === 401 || response.status === 403) throw new Error('SteamGridDB rejected the API key. Check it in Settings.');
  if (response.status === 429) throw new Error('SteamGridDB is busy. Please wait a moment and try again.');
  if (!response.ok) throw new Error('SteamGridDB could not load this item. Please try again.');
  const json = await response.json();
  if (!json.success) throw new Error('SteamGridDB could not load this item. Please try again.');
  return json.data;
}

async function search(key, term) {
  term = String(term || '').trim().slice(0, 200);
  if (!term) return [];
  const data = await request(key, `/search/autocomplete/${encodeURIComponent(term)}`);
  return (data || []).map(g => ({ id: g.id, name: g.name }));
}

async function list(key, gameId, kind, page = 0) {
  const type = typeFor(kind);
  if (!Number.isSafeInteger(page) || page < 0) throw new Error('Invalid artwork page.');
  const dimensions = kind === 'grid' ? '&dimensions=512x512,1024x1024' : kind === 'capsule' ? '&dimensions=600x900' : '';
  const data = await request(key, `/${type}/game/${positiveId(gameId)}?types=static&page=${page}${dimensions}`);
  return (data || []).filter(a => assetUrl(a.url)).map(a => ({
    id: a.id, url: assetUrl(a.url), thumb: assetUrl(a.thumb) || assetUrl(a.url),
    width: a.width, height: a.height, author: a.author?.name || 'Unknown artist',
  }));
}

async function artwork(key, kind, id) {
  const data = await request(key, `/${typeFor(kind)}/${positiveId(id)}`);
  const url = assetUrl(data?.url);
  if (!url) throw new Error('This artwork is unavailable. Choose another image.');
  return url;
}

module.exports = { search, list, artwork, keyFor };
