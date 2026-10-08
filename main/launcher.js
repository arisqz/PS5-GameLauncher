const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { shell } = require('electron');

/** Split a Windows-style argument string, honouring double quotes. */
function splitArgs(str) {
  const out = [];
  let cur = '';
  let quoted = false;
  let had = false;
  for (const ch of String(str || '')) {
    if (ch === '"') {
      quoted = !quoted;
      had = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (cur || had) out.push(cur);
      cur = '';
      had = false;
    } else cur += ch;
  }
  if (cur || had) out.push(cur);
  return out;
}

const running = new Map(); // gameId -> { pid, start }

/**
 * Launch a game. Resolves with { tracked } once the process has started.
 * `onExit(minutes, shortLived)` fires for tracked processes.
 */
/**
 * How a game starts:
 *  - 'direct': its own .exe, no store client involved (Xbox games are always
 *    started directly by Windows);
 *  - 'store': through its store client, kept hidden where the store allows it
 *    (Steam starts silently in the tray, Epic with silent=true).
 * game.launchMode is the per-game choice ('auto' | 'direct' | 'store').
 * 'auto' goes direct for games that are known to run without their store
 * when "Start Games Directly" is on.
 */
function launchMode(game, { preferDirect = false } = {}) {
  const want = game.launchMode || 'auto';
  const canDirect = !!(game.direct && game.direct.target) || (game.source === 'steam' && !!game.installDir);
  if (want === 'direct' && canDirect) return 'direct';
  if (want === 'store') return 'store';
  if (preferDirect && game.directSafe && canDirect) return 'direct';
  return 'store';
}

/** The game's own executable for a direct start (found and remembered on first use for Steam). */
async function directTarget(game) {
  if (game.direct && game.direct.target && fs.existsSync(game.direct.target)) return game.direct;
  if (game.installDir && fs.existsSync(game.installDir)) {
    const { findBestExe } = require('./scanner');
    const best = await findBestExe(game.installDir, game.name);
    if (best) {
      game.direct = { target: best.file, args: '', cwd: path.dirname(best.file) };
      return game.direct;
    }
  }
  throw new Error("Couldn't find the game's executable. Choose Launch Method › Through the Store instead.");
}

async function launchGame(game, onExit, { system, preferDirect = false } = {}) {
  const mode = launchMode(game, { preferDirect });
  if (mode === 'direct' && game.launch && game.launch.type !== 'exe' && game.launch.type !== 'aumid') {
    const d = await directTarget(game);
    const extra = game.launchArgs ? ` ${game.launchArgs}` : '';
    return launchGame({ ...game, launchMode: 'store', launch: { type: 'exe', target: d.target, args: `${d.args || ''}${extra}`.trim(), cwd: d.cwd } }, onExit, { system });
  }
  const l = game.launch || {};
  // Xbox / Microsoft Store games: Windows starts the package by its app id.
  if (l.type === 'aumid') {
    const target = `shell:AppsFolder\\${l.target}`;
    if (system && system.available()) {
      await system.request('launch', { file: 'explorer.exe', args: target, cwd: process.env.SystemRoot || 'C:\\Windows' }, 30000);
    } else await shell.openExternal(target);
    return { tracked: false };
  }
  // Steam: steam.exe -silent -applaunch starts the game without ever showing
  // the Steam window (Steam itself stays in the tray, which games need).
  if (l.type === 'steam') {
    if (l.steamExe && fs.existsSync(l.steamExe) && system && system.available()) {
      const args = `-silent -applaunch ${l.appid}${game.launchArgs ? ` ${game.launchArgs}` : ''}`;
      await system.request('launch', { file: l.steamExe, args, cwd: path.dirname(l.steamExe) }, 30000);
    } else await shell.openExternal(l.target);
    return { tracked: false };
  }
  // Prefer starting executables through the Windows shell (via the helper):
  // the game inherits nothing from the launcher and UAC prompts work normally.
  if (l.type === 'exe' && system && system.available()) {
    if (!fs.existsSync(l.target)) throw new Error(`Executable not found: ${l.target}`);
    try {
      const pid = await system.request('launch', { file: l.target, args: l.args || '', cwd: l.cwd && fs.existsSync(l.cwd) ? l.cwd : path.dirname(l.target) }, 30000);
      return { tracked: false, pid };
    } catch (err) {
      if (/cancel/i.test(err.message)) throw new Error('The launch was cancelled.');
      throw err;
    }
  }
  if (l.type === 'uri') {
    await shell.openExternal(l.target);
    return { tracked: false };
  }
  if (l.type === 'shell') {
    const err = await shell.openPath(l.target);
    if (err) throw new Error(err);
    return { tracked: false };
  }
  if (l.type === 'exe') {
    if (!fs.existsSync(l.target)) throw new Error(`Executable not found: ${l.target}`);
    return new Promise((resolve, reject) => {
      let started = false;
      let child;
      const fallback = async () => {
        const err = await shell.openPath(l.target);
        if (err) reject(new Error(err));
        else resolve({ tracked: false });
      };
      try {
        child = spawn(l.target, splitArgs(l.args), {
          cwd: l.cwd && fs.existsSync(l.cwd) ? l.cwd : path.dirname(l.target),
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
      } catch {
        fallback();
        return;
      }
      child.once('error', () => {
        if (!started) fallback(); // e.g. needs elevation — let the shell show UAC
      });
      child.once('spawn', () => {
        started = true;
        const start = Date.now();
        running.set(game.id, { pid: child.pid, start });
        child.once('exit', () => {
          running.delete(game.id);
          const ms = Date.now() - start;
          onExit && onExit(Math.round(ms / 60000), ms < 15000);
        });
        child.unref();
        resolve({ tracked: true });
      });
    });
  }
  throw new Error('This entry has no launch target.');
}

module.exports = { launchGame, launchMode, running, splitArgs };
