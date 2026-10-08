// Control-centre style quick menu (Guide / PS button, Home or F1).

import { h, escapeHtml, clamp, timeAgo, bump } from '../util.js';
import { icon } from '../icons.js';
import { state, on, api, artUrl, sortGames, gamesIn, setSetting, lastActive, emit, currentGame } from '../state.js';
import { sfx } from '../sound.js';
import { mouseActive, connectedPads, rumble } from '../input.js';
import { mountOverlay, FocusList, topOverlay } from '../ui/overlay.js';
import { confirmDialog, sliderDialog, optionsMenu } from '../ui/dialogs.js';
import { party, discordCmd, discordConnect, statusText, inCall } from '../discord.js';
import { launchGame } from '../ui/gameactions.js';
import { tileArt } from '../ui/tiles.js';
import { renderHints } from '../ui/glyphs.js';
import { sliderHtml, setSlider, dragSlider } from '../ui/slider.js';
import { t } from '../i18n.js';
import {
  sys,
  watchMedia,
  mediaPosition,
  mediaCommand,
  seekLocal,
  selectSession,
  appName,
  fmtTime,
  loadVolume,
  setVolume,
  setMute,
  loadOutputs,
  currentOutput,
  outputLabel,
  outputIcon,
  setOutput,
  loadBrightness,
  setBrightness,
  loadNightLight,
  setNightLight,
  loadBluetooth,
  setBluetooth,
  connectDevice,
  deviceIcon,
  deviceStatus,
} from '../system.js';

/** Choose the Windows playback device (shared with Settings › Sound). */
export async function pickOutputDevice(anchor) {
  const list = sys.outputs && sys.outputs.length ? sys.outputs : await loadOutputs();
  if (!list.length) {
    sfx.error();
    return;
  }
  const choice = await optionsMenu({
    title: 'Output Device',
    anchor,
    index: Math.max(0, list.findIndex((d) => d.default)),
    items: list.map((d) => ({ label: outputLabel(d).name, hint: outputLabel(d).sub, icon: outputIcon(d), checked: d.default, id: d.id })),
  });
  if (choice && !list.find((d) => d.id === choice.id)?.default) {
    try {
      await setOutput(choice.id);
    } catch {
      sfx.error();
    }
  }
}

// Always shown; everything else can be hidden with "Customize".
const FIXED = new Set(['home', 'game', 'notifications', 'settings', 'power']);

function sessionText(g) {
  const since = state.runningSince[g.id];
  if (!since) return 'Playing now';
  const min = Math.max(0, Math.floor((Date.now() - since) / 60000));
  if (min < 1) return 'Playing now';
  if (min < 60) return t('Playing for {m} min', { m: min });
  return t('Playing for {h} h {m} min', { h: Math.floor(min / 60), m: min % 60 });
}

function gameIconUrl(g) {
  return artUrl(g, 'grid') || artUrl(g, 'capsule') || artUrl(g, 'banner') || artUrl(g, 'icon');
}

function avatarFor(m) {
  if (m.avatar) return `<img src="${escapeHtml(m.avatar)}" alt="" loading="lazy">`;
  let hash = 0;
  for (const ch of String(m.id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hues = [235, 200, 150, 30, 340, 270];
  return `<span class="av-fallback" style="background:hsl(${hues[hash % hues.length]} 60% 45%)">${escapeHtml((m.name || '?').charAt(0).toUpperCase())}</span>`;
}

export class QuickMenu {
  constructor(router, { overlay = false } = {}) {
    this.router = router;
    this.overlay = overlay;
    this.onClosed = null;
    this.ctl = null;
    this.customizing = false;
    on('running', () => this.ctl && !this.customizing && !this.panel && this.refreshBar());
    on('settings', (k) => (k === null || k === 'qmHidden') && this.ctl && !this.customizing && !this.panel && this.refreshBar());
    on('notifications', () => this.ctl && this.updateBadge());
    on('media', () => this.ctl && this.onMedia());
    on('volume', () => this.ctl && this.refreshRows('sound'));
    on('outputs', () => this.ctl && this.refreshRows('sound'));
    on('brightness', () => this.ctl && this.panelIs('display') && this.rebuildPanel());
    on('nightlight', () => this.ctl && this.panelIs('display') && this.rebuildPanel());
    on('bluetooth', () => this.ctl && this.panelIs('bluetooth') && this.rebuildPanel());
    on('discord', () => {
      if (!this.ctl) return;
      if (this.panelIs('party')) this.refreshParty();
      else if (!this.panel && this.cardSignature() !== this.cardSig) this.renderCards(false);
      this.updatePartyIcon();
    });
  }

  toggle() {
    if (this.ctl) this.close();
    else this.open();
  }

  close() {
    if (!this.ctl) return;
    if (this.customizing) this.exitCustomize({ quiet: true });
    sfx.close();
    // Close anything stacked above us first.
    let o = topOverlay();
    while (o && o !== this.ctl) {
      o.close();
      o = topOverlay();
    }
    this.ctl.close();
    this.ctl = null;
    if (this.onClosed) setTimeout(this.onClosed, 380);
  }

  /* ---------------------------------------------------------------- */

  /** Every control, in order (the running game appears right after Home). */
  allItems() {
    const close = () => this.close();
    const g = currentGame();
    return [
      { id: 'home', icon: 'home', label: 'Home', run: () => (close(), this.router.home()) },
      g ? { id: 'game', game: g, label: g.name, panel: () => this.gamePanel(g) } : null,
      { id: 'library', icon: 'library', label: 'Game Library', run: () => (close(), this.router.open('library')) },
      { id: 'notifications', icon: 'bell', label: 'Notifications', panel: () => this.notificationsPanel() },
      { id: 'party', icon: 'party', label: 'Party', panel: () => this.partyPanel() },
      { id: 'search', icon: 'search', label: 'Search', run: () => (close(), this.router.openSearch()) },
      { id: 'music', icon: 'music', label: 'Music', panel: () => this.musicPanel(), wide: true },
      { id: 'sound', icon: 'volume', label: 'Sound', panel: () => this.soundPanel() },
      { id: 'bluetooth', icon: 'bluetooth', label: 'Bluetooth', panel: () => this.bluetoothPanel() },
      { id: 'accessories', icon: 'gamepad', label: 'Accessories', panel: () => this.accessoriesPanel() },
      { id: 'display', icon: 'display', label: 'Screen', panel: () => this.displayPanel() },
      { id: 'settings', icon: 'settings', label: 'Settings', run: () => (close(), this.router.open('settings')) },
      { id: 'power', icon: 'power', label: 'Power', panel: () => this.powerPanel() },
    ].filter(Boolean);
  }

  barItems(hiddenList = state.settings.qmHidden) {
    const hidden = new Set(hiddenList || []);
    return this.allItems().filter((it) => FIXED.has(it.id) || !hidden.has(it.id));
  }

  /** (Re)build the icon bar for this.items, keeping focus on the same control. */
  renderBar(focusId = null) {
    const keepId = focusId || (this.barNav && this.items[this.barNav.index] ? this.items[this.barNav.index].id : null);
    const hidden = this.customHidden || new Set(state.settings.qmHidden || []);
    const barEls = this.items.map((it, i) => {
      const ic = it.game
        ? `<img src="${escapeHtml(gameIconUrl(it.game) || '')}" alt="">`
        : icon(it.id === 'sound' && (sys.muted || sys.volume === 0) ? 'mute' : it.icon);
      const el = h(
        'button',
        {
          class: `qm-btn fx qm-${it.id}${this.customizing && !FIXED.has(it.id) && hidden.has(it.id) ? ' off' : ''}`,
          onmouseenter: () => mouseActive() && this.focus('bar', i, true),
          onclick: () => {
            this.focus('bar', i, true);
            if (this.customizing) this.toggleCustom(i);
            else this.activateBar(i);
          },
        },
        h('span', { class: 'qm-label', text: t(it.label) }),
        h('span', { class: `qm-ic${it.game ? ' qm-game-ic' : ''}`, html: ic }),
        it.id === 'notifications' ? h('span', { class: 'qm-badge' }) : null,
        it.id === 'music' ? h('span', { class: 'qm-eq', html: '<i></i><i></i><i></i>' }) : null,
        it.id === 'party' ? h('span', { class: 'qm-live' }) : null,
        this.customizing && !FIXED.has(it.id) ? h('span', { class: `qm-check${hidden.has(it.id) ? '' : ' on'}`, html: icon('check') }) : null
      );
      return el;
    });
    this.barRow.replaceChildren(...barEls);
    const idx = Math.max(0, keepId ? this.items.findIndex((x) => x.id === keepId) : 0);
    this.barNav = new FocusList(barEls, { index: idx });
    if (this.el) {
      this.updateBadge();
      this.updateEq();
      this.updatePartyIcon();
      this.applyFocus();
    }
  }

  refreshBar() {
    const ids = this.barItems().map((x) => x.id).join(',');
    if (ids === this.items.map((x) => x.id).join(',')) return;
    this.items = this.barItems();
    this.renderBar();
  }

  /* ------------------------------ customize ------------------------------ */

  enterCustomize() {
    if (this.customizing) return;
    if (this.panel) this.closePanelQuiet();
    sfx.select();
    this.customizing = true;
    this.customHidden = new Set(state.settings.qmHidden || []);
    const id = this.items[this.barNav.index] && this.items[this.barNav.index].id;
    this.items = this.allItems();
    this.zone = 'bar';
    this.el.classList.add('customizing');
    renderHints(this.hints, [
      ['confirm', 'Select'],
      ['back', 'Done'],
    ]);
    this.renderBar(id);
  }

  toggleCustom(i) {
    const it = this.items[i];
    if (!it || FIXED.has(it.id)) {
      sfx.bump();
      bump(this.barNav.els[i], 'up');
      return;
    }
    if (this.customHidden.has(it.id)) this.customHidden.delete(it.id);
    else this.customHidden.add(it.id);
    sfx.toggle();
    const el = this.barNav.els[i];
    const off = this.customHidden.has(it.id);
    el.classList.toggle('off', off);
    el.querySelector('.qm-check')?.classList.toggle('on', !off);
  }

  exitCustomize({ quiet = false } = {}) {
    if (!this.customizing) return;
    const hidden = [...this.customHidden];
    // Stay on the focused control, or the nearest one before it that is still shown.
    const all = this.items;
    let id = 'home';
    for (let i = this.barNav.index; i >= 0; i--) {
      if (FIXED.has(all[i].id) || !this.customHidden.has(all[i].id)) {
        id = all[i].id;
        break;
      }
    }
    this.customizing = false;
    this.customHidden = null;
    if (!quiet) sfx.back();
    this.items = this.barItems(hidden);
    setSetting('qmHidden', hidden);
    this.el.classList.remove('customizing');
    renderHints(this.hints, [['options', 'Customize']]);
    this.renderBar(id);
  }

  panelIs(id) {
    return !!(this.panel && this.items[this.panel.index] && this.items[this.panel.index].id === id);
  }

  barIndex(id) {
    return this.items.findIndex((b) => b.id === id);
  }

  cardDefs() {
    const games = gamesIn('game');
    const cards = [];
    const playing = currentGame();
    if (playing) {
      cards.push({
        img: artUrl(playing, 'hero') || artUrl(playing, 'banner'),
        logo: artUrl(playing, 'hero') ? artUrl(playing, 'logo') : null,
        tile: !artUrl(playing, 'hero') && !artUrl(playing, 'banner') ? playing : null,
        cap: sessionText(playing),
        title: playing.name,
        playing: true,
        run: () => this.openPanel(this.barIndex('game')),
      });
    }
    const m = sys.media;
    if (m && m.active) {
      cards.push({
        media: true,
        cap: `${appName(m.app)} · ${t(m.status === 'Playing' ? 'Now playing' : 'Paused')}`,
        title: m.title || 'Unknown title',
        sub: m.artist || '',
        run: () => this.openPanel(this.barIndex('music')),
      });
    }
    if (inCall()) {
      const st = party.state;
      cards.push({
        party: true,
        cap: `${t('Party')} · ${t(st.members.length === 1 ? '1 member' : '{n} members', { n: st.members.length })}`,
        title: st.channel.name,
        sub: st.channel.guild || (st.channel.dm ? 'Direct call' : ''),
        run: () => this.openPanel(this.barIndex('party')),
      });
    }
    const last = sortGames(games.filter((g) => lastActive(g) && g !== playing), 'recent')[0];
    if (last) {
      cards.push({
        img: artUrl(last, 'hero') || artUrl(last, 'banner'),
        logo: artUrl(last, 'hero') ? artUrl(last, 'logo') : null,
        cap: t('Last played: {when}', { when: timeAgo(lastActive(last)) }),
        title: last.name,
        tile: !artUrl(last, 'hero') && !artUrl(last, 'banner') ? last : null,
        run: () => (this.close(), this.overlay ? this.router.open('hub', { id: last.id }) : launchGame(last)),
      });
    }
    const added = sortGames(games, 'added').find((g) => g !== last && g !== playing);
    if (added) {
      cards.push({
        img: artUrl(added, 'hero') || artUrl(added, 'banner'),
        logo: artUrl(added, 'hero') ? artUrl(added, 'logo') : null,
        cap: 'Recently added',
        title: added.name,
        tile: !artUrl(added, 'hero') && !artUrl(added, 'banner') ? added : null,
        run: () => (this.close(), this.router.open('hub', { id: added.id })),
      });
    }
    const n = state.notifications[0];
    cards.push({
      icon: n ? n.icon || 'bell' : 'bell',
      cap: n ? `${state.notifications.length} notification${state.notifications.length === 1 ? '' : 's'}` : 'All caught up',
      title: n ? n.title : 'No new notifications',
      run: () => this.openPanel(this.barIndex('notifications')),
    });
    return cards.slice(0, 4);
  }

  renderCards(animate) {
    const keep = this.cardNav ? this.cardNav.index : 0;
    const wasFocused = this.zone === 'cards';
    this.cards = this.cardDefs();
    const cardEls = this.cards.map((c, i) => {
      let img;
      if (c.party) {
        const st = party.state;
        img = h(
          'div',
          { class: 'qc-img qc-party' },
          h(
            'div',
            { class: 'qcp-avatars' },
            ...st.members.slice(0, 4).map((m) => h('div', { class: `qcp-av${m.speaking ? ' speaking' : ''}`, html: avatarFor(m) }))
          ),
          st.members.length > 4 ? h('div', { class: 'qcp-more', text: `+${st.members.length - 4}` }) : null
        );
      } else if (c.media) {
        img = h(
          'div',
          { class: 'qc-img qc-media' },
          h('div', { class: 'qcm-blur', style: sys.art ? { backgroundImage: `url("${sys.art}")` } : {} }),
          sys.art ? h('img', { class: 'qcm-cover', src: sys.art, alt: '' }) : h('div', { class: 'qcm-cover empty', html: icon('music') }),
          h('div', { class: 'qcm-bar', html: sliderHtml(0, 'no-knob') })
        );
      } else if (c.tile) {
        // No wide artwork: show the game's own tile art.
        img = h('div', { class: 'qc-img qc-tile' }, tileArt(c.tile));
      } else {
        img = h(
          'div',
          { class: 'qc-img', style: c.img ? { backgroundImage: `url("${c.img}")` } : {}, html: c.img ? '' : icon(c.icon || 'bell') },
          c.logo ? h('img', { class: 'qc-logo', src: c.logo, alt: '' }) : null
        );
      }
      return h(
        'button',
        {
          class: `qm-card fx${c.media ? ' media' : ''}${c.playing ? ' playing' : ''}${animate ? ' anim' : ''}`,
          style: { animationDelay: `${0.06 + i * 0.05}s` },
          onmouseenter: () => mouseActive() && this.focus('cards', i, true),
          onclick: () => c.run(),
        },
        img,
        h(
          'div',
          { class: 'qc-text' },
          h('div', { class: 'qc-cap', text: t(c.cap) }),
          h('div', { class: 'qc-title', text: t(c.title) }),
          c.sub ? h('div', { class: 'qc-sub', text: t(c.sub) }) : null
        )
      );
    });
    this.cardRow.innerHTML = '';
    this.cardRow.append(...cardEls);
    this.cardNav = new FocusList(cardEls, { index: Math.min(keep, cardEls.length - 1) });
    if (!wasFocused) this.cardNav.blur();
    this.cardSig = this.cardSignature();
    this.tickProgress();
  }

  cardSignature() {
    const m = sys.media;
    const st = party.state;
    const p = inCall() ? `${st.channel.id}|${st.members.map((x) => `${x.id}${x.speaking ? '*' : ''}`).join(',')}` : 'no-party';
    return (m && m.active ? `${m.app}|${m.key}|${m.status}|${sys.artKey}` : 'none') + '|' + p;
  }

  open() {
    sfx.open();
    this.zone = 'bar';
    this.panel = null;
    this.cardNav = null;
    this.unwatch = watchMedia();
    loadVolume();
    loadOutputs();
    // Warm up the slower panels so they usually open fully populated.
    loadBluetooth();
    loadNightLight();
    if (sys.displays === null) loadBrightness();

    this.cardRow = h('div', { class: 'qm-cards' });

    // Bar
    this.customizing = false;
    this.items = this.barItems();
    this.barNav = null;
    this.el = null;
    this.barRow = h('div', { class: 'qm-bar-row' });
    this.renderBar('home');
    this.panelHost = h('div', { class: 'qm-panel-host' });
    this.hints = h('div', { class: 'qm-hints' });
    renderHints(this.hints, [['options', 'Customize']]);
    this.el = h(
      'div',
      { class: `overlay qm${this.overlay ? ' in-game' : ''}` },
      h('div', { class: 'qm-shade' }),
      h('div', { class: 'qm-top' }, h('div', { class: 'qm-clock', dataset: { clock: '' } })),
      this.cardRow,
      this.panelHost,
      h('div', { class: 'qm-custom-msg', text: t('You can customize your control center. Select which controls you want to access quickly.') }),
      h('div', { class: 'qm-bar' }, this.barRow),
      this.hints
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el || e.target.classList.contains('qm-shade')) this.close();
    });
    this.renderCards(true);
    this.ticker = setInterval(() => this.tickProgress(), 500);
    this.ctl = mountOverlay(this.el, (a) => this.handle(a), {
      dimApp: true,
      closeDelay: 380,
      onClose: () => {
        this.ctl = null;
        clearInterval(this.ticker);
        if (this.unwatch) this.unwatch();
        this.unwatch = null;
      },
    });
    this.updateBadge();
    this.updateEq();
    this.updatePartyIcon();
    emit('clock');
    this.applyFocus();
  }

  updateBadge() {
    const b = this.el && this.el.querySelector('.qm-badge');
    if (!b) return;
    const n = state.notifications.filter((x) => !x.read).length;
    b.textContent = n ? String(n) : '';
    b.style.display = n ? '' : 'none';
  }

  updatePartyIcon() {
    const b = this.el && this.el.querySelector('.qm-party');
    if (b) b.classList.toggle('live', inCall());
  }

  updateEq() {
    const playing = !!(sys.media && sys.media.active && sys.media.status === 'Playing');
    this.el && this.el.querySelector('.qm-music')?.classList.toggle('playing', playing);
  }

  onMedia() {
    this.updateEq();
    if (this.cardSignature() !== this.cardSig && !this.panel) this.renderCards(false);
    if (this.panel && this.panel.player) this.updatePlayer();
    this.tickProgress();
  }

  tickProgress() {
    const m = sys.media;
    if (!m || !m.active || !this.el) return;
    const p = m.duration > 0 ? (mediaPosition() / m.duration) * 100 : 0;
    this.el.querySelectorAll('.qcm-bar').forEach((b) => setSlider(b, p));
    if (this.panel && this.panel.player) {
      const pl = this.panel.player;
      setSlider(pl.querySelector('.mp-progress'), p);
      pl.querySelector('.mp-t0').textContent = fmtTime(mediaPosition());
      pl.querySelector('.mp-t1').textContent = m.duration > 0 ? fmtTime(m.duration) : '';
    }
  }

  focus(zone, i, fromMouse = false) {
    if (zone !== this.zone && !fromMouse) sfx.move();
    this.zone = zone;
    if (zone === 'cards') this.cardNav.set(i);
    if (zone === 'bar') this.barNav.set(i);
    this.applyFocus();
  }

  applyFocus() {
    this.cardNav && this.cardNav.blur();
    this.barNav.blur();
    if (this.panel) this.panel.nav.blur();
    if (this.zone === 'cards' && this.cardNav) this.cardNav.refocus();
    else if (this.zone === 'bar') this.barNav.refocus();
    else if (this.zone === 'panel' && this.panel) {
      this.panel.nav.refocus();
      if (this.panel.nav.current) this.panel.nav.current.scrollIntoView({ block: 'nearest' });
    }
    this.barNav.els.forEach((el, i) => el.classList.toggle('active', !!this.panel && i === this.panel.index));
    if (this.panel) this.panel.nav.els.forEach((el) => this.renderRow(el));
  }

  activateBar(i) {
    const it = this.items[i];
    if (it.panel) this.openPanel(i);
    else {
      sfx.select();
      it.run();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Panels                                                            */
  /* ---------------------------------------------------------------- */

  openPanel(i, { keepIndex = null } = {}) {
    const it = this.items[i];
    if (!it || !it.panel) return;
    const rebuild = keepIndex !== null && this.panel && this.panel.index === i;
    if (!rebuild && this.panel && this.panel.index === i) {
      this.closePanel();
      return;
    }
    if (!rebuild) sfx.select();
    this.barNav.set(i);
    const def = it.panel();
    const rows = def.rows.map((r, ri) => {
      const el = h('button', {
        class: `qp-row fx fx-in t-${r.type || 'action'}${r.danger ? ' danger' : ''}`,
        onmouseenter: () => {
          if (mouseActive() && this.panel) {
            this.zone = 'panel';
            this.panel.nav.set(ri);
            this.applyFocus();
          }
        },
        onclick: (e) => {
          this.zone = 'panel';
          this.panel.nav.set(ri);
          const btn = e.target.closest('[data-bi]');
          if (btn) r.bi = Number(btn.dataset.bi);
          this.applyFocus();
          if (r.type !== 'range') this.activateRow(r, el);
        },
      });
      el._row = r;
      if (r.bi === undefined) r.bi = r.defaultButton || 0;
      this.renderRow(el);
      if (r.type === 'range') {
        dragSlider(el, (p) => {
          const step = r.step || 5;
          const v = Math.round(((p / 100) * (r.max || 100)) / step) * step;
          if (v !== r.value()) {
            r.set(v);
            this.renderRow(el);
          }
        });
      }
      return el;
    });
    const player = def.player ? this.buildPlayer() : null;
    const content = [
      h('div', {
        class: 'qp-head',
        html: `${it.game ? `<span class="qp-game-ic"><img src="${escapeHtml(gameIconUrl(it.game) || '')}" alt=""></span>` : icon(it.icon)}<span>${escapeHtml(t(def.title || it.label))}</span>${def.subtitle ? `<em>${escapeHtml(t(def.subtitle))}</em>` : ''}`,
      }),
      player,
      rows.length ? h('div', { class: 'qp-rows' }, ...rows) : h('div', { class: 'qp-empty', text: t(def.empty || 'Nothing here') }),
    ].filter(Boolean);
    if (player) {
      dragSlider(player.querySelector('.mp-progress'), (p) => {
        const m = sys.media;
        if (m && m.active && m.canSeek && m.duration > 0) {
          const sec = (p / 100) * m.duration;
          seekLocal(sec);
          clearTimeout(this.seekTimer);
          this.seekTimer = setTimeout(() => mediaCommand('seek', Math.round(sec)), 120);
          this.tickProgress();
        }
      });
    }

    let panelEl;
    if (rebuild) {
      // Swap the content of the panel that is already on screen, so its
      // entrance animation keeps running and the size change is smooth.
      panelEl = this.panel.el;
      const from = panelEl.offsetHeight;
      panelEl.replaceChildren(...content);
      panelEl.style.transition = 'none';
      panelEl.style.height = '';
      const to = panelEl.offsetHeight;
      if (Math.abs(to - from) > 1) {
        panelEl.style.height = `${from}px`;
        void panelEl.offsetHeight;
        panelEl.style.transition = 'height 0.32s var(--ease-out)';
        panelEl.style.height = `${to}px`;
        clearTimeout(panelEl._hTimer);
        panelEl._hTimer = setTimeout(() => {
          panelEl.style.height = '';
          panelEl.style.transition = '';
        }, 360);
      } else {
        panelEl.style.transition = '';
      }
    } else {
      if (this.panel) this.dismissPanelEl(this.panel.el);
      panelEl = h('div', { class: `qm-panel${it.wide ? ' wide' : ''}` }, ...content);
      this.panelHost.append(panelEl);
      const r = this.barNav.els[i].getBoundingClientRect();
      const pw = panelEl.offsetWidth;
      panelEl.style.left = `${clamp(r.left + r.width / 2 - pw / 2, 24, window.innerWidth - pw - 24)}px`;
    }
    const nav = new FocusList(rows, { index: rebuild ? Math.min(keepIndex, rows.length - 1) : 0 });
    this.panel = { index: i, el: panelEl, nav, rows: def.rows, player };
    if (!rebuild) {
      this.zone = rows.length ? 'panel' : 'bar';
      if (def.onOpen) def.onOpen();
    } else if (this.zone === 'panel' && !rows.length) {
      this.zone = 'bar';
    }
    this.setPanelOpen(true);
    if (player) this.updatePlayer();
    this.applyFocus();
    this.tickProgress();
  }

  /** Re-render the open panel in place (e.g. after async data arrived). */
  rebuildPanel() {
    if (!this.panel) return;
    this.openPanel(this.panel.index, { keepIndex: Math.max(0, this.panel.nav.index) });
  }

  /** Play the exit animation of a panel element, then remove it. */
  dismissPanelEl(el) {
    if (!el || el._dismissed) return;
    el._dismissed = true;
    el.classList.add('out');
    const done = () => el.remove();
    el.addEventListener('animationend', done, { once: true });
    setTimeout(done, 400);
  }

  /** The cards row hides while a panel is open; bring it back only after the panel has left. */
  setPanelOpen(open) {
    clearTimeout(this.panelOpenTimer);
    if (open) {
      this.el.classList.add('panel-open');
      return;
    }
    this.panelOpenTimer = setTimeout(() => {
      if (this.panel) return;
      if (this.cardSignature() !== this.cardSig) this.renderCards(false);
      this.el.classList.remove('panel-open');
    }, 200);
  }

  refreshRows(id) {
    if (!this.panel || this.items[this.panel.index].id !== id) return;
    this.panel.nav.els.forEach((el) => this.renderRow(el));
    const ic = this.barNav.els[this.barIndex('sound')].querySelector('.qm-ic');
    if (ic) ic.innerHTML = icon(sys.muted || sys.volume === 0 ? 'mute' : 'volume');
  }

  closePanel() {
    if (!this.panel) return;
    this.dismissPanelEl(this.panel.el);
    this.panel = null;
    this.zone = 'bar';
    sfx.back();
    this.setPanelOpen(false);
    this.applyFocus();
  }

  renderRow(el) {
    const r = el._row;
    const focused = el.classList.contains('focused');
    // Only touch the DOM when something changed, so focus animations keep running.
    const put = (html) => {
      if (el._html !== html) {
        el._html = html;
        el.innerHTML = html;
      }
    };
    if (r.type === 'buttons') {
      put(`<span class="qp-btns${r.labels ? ' labelled' : ''}">${r
        .buttons()
        .map((b, bi) => {
          const btn = `<span class="qp-btn fx${b.big ? ' big' : ''}${b.on ? ' on' : ''}${b.danger ? ' danger' : ''}${focused && bi === r.bi ? ' sel' : ''}${b.disabled ? ' disabled' : ''}"${r.labels ? '' : ` data-bi="${bi}"`} title="${escapeHtml(t(b.label))}">${icon(b.icon)}</span>`;
          return r.labels ? `<span class="qp-btnwrap" data-bi="${bi}">${btn}<span class="qp-btnlbl">${escapeHtml(t(b.label))}</span></span>` : btn;
        })
        .join('')}</span>`);
      return;
    }
    if (r.type === 'member') {
      const m = r.member();
      if (!m) return;
      const flags = `${m.deaf ? icon('headphonesOff') : ''}${m.mute ? icon('micOff') : ''}`;
      put(
        `<span class="qp-avatar${m.speaking ? ' speaking' : ''}">${avatarFor(m)}</span><span class="qp-text"><span class="qp-label">${escapeHtml(m.name)}</span><span class="qp-sub">${escapeHtml(
          m.self ? 'You' : m.volume !== 100 ? `Volume ${m.volume}%` : m.speaking ? 'Speaking' : 'In call'
        )}</span></span><span class="qp-flags">${flags}</span>`
      );
      return;
    }
    const val = typeof r.value === 'function' ? r.value() : r.value;
    if (r.type === 'range') {
      const ic = typeof r.icon === 'function' ? r.icon() : r.icon;
      put(`<span class="qp-range-head">${ic ? `<span class="qp-ic">${icon(ic)}</span>` : ''}<span class="qp-label">${escapeHtml(t(r.label))}</span><span class="qp-num">${val}%</span></span>${sliderHtml((val / (r.max || 100)) * 100)}`);
      return;
    }
    let right = '';
    if (r.type === 'toggle') right = `<span class="switch${val ? ' on' : ''}"><i></i></span>`;
    else if (val !== undefined && val !== null && val !== '') right = `<span class="qp-val">${escapeHtml(t(val))}</span>`;
    if (r.chevron) right += `<span class="qp-chev">${icon('chevronRight')}</span>`;
    put(`${r.icon ? `<span class="qp-ic">${icon(typeof r.icon === 'function' ? r.icon() : r.icon)}</span>` : ''}<span class="qp-text"><span class="qp-label">${escapeHtml(t(r.label))}</span>${r.sub ? `<span class="qp-sub">${escapeHtml(t(typeof r.sub === 'function' ? r.sub() : r.sub))}</span>` : ''}</span>${right}`);
  }

  async activateRow(r, el) {
    if (r.type === 'toggle') {
      sfx.toggle();
      await r.toggle();
      this.renderRow(el);
    } else if (r.type === 'range') {
      sfx.bump();
    } else if (r.type === 'buttons') {
      const b = r.buttons()[r.bi];
      if (!b || b.disabled) return sfx.bump();
      sfx.select();
      const hit = el.querySelector(`[data-bi="${r.bi}"]`);
      const btn = hit && (hit.classList.contains('qp-btn') ? hit : hit.querySelector('.qp-btn'));
      if (btn) {
        btn.classList.remove('pressed');
        void btn.offsetWidth;
        btn.classList.add('pressed');
      }
      await b.run();
      this.renderRow(el);
    } else if (r.run) {
      sfx.select();
      await r.run(el);
      if (this.panel && el.isConnected) this.renderRow(el);
    }
  }

  adjustRow(delta) {
    const el = this.panel.nav.current;
    const r = el && el._row;
    if (!r) return false;
    if (r.type === 'buttons') {
      const n = r.buttons().length;
      const next = r.bi + delta;
      if (next < 0 || next >= n) {
        sfx.bump();
        return true;
      }
      r.bi = next;
      sfx.move();
      this.renderRow(el);
      return true;
    }
    if (r.type !== 'range') return false;
    const step = r.step || 5;
    const v = clamp(Math.round(((r.value() || 0) + delta * step) / step) * step, 0, r.max || 100);
    if (v === r.value()) {
      sfx.bump();
      return true;
    }
    r.set(v);
    sfx.tick();
    this.renderRow(el);
    return true;
  }

  /* -------------------------- media player ------------------------- */

  buildPlayer() {
    return h(
      'div',
      { class: 'mp' },
      h('div', { class: 'mp-art' }, h('div', { class: 'mp-art-blur' }), h('img', { class: 'mp-cover', alt: '' }), h('div', { class: 'mp-cover-empty', html: icon('music') })),
      h(
        'div',
        { class: 'mp-meta' },
        h('div', { class: 'mp-app' }),
        h('div', { class: 'mp-title' }),
        h('div', { class: 'mp-artist' }),
        h('div', { class: 'mp-time' }, h('span', { class: 'mp-t0' }), h('div', { class: 'mp-progress', html: sliderHtml(0, 'thin') }), h('span', { class: 'mp-t1' }))
      )
    );
  }

  updatePlayer() {
    const pl = this.panel && this.panel.player;
    if (!pl) return;
    const m = sys.media;
    const active = !!(m && m.active);
    pl.classList.toggle('idle', !active);
    pl.querySelector('.mp-app').textContent = active ? appName(m.app) : '';
    pl.querySelector('.mp-title').textContent = active ? m.title || t('Unknown title') : t('Nothing is playing');
    pl.querySelector('.mp-artist').textContent = active ? [m.artist, m.album].filter(Boolean).join(' · ') : t('Start music or a video in any app — Spotify, a browser, Media Player…');
    const cover = pl.querySelector('.mp-cover');
    if (sys.art) {
      if (cover.getAttribute('src') !== sys.art) cover.src = sys.art;
      pl.querySelector('.mp-art-blur').style.backgroundImage = `url("${sys.art}")`;
    }
    pl.classList.toggle('has-art', !!sys.art && active);
    this.panel.nav.els.forEach((el) => this.renderRow(el));
  }

  musicPanel() {
    const s = () => state.settings;
    const m = () => sys.media || {};
    const rows = [
      {
        type: 'buttons',
        defaultButton: 1,
        buttons: () => [
          { icon: 'skipPrev', label: 'Previous', disabled: !m().active || m().canPrev === false, run: () => mediaCommand('prev') },
          { icon: m().status === 'Playing' ? 'pause' : 'play', label: 'Play / Pause', big: true, disabled: !m().active, run: () => mediaCommand('toggle') },
          { icon: 'skipNext', label: 'Next', disabled: !m().active || m().canNext === false, run: () => mediaCommand('next') },
        ],
      },
    ];
    const sessions = (m().sessions || []).filter((x) => x.app);
    if (sessions.length > 1) {
      rows.push({
        icon: 'refresh',
        label: 'Switch Source',
        value: () => appName(m().app),
        run: async () => {
          const list = (sys.media && sys.media.sessions) || [];
          const i = list.findIndex((x) => x.app === (sys.media && sys.media.app));
          const next = list[(i + 1) % list.length];
          if (next) await selectSession(next.app);
        },
      });
    }
    rows.push({ type: 'toggle', icon: 'sparkle', label: 'Launcher Ambient Music', value: () => s().ambient, toggle: () => setSetting('ambient', !s().ambient) });
    return { title: 'Music', player: true, rows };
  }

  soundPanel() {
    const s = () => state.settings;
    const rows = [];
    if (sys.volume !== null) {
      rows.push(
        {
          type: 'range',
          icon: () => (sys.muted || sys.volume === 0 ? 'mute' : 'volume'),
          label: 'Volume',
          step: 2,
          value: () => sys.volume ?? 0,
          set: (v) => setVolume(v),
        },
        { type: 'toggle', icon: 'mute', label: 'Mute', value: () => sys.muted, toggle: () => setMute(!sys.muted) },
        {
          icon: () => (currentOutput() ? outputIcon(currentOutput()) : 'speaker'),
          label: 'Output Device',
          sub: () => {
            const d = currentOutput();
            return d ? d.name : sys.outputs === null ? 'Checking…' : 'No playback device';
          },
          chevron: true,
          run: (el) => pickOutputDevice(el),
        }
      );
    }
    rows.push(
      { type: 'toggle', icon: 'music', label: 'Interface Sounds', value: () => s().uiSounds, toggle: () => setSetting('uiSounds', !s().uiSounds) },
      { type: 'range', label: 'Interface Volume', value: () => s().uiVolume ?? 60, set: (v) => setSetting('uiVolume', v) }
    );
    return { title: 'Sound', rows, onOpen: () => loadOutputs() };
  }

  /** Update the party panel in place, or rebuild it when its rows changed. */
  refreshParty() {
    const sig = this.partySig();
    if (sig !== this.panel.partySig) {
      this.rebuildPanel();
      this.panel.partySig = sig;
    } else {
      this.panel.nav.els.forEach((el) => this.renderRow(el));
    }
  }

  partySig() {
    const st = party.state;
    if (!st) return 'none';
    return `${st.status}|${st.configured}|${st.authorized}|${st.channel ? st.channel.id : ''}|${st.members.map((m) => m.id).join(',')}`;
  }

  partyPanel() {
    const st = party.state;
    const openSetup = () => {
      this.close();
      this.router.open('settings', { category: 'users', section: 1 });
    };
    if (!st || st.status === 'setup') {
      return {
        title: 'Party',
        rows: [
          { icon: 'party', label: 'Connect Discord', sub: 'Mute, deafen and leave calls from here', chevron: true, run: openSetup },
        ],
      };
    }
    if (st.status !== 'ready') {
      const waiting = st.status === 'connecting' || st.status === 'authorizing';
      return {
        title: 'Party',
        rows: [
          waiting
            ? { icon: 'party', label: statusText(st), sub: st.status === 'authorizing' ? 'Discord is showing an Authorize prompt' : 'One moment…' }
            : {
                icon: st.status === 'offline' ? 'refresh' : 'link',
                label: st.status === 'offline' ? 'Discord isn’t running' : st.authorized ? 'Reconnect to Discord' : 'Connect to Discord',
                sub: st.status === 'offline' ? 'Start Discord, then select to retry' : st.error || 'Discord will ask you to authorize the launcher',
                run: () => discordConnect(),
              },
          { icon: 'settings', label: 'Discord Settings', chevron: true, run: openSetup },
        ],
      };
    }

    const v = () => (party.state && party.state.voice) || { mute: false, deaf: false, input: 100, output: 100 };
    const rows = [];
    const call = st.channel;
    if (call) {
      for (const m of st.members.slice(0, 8)) {
        rows.push({
          type: 'member',
          member: () => (party.state.members || []).find((x) => x.id === m.id),
          run: async () => {
            const cur = (party.state.members || []).find((x) => x.id === m.id);
            if (!cur || cur.self) return;
            await sliderDialog({
              title: `${cur.name} — ${t('Volume')}`,
              value: cur.volume,
              min: 0,
              max: 200,
              step: 10,
              onChange: (nv) => discordCmd('userVolume', nv, cur.id),
            });
          },
        });
      }
    }
    rows.push({
      type: 'buttons',
      labels: true,
      buttons: () => {
        const list = [
          { icon: v().mute ? 'micOff' : 'mic', label: v().mute ? 'Unmute' : 'Mute', on: v().mute, run: () => discordCmd('mute', !v().mute) },
          { icon: v().deaf ? 'headphonesOff' : 'headphones', label: v().deaf ? 'Undeafen' : 'Deafen', on: v().deaf, run: () => discordCmd('deaf', !v().deaf) },
        ];
        if (party.state && party.state.channel) list.push({ icon: 'phoneOff', label: 'Leave', danger: true, run: () => this.leaveCall() });
        return list;
      },
    });
    rows.push(
      { type: 'range', icon: 'volume', label: 'Voice Volume', max: 200, step: 10, value: () => v().output, set: (x) => discordCmd('output', x) },
      { type: 'range', icon: 'mic', label: 'Mic Volume', step: 5, value: () => v().input, set: (x) => discordCmd('input', x) }
    );
    return {
      title: call ? call.name : 'Party',
      subtitle: call ? call.guild || (call.dm ? 'Direct call' : '') : 'Not in a voice channel',
      rows,
      onOpen: () => {
        if (this.panel) this.panel.partySig = this.partySig();
      },
    };
  }

  async leaveCall() {
    const ch = party.state && party.state.channel;
    if (!ch) return;
    if (await confirmDialog({ title: t('Leave {name}?', { name: ch.name }), confirmLabel: 'Leave', danger: true })) discordCmd('leave');
  }

  gamePanel(g) {
    return {
      title: g.name,
      subtitle: sessionText(g),
      rows: [
        {
          icon: 'info',
          label: 'Game Details',
          chevron: true,
          run: () => {
            this.close();
            this.router.open('hub', { id: g.id });
          },
        },
        { icon: 'close', label: 'Close Game', danger: true, run: () => this.closeGame(g) },
      ],
    };
  }

  async closeGame(g) {
    const ok = await confirmDialog({ title: t('Close {name}?', { name: g.name }), message: 'Unsaved progress may be lost.', confirmLabel: 'Close Game', danger: true });
    if (!ok) return;
    if (this.overlay) {
      // The launcher hides this window itself once the home screen is in
      // front of the game; closing first would hand focus back to the game.
      try {
        await api.closeGame(g.id);
      } catch {}
      this.close();
      return;
    }
    this.close();
    try {
      await api.closeGame(g.id);
    } catch {}
  }

  bluetoothPanel() {
    const bt = sys.bt;
    if (!bt) {
      return { title: 'Bluetooth', rows: [{ icon: 'bluetooth', label: 'Bluetooth', value: 'Checking…' }], onOpen: () => loadBluetooth() };
    }
    if (!bt.available) {
      return { title: 'Bluetooth', rows: [{ icon: 'bluetooth', label: 'Bluetooth', sub: bt.error || 'No Bluetooth adapter found', value: 'Unavailable' }] };
    }
    const rows = [{ type: 'toggle', icon: 'bluetooth', label: 'Bluetooth', value: () => !!(sys.bt && sys.bt.on), toggle: () => setBluetooth(!(sys.bt && sys.bt.on)) }];
    if (bt.on) {
      for (const d of bt.devices.slice(0, 6)) {
        rows.push({
          icon: deviceIcon(d),
          label: d.name,
          sub: () => {
            const cur = (sys.bt && sys.bt.devices.find((x) => x.id === d.id)) || d;
            return deviceStatus(cur) + (cur.audio || cur.connected || cur.busy ? '' : ' · turn it on to connect');
          },
          value: d.audio && !d.busy ? (d.connected ? 'Disconnect' : 'Connect') : '',
          run: () => (d.audio ? connectDevice(d, !d.connected) : null),
        });
      }
    }
    rows.push({
      icon: 'plus',
      label: 'Add a Device…',
      chevron: true,
      run: () => {
        this.close();
        this.router.open('settings', { category: 'bluetooth', section: 1 });
      },
    });
    return { title: 'Bluetooth', rows, onOpen: () => loadBluetooth() };
  }

  accessoriesPanel() {
    const pads = connectedPads();
    return {
      title: 'Accessories',
      empty: 'No controllers connected. Press a button on your controller.',
      rows: pads.map((p) => ({
        icon: 'gamepad',
        label: p.id.replace(/\s*\(.*\)\s*$/, '') || 'Controller',
        sub: p.kind === 'ps' ? 'PlayStation controller' : 'Xbox / XInput controller',
        value: `#${p.index + 1}`,
        run: () => rumble(0.8, 260),
      })),
    };
  }

  displayPanel() {
    const s = () => state.settings;
    const rows = [];
    if (sys.displays === null) {
      rows.push({ icon: 'sun', label: 'Brightness', value: 'Checking…' });
    } else if (sys.displays.length) {
      const many = sys.displays.length > 1;
      sys.displays.forEach((d, i) =>
        rows.push({
          type: 'range',
          icon: 'sun',
          label: many ? `Brightness · ${d.name || `Display ${i + 1}`}` : 'Brightness',
          value: () => (sys.displays[i] ? sys.displays[i].percent : 0),
          set: (v) => setBrightness(i, v),
        })
      );
    } else {
      rows.push({ icon: 'sun', label: 'Brightness', sub: 'Turn on DDC/CI in your monitor menu', value: 'Not supported' });
    }
    if (sys.nightLight !== null) {
      rows.push({ type: 'toggle', icon: 'nightLight', label: 'Night Light', value: () => !!sys.nightLight, toggle: () => setNightLight(!sys.nightLight) });
    }
    rows.push(
      { type: 'toggle', icon: 'maximize', label: 'Full Screen', value: () => state.window.fullscreen, toggle: async () => setSetting('fullscreen', !state.window.fullscreen) },
      { type: 'toggle', icon: 'sparkle', label: 'Reduce Motion', value: () => s().reduceMotion, toggle: () => setSetting('reduceMotion', !s().reduceMotion) },
      {
        icon: 'display',
        label: 'Interface Size',
        value: () => `${s().uiScale || 100}%`,
        run: async () => {
          const steps = [80, 90, 100, 110, 125];
          const i = steps.indexOf(s().uiScale || 100);
          await setSetting('uiScale', steps[(i + 1) % steps.length]);
        },
      }
    );
    return {
      title: 'Screen',
      rows,
      onOpen: () => {
        if (sys.displays === null) loadBrightness();
        loadNightLight();
      },
    };
  }

  notificationsPanel() {
    const list = state.notifications.slice(0, 8);
    return {
      title: 'Notifications',
      empty: 'You have no notifications.',
      onOpen: () => {
        state.notifications.forEach((n) => (n.read = true));
        this.updateBadge();
      },
      rows: list.length
        ? [
            ...list.map((n) => ({ icon: n.icon || 'bell', label: n.title, sub: `${n.body ? `${t(n.body)} · ` : ''}${timeAgo(n.time)}`, run: () => {} })),
            {
              icon: 'trash',
              label: 'Clear All',
              run: () => {
                state.notifications = [];
                this.updateBadge();
                this.closePanel();
              },
            },
          ]
        : [],
    };
  }

  powerPanel() {
    const confirmRun = (title, message, label, fn) => async () => {
      if (await confirmDialog({ title, message, confirmLabel: label, danger: true })) fn();
    };
    return {
      title: 'Power',
      rows: [
        { icon: 'minimize', label: 'Minimize Launcher', run: () => (this.close(), api.windowAction('minimize')) },
        { icon: 'exit', label: 'Exit Launcher', run: confirmRun('Exit the launcher?', '', 'Exit', () => api.windowAction('close')) },
        { icon: 'moon', label: 'Sleep', run: confirmRun('Put the PC to sleep?', '', 'Sleep', () => api.power('sleep')) },
        { icon: 'restart', label: 'Restart PC', run: confirmRun('Restart the PC?', 'Unsaved work in other apps will be lost.', 'Restart', () => api.power('restart')) },
        { icon: 'power', label: 'Turn Off PC', danger: true, run: confirmRun('Turn off the PC?', 'Unsaved work in other apps will be lost.', 'Turn Off', () => api.power('shutdown')) },
      ],
    };
  }

  /* ---------------------------------------------------------------- */

  handle(action) {
    if (this.customizing) {
      if (action === 'left' || action === 'right') {
        if (this.barNav.move(action === 'left' ? -1 : 1)) sfx.move();
        else sfx.bump();
      } else if (action === 'confirm') this.toggleCustom(this.barNav.index);
      else if (action === 'back' || action === 'options') this.exitCustomize();
      else sfx.bump();
      return true;
    }
    if (action === 'options') {
      this.enterCustomize();
      return true;
    }
    if (action === 'back') {
      if (this.panel) this.closePanel();
      else this.close();
      return true;
    }
    if (this.zone === 'cards') {
      if (action === 'left' || action === 'right') this.cardNav.move(action === 'left' ? -1 : 1) ? sfx.move() : sfx.bump();
      else if (action === 'down') this.focus('bar', this.barNav.index);
      else if (action === 'confirm') {
        sfx.select();
        this.cards[this.cardNav.index].run();
      } else if (action === 'up') sfx.bump();
      return true;
    }
    if (this.zone === 'bar') {
      if (action === 'left' || action === 'right') {
        if (this.barNav.move(action === 'left' ? -1 : 1)) {
          sfx.move();
          if (this.panel) this.closePanelQuiet();
        } else {
          sfx.bump();
          bump(this.barNav.current, action);
        }
      } else if (action === 'up') {
        if (this.panel && this.panel.nav.els.length) {
          this.zone = 'panel';
          this.panel.nav.set(this.panel.nav.els.length - 1);
          sfx.move();
          this.applyFocus();
        } else if (!this.panel && this.cards.length) this.focus('cards', this.cardNav.index < 0 ? 0 : this.cardNav.index);
        else sfx.bump();
      } else if (action === 'confirm') this.activateBar(this.barNav.index);
      else if (action === 'down') sfx.bump();
      return true;
    }
    if (this.zone === 'panel' && this.panel) {
      const nav = this.panel.nav;
      if (action === 'up') {
        if (nav.move(-1)) {
          sfx.move();
          this.applyFocus();
        } else sfx.bump();
      } else if (action === 'down') {
        if (!nav.move(1)) this.zone = 'bar';
        sfx.move();
        this.applyFocus();
      } else if (action === 'left' || action === 'right') {
        if (!this.adjustRow(action === 'left' ? -1 : 1)) sfx.bump();
      } else if (action === 'confirm') this.activateRow(nav.current._row, nav.current);
      else if (action === 'x' && this.panel.player) mediaCommand('toggle');
      return true;
    }
    return true;
  }

  closePanelQuiet() {
    this.dismissPanelEl(this.panel.el);
    this.panel = null;
    this.setPanelOpen(false);
    this.applyFocus();
  }
}
