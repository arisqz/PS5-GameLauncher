// Detects which library game is running, however it was started (launcher,
// Steam, Epic, a desktop shortcut…). Works from the system process list:
// process names first, then the full image path of the few candidates, both
// read through the helper without opening a handle to any game process.
//
// Several library entries can share one executable (e.g. Switch games that all
// start the same emulator). A process is only ever counted for ONE game,
// chosen by: the game the launcher just started, then the window title (the
// emulator shows the game name), then the most recently played candidate.

const fsp = require('fs').promises;
const path = require('path');
const { EXE_SKIP } = require('./scanner');

const TICK_MS = 3000;
// Matched against folder names and program files only (.exe/.dll/.sys), never
// art or data files — a skin called "Vanguard" is not Riot Vanguard.
const ANTI_CHEAT = /easy.?anti.?cheat|battl.?eye|^beservice|anti.?cheat|xigncode|nprotect|gameguard|punkbuster|pnkbstr|^equ8|faceit|mhyprot|acebase|sguard|^vgk|riot.?vanguard/i;
const PROGRAM_FILE = /\.(exe|dll|sys)$/i;

function antiCheatName(e) {
  return (e.isDirectory() || PROGRAM_FILE.test(e.name)) && ANTI_CHEAT.test(e.name);
}
const SKIP_DIRS = /^(redist|_commonredist|directx|__installer|support|\.git)$/i;

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** How well a window title matches a game name (0..1). */
function titleScore(title, name) {
  const t = ` ${normalize(title)} `;
  const words = normalize(name).split(' ').filter((w) => w.length > 1 || /\d/.test(w));
  if (!words.length) return 0;
  if (t.includes(` ${words.join(' ')} `)) return 1;
  const hit = words.filter((w) => t.includes(` ${w} `)).length;
  return hit / words.length;
}

class GameMonitor {
  /**
   * @param {object} o
   * @param {import('./library').Library} o.library
   * @param {import('./system').SystemBridge} o.system
   * @param {(running: {id:string, pid:number, since:number}[]) => void} o.onChange
   * @param {(gameId: string, minutes: number) => void} o.onEnded
   */
  constructor({ library, system, onChange, onEnded }) {
    this.library = library;
    this.system = system;
    this.onChange = onChange;
    this.onEnded = onEnded;
    this.index = new Map(); // gameId -> { names:Set, dir, exe, sig, antiCheat }
    this.pidPaths = new Map(); // pid -> lower-case image path ('' if unknown)
    this.pidSeen = new Map(); // pid -> first time we saw it as a game candidate
    this.running = new Map(); // gameId -> { pid, since }
    this.launches = new Map(); // gameId -> time the launcher started it
    this.timer = null;
    this.ticking = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    setTimeout(() => this.tick(), 1500);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  list() {
    return [...this.running.entries()].map(([id, r]) => ({ id, pid: r.pid, since: r.since }));
  }

  get(id) {
    return this.running.get(id) || null;
  }

  /** The launcher is starting this game: it wins any "which game is it?" question. */
  noteLaunch(id) {
    this.launches.set(id, Date.now());
  }

  hasAntiCheat(id) {
    const e = this.index.get(id);
    return !e || e.antiCheat !== false;
  }

  /** Make the next tick come sooner (e.g. right after a launch). */
  poke(delay = 800) {
    setTimeout(() => this.tick(), delay);
  }

  /* -------------------------------------------------------------- */

  /** Exe names in a game folder (files before sub-folders) + anti-cheat check. */
  async scanDir(dir) {
    const names = new Set();
    let antiCheat = false;
    let budget = 6000;
    const queue = [{ d: dir, depth: 0 }];
    while (queue.length && budget > 0) {
      const { d, depth } = queue.shift();
      let entries;
      try {
        entries = await fsp.readdir(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (--budget < 0) break;
        if (antiCheatName(e)) antiCheat = true;
        if (e.isFile() && /\.exe$/i.test(e.name) && !EXE_SKIP.test(e.name)) names.add(e.name.slice(0, -4).toLowerCase());
        else if (e.isDirectory() && depth < 4 && !SKIP_DIRS.test(e.name)) queue.push({ d: path.join(d, e.name), depth: depth + 1 });
      }
    }
    // Anti-cheat often lives next to the binaries folder: also peek at parents.
    let p = dir;
    for (let i = 0; i < 3 && !antiCheat; i++) {
      const up = path.dirname(p);
      if (up === p) break;
      p = up;
      try {
        const entries = await fsp.readdir(p, { withFileTypes: true });
        if (entries.some(antiCheatName)) antiCheat = true;
      } catch {}
    }
    return { names, antiCheat };
  }

  async indexFor(g) {
    const exe = g.exe || (g.launch && g.launch.type === 'exe' ? g.launch.target : null);
    // Shortcut games: the exe's folder is the install folder (catches games that
    // start through a small launcher exe in the same folder).
    const dir = g.installDir || (exe ? path.dirname(exe) : null);
    const alt = (g.altDirs || []).map((d) => path.normalize(d).toLowerCase() + path.sep);
    const sig = `${exe}|${dir}|${alt.join('|')}`;
    const cached = this.index.get(g.id);
    if (cached && cached.sig === sig) return cached;
    const { names, antiCheat } = dir ? await this.scanDir(dir) : { names: new Set(), antiCheat: true };
    if (exe && /\.exe$/i.test(exe)) names.add(path.basename(exe, path.extname(exe)).toLowerCase());
    const entry = {
      names,
      dir: dir ? path.normalize(dir).toLowerCase() + path.sep : null,
      alt,
      exe: exe ? path.normalize(exe).toLowerCase() : null,
      sig,
      antiCheat,
    };
    this.index.set(g.id, entry);
    return entry;
  }

  matches(entry, imagePath) {
    if (!imagePath) return false;
    if (entry.exe && imagePath === entry.exe) return true;
    if (entry.dir && imagePath.startsWith(entry.dir)) return true;
    return (entry.alt || []).some((d) => imagePath.startsWith(d));
  }

  async pathOf(pid) {
    if (!this.pidPaths.has(pid)) {
      let p = '';
      try {
        p = String((await this.system.request('procPath', { pid }, 4000)) || '');
      } catch {}
      this.pidPaths.set(pid, p ? path.normalize(p).toLowerCase() : '');
    }
    return this.pidPaths.get(pid);
  }

  /** Pick one game for a process that several library entries could be. */
  async resolve(pid, ids) {
    if (ids.length === 1) return ids[0];
    const firstSeen = this.pidSeen.get(pid) || Date.now();
    // 1. Started from the launcher shortly before the process appeared.
    let best = null;
    for (const id of ids) {
      const t = this.launches.get(id);
      if (t && t >= firstSeen - 120000 && (!best || t > this.launches.get(best))) best = id;
    }
    if (best) return best;
    // 2. The window title names the game (emulators do this).
    let titles = [];
    try {
      titles = (await this.system.request('windowTitles', { pid }, 3000)) || [];
    } catch {}
    let top = null;
    let topScore = 0;
    for (const id of ids) {
      const g = this.library.find(id);
      if (!g) continue;
      const score = Math.max(0, ...titles.map((t) => titleScore(t, g.name)));
      if (score > topScore) {
        topScore = score;
        top = id;
      }
    }
    if (top && topScore >= 0.6) return top;
    // 3. Still ambiguous after a while: the most recently played candidate.
    if (Date.now() - firstSeen > 20000) {
      const games = ids.map((id) => this.library.find(id)).filter(Boolean);
      games.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
      return games[0] ? games[0].id : null;
    }
    return null;
  }

  async tick() {
    if (this.ticking || !this.system.available()) return;
    this.ticking = true;
    try {
      const procs = await this.system.request('procs', {}, 8000);
      const byName = new Map();
      for (const p of procs) {
        const n = String(p.name).toLowerCase();
        if (!byName.has(n)) byName.set(n, []);
        byName.get(n).push(p.pid);
      }
      const alive = new Set(procs.map((p) => p.pid));
      for (const pid of this.pidPaths.keys()) if (!alive.has(pid)) this.pidPaths.delete(pid);
      for (const pid of this.pidSeen.keys()) if (!alive.has(pid)) this.pidSeen.delete(pid);

      const found = new Map(); // gameId -> { pid, since }
      const taken = new Set(); // pids already assigned
      // Keep following games we already know (one process = one game).
      for (const [id, r] of this.running) {
        if (alive.has(r.pid) && this.library.find(id)) {
          found.set(id, r);
          taken.add(r.pid);
        }
      }

      // Collect candidate games for each new process.
      const candidates = new Map(); // pid -> [gameId]
      for (const g of this.library.games) {
        if (g.category === 'media' || found.has(g.id)) continue;
        const entry = await this.indexFor(g);
        if (!entry.names.size) continue;
        for (const name of entry.names) {
          for (const pid of byName.get(name) || []) {
            if (taken.has(pid)) continue;
            if (!this.matches(entry, await this.pathOf(pid))) continue;
            if (!this.pidSeen.has(pid)) this.pidSeen.set(pid, Date.now());
            if (!candidates.has(pid)) candidates.set(pid, []);
            if (!candidates.get(pid).includes(g.id)) candidates.get(pid).push(g.id);
          }
        }
      }
      for (const [pid, ids] of candidates) {
        const open = ids.filter((id) => !found.has(id));
        if (!open.length) continue;
        const id = await this.resolve(pid, open);
        if (!id) continue;
        found.set(id, { pid, since: this.pidSeen.get(pid) || Date.now() });
        taken.add(pid);
        this.launches.delete(id);
      }

      let changed = false;
      for (const [id, r] of this.running) {
        if (!found.has(id)) {
          changed = true;
          const minutes = Math.round((Date.now() - r.since) / 60000);
          this.onEnded(id, minutes);
        }
      }
      for (const id of found.keys()) if (!this.running.has(id)) changed = true;
      this.running = found;
      if (changed) this.onChange(this.list());
    } catch {
      // Helper not ready yet — try again next tick.
    } finally {
      this.ticking = false;
    }
  }

  /** Close a running game: ask its windows to close, then end the process. */
  async close(id) {
    const r = this.running.get(id);
    if (!r) return false;
    // A paused game can't react to the close request.
    await this.system.request('resume', { pid: r.pid }).catch(() => {});
    try {
      await this.system.request('closeWindows', { pid: r.pid });
    } catch {}
    const gone = async () => {
      try {
        const procs = await this.system.request('procs', {}, 8000);
        return !procs.some((p) => p.pid === r.pid);
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 10; i++) {
      await new Promise((res) => setTimeout(res, 500));
      if (await gone()) break;
    }
    if (!(await gone())) {
      await new Promise((res) => {
        require('child_process').execFile('taskkill', ['/PID', String(r.pid), '/T', '/F'], { windowsHide: true }, () => res());
      });
    }
    await this.tick();
    return true;
  }
}

module.exports = { GameMonitor, titleScore };
