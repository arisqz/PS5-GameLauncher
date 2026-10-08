// Declarative settings tree: categories → sections → items.

import { api, state, refreshInfo, pushNotification } from '../state.js';
import { fmtBytes } from '../util.js';
import { confirmDialog, optionsMenu } from '../ui/dialogs.js';
import { AVATARS } from '../ui/avatar.js';
import { guideCategory } from './guide.js';
import { LANGUAGES } from '../i18n.js';
import { activeProfileId, pickProfileImage, updateProfile } from '../profiles.js';
import { connectedPads } from '../input.js';
import {
  sys,
  setVolume,
  setMute,
  setBrightness,
  setNightLight,
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
import { t } from '../i18n.js';

const onOff = (key, label, desc) => ({ type: 'toggle', key, label, desc });

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

export function buildSchema(router) {
  const cats = [
    guideCategory(router),
    {
      id: 'library',
      label: 'Library',
      icon: 'fLibrary',
      desc: 'Game folders, automatic scanning and artwork',
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
            { type: 'action', label: 'Add Folder…', icon: 'folderPlus', run: () => api.addFolder() },
            { type: 'action', label: 'Add Games from Files…', icon: 'file', run: () => api.addFiles() },
            { type: 'note', label: 'Shortcuts (.lnk, .url), executables and sub-folders with installed games are detected. You can also drag and drop shortcuts onto the launcher.' },
          ],
        },
        {
          label: 'Scanning',
          items: () => [
            onOff('scanSteam', 'Scan Steam Library'),
            onOff('scanEpic', 'Scan Epic Games Library'),
            onOff('scanXbox', 'Scan Xbox / Microsoft Store Games'),
            onOff('scanUbisoft', 'Scan Ubisoft Connect Library'),
            onOff('rescanOnStartup', 'Scan for New Games at Startup'),
            { type: 'action', label: 'Scan Now', icon: 'refresh', run: () => api.scan() },
            { type: 'header', label: 'Detected' },
            { type: 'info', label: 'Steam', value: state.info.steam ? `${state.info.steam.count} installed` : state.settings.scanSteam ? 'Not found' : 'Off' },
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
            { type: 'text', key: 'sgdbKey', label: 'SteamGridDB API Key', secret: true, placeholder: 'Optional — improves artwork for non-Steam games' },
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
            onOff('showStore', 'Show Store Tile'),
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
        {
          label: 'Interface',
          items: () => [onOff('uiSounds', 'Interface Sounds'), { type: 'range', key: 'uiVolume', label: 'Interface Volume', min: 0, max: 100, step: 5, unit: '%' }],
        },
        {
          label: 'Ambient Music',
          items: () => [onOff('ambient', 'Ambient Music on Home'), { type: 'range', key: 'ambientVolume', label: 'Music Volume', min: 0, max: 100, step: 5, unit: '%' }],
        },
      ],
    },
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
            sys.nightLight === null
              ? null
              : { type: 'toggle', icon: 'nightLight', label: 'Night Light', get: () => !!sys.nightLight, set: (v) => setNightLight(v) },
            onOff('fullscreen', 'Full Screen'),
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
            const pads = connectedPads();
            return [
              { type: 'header', label: 'Connected' },
              ...(pads.length ? pads.map((p) => ({ type: 'info', label: p.id.replace(/\s*\(.*\)\s*$/, '') || 'Gamepad', value: p.kind === 'ps' ? 'PlayStation' : 'Xbox / XInput' })) : [{ type: 'info', label: 'No controllers detected', value: 'Press a button' }]),
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
        {
          label: 'Language',
          items: () => [
            { type: 'choice', key: 'language', label: 'Language', icon: 'globe', options: LANGUAGES },
            { type: 'note', label: 'The interface reloads in the new language. Game names and descriptions stay as they come from the store.' },
          ],
        },
        {
          label: 'Startup',
          items: () => [onOff('launchAtStartup', 'Start with Windows'), onOff('welcomeScreen', 'Show Welcome Screen')],
        },
        {
          label: 'In-Game Overlay',
          items: () => [
            onOff('overlay', 'Quick Menu Over Games'),
            onOff('overlayHotkey', 'Keyboard Shortcut (Ctrl+Alt+Home)'),
            onOff('pauseGames', 'Pause Game While Menus Are Open'),
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
      desc: 'Artwork cache and library data',
      sections: [
        {
          label: 'Library Data',
          items: () => [
            { type: 'info', label: 'Games', value: String(state.games.filter((g) => g.category !== 'media').length) },
            { type: 'info', label: 'Media Apps', value: String(state.games.filter((g) => g.category === 'media').length) },
            { type: 'info', label: 'Artwork Cache', value: state.cacheSize == null ? 'Calculating…' : fmtBytes(state.cacheSize), async: 'cache' },
            { type: 'action', label: 'Open Data Folder', icon: 'folder', run: () => api.openDataFolder() },
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
  const order = ['guide', 'library', 'home', 'users', 'system', 'storage', 'sound', 'screen', 'bluetooth', 'accessories', 'about'];
  return order.map((id) => cats.find((c) => c.id === id)).filter(Boolean);
}
