// Explore, the first tile on Home (as on the PS5): "Welcome back" and a grid of
// widgets under the tile row. Your activity, the DualSense's battery, the PC's
// drives (L1 / R1 to go through them), game captures, Steam friends, the game
// played last, what's new in the launcher, and downloads.
//
// The grid is laid out in columns and rows like the PS5's; moving between
// widgets remembers the row it came from, so going right through a tall widget
// and on lands level with where it started.

import { h, escapeHtml, fmtPlaytime, timeAgo, clamp } from '../util.js';
import { icon } from '../icons.js';
import { api, state, on, playtimeOf, lastActive, activeDownloads, artUrl } from '../state.js';
import { sfx } from '../sound.js';
import { mouseActive, connectedPads } from '../input.js';
import { glyph } from './glyphs.js';
import { tileArt } from './tiles.js';
import { progressOf } from './downloads.js';
import { loadStorage, fmtSize, driveName } from '../views/storage.js';
import { steam, friendsList, onlineCount, presenceText } from '../steamfriends.js';
import { update } from '../updates.js';
import { t } from '../i18n.js';

const RING = 2 * Math.PI * 42; // the battery ring's length (r = 42 in its 100 × 100 box)

export class ExploreHub {
  /**
   * @param {{ openView(name: string, params?: object): void, focusGame(id: string): void, onFocusRequest(i: number, how: string): void }} host
   */
  constructor(host) {
    this.host = host;
    this.drive = null; // letter of the drive shown
    this.captures = null;
    this.capturesAt = 0;
    this.storageAt = 0;
    this.wantRow = 0;
    this.index = 0;
    this.focusedEl = null;
    this.welcome = h('div', { class: 'ex-welcome' });
    this.grid = h('div', { class: 'ex-grid' });
    this.el = h('div', { class: 'explore' }, this.welcome, h('div', { class: 'ex-viewport' }, this.grid));
    this.widgets = [
      { id: 'activity', col: 0, row: 0, cs: 1, rs: 1, build: () => this.buildActivity(), run: () => host.openView('library', { tab: 'game', sort: 'playtime' }) },
      { id: 'pad', col: 0, row: 1, cs: 1, rs: 1, build: () => this.buildPad(), run: () => host.openView('settings', { category: 'accessories' }) },
      { id: 'storage', col: 0, row: 2, cs: 1, rs: 1, build: () => this.buildStorage(), run: () => host.openView('settings', { category: 'storage' }) },
      { id: 'captures', col: 1, row: 0, cs: 1, rs: 3, build: () => this.buildCaptures(), run: () => host.openView('gallery') },
      { id: 'friends', col: 2, row: 0, cs: 1, rs: 2, build: () => this.buildFriends(), run: () => this.openFriends() },
      { id: 'recent', col: 2, row: 2, cs: 1, rs: 1, build: () => this.buildRecent(), run: () => this.recentGame && host.focusGame(this.recentGame.id) },
      { id: 'news', col: 3, row: 0, cs: 1, rs: 2, build: () => this.buildNews(), run: () => host.openView('settings', { category: 'system', section: 'Software Update' }) },
      { id: 'downloads', col: 3, row: 2, cs: 1, rs: 1, build: () => this.buildDownloads(), run: () => host.openView('downloads') },
    ];
    this.widgets.forEach((w, i) => {
      w.el = h('button', {
        class: `ex-w ex-${w.id} fx`,
        style: { gridColumn: `${w.col + 1} / span ${w.cs}`, gridRow: `${w.row + 1} / span ${w.rs}` },
        onmouseenter: () => mouseActive() && host.onFocusRequest(i, 'hover'),
        onclick: () => {
          host.onFocusRequest(i, 'click');
          this.activate();
        },
      });
      this.grid.append(w.el);
    });
    this.render();

    const when = (evt, ids) =>
      on(evt, () => {
        if (this.el.isConnected) for (const id of ids) this.paint(id);
      });
    when('games', ['activity', 'recent']);
    when('dualsense', ['pad']);
    when('gamepad', ['pad']);
    when('storage', ['storage']);
    when('steamfriends', ['friends']);
    when('downloads', ['downloads']);
    when('update', ['news']);
    on('settings', (k) => {
      if (k === null || k === 'profileName') this.paintWelcome();
    });
    on('device', () => this.el.isConnected && this.paint('storage'));
  }

  /** Everything drawn again (and the data that is fetched, fetched again now and then). */
  render() {
    this.paintWelcome();
    for (const w of this.widgets) this.paint(w.id);
  }

  /** On screen: get the drives and captures again when they're a while old. */
  refresh() {
    const now = Date.now();
    if (now - this.storageAt > 15000) {
      this.storageAt = now;
      loadStorage().catch(() => {});
    }
    if (now - this.capturesAt > 10000) {
      this.capturesAt = now;
      Promise.all([api.captureList(), api.captureDir().catch(() => '')])
        .then(([list, dir]) => {
          this.captures = Array.isArray(list) ? list : [];
          this.captureDrive = String(dir || '').slice(0, 2).toUpperCase();
          this.paint('captures');
          this.paint('activity');
          this.paint('storage');
        })
        .catch(() => {});
    }
    this.render();
  }

  paintWelcome() {
    const name = state.settings.profileName || '';
    this.welcome.textContent = name ? t('Welcome back, {name}', { name }) : t('Welcome back');
  }

  paint(id) {
    const w = this.widgets.find((x) => x.id === id);
    if (!w) return;
    // The storage widget keeps its elements, so the ring and numbers can move.
    if (id === 'storage' && w.el.firstChild) return this.paintStorage(w.el);
    const html = w.build();
    if (w.el._html !== html) {
      w.el._html = html;
      w.el.innerHTML = html;
      if (id === 'recent' && this.recentGame) w.el.querySelector('.ex-recent-art')?.append(tileArt(this.recentGame));
    }
    if (id === 'storage') this.paintStorage(w.el);
  }

  /* ---------------------------------------------------------------- */
  /* Widgets                                                           */
  /* ---------------------------------------------------------------- */

  buildActivity() {
    const games = state.games.filter((g) => g.category !== 'media' && !g.hidden);
    const total = games.reduce((n, g) => n + playtimeOf(g), 0);
    const top = games.reduce((best, g) => (playtimeOf(g) > (best ? playtimeOf(best) : 0) ? g : best), null);
    const share = top && total ? Math.round((playtimeOf(top) / total) * 100) : 0;
    const shots = this.captures ? this.captures.length : null;
    const favs = games.filter((g) => g.favorite).length;
    const stat = (ic, value, label) => `<span class="ex-stat" title="${escapeHtml(t(label))}">${icon(ic)}<b>${escapeHtml(String(value))}</b></span>`;
    return `<div class="ex-stats">${stat('gamepad', games.length, 'Games')}${stat('clock', total ? fmtPlaytime(total) : '0h', 'Play time')}${stat('camera', shots ?? '–', 'Captures')}${stat('star', favs, 'Favorites')}</div>
      <div class="ex-most">${icon('trophy')}<span class="ex-most-name">${escapeHtml(top ? top.name : t('No play time yet'))}</span></div>
      <div class="ex-most-line"><span>${escapeHtml(t('Most played'))}</span><span>${top ? `${share}%` : ''}</span></div>
      <div class="ex-bar"><i style="width:${share}%"></i></div>`;
  }

  buildPad() {
    const ds = state.dualsense.find((p) => typeof p.battery === 'number') || state.dualsense[0] || null;
    const pads = connectedPads();
    const name = ds ? (ds.model === 'edge' ? 'DualSense Edge' : 'DualSense') : pads[0] ? pads[0].id.replace(/\s*\(.*\)\s*$/, '') : t('No Controller');
    const level = ds && typeof ds.battery === 'number' ? clamp(ds.battery, 0, 100) : null;
    const lit = level === null ? (ds || pads.length ? 100 : 0) : level;
    const charging = ds && (ds.power === 'charging' || ds.power === 'full');
    return `<span class="ex-ring${level === null ? ' unknown' : ''}${ds || pads.length ? '' : ' none'}">
        <svg viewBox="0 0 100 100"><circle class="trk" cx="50" cy="50" r="42"/><circle class="lvl" cx="50" cy="50" r="42" style="stroke-dasharray:${((lit / 100) * RING).toFixed(1)} ${RING.toFixed(1)}"/></svg>
        <span class="ex-ring-in"><small>1</small>${icon('gamepad')}</span>
      </span>
      <span class="ex-pad-text"><span class="ex-pad-name">${escapeHtml(name)}</span>
        ${level !== null ? `<span class="ex-batt${level <= 15 && !charging ? ' low' : ''}${charging ? ' charging' : ''}"><i style="width:${level}%"></i></span><span class="ex-batt-pct">${level}%</span>` : `<span class="ex-dim">${escapeHtml(t(ds || pads.length ? 'Connected' : 'Connect a controller to play'))}</span>`}
      </span>`;
  }

  /** Drives the widget can show, the system drive first. */
  drives() {
    const st = state.storage;
    const list = (st && st.drives) || [];
    return [...list].sort((a, b) => (a.letter === 'C:' ? -1 : b.letter === 'C:' ? 1 : a.letter.localeCompare(b.letter)));
  }

  buildStorage() {
    return `<span class="ex-st-text">
        <span class="ex-head">${icon('drive')}<span class="ex-st-name"></span></span>
        <span class="ex-key"><b class="ex-dot games"></b>${escapeHtml(t('Games and Apps'))}</span>
        <span class="ex-key"><b class="ex-dot media"></b>${escapeHtml(t('Media Gallery'))}</span>
        <span class="ex-key"><b class="ex-dot other"></b>${escapeHtml(t('Other'))}</span>
      </span>
      <span class="ex-donut">
        <svg viewBox="0 0 100 100"><circle class="trk" cx="50" cy="50" r="40"/><circle class="seg games" cx="50" cy="50" r="40" pathLength="100"/><circle class="seg media" cx="50" cy="50" r="40" pathLength="100"/><circle class="seg other" cx="50" cy="50" r="40" pathLength="100"/></svg>
        <span class="ex-free"><b class="ex-free-n"></b><small>${escapeHtml(t('Free'))}</small></span>
      </span>
      <span class="ex-pager"></span>`;
  }

  /** The drive shown: its parts of the ring, its free space (counting to the new number). dir: from L1 (-1) / R1 (1). */
  paintStorage(el, dir = 0) {
    const drives = this.drives();
    let d = drives.find((x) => x.letter === this.drive) || drives[0] || null;
    this.drive = d ? d.letter : null;
    const nameEl = el.querySelector('.ex-st-name');
    if (!nameEl) return;
    const name = d ? driveName(d) : state.storage ? t('No drives found') : t('Calculating…');
    if (nameEl.textContent !== name) nameEl.textContent = name;
    const total = d ? d.total : 0;
    const used = d ? Math.max(0, d.total - d.free) : 0;
    const games = d ? Math.min(d.games || 0, used) : 0;
    const media = d && this.captures && this.captureDrive === d.letter ? Math.min(this.captures.reduce((n, c) => n + (c.size || 0), 0), used - games) : 0;
    const other = Math.max(0, used - games - media);
    const pct = (n) => (total ? (n / total) * 100 : 0);
    let at = 0;
    for (const [cls, n] of [['games', games], ['media', media], ['other', other]]) {
      const c = el.querySelector(`.seg.${cls}`);
      const len = pct(n);
      // A sliver of a gap between the parts, as on the PS5.
      const shown = Math.max(0, len - (len > 1.2 ? 0.8 : 0));
      c.style.strokeDasharray = `${shown.toFixed(2)} ${(100 - shown).toFixed(2)}`;
      c.style.strokeDashoffset = `${(-at).toFixed(2)}`;
      at += len;
    }
    this.tweenFree(el.querySelector('.ex-free-n'), d ? d.free : 0);
    const pager = el.querySelector('.ex-pager');
    const many = drives.length > 1;
    pager.innerHTML = many ? `${glyph('l1')}<span class="ex-dots">${drives.map((x) => `<i class="${x === d ? 'on' : ''}"></i>`).join('')}</span>${glyph('r1')}` : '';
    if (dir) {
      const text = el.querySelector('.ex-st-text');
      text.classList.remove('from-left', 'from-right');
      void text.offsetWidth;
      text.classList.add(dir < 0 ? 'from-left' : 'from-right');
    }
  }

  /** The free space counts over to the new drive's (as the ring turns). */
  tweenFree(el, to) {
    const from = el._value ?? to;
    el._value = to;
    cancelAnimationFrame(el._raf);
    if (!state.storage) {
      el.textContent = '–';
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 600);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmtSize(from + (to - from) * e);
      if (p < 1) el._raf = requestAnimationFrame(step);
    };
    if (from === to || document.body.classList.contains('reduce-motion')) el.textContent = fmtSize(to);
    else el._raf = requestAnimationFrame(step);
  }

  /** L1 / R1 on the storage widget: the drive before / after. */
  switchDrive(d) {
    const drives = this.drives();
    const i = drives.findIndex((x) => x.letter === this.drive);
    const next = drives[i + d];
    if (!next) {
      sfx.bump();
      return;
    }
    sfx.move();
    this.drive = next.letter;
    this.paintStorage(this.widgets.find((w) => w.id === 'storage').el, d);
  }

  buildCaptures() {
    const last = (this.captures || []).slice().sort((a, b) => b.time - a.time)[0];
    const pic = last && (last.kind === 'image' ? last.url : last.thumbUrl);
    return `${pic ? `<img class="ex-cap-img" decoding="async" alt="" src="${escapeHtml(pic)}">` : `<span class="ex-cap-empty">${icon('gallery')}<span>${escapeHtml(t(this.captures ? 'No captures yet' : 'Loading…'))}</span></span>`}
      <span class="ex-cap-shade"></span>
      <span class="ex-cap-label">${icon('screenshot')}<span>${escapeHtml(t('Game Captures'))}</span></span>
      ${last && last.game ? `<span class="ex-cap-game">${escapeHtml(last.game)}</span>` : ''}`;
  }

  buildFriends() {
    const st = steam.state;
    if (!st || !st.configured) {
      return `<span class="ex-head big">${icon('friends')}<span>${escapeHtml(t('Friends'))}</span></span>
        <span class="ex-dim ex-friends-setup">${escapeHtml(t('Set up Steam Friends to see who’s online and what they play.'))}</span>
        <span class="ex-link">${escapeHtml(t('Set Up'))}${icon('chevronRight')}</span>`;
    }
    const all = friendsList();
    const online = all.filter((f) => f.state !== 'offline');
    const playing = online.filter((f) => f.game);
    const shown = [...playing, ...online.filter((f) => !f.game)].slice(0, 6);
    const n = onlineCount();
    const av = (f) => (f.avatar ? `<img src="${escapeHtml(f.avatar)}" alt="">` : `<span>${escapeHtml((f.name || '?').slice(0, 1))}</span>`);
    const line = n ? (n === 1 ? escapeHtml(shown[0] ? shown[0].name : '') + ` ${escapeHtml(t('is online'))}` : t('{name} + {n} others online', { name: escapeHtml(shown[0] ? shown[0].name : ''), n: n - 1 })) : escapeHtml(t('No friends online'));
    return `<span class="ex-avatars">${shown.map((f) => `<span class="ex-av${f.game ? ' playing' : ''}">${av(f)}</span>`).join('')}</span>
      <span class="ex-title">${escapeHtml(t('Friends'))}</span>
      <span class="ex-online">${n ? '<i class="ex-on"></i>' : ''}${line}</span>
      <span class="ex-friend-list">${playing
        .slice(0, 3)
        .map((f) => `<span class="ex-friend">${av(f)}<span><b>${escapeHtml(f.name)}</b><em>${escapeHtml(presenceText(f))}</em></span></span>`)
        .join('')}</span>`;
  }

  buildRecent() {
    const g = state.games.filter((x) => lastActive(x) && !x.hidden).sort((a, b) => lastActive(b) - lastActive(a))[0] || null;
    this.recentGame = g;
    if (!g) return `<span class="ex-head">${icon('clock')}<span>${escapeHtml(t('Recently Played'))}</span></span><span class="ex-dim">${escapeHtml(t('Games you play show up here.'))}</span>`;
    return `<span class="ex-recent-text"><span class="ex-head">${icon('clock')}<span>${escapeHtml(t('Recently Played'))}</span></span>
        <span class="ex-recent-name">${escapeHtml(g.name)}</span>
        <span class="ex-dim">${escapeHtml(timeAgo(lastActive(g)))}</span></span>
      <span class="ex-recent-art" data-v="${escapeHtml(String(g.artVersion || ''))}|${escapeHtml(artUrl(g, 'grid') || '')}"></span>`;
  }

  buildNews() {
    const s = update.state;
    const v = (state.info && state.info.version) || '';
    const latest = s && s.latest && s.latest.version;
    const waiting = s && ['available', 'downloading', 'ready'].includes(s.status);
    return `<span class="ex-news-glow"></span>
      <span class="ex-title">${escapeHtml(t('What’s New'))}</span>
      <span class="ex-news-sub">${escapeHtml(waiting ? t('Version {v} is available', { v: latest }) : t('PS5 Game Launcher {v}', { v }))}</span>
      <span class="ex-news-more">${escapeHtml(t(waiting ? 'Get the update' : 'See what changed'))}${icon('chevronRight')}</span>`;
  }

  buildDownloads() {
    const list = activeDownloads();
    const d = list[0];
    const p = d ? Math.floor(progressOf(d) * 100) : 0;
    return `<span class="ex-head">${icon('download')}<span>${escapeHtml(t('Downloads'))}</span></span>
      ${d ? `<span class="ex-dl-name">${escapeHtml(d.name || '')}</span><span class="ex-bar"><i style="width:${Math.max(1, p)}%"></i></span><span class="ex-dim">${escapeHtml(list.length > 1 ? t('{n} downloads · {p}%', { n: list.length, p }) : `${p}%`)}</span>` : `<span class="ex-dim">${escapeHtml(t('No downloads'))}</span>`}`;
  }

  openFriends() {
    const st = steam.state;
    if (!st || !st.configured) this.host.openView('settings', { category: 'users', section: 'Steam Friends' });
    else this.host.openQuick('party', 'friends');
  }

  /* ---------------------------------------------------------------- */
  /* Focus                                                             */
  /* ---------------------------------------------------------------- */

  get current() {
    return this.widgets[this.index];
  }

  set(i, how = '') {
    i = clamp(i, 0, this.widgets.length - 1);
    this.index = i;
    const w = this.current;
    if (how !== 'keep-row') this.wantRow = w.row;
    this.refocus();
    this.scrollTo(w);
  }

  refocus() {
    for (const w of this.widgets) w.el.classList.toggle('focused', w === this.current);
    this.el.classList.add('has-focus');
  }

  blur() {
    for (const w of this.widgets) w.el.classList.remove('focused');
    this.el.classList.remove('has-focus');
  }

  /** Move: true when there was somewhere to go. */
  move(dir) {
    const cur = this.current;
    const overlapRows = (w, row) => row >= w.row && row < w.row + w.rs;
    const overlapCols = (a, b) => a.col < b.col + b.cs && b.col < a.col + a.cs;
    let best = null;
    if (dir === 'left' || dir === 'right') {
      const cols = this.widgets.filter((w) => (dir === 'right' ? w.col >= cur.col + cur.cs : w.col + w.cs <= cur.col));
      if (!cols.length) return false;
      const col = dir === 'right' ? Math.min(...cols.map((w) => w.col)) : Math.max(...cols.map((w) => w.col + w.cs - 1));
      const inCol = cols.filter((w) => (dir === 'right' ? w.col === col : w.col + w.cs - 1 === col));
      best = inCol.find((w) => overlapRows(w, this.wantRow)) || inCol.sort((a, b) => Math.abs(a.row - this.wantRow) - Math.abs(b.row - this.wantRow))[0];
      this.index = this.widgets.indexOf(best);
      this.refocus();
      this.scrollTo(best);
      return true;
    }
    const cands = this.widgets.filter((w) => overlapCols(w, cur) && (dir === 'down' ? w.row >= cur.row + cur.rs : w.row + w.rs <= cur.row));
    if (!cands.length) return false;
    best = cands.sort((a, b) => (dir === 'down' ? a.row - b.row : b.row - a.row))[0];
    this.set(this.widgets.indexOf(best));
    return true;
  }

  /** Columns off the right edge slide into view. */
  scrollTo(w) {
    const vp = this.grid.parentElement;
    if (!vp || !w) return;
    const vw = vp.clientWidth;
    const right = w.el.offsetLeft + w.el.offsetWidth;
    const pad = vw * 0.05;
    const x = Math.max(0, right - vw + pad);
    this.grid.style.transform = x ? `translateX(${-x}px)` : '';
  }

  /** Back to the start: the first column in view, nothing focused. */
  reset() {
    this.grid.style.transform = '';
  }

  activate() {
    const w = this.current;
    if (!w) return;
    sfx.select();
    w.run();
  }

  /** L1 / R1: the storage widget changes drive; elsewhere they're not for us. */
  shoulder(d) {
    if (this.current.id !== 'storage') return false;
    this.switchDrive(d);
    return true;
  }
}
