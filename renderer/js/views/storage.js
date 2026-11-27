// Settings › Storage › Games and Apps, like the PS5's storage screens: a card
// per drive (games, other files, free space), and a screen to tick games on a
// drive and delete them. Deleting goes through main/storage.js.

import { h, escapeHtml, fmtDate } from '../util.js';
import { icon } from '../icons.js';
import { api, state, emit, on, artUrl, findGame, sourceLabel, pushNotification } from '../state.js';
import { sfx } from '../sound.js';
import { mouseActive } from '../input.js';
import { mountOverlay, FocusList } from '../ui/overlay.js';
import { confirmDialog, optionsMenu } from '../ui/dialogs.js';
import { renderHints } from '../ui/glyphs.js';
import { t } from '../i18n.js';

state.storage = null;
let listening = false;

/** Drives and installed games (sizes keep coming in while folders are measured). */
export async function loadStorage() {
  if (!listening) {
    listening = true;
    api.on('storage:changed', () => loadStorage());
  }
  try {
    state.storage = await api.storageInfo();
  } catch {
    state.storage = state.storage || { drives: [], games: [] };
  }
  emit('storage');
  return state.storage;
}

/** Sizes the way the PS5 writes them: 81.73 MB, 16.24 GB, 103.5 GB. */
export function fmtSize(n) {
  if (!n) return '0 KB';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i < 2 ? Math.round(n) : n.toFixed(n >= 100 ? 1 : 2)} ${u[i]}`;
}

export function driveName(d) {
  return `${(d.label || '').trim() || t('Local Disk')} (${d.letter})`;
}

/** The drive card in Settings (a settings row of type "drive"). */
export function driveCardHtml(d) {
  const used = Math.max(0, d.total - d.free);
  const games = Math.min(d.games || 0, used);
  const other = used - games;
  const pct = (n) => (d.total ? Math.max(0, Math.min(100, (n / d.total) * 100)) : 0);
  return `<span class="sd-top"><span class="sd-name">${escapeHtml(driveName(d))}</span><span class="sd-size">${escapeHtml(t('Size: {size}', { size: fmtSize(d.total) }))}</span></span>
    <span class="sd-bar"><i class="sd-games" style="width:${pct(games)}%"></i><i class="sd-other" style="width:${pct(other)}%"></i></span>
    <span class="sd-bottom">
      <span class="sd-key"><b class="sd-dot sd-games"></b>${escapeHtml(t('Games and Apps'))}<em>${fmtSize(games)}</em></span>
      <span class="sd-key"><b class="sd-dot sd-other"></b>${escapeHtml(t('Other'))}<em>${fmtSize(other)}</em></span>
      <span class="sd-free">${escapeHtml(t('Free space: {size}', { size: fmtSize(d.free) }))}</span>
    </span>`;
}

/** The Media Gallery's size (its captures), read when Storage opens. */
export async function loadCaptureSize() {
  try {
    const list = await api.captureList();
    state.captureBytes = (list || []).reduce((n, c) => n + (c.size || 0), 0);
  } catch {
    state.captureBytes = state.captureBytes || 0;
  }
  emit('storage');
}

/**
 * Settings › Storage › PC Storage, as the PS5's Console Storage: every drive
 * of the PC added up (its size, a bar, the free space), then what's on them
 * (Games and Apps opens the screen to delete games, Media Gallery the
 * captures), then each drive.
 */
export function storageItems(router) {
  const st = state.storage;
  if (!st) return [{ type: 'info', label: 'PC Storage', value: 'Calculating…' }];
  if (!st.drives.length) return [{ type: 'info', label: 'No drives found', value: '' }];
  const total = st.drives.reduce((n, d) => n + d.total, 0);
  const free = st.drives.reduce((n, d) => n + d.free, 0);
  const used = Math.max(0, total - free);
  const games = Math.min(used, st.drives.reduce((n, d) => n + (d.games || 0), 0));
  const media = Math.min(used - games, state.captureBytes || 0);
  const other = Math.max(0, used - games - media);
  const pct = (n) => (total ? Math.max(0, Math.min(100, (n / total) * 100)) : 0);
  // Games and Apps opens on the drive with the most games.
  const busiest = [...st.drives].sort((a, b) => (b.games || 0) - (a.games || 0))[0];
  return [
    {
      type: 'block',
      label: 'PC storage',
      cls: 'st-sum',
      html: () => `<div class="sb-top"><span class="sb-name">${escapeHtml(t('PC storage'))}</span><span class="sb-size">${escapeHtml(t('Size: {size}', { size: fmtSize(total) }))}</span></div>
        <div class="sb-bar"><i class="games" style="width:${pct(games)}%"></i><i class="media" style="width:${pct(media)}%"></i><i class="other" style="width:${pct(other)}%"></i></div>
        <div class="sb-free">${escapeHtml(t('Free space: {size}', { size: fmtSize(free) }))}</div>`,
    },
    { type: 'action', dot: 'games', label: 'Games and Apps', value: fmtSize(games), chev: false, run: (el) => openGamesAndApps(busiest && busiest.letter, { from: el }) },
    { type: 'action', dot: 'media', label: 'Media Gallery', value: fmtSize(media), chev: false, run: () => router && router.open('gallery') },
    { type: 'info', dot: 'other', label: 'Other', value: fmtSize(other) },
    { type: 'header', label: 'Drives' },
    ...st.drives.map((d) => ({
      type: 'action',
      icon: 'drive',
      label: driveName(d),
      value: t('{free} free of {total}', { free: fmtSize(d.free), total: fmtSize(d.total) }),
      run: (el) => openGamesAndApps(d.letter, { from: el }),
    })),
  ];
}

/** Why a game can't be deleted from here. */
function blockedText(g) {
  if (g.running) return 'Close the game to delete it';
  if (g.reason === 'launcher') return t('Uninstall it in {launcher}', { launcher: g.launcher });
  if (g.reason === 'shared') return 'Shares its program with other games';
  if (g.reason === 'unknown') return 'Its folder isn’t clear: delete it yourself';
  return '';
}

const canDelete = (g) => g.deletable && !g.running;

/**
 * Confirm and delete games (from the Games and Apps screen or a game's
 * Options). Says what happens: Steam restarts quietly, PC folders go for good.
 */
export async function deleteGames(list) {
  if (!list.length) return false;
  const steam = list.filter((g) => g.source === 'steam');
  const pc = list.filter((g) => g.source !== 'steam' && g.source !== 'emulator');
  // Emulated games: their ROM file (saves stay with the emulator).
  const roms = list.filter((g) => g.source === 'emulator');
  const names = list.slice(0, 5).map((g) => `• ${g.name}`);
  if (list.length > 5) names.push(t('and {n} more', { n: list.length - 5 }));
  const lines = [names.join('\n')];
  if (steam.length) lines.push(t('Steam closes and starts again in the background to remove its games. Saves in Steam Cloud stay.'));
  if (pc.length) lines.push(`${t('These folders are deleted for good, not moved to the Recycle Bin:')}\n${pc.map((g) => g.root).join('\n')}`);
  if (roms.length) lines.push(`${t('These game files are deleted for good, not moved to the Recycle Bin. Saves stay in the emulator:')}\n${roms.map((g) => g.root).join('\n')}`);
  const ok = await confirmDialog({
    title: list.length === 1 ? t('Delete {name}?', { name: list[0].name }) : t('Delete {n} games?', { n: list.length }),
    message: lines.join('\n\n'),
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return false;
  const res = await api.storageDelete(list.map((g) => g.id)).catch((err) => ({ deleted: [], failed: list.map((g) => ({ id: g.id, error: String((err && err.message) || err) })) }));
  const freed = list.filter((g) => res.deleted.includes(g.id)).reduce((n, g) => n + (g.size || 0), 0);
  if (res.deleted.length) {
    pushNotification({
      title: res.deleted.length === 1 ? t('Deleted {name}', { name: list.find((g) => g.id === res.deleted[0]).name }) : t('Deleted {n} games', { n: res.deleted.length }),
      body: freed ? t('{size} free again', { size: fmtSize(freed) }) : '',
      icon: 'trash',
      kind: 'system',
    });
  }
  for (const f of res.failed) {
    const g = list.find((x) => x.id === f.id);
    pushNotification({ title: t('Couldn’t delete {name}', { name: g ? g.name : '' }), body: t(f.error), icon: 'info', kind: 'system' });
  }
  await loadStorage();
  return res.deleted.length > 0;
}

/** Delete one game from its Options menu. */
export async function deleteGame(game) {
  const st = await loadStorage();
  const g = st.games.find((x) => x.id === game.id);
  if (!g || !canDelete(g)) {
    sfx.error();
    pushNotification({ title: t('Couldn’t delete {name}', { name: game.name }), body: g ? t(blockedText(g)) : t('It isn’t installed on this PC.'), icon: 'info', kind: 'system' });
    return false;
  }
  return deleteGames([g]);
}

/** Whether a game's Options get a Delete entry (Steam and PC games on this PC). */
export function offersDelete(game) {
  return game && (game.source === 'steam' || game.source === 'folder' || game.source === 'manual' || game.source === 'emulator') && game.installed !== false;
}

const SORTS = [
  { value: 'date', label: 'Usage Date' },
  { value: 'size', label: 'Size' },
  { value: 'name', label: 'Name' },
];

/* ------------------------------------------------------------------ */
/* Games and Apps                                                      */
/* ------------------------------------------------------------------ */

/** from: the row it was opened from (the screen grows out of it, as between Settings' pages). */
export function openGamesAndApps(letter, { from = null } = {}) {
  let drives = [];
  let drive = letter;
  let sort = 'date';
  let games = [];
  const picked = new Set();
  let zone = 'list';
  let busy = false;
  let done = false;

  const title = h('div', { class: 'sel-title ga-title', text: t('Games and Apps') });
  const tabsRow = h('div', { class: 'ga-tabs' });
  const sortBtn = h('button', { class: 'ga-sort fx' });
  const sortRow = h('div', { class: 'ga-sortrow' }, h('span', { class: 'ga-sortlabel', text: t('Sort by') }), sortBtn);
  const list = h('div', { class: 'ga-list' });
  const listWrap = h('div', { class: 'ga-list-wrap' }, list);
  const empty = h('div', { class: 'ga-empty' });
  const btnDefs = [
    { label: 'Select All', run: () => setAll(true), disabled: () => !games.some(canDelete) },
    { label: 'Deselect All', run: () => setAll(false), disabled: () => !picked.size },
    { label: 'Delete', run: () => remove(), disabled: () => !picked.size || busy },
  ];
  const btns = btnDefs.map((b, i) => {
    const el = h('button', { class: `ga-btn fx${i === 2 ? ' ga-delete' : ''}`, text: t(b.label) });
    el.addEventListener('mouseenter', () => mouseActive() && !el.classList.contains('disabled') && focus('side', i));
    el.addEventListener('click', () => {
      focus('side', i);
      press();
    });
    return el;
  });
  const meterName = h('div', { class: 'ga-meter-name' });
  const meterBar = h('div', { class: 'ga-meter-bar', html: '<i></i><b></b>' });
  const meterFree = h('div', { class: 'ga-meter-free' });
  const selected = h('div', { class: 'ga-selected' });
  const side = h('div', { class: 'ga-side' }, btns[0], btns[1], h('div', { class: 'ga-meter' }, meterName, meterBar, meterFree), selected, btns[2]);
  const hints = h('div', { class: 'gal-hints ga-hints' });
  renderHints(hints, [
    ['l1', 'Drive'],
    ['confirm', 'Select'],
    ['back', 'Back'],
  ]);
  // Everything but the title and the button hints zooms (the titles crossfade, as in Settings).
  const body = h('div', { class: 'ga-body' }, tabsRow, sortRow, listWrap, empty, side);
  const root = h('div', { class: 'overlay sel-overlay ga-overlay' }, title, body, hints);
  // The point both screens zoom about: the chosen row's middle (else the screen's).
  const r = from && from.getBoundingClientRect ? from.getBoundingClientRect() : null;
  const origin = r && r.width ? `${r.left + r.width / 2}px ${r.top + r.height / 2}px` : '50% 50%';
  body.style.transformOrigin = origin;
  const page = document.querySelector('.settings-view .set-page');
  if (page) page.style.transformOrigin = origin;

  let tabEls = [];
  let rowEls = [];
  const tabNav = new FocusList([]);
  const listNav = new FocusList([], { onChange: () => scroll() });
  const btnNav = new FocusList(btns);
  sortBtn.addEventListener('mouseenter', () => mouseActive() && focus('sort', 0));
  sortBtn.addEventListener('click', () => {
    focus('sort', 0);
    pickSort();
  });
  listWrap.addEventListener('wheel', (e) => {
    if (!rowEls.length) return;
    focus('list', Math.max(0, Math.min(rowEls.length - 1, listNav.index + (e.deltaY > 0 ? 1 : -1))));
  });

  const current = () => drives.find((d) => d.letter === drive) || drives[0];

  function sorted(list) {
    const by = {
      date: (a, b) => (b.lastUsed || b.addedAt || 0) - (a.lastUsed || a.addedAt || 0),
      size: (a, b) => (b.size || 0) - (a.size || 0),
      name: (a, b) => a.name.localeCompare(b.name),
    }[sort];
    return [...list].sort(by);
  }

  /** (Re)build from state.storage, keeping the ticks and the focused game. */
  function build() {
    const st = state.storage || { drives: [], games: [] };
    drives = st.drives.filter((d) => d.count > 0 || d.letter === drive);
    if (!drives.some((d) => d.letter === drive) && drives.length) drive = drives[0].letter;
    const focusedId = rowEls[listNav.index] ? rowEls[listNav.index]._game.id : null;
    games = sorted(st.games.filter((g) => g.drive === drive));
    for (const id of [...picked]) if (!games.some((g) => g.id === id && canDelete(g))) picked.delete(id);

    tabEls = drives.map((d, i) => {
      const el = h('button', { class: `ga-tab fx fx-in${d.letter === drive ? ' active' : ''}`, text: driveName(d) });
      el.addEventListener('mouseenter', () => mouseActive() && focus('tabs', i));
      el.addEventListener('click', () => {
        focus('tabs', i);
        setDrive(d.letter);
      });
      return el;
    });
    tabsRow.replaceChildren(...tabEls);
    tabNav.setItems(tabEls, Math.max(0, drives.findIndex((d) => d.letter === drive)));

    rowEls = games.map((g, i) => {
      const lib = findGame(g.id);
      // The square art the home screen shows (Steam or SteamGridDB); the exe's icon only as a last resort.
      const art = lib && (artUrl(lib, 'grid') || artUrl(lib, 'capsule') || artUrl(lib, 'banner') || artUrl(lib, 'icon'));
      const blocked = !canDelete(g);
      const el = h('button', {
        class: `ga-row fx fx-in${blocked ? ' blocked' : ''}`,
        html: `<span class="ga-check">${icon('check')}</span>
          <span class="ga-art">${art ? `<img src="${escapeHtml(art)}" alt="" loading="lazy">` : icon('gamepad')}</span>
          <span class="ga-info"><span class="ga-name">${escapeHtml(g.name)}</span><span class="ga-badge">${escapeHtml(lib ? sourceLabel(lib) : 'PC')}</span>${
            blocked ? `<span class="ga-why">${escapeHtml(t(blockedText(g)))}</span>` : ''
          }</span>
          <span class="ga-meta"><span class="ga-size">${g.size == null ? escapeHtml(t('Calculating…')) : fmtSize(g.size)}</span><span class="ga-date">${escapeHtml(g.lastUsed ? fmtDate(g.lastUsed) : t('Not played yet'))}</span></span>`,
      });
      // No art (or it doesn't load): the gamepad instead of a broken picture.
      const img = el.querySelector('.ga-art img');
      if (img) img.addEventListener('error', () => (img.parentElement.innerHTML = icon('gamepad')), { once: true });
      el._game = g;
      el.addEventListener('mouseenter', () => mouseActive() && focus('list', i));
      el.addEventListener('click', () => {
        focus('list', i);
        toggle(i);
      });
      return el;
    });
    list.replaceChildren(...rowEls);
    const keep = focusedId ? games.findIndex((g) => g.id === focusedId) : -1;
    listNav.setItems(rowEls, keep >= 0 ? keep : Math.min(Math.max(0, listNav.index), Math.max(0, rowEls.length - 1)));
    empty.textContent = t('No games on this drive.');
    empty.style.display = rowEls.length ? 'none' : '';
    if (zone === 'list' && !rowEls.length) zone = 'tabs';
    paint();
    scroll(true);
  }

  function paint() {
    rowEls.forEach((el) => el.classList.toggle('on', picked.has(el._game.id)));
    const d = current();
    const sel = games.filter((g) => picked.has(g.id)).reduce((n, g) => n + (g.size || 0), 0);
    sortBtn.innerHTML = `<span>${escapeHtml(t(SORTS.find((s) => s.value === sort).label))}</span>${icon('chevronDown')}`;
    if (d) {
      meterName.textContent = t('{drive} storage', { drive: driveName(d) });
      const used = Math.max(0, d.total - d.free);
      meterBar.querySelector('i').style.width = `${d.total ? (used / d.total) * 100 : 0}%`;
      // What deleting the ticked games frees, shown inside the used part.
      meterBar.querySelector('b').style.width = `${d.total ? (Math.min(sel, used) / d.total) * 100 : 0}%`;
      meterBar.querySelector('b').style.left = `${d.total ? ((used - Math.min(sel, used)) / d.total) * 100 : 0}%`;
      meterFree.textContent = t('Available: {size}', { size: fmtSize(d.free) });
    }
    selected.textContent = busy ? t('Deleting…') : t('Selected: {size}', { size: fmtSize(sel) });
    btns.forEach((el, i) => el.classList.toggle('disabled', !!btnDefs[i].disabled()));
    if (zone === 'side' && btns[btnNav.index].classList.contains('disabled')) {
      const ok = btns.findIndex((el) => !el.classList.contains('disabled'));
      if (ok >= 0) btnNav.set(ok, { silent: true });
      else zone = rowEls.length ? 'list' : 'tabs';
    }
    applyZone();
  }

  function applyZone() {
    tabNav.blur();
    listNav.blur();
    btnNav.blur();
    sortBtn.classList.toggle('focused', zone === 'sort');
    if (zone === 'tabs') tabNav.refocus();
    else if (zone === 'list') listNav.refocus();
    else if (zone === 'side') btnNav.refocus();
  }

  function focus(z, i) {
    zone = z;
    if (z === 'tabs') tabNav.set(i, { silent: true });
    else if (z === 'list') listNav.set(i, { silent: true });
    else if (z === 'side') btnNav.set(i, { silent: true });
    applyZone();
  }

  function scroll(instant = false) {
    const el = rowEls[listNav.index];
    if (!el) return (list.style.transform = '');
    const rowH = el.offsetHeight;
    list.style.transition = instant ? 'none' : '';
    list.style.transform = `translateY(${-Math.max(0, listNav.index - 2) * rowH}px)`;
  }

  function setDrive(letter) {
    if (letter === drive) return;
    drive = letter;
    picked.clear();
    listNav.setItems([], 0);
    sfx.move();
    build();
    // As Settings' tabs: this drive's games go at once, the next's fade in a moment later.
    for (const el of [list, side]) {
      el.classList.remove('swap');
      void el.offsetWidth;
      el.classList.add('swap');
    }
    clearTimeout(swapTimer);
    swapTimer = setTimeout(() => [list, side].forEach((el) => el.classList.remove('swap')), 400);
  }
  let swapTimer = 0;

  async function pickSort() {
    sfx.select();
    const choice = await optionsMenu({
      title: t('Sort by'),
      anchor: sortBtn,
      side: 'below-right',
      index: Math.max(0, SORTS.findIndex((s) => s.value === sort)),
      items: SORTS.map((s) => ({ label: t(s.label), value: s.value, checked: s.value === sort })),
    });
    if (choice && choice.value !== sort) {
      sort = choice.value;
      listNav.setItems(rowEls, 0);
      build();
    }
  }

  function toggle(i) {
    const g = games[i];
    if (!g) return;
    if (!canDelete(g)) return sfx.bump();
    if (picked.has(g.id)) picked.delete(g.id);
    else picked.add(g.id);
    sfx.toggle(picked.has(g.id));
    paint();
  }

  function setAll(on) {
    if (on) games.filter(canDelete).forEach((g) => picked.add(g.id));
    else picked.clear();
    paint();
  }

  function press() {
    const b = btnDefs[btnNav.index];
    if (!b || btns[btnNav.index].classList.contains('disabled')) return sfx.bump();
    sfx.select();
    b.run();
  }

  async function remove() {
    const list = games.filter((g) => picked.has(g.id));
    busy = true;
    paint();
    try {
      if (await deleteGames(list)) picked.clear();
    } finally {
      busy = false;
      if (!done) build();
    }
  }

  function close() {
    if (done) return;
    done = true;
    off();
    // Back to Storage: its page comes back in (a moment later) and grows back from the row.
    document.body.classList.remove('ga-open');
    document.body.classList.add('ga-back');
    setTimeout(() => document.body.classList.remove('ga-back'), 500);
    ctl.close();
  }

  // Sizes coming in, games gone after a delete: shown as they change.
  const off = on('storage', () => !done && build());

  // The Settings background (with its animation) stays; the page in front of it makes way.
  document.body.classList.add('ga-open');

  const ctl = mountOverlay(root, (action) => {
    if (action === 'back') {
      sfx.back();
      close();
      return true;
    }
    if (busy) return true;
    if (action === 'l1' || action === 'r1') {
      const i = drives.findIndex((d) => d.letter === drive) + (action === 'l1' ? -1 : 1);
      if (drives[i]) setDrive(drives[i].letter);
      else sfx.bump();
      return true;
    }
    if (zone === 'tabs') {
      if (action === 'left' || action === 'right') {
        if (tabNav.move(action === 'left' ? -1 : 1)) {
          sfx.move();
          setDrive(drives[tabNav.index].letter);
          zone = 'tabs';
          applyZone();
        } else sfx.bump();
      } else if (action === 'down') {
        zone = 'sort';
        sfx.move();
        applyZone();
      } else if (action === 'confirm') setDrive(drives[tabNav.index].letter);
      else sfx.bump();
    } else if (zone === 'sort') {
      if (action === 'up') {
        zone = 'tabs';
        sfx.move();
        applyZone();
      } else if (action === 'down' && rowEls.length) {
        zone = 'list';
        sfx.move();
        applyZone();
      } else if (action === 'right') {
        zone = 'side';
        sfx.move();
        paint();
      } else if (action === 'confirm') pickSort();
      else sfx.bump();
    } else if (zone === 'list') {
      if (action === 'up') {
        if (listNav.index > 0) listNav.move(-1) && sfx.move();
        else {
          zone = 'sort';
          sfx.move();
          applyZone();
        }
      } else if (action === 'down') listNav.move(1) ? sfx.move() : sfx.bump();
      else if (action === 'right') {
        zone = 'side';
        sfx.move();
        paint();
      } else if (action === 'confirm') toggle(listNav.index);
      else sfx.bump();
    } else if (zone === 'side') {
      if (action === 'up' || action === 'down') {
        let i = btnNav.index;
        do i += action === 'up' ? -1 : 1;
        while (btns[i] && btns[i].classList.contains('disabled'));
        if (btns[i]) {
          btnNav.set(i);
          sfx.move();
        } else sfx.bump();
      } else if (action === 'left') {
        zone = rowEls.length ? 'list' : 'sort';
        sfx.move();
        applyZone();
      } else if (action === 'confirm') press();
      else sfx.bump();
    }
    return true;
  }, { closeDelay: 260 });

  sfx.open();
  build();
  if (!rowEls.length) zone = 'tabs';
  applyZone();
  loadStorage();
}
