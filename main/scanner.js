const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { shell } = require('electron');
const { parseVdf, getCI } = require('./vdf');

const SHORTCUT_EXT = new Set(['.lnk', '.url', '.exe', '.bat', '.cmd']);
const EXE_SKIP = /(unins|uninstall|setup|install|crash|report|redist|vcredist|vc_redist|dxsetup|dotnet|directx|helper|updater|update|patcher|prereq|easyanticheat|eac_|be_service|battleye|cefprocess|webhelper|notification|overlay|benchmark|config|settings|server|editor|console|dump|7z|python|java|unity ?crash)/i;

const STEAM_EXCLUDED_IDS = new Set([
  '228980', '1070560', '1391110', '1628350', '1493710', '2180100', '961940', '1161040',
  '1826330', '2348590', '2805730', '858280', '250820', '1054830', '1113280', '1245040',
  '1420170', '1580130', '1887720', '2230260', '3658110',
]);
const STEAM_EXCLUDED_NAMES = /^(steamworks common redistributables|steam linux runtime.*|proton.*|steamvr.*|steam audio.*|spacewar|.*dedicated server.*|.*\bsdk\b.*|.*soundtrack.*)$/i;

function hashId(prefix, s) {
  return prefix + '-' + crypto.createHash('sha1').update(String(s).toLowerCase()).digest('hex').slice(0, 12);
}

function tidyName(name) {
  return String(name || '')
    .replace(/[™®©]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameFromFile(file) {
  let n = path.basename(file, path.extname(file));
  n = n.replace(/\s*-\s*(shortcut|verknüpfung|raccourci|acceso directo|collegamento|atalho)$/i, '');
  n = n.replace(/_+/g, ' ');
  return tidyName(n);
}

function steamIdFromString(s) {
  if (!s) return null;
  let m = s.match(/steam:\/\/(?:rungameid|run|launch)\/(\d+)/i);
  if (m) return m[1];
  m = s.match(/-applaunch\s+(\d+)/i);
  if (m) return m[1];
  return null;
}

function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const m = stdout.match(/REG_\w+\s+(.+)\s*$/m);
      resolve(m ? m[1].trim() : null);
    });
  });
}

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Shortcut folders                                                    */
/* ------------------------------------------------------------------ */

async function describeFile(file, extra = {}) {
  const ext = path.extname(file).toLowerCase();
  const name = nameFromFile(file);
  const base = { name, path: file, source: 'folder', ...extra };

  if (ext === '.url') {
    const text = (await readText(file)) || '';
    const m = text.match(/^\s*URL\s*=\s*(.+)$/im);
    if (!m) return null;
    const url = m[1].trim();
    const steamAppId = steamIdFromString(url);
    return {
      ...base,
      id: hashId('lnk', file),
      steamAppId,
      launch: { type: 'uri', target: steamAppId ? `steam://rungameid/${steamAppId}` : url },
    };
  }

  if (ext === '.lnk') {
    let link = null;
    try {
      link = shell.readShortcutLink(file);
    } catch {
      link = null;
    }
    const target = (link && link.target) || '';
    const args = (link && link.args) || '';
    const steamAppId = steamIdFromString(args) || steamIdFromString(target);
    if (steamAppId) {
      return { ...base, id: hashId('lnk', file), steamAppId, launch: { type: 'uri', target: `steam://rungameid/${steamAppId}` } };
    }
    if (target && /\.exe$/i.test(target) && fs.existsSync(target)) {
      return {
        ...base,
        id: hashId('lnk', file),
        exe: target,
        launch: { type: 'exe', target, args, cwd: (link && link.cwd) || path.dirname(target) },
      };
    }
    // Store apps, advertised shortcuts etc. — let the shell handle it.
    return { ...base, id: hashId('lnk', file), exe: target || null, launch: { type: 'shell', target: file } };
  }

  if (ext === '.exe') {
    return {
      ...base,
      id: hashId('exe', file),
      exe: file,
      launch: { type: 'exe', target: file, args: '', cwd: path.dirname(file) },
    };
  }

  if (ext === '.bat' || ext === '.cmd') {
    return { ...base, id: hashId('lnk', file), launch: { type: 'shell', target: file } };
  }
  return null;
}

function similarity(a, b) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8;
  const grams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const gx = grams(x);
  const gy = grams(y);
  let hit = 0;
  for (const [g, n] of gx) hit += Math.min(n, gy.get(g) || 0);
  return (2 * hit) / (x.length + y.length - 2 || 1);
}

/** Find the most plausible game executable inside an install directory. */
async function findBestExe(dir, folderName, depth = 0, budget = { n: 0 }) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  for (const e of entries) {
    if (++budget.n > 4000) break;
    const full = path.join(dir, e.name);
    if (e.isFile() && /\.exe$/i.test(e.name) && !EXE_SKIP.test(e.name)) {
      let size = 0;
      try {
        size = (await fsp.stat(full)).size;
      } catch {}
      const score = similarity(path.basename(e.name, '.exe'), folderName) * 3 + Math.min(size / 50e6, 1) - depth * 0.5;
      if (!best || score > best.score) best = { file: full, score };
    } else if (e.isDirectory() && depth < 2 && !/^(redist|_commonredist|directx|support|tools|docs?|engine|__installer|crashreport)/i.test(e.name)) {
      const sub = await findBestExe(full, folderName, depth + 1, budget);
      if (sub && (!best || sub.score > best.score)) best = sub;
    }
  }
  return best;
}

/**
 * Scan a folder for game shortcuts (.lnk/.url/.exe/.bat). Sub-folders that
 * contain shortcuts are scanned too; sub-folders without shortcuts are treated
 * as game install folders and the best executable inside is picked.
 */
async function scanFolder(folder) {
  const games = [];
  let entries;
  try {
    entries = await fsp.readdir(folder, { withFileTypes: true });
  } catch {
    return games;
  }

  for (const e of entries) {
    const full = path.join(folder, e.name);
    if (e.isFile() && SHORTCUT_EXT.has(path.extname(e.name).toLowerCase())) {
      if (path.extname(e.name).toLowerCase() === '.exe' && EXE_SKIP.test(e.name)) continue;
      const g = await describeFile(full, { folder });
      if (g) games.push(g);
    }
  }

  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('$')) continue;
    const full = path.join(folder, e.name);
    let sub;
    try {
      sub = await fsp.readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    const shortcuts = sub.filter((s) => s.isFile() && /\.(lnk|url)$/i.test(s.name));
    if (shortcuts.length) {
      for (const s of shortcuts) {
        const g = await describeFile(path.join(full, s.name), { folder });
        if (g) games.push(g);
      }
      continue;
    }
    const best = await findBestExe(full, e.name);
    if (best) {
      games.push({
        id: hashId('dir', full),
        name: tidyName(e.name),
        path: full,
        folder,
        source: 'folder',
        exe: best.file,
        installDir: full,
        launch: { type: 'exe', target: best.file, args: '', cwd: path.dirname(best.file) },
      });
    }
  }
  return games;
}

/* ------------------------------------------------------------------ */
/* Steam                                                               */
/* ------------------------------------------------------------------ */

async function findSteamPath() {
  const reg = await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  const candidates = [reg, 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'].filter(Boolean);
  for (const c of candidates) {
    const p = path.normalize(c);
    if (fs.existsSync(path.join(p, 'steamapps'))) return p;
  }
  return null;
}

async function readSteamUser(steamPath) {
  const out = { accountId: null, persona: null, playtime: {} };
  const lu = await readText(path.join(steamPath, 'config', 'loginusers.vdf'));
  if (lu) {
    try {
      const users = getCI(parseVdf(lu), 'users') || {};
      let pick = null;
      for (const [id64, u] of Object.entries(users)) {
        if (!pick || getCI(u, 'MostRecent') === '1') pick = { id64, u };
      }
      if (pick) {
        out.accountId = (BigInt(pick.id64) - 76561197960265728n).toString();
        out.persona = getCI(pick.u, 'PersonaName') || null;
      }
    } catch {}
  }

  let file = out.accountId ? path.join(steamPath, 'userdata', out.accountId, 'config', 'localconfig.vdf') : null;
  if (!file || !fs.existsSync(file)) {
    // Fall back to the most recently written localconfig.
    try {
      const dirs = await fsp.readdir(path.join(steamPath, 'userdata'));
      let newest = 0;
      for (const d of dirs) {
        const f = path.join(steamPath, 'userdata', d, 'config', 'localconfig.vdf');
        try {
          const st = await fsp.stat(f);
          if (st.mtimeMs > newest) {
            newest = st.mtimeMs;
            file = f;
          }
        } catch {}
      }
    } catch {}
  }
  if (file) {
    const text = await readText(file);
    if (text) {
      try {
        const apps = getCI(parseVdf(text), 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps') || {};
        for (const [appid, a] of Object.entries(apps)) {
          if (!a || typeof a !== 'object') continue;
          const minutes = Number(getCI(a, 'Playtime') || 0);
          const last = Number(getCI(a, 'LastPlayed') || 0) * 1000;
          if (minutes || last) out.playtime[appid] = { minutes, lastPlayed: last };
        }
      } catch {}
    }
  }
  return out;
}

async function scanSteam() {
  const steamPath = await findSteamPath();
  if (!steamPath) return { found: false, games: [] };

  const libs = new Set([steamPath]);
  const lf = await readText(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'));
  if (lf) {
    try {
      const root = getCI(parseVdf(lf), 'libraryfolders') || {};
      for (const v of Object.values(root)) {
        if (v && typeof v === 'object' && getCI(v, 'path')) libs.add(path.normalize(getCI(v, 'path')));
        else if (typeof v === 'string' && /[\\/]/.test(v)) libs.add(path.normalize(v));
      }
    } catch {}
  }

  const user = await readSteamUser(steamPath);
  const games = [];
  const seen = new Set();
  for (const lib of libs) {
    const dir = path.join(lib, 'steamapps');
    let files;
    try {
      files = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^appmanifest_\d+\.acf$/i.test(f)) continue;
      const text = await readText(path.join(dir, f));
      if (!text) continue;
      let st;
      try {
        st = getCI(parseVdf(text), 'AppState');
      } catch {
        continue;
      }
      if (!st) continue;
      const appid = String(getCI(st, 'appid') || '');
      const name = tidyName(getCI(st, 'name') || '');
      if (!appid || !name || seen.has(appid)) continue;
      if (STEAM_EXCLUDED_IDS.has(appid) || STEAM_EXCLUDED_NAMES.test(name)) continue;
      seen.add(appid);
      const pt = user.playtime[appid] || {};
      games.push({
        id: `steam-${appid}`,
        name,
        source: 'steam',
        steamAppId: appid,
        installDir: path.join(dir, 'common', getCI(st, 'installdir') || ''),
        sizeOnDisk: Number(getCI(st, 'SizeOnDisk') || 0),
        launch: { type: 'steam', appid, steamExe: path.join(steamPath, 'steam.exe'), target: `steam://rungameid/${appid}` },
        steamPlaytime: pt.minutes || 0,
        steamLastPlayed: pt.lastPlayed || Number(getCI(st, 'LastPlayed') || 0) * 1000 || 0,
      });
    }
  }
  return { found: true, steamPath, persona: user.persona, games, playtime: user.playtime };
}

/* ------------------------------------------------------------------ */
/* Epic Games                                                          */
/* ------------------------------------------------------------------ */

async function scanEpic() {
  let dir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
  const reg = await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher', 'AppDataPath');
  if (reg && fs.existsSync(path.join(reg, 'Manifests'))) dir = path.join(reg, 'Manifests');

  let files;
  try {
    files = await fsp.readdir(dir);
  } catch {
    return { found: false, games: [] };
  }
  const games = [];
  for (const f of files) {
    if (!/\.item$/i.test(f)) continue;
    const text = await readText(path.join(dir, f));
    if (!text) continue;
    let j;
    try {
      j = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      continue;
    }
    const cats = j.AppCategories || [];
    if (!cats.includes('games')) continue;
    if (j.bIsIncompleteInstall) continue;
    if (j.MainGameAppName && j.MainGameAppName !== j.AppName) continue; // DLC
    if (!j.InstallLocation || !fs.existsSync(j.InstallLocation)) continue;
    const uri = `com.epicgames.launcher://apps/${encodeURIComponent(j.CatalogNamespace)}%3A${encodeURIComponent(j.CatalogItemId)}%3A${encodeURIComponent(j.AppName)}?action=launch&silent=true`;
    const exe = j.LaunchExecutable ? path.join(j.InstallLocation, j.LaunchExecutable) : null;
    games.push({
      id: `epic-${j.AppName}`,
      name: tidyName(j.DisplayName),
      source: 'epic',
      installDir: j.InstallLocation,
      exe,
      launch: { type: 'uri', target: uri },
      // Started without the Epic launcher, the game gets the arguments Epic
      // would pass, minus the sign-in. Fine for games that run offline.
      direct: exe
        ? { target: exe, args: `${(j.LaunchCommand || '').trim()} -epicapp=${j.AppName} -epicenv=Prod -EpicPortal`.trim(), cwd: path.dirname(exe) }
        : null,
      directSafe: !!j.bCanRunOffline && String(j.OwnershipToken) !== 'true',
    });
  }
  return { found: true, games };
}

/* ------------------------------------------------------------------ */
/* Ubisoft Connect                                                     */
/* ------------------------------------------------------------------ */

function regLines(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

/** reg query /s output -> { 'HKEY_...\\Key': { Value: data } } */
function parseReg(text) {
  const out = {};
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) out[(cur = line.trim())] = {};
    else if (cur) {
      const m = line.match(/^\s+(.+?)\s+REG_\w+\s+(.*)$/);
      if (m) out[cur][m[1]] = m[2].trim();
    }
  }
  return out;
}

async function scanUbisoft() {
  const installs = {};
  for (const root of ['HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs', 'HKLM\\SOFTWARE\\Ubisoft\\Launcher\\Installs']) {
    for (const [key, vals] of Object.entries(parseReg(await regLines(['query', root, '/s'])))) {
      const id = key.split('\\').pop();
      if (/^\d+$/.test(id) && vals.InstallDir && !installs[id]) installs[id] = path.normalize(vals.InstallDir);
    }
  }
  const ids = Object.keys(installs);
  if (!ids.length) {
    const client = await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher', 'InstallDir');
    return { found: !!client, games: [] };
  }
  // Display names live in the uninstall entries ("Uplay Install <id>").
  const names = {};
  const un = parseReg(await regLines(['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'Uplay Install', '/k']));
  for (const key of Object.keys(un)) {
    const id = (key.match(/Uplay Install (\d+)$/) || [])[1];
    if (!id) continue;
    const vals = parseReg(await regLines(['query', key, '/v', 'DisplayName']))[key] || {};
    if (vals.DisplayName) names[id] = vals.DisplayName;
  }
  const games = [];
  for (const id of ids) {
    const dir = installs[id].replace(/[\\/]+$/, '');
    if (!fs.existsSync(dir)) continue;
    const name = tidyName(names[id] || path.basename(dir));
    const best = await findBestExe(dir, name.replace(/^tom clancy'?s\s+/i, ''));
    games.push({
      id: `ubisoft-${id}`,
      name,
      source: 'ubisoft',
      installDir: dir,
      exe: best ? best.file : null,
      launch: { type: 'uri', target: `uplay://launch/${id}/0` },
      direct: best ? { target: best.file, args: '', cwd: path.dirname(best.file) } : null,
      directSafe: false, // Ubisoft games always need Ubisoft Connect running
    });
  }
  return { found: true, games };
}

/* ------------------------------------------------------------------ */
/* Xbox / Microsoft Store (PC Game Pass)                               */
/* ------------------------------------------------------------------ */

// Installed packages that ship a MicrosoftGame.config are games. The package
// folder under WindowsApps is usually a junction into <drive>:\\XboxGames.
const XBOX_PS = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out = @()
foreach ($p in Get-AppxPackage) {
  $loc = $p.InstallLocation
  if (-not $loc) { continue }
  $cfg = Join-Path $loc 'MicrosoftGame.config'
  if (-not (Test-Path -LiteralPath $cfg)) { continue }
  $m = Get-AppxPackageManifest $p
  $apps = @($m.Package.Applications.Application | ForEach-Object { $_.Id })
  $real = (Get-Item -LiteralPath $loc).Target
  if ($real -is [array]) { $real = $real[0] }
  $out += [pscustomobject]@{ family = $p.PackageFamilyName; pkg = $p.Name; apps = $apps; loc = $loc; real = $real; config = [IO.File]::ReadAllText($cfg) }
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
`;

function powershell(script, timeout = 30000) {
  return new Promise((resolve) => {
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, timeout, maxBuffer: 32 << 20 }, (err, stdout) =>
      resolve(err && !stdout ? '' : String(stdout || ''))
    );
  });
}

const xmlAttr = (xml, tag, attr) => {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`, 'i'));
  return m ? m[1] : null;
};

async function scanXbox() {
  let list = [];
  try {
    list = JSON.parse((await powershell(XBOX_PS)).trim() || '[]');
  } catch {
    return { found: false, games: [] };
  }
  if (!Array.isArray(list)) list = [list];
  const games = [];
  for (const it of list) {
    if (!it || !it.family || !it.config) continue;
    const xml = String(it.config);
    const exes = [...xml.matchAll(/<Executable\b([^>]*)\/?>/gi)].map((m) => ({
      name: (m[1].match(/\bName="([^"]+)"/i) || [])[1],
      id: (m[1].match(/\bId="([^"]+)"/i) || [])[1],
    }));
    const apps = Array.isArray(it.apps) ? it.apps : [it.apps].filter(Boolean);
    const exe = exes.find((e) => apps.includes(e.id)) || exes[0] || {};
    const appId = exe.id && apps.includes(exe.id) ? exe.id : apps[0];
    if (!appId) continue;
    let name = xmlAttr(xml, 'ShellVisuals', 'DefaultDisplayName');
    if (!name || /^ms-resource:/i.test(name)) name = String(it.pkg || '').split('.').pop().replace(/([a-z])([A-Z])/g, '$1 $2');
    const dir = path.resolve(it.real && fs.existsSync(it.real) ? it.real : it.loc);
    games.push({
      id: `xbox-${String(it.pkg || it.family).toLowerCase()}`,
      name: tidyName(name),
      source: 'xbox',
      installDir: dir,
      // Package processes can report either path.
      altDirs: it.loc && path.resolve(it.loc) !== dir ? [path.resolve(it.loc)] : [],
      exe: exe.name ? path.join(dir, exe.name) : null,
      storeId: (xml.match(/<StoreId>([^<]+)<\/StoreId>/i) || [])[1] || null,
      // Packaged games are started by Windows itself: no Xbox app involved.
      launch: { type: 'aumid', target: `${it.family}!${appId}` },
    });
  }
  return { found: true, games };
}

module.exports = { scanFolder, scanSteam, scanEpic, scanUbisoft, scanXbox, findBestExe, describeFile, readSteamUser, findSteamPath, tidyName, hashId, similarity, EXE_SKIP };
