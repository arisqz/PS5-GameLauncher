// Discord voice control over Discord's local RPC pipe (\\.\pipe\discord-ipc-N).
//
// Voice control needs the `rpc` OAuth scopes, which Discord only grants to an
// application's own developers. So the user creates an application in the
// Discord Developer Portal and enters its Application ID + Client Secret
// once; Discord then shows an "Authorize" prompt and we keep the token
// (encrypted with Windows DPAPI via Electron's safeStorage).

const net = require('net');
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const SCOPES = ['rpc', 'rpc.voice.read', 'rpc.voice.write'];
const REDIRECT_URI = 'http://localhost';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';

let nonceSeq = 0;
const nonce = () => `${Date.now().toString(36)}-${++nonceSeq}`;

class DiscordBridge {
  constructor({ file, send }) {
    this.file = file;
    this.send = send;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this.retryTimer = null;
    this.pushTimer = null;
    this.channelSubs = null;
    this.creds = this.loadCreds();
    this.state = {
      configured: !!(this.creds.clientId && this.creds.secret),
      clientId: this.creds.clientId || '',
      authorized: !!this.creds.access,
      status: 'idle', // idle | setup | connecting | offline | authorizing | needs-auth | ready | error
      error: null,
      user: null,
      voice: null, // { mute, deaf, input, output }
      channel: null, // { id, name, guild }
      members: [], // [{ id, name, avatar, mute, deaf, speaking, volume, self }]
    };
    if (!this.state.configured) this.state.status = 'setup';
  }

  /* -------------------------------------------------------------- */
  /* Credentials                                                    */
  /* -------------------------------------------------------------- */

  loadCreds() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  saveCreds() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.creds, null, 2));
    } catch (err) {
      console.error('[discord] failed to save credentials', err);
    }
  }

  seal(text) {
    if (!text) return null;
    if (safeStorage.isEncryptionAvailable()) return { enc: true, v: safeStorage.encryptString(text).toString('base64') };
    return { enc: false, v: Buffer.from(text, 'utf8').toString('base64') };
  }

  open(box) {
    if (!box) return null;
    try {
      const raw = Buffer.from(box.v, 'base64');
      return box.enc ? safeStorage.decryptString(raw) : raw.toString('utf8');
    } catch {
      return null;
    }
  }

  setup({ clientId, secret }) {
    if (clientId !== undefined) {
      const id = String(clientId).trim();
      if (id && !/^\d{15,22}$/.test(id)) throw new Error('The Application ID is the long number on the app’s General Information page.');
      if (id !== this.creds.clientId) {
        this.creds.access = null;
        this.creds.refresh = null;
      }
      this.creds.clientId = id;
    }
    if (secret !== undefined && String(secret).trim()) this.creds.secret = this.seal(String(secret).trim());
    this.saveCreds();
    this.state.configured = !!(this.creds.clientId && this.creds.secret);
    this.state.clientId = this.creds.clientId || '';
    this.state.authorized = !!this.creds.access;
    if (!this.state.configured) this.setStatus('setup');
    else if (this.state.status === 'setup') this.setStatus('idle');
    this.push();
    return this.publicState();
  }

  forget() {
    this.close();
    this.creds = {};
    this.saveCreds();
    Object.assign(this.state, { configured: false, clientId: '', authorized: false, user: null, voice: null, channel: null, members: [], error: null });
    this.setStatus('setup');
    return this.publicState();
  }

  /* -------------------------------------------------------------- */
  /* State                                                          */
  /* -------------------------------------------------------------- */

  publicState() {
    return { ...this.state, members: this.state.members.slice() };
  }

  setStatus(status, error = null) {
    this.state.status = status;
    this.state.error = error;
    this.push();
  }

  push() {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.send('discord:state', this.publicState()), 40);
  }

  /* -------------------------------------------------------------- */
  /* Pipe transport                                                 */
  /* -------------------------------------------------------------- */

  write(op, payload) {
    if (!this.sock) return;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const head = Buffer.alloc(8);
    head.writeInt32LE(op, 0);
    head.writeInt32LE(body.length, 4);
    this.sock.write(Buffer.concat([head, body]));
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) break;
      const body = this.buf.subarray(8, 8 + len).toString('utf8');
      this.buf = this.buf.subarray(8 + len);
      let msg = null;
      try {
        msg = JSON.parse(body);
      } catch {}
      this.onMessage(op, msg);
    }
  }

  onMessage(op, msg) {
    if (op === OP.PING) return this.write(OP.PONG, msg);
    if (op === OP.CLOSE) {
      const reason = (msg && msg.message) || 'Discord closed the connection';
      this.close();
      this.setStatus('error', /client id|invalid/i.test(reason) ? 'Discord rejected the Application ID. Check it in Settings.' : reason);
      return;
    }
    if (!msg) return;
    if (msg.nonce && this.pending.has(msg.nonce)) {
      const p = this.pending.get(msg.nonce);
      this.pending.delete(msg.nonce);
      clearTimeout(p.timer);
      if (msg.evt === 'ERROR') p.reject(Object.assign(new Error((msg.data && msg.data.message) || 'Discord error'), { code: msg.data && msg.data.code }));
      else p.resolve(msg.data);
      return;
    }
    if (msg.cmd === 'DISPATCH') this.onEvent(msg.evt, msg.data || {});
  }

  request(cmd, args = {}, { evt, timeout = 10000 } = {}) {
    if (!this.sock) return Promise.reject(new Error('Not connected to Discord'));
    return new Promise((resolve, reject) => {
      const n = nonce();
      const timer = setTimeout(() => {
        this.pending.delete(n);
        reject(new Error(`${cmd} timed out`));
      }, timeout);
      this.pending.set(n, { resolve, reject, timer });
      const payload = { cmd, args, nonce: n };
      if (evt) payload.evt = evt;
      this.write(OP.FRAME, payload);
    });
  }

  openPipe() {
    return new Promise((resolve, reject) => {
      let i = 0;
      const tryNext = () => {
        if (i > 9) return reject(new Error('Discord is not running'));
        const sock = net.connect(`\\\\?\\pipe\\discord-ipc-${i++}`);
        sock.once('connect', () => {
          sock.removeAllListeners('error');
          resolve(sock);
        });
        sock.once('error', () => tryNext());
      };
      tryNext();
    });
  }

  close() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.sock) {
      const s = this.sock;
      this.sock = null;
      try {
        s.destroy();
      } catch {}
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Disconnected'));
    }
    this.pending.clear();
    this.buf = Buffer.alloc(0);
    this.channelSubs = null;
  }

  /* -------------------------------------------------------------- */
  /* Connect / authorize                                            */
  /* -------------------------------------------------------------- */

  /** interactive: allowed to show Discord's "Authorize" prompt. */
  async connect({ interactive = false } = {}) {
    if (!this.state.configured) {
      this.setStatus('setup');
      return this.publicState();
    }
    if (this.connecting) return this.connecting;
    this.connecting = this._connect(interactive).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async _connect(interactive) {
    this.close();
    this.setStatus('connecting');
    let sock;
    try {
      sock = await this.openPipe();
    } catch {
      this.setStatus('offline', 'Discord isn’t running.');
      this.scheduleRetry();
      return this.publicState();
    }
    this.sock = sock;
    sock.on('data', (c) => this.onData(c));
    sock.on('close', () => {
      if (this.sock !== sock) return;
      this.sock = null;
      Object.assign(this.state, { channel: null, members: [] });
      this.setStatus('offline', 'Lost the connection to Discord.');
      this.scheduleRetry();
    });
    sock.on('error', () => {});

    const ready = new Promise((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
      setTimeout(() => reject(new Error('Discord did not answer')), 8000);
    });
    this.write(OP.HANDSHAKE, { v: 1, client_id: this.creds.clientId });
    try {
      const data = await ready;
      if (data && data.user) this.state.user = this.describeUser(data.user);
    } catch (err) {
      if (this.state.status === 'connecting') this.setStatus('error', err.message);
      return this.publicState();
    }

    try {
      await this.authenticate(interactive);
    } catch (err) {
      if (err.needsAuth) this.setStatus('needs-auth', err.message);
      else this.setStatus('error', err.message);
      return this.publicState();
    }

    this.setStatus('ready');
    await this.afterAuth();
    return this.publicState();
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (!this.state.configured || !this.creds.access) return;
    this.retryTimer = setTimeout(() => this.connect({ interactive: false }), 15000);
  }

  async authenticate(interactive) {
    let token = this.open(this.creds.access);
    if (token && this.creds.expires && Date.now() > this.creds.expires - 60000) token = await this.refreshToken();
    if (token) {
      try {
        await this.request('AUTHENTICATE', { access_token: token });
        return;
      } catch {
        token = await this.refreshToken();
        if (token) {
          try {
            await this.request('AUTHENTICATE', { access_token: token });
            return;
          } catch {}
        }
      }
    }
    if (!interactive) throw Object.assign(new Error('Connect the launcher to Discord in Settings.'), { needsAuth: true });

    this.setStatus('authorizing');
    let code;
    try {
      const res = await this.request('AUTHORIZE', { client_id: this.creds.clientId, scopes: SCOPES }, { timeout: 120000 });
      code = res && res.code;
    } catch (err) {
      throw Object.assign(new Error(/cancel|denied|closed/i.test(err.message) ? 'The request was declined in Discord.' : err.message), { needsAuth: true });
    }
    if (!code) throw Object.assign(new Error('Discord did not return an authorization code.'), { needsAuth: true });
    token = await this.exchange({ grant_type: 'authorization_code', code });
    await this.request('AUTHENTICATE', { access_token: token });
  }

  async exchange(params) {
    const secret = this.open(this.creds.secret);
    if (!secret) throw Object.assign(new Error('Enter the Client Secret in Settings.'), { needsAuth: true });
    const attempt = async (withRedirect) => {
      const body = new URLSearchParams({ client_id: this.creds.clientId, client_secret: secret, ...params });
      if (withRedirect && params.grant_type === 'authorization_code') body.set('redirect_uri', REDIRECT_URI);
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15000),
      });
      const json = await res.json().catch(() => ({}));
      return { ok: res.ok, json };
    };
    let r = await attempt(true);
    if (!r.ok && params.grant_type === 'authorization_code' && /redirect/i.test(JSON.stringify(r.json))) r = await attempt(false);
    if (!r.ok) {
      const msg = r.json.error_description || r.json.error || 'Discord refused the token request';
      throw Object.assign(new Error(/client/i.test(msg) ? 'Discord rejected the Client Secret. Check it in Settings.' : msg), { needsAuth: true });
    }
    this.creds.access = this.seal(r.json.access_token);
    if (r.json.refresh_token) this.creds.refresh = this.seal(r.json.refresh_token);
    this.creds.expires = Date.now() + (r.json.expires_in || 604800) * 1000;
    this.saveCreds();
    this.state.authorized = true;
    return r.json.access_token;
  }

  async refreshToken() {
    const refresh = this.open(this.creds.refresh);
    if (!refresh) return null;
    try {
      return await this.exchange({ grant_type: 'refresh_token', refresh_token: refresh });
    } catch {
      return null;
    }
  }

  disconnect() {
    clearTimeout(this.retryTimer);
    this.close();
    Object.assign(this.state, { channel: null, members: [], voice: null });
    this.setStatus('idle');
    return this.publicState();
  }

  /* -------------------------------------------------------------- */
  /* Voice state                                                    */
  /* -------------------------------------------------------------- */

  async afterAuth() {
    for (const evt of ['VOICE_SETTINGS_UPDATE', 'VOICE_CHANNEL_SELECT', 'VOICE_CONNECTION_STATUS']) {
      this.request('SUBSCRIBE', {}, { evt }).catch(() => {});
    }
    try {
      this.applyVoiceSettings(await this.request('GET_VOICE_SETTINGS'));
    } catch {}
    await this.loadChannel();
  }

  applyVoiceSettings(v) {
    if (!v) return;
    this.state.voice = {
      mute: !!v.mute,
      deaf: !!v.deaf,
      input: v.input ? Math.round(v.input.volume) : 100,
      output: v.output ? Math.round(v.output.volume) : 100,
    };
    this.push();
  }

  async loadChannel() {
    let ch = null;
    try {
      ch = await this.request('GET_SELECTED_VOICE_CHANNEL');
    } catch {}
    await this.switchChannelSubs(ch ? ch.id : null);
    if (!ch) {
      Object.assign(this.state, { channel: null, members: [] });
      this.push();
      return;
    }
    let guild = null;
    if (ch.guild_id) {
      try {
        const g = await this.request('GET_GUILD', { guild_id: ch.guild_id, timeout: 5 });
        guild = g && g.name;
      } catch {}
    }
    this.state.channel = { id: ch.id, name: ch.name || 'Voice channel', guild, dm: !ch.guild_id };
    this.state.members = (ch.voice_states || []).map((vs) => this.describeMember(vs));
    this.push();
  }

  async switchChannelSubs(channelId) {
    const evts = ['VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE', 'SPEAKING_START', 'SPEAKING_STOP'];
    if (this.channelSubs && this.channelSubs !== channelId) {
      const old = this.channelSubs;
      for (const evt of evts) this.request('UNSUBSCRIBE', { channel_id: old }, { evt }).catch(() => {});
    }
    if (channelId && this.channelSubs !== channelId) {
      for (const evt of evts) this.request('SUBSCRIBE', { channel_id: channelId }, { evt }).catch(() => {});
    }
    this.channelSubs = channelId;
  }

  describeUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      name: u.global_name || u.username,
      avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=96` : null,
    };
  }

  describeMember(vs) {
    const u = this.describeUser(vs.user) || { id: '?', name: 'Unknown', avatar: null };
    const s = vs.voice_state || {};
    const prev = this.state.members.find((m) => m.id === u.id);
    return {
      ...u,
      name: vs.nick || u.name,
      mute: !!(s.self_mute || s.mute || vs.mute),
      deaf: !!(s.self_deaf || s.deaf),
      volume: vs.volume != null ? Math.round(vs.volume) : 100,
      speaking: prev ? prev.speaking : false,
      self: !!(this.state.user && this.state.user.id === u.id),
    };
  }

  onEvent(evt, data) {
    switch (evt) {
      case 'READY':
        if (this.readyWaiter) this.readyWaiter.resolve(data);
        this.readyWaiter = null;
        break;
      case 'ERROR':
        if (this.readyWaiter) this.readyWaiter.reject(new Error(data.message || 'Discord error'));
        this.readyWaiter = null;
        break;
      case 'VOICE_SETTINGS_UPDATE':
        this.applyVoiceSettings(data);
        break;
      case 'VOICE_CHANNEL_SELECT':
        this.loadChannel();
        break;
      case 'VOICE_STATE_CREATE':
      case 'VOICE_STATE_UPDATE': {
        const m = this.describeMember(data);
        const i = this.state.members.findIndex((x) => x.id === m.id);
        if (i >= 0) this.state.members[i] = m;
        else this.state.members.push(m);
        this.push();
        break;
      }
      case 'VOICE_STATE_DELETE': {
        const id = data.user && data.user.id;
        this.state.members = this.state.members.filter((x) => x.id !== id);
        if (this.state.user && id === this.state.user.id) this.state.channel = null;
        this.push();
        break;
      }
      case 'SPEAKING_START':
      case 'SPEAKING_STOP': {
        const m = this.state.members.find((x) => x.id === data.user_id);
        if (m) {
          m.speaking = evt === 'SPEAKING_START';
          this.push();
        }
        break;
      }
    }
  }

  /* -------------------------------------------------------------- */
  /* Commands                                                       */
  /* -------------------------------------------------------------- */

  async command(name, value, extra) {
    if (this.state.status !== 'ready') throw new Error('Not connected to Discord');
    switch (name) {
      case 'mute':
        return this.applyVoiceSettings(await this.request('SET_VOICE_SETTINGS', { mute: !!value }));
      case 'deaf':
        return this.applyVoiceSettings(await this.request('SET_VOICE_SETTINGS', { deaf: !!value }));
      case 'input':
        return this.applyVoiceSettings(await this.request('SET_VOICE_SETTINGS', { input: { volume: Math.max(0, Math.min(100, Number(value))) } }));
      case 'output':
        return this.applyVoiceSettings(await this.request('SET_VOICE_SETTINGS', { output: { volume: Math.max(0, Math.min(200, Number(value))) } }));
      case 'leave':
        await this.request('SELECT_VOICE_CHANNEL', { channel_id: null, force: true });
        Object.assign(this.state, { channel: null, members: [] });
        await this.switchChannelSubs(null);
        this.push();
        return true;
      case 'userVolume': {
        const res = await this.request('SET_USER_VOICE_SETTINGS', { user_id: String(extra), volume: Math.max(0, Math.min(200, Number(value))) });
        const m = this.state.members.find((x) => x.id === String(extra));
        if (m && res) m.volume = Math.round(res.volume != null ? res.volume : value);
        this.push();
        return true;
      }
      case 'userMute': {
        await this.request('SET_USER_VOICE_SETTINGS', { user_id: String(extra), mute: !!value });
        return true;
      }
    }
    throw new Error(`Unknown command ${name}`);
  }

  /** Called once at startup: reconnect silently if we were authorized before. */
  start() {
    if (this.state.configured && this.creds.access) setTimeout(() => this.connect({ interactive: false }), 2500);
  }
}

module.exports = { DiscordBridge, REDIRECT_URI };
