const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const STORE_ASSETS = 'https://shared.steamstatic.com/store_item_assets/';
const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps/';
const SGDB_API = 'https://www.steamgriddb.com/api/v2';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PS5GameLauncher/1.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Name matching                                                       */
/* ------------------------------------------------------------------ */

const ROMAN = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => ROMAN[w] || w)
    .join(' ');
}

function dice(a, b) {
  const x = a.replace(/ /g, '');
  const y = b.replace(/ /g, '');
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) || 0;
    if (n > 0) {
      grams.set(g, n - 1);
      hit++;
    }
  }
  return (2 * hit) / (x.length + y.length - 2);
}

const EXTRA_WORDS = /\b(soundtrack|ost|dlc|demo|season pass|pack|bundle|artbook|expansion|playtest|dedicated server|sdk|editor|beta)\b/i;

function scoreMatch(query, candidate, rank = 0) {
  const q = normalize(query);
  const c = normalize(candidate);
  let score = dice(q, c);
  if (q === c) score = 1.2;
  else if (` ${c} `.includes(` ${q} `)) score = Math.max(score, 0.8);
  else if (` ${q} `.includes(` ${c} `)) score = Math.max(score, 0.72);
  if (EXTRA_WORDS.test(candidate) && !EXTRA_WORDS.test(query)) score -= 0.4;
  if (rank === 0) score += 0.05;
  return score;
}

function searchTerm(name) {
  return String(name)
    .replace(/[™®©]/g, '')
    .replace(/\b(launcher|game of the year edition|goty|definitive edition|remastered|x64|dx12|dx11|vulkan)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchSteam(term) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;
  const j = await getJson(url);
  return (j.items || [])
    .filter((i) => i.type === 'app')
    .map((i) => ({ appid: String(i.id), name: i.name, image: i.tiny_image || null }));
}

async function resolveSteamAppId(name) {
  const tries = [searchTerm(name)];
  const short = searchTerm(name).split(/\s[-–:]\s|:\s/)[0];
  if (short && short !== tries[0]) tries.push(short);

  let best = null;
  for (const term of tries) {
    if (!term) continue;
    const results = await searchSteam(term);
    for (const [rank, r] of results.entries()) {
      const s = scoreMatch(name, r.name, rank);
      if (!best || s > best.score) best = { ...r, score: s };
    }
    if (best && best.score >= 0.9) break;
    await sleep(120);
  }
  return best && best.score >= 0.62 ? best : null;
}

/* ------------------------------------------------------------------ */
/* Steam store data                                                    */
/* ------------------------------------------------------------------ */

async function fetchStoreItems(appids) {
  const out = {};
  const ids = [...new Set(appids.filter(Boolean).map(String))];
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    const input = {
      ids: chunk.map((a) => ({ appid: Number(a) })),
      context: { language: 'english', country_code: 'US' },
      data_request: { include_assets: true, include_basic_info: true, include_release: true, include_screenshots: true },
    };
    const url = `https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=${encodeURIComponent(JSON.stringify(input))}`;
    try {
      const j = await getJson(url);
      for (const item of (j.response && j.response.store_items) || []) {
        if (item && item.appid) out[String(item.appid)] = item;
      }
    } catch (err) {
      console.warn('[metadata] GetItems failed', err.message);
    }
  }
  return out;
}

function steamCandidates(appid, item) {
  const a = (item && item.assets) || {};
  const fmt = a.asset_url_format || `steam/apps/${appid}/\${FILENAME}`;
  const u = (f) => (f ? STORE_ASSETS + fmt.replace('${FILENAME}', f) : null);
  const plain = (f) => `${STORE_ASSETS}steam/apps/${appid}/${f}`;
  return {
    hero: [u(a.library_hero_2x), u(a.library_hero), `${STEAM_CDN}${appid}/library_hero.jpg`].filter(Boolean),
    logo: [plain('logo_2x.png'), plain('logo.png'), `${STEAM_CDN}${appid}/logo.png`],
    capsule: [u(a.library_capsule_2x), u(a.library_capsule), `${STEAM_CDN}${appid}/library_600x900_2x.jpg`, `${STEAM_CDN}${appid}/library_600x900.jpg`].filter(Boolean),
    banner: [u(a.header_2x), u(a.header), `${STEAM_CDN}${appid}/header.jpg`].filter(Boolean),
    backdrop: [u(a.raw_page_background), u(a.hero_capsule_2x)].filter(Boolean),
  };
}

function steamMeta(item) {
  if (!item) return {};
  const b = item.basic_info || {};
  const names = (arr) => (arr || []).map((x) => x.name).filter(Boolean).join(', ');
  return {
    title: item.name || null,
    description: b.short_description || '',
    developer: names(b.developers),
    publisher: names(b.publishers),
    franchise: names(b.franchises),
    released: item.release && item.release.steam_release_date ? item.release.steam_release_date * 1000 : null,
  };
}

function steamScreenshots(item) {
  const list = (item && item.screenshots && item.screenshots.all_ages_screenshots) || [];
  return list.slice(0, 8).map((s) => ({
    full: STORE_ASSETS + s.filename,
    thumb: STORE_ASSETS + s.filename.replace(/\.jpg(\?|$)/, '.600x338.jpg$1'),
  }));
}

/* ------------------------------------------------------------------ */
/* SteamGridDB (optional, needs an API key)                           */
/* ------------------------------------------------------------------ */

async function sgdbGet(key, p) {
  const j = await getJson(SGDB_API + p, { Authorization: `Bearer ${key}` });
  return j && j.success ? j.data : null;
}

async function sgdbCandidates(key, game) {
  let gameId = null;
  if (game.steamAppId) {
    try {
      const d = await sgdbGet(key, `/games/steam/${game.steamAppId}`);
      gameId = d && d.id;
    } catch {}
  }
  if (!gameId) {
    try {
      const d = await sgdbGet(key, `/search/autocomplete/${encodeURIComponent(searchTerm(game.name))}`);
      gameId = d && d[0] && d[0].id;
    } catch {}
  }
  if (!gameId) return null;
  const grab = (p) => sgdbGet(key, p).then((d) => (d || []).map((x) => x.url)).catch(() => []);
  const [grid, capsule, hero, logo] = await Promise.all([
    grab(`/grids/game/${gameId}?dimensions=1024x1024,512x512&types=static`),
    grab(`/grids/game/${gameId}?dimensions=600x900&types=static`),
    grab(`/heroes/game/${gameId}?types=static`),
    grab(`/logos/game/${gameId}?types=static`),
  ]);
  return { sgdbId: gameId, grid, capsule, hero, logo };
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

async function download(urls, destNoExt) {
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 800) continue;
      const ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : ct.includes('gif') ? '.gif' : '.jpg';
      await fsp.writeFile(destNoExt + ext, buf);
      return path.basename(destNoExt + ext);
    } catch {}
  }
  return null;
}

async function pool(items, size, fn) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

module.exports = {
  searchSteam,
  resolveSteamAppId,
  fetchStoreItems,
  steamCandidates,
  steamMeta,
  steamScreenshots,
  sgdbCandidates,
  download,
  pool,
  sleep,
};
