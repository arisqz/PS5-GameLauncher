// Launching games and the per-game options ("…") menu.

import { h, sleep } from '../util.js';
import { api, on, artUrl, state, findGame, pushNotification, downloadFor, isInstalled } from '../state.js';
import { sfx } from '../sound.js';
import { optionsMenu, confirmDialog, textDialog, matchDialog, themeTrackDialog } from './dialogs.js';
import { mountOverlay } from './overlay.js';
import { startUpdate, startInstall } from './downloads.js';
import { t } from '../i18n.js';
import { deleteGame, offersDelete } from '../views/storage.js';
import { pickImage, pickAudio, showGameLocation } from './filebrowser.js';
import { steamGridDBPicker } from './steamgriddb.js';
import { themeHold, themeChanged, themePause } from '../thememusic.js';

let launching = false;

/** Bring a running game back to the front. */
export async function continueGame(game) {
  if (!game) return;
  sfx.select();
  try {
    const r = await api.continueGame(game.id);
    if (!r || !r.continued) pushNotification({ title: game.name, body: "Couldn't switch to the game window.", icon: 'info', kind: 'game' });
  } catch {}
}

/** Close a running game (asks first). Resolves true once it has closed. */
export async function closeRunningGame(game, { ask = true } = {}) {
  if (!game) return false;
  if (ask) {
    const ok = await confirmDialog({ title: t('Close {name}?', { name: game.name }), message: 'Unsaved progress may be lost.', confirmLabel: 'Close Game', danger: true });
    if (!ok) return false;
  }
  try {
    await api.closeGame(game.id);
  } catch {}
  return !state.running.has(game.id) || !(await api.gamesRunning()).some((r) => r.id === game.id);
}

/**
 * Resolves when the main process reports the game's window is up, or the
 * launcher has been in the background for a while. cancel() stops watching.
 */
function watchGameShown(id) {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  // The main process decides (it ignores anti-cheat splash windows), so
  // losing focus to a splash doesn't end the Starting… screen.
  const offStarted = api.on('game:started', (e) => e && e.id === id && done());
  function done() {
    offStarted();
    resolve();
  }
  return { promise, cancel: done };
}

/**
 * Start a game. from: the element it was started from (its cover, the Play
 * Game button…): the launch screen fades in out of it.
 */
export async function launchGame(game, { from = null } = {}) {
  if (!game || launching) return;
  // Owned on Steam but not on this PC: download it instead.
  if (!isInstalled(game)) return startInstall(game);
  if (state.running.has(game.id)) return continueGame(game);
  // Only one game at a time: offer to close the one that is running.
  const other = [...state.running].map((id) => findGame(id)).find(Boolean);
  if (other) {
    const ok = await confirmDialog({
      title: t('Close {name}?', { name: other.name }),
      message: `${other.name} is still running. Close it to start ${game.name}.
Unsaved progress may be lost.`,
      confirmLabel: 'Close and Start',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    const closed = await closeRunningGame(other, { ask: false });
    if (!closed) {
      pushNotification({ title: other.name, body: "The game didn't close, so the new one wasn't started.", icon: 'info', kind: 'game' });
      return;
    }
  }
  launching = true;
  sfx.launch();
  themeHold(true);
  const hero = artUrl(game, 'hero');
  const logo = artUrl(game, 'logo');
  const el = h(
    'div',
    { class: 'overlay launch-overlay' },
    h('div', { class: 'launch-bg', style: hero ? { backgroundImage: `url("${hero}")` } : {} }),
    h('div', { class: 'launch-shade' }),
    h(
      'div',
      { class: 'launch-center' },
      logo ? h('img', { class: 'launch-logo', src: logo, alt: '' }) : h('div', { class: 'launch-title', text: game.name }),
      h('div', { class: 'launch-status' }, h('div', { class: 'spinner' }), h('span', { text: t('Starting…') }))
    )
  );
  // Where it comes from: the middle of what was pressed (else the screen's).
  const r = from instanceof Element && from.isConnected ? from.getBoundingClientRect() : null;
  const ox = r && r.width ? r.left + r.width / 2 : window.innerWidth / 2;
  const oy = r && r.height ? r.top + r.height / 2 : window.innerHeight / 2;
  el.style.setProperty('--lx', `${ox}px`);
  el.style.setProperty('--ly', `${oy}px`);
  const app = document.getElementById('app');
  app.classList.add('launching');
  // The launch screen stays up until the game's window is on screen (the
  // launcher then minimizes behind it). Back dismisses it early.
  let dismiss = null;
  const dismissed = new Promise((r) => (dismiss = r));
  const ctl = mountOverlay(
    el,
    (action) => {
      if (action === 'back') dismiss();
      return true;
    },
    { closeDelay: 700 }
  );
  const shown = watchGameShown(game.id);
  try {
    await sleep(650);
    await api.launch(game.id);
    const how = await Promise.race([shown.promise.then(() => 'shown'), dismissed.then(() => 'back'), sleep(120000).then(() => 'timeout')]);
    if (how !== 'shown') api.launchCancel().catch(() => {});
  } catch (err) {
    sfx.error();
    pushNotification({ title: t("Couldn't start {name}", { name: game.name }), body: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), icon: 'info', kind: 'game' });
  } finally {
    shown.cancel();
    app.classList.remove('launching');
    ctl.close();
    launching = false;
    themeHold(false);
  }
}

async function changeArtwork(game, anchor) {
  const custom = (kind) => async () => {
    const file = await pickImage('Choose an Image', 'art');
    if (!file) return;
    const g = await api.customArt(game.id, kind, file);
    if (g) pushNotification({ title: 'Artwork updated', body: game.name, icon: 'image', silent: false });
  };
  await optionsMenu({
    title: 'Change Artwork',
    anchor,
    items: [
      ...(state.settings.sgdbKey?.trim() || state.info?.sgdb ? [{ label: 'Choose from SteamGridDB…', icon: 'image', run: () => steamGridDBPicker(game) }] : []),
      {
        label: 'Find on Steam…',
        icon: 'search',
        run: async () => {
          const appid = await matchDialog(game);
          if (!appid) return;
          pushNotification({ title: 'Updating artwork', body: game.name, icon: 'refresh', silent: true });
          await api.setMatch(game.id, appid === 'none' ? null : appid);
        },
      },
      { label: 'Refresh Artwork', icon: 'refresh', run: () => api.refreshArt(game.id) },
      { label: 'Custom Tile Image…', icon: 'image', run: custom('grid') },
      { label: 'Custom Background…', icon: 'image', run: custom('hero') },
      { label: 'Custom Logo…', icon: 'image', run: custom('logo') },
    ],
  });
}

/** Options › Theme Music, in a few words: what plays for this game. */
function themeMusicLabel(game) {
  if (state.settings.themeMusic !== true) return 'Off in Settings';
  const m = game.themeMusic;
  if (!m) return 'Automatic';
  if (m.mode === 'off') return 'Off';
  if (m.mode === 'file') return m.path.split(/[\\/]/).pop();
  return m.title || 'Chosen Track';
}

/** Options › Theme Music: found automatically, a chosen video, a file of one's own, or none. */
async function chooseThemeMusic(game, anchor) {
  const id = game.id;
  const m = game.themeMusic;
  const mode = m ? m.mode : 'auto';
  const youtube = state.settings.themeMusic === true; // yt-dlp is there
  const choice = await optionsMenu({
    title: 'Theme Music',
    anchor,
    items: [
      { value: 'auto', label: 'Automatic', hint: 'Its theme, found on YouTube', checked: mode === 'auto' },
      { value: 'track', label: 'Choose from YouTube…', hint: !youtube ? 'Turn on Game Theme Music in Settings' : mode === 'track' ? m.title : undefined, disabled: !youtube, checked: mode === 'track' },
      { value: 'file', label: 'Your Own File…', hint: mode === 'file' ? themeMusicLabel(game) : undefined, checked: mode === 'file' },
      { value: 'off', label: 'Off for This Game', checked: mode === 'off' },
    ],
  });
  if (!choice) return;
  let pick = null;
  if (choice.value === 'track') {
    const tr = await themeTrackDialog(game);
    if (!tr) return;
    pick = { mode: 'track', source: 'youtube', id: tr.id, title: tr.title, channel: tr.channel };
  } else if (choice.value === 'file') {
    const file = await pickAudio('Choose Theme Music');
    if (!file) return;
    pick = { mode: 'file', path: file };
  } else if (choice.value === 'off') pick = { mode: 'off' };
  await api.updateGame(id, { themeMusic: pick });
  const g = findGame(id);
  if (g) g.themeMusic = pick || undefined;
  themeChanged(id);
}

/**
 * Show the options menu for a game ("…" / the Options button). Its theme
 * music pauses while the menu (or anything opened from it) is up.
 * extra: additional items prepended to the menu.
 */
export async function gameOptions(game, anchor, opts) {
  if (!game) return;
  themePause(true);
  try {
    return await gameOptionsMenu(game, anchor, opts);
  } finally {
    themePause(false);
  }
}

async function gameOptionsMenu(game, anchor, { extra = [] } = {}) {
  const id = game.id;
  const running = state.running.has(id);
  const dl = downloadFor(game);
  if (!isInstalled(game)) return notInstalledOptions(game, anchor, dl);
  const items = [
    ...extra,
    // A Steam update waiting (or one that stopped): start it from here too.
    dl && (dl.status === 'available' || dl.status === 'error' || dl.status === 'paused')
      ? { label: dl.status === 'paused' ? 'Resume Update' : 'Update', icon: 'download', run: () => startUpdate(findGame(id) || game) }
      : null,
    running
      ? { label: 'Continue', icon: 'play', run: () => continueGame(findGame(id) || game) }
      : { label: 'Play', icon: 'play', run: () => launchGame(findGame(id) || game, { from: anchor }) },
    running ? { label: 'Close Game', icon: 'close', danger: true, run: () => closeRunningGame(findGame(id) || game) } : null,
    {
      label: game.favorite ? 'Remove from Favorites' : 'Add to Favorites',
      icon: game.favorite ? 'starFill' : 'star',
      run: () => api.updateGame(id, { favorite: !game.favorite }),
    },
    { label: 'Change Artwork', icon: 'image', submenu: true, run: () => changeArtwork(game, anchor) },
    { label: 'Theme Music', icon: 'music', hint: themeMusicLabel(game), submenu: true, run: () => chooseThemeMusic(game, anchor) },
  ];
  const PAUSE_MODES = [
    { value: 'auto', label: 'Automatic', hint: 'Only while the game is offline' },
    { value: 'always', label: 'Always' },
    { value: 'never', label: 'Never' },
  ];
  const pauseMode = game.pauseMode || 'auto';
  items.push({
    label: 'Pause in Menus',
    icon: 'pause',
    hint: PAUSE_MODES.find((m) => m.value === pauseMode).label,
    submenu: true,
    run: async () => {
      const choice = await optionsMenu({
        title: 'Pause While Menus Are Open',
        anchor,
        items: PAUSE_MODES.map((m) => ({ ...m, checked: m.value === pauseMode })),
      });
      if (choice) await api.updateGame(id, { pauseMode: choice.value });
    },
  });
  // Controller passthrough: single-player games that use the DualSense's own
  // features (HD haptics, adaptive triggers) can get the real controller and
  // are paused while a menu is open instead. With the virtual one, each game
  // can have its own kind of controller (an Xbox one for a game that only
  // knows Xbox buttons, say).
  if (state.settings.controllerPassthrough) {
    items.push(
      { label: 'Controller', icon: 'gamepad', hint: controllerModeLabel(game), submenu: true, run: () => pickControllerMode(game, anchor) },
      {
        label: 'Emulated Controller',
        icon: 'gamepad',
        hint: game.controllerMode === 'real' ? 'Not used with the real controller' : padEmulationLabel(game),
        disabled: game.controllerMode === 'real',
        submenu: true,
        run: () => pickPadEmulation(game, anchor),
      }
    );
  }
  // Store games can start through their store (kept hidden) or straight from
  // their own executable, without the store client.
  const STORES = { steam: 'Steam', epic: 'Epic Games', ubisoft: 'Ubisoft Connect' };
  const canDirect = !!(game.direct && game.direct.target) || (game.source === 'steam' && !!game.installDir);
  if (STORES[game.source] && canDirect) {
    const store = STORES[game.source];
    const LAUNCH_MODES = [
      { value: 'auto', label: 'Automatic', hint: t(state.settings.preferDirect && game.directSafe ? 'Directly' : 'Through {store}', { store }) },
      { value: 'direct', label: 'Directly', hint: t('Without {store}', { store }) },
      { value: 'store', label: t('Through {store}', { store }) },
    ];
    const launchMode = game.launchMode || 'auto';
    items.push({
      label: 'Launch Method',
      icon: 'play',
      hint: LAUNCH_MODES.find((m) => m.value === launchMode).label,
      submenu: true,
      run: async () => {
        const choice = await optionsMenu({
          title: 'Launch Method',
          anchor,
          items: LAUNCH_MODES.map((m) => ({ ...m, checked: m.value === launchMode })),
        });
        if (!choice || choice.value === launchMode) return;
        if (choice.value === 'direct' && game.source !== 'xbox') {
          const ok = await confirmDialog({
            title: 'Start this game directly?',
            message: t(
              game.source === 'ubisoft'
                ? 'The game starts from its own executable. Ubisoft games still need Ubisoft Connect, which they start in the background themselves. Games with anti-cheat (like BattlEye) may refuse to start this way.'
                : "The game starts from its own executable without {store}. Online games that need a {store} sign-in may not connect, and some games restart themselves through {store}.",
              { store }
            ),
            confirmLabel: 'Start Directly',
          });
          if (!ok) return;
        }
        await api.updateGame(id, { launchMode: choice.value });
      },
    });
  }
  items.push(
    { label: 'Open File Location', icon: 'folder', run: () => showGameLocation(findGame(id) || game) },
    // Name, where it shows, its start arguments and removing it, in one place
    // at the bottom (keeps this menu short).
    { label: 'Manage…', icon: 'sliders', submenu: true, run: () => manageGame(game, anchor) }
  );
  return optionsMenu({ title: game.name, anchor, items: items.filter(Boolean) });
}

/** A Steam game that isn't on this PC: download it, or tidy up its library entry. */
function notInstalledOptions(game, anchor, dl) {
  const id = game.id;
  return optionsMenu({
    title: game.name,
    anchor,
    items: [
      dl ? null : { label: 'Download', icon: 'download', run: () => startInstall(findGame(id) || game) },
      {
        label: game.favorite ? 'Remove from Favorites' : 'Add to Favorites',
        icon: game.favorite ? 'starFill' : 'star',
        run: () => api.updateGame(id, { favorite: !game.favorite }),
      },
      { label: 'Change Artwork', icon: 'image', submenu: true, run: () => changeArtwork(game, anchor) },
      { label: 'View in Steam Store', icon: 'steam', run: () => api.openExternal(`steam://store/${game.steamAppId}`) },
      { label: 'Manage…', icon: 'sliders', submenu: true, run: () => manageGame(game, anchor) },
    ].filter(Boolean),
  });
}

/** Options › Manage…: Rename, Move to Media, Hide from Home, Launch Options, Delete, Remove from Library. */
async function manageGame(game, anchor) {
  const id = game.id;
  const installed = isInstalled(game);
  const canDirect = !!(game.direct && game.direct.target) || (game.source === 'steam' && !!game.installDir);
  const hasArgs = installed && game.launch && (game.launch.type === 'exe' || game.launch.type === 'steam' || canDirect);
  await optionsMenu({
    title: 'Manage',
    anchor,
    items: [
      {
        label: 'Rename…',
        icon: 'edit',
        run: async () => {
          const name = await textDialog({ title: 'Rename', value: game.name, capitalize: true });
          if (name && name.trim()) await api.updateGame(id, { name: name.trim() });
        },
      },
      {
        label: game.category === 'media' ? 'Move to Games' : 'Move to Media',
        icon: game.category === 'media' ? 'gamepad' : 'music',
        run: () => api.updateGame(id, { category: game.category === 'media' ? 'game' : 'media' }),
      },
      {
        label: game.hidden ? 'Show on Home' : 'Hide from Home',
        icon: game.hidden ? 'eye' : 'eyeOff',
        run: () => api.updateGame(id, { hidden: !game.hidden }),
      },
      hasArgs
        ? {
            label: 'Launch Options…',
            icon: 'play',
            run: async () => {
              const current = game.launch.type === 'exe' ? game.launch.args || '' : game.launchArgs || '';
              const args = await textDialog({ title: 'Launch arguments', value: current, placeholder: '-windowed -novid' });
              if (args !== null) await api.updateGame(id, { launchArgs: args });
            },
          }
        : null,
      // Uninstall: the game's files go (Steam's way for Steam games), see Settings › Storage.
      installed && offersDelete(game) ? { label: 'Delete', icon: 'trash', danger: true, run: () => deleteGame(findGame(id) || game) } : null,
      {
        label: 'Remove from Library',
        icon: 'trash',
        danger: true,
        run: async () => {
          const ok = await confirmDialog({
            title: t('Remove {name}?', { name: game.name }),
            message: game.source === 'manual'
              ? 'It will be removed from the launcher. Your game files are not touched. You can add it again manually.'
              : installed
              ? 'It will be removed from the launcher and ignored by future scans. Your game files are not touched.\nYou can bring removed games back in Settings › Library.'
              : 'It will be removed from the launcher and ignored by future scans. You still own it on Steam.\nYou can bring removed games back in Settings › Library.',
            confirmLabel: 'Remove',
            danger: true,
          });
          if (ok) await api.removeGame(id);
        },
      },
    ].filter(Boolean),
  });
}

export function isRunning(game) {
  return state.running.has(game.id);
}

/* Controller passthrough, per game ---------------------------------- */

const CONTROLLER_MODES = [
  { value: 'virtual', label: 'Virtual Controller', hint: 'Ignores presses in menus' },
  { value: 'real', label: 'Real Controller', hint: 'The game uses it directly' },
];

/** What the virtual controller is shown to games as (Settings › Controllers sets the default). */
export const PAD_EMULATION = [
  { value: 'dualsense', label: 'DualSense', hint: 'Touchpad, motion, PlayStation buttons' },
  { value: 'dualshock4', label: 'DualShock 4', hint: 'For games that only know PS4 controllers' },
  { value: 'xbox360', label: 'Xbox Controller', hint: 'Xbox buttons; no touchpad or motion' },
];

export function emulationName(value) {
  return (PAD_EMULATION.find((m) => m.value === value) || PAD_EMULATION[0]).label;
}

export function controllerModeLabel(game) {
  return CONTROLLER_MODES.find((m) => m.value === (game.controllerMode || 'virtual')).label;
}

/** The game's own emulated controller, or "Default (…)" when it follows the setting. */
export function padEmulationLabel(game) {
  const own = game.padEmulation && game.padEmulation !== 'default' ? game.padEmulation : null;
  return own ? emulationName(own) : t('Default ({name})', { name: t(emulationName(state.settings.passthroughEmulation)) });
}

export async function pickControllerMode(game, anchor) {
  const cur = game.controllerMode || 'virtual';
  const choice = await optionsMenu({
    title: 'Controller for This Game',
    anchor,
    index: Math.max(0, CONTROLLER_MODES.findIndex((m) => m.value === cur)),
    items: CONTROLLER_MODES.map((m) => ({ ...m, checked: m.value === cur })),
  });
  if (!choice || choice.value === cur) return;
  game.controllerMode = choice.value; // shown right away; the library update follows
  await api.updateGame(game.id, { controllerMode: choice.value });
}

export async function pickPadEmulation(game, anchor) {
  const cur = game.padEmulation && game.padEmulation !== 'default' ? game.padEmulation : 'default';
  const items = [
    { value: 'default', label: t('Default ({name})', { name: t(emulationName(state.settings.passthroughEmulation)) }), hint: 'Settings › Controllers' },
    ...PAD_EMULATION,
  ];
  const choice = await optionsMenu({
    title: 'Emulated Controller',
    anchor,
    index: Math.max(0, items.findIndex((m) => m.value === cur)),
    items: items.map((m) => ({ ...m, checked: m.value === cur })),
  });
  if (!choice || choice.value === cur) return;
  game.padEmulation = choice.value;
  await api.updateGame(game.id, { padEmulation: choice.value });
}

