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

/** Package id -> app ids, from packageinfo.vdf (format 27 / 28; newer versions are read like 28). */
function readPackages(buf) {
  const magic = buf.readUInt32LE(0);
  const version = magic & 0xff;
  if (magic >>> 8 !== 0x065655 || version < 0x27) throw new Error(`unknown packageinfo.vdf format (0x${magic.toString(16)})`);
  const r = reader(buf, 8);
  const out = new Map();
  for (;;) {
    const id = buf.readUInt32LE(r.pos);
    r.pos += 4;
    if (id === 0xffffffff) break;
    r.pos += 20 + 4 + (version >= 0x28 ? 8 : 0); // sha1, change number, PICS token
    const data = r.kv();
    const p = data[String(id)] || Object.values(data)[0] || {};
    out.set(id, Object.values(p.appids || {}).map(Number));
  }
  return out;
}

/** Calls fn(id, appinfo) for the apps in `wanted` (a Set of numbers), from appinfo.vdf (format 28 / 29; newer versions are read like 29). */
function eachApp(buf, wanted, fn) {
  const magic = buf.readUInt32LE(0);
  const version = magic & 0xff;
  if (magic >>> 8 !== 0x075644 || version < 0x28) throw new Error(`unknown appinfo.vdf format (0x${magic.toString(16)})`);
  let strings = null;
  let start = 8;
  if (version >= 0x29) {
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
  }
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
  const [pk, ai] = await Promise.all([fsp.readFile(path.join(cache, 'packageinfo.vdf')), fsp.readFile(path.join(cache, 'appinfo.vdf'))]);
  const owned = new Set();
  for (const [id, apps] of readPackages(pk)) if (id !== 0) for (const a of apps) owned.add(a);
  // Several accounts on this PC share the cache: keep what the signed-in one knows.
  const accounts = await steamAccounts(steamPath);
  const mine = accounts.count > 1 && accounts.active ? await accountApps(steamPath, accounts.active) : null;
  const all = [];
  eachApp(ai, owned, (id, a) => {
    const c = a.common || {};
    const type = String(c.type || '').toLowerCase();
    if ((type !== 'game' && type !== 'demo') || !c.name) return;
    if (c.oslist && !/windows/i.test(String(c.oslist))) return;
    if (installed.has(String(id)) || NOT_GAMES.test(c.name) || exclude(String(id), c.name)) return;
    all.push({ appid: String(id), name: c.name, demo: type === 'demo' });
  });
  // That account filter only knows games the account has touched; if it would
  // leave nothing, it's not to be trusted (wrong account guessed): show them all.
  const out = mine ? all.filter((g) => mine.has(g.appid)) : all;
  return out.length || !all.length ? out : all;
}

/** What installing a game needs: its install folder and sizes (Windows, public branch). */
async function appDetails(steamPath, appid) {
  const buf = await fsp.readFile(path.join(steamPath, 'appcache', 'appinfo.vdf'));
  let found = null;
  eachApp(buf, new Set([Number(appid)]), (_id, a) => (found = a));
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
