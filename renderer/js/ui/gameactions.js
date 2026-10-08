// Launching games and the per-game options ("…") menu.

import { h, sleep } from '../util.js';
import { api, on, artUrl, state, findGame, pushNotification } from '../state.js';
import { sfx } from '../sound.js';
import { optionsMenu, confirmDialog, textDialog, matchDialog } from './dialogs.js';
import { mountOverlay } from './overlay.js';
import { t } from '../i18n.js';

let launching = false;

/** Bring a running game back to the front. */
export async function continueGame(game) {
  if (!game) return;
  sfx.select();
  try {
    const r = await api.continueGame(game.id);
    if (!r || !r.continued) pushNotification({ title: game.name, body: "Couldn't switch to the game window.", icon: 'info' });
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

export async function launchGame(game) {
  if (!game || launching) return;
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
      pushNotification({ title: other.name, body: "The game didn't close, so the new one wasn't started.", icon: 'info' });
      return;
    }
  }
  launching = true;
  sfx.launch();
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
    pushNotification({ title: t("Couldn't start {name}", { name: game.name }), body: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), icon: 'info' });
  } finally {
    shown.cancel();
    app.classList.remove('launching');
    ctl.close();
    launching = false;
  }
}

async function changeArtwork(game, anchor) {
  const custom = (kind) => async () => {
    const g = await api.customArt(game.id, kind);
    if (g) pushNotification({ title: 'Artwork updated', body: game.name, icon: 'image', silent: false });
  };
  await optionsMenu({
    title: 'Change Artwork',
    anchor,
    items: [
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

/**
 * Show the options menu for a game.
 * extra: additional items prepended to the menu.
 */
export async function gameOptions(game, anchor, { extra = [] } = {}) {
  if (!game) return;
  const id = game.id;
  const running = state.running.has(id);
  const items = [
    ...extra,
    running
      ? { label: 'Continue', icon: 'play', run: () => continueGame(findGame(id) || game) }
      : { label: 'Play', icon: 'play', run: () => launchGame(findGame(id) || game) },
    running ? { label: 'Close Game', icon: 'close', danger: true, run: () => closeRunningGame(findGame(id) || game) } : null,
    {
      label: game.favorite ? 'Remove from Favorites' : 'Add to Favorites',
      icon: game.favorite ? 'starFill' : 'star',
      run: () => api.updateGame(id, { favorite: !game.favorite }),
    },
    { label: 'Change Artwork', icon: 'image', submenu: true, run: () => changeArtwork(game, anchor) },
    {
      label: 'Rename…',
      icon: 'edit',
      run: async () => {
        const name = await textDialog({ title: 'Rename', value: game.name });
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
  const hasArgs = game.launch && (game.launch.type === 'exe' || game.launch.type === 'steam' || canDirect);
  if (hasArgs) {
    items.push({
      label: 'Launch Options…',
      icon: 'sliders',
      run: async () => {
        const current = game.launch.type === 'exe' ? game.launch.args || '' : game.launchArgs || '';
        const args = await textDialog({ title: 'Launch arguments', value: current, placeholder: '-windowed -novid' });
        if (args !== null) await api.updateGame(id, { launchArgs: args });
      },
    });
  }
  items.push(
    { label: 'Open File Location', icon: 'folder', run: () => api.openLocation(id) },
    {
      label: 'Remove from Library',
      icon: 'trash',
      danger: true,
      run: async () => {
        const ok = await confirmDialog({
          title: t('Remove {name}?', { name: game.name }),
          message: 'It will be removed from the launcher and ignored by future scans. Your game files are not touched.\nYou can bring removed games back in Settings › Library.',
          confirmLabel: 'Remove',
          danger: true,
        });
        if (ok) await api.removeGame(id);
      },
    }
  );
  return optionsMenu({ title: game.name, anchor, items: items.filter(Boolean) });
}

export function isRunning(game) {
  return state.running.has(game.id);
}
