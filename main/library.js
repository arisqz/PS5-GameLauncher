const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');
const scanner = require('./scanner');
const meta = require('./metadata');

const ART_KEYS = ['hero', 'logo', 'capsule', 'banner', 'grid', 'icon'];

class Library {
  /**
   * @param {object} o
   * @param {import('./store').JsonStore} o.store    library.json
   * @param {import('./store').JsonStore} o.settings settings.json
   * @param {string} o.artDir
   * @param {(channel: string, payload: any) => void} o.send
   */
  constructor({ store, settings, artDir, send }) {
    this.store = store;
    this.settings = settings;
    this.artDir = artDir;
    this.send = send;
    this.scanning = null;
    this.steamInfo = null;
    this.epicFound = false;
    this.publishTimer = null;
    if (!Array.isArray(this.store.data.games)) this.store.data.games = [];
    if (!Array.isArray(this.store.data.excluded)) this.store.data.excluded = [];
  }

  get games() {
    return this.store.data.games;
  }

  find(id) {
    return this.games.find((g) => g.id === id);
  }

  artPath(id) {
    return path.join(this.artDir, id.replace(/[^a-z0-9_-]/gi, '_'));
  }

  publish(now = false) {
    clearTimeout(this.publishTimer);
    const go = () => this.send('library:changed', this.games);
    if (now) go();
    else this.publishTimer = setTimeout(go, 250);
  }

  save() {
    this.store.saveSoon();
    this.publish();
  }

  progress(p) {
    this.send('scan:progress', p);
  }

  notify(title, body, icon = 'library') {
    this.send('notify', { title, body, icon });
  }

  newGame(r) {
    return {
      ...r,
      addedAt: Date.now(),
      lastPlayed: 0,
      playtime: 0,
      launchCount: 0,
      favorite: false,
      hidden: false,
      category: 'game',
      art: {},
      artVersion: 0,
      meta: {},
      screenshots: [],
      metaStatus: 'pending',
    };
  }

  /* -------------------------------------------------------------- */

  scan({ silent = false } = {}) {
    if (this.scanning) return this.scanning;
    this.scanning = this._scan(silent).finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  async _scan(silent) {
    const s = this.settings.data;
    this.progress({ active: true, label: 'Scanning for games…', current: 0, total: 0 });

    const found = [];
    if (s.scanSteam) {
      try {
        const steam = await scanner.scanSteam();
        this.steamInfo = steam.found ? { path: steam.steamPath, persona: steam.persona, count: steam.games.length } : null;
        found.push(...steam.games);
      } catch (err) {
        console.warn('[scan] steam failed', err);
      }
    }
    if (s.scanEpic) {
      try {
        const epic = await scanner.scanEpic();
        this.epicFound = epic.found;
        found.push(...epic.games);
      } catch (err) {
        console.warn('[scan] epic failed', err);
      }
    }
    if (s.scanXbox !== false) {
      try {
        const xbox = await scanner.scanXbox();
        this.xboxFound = xbox.found && xbox.games.length > 0;
        found.push(...xbox.games);
      } catch (err) {
        console.warn('[scan] xbox failed', err);
      }
    }
    if (s.scanUbisoft !== false) {
      try {
        const ubi = await scanner.scanUbisoft();
        this.ubisoftFound = ubi.found;
        found.push(...ubi.games);
      } catch (err) {
        console.warn('[scan] ubisoft failed', err);
      }
    }
    for (const folder of s.folders || []) {
      this.progress({ active: true, label: `Scanning ${path.basename(folder) || folder}…`, current: 0, total: 0 });
      found.push(...(await scanner.scanFolder(folder)));
    }

    const added = this.merge(found);
    this.store.saveNow();
    this.publish(true);

    const pending = this.games.filter((g) => g.metaStatus === 'pending' || g.metaStatus === 'error');
    if (pending.length) await this.fetchMetadata(pending);

    this.progress({ active: false });
    if (!silent || added.length) {
      if (added.length) {
        this.notify(
          added.length === 1 ? 'New game added' : `${added.length} new games added`,
          added.slice(0, 3).map((g) => g.name).join(', ') + (added.length > 3 ? '…' : ''),
          'library'
        );
      } else if (!silent) {
        this.notify('Library is up to date', `${this.games.length} games in your library`, 'check');
      }
    }
    return { added: added.length, total: this.games.length };
  }

  /** Merge scan results into the library. Returns the newly added games. */
  merge(found) {
    for (const g of this.games) for (const k of ['update', 'updateRequested', 'manifest', 'steamRoot']) delete g[k];
    const s = this.settings.data;
    const excluded = new Set(this.store.data.excluded);
    const byId = new Map(this.games.map((g) => [g.id, g]));
    const steamIds = new Set(found.filter((r) => r.source === 'steam').map((r) => r.steamAppId));
    const seen = new Set();
    const added = [];

    for (const r of found) {
      if (excluded.has(r.id) || seen.has(r.id)) continue;
      if (r.source === 'folder' && r.steamAppId && steamIds.has(r.steamAppId)) continue;
      seen.add(r.id);
      const g = byId.get(r.id);
      if (g) {
        for (const k of ['launch', 'direct', 'directSafe', 'storeId', 'altDirs', 'path', 'folder', 'installDir', 'exe', 'sizeOnDisk', 'steamPlaytime', 'steamLastPlayed']) {
          if (r[k] !== undefined) g[k] = r[k];
        }
        if (!g.nameLocked && !g.meta?.title) g.name = r.name;
        if (!g.steamAppId && r.steamAppId && !g.noSteamMatch) {
          g.steamAppId = r.steamAppId;
          g.metaStatus = 'pending';
        }
      } else {
        const ng = this.newGame(r);
        this.games.push(ng);
        byId.set(ng.id, ng);
        added.push(ng);
      }
    }

    const folders = new Set(s.folders || []);
    const removed = [];
    this.store.data.games = this.games.filter((g) => {
      let keep = true;
      if (g.source === 'steam') keep = s.scanSteam && seen.has(g.id);
      else if (g.source === 'epic') keep = s.scanEpic && seen.has(g.id);
      else if (g.source === 'xbox') keep = s.scanXbox !== false && seen.has(g.id);
      else if (g.source === 'ubisoft') keep = s.scanUbisoft !== false && seen.has(g.id);
      else if (g.source === 'folder') keep = folders.has(g.folder) && seen.has(g.id);
      if (!keep) removed.push(g);
      return keep;
    });
    for (const g of removed) this.deleteArt(g.id);
    return added;
  }

  async importPaths(paths) {
    const found = [];
    const addFolders = [];
    for (const p of paths) {
      let st;
      try {
        st = await fsp.stat(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) addFolders.push(p);
      else {
        const g = await scanner.describeFile(p, { source: 'manual' });
        if (g) found.push(g);
      }
    }
    const added = [];
    const excluded = new Set(this.store.data.excluded);
    for (const r of found) {
      if (this.find(r.id)) continue;
      if (r.steamAppId && this.games.some((g) => g.steamAppId === r.steamAppId)) continue;
      this.store.data.excluded = this.store.data.excluded.filter((x) => x !== r.id);
      excluded.delete(r.id);
      const ng = this.newGame(r);
      this.games.push(ng);
      added.push(ng);
    }
    if (addFolders.length) {
      const s = this.settings.data;
      s.folders = [...new Set([...(s.folders || []), ...addFolders])];
      this.settings.saveNow();
      this.send('settings:changed', s);
    }
    this.store.saveNow();
    this.publish(true);
    if (addFolders.length) {
      const r = await this.scan({ silent: false });
      return added.length + ((r && r.added) || 0) + addFolders.length;
    }
    if (added.length) {
      await this.fetchMetadata(added);
      this.notify(added.length === 1 ? 'Game added' : `${added.length} games added`, added.map((g) => g.name).join(', '), 'library');
    }
    return added.length;
  }

  /* -------------------------------------------------------------- */

  async fetchMetadata(games, { force = false } = {}) {
    if (!games.length) return;
    const s = this.settings.data;
    const total = games.length;
    let done = 0;
    this.progress({ active: true, label: 'Finding artwork…', current: 0, total });

    // 1. Resolve Steam app ids by name for non-Steam entries.
    for (const g of games) {
      if (g.steamAppId || g.noSteamMatch) continue;
      this.progress({ active: true, label: `Matching ${g.name}…`, current: done, total });
      try {
        const m = await meta.resolveSteamAppId(g.name);
        if (m) {
          g.steamAppId = m.appid;
          g.matchedName = m.name;
        }
      } catch (err) {
        g.metaStatus = 'error';
      }
      await meta.sleep(150);
    }

    // 2. Batch store lookups.
    const items = await meta.fetchStoreItems(games.map((g) => g.steamAppId));

    // 3. Artwork downloads.
    await meta.pool(games, 4, async (g) => {
      this.progress({ active: true, label: `Downloading artwork · ${g.name}`, current: done, total });
      try {
        await this.fetchArtFor(g, items[g.steamAppId], force, s);
      } catch (err) {
        console.warn('[metadata] failed for', g.name, err);
        g.metaStatus = 'error';
      }
      done++;
      this.progress({ active: true, label: `Downloading artwork · ${g.name}`, current: done, total });
      this.save();
    });
    this.store.saveNow();
    this.publish(true);
    this.progress({ active: false });
  }

  async fetchArtFor(g, item, force, s) {
    const dir = this.artPath(g.id);
    await fsp.mkdir(dir, { recursive: true });
    const custom = g.customArt || {};
    if (force) {
      for (const f of await fsp.readdir(dir)) {
        if (!f.startsWith('custom-')) await fsp.rm(path.join(dir, f), { force: true });
      }
    }

    const art = {};
    for (const k of ART_KEYS) if (custom[k] && g.art && g.art[k]) art[k] = g.art[k];

    const steam = g.steamAppId ? meta.steamCandidates(g.steamAppId, item) : null;
    let sg = null;
    if (s.sgdbKey) {
      try {
        sg = await meta.sgdbCandidates(s.sgdbKey, g);
      } catch {}
    }
    const preferSg = s.artSource === 'sgdb';
    const order = (k) => {
      const a = (steam && steam[k]) || [];
      const b = (sg && sg[k]) || [];
      return preferSg ? [...b, ...a] : [...a, ...b];
    };

    const get = async (k, list) => {
      if (art[k] || !list.length) return;
      art[k] = await meta.download(list, path.join(dir, k));
    };
    await Promise.all([get('hero', order('hero')), get('logo', order('logo')), get('capsule', order('capsule')), get('banner', order('banner'))]);
    if (sg && sg.grid.length) await get('grid', sg.grid.slice(0, 3));

    // Steam's own library cache (newer games keep logos under hashed paths
    // that the public store API does not expose).
    if (g.steamAppId && (!art.logo || !art.hero || !art.capsule || !art.banner)) {
      const local = await this.steamLocalAssets(g.steamAppId);
      for (const [k, file] of Object.entries(local)) {
        if (art[k] || !file) continue;
        const name = k + path.extname(file).toLowerCase();
        try {
          await fsp.copyFile(file, path.join(dir, name));
          art[k] = name;
        } catch {}
      }
    }
    if (!art.hero && steam && steam.backdrop.length) await get('hero', steam.backdrop);

    // Executable icon as a last-resort tile.
    const exe = g.exe || (g.launch && g.launch.type === 'exe' ? g.launch.target : null);
    if (!art.icon && exe && fs.existsSync(exe)) {
      try {
        const img = await app.getFileIcon(exe, { size: 'large' });
        if (!img.isEmpty()) {
          await fsp.writeFile(path.join(dir, 'icon.png'), img.toPNG());
          art.icon = 'icon.png';
        }
      } catch {}
    }

    for (const k of Object.keys(art)) if (!art[k]) delete art[k];
    g.art = art;
    g.artVersion = Date.now();
    if (item) {
      g.meta = meta.steamMeta(item);
      g.screenshots = meta.steamScreenshots(item);
    } else if (!g.steamAppId) {
      g.meta = {};
      g.screenshots = [];
    }
    g.metaStatus = g.steamAppId || sg ? 'ok' : 'notfound';
  }

  async steamLocalAssets(appid) {
    if (this.steamPath === undefined) this.steamPath = await scanner.findSteamPath();
    const out = {};
    if (!this.steamPath) return out;
    const base = path.join(this.steamPath, 'appcache', 'librarycache');
    const wanted = {
      logo: ['logo.png'],
      hero: ['library_hero.jpg'],
      capsule: ['library_600x900.jpg', 'library_capsule.jpg'],
      banner: ['header.jpg', 'library_header.jpg'],
    };
    const appDir = path.join(base, String(appid));
    let subdirs = [];
    try {
      subdirs = (await fsp.readdir(appDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(appDir, e.name));
    } catch {}
    for (const [k, names] of Object.entries(wanted)) {
      for (const n of names) {
        const candidates = [path.join(base, `${appid}_${n}`), path.join(appDir, n), ...subdirs.map((d) => path.join(d, n))];
        const hit = candidates.find((f) => fs.existsSync(f));
        if (hit) {
          out[k] = hit;
          break;
        }
      }
    }
    return out;
  }

  async setMatch(id, appid) {
    const g = this.find(id);
    if (!g) return null;
    if (appid) {
      g.steamAppId = String(appid);
      g.noSteamMatch = false;
    } else {
      if (g.source !== 'steam') g.steamAppId = null;
      g.noSteamMatch = true;
    }
    g.customArt = {};
    await this.fetchMetadata([g], { force: true });
    return g;
  }

  async setCustomArt(id, kind, file) {
    const g = this.find(id);
    if (!g || !ART_KEYS.includes(kind)) return null;
    const dir = this.artPath(g.id);
    await fsp.mkdir(dir, { recursive: true });
    for (const f of await fsp.readdir(dir)) {
      if (f.startsWith(`custom-${kind}.`)) await fsp.rm(path.join(dir, f), { force: true });
    }
    const name = `custom-${kind}${path.extname(file).toLowerCase() || '.png'}`;
    await fsp.copyFile(file, path.join(dir, name));
    g.art = { ...(g.art || {}), [kind]: name };
    g.customArt = { ...(g.customArt || {}), [kind]: true };
    g.artVersion = Date.now();
    this.save();
    return g;
  }

  /* -------------------------------------------------------------- */

  update(id, patch) {
    const g = this.find(id);
    if (!g) return null;
    const allowed = ['name', 'favorite', 'hidden', 'category', 'lastPlayed', 'launchCount', 'playtime', 'pauseMode', 'launchMode'];
    for (const k of allowed) if (k in patch) g[k] = patch[k];
    if ('name' in patch) g.nameLocked = true;
    if (patch.launchArgs !== undefined) {
      if (g.launch && g.launch.type === 'exe') g.launch.args = patch.launchArgs;
      else g.launchArgs = patch.launchArgs; // added to store and direct starts
    }
    this.save();
    return g;
  }

  remove(id) {
    const g = this.find(id);
    if (!g) return;
    if (!this.store.data.excluded.includes(id)) this.store.data.excluded.push(id);
    this.store.data.games = this.games.filter((x) => x.id !== id);
    this.deleteArt(id);
    this.save();
  }

  restoreExcluded() {
    const n = this.store.data.excluded.length;
    this.store.data.excluded = [];
    this.store.saveNow();
    return n;
  }

  deleteArt(id) {
    fs.rm(this.artPath(id), { recursive: true, force: true }, () => {});
  }

  async reset() {
    this.store.data.games = [];
    this.store.data.excluded = [];
    await fsp.rm(this.artDir, { recursive: true, force: true });
    this.store.saveNow();
    this.publish(true);
  }

  async cacheSize() {
    let total = 0;
    const walk = async (d) => {
      let entries;
      try {
        entries = await fsp.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) await walk(f);
        else {
          try {
            total += (await fsp.stat(f)).size;
          } catch {}
        }
      }
    };
    await walk(this.artDir);
    return total;
  }

  async refreshSteamPlaytime() {
    if (!this.settings.data.scanSteam) return;
    const steamPath = await scanner.findSteamPath();
    if (!steamPath) return;
    const user = await scanner.readSteamUser(steamPath);
    let changed = false;
    for (const g of this.games) {
      const viaSteam = g.source === 'steam' || String(g.launch?.target || '').startsWith('steam://');
      if (!viaSteam || !g.steamAppId) continue;
      const pt = user.playtime[g.steamAppId];
      if (!pt) continue;
      if (pt.minutes !== g.steamPlaytime || pt.lastPlayed !== g.steamLastPlayed) {
        g.steamPlaytime = pt.minutes;
        g.steamLastPlayed = pt.lastPlayed;
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

module.exports = { Library };
