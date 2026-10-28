// Steam friends for the Game Base (quick menu): who is online and what they
// are playing, for the account signed in to Steam on this PC.
//
// It reads Steam's Web API (ISteamUser GetFriendList + GetPlayerSummaries)
// with the user's own key from steamcommunity.com/dev/apikey, stored like the
// Discord secret (encrypted with Windows DPAPI via Electron's safeStorage).
// Nothing here signs in to Steam or reads chats: messaging a friend, joining
// their game or opening their profile hands a steam:// link to the Steam
// client, which does it itself.
//
// Steam only hands out a friends list that is public. When the user's isn't,
// the friends come from the Steam client's own copy on this PC instead
// (userdata\<account>\config\localconfig.vdf, "friends": the people it keeps
// names and pictures of, which can include a few non-friends from group
// chats); who is online and what they play is asked of Steam as before.

const fs = require('fs');
const path = require('path');
const { safeStorage, shell, clipboard } = require('electron');
const scanner = require('./scanner');
const { steamAccounts } = require('./steamowned');
const { parseVdf, getCI } = require('./vdf');

const API = 'https://api.steampowered.com';
const STEAM64 = 76561197960265728n;
const STALE = 30 * 1000; // older than this and a look at the list refreshes it
const BACKGROUND = 3 * 60 * 1000; // the bar's online count, while nobody looks
const STATES = ['offline', 'online', 'busy', 'away', 'snooze', 'trade', 'play']; // personastate 0-6

class SteamFriends {
  constructor({ file, send, system }) {
    this.file = file;
    this.send = send;
    this.system = system;
    this.creds = this.load();
    this.steamPath = null;
    this.timer = null;
    this.busy = null;
    this.state = {
      configured: !!this.creds.key,
      status: this.creds.key ? 'idle' : 'setup', // setup | idle | loading | ready | error
      error: null,
      self: null, // { id, name, avatar }
      source: null, // 'steam' (the Web API's friends list) | 'local' (the Steam client's copy: the list is private)
      friends: [], // [{ id, name, avatar, state, game, gameId, lobby, lastOnline }]
      online: 0,
      updated: 0,
    };
  }

  /* -------------------------------------------------------------- */
  /* The key                                                        */
  /* -------------------------------------------------------------- */

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.creds, null, 2));
    } catch (err) {
      console.error('[steamfriends] failed to save the key', err);
    }
  }

  key() {
    const box = this.creds.key;
    if (!box) return null;
    try {
      const raw = Buffer.from(box.v, 'base64');
      return box.enc ? safeStorage.decryptString(raw) : raw.toString('utf8');
    } catch {
      return null;
    }
  }

  /** Save the Web API key (typed, or from the clipboard), then load the friends. */
  async setKey({ key, fromClipboard = false } = {}) {
    const text = String(fromClipboard ? clipboard.readText() : key || '').trim();
    if (!/^[0-9A-Fa-f]{32}$/.test(text)) {
      throw new Error(fromClipboard ? 'The clipboard has no Steam Web API key (32 letters and numbers).' : 'A Steam Web API key is 32 letters and numbers (0-9, A-F).');
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage isn’t available on this PC, so the Steam Web API key can’t be saved safely.');
    }
    this.creds.key = { enc: true, v: safeStorage.encryptString(text.toUpperCase()).toString('base64') };
    this.save();
    this.state.configured = true;
    this.state.error = null;
    this.state.status = 'idle';
    this.push();
    await this.refresh(true);
    return this.publicState();
  }

  forget() {
    this.creds = {};
    this.save();
    clearTimeout(this.timer);
    Object.assign(this.state, { configured: false, status: 'setup', error: null, self: null, friends: [], online: 0, updated: 0 });
    this.push();
    return this.publicState();
  }

  /* -------------------------------------------------------------- */
  /* Loading                                                        */
  /* -------------------------------------------------------------- */

  start() {
    if (this.state.configured) this.refresh(true).catch(() => {});
  }

  stop() {
    clearTimeout(this.timer);
  }

  publicState() {
    return { ...this.state };
  }

  push() {
    this.send('steamfriends:state', this.publicState());
  }

  /** The state now; the list is refreshed first when it is older than STALE (or always, with force). */
  async get({ refresh = false } = {}) {
    if (this.state.configured && (refresh || Date.now() - this.state.updated > STALE)) await this.refresh(refresh).catch(() => {});
    return this.publicState();
  }

  /** The signed-in Steam account as a SteamID64. */
  async steamId() {
    if (!this.steamPath) this.steamPath = await scanner.findSteamPath();
    if (!this.steamPath) throw new Error('Steam was not found on this PC.');
    const { active } = await steamAccounts(this.steamPath);
    if (!active) throw new Error('Sign in to Steam once on this PC.');
    return (BigInt(active) + STEAM64).toString();
  }

  async api(method, params) {
    const key = this.key();
    if (!key) throw Object.assign(new Error('Enter your Steam Web API key in Settings.'), { setup: true });
    const url = `${API}/ISteamUser/${method}/?${new URLSearchParams({ key, ...params })}`;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    } catch {
      throw new Error('Steam can’t be reached. Check the internet connection.');
    }
    if (res.status === 401) throw Object.assign(new Error('Steam didn’t share the friends list. In Steam › Profile › Edit Profile › Privacy Settings, set Friends List to Public.'), { private: true });
    if (res.status === 403) throw new Error('Steam turned the key down. Check the Steam Web API key in Settings.');
    if (res.status === 429) throw new Error('Steam asked to slow down. Try again in a minute.');
    if (!res.ok) throw new Error(`Steam answered ${res.status}. Try again in a moment.`);
    return res.json();
  }

  /** The friends the Steam client keeps on this PC (SteamID64s), for a private friends list. */
  async localFriends(me) {
    const account = (BigInt(me) - STEAM64).toString();
    try {
      const text = await fs.promises.readFile(path.join(this.steamPath, 'userdata', account, 'config', 'localconfig.vdf'), 'utf8');
      const friends = getCI(getCI(parseVdf(text), 'UserLocalConfigStore') || {}, 'friends') || {};
      return Object.keys(friends)
        .filter((k) => /^\d+$/.test(k) && k !== account && friends[k] && typeof friends[k] === 'object')
        .map((k) => (BigInt(k) + STEAM64).toString());
    } catch {
      return [];
    }
  }

  async summaries(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const j = await this.api('GetPlayerSummaries/v2', { steamids: ids.slice(i, i + 100).join(',') });
      out.push(...((j.response && j.response.players) || []));
    }
    return out;
  }

  /** Read the friends list and everyone's status again (one at a time). */
  refresh(force = false) {
    if (this.busy) return this.busy;
    if (!force && Date.now() - this.state.updated < STALE / 2) return Promise.resolve(this.publicState());
    this.busy = (async () => {
      clearTimeout(this.timer);
      if (!this.state.updated) {
        this.state.status = 'loading';
        this.push();
      }
      try {
        const me = await this.steamId();
        let ids;
        let source = 'steam';
        try {
          const list = await this.api('GetFriendList/v1', { steamid: me, relationship: 'friend' });
          ids = ((list.friendslist && list.friendslist.friends) || []).map((f) => f.steamid);
        } catch (err) {
          if (!err.private) throw err;
          ids = await this.localFriends(me);
          source = 'local';
          if (!ids.length) throw err;
        }
        const people = await this.summaries([me, ...ids]);
        const describe = (p) => ({
          id: p.steamid,
          name: p.personaname || p.steamid,
          avatar: p.avatarfull || p.avatarmedium || p.avatar || null,
          state: STATES[p.personastate] || 'offline',
          game: p.gameextrainfo || null,
          gameId: p.gameid || null,
          lobby: p.lobbysteamid || null,
          lastOnline: p.lastlogoff ? p.lastlogoff * 1000 : 0,
        });
        const self = people.find((p) => p.steamid === me);
        const friends = people.filter((p) => p.steamid !== me).map(describe);
        // As on the PS5: whoever is in a game first, then the rest online, then offline (most recent first).
        const rank = (f) => (f.state === 'offline' ? 3 : f.game ? 0 : f.state === 'online' || f.state === 'play' || f.state === 'trade' ? 1 : 2);
        friends.sort((a, b) => rank(a) - rank(b) || (rank(a) === 3 ? b.lastOnline - a.lastOnline : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
        Object.assign(this.state, {
          status: 'ready',
          error: null,
          source,
          self: self ? describe(self) : null,
          friends,
          online: friends.filter((f) => f.state !== 'offline').length,
          updated: Date.now(),
        });
      } catch (err) {
        this.state.error = err.message;
        if (err.setup) this.state.status = 'setup';
        else if (!this.state.updated) this.state.status = 'error';
      } finally {
        this.busy = null;
        this.push();
        if (this.state.configured) this.timer = setTimeout(() => this.refresh(true).catch(() => {}), BACKGROUND);
      }
      return this.publicState();
    })();
    return this.busy;
  }

  /* -------------------------------------------------------------- */
  /* Actions (the Steam client does them)                           */
  /* -------------------------------------------------------------- */

  /**
   * message | profile | join | friends: a steam:// link for Steam, then its
   * window is brought in front of the launcher (Steam may not get to do that
   * itself while another app is in front).
   */
  async open(kind, id) {
    const sid = String(id || '');
    if (kind !== 'friends' && !/^\d{17}$/.test(sid)) throw new Error('Unknown Steam friend.');
    const f = this.state.friends.find((x) => x.id === sid);
    let url;
    if (kind === 'message') url = `steam://friends/message/${sid}`;
    else if (kind === 'profile') url = `steam://url/SteamIDPage/${sid}`;
    else if (kind === 'friends') url = 'steam://open/friends';
    else if (kind === 'join') {
      // Only a game that shows a joinable lobby, as Steam's own Join Game.
      if (!f || !f.gameId || !f.lobby || !/^\d+$/.test(String(f.gameId)) || !/^\d+$/.test(String(f.lobby))) throw new Error('Your friend’s game can’t be joined right now.');
      url = `steam://joinlobby/${f.gameId}/${f.lobby}/${sid}`;
    } else throw new Error('Unknown action.');
    const before = new Set((await this.steamWindows()).map((w) => w.hwnd));
    await shell.openExternal(url);
    if (kind !== 'join') this.bringForward(before, f && f.name).catch(() => {});
    return true;
  }

  async steamWindows() {
    if (!this.system || !this.system.available()) return [];
    try {
      const list = await this.system.request('appWindows', { name: 'steamwebhelper', title: '' }, 3000);
      return (list || []).filter((w) => w.visible && !w.minimized);
    } catch {
      return [];
    }
  }

  /** The window Steam opened for it (new, or the chat with that friend) in front. */
  async bringForward(before, name) {
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const list = await this.steamWindows();
      const win = list.find((w) => !before.has(w.hwnd)) || (name && list.find((w) => String(w.title || '').includes(name)));
      if (win) {
        await this.system.request('fgSet', { hwnd: win.hwnd }, 3000).catch(() => {});
        return;
      }
    }
  }
}

module.exports = { SteamFriends };
