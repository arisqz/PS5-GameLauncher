// Declarative settings tree: categories → sections → items.

import { api, state, refreshInfo, pushNotification, setSetting, isInstalled } from '../state.js';
import { fmtBytes, escapeHtml } from '../util.js';
import { confirmDialog, optionsMenu, infoDialog } from '../ui/dialogs.js';
import { update, loadUpdate, checkUpdate, downloadUpdate, installUpdate, updateStatus } from '../updates.js';
import { ytdlp, loadYtdlp } from '../thememusic.js';
import { AVATARS } from '../ui/avatar.js';
import { guideCategory } from './guide.js';
import { openSoundStore } from './soundstore.js';
import { openGallery } from './gallery.js';
import { emit, on } from '../state.js';
import { LANGUAGES } from '../i18n.js';
import { activeProfileId, pickProfileImage, updateProfile } from '../profiles.js';
import { connectedPads } from '../input.js';
import { refreshDualsense, modelName, powerLabel, batteryText, connectionLabel } from '../dualsense.js';
import { loadStorage, loadCaptureSize, storageItems } from './storage.js';
import { browseFiles, addGameFolder, addGameFiles, showFolder } from '../ui/filebrowser.js';
import { loadEmulators, emulatorItems } from './emulators.js';
import { loadEncoders, encoderItems } from './captureEncoders.js';
import {
  sys,
  setVolume,
  setMute,
  setBrightness,
  setNightLight,
  loadHdr,
  setHdr,
  hdrDisplays,
  loadBluetooth,
  setBluetooth,
  connectDevice,
  unpairDevice,
  startScan,
  stopScan,
  pairDevice,
  deviceIcon,
  deviceStatus,
  loadOutputs,
  outputLabel,
  outputIcon,
  setOutput,
} from '../system.js';
import { party, loadDiscord, discordSetup, discordConnect, discordDisconnect, discordForget, statusText } from '../discord.js';
import { steam, loadFriends, setFriendsKey, forgetFriendsKey } from '../steamfriends.js';
import { t } from '../i18n.js';

const onOff = (key, label, desc) => ({ type: 'toggle', key, label, desc });


let gpuMenuBusy = false;
async function chooseLauncherGpu(anchor) {
  if (gpuMenuBusy) return;
  gpuMenuBusy = true;
  try {
    const current = await api.getGpuPreference();
    if (!current.supported) {
      await infoDialog({ title: 'Launcher GPU', html: escapeHtml(t('GPU preference selection is available on Windows only.')) });
      return;
    }
    const choice = await optionsMenu({
      title: 'Launcher GPU',
      anchor,
      index: current.preference,
      items: ['Let Windows decide', 'Power saving', 'High performance'].map((label, id) => ({
        id, label, checked: id === current.preference,
      })),
    });
    if (!choice || choice.id === current.preference) return;
    await api.setGpuPreference(choice.id);
    await infoDialog({
      title: 'GPU preference saved',
      html: escapeHtml(t('Fully close and reopen the launcher to apply this change. Keep Hardware Acceleration enabled to use GPU rendering. This setting applies to the launcher, not your games.')),
    });
  } catch (error) {
    const msg = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    await infoDialog({ title: 'Could not change GPU preference', html: escapeHtml(t(msg)) });
  } finally {
    gpuMenuBusy = false;
  }
}

function deviceMenu(d, anchor) {
  const items = [];
  if (d.audio) {
    items.push(
      d.connected
        ? { label: 'Disconnect', icon: 'close', run: () => connectDevice(d, false) }
        : { label: 'Connect', icon: 'link', run: () => connectDevice(d, true) }
    );
  } else {
    items.push({
      label: d.connected ? 'Connected' : 'Turn the device on to connect it',
      icon: d.connected ? 'check' : 'info',
      disabled: true,
    });
  }
  items.push({
    label: 'Remove Device',
    icon: 'trash',
    danger: true,
    run: async () => {
      if (await confirmDialog({ title: t('Remove {name}?', { name: d.name }), message: 'You will need to pair it again to use it with this PC.', confirmLabel: 'Remove', danger: true })) {
        await unpairDevice(d);
      }
    },
  });
  return optionsMenu({ title: d.name, anchor, items });
}

function discordItems() {
  const st = party.state;
  const items = [{ type: 'info', label: 'Status', value: statusText(st), valueClass: st && st.status === 'ready' ? 'ok' : '' }];
  items.push(
    {
      type: 'text',
      label: 'Client ID',
      placeholder: 'From the Discord Developer Portal',
      get: () => (party.state && party.state.clientId) || '',
      set: (v) => discordSetup({ clientId: v }),
    },
    {
      type: 'text',
      label: 'Client Secret',
      secret: true,
      placeholder: 'From the Discord Developer Portal',
      get: () => (party.state && party.state.configured ? 'saved-secret' : ''),
      set: (v) => (v ? discordSetup({ secret: v }) : null),
    }
  );
  if (st && st.configured) {
    if (st.status === 'ready') items.push({ type: 'action', icon: 'close', label: 'Disconnect', run: () => discordDisconnect() });
    else if (st.status === 'connecting' || st.status === 'authorizing') items.push({ type: 'action', icon: 'party', label: 'Connecting…', disabled: true });
    else items.push({ type: 'action', icon: 'link', label: st.authorized ? 'Reconnect to Discord' : 'Connect to Discord', run: () => discordConnect() });
  }
  items.push({ type: 'action', icon: 'external', label: 'Open Discord Developer Portal', run: () => api.openExternal('https://discord.com/developers/applications') });
  if (st && st.configured) {
    items.push({
      type: 'action',
      icon: 'trash',
      label: 'Remove Discord Setup',
      danger: true,
      run: async () => {
        if (await confirmDialog({ title: 'Remove the Discord setup?', message: 'The Client ID, secret and sign-in are deleted from this PC.', confirmLabel: 'Remove', danger: true })) await discordForget();
      },
    });
  }
  items.push({
    type: 'note',
    label:
      'One-time setup: in the Discord Developer Portal create a New Application (any name). Under OAuth2, copy the Client ID and reset/copy the Client Secret, and add the redirect http://localhost. Enter both here and choose Connect — Discord asks you to authorize the launcher. Only you can use this application, which is what lets it control your voice.',
  });
  return items;
}

/** Download yt-dlp (its progress shows in Settings › Sound › Game Theme Music). True once it's there. */
async function downloadYtdlp() {
  try {
    ytdlp.state = await api.ytdlpInstall();
    return true;
  } catch (err) {
    pushNotification({ title: 'yt-dlp couldn’t be downloaded', body: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), icon: 'info', kind: 'system' });
    return false;
  }
}

/** Turn game theme music on (downloading yt-dlp first if it isn't there) or off. */
async function setThemeMusic(on) {
  if (!on) return setSetting('themeMusic', false);
  if (!(ytdlp.state && ytdlp.state.installed)) {
    const ok = await confirmDialog({
      title: 'Download yt-dlp?',
      message: 'Theme music is found on YouTube with yt-dlp, a free open-source program. It is downloaded once from its GitHub page (about 17 MB) and kept up to date by the launcher. Each game’s music is downloaded the first time it plays.',
      confirmLabel: 'Download',
    });
    if (!ok || !(await downloadYtdlp())) return;
  }
  await setSetting('themeMusic', true);
}

/** Settings › Sound › Game Theme Music. */
function themeMusicItems() {
  const y = ytdlp.state;
  const installed = !!(y && y.installed);
  const items = [
    { type: 'toggle', label: 'Game Theme Music', get: () => state.settings.themeMusic === true && installed, set: (v) => setThemeMusic(v), disabled: !!(y && y.installing) },
    { type: 'range', key: 'themeMusicVolume', label: 'Theme Music Volume', min: 0, max: 100, step: 5, unit: '%' },
  ];
  if (y && y.installing) items.push({ type: 'info', label: 'yt-dlp', value: t('Downloading… {p}%', { p: Math.round((y.progress || 0) * 100) }) });
  else if (!installed) {
    // The program theme music needs, without turning the music on yet (the switch above does that).
    items.push({ type: 'action', icon: 'download', label: 'Download yt-dlp', value: (y && y.error) || 'About 17 MB', run: () => downloadYtdlp() });
  } else {
    items.push(
      { type: 'info', label: 'yt-dlp', value: y.version || '' },
      {
        type: 'action',
        icon: 'trash',
        label: 'Remove yt-dlp',
        run: async () => {
          if (!(await confirmDialog({ title: 'Remove yt-dlp?', message: 'Game theme music turns off. Turning it on again downloads yt-dlp again.', confirmLabel: 'Remove', danger: true }))) return;
          await setSetting('themeMusic', false);
          ytdlp.state = await api.ytdlpRemove();
        },
      }
    );
  }
  // Every installed game's theme, found and downloaded now instead of when it's first selected.
  const f = ytdlp.fetch;
  if (installed) items.push(onOff('themeMusicNewGames', 'Get Theme Music for New Games'));
  if (installed && f && f.running) {
    items.push(
      { type: 'info', label: 'Getting Theme Music', value: t('{done} of {total}', { done: f.done, total: f.total }) + (f.current ? ` · ${f.current}` : '') },
      { type: 'action', icon: 'close', label: f.stopping ? 'Stopping…' : 'Stop', disabled: f.stopping, run: () => api.themeStopFetch() }
    );
  } else if (installed) {
    const count = state.games.filter((g) => isInstalled(g) && g.category !== 'media').length;
    items.push({
      type: 'action',
      icon: 'download',
      label: 'Get Theme Music for All Games',
      value: f && f.total ? t('{found} of {total} found', { found: f.found, total: f.total }) : t('{n} installed games', { n: count }),
      run: () => {
        api.themeFetchAll().catch(() => {});
      },
    });
  }
  if (ytdlp.cacheSize) {
    items.push({
      type: 'action',
      icon: 'trash',
      label: 'Delete Downloaded Theme Music',
      value: fmtBytes(ytdlp.cacheSize),
      run: async () => {
        await api.themeClearCache();
        await loadYtdlp();
      },
    });
  }
  items.push({
    type: 'note',
    label:
      'A game’s theme plays while it’s selected on Home or in its game hub. It’s found on YouTube with yt-dlp, and each song is downloaded once (the launcher keeps up to 1 GB of them). It pauses while another app plays media, and the menu music waits while it plays. Choose another video or your own file in a game’s Options › Theme Music.',
  });
  return items;
}

/** Settings › System › Software Update: this launcher's updates from its GitHub Releases page. */
function updateItems() {
  const s = update.state;
  const l = s && s.latest;
  const busy = s && (s.status === 'checking' || s.status === 'downloading' || s.status === 'installing');
  const items = [
    { type: 'info', label: 'Current Version', value: (s && s.current) || state.info.version || '' },
    {
      type: 'action',
      icon: 'refresh',
      label: 'Check for Updates',
      value: updateStatus(s),
      valueClass: s && s.status === 'none' ? 'ok' : '',
      disabled: !!busy,
      run: () => checkUpdate(),
    },
  ];
  if (l && (s.status === 'available' || s.status === 'downloading' || s.status === 'error')) {
    items.push({
      type: 'action',
      icon: 'download',
      label: s.installable ? t('Download and Install {v}', { v: l.version }) : t('Download {v} from GitHub', { v: l.version }),
      value: l.size ? `${Math.round(l.size / 1048576)} MB` : '',
      disabled: s.status === 'downloading',
      run: () => downloadUpdate(),
    });
  }
  if (s && s.status === 'ready') {
    items.push({
      type: 'action',
      icon: 'restart',
      label: 'Restart and Install',
      run: async () => {
        if (await confirmDialog({ title: t('Install {v}?', { v: l.version }), message: 'The launcher closes, installs the update and starts again. Your settings and library stay.', confirmLabel: 'Restart and Install' })) installUpdate();
      },
    });
  }
  if (l && l.notes) {
    items.push({
      type: 'action',
      icon: 'info',
      label: t('What’s New in {v}', { v: l.version }),
      run: () => infoDialog({ title: l.name || l.version, html: l.notes.split('\n').map((line) => `<p>${line.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</p>`).join('') }),
    });
  }
  items.push(
    onOff('autoUpdateCheck', 'Check for Updates Automatically'),
    {
      type: 'note',
      label: s && !s.installable
        ? 'Updates come from the Releases page on GitHub. This copy runs from the zip, so a new version is downloaded from there and unpacked over it.'
        : 'Updates come from the Releases page on GitHub. To install one, the launcher closes, the update installs in the background and the launcher starts again. Your settings, library and captures stay.',
    }
  );
  return items;
}

function steamFriendsItems() {
  const st = steam.state;
  const status = !st || !st.configured
    ? 'Not set up'
    : st.status === 'ready'
      ? st.self
        ? t('{name} · {n} friends', { name: st.self.name, n: st.friends.length })
        : t('{n} friends', { n: st.friends.length })
      : st.status === 'loading' || st.status === 'idle'
        ? 'Loading…'
        : st.error || 'Not connected';
  const items = [
    { type: 'info', label: 'Status', value: status, valueClass: st && st.status === 'ready' && !st.error ? 'ok' : '' },
    st && st.source === 'local' ? { type: 'info', label: 'Friends List', value: 'Private: read from Steam on this PC' } : null,
    {
      type: 'text',
      label: 'Steam Web API Key',
      secret: true,
      placeholder: '32 letters and numbers',
      get: () => (steam.state && steam.state.configured ? 'saved-key' : ''),
      set: (v) => (v ? setFriendsKey({ key: v }) : null),
    },
    { type: 'action', icon: 'edit', label: 'Paste Key from Clipboard', run: () => setFriendsKey({ fromClipboard: true }) },
    { type: 'action', icon: 'external', label: 'Open the Steam API Key Page', run: () => api.openExternal('https://steamcommunity.com/dev/apikey') },
  ];
  if (st && st.configured) {
    items.push(
      { type: 'action', icon: 'refresh', label: 'Refresh Friends', run: () => loadFriends({ refresh: true }) },
      {
        type: 'action',
        icon: 'trash',
        label: 'Remove Steam Friends',
        danger: true,
        run: async () => {
          if (await confirmDialog({ title: 'Remove Steam Friends?', message: 'The Steam Web API key is deleted from this PC.', confirmLabel: 'Remove', danger: true })) await forgetFriendsKey();
        },
      }
    );
  }
  items.push({
    type: 'note',
    label:
      'One-time setup for the Friends list in Social: open the Steam API Key page, sign in with your Steam account, register a key (any domain name, for example localhost) and copy it here, or paste it from the clipboard. The launcher only reads which friends are online and what they play with it; it is stored encrypted on this PC. Messages, joining and profiles open in Steam.',
  });
  return items.filter(Boolean);
}

function outputItems() {
  const list = sys.outputs;
  if (list === null) return [{ type: 'header', label: 'Looking for playback devices', busy: true }];
  if (!list.length) return [{ type: 'info', label: 'Playback devices', value: 'None found' }];
  return [
    { type: 'header', label: 'Play Sound Through' },
    ...list.map((d) => ({
      type: 'action',
      icon: outputIcon(d),
      label: outputLabel(d).name,
      value: d.default ? 'In Use' : outputLabel(d).sub,
      valueClass: d.default ? 'ok' : '',
      run: async () => {
        if (d.default) return;
        try {
          await setOutput(d.id);
        } catch (err) {
          pushNotification({ title: "Couldn't switch the output device", body: String(err.message || err), icon: 'info' });
        }
      },
    })),
    { type: 'note', label: 'This is the Windows default playback device. Games and apps that follow the default device switch with it.' },
  ];
}

/* DualSense info ---------------------------------------------------- */
// The same details DualSense Client shows on its device page.
function dualsenseItems() {
  const pads = state.dualsense || [];
  if (!pads.length) return [{ type: 'info', label: 'No DualSense connected', value: 'Connect it with USB or Bluetooth' }];
  const yes = (v, on, off) => (v === undefined ? 'Unknown' : v ? on : off);
  const items = [];
  pads.forEach((p, i) => {
    const fw = p.firmware || {};
    items.push(
      { type: 'header', label: pads.length > 1 ? `${t(modelName(p))} ${i + 1}` : modelName(p) },
      { type: 'info', label: 'Connection', value: connectionLabel(p) },
      { type: 'info', label: 'Controller MAC', value: p.mac || 'Unknown' },
      { type: 'info', label: 'Battery Level', value: batteryText(p) },
      { type: 'info', label: 'Power State', value: p.power ? powerLabel(p) : 'Unknown' },
      { type: 'info', label: 'Polling Rate', value: p.rate ? `${p.rate} Hz` : 'Measuring…' },
      { type: 'header', label: 'Connection Status' },
      { type: 'info', label: 'Headphones', value: yes(p.headphones, 'Connected', 'Not connected') },
      { type: 'info', label: 'Microphone', value: yes(p.mic, 'Connected', 'Not connected') },
      { type: 'info', label: 'Microphone Muted', value: yes(p.micMuted, 'Yes', 'No') },
      { type: 'info', label: 'USB Data', value: yes(p.usbData, 'Active', 'Inactive') },
      { type: 'info', label: 'USB Power', value: yes(p.usbPower, 'Connected', 'Not connected') },
      { type: 'header', label: 'Firmware' }
    );
    if (!p.firmware) items.push({ type: 'info', label: 'Firmware Version', value: 'Unknown' });
    else
      items.push(
        { type: 'info', label: 'Firmware Version', value: fw.version },
        { type: 'info', label: 'Update Version', value: fw.update },
        { type: 'info', label: 'Hardware', value: fw.generation ? t('Generation {n}', { n: fw.generation }) : 'Unknown' },
        { type: 'info', label: 'Model Revision', value: fw.revision },
        { type: 'info', label: 'Build Date', value: fw.buildDate },
        { type: 'info', label: 'Build Time', value: fw.buildTime },
        { type: 'info', label: 'SBL Firmware', value: fw.sbl },
        { type: 'info', label: 'DSP Firmware', value: fw.dsp },
        { type: 'info', label: 'MCU Firmware', value: fw.mcu }
      );
  });
  items.push({ type: 'action', icon: 'refresh', label: 'Read Again', run: () => refreshDualsense() });
  return items;
}

/* Controller passthrough ------------------------------------------- */
function passthroughItems() {
  if (!state.settings.controllerPassthrough) return [];
  const st = state.passthrough;
  let value = 'Starting…';
  let cls = '';
  let note = null;
  if (st) {
    if (st.hidhide === 'missing') {
      value = 'HidHide not installed';
      note = 'Install HidHide (see User Guide › Controller in Games), then turn this off and on again.';
    } else if (st.hidhide === 'denied') {
      value = 'HidHide refused access';
      note = 'HidHide only lets administrators change it on this PC. Hide your DualSense in the HidHide app yourself and add the launcher\'s syshelper.exe under Applications.';
    } else if (st.viiper === 'nodriver') {
      value = 'USB/IP driver missing';
      note = 'The virtual controller needs the usbip-win2 driver. Install VIIPER, which brings it (see User Guide › Controller in Games), then turn this off and on again.';
    } else if (st.viiper === 'missing') {
      value = 'libVIIPER is missing';
      note = 'This copy of the launcher came without libVIIPER.dll, which makes the virtual controller. Reinstall the launcher.';
    } else if (st.realGame) {
      value = 'Paused for this game';
      note = t('{name} uses the real controller, so passthrough is off while it runs. The game is paused whenever a menu is open instead.', { name: st.realGame });
    } else if (st.enabled) {
      value = st.devices ? t(st.devices === 1 ? '1 controller' : '{n} controllers', { n: st.devices }) : 'Waiting for a controller';
      cls = st.devices ? 'ok' : '';
      note = 'Games now see a virtual DualSense that goes quiet while the quick menu or the launcher is in front. What games send it reaches your controller: rumble, adaptive triggers, lights, HD haptics and the controller speaker. Your controller reconnects by itself once when this turns on, so games that had it open switch over.';
    } else if (st.error) value = st.error;
    // Programs on HidHide's own list still read the real controller (double input).
    if (st.enabled && st.allowed && st.allowed.length) {
      note = t('These programs are allowed in HidHide and still see your real controller, so games can get double input: {list}. Remove them in the HidHide app under Applications, then turn this off and on.', { list: st.allowed.join(', ') });
    } else if (st.enabled && st.inverse) {
      note = 'HidHide is set to Inverse application cover, so other programs can still see your real controller. Turn that off in the HidHide app.';
    } else if (st.enabled && st.error) {
      note = st.error;
    }
  }
  return [
    { type: 'info', label: 'Controller Passthrough', value, valueClass: cls },
    note ? { type: 'note', label: note } : null,
    st && st.enabled && st.xbox ? { type: 'note', label: 'Xbox controllers: games that read them through XInput get a virtual Xbox controller that goes quiet while a menu is open. Games using Windows.Gaming.Input or GameInput still see your Xbox controller (Windows doesn’t let it be hidden from them), but they ignore it while a menu is in front. A game that was already running when this turned on keeps your Xbox controller until you restart it.' } : null,
    {
      type: 'choice',
      key: 'passthroughEmulation',
      label: 'Emulate DualSense As',
      options: [
        { value: 'dualsense', label: 'DualSense' },
        { value: 'dualshock4', label: 'DualShock 4' },
        { value: 'xbox360', label: 'Xbox Controller' },
      ],
    },
    { type: 'note', label: 'A game can have its own: Options › Emulated Controller on the game.' },
  ];
}

/* Sound themes ------------------------------------------------------ */
let packList = null;
async function loadPacks() {
  try {
    packList = await api.soundPacks();
  } catch {
    packList = [];
  }
  emit('soundpacks');
}
on('soundpacks-changed', () => loadPacks());

// UI sounds come as files named after the Steam Deck sounds, or (newer packs)
// as "mappings" from those names to the pack's own files.
const isUiPack = (p) => p.files.some((f) => /^(deck_ui_|confirmation_|bumper_end)/i.test(f)) || Object.keys(p.mappings || {}).length > 0;
const isMusicPack = (p) => !!p.music;

/** UI Sounds / Menu Music: the theme in use (a drop-down), browsing, removing. */
function packChoiceItems(kind) {
  const music = kind === 'music';
  const key = music ? 'musicPack' : 'soundPack';
  const items = music
    ? [onOff('ambient', 'Menu Music'), { type: 'range', key: 'ambientVolume', label: 'Music Volume', min: 0, max: 100, step: 5, unit: '%' }]
    : [onOff('uiSounds', 'Interface Sounds'), { type: 'range', key: 'uiVolume', label: 'Interface Volume', min: 0, max: 100, step: 5, unit: '%' }];
  if (packList === null) {
    items.push({ type: 'header', label: 'Looking for sound themes', busy: true });
    return items;
  }
  const packs = packList.filter(music ? isMusicPack : isUiPack);
  const builtin = music ? 'Generated Ambient Music' : 'Built-in Sounds';
  const current = () => packs.find((p) => p.id === state.settings[key]) || null;
  items.push({
    type: 'action',
    icon: music ? 'music' : 'volume',
    label: music ? 'Music' : 'Sound Theme',
    value: current() ? current().name : builtin,
    run: async (el) => {
      const cur = current();
      const choice = await optionsMenu({
        title: music ? 'Music' : 'Sound Theme',
        anchor: el,
        index: cur ? packs.indexOf(cur) + 1 : 0,
        items: [
          { id: null, label: builtin, checked: !cur },
          ...packs.map((p) => ({ id: p.id, label: p.name, hint: p.author, checked: cur === p })),
        ],
      });
      if (!choice || choice.id === (cur ? cur.id : null)) return;
      await setSetting(key, choice.id);
      if (music && choice.id && !state.settings.ambient) await setSetting('ambient', true);
    },
  });
  items.push({ type: 'action', icon: 'download', label: music ? 'Browse Menu Music…' : 'Browse Sound Themes…', run: () => openSoundStore({ kind: music ? 'Music' : 'Audio' }) });
  if (packs.length) {
    items.push({
      type: 'action',
      icon: 'trash',
      label: music ? 'Delete Menu Music…' : 'Delete a Sound Theme…',
      run: async (el) => {
        const choice = await optionsMenu({
          title: music ? 'Delete Menu Music' : 'Delete a Sound Theme',
          anchor: el,
          items: packs.map((p) => ({ id: p.id, label: p.name, hint: p.author, icon: 'trash' })),
        });
        const p = choice && packs.find((x) => x.id === choice.id);
        if (!p) return;
        const both = isUiPack(p) && isMusicPack(p);
        const ok = await confirmDialog({
          title: t('Delete {name}?', { name: p.name }),
          message: both ? 'This pack has both interface sounds and menu music; both are deleted.' : 'You can download it again from the store.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        await api.removeSoundPack(p.id);
        await loadPacks();
      },
    });
  }
  const install = (from) => async () => {
    const picked = await browseFiles(from === 'folder' ? { title: 'Choose a Sound Pack Folder', mode: 'folder', key: 'sounds' } : { title: 'Choose a Sound Pack', mode: 'file', exts: ['zip'], key: 'sounds' });
    if (!picked) return;
    const p = await api.installSoundPack(from, picked);
    if (!p) return;
    await loadPacks();
    await setSetting(isUiPack(p) ? 'soundPack' : 'musicPack', p.id);
  };
  items.push(
    { type: 'action', icon: 'file', label: 'Install from a .zip File…', run: install('zip') },
    { type: 'action', icon: 'folderPlus', label: 'Install from a Folder…', run: install('folder') },
    {
      type: 'note',
      label: music
        ? 'Menu music packs are Steam Deck Audio Loader packs from deckthemes.com. It plays on the home screen once you have picked your profile.'
        : 'Sound themes are Steam Deck Audio Loader packs from deckthemes.com. Sounds a theme leaves out keep the built-in ones.',
    }
  );
  return items;
}

function bluetoothItems() {
  const bt = sys.bt;
  if (!bt) return [{ type: 'header', label: 'Looking for Bluetooth', busy: true }];
  if (!bt.available) {
    return [
      { type: 'info', label: 'Bluetooth', value: 'No adapter found' },
      { type: 'note', label: bt.error || 'Plug in a Bluetooth adapter or turn Bluetooth on in Windows.' },
    ];
  }
  const items = [{ type: 'toggle', label: 'Bluetooth', icon: 'bluetooth', get: () => !!(sys.bt && sys.bt.on), set: (v) => setBluetooth(v) }];
  if (!bt.on) {
    items.push({ type: 'note', label: 'Turn Bluetooth on to use wireless controllers, headphones and speakers.' });
    return items;
  }
  items.push({ type: 'header', label: 'Paired Devices' });
  if (!bt.devices.length) items.push({ type: 'note', label: 'No paired devices yet. Open “Add a Device” to pair one.' });
  for (const d of bt.devices) {
    items.push({
      type: 'action',
      icon: deviceIcon(d),
      label: d.name,
      value: deviceStatus(d),
      valueClass: d.busy ? 'busy' : d.connected ? 'ok' : '',
      run: (el) => deviceMenu(d, el),
    });
  }
  items.push({ type: 'action', icon: 'refresh', label: 'Refresh', run: () => loadBluetooth() });
  return items;
}

function scanItems() {
  if (sys.bt && sys.bt.available && !sys.bt.on) {
    return [{ type: 'note', label: 'Bluetooth is off. Turn it on under “Devices” first.' }];
  }
  const sc = sys.btScan;
  const scanning = !!(sc && sc.scanning);
  const devs = (sc && sc.devices) || [];
  const items = [{ type: 'header', label: scanning ? 'Searching for devices' : 'Nearby devices', busy: scanning }];
  for (const d of devs) {
    items.push({
      type: 'action',
      icon: deviceIcon(d),
      label: d.name,
      value: d.busy || 'Pair',
      valueClass: d.busy ? 'busy' : '',
      run: () => pairDevice(d),
    });
  }
  if (!devs.length) {
    items.push({
      type: 'note',
      label: scanning ? 'Put your device in pairing mode — it will show up here.' : sc && sc.error ? sc.error : 'No devices found. Make sure the device is in pairing mode.',
    });
  }
  items.push({ type: 'action', icon: 'search', label: scanning ? 'Searching…' : 'Search Again', disabled: scanning, run: () => startScan() });
  return items;
}

const NOTIFY_WHEN = [
  { value: 'always', label: 'Always Show' },
  { value: 'notInGame', label: 'Hide During Games' },
  { value: 'never', label: "Don't Show" },
];
const NOTIFY_KINDS = [
  { id: 'discord', label: 'Discord Messages', icon: 'party' },
  { id: 'party', label: 'Party and Voice Chat', icon: 'mic' },
  { id: 'controller', label: 'Controllers', icon: 'gamepad' },
  { id: 'game', label: 'Game Sessions', icon: 'play' },
  { id: 'capture', label: 'Captures', icon: 'camera' },
  { id: 'downloads', label: 'Downloads', icon: 'download' },
  { id: 'library', label: 'Library and Artwork', icon: 'library' },
  { id: 'system', label: 'System', icon: 'settings' },
];

/* Captures (recording through OBS) ---------------------------------- */
function captureStatus() {
  const c = state.capture;
  if (!c) return { value: 'Checking…', cls: '' };
  if (c.installed === false) return { value: 'OBS Studio is not installed', cls: '' };
  if (!state.settings.captureEnabled) return { value: 'Off', cls: '' };
  if (c.status === 'starting') return { value: 'Starting OBS…', cls: 'busy' };
  if (c.status === 'ready') return { value: c.replay ? t('Keeping the last {n}', { n: lengthLabel(state.settings.captureClipLength) }) : 'Ready', cls: 'ok' };
  if (c.status === 'idle' || c.status === 'off') return { value: 'Starts with your next game', cls: '' };
  return { value: c.error || 'Not available', cls: '' };
}

function lengthLabel(s) {
  s = Number(s) || 60;
  return s >= 60 ? t(s === 60 ? '1 minute' : '{n} minutes', { n: s / 60 }) : t('{n} seconds', { n: s });
}

const loadCapture = () =>
  api
    .captureState()
    .then((s) => {
      state.capture = s;
      emit('capture-state', s);
    })
    .catch(() => {});

function capturesCategory() {
  return {
    id: 'captures',
    label: 'Captures',
    icon: 'fCaptures',
    desc: 'Clips, screenshots and recordings with OBS',
    sections: [
      {
        label: 'Recording',
        onEnter: loadCapture,
        items: () => {
          const st = captureStatus();
          const items = [
            onOff('captureEnabled', 'Record Gameplay', 'OBS Studio runs silently in the background while you play and keeps the last moments ready to save.'),
            { type: 'info', label: 'OBS Studio', value: st.value, valueClass: st.cls },
          ];
          if (state.capture && state.capture.installed === false) {
            items.push({ type: 'action', icon: 'external', label: 'Download OBS Studio', run: () => api.openExternal('https://obsproject.com/download') });
          }
          items.push(
            {
              type: 'choice',
              key: 'captureClipLength',
              label: 'Recent Gameplay Length',
              options: [15, 30, 60, 180, 300, 600].map((v) => ({ value: v, label: lengthLabel(v) })),
            },
            onOff('captureCreateButton', 'Create Button Opens Capture Menu'),
            { type: 'action', icon: 'gallery', label: 'Open Media Gallery', run: () => openGallery() },
            {
              type: 'note',
              label: 'Press the Create button (or Ctrl+Alt+End) in a game to save recent gameplay, take a screenshot or start a recording. The game keeps running. The launcher uses its own OBS profile and scene collection, so your own OBS setup stays as it is. Longer recent gameplay uses more memory.',
            }
          );
          return items;
        },
      },
      {
        label: 'Video',
        items: () => [
          {
            type: 'choice',
            key: 'captureResolution',
            label: 'Resolution',
            options: [
              { value: 0, label: 'Same as Screen' },
              { value: 2160, label: '2160p (4K)' },
              { value: 1440, label: '1440p' },
              { value: 1080, label: '1080p' },
              { value: 720, label: '720p' },
            ],
          },
          { type: 'choice', key: 'captureFps', label: 'Frame Rate', options: [30, 60, 120].map((v) => ({ value: v, label: t('{n} fps', { n: v }) })) },
        ],
      },
      { label: 'Encoder and Quality', items: encoderItems, onEnter: () => loadEncoders() },
      {
        label: 'Audio',
        items: () => [
          onOff('captureGameAudioOnly', 'Game Audio Only', 'Off: everything you hear on the PC is recorded (music, voice chat…).'),
          onOff('captureMic', 'Include Microphone'),
        ],
      },
      {
        label: 'Screenshots',
        items: () => [{ type: 'choice', key: 'captureShotFormat', label: 'Screenshot Format', options: [{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }] }],
      },
      {
        label: 'Save Location',
        onEnter: loadCapture,
        items: () => [
          { type: 'info', label: 'Folder', value: (state.capture && state.capture.dir) || '…' },
          {
            type: 'action',
            icon: 'folder',
            label: 'Change Folder…',
            run: async () => {
              const dir = await browseFiles({ title: 'Choose Where Captures Are Saved', mode: 'folder', start: await api.captureDir() });
              if (dir) await api.capturePickDir(dir).then(loadCapture);
            },
          },
          { type: 'action', icon: 'folder', label: 'Open Folder', run: async () => showFolder('Captures', await api.captureDir()) },
        ],
      },
    ],
  };
}

function notificationsCategory() {
  return {
    id: 'notifications',
    label: 'Notifications',
    icon: 'bell',
    desc: 'Pop-ups, and which ones you see when',
    sections: [
      {
        label: 'Pop-Ups',
        items: () => [
          onOff('notifPopups', 'Allow Pop-Up Notifications'),
          onOff('notifPreview', 'Show Preview'),
          {
            type: 'choice',
            key: 'notifDuration',
            label: 'Display Time',
            options: [
              { value: 'short', label: 'Short' },
              { value: 'default', label: 'Default' },
              { value: 'long', label: 'Long' },
            ],
          },
          {
            type: 'action',
            icon: 'bell',
            label: 'Show a Test Notification',
            run: () => pushNotification({ title: 'PS5 Game Launcher', body: 'This is how notifications look.', icon: 'bell', kind: 'system' }),
          },
          { type: 'note', label: 'Select which pop-ups you want to see, and when you want to see them. While a game is running, pop-ups appear over the game. Everything is still listed under Notifications in the quick menu.' },
          ...NOTIFY_KINDS.map((k) => ({ type: 'choice', key: `notif_${k.id}`, label: k.label, icon: k.icon, options: NOTIFY_WHEN })),
        ],
      },
    ],
  };
}

export function buildSchema(router) {
  const cats = [
    guideCategory(router),
    notificationsCategory(),
    {
      id: 'library',
      label: 'Library',
      icon: 'fLibrary',
      desc: 'Game folders, emulators, scanning and artwork',
      sections: [
        {
          label: 'Game Folders',
          items: () => [
            { type: 'header', label: 'Folders with game shortcuts' },
            ...(state.settings.folders || []).map((f) => ({
              type: 'action',
              label: f.split(/[\\/]/).filter(Boolean).pop() || f,
              value: f,
              valueClass: 'path',
              icon: 'folder',
              run: async (el) => {
                await optionsMenu({
                  title: f,
                  anchor: el,
                  items: [
                    { label: 'Rescan Folder', icon: 'refresh', run: () => api.scan() },
                    {
                      label: 'Remove Folder',
                      icon: 'trash',
                      danger: true,
                      run: async () => {
                        if (await confirmDialog({ title: 'Remove this folder?', message: t('Games found in\n{folder}\nwill be removed from the library.', { folder: f }), confirmLabel: 'Remove', danger: true })) {
                          await api.removeFolder(f);
                        }
                      },
                    },
                  ],
                });
              },
            })),
            (state.settings.folders || []).length ? null : { type: 'info', label: 'No folders added yet', value: '' },
            { type: 'action', label: 'Add Folder…', icon: 'folderPlus', run: () => addGameFolder() },
            { type: 'action', label: 'Add Games from Files…', icon: 'file', run: () => addGameFiles() },
            { type: 'note', label: 'Shortcuts (.lnk, .url), executables and sub-folders with installed games are detected. You can also drag and drop shortcuts onto the launcher.' },
          ],
        },
        { label: 'Emulators', items: emulatorItems, onEnter: () => loadEmulators() },
        {
          label: 'Scanning',
          items: () => [
            onOff('scanSteam', 'Scan Steam Library'),
            onOff('steamOwned', 'Show Steam Games That Aren’t Installed', 'Games you own on Steam show in the Game Library, ready to download.'),
            onOff('scanEpic', 'Scan Epic Games Library'),
            onOff('scanXbox', 'Scan Xbox / Microsoft Store Games'),
            onOff('scanUbisoft', 'Scan Ubisoft Connect Library'),
            onOff('rescanOnStartup', 'Scan for New Games at Startup'),
            onOff('steamAutoUpdate', 'Update Steam Games Right Away', 'When a game has an update, the launcher asks Steam to download it straight away instead of on Steam’s schedule.'),
            { type: 'action', label: 'Scan Now', icon: 'refresh', run: () => api.scan() },
            { type: 'header', label: 'Detected' },
            {
              type: 'info',
              label: 'Steam',
              value: state.info.steam
                ? t(state.info.steam.owned ? '{n} installed · {m} to download' : '{n} installed', { n: state.info.steam.count, m: state.info.steam.owned })
                : state.settings.scanSteam ? 'Not found' : 'Off',
            },
            state.info.steam && state.info.steam.ownedError && state.settings.steamOwned !== false
              ? { type: 'note', label: t('Couldn’t read the Steam games you own that aren’t installed: {e}', { e: state.info.steam.ownedError }) }
              : null,
            { type: 'info', label: 'Epic Games', value: state.info.epic ? 'Found' : state.settings.scanEpic ? 'Not found' : 'Off' },
            { type: 'info', label: 'Xbox', value: state.info.xbox ? 'Found' : state.settings.scanXbox !== false ? 'Not found' : 'Off' },
            { type: 'info', label: 'Ubisoft Connect', value: state.info.ubisoft ? 'Found' : state.settings.scanUbisoft !== false ? 'Not found' : 'Off' },
            {
              type: 'action',
              label: 'Restore Removed Games',
              value: state.info.excluded ? `${state.info.excluded}` : 'None',
              disabled: !state.info.excluded,
              run: async () => {
                const n = await api.restoreExcluded();
                await refreshInfo();
                pushNotification({ title: 'Removed games restored', body: t(n === 1 ? '1 entry will show up again.' : '{n} entries will show up again.', { n }), icon: 'refresh' });
              },
            },
          ],
        },
        {
          label: 'Artwork',
          items: () => [
            {
              type: 'choice',
              key: 'tileStyle',
              label: 'Tile Artwork',
              options: [
                { value: 'auto', label: 'Automatic' },
                { value: 'hero', label: 'Hero + Logo' },
                { value: 'capsule', label: 'Box Art' },
                { value: 'banner', label: 'Banner' },
                { value: 'grid', label: 'SteamGridDB Square' },
              ],
            },
            {
              type: 'choice',
              key: 'artSource',
              label: 'Preferred Source',
              options: [
                { value: 'steam', label: 'Steam' },
                { value: 'sgdb', label: 'SteamGridDB' },
              ],
            },
            {
              type: 'text',
              key: 'sgdbKey',
              label: 'SteamGridDB API Key',
              secret: true,
              placeholder: 'Paste or type your key',
              after: async (v) => (await import('../ui/sgdbkey.js')).sgdbKeyEntered(v),
            },
            { type: 'action', label: 'Get a SteamGridDB API Key', icon: 'external', run: () => api.openExternal('https://www.steamgriddb.com/profile/preferences/api') },
            {
              type: 'action',
              label: 'Re-download All Artwork',
              icon: 'download',
              run: async () => {
                if (await confirmDialog({ title: 'Re-download all artwork?', message: 'Banners, heroes and logos for every game will be fetched again.', confirmLabel: 'Download' })) api.refreshAll();
              },
            },
          ],
        },
      ],
    },
    {
      id: 'home',
      label: 'Home Screen',
      icon: 'fHome',
      desc: 'Carousel, background and clock',
      sections: [
        {
          label: 'Layout',
          items: () => [
            {
              type: 'choice',
              key: 'homeCount',
              label: 'Games on Home',
              options: [6, 8, 10, 12, 15, 20, 30].map((n) => ({ value: n, label: String(n) })),
            },
            {
              type: 'choice',
              key: 'homeSort',
              label: 'Order',
              options: [
                { value: 'recent', label: 'Recently Played' },
                { value: 'added', label: 'Recently Added' },
                { value: 'name', label: 'Alphabetical' },
                { value: 'playtime', label: 'Most Played' },
              ],
            },
          ],
        },
        {
          label: 'Background',
          items: () => [
            {
              type: 'choice',
              key: 'background',
              label: 'Theme Background',
              options: [
                { value: 'animated', label: 'Animated' },
                { value: 'static', label: 'Static' },
                { value: 'off', label: 'Black' },
              ],
            },
            onOff('heroMotion', 'Slow Zoom on Game Art'),
          ],
        },
        {
          label: 'Clock',
          items: () => [onOff('showClock', 'Show Clock'), onOff('clock24', '24-Hour Clock')],
        },
      ],
    },
    {
      id: 'sound',
      label: 'Sound',
      icon: 'fSound',
      desc: 'Volume, output device and interface sounds',
      sections: [
        {
          label: 'Volume',
          items: () =>
            sys.volume === null
              ? [{ type: 'info', label: 'System volume', value: 'Not available' }]
              : [
                  { type: 'header', label: 'Windows' },
                  { type: 'range', label: 'System Volume', min: 0, max: 100, step: 2, unit: '%', get: () => sys.volume, set: (v) => setVolume(v) },
                  { type: 'toggle', label: 'Mute', get: () => sys.muted, set: (v) => setMute(v) },
                ],
        },
        { label: 'Output Device', items: outputItems, onEnter: () => loadOutputs() },
        { label: 'UI Sounds', items: () => packChoiceItems('ui'), onEnter: () => loadPacks() },
        { label: 'Menu Music', items: () => packChoiceItems('music'), onEnter: () => loadPacks() },
        { label: 'Game Theme Music', items: themeMusicItems, onEnter: () => loadYtdlp() },
      ],
    },
    capturesCategory(),
    {
      id: 'screen',
      label: 'Screen and Video',
      icon: 'fScreen',
      desc: 'Full screen, interface size and motion',
      sections: [
        {
          label: 'Brightness',
          items: () => {
            if (sys.displays === null) return [{ type: 'info', label: 'Looking for displays…', value: '' }];
            if (!sys.displays.length) {
              return [
                { type: 'info', label: 'Brightness control', value: 'Not supported' },
                { type: 'note', label: 'No display answered over DDC/CI. Turn on “DDC/CI” in your monitor’s on-screen menu, then reopen this page.' },
              ];
            }
            const many = sys.displays.length > 1;
            return [
              many
                ? {
                    type: 'range',
                    label: 'All Displays',
                    icon: 'sun',
                    min: 0,
                    max: 100,
                    step: 5,
                    unit: '%',
                    get: () => Math.round(sys.displays.reduce((a, d) => a + d.percent, 0) / sys.displays.length),
                    set: (v) => setBrightness(-1, v),
                  }
                : null,
              ...sys.displays.map((d, i) => ({
                type: 'range',
                label: many ? d.name || `Display ${i + 1}` : 'Brightness',
                icon: many ? 'display' : 'sun',
                min: 0,
                max: 100,
                step: 5,
                unit: '%',
                get: () => (sys.displays[i] ? sys.displays[i].percent : 0),
                set: (v) => setBrightness(i, v),
              })),
              { type: 'note', label: 'Brightness is set on the monitor itself over DDC/CI, the same as its own buttons.' },
            ];
          },
        },
        {
          label: 'Display',
          items: () => [
            ...hdrDisplays().map((d, _i, all) => ({
              type: 'toggle',
              icon: 'display',
              label: all.length > 1 ? t('HDR · {name}', { name: d.name || t('Display {n}', { n: d.index + 1 }) }) : 'HDR',
              get: () => !!(sys.hdr[d.index] && sys.hdr[d.index].on),
              set: (v) => setHdr(d.index, v),
            })),
            sys.hdr && sys.hdr.length && !hdrDisplays().length ? { type: 'info', icon: 'display', label: 'HDR', value: 'Not supported by this display' } : null,
            sys.nightLight === null
              ? null
              : { type: 'toggle', icon: 'nightLight', label: 'Night Light', get: () => !!sys.nightLight, set: (v) => setNightLight(v) },
            onOff('fullscreen', 'Full Screen'),
            onOff('hardwareAcceleration', 'Hardware Acceleration', 'Use GPU acceleration when available. Fully close and reopen the launcher after changing this setting.'),
            { type: 'action', label: 'Launcher GPU', run: chooseLauncherGpu },
            { type: 'note', label: 'Fully close and reopen the launcher after changing Hardware Acceleration or Launcher GPU. Windows selects the adapter for each GPU preference.' },
            {
              type: 'choice',
              key: 'uiScale',
              label: 'Interface Size',
              options: [80, 90, 100, 110, 125].map((n) => ({ value: n, label: `${n}%` })),
            },
            { type: 'note', label: 'Press F11 at any time to toggle full screen.' },
          ],
        },
        {
          label: 'Motion',
          items: () => [onOff('reduceMotion', 'Reduce Motion')],
        },
      ],
    },
    {
      id: 'bluetooth',
      label: 'Bluetooth',
      icon: 'fBluetooth',
      desc: 'Wireless devices',
      onEnter: () => loadBluetooth(),
      sections: [
        { label: 'Devices', items: bluetoothItems },
        { label: 'Add a Device', items: scanItems, onEnter: () => startScan(), onLeave: () => stopScan() },
      ],
    },
    {
      id: 'accessories',
      label: 'Accessories',
      icon: 'fAccessories',
      desc: 'Controllers and button prompts',
      sections: [
        {
          label: 'Controllers',
          items: () => {
            // With passthrough on the launcher doesn't use the browser's controller list (see input.js):
            // DualSense controllers come from the helper then.
            const pads = connectedPads().map((p) => ({ label: p.id.replace(/\s*\(.*\)\s*$/, '') || 'Gamepad', value: p.kind === 'ps' ? 'PlayStation' : 'Xbox / XInput' }));
            if (!pads.length) for (const p of state.dualsense || []) pads.push({ label: modelName(p), value: 'PlayStation' });
            return [
              { type: 'header', label: 'Connected' },
              ...(pads.length ? pads.map((p) => ({ type: 'info', label: p.label, value: p.value })) : [{ type: 'info', label: 'No controllers detected', value: 'Press a button' }]),
              {
                type: 'choice',
                key: 'prompts',
                label: 'Button Prompts',
                options: [
                  { value: 'auto', label: 'Automatic' },
                  { value: 'xbox', label: 'Xbox' },
                  { value: 'ps', label: 'PlayStation' },
                  { value: 'keyboard', label: 'Keyboard' },
                ],
              },
              onOff('vibration', 'Vibration'),
            ];
          },
        },
        { label: 'DualSense', items: dualsenseItems, onEnter: () => refreshDualsense() },
        {
          label: 'Shortcuts',
          items: () => [
            { type: 'header', label: 'Controller' },
            { type: 'info', label: 'Quick Menu', value: 'Guide / PS button' },
            { type: 'info', label: 'Options', value: 'Menu / Options button' },
            { type: 'info', label: 'Switch Tabs', value: 'LB / RB' },
            { type: 'header', label: 'Keyboard' },
            { type: 'info', label: 'Quick Menu', value: 'Home or F1' },
            { type: 'info', label: 'Options', value: 'O' },
            { type: 'info', label: 'Search', value: 'S' },
            { type: 'info', label: 'Full Screen', value: 'F11' },
          ],
        },
      ],
    },
    {
      id: 'system',
      label: 'System',
      icon: 'fSystem',
      desc: 'Startup and game launch behaviour',
      sections: [
        { label: 'Software Update', items: updateItems, onEnter: () => loadUpdate() },
        {
          label: 'Language and Font',
          items: () => [
            { type: 'choice', key: 'language', label: 'Language', icon: 'globe', options: LANGUAGES },
            { type: 'note', label: 'The interface reloads in the new language. Game names and descriptions stay as they come from the store.' },
            {
              type: 'choice',
              key: 'font',
              label: 'Font',
              icon: 'palette',
              options: [
                { value: 'system', label: 'Segoe UI (Windows)' },
                { value: 'sst', label: 'SST (PlayStation)' },
              ],
            },
          ],
        },
        {
          label: 'Startup',
          items: () => [
            onOff('launchAtStartup', 'Start with Windows'),
            onOff('welcomeScreen', 'Show Welcome Screen'),
            { type: 'action', icon: 'restart', label: 'Run Setup Again', run: async () => (await import('./setup.js')).runSetup() },
          ],
        },
        {
          label: 'In-Game Overlay',
          items: () => [
            onOff('overlay', 'Quick Menu Over Games'),
            onOff('overlayHotkey', 'Keyboard Shortcut (Ctrl+Alt+Home)'),
            onOff('pauseGames', 'Pause Game While Menus Are Open'),
            {
              type: 'toggle',
              label: 'Block Controller in Games While Menus Are Open',
              get: () => !!state.settings.controllerPassthrough,
              set: async (v) => {
                // The controller reconnects once either way, which takes a moment.
                pushNotification({ title: v ? 'Setting up your controller…' : 'Switching back to your controller…', body: 'It reconnects in a moment. Wait a few seconds before pressing buttons.', icon: 'gamepad', kind: 'controller' });
                await setSetting('controllerPassthrough', v);
              },
            },
            ...passthroughItems(),
            {
              type: 'note',
              label:
                'Pausing keeps your button presses from reaching the game while the quick menu or home screen is in front. Games with anti-cheat are never paused (nothing touches them), and neither are games connected to a server, since pausing would disconnect them. Change it per game in its Options › Pause in Menus.',
            },
            {
              type: 'note',
              label:
                'Press the Guide / PS button while playing to open the quick menu on top of the game. It is a separate window, so nothing is injected into the game. It shows over borderless and most full-screen games; games running in exclusive full screen may minimize while it is open.',
            },
          ],
        },
        {
          label: 'Game Launch',
          items: () => [
            {
              type: 'choice',
              key: 'onLaunch',
              label: 'When a Game Starts',
              options: [
                { value: 'minimize', label: 'Minimize Launcher' },
                { value: 'stay', label: 'Keep Launcher Open' },
                { value: 'close', label: 'Close Launcher' },
              ],
            },
            onOff('restoreOnExit', 'Return to Launcher When Game Closes'),
            onOff('preferDirect', 'Start Games Directly'),
            { type: 'note', label: 'Xbox games always start directly, without the Xbox app. Steam starts hidden in the tray and Epic in silent mode, so no store window opens. With Start Games Directly on, Epic games that run offline start from their own executable without the Epic launcher. Online games still need their store for sign-in. Change it per game in its Options › Launch Method.' },
            { type: 'note', label: 'Play time is tracked for games started directly from an executable. Steam play time is read from your Steam client.' },
          ],
        },
      ],
    },
    {
      id: 'users',
      label: 'Users and Accounts',
      icon: 'fUsers',
      desc: 'Profile name and avatar',
      sections: [
        {
          label: 'Profile',
          items: () => [
            { type: 'text', key: 'profileName', label: 'Profile Name' },
            {
              type: 'choice',
              key: 'avatar',
              label: 'Avatar Color',
              options: AVATARS.map((_, i) => ({ value: i, label: t('Color {n}', { n: i + 1 }) })),
            },
            {
              type: 'action',
              label: state.settings.avatarImage ? 'Change Picture…' : 'Choose Picture…',
              icon: 'image',
              run: () => pickProfileImage(activeProfileId()),
            },
            state.settings.avatarImage
              ? {
                  type: 'action',
                  label: 'Remove Picture',
                  icon: 'close',
                  run: async () => {
                    const old = state.settings.avatarImage;
                    await updateProfile(activeProfileId(), { image: null });
                    api.removeProfileImage(old).catch(() => {});
                  },
                }
              : null,
            { type: 'note', label: 'Add more users, or switch between them, on the welcome screen when the launcher starts.' },
          ],
        },
        { label: 'Discord', items: discordItems, onEnter: () => loadDiscord() },
        { label: 'Steam Friends', items: steamFriendsItems, onEnter: () => loadFriends() },
        {
          label: 'Linked Platforms',
          items: () => [
            { type: 'info', label: 'Steam', value: state.info.steam ? state.info.steam.persona || 'Signed in' : 'Not detected' },
            { type: 'info', label: 'Epic Games', value: state.info.epic ? 'Installed' : 'Not detected' },
          ],
        },
      ],
    },
    {
      id: 'storage',
      label: 'Storage',
      icon: 'fStorage',
      desc: 'Drives, installed games and library data',
      sections: [
        { label: 'PC Storage', items: () => storageItems(router), onEnter: () => (loadStorage(), loadCaptureSize()) },
        {
          label: 'Library Data',
          items: () => [
            { type: 'info', label: 'Games', value: String(state.games.filter((g) => g.category !== 'media').length) },
            { type: 'info', label: 'Media Apps', value: String(state.games.filter((g) => g.category === 'media').length) },
            { type: 'info', label: 'Artwork Cache', value: state.cacheSize == null ? 'Calculating…' : fmtBytes(state.cacheSize), async: 'cache' },
            { type: 'action', label: 'Open Data Folder', icon: 'folder', run: async () => showFolder('Data Folder', await api.dataDir()) },
            {
              type: 'action',
              label: 'Reset Library',
              icon: 'trash',
              danger: true,
              run: async () => {
                if (await confirmDialog({ title: 'Reset the library?', message: 'All games, play history and cached artwork will be removed. Settings and folders are kept. A new scan will run afterwards.', confirmLabel: 'Reset', danger: true })) {
                  await api.resetLibrary();
                  api.scan();
                }
              },
            },
          ],
        },
      ],
    },
    {
      id: 'about',
      label: 'About',
      icon: 'fAbout',
      desc: 'Version information',
      sections: [
        {
          label: 'Software',
          items: () => [
            { type: 'info', label: 'PS5 Game Launcher', value: state.info.version },
            { type: 'info', label: 'Electron', value: state.info.electron },
            { type: 'info', label: 'Chromium', value: state.info.chrome },
            { type: 'info', label: 'System', value: state.info.platform },
            { type: 'note', label: 'Game artwork and details are provided by Steam and (optionally) SteamGridDB. This launcher is not affiliated with Sony Interactive Entertainment or Valve.' },
          ],
        },
      ],
    },
  ];
  // Same order as the console's settings list.
  const order = ['guide', 'library', 'home', 'notifications', 'users', 'system', 'storage', 'sound', 'screen', 'bluetooth', 'accessories', 'captures', 'about'];
  return order.map((id) => cats.find((c) => c.id === id)).filter(Boolean);
}

// The first-time setup (views/setup.js) shows some of the same rows.
export { discordItems, themeMusicItems, packChoiceItems, loadPacks };
