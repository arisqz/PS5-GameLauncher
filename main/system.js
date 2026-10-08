// Bridge to native/syshelper.exe: media sessions, system volume, playback
// devices, monitor brightness and more. The helper is a long-running child process that speaks one JSON
// object per line over stdin/stdout.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');

const NATIVE_DIR = path.join(__dirname, 'native').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const EXE = path.join(NATIVE_DIR, 'syshelper.exe');

class SystemBridge extends EventEmitter {
  constructor() {
    super();
    this.forward = false;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.failures = 0;
    this.art = { key: null, app: null, data: null };
    this.queues = new Map(); // coalesced setters: name -> { busy, next }
  }

  available() {
    return process.platform === 'win32' && fs.existsSync(EXE);
  }

  start() {
    if (this.proc || !this.available()) return;
    // detached: keep the helper out of Node's kill-on-close job, so if the
    // launcher ever dies it still gets to resume a paused game before exiting
    // (it exits by itself as soon as its stdin closes).
    const proc = spawn(EXE, [], { windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc = proc;
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.event) {
        // Unsolicited events, e.g. { event: 'guide' } or { event: 'pad', action: 'down' }
        this.emit(msg.event, msg);
        return;
      }
      if (msg.id == null) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error || 'helper error'));
    });
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('helper exited'));
      }
      this.pending.clear();
      this.failures++;
    });
    proc.on('error', () => {});
    if (this.forward) setTimeout(() => this.setPadForward(true), 300);
  }

  request(cmd, args = {}, timeout = 8000) {
    if (!this.available()) return Promise.reject(new Error('System helper is not available'));
    if (!this.proc) {
      if (this.failures > 5) return Promise.reject(new Error('System helper keeps crashing'));
      this.start();
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        // id last: an argument must never overwrite the request id.
        this.proc.stdin.write(`${JSON.stringify({ ...args, id, cmd })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Run setters one at a time and only send the newest value (sliders fire a lot). */
  coalesce(name, value, run) {
    let q = this.queues.get(name);
    if (!q) {
      q = { busy: false, next: undefined, waiters: [] };
      this.queues.set(name, q);
    }
    q.next = value;
    return new Promise((resolve) => {
      q.waiters.push(resolve);
      const pump = async () => {
        if (q.busy || q.next === undefined) return;
        q.busy = true;
        const v = q.next;
        q.next = undefined;
        let result;
        try {
          result = await run(v);
        } catch {
          result = null;
        }
        q.busy = false;
        if (q.next !== undefined) pump();
        else {
          const ws = q.waiters.splice(0);
          ws.forEach((w) => w(result));
        }
      };
      pump();
    });
  }

  /* -------------------------------------------------------------- */

  async media(app, knownKey) {
    const state = await this.request('media', { app: app || '' });
    if (!state || !state.active) return state || { active: false, sessions: [] };
    const artKey = `${state.app}|${state.key}`;
    if (this.art.key !== artKey) {
      try {
        const withArt = await this.request('media', { app: state.app, art: true });
        this.art = { key: artKey, data: withArt.art || null };
      } catch {
        this.art = { key: artKey, data: null };
      }
    }
    state.artKey = this.art.data ? artKey : null;
    if (knownKey !== artKey && this.art.data) state.art = this.art.data;
    return state;
  }

  mediaCommand(app, action, value) {
    return this.request('mediaCmd', { app: app || '', action, value: value || 0 });
  }

  volume() {
    return this.request('volume');
  }

  setVolume(v) {
    return this.coalesce('volume', v, (x) => this.request('setVolume', { value: Math.round(x) }));
  }

  setMute(m) {
    return this.request('setMute', { value: !!m });
  }

  audioOutputs() {
    return this.request('audioOutputs', {}, 8000);
  }

  setAudioOutput(id) {
    return this.request('setAudioOutput', { device: String(id || '') }, 8000);
  }

  brightness() {
    return this.request('brightness', {}, 15000);
  }

  setBrightness(v, index = -1) {
    return this.coalesce(`brightness:${index}`, v, (x) => this.request('setBrightness', { value: Math.round(x), index }, 15000));
  }

  nightLight() {
    return this.request('nightLight');
  }

  setNightLight(on) {
    return this.request('setNightLight', { value: !!on });
  }

  bluetooth() {
    return this.request('bt', {}, 20000);
  }

  bluetoothRadio(on) {
    return this.request('btRadio', { value: !!on }, 20000);
  }

  bluetoothConnect(address, connect) {
    return this.request(connect ? 'btConnect' : 'btDisconnect', { address }, 15000);
  }

  bluetoothPair(id) {
    return this.request('btPair', { device: id }, 70000);
  }

  bluetoothUnpair(id) {
    return this.request('btUnpair', { device: id }, 35000);
  }

  bluetoothScan(action) {
    const cmd = { start: 'btScanStart', stop: 'btScanStop' }[action] || 'btScan';
    return this.request(cmd, {}, 10000);
  }

  setPadForward(on) {
    this.forward = !!on;
    return this.request('padForward', { value: this.forward }).catch(() => {});
  }

  foreground() {
    return this.request('fgGet', {}, 3000).catch(() => null);
  }

  focusWindow(hwnd) {
    if (!hwnd) return Promise.resolve(false);
    return this.request('fgSet', { hwnd: Number(hwnd) }, 3000).catch(() => false);
  }

  stop() {
    if (this.proc) {
      // Closing stdin makes the helper resume any paused game and exit by itself.
      const proc = this.proc;
      this.proc = null;
      try {
        proc.stdin.end();
      } catch {}
      setTimeout(() => {
        try {
          proc.kill();
        } catch {}
      }, 3000).unref();
    }
  }
}

module.exports = { SystemBridge };
