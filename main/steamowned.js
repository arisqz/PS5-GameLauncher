// Steam games the user owns but hasn't installed, read from the Steam
// client's own caches (no sign-in, no Web API key, nothing sent anywhere):
//
//  - appcache\packageinfo.vdf: the packages (licences) the client knows,
//    each with the app ids it grants. Package 0 is Steam's own base package.
//    The cache is shared by every account used on the PC, so with several
//    accounts the list is narrowed to apps the signed-in account has in its
//    own userdata\<account>\config\localconfig.vdf.
//  - appcache\appinfo.vdf: name, type (game, demo, DLC, tool…), supported
//    systems, install folder and depot sizes of every app the client knows.
//    Since late 2026 Steam splits it into 256 shards, appcache\appinfo\
//    appinfo_00.vdf … appinfo_ff.vdf (format 42), and deletes appinfo.vdf.
//
// Both are binary KeyValues. The games among the licensed apps that have no
// appmanifest (not installed) become library entries that can be downloaded.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { parseVdf, getCI } = require('./vdf');

/** Binary KeyValues reader (types 0 = section, 1 = string, 2 = int32, 3 = float, 7 = uint64, 8 = end). */
function reader(buf, start, strings = null) {
  let o = start;
  const cstr = () => {
    const e = buf.indexOf(0, o);
    const s = buf.toString('utf8', o, e);
    o = e + 1;
    return s;
  };
  const key = () => {
    if (!strings) return cstr();
    const i = buf.readUInt32LE(o);
    o += 4;
    return strings[i];
  };
  function kv() {
    const obj = {};
    for (;;) {
      const t = buf[o++];
      if (t === 0x08 || t === undefined) return obj;
      const name = key();
      if (t === 0x00) obj[name] = kv();
      else if (t === 0x01) obj[name] = cstr();
      else if (t === 0x02 || t === 0x03) {
        obj[name] = t === 0x02 ? buf.readInt32LE(o) : buf.readFloatLE(o);
        o += 4;
      } else if (t === 0x07) {
        obj[name] = buf.readBigUInt64LE(o).toString();
        o += 8;
      } else throw new Error(`unknown KeyValues type ${t}`);
    }
  }
  return { kv, get pos() { return o; }, set pos(v) { o = v; } };
}

/** Package id -> app ids, from packageinfo.vdf (format 27 / 28). */
function readPackages(buf) {
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x06565527 && magic !== 0x06565528) throw new Error('unknown packageinfo.vdf format');
  const r = reader(buf, 8);
  const out = new Map();
  for (;;) {
    const id = buf.readUInt32LE(r.pos);
    r.pos += 4;
    if (id === 0xffffffff) break;
    r.pos += 20 + 4 + (magic === 0x06565528 ? 8 : 0); // sha1, change number, PICS token
    const data = r.kv();
    const p = data[String(id)] || Object.values(data)[0] || {};
    out.set(id, Object.values(p.appids || {}).map(Number));
  }
  return out;
}

/** Calls fn(id, appinfo) for the apps in `wanted` (a Set of numbers), from appinfo.vdf (format 28 / 29) or one shard (format 2A). */
function eachApp(buf, wanted, fn) {
  if (buf.readUInt32LE(0) === 0x0756442a) return eachShardApp(buf, wanted, fn);
  const magic = buf.readUInt32LE(0);
  let strings = null;
  let start = 8;
  if (magic === 0x07564429) {
    // Format 29: key names come from a string table at the offset after the universe.
    let p = Number(buf.readBigInt64LE(8));
    const count = buf.readUInt32LE(p);
    p += 4;
    strings = new Array(count);
    for (let i = 0; i < count; i++) {
      const e = buf.indexOf(0, p);
      strings[i] = buf.toString('utf8', p, e);
      p = e + 1;
    }
    start = 16;
  } else if (magic !== 0x07564428) throw new Error('unknown appinfo.vdf format');
  const r = reader(buf, start, strings);
  for (;;) {
    const id = buf.readUInt32LE(r.pos);
    if (id === 0) break;
    const size = buf.readUInt32LE(r.pos + 4);
    const end = r.pos + 8 + size;
    if (wanted.has(id)) {
      // info state, last updated, PICS token, sha1, change number, binary sha1
      r.pos += 8 + 4 + 4 + 8 + 20 + 4 + 20;
      try {
        const data = r.kv();
        fn(id, data.appinfo || Object.values(data)[0] || {});
      } catch {}
    }
    r.pos = end;
  }
}

/**
 * One appinfo shard (format 42, see github.com/xPaw/SteamAppInfo): a 44-byte
 * header, an index of apps, the shard's string table, then each app's data
 * (a 20-byte SHA-1 and its binary KeyValues, keys from the string table).
 */
function eachShardApp(buf, wanted, fn) {
  // magic, universe, shard index, shard count, then:
  const count = buf.readUInt32LE(16);
  const indexSize = buf.readUInt32LE(20);
  const stringCount = buf.readUInt32LE(24);
  const tableSize = buf.readUInt32LE(28);
  const index = 44;
  const strings = new Array(stringCount);
  for (let i = 0, p = index + indexSize; i < stringCount; i++) {
    const e = buf.indexOf(0, p);
    strings[i] = buf.toString('utf8', p, e);
    p = e + 1;
  }
  const data = index + indexSize + tableSize;
  const r = reader(buf, 0, strings);
  for (let i = 0, p = index; i < count; i++) {
    const id = buf.readUInt32LE(p);
    const offset = buf.readUInt32LE(p + 4);
    const summary = buf.readUInt32LE(p + 12);
    p += 16 + summary;
    if (!wanted.has(id)) continue;
    r.pos = data + offset + 20; // binary SHA-1
    try {
      const kv = r.kv();
      fn(id, kv.appinfo || Object.values(kv)[0] || {});
    } catch {}
  }
}

/** The shard an app's info is in: low byte of the MurmurHash3 finalizer of its id. */
function shardOf(appid) {
  let h = appid >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h & 0xff).toString(16).padStart(2, '0');
}

/**
 * Calls fn(id, appinfo) for the apps in `wanted`, from the shards when Steam
 * has them (only the shards those apps are in), else from appinfo.vdf.
 */
async function readApps(steamPath, wanted, fn) {
  const cache = path.join(steamPath, 'appcache');
  const dir = path.join(cache, 'appinfo');
  let shards = null;
  try {
    shards = (await fsp.readdir(dir)).filter((f) => /^appinfo_[0-9a-f]{2}\.vdf$/i.test(f));
  } catch {}
  if (!shards || !shards.length) return eachApp(await fsp.readFile(path.join(cache, 'appinfo.vdf')), wanted, fn);
  const need = new Set([...wanted].map(shardOf));
  const seen = new Set();
  const read = async (list, ids) => {
    for (const f of list) {
      let buf;
      try {
        buf = await fsp.readFile(path.join(dir, f));
      } catch {
        continue;
      }
      eachApp(buf, ids, (id, a) => (seen.add(id), fn(id, a)));
    }
  };
  const first = shards.filter((f) => need.has(f.slice(8, 10).toLowerCase()));
  await read(first, wanted);
  // Not where the hash says (another client build mapping them differently): look in the other shards too.
  const left = new Set([...wanted].filter((id) => !seen.has(id)));
  if (left.size) await read(shards.filter((f) => !first.includes(f)), left);
}

/* Accounts -------------------------------------------------------------- */

/**
 * The account Steam is (or was last) signed in with, and how many accounts
 * have been used on this PC. From logs\connection_log.txt ("[Logged On, …]
 * [U:1:<account>]"), else the newest entry of config\loginusers.vdf.
 */
async function steamAccounts(steamPath) {
  const out = { active: null, count: 0 };
  try {
    const users = getCI(parseVdf(await fsp.readFile(path.join(steamPath, 'config', 'loginusers.vdf'), 'utf8')), 'users') || {};
    const list = Object.entries(users).map(([id64, u]) => ({ account: (BigInt(id64) - 76561197960265728n).toString(), recent: getCI(u, 'MostRecent') === '1', time: Number(getCI(u, 'Timestamp') || 0) }));
    out.count = list.length;
    const pick = list.find((u) => u.recent) || list.sort((a, b) => b.time - a.time)[0];
    if (pick) out.active = pick.account;
  } catch {}
  try {
    const file = path.join(steamPath, 'logs', 'connection_log.txt');
    const fh = await fsp.open(file, 'r');
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const all = [...buf.toString('utf8').matchAll(/\[Logged On, [^\]]*\] \[U:1:(\d+)\]/g)];
      if (all.length) out.active = all[all.length - 1][1];
    } finally {
      await fh.close();
    }
  } catch {}
  return out;
}

/** App ids the account has its own settings for (played, installed, updated…). */
async function accountApps(steamPath, account) {
  try {
    const text = await fsp.readFile(path.join(steamPath, 'userdata', account, 'config', 'localconfig.vdf'), 'utf8');
    const apps = getCI(parseVdf(text), 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps') || {};
    return new Set(Object.keys(apps));
  } catch {
    return null;
  }
}

/* Owned games ----------------------------------------------------------- */

// Not games to show: test and experimental servers, dedicated servers, playtests.
const NOT_GAMES = /\b(test server|experimental server|public test|dedicated server|playtest)\b/i;

/**
 * Owned games (and demos) that aren't installed.
 * installed: the app ids that have an appmanifest.
 */
async function ownedNotInstalled(steamPath, installed, { exclude = () => false } = {}) {
  const cache = path.join(steamPath, 'appcache');
  const pk = await fsp.readFile(path.join(cache, 'packageinfo.vdf'));
  const owned = new Set();
  for (const [id, apps] of readPackages(pk)) if (id !== 0) for (const a of apps) owned.add(a);
  // Several accounts on this PC share the cache: leave out what only another
  // account knows. A game no account knows yet stays: Steam lists a game in an
  // account's localconfig.vdf only once it's been used (or Steam closes), so
  // one just added to the library (Rob Run) would otherwise never show.
  const accounts = await steamAccounts(steamPath);
  const mine = accounts.count > 1 && accounts.active ? await accountApps(steamPath, accounts.active) : null;
  const others = new Set();
  if (mine) {
    const dirs = await fsp.readdir(path.join(steamPath, 'userdata')).catch(() => []);
    for (const d of dirs) {
      if (d === accounts.active || !/^\d+$/.test(d)) continue;
      for (const id of (await accountApps(steamPath, d)) || []) if (!mine.has(id)) others.add(id);
    }
  }
  const out = [];
  await readApps(steamPath, owned, (id, a) => {
    const c = a.common || {};
    const type = String(c.type || '').toLowerCase();
    if ((type !== 'game' && type !== 'demo') || !c.name) return;
    if (c.oslist && !/windows/i.test(String(c.oslist))) return;
    if (installed.has(String(id)) || NOT_GAMES.test(c.name) || exclude(String(id), c.name)) return;
    if (others.has(String(id))) return;
    out.push({ appid: String(id), name: c.name, demo: type === 'demo' });
  });
  return out;
}

/** What installing a game needs: its install folder and sizes (Windows, public branch). */
async function appDetails(steamPath, appid) {
  let found = null;
  await readApps(steamPath, new Set([Number(appid)]), (_id, a) => (found = a));
  if (!found) return null;
  const c = found.common || {};
  let size = 0;
  let download = 0;
  for (const [id, d] of Object.entries(found.depots || {})) {
    if (!/^\d+$/.test(id) || !d || typeof d !== 'object') continue;
    if (d.dlcappid || d.depotfromapp || d.sharedinstall) continue; // DLC, redistributables
    const os = d.config && d.config.oslist;
    if (os && !/windows/i.test(String(os))) continue;
    const m = d.manifests && d.manifests.public;
    if (!m || typeof m !== 'object') continue;
    size += Number(m.size || 0);
    download += Number(m.download || 0);
  }
  return { name: c.name || '', installdir: (found.config && found.config.installdir) || c.name || '', size, download };
}

module.exports = { ownedNotInstalled, appDetails, steamAccounts };
