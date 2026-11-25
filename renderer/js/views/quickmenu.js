// Control-centre style quick menu (Guide / PS button, Home or F1).

import { h, escapeHtml, clamp, timeAgo, bump } from '../util.js';
import { icon } from '../icons.js';
import { state, on, api, artUrl, sortGames, gamesIn, setSetting, lastActive, emit, currentGame, activeDownloads, findGame, isInstalled } from '../state.js';
import { sfx } from '../sound.js';
import { mouseActive, connectedPads, rumble } from '../input.js';
import { mountOverlay, FocusList, topOverlay } from '../ui/overlay.js';
import { confirmDialog, sliderDialog, optionsMenu, textDialog } from '../ui/dialogs.js';
import { party, discordCmd, discordConnect, statusText, inCall, conversations, discordGuilds, discordVoiceChannels, discordDirectChats, joinVoice } from '../discord.js';
import { steam, loadFriends, openFriend, friendsList, onlineCount, presenceText } from '../steamfriends.js';
import { openChat } from '../ui/chat.js';
import { launchGame, PAD_EMULATION as EMULATION, emulationName, controllerModeLabel, padEmulationLabel, pickControllerMode, pickPadEmulation } from '../ui/gameactions.js';
import { tileArt } from '../ui/tiles.js';
import { renderHints } from '../ui/glyphs.js';
import { sliderHtml, setSlider, dragSlider } from '../ui/slider.js';
import { t } from '../i18n.js';
import { mainBattery, modelName, powerLabel, batteryText, connectionLabel } from '../dualsense.js';
import { statusText as dlStatus, progressOf, fmtLeft, pulsing } from '../ui/downloads.js';
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
  loadHdr,
  setHdr,
  hdrDisplays,
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

/** "Let's Play Games" -> "LPG": a server without an icon. */
function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}

// The Game Base's tabs as the PS5 draws them: solid shapes (white when open, grey otherwise),
// their faces and gaps cut out in the rail's colour (--gb-cut).
const CUT = 'var(--gb-cut)';
const RAIL_ICONS = {
  friends: `<rect x="9" y="2.5" width="12.5" height="12.5" rx="3.6" fill="currentColor"/><circle cx="13.5" cy="7.3" r="1.05" fill="${CUT}"/><circle cx="17.1" cy="7.3" r="1.05" fill="${CUT}"/><path d="M12.7 10.3c1.2 1.3 4.1 1.3 5.3 0" fill="none" stroke="${CUT}" stroke-width="1.4" stroke-linecap="round"/><rect x="2.5" y="9" width="12.5" height="12.5" rx="3.6" fill="currentColor" stroke="${CUT}" stroke-width="1.7"/><circle cx="7" cy="13.9" r="1.05" fill="${CUT}"/><circle cx="10.6" cy="13.9" r="1.05" fill="${CUT}"/><path d="M6.2 16.9c1.2 1.3 4.1 1.3 5.3 0" fill="none" stroke="${CUT}" stroke-width="1.4" stroke-linecap="round"/>`,
  headset: `<path d="M4.1 14.2V12a7.9 7.9 0 0 1 15.8 0v2.2" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><rect x="2.6" y="12.4" width="5.1" height="7.6" rx="2.2" fill="currentColor"/><rect x="16.3" y="12.4" width="5.1" height="7.6" rx="2.2" fill="currentColor"/><path d="M18.9 19.8c0 1.5-2 2.3-5.3 2.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
  messages: `<path d="M2.5 6A3.5 3.5 0 0 1 6 2.5h7A3.5 3.5 0 0 1 16.5 6v4A3.5 3.5 0 0 1 13 13.5H8.6L5 16.6v-3.3A3.5 3.5 0 0 1 2.5 10z" fill="currentColor"/><path d="M10.5 11A3.5 3.5 0 0 1 14 7.5h4.5A3.5 3.5 0 0 1 22 11v3.6a3.5 3.5 0 0 1-2.5 3.4v3.3L16 18.1h-2a3.5 3.5 0 0 1-3.5-3.5z" fill="currentColor" stroke="${CUT}" stroke-width="1.7"/>`,
  discord: `<path d="M19.3 5.4a16.3 16.3 0 0 0-4-1.3l-.5 1a15 15 0 0 0-5.6 0l-.5-1a16.3 16.3 0 0 0-4 1.3C2.2 9.2 1.5 12.9 1.9 16.6a16.4 16.4 0 0 0 5 2.5l1.1-1.7a10.6 10.6 0 0 1-1.7-.8l.4-.3a11.7 11.7 0 0 0 10.6 0l.4.3a10.6 10.6 0 0 1-1.7.8l1.1 1.7a16.4 16.4 0 0 0 5-2.5c.5-4.3-.7-8-2.8-11.2z" fill="currentColor"/><ellipse cx="8.6" cy="12.6" rx="1.65" ry="1.85" fill="${CUT}"/><ellipse cx="15.4" cy="12.6" rx="1.65" ry="1.85" fill="${CUT}"/>`,
};
const railIcon = (id) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${RAIL_ICONS[id] || ''}</svg>`;

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
    // Per-game settings (controller) changed from a menu: show them in the open panel.
    on('games', () => this.ctl && this.panel && this.panel.nav.els.forEach((el) => this.renderRow(el)));
    on('passthrough', () => this.ctl && this.panelIs('accessories') && this.panel.nav.els.forEach((el) => this.renderRow(el)));
    on('dualsense', () => {
      if (!this.ctl) return;
      this.updateBattery();
      if (this.panelIs('accessories')) this.rebuildPanel();
    });
    on('downloads', () => this.ctl && this.onDownloads());
    on('capture-saved', () => this.ctl && !this.panel && this.cardSignature() !== this.cardSig && this.renderCards(false));
    on('media', () => this.ctl && this.onMedia());
    on('volume', () => this.ctl && this.refreshRows('sound'));
    on('outputs', () => this.ctl && this.refreshRows('sound'));
    on('brightness', () => this.ctl && this.panelIs('display') && this.rebuildPanel());
    on('nightlight', () => this.ctl && this.panelIs('display') && this.rebuildPanel());
    on('hdr', () => this.ctl && this.panelIs('display') && this.rebuildPanel());
    on('bluetooth', () => this.ctl && this.panelIs('bluetooth') && this.rebuildPanel());
    on('discord', () => {
      if (!this.ctl) return;
      if (this.baseTab('party')) this.refreshParty();
      else if (this.baseTab('messages')) this.rebuildPanel();
      else if (!this.panel && this.cardSignature() !== this.cardSig) this.renderCards(false);
      if (this.panelIs('party')) this.renderRail();
      this.updatePartyIcon();
    });
    on('steamfriends', () => {
      if (!this.ctl) return;
      if (this.baseTab('friends')) this.refreshFriends();
      if (this.panelIs('party')) this.renderRail();
      this.updatePartyIcon();
    });
  }

  toggle() {
    if (this.ctl) this.close();
    else this.open();
  }

  close({ quiet = false } = {}) {
    if (!this.ctl) return;
    if (this.customizing) this.exitCustomize({ quiet: true });
    if (!quiet) sfx.menuOut();
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
      // Friends, Party and Messages in one card, as the PS5's Game Base (id kept from "Party").
      { id: 'party', icon: 'party', label: 'Social', panel: () => this.gameBasePanel() },
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
        h('span', { class: 'qm-active-dot', 'aria-hidden': 'true' }),
        it.id === 'notifications' ? h('span', { class: 'qm-badge' }) : null,
        it.id === 'music' ? h('span', { class: 'qm-eq', html: '<i></i><i></i><i></i>' }) : null,
        it.id === 'party' ? h('span', { class: 'qm-online' }) : null,
        it.id === 'accessories' ? h('span', { class: 'qm-batt', html: '<i></i>' }) : null,
        this.customizing && !FIXED.has(it.id) ? h('span', { class: `qm-check${hidden.has(it.id) ? '' : ' on'}`, html: icon('check') }) : null
      );
      return el;
    });
    this.barRow.replaceChildren(...barEls);
    this.updateBattery();
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
    // As on the PS5: no button prompts while customizing.
    renderHints(this.hints, []);
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
    el.classList.remove('press');
    void el.offsetWidth;
    el.classList.add('press');
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
    const games = gamesIn('game').filter(isInstalled);
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
    // A clip / screenshot just saved: its card opens the Media Gallery (as on the PS5).
    const shot = state.lastCapture;
    if (shot && Date.now() - shot.time < 30 * 60000) {
      const img = shot.image ? (window.appUrl ? window.appUrl(shot.image) : shot.image) : null;
      cards.push({
        capture: true,
        img,
        icon: shot.kind === 'screenshot' ? 'camera' : 'clipRecent',
        cap: shot.kind === 'screenshot' ? 'Screenshot' : shot.kind === 'recording' ? 'Recording' : 'Recent Gameplay',
        title: shot.title,
        sub: shot.game || ' ',
        run: () => {
          this.close();
          this.router.open('gallery');
        },
      });
    }
    // Steam updates under way: like the PS5's Downloads/Uploads card.
    const dls = activeDownloads();
    if (dls.length) {
      const d = dls[0];
      const g = d.gameId ? findGame(d.gameId) : null;
      cards.push({
        download: d.appid,
        img: g ? artUrl(g, 'hero') || artUrl(g, 'banner') : null,
        tile: g && !artUrl(g, 'hero') && !artUrl(g, 'banner') ? g : null,
        icon: 'download',
        cap: dls.length === 1 ? 'Downloads' : t('Downloads · {n}', { n: dls.length }),
        title: d.name,
        sub: ' ',
        run: () => this.openPanel(this.barIndex('notifications')),
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
        run: () => {
          this.gbTab = 'party';
          this.openPanel(this.barIndex('party'));
        },
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
      if (c.download) img.append(h('div', { class: 'qc-dl-bar' }, h('i')));
      return h(
        'button',
        {
          class: `qm-card fx${c.media ? ' media' : ''}${c.playing ? ' playing' : ''}${c.download ? ' download' : ''}${c.capture ? ' capture' : ''}${animate ? ' anim' : ''}`,
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
    this.layoutCards();
    this.cardSig = this.cardSignature();
    this.tickProgress();
    this.paintDownloadCard();
  }

  /** The download card's bar and words, in place. */
  paintDownloadCard() {
    const i = this.cards ? this.cards.findIndex((c) => c.download) : -1;
    if (i < 0 || !this.cardNav.els[i]) return;
    const d = activeDownloads().find((x) => x.appid === this.cards[i].download);
    if (!d) return;
    const el = this.cardNav.els[i];
    const bar = el.querySelector('.qc-dl-bar i');
    if (bar) bar.style.width = `${Math.max(1, progressOf(d) * 100)}%`;
    el.querySelector('.qc-dl-bar')?.classList.toggle('pulse', pulsing(d));
    const sub = el.querySelector('.qc-sub');
    if (sub) sub.textContent = [dlStatus(d), d.status === 'downloading' ? fmtLeft(d.eta) : ''].filter(Boolean).join(' · ');
  }

  onDownloads() {
    if (!this.panel && this.cardSignature() !== this.cardSig) this.renderCards(false);
    else this.paintDownloadCard();
    if (this.panelIs('notifications')) {
      const ids = activeDownloads().map((d) => d.appid).join(',');
      if (ids !== this.panel.dlIds) this.rebuildPanel();
      else this.panel.nav.els.forEach((el) => this.renderRow(el));
    }
  }

  cardSignature() {
    const m = sys.media;
    const st = party.state;
    const p = inCall() ? `${st.channel.id}|${st.members.map((x) => `${x.id}${x.speaking ? '*' : ''}`).join(',')}` : 'no-party';
    return (m && m.active ? `${m.app}|${m.key}|${m.status}|${sys.artKey}` : 'none') + '|' + p + '|' + activeDownloads().map((d) => d.appid).join(',') + '|' + (state.lastCapture ? state.lastCapture.time : '');
  }

  open() {
    sfx.menuIn();
    this.zone = 'bar';
    this.panel = null;
    this.cardNav = null;
    this.unwatch = watchMedia();
    loadVolume();
    loadOutputs();
    // Warm up the slower panels so they usually open fully populated.
    loadBluetooth();
    loadNightLight();
    loadHdr();
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
    // The Friends tab stays current while it is on screen (main asks Steam at most every 30 s).
    this.friendsTicker = setInterval(() => {
      if (this.baseTab('friends')) loadFriends();
      if (this.baseTab('discord')) this.loadDiscordView(true);
    }, 30000);
    this.ctl = mountOverlay(this.el, (a) => this.handle(a), {
      dimApp: true,
      closeDelay: 380,
      onClose: () => {
        this.ctl = null;
        clearInterval(this.ticker);
        clearInterval(this.friendsTicker);
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
    if (!b) return;
    const connected = inCall();
    const muted = !!(party.state?.voice?.mute || party.state?.voice?.deaf);
    // How many Steam friends are online, next to the icon (as the PS5 shows it).
    const n = onlineCount();
    const el = b.querySelector('.qm-online');
    if (el) {
      const mic = connected
        ? `<span class="qm-voice${muted ? ' muted' : ''}" role="img" aria-label="${escapeHtml(t(muted ? 'Microphone muted' : 'In voice chat'))}">${icon(muted ? 'micOff' : 'mic')}</span>`
        : '';
      const html = (n ? `<i></i>${n}` : '') + mic;
      if (el.innerHTML !== html) el.innerHTML = html;
    }
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

  /**
   * The cards as the PS5's carousel: the selected one grows (upwards, from the
   * row's bottom line) and the row slides so it stands in the slot at the
   * left, the one before it peeking in at the edge (css: .qm-cards, --qi).
   * A card the mouse points at grows in place, so the row doesn't slide away
   * from under the pointer.
   */
  layoutCards() {
    if (!this.cardRow || !this.cardNav) return;
    this.cardRow.classList.toggle('active', this.zone === 'cards');
    if (!this.cardMouse) this.cardRow.style.setProperty('--qi', String(Math.max(0, this.cardNav.index)));
  }

  focus(zone, i, fromMouse = false) {
    this.cardMouse = fromMouse && zone === 'cards';
    if (zone !== this.zone && !fromMouse) sfx.move();
    this.zone = zone;
    if (zone === 'cards') this.cardNav.set(i);
    if (zone === 'bar') this.barNav.set(i);
    this.applyFocus();
  }

  applyFocus() {
    this.layoutCards();
    this.cardNav && this.cardNav.blur();
    this.barNav.blur();
    if (this.panel) this.panel.nav.blur();
    if (this.panel && this.panel.rail) this.panel.rail.forEach((el, i) => el.classList.toggle('focused', this.zone === 'rail' && i === this.panel.railIndex));
    if (this.zone === 'cards' && this.cardNav) this.cardNav.refocus();
    else if (this.zone === 'bar') this.barNav.refocus();
    else if (this.zone === 'panel' && this.panel) {
      this.panel.nav.refocus();
      this.scrollToRow(this.panel.nav.current);
    }
    this.barNav.els.forEach((el, i) => el.classList.toggle('active', !!this.panel && i === this.panel.index));
    if (this.panel) this.panel.nav.els.forEach((el) => this.renderRow(el));
  }

  /**
   * Keep the focused row in view: on the first row the list goes back to its
   * very top (its title and anything above the row show again); a row right
   * under a section title ("Online: 4") brings the title along.
   */
  scrollToRow(cur) {
    if (!cur || !this.panel) return;
    const els = this.panel.nav.els;
    const first = els.find((el) => !el.classList.contains('disabled'));
    const box = this.panel.el.querySelector('.gb-main') || this.panel.el;
    if (cur === first) {
      box.scrollTop = 0;
      return;
    }
    const prev = cur.previousElementSibling;
    if (prev && prev._row && prev._row.type === 'section') prev.scrollIntoView({ block: 'nearest' });
    cur.scrollIntoView({ block: 'nearest' });
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
        class: `qp-row fx fx-in t-${r.type || 'action'}${r.danger ? ' danger' : ''}${r.cls ? ` ${r.cls}` : ''}`,
        onmouseenter: () => {
          if (mouseActive() && this.panel && r.type !== 'section') {
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
    const headIcon = def.tabs ? '' : it.game ? `<span class="qp-game-ic"><img src="${escapeHtml(gameIconUrl(it.game) || '')}" alt=""></span>` : icon(it.icon);
    let content = [
      h('div', {
        class: `qp-head${def.headClass ? ` ${def.headClass}` : ''}`,
        html: def.headHtml || `${headIcon}<span>${escapeHtml(t(def.title || it.label))}</span>${def.subtitle ? `<em>${escapeHtml(t(def.subtitle))}</em>` : ''}`,
      }),
      player,
      rows.length ? h('div', { class: 'qp-rows' }, ...rows) : h('div', { class: 'qp-empty', text: t(def.empty || 'Nothing here') }),
    ].filter(Boolean);
    // The Game Base: its tabs on a rail at the left, the open one's content beside it.
    let rail = null;
    if (def.tabs) {
      rail = def.tabs.map((tb) =>
        h('button', {
          class: `gb-tab fx gb-${tb.id}${tb.id === def.tab ? ' on' : ''}`,
          title: t(tb.label),
          html: (RAIL_ICONS[tb.icon] ? railIcon(tb.icon) : icon(tb.icon)) + '<i class="gb-dot"></i>',
          onclick: () => {
            this.zone = 'rail';
            this.switchTab(tb.id);
          },
        })
      );
      content = [h('div', { class: 'gb-rail' }, ...rail), h('div', { class: 'gb-main' }, ...content)];
    }
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
      panelEl = h('div', { class: `qm-panel${it.wide ? ' wide' : ''}${def.tabs ? ' gamebase' : ''}` }, ...content);
      this.panelHost.append(panelEl);
      const r = this.barNav.els[i].getBoundingClientRect();
      const pw = panelEl.offsetWidth;
      panelEl.style.left = `${clamp(r.left + r.width / 2 - pw / 2, 24, window.innerWidth - pw - 24)}px`;
    }
    const first = Math.max(0, def.rows.findIndex((r) => r.type !== 'section'));
    const nav = new FocusList(rows, { index: rebuild ? Math.max(first, Math.min(keepIndex, rows.length - 1)) : first });
    const tabs = def.tabs || null;
    this.panel = { index: i, el: panelEl, nav, rows: def.rows, player, dlIds: def.dlIds, rail, tabs, railIndex: tabs ? tabs.findIndex((x) => x.id === def.tab) : -1, sig: def.sig };
    if (rail) this.renderRail();
    if (!rebuild) {
      this.zone = rows.length ? 'panel' : rail ? 'rail' : 'bar';
      if (def.onOpen) def.onOpen();
    } else {
      if (def.onOpen && def.tab !== undefined && def.tab !== this.lastTabOpened) def.onOpen();
      if (this.zone === 'panel' && !rows.length) this.zone = rail ? 'rail' : 'bar';
    }
    this.lastTabOpened = def.tab;
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
    this.lastTabOpened = undefined;
    this.dcView = null;
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
        // Playback updates can arrive during the press animation. Keep the
        // button nodes alive while updating their icons and focus state.
        if (r.type === 'buttons' && !r.search && el.querySelector('.qp-btns')) {
          const template = document.createElement('template');
          template.innerHTML = html;
          const current = el.querySelectorAll('.qp-btn');
          const next = template.content.querySelectorAll('.qp-btn');
          if (current.length === next.length) {
            current.forEach((btn, i) => {
              const pressed = btn.classList.contains('pressed');
              btn.className = next[i].className + (pressed ? ' pressed' : '');
              btn.title = next[i].title;
              if (btn.innerHTML !== next[i].innerHTML) btn.innerHTML = next[i].innerHTML;
            });
            const labels = el.querySelectorAll('.qp-btnlbl');
            template.content.querySelectorAll('.qp-btnlbl').forEach((label, i) => {
              if (labels[i]) labels[i].textContent = label.textContent;
            });
            return;
          }
        }
        el.innerHTML = html;
      }
    };
    if (r.type === 'buttons' && r.search) {
      const [pill, sq] = r.buttons();
      put(`<span class="gb-search"><span class="gb-pill fx${focused && r.bi === 0 ? ' sel' : ''}" data-bi="0"><span>${escapeHtml(t(pill.label))}</span></span><span class="gb-sq fx${focused && r.bi === 1 ? ' sel' : ''}" data-bi="1" title="${escapeHtml(t(sq.label))}">${icon(sq.icon)}</span></span>`);
      return;
    }
    // Discord tab: Direct Voice Chats, a server, a voice channel / direct chat (who is in it on the right).
    if (r.type === 'dc') {
      const d = r.item();
      const lead = r.lead === 'phone'
        ? `<span class="dc-phone">${icon('phoneCall')}</span>`
        : r.lead === 'voice'
          ? `<span class="dc-vic">${icon(d.stage ? 'mic' : 'volume')}</span>`
          : `<span class="dc-gicon">${d.icon ? `<img src="${escapeHtml(d.icon)}" alt="" loading="lazy">` : `<b>${escapeHtml(initials(d.name))}</b>`}</span>`;
      const people = d.members || d.voice || [];
      const stack = people.length
        ? `<span class="dc-stack">${people.slice(0, 2).map((m) => `<span class="dc-av">${avatarFor(m)}</span>`).join('')}<span class="dc-count">${people.length}</span></span>`
        : '';
      const here = r.current && r.current();
      put(`${lead}<span class="qp-text"><span class="dc-name">${escapeHtml(t(d.name))}</span>${here ? `<span class="dc-here">${escapeHtml(t('You’re in this voice chat'))}</span>` : ''}</span>${stack}<i class="gb-sep"></i>`);
      return;
    }
    if (r.type === 'friend') {
      const f = r.friend();
      if (!f) return;
      el.classList.toggle('off', f.state === 'offline');
      const av = f.avatar ? `<img src="${escapeHtml(f.avatar)}" alt="" loading="lazy">` : avatarFor({ id: f.id, name: f.name });
      const dot = f.state === 'offline' ? '' : `<i class="gb-status ${f.state}"></i>`;
      put(
        `<span class="gb-av">${av}${dot}</span><span class="qp-text"><span class="gb-name">${escapeHtml(f.name)}</span><span class="gb-pres">${f.game ? icon('gamepad') : ''}<span>${escapeHtml(presenceText(f))}</span></span></span><i class="gb-sep"></i>`
      );
      return;
    }
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
    // Greyed out (and skipped by up / down); section titles are never focused.
    el.classList.toggle('disabled', r.type === 'section' || !!(typeof r.disabled === 'function' ? r.disabled() : r.disabled));
    if (r.type === 'section') {
      put(`<span class="qp-section">${escapeHtml(t(typeof r.label === 'function' ? r.label() : r.label))}</span>`);
      return;
    }
    if (r.type === 'download') {
      const d = r.download();
      if (!d) return;
      const g = d.gameId ? findGame(d.gameId) : null;
      const img = g && gameIconUrl(g);
      const left = d.status === 'downloading' ? fmtLeft(d.eta) : '';
      put(
        `<span class="qp-dl-cover">${img ? `<img src="${escapeHtml(img)}" alt="">` : icon('download')}</span><span class="qp-text"><span class="qp-label">${escapeHtml(d.name)}</span><span class="qp-dl-line"><span>${escapeHtml(dlStatus(d))}</span><span>${escapeHtml(left)}</span></span><span class="qp-dl-bar${pulsing(d) ? ' pulse' : ''}"><i style="width:${Math.max(d.status === 'downloading' ? 1 : 0, Math.round(progressOf(d) * 1000) / 10)}%"></i></span></span>`
      );
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
    if (typeof r.disabled === 'function' ? r.disabled() : r.disabled) {
      sfx.bump();
      return;
    }
    if (r.type === 'toggle') {
      sfx.toggle(!(typeof r.value === 'function' ? r.value() : r.value));
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
      // Other rows can depend on this one (Controller › Emulated Controller).
      if (this.panel && el.isConnected) this.panel.nav.els.forEach((x) => this.renderRow(x));
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
    sfx.slider(delta > 0);
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

  /* ------------------------------ Game Base ----------------------------- */

  /** Is the Game Base open on this tab? */
  baseTab(id) {
    return this.panelIs('party') && (this.gbTab || 'friends') === id;
  }

  /** The Game Base, on its open tab (Friends, Party or Messages), as on the PS5. */
  gameBasePanel() {
    const tab = this.gbTab || 'friends';
    const def = tab === 'party' ? this.partyPanel() : tab === 'messages' ? this.messagesPanel() : tab === 'discord' ? this.discordPanel() : this.friendsPanel();
    return {
      ...def,
      tab,
      tabs: [
        { id: 'friends', icon: 'friends', label: 'Friends' },
        { id: 'party', icon: 'headset', label: 'Party' },
        { id: 'messages', icon: 'messages', label: 'Messages' },
        { id: 'discord', icon: 'discord', label: 'Discord' },
      ],
    };
  }

  /** The rail's state: the open tab lit, friends online / a call going as a dot. */
  renderRail() {
    const p = this.panel;
    if (!p || !p.rail) return;
    const tab = this.gbTab || 'friends';
    p.rail.forEach((el, i) => {
      const id = p.tabs[i].id;
      el.classList.toggle('on', id === tab);
      el.classList.toggle('dot', id === 'friends' ? onlineCount() > 0 : id === 'party' ? inCall() : id === 'messages' ? conversations().some((c) => c.unread) : false);
    });
  }

  /** Show another tab of the Game Base (from its rail). */
  switchTab(id) {
    if (!this.panelIs('party')) return;
    if ((this.gbTab || 'friends') === id) {
      this.applyFocus();
      return;
    }
    this.gbTab = id;
    sfx.move();
    const zone = this.zone;
    this.openPanel(this.panel.index, { keepIndex: 0 });
    // The rows start from the top again; focus stays where it was (the rail).
    this.panel.nav.set(Math.max(0, this.panel.rows.findIndex((r) => r.type !== 'section')));
    this.zone = zone === 'rail' ? 'rail' : this.zone;
    this.panel.railIndex = this.panel.tabs.findIndex((x) => x.id === id);
    this.applyFocus();
  }

  friendsSig() {
    const st = steam.state;
    if (!st) return 'none';
    return `${st.configured}|${st.status}|${st.updated ? 1 : 0}|${this.friendFilter || ''}|${friendsList().map((f) => `${f.id}:${f.state === 'offline' ? 0 : 1}`).join(',')}`;
  }

  /** Friends changed: rebuild when who is where changed, else repaint the rows. */
  refreshFriends() {
    if (this.friendsSig() !== this.panel.sig) this.rebuildPanel();
    else this.panel.nav.els.forEach((el) => this.renderRow(el));
  }

  friendsPanel() {
    const st = steam.state;
    const setup = () => {
      this.close();
      this.router.open('settings', { category: 'users', section: 'Steam Friends' });
    };
    const sig = this.friendsSig();
    if (!st || !st.configured) {
      return {
        title: 'Friends',
        sig,
        rows: [{ icon: 'steam', label: 'Set Up Steam Friends', sub: 'See which friends are online and what they play', chevron: true, run: setup }],
      };
    }
    if (!st.updated) {
      const failed = st.status === 'error';
      return {
        title: 'Friends',
        sig,
        onOpen: () => loadFriends(),
        rows: failed
          ? [
              { icon: 'refresh', label: 'Couldn’t load your friends', sub: st.error || 'Select to try again', run: () => loadFriends({ refresh: true }) },
              { icon: 'settings', label: 'Steam Friends Settings', chevron: true, run: setup },
            ]
          : [{ icon: 'steam', label: 'Loading your friends…', sub: 'One moment…' }],
      };
    }
    const q = (this.friendFilter || '').toLowerCase();
    const list = friendsList().filter((f) => !q || f.name.toLowerCase().includes(q));
    const online = list.filter((f) => f.state !== 'offline');
    const offline = list.filter((f) => f.state === 'offline');
    const row = (f) => ({
      type: 'friend',
      friend: () => friendsList().find((x) => x.id === f.id) || f,
      run: (el) => this.friendMenu(friendsList().find((x) => x.id === f.id) || f, el),
    });
    return {
      title: 'Friends',
      sig,
      onOpen: () => loadFriends(),
      rows: [
        {
          type: 'buttons',
          search: true,
          cls: 'gb-search-row',
          buttons: () => [
            { label: this.friendFilter ? t('“{q}”', { q: this.friendFilter }) : 'Search Friends', run: () => this.searchFriends() },
            { icon: 'friendsCard', label: 'Open Steam Friends', run: () => openFriend('friends') },
          ],
        },
        { type: 'section', label: t('Online: {n}', { n: online.length }) },
        ...online.map(row),
        offline.length ? { type: 'section', label: t('Offline: {n}', { n: offline.length }) } : null,
        ...offline.map(row),
      ].filter(Boolean),
    };
  }

  async searchFriends() {
    const v = await textDialog({ title: 'Search Friends', value: this.friendFilter || '', placeholder: 'Name' });
    if (v === null) return;
    this.friendFilter = v.trim();
    if (this.panelIs('party')) this.rebuildPanel();
  }

  /** What to do with a friend: all of it happens in the Steam client. */
  async friendMenu(f, anchor) {
    const items = [{ id: 'message', label: 'Send Message', icon: 'chat' }];
    if (f.game && f.lobby) items.push({ id: 'join', label: t('Join {game}', { game: f.game }), icon: 'gamepad' });
    items.push({ id: 'profile', label: 'View Profile', icon: 'user' });
    const choice = await optionsMenu({ title: f.name, anchor, items });
    if (!choice) return;
    this.close();
    await openFriend(choice.id, f.id);
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
    if (!call) {
      rows.push({ icon: 'discord', label: 'Join a Voice Chat', sub: 'On your Discord servers, or call someone directly', chevron: true, run: () => this.switchTab('discord') });
    }
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
      { icon: 'volume', label: 'Voice Volume', value: () => `${v().output}%`, chevron: true, run: () => this.voiceSlider('output', 'Voice Volume', 200, 10) },
      { icon: 'mic', label: 'Mic Volume', value: () => `${v().input}%`, chevron: true, run: () => this.voiceSlider('input', 'Mic Volume', 100, 5) }
    );
    return {
      title: call ? call.name : 'Party',
      subtitle: call ? call.guild || (call.dm ? 'Direct call' : '') : 'Not in a voice chat',
      rows,
      onOpen: () => {
        if (this.panel) this.panel.partySig = this.partySig();
      },
    };
  }

  /** Discord's voice / mic volume, on a slider of its own (left / right stay for the rail). */
  async voiceSlider(kind, title, max, step) {
    const cur = () => ((party.state && party.state.voice) || {})[kind === 'output' ? 'output' : 'input'] ?? 100;
    const orig = cur();
    const v = await sliderDialog({ title: t(title), value: orig, min: 0, max, step, onChange: (nv) => discordCmd(kind, nv) });
    if (v === null) discordCmd(kind, orig);
  }

  /** The Discord tab's rows when Discord isn't connected (as the Party tab's). */
  discordSetupRows() {
    const def = this.partyPanel();
    return def.rows;
  }

  /**
   * The Discord tab, as on the PS5: Direct Voice Chats, then the servers with
   * who is in voice on each; a server opens its voice channels, a channel (or
   * direct chat) joins its call. Back goes up again.
   */
  discordPanel() {
    const st = party.state;
    if (!st || st.status !== 'ready') return { title: 'Discord', rows: this.discordSetupRows() };
    const user = st.user;
    const view = this.dcView || null;
    const here = (id) => () => !!(party.state && party.state.channel && party.state.channel.id === id);
    const failed = (list) => !list && this.dcError;
    const retry = () => ({ icon: 'refresh', label: 'Couldn’t load from Discord', sub: this.dcError, run: () => this.loadDiscordView(true) });
    if (view) {
      const list = view.type === 'direct' ? this.dcDirect : (this.dcChannels || {})[view.id];
      const loading = !list;
      if (failed(list)) return { title: view.name, rows: [retry()] };
      return {
        title: view.name,
        subtitle: view.type === 'direct' ? '' : 'Voice channels',
        onOpen: () => this.loadDiscordView(),
        empty: view.type === 'direct' ? 'Direct chats show up here once you’ve had a message or a call in them.' : 'This server has no voice channels.',
        rows: loading
          ? [{ icon: 'refresh', label: 'Loading…', disabled: true }]
          : list.map((c) => ({
              type: 'dc',
              lead: view.type === 'direct' ? 'server' : 'voice',
              item: () => ((view.type === 'direct' ? this.dcDirect : (this.dcChannels || {})[view.id]) || []).find((x) => x.id === c.id) || c,
              current: here(c.id),
              run: () => this.joinVoiceChat(c, view.type === 'direct'),
            })),
      };
    }
    const guilds = this.dcGuilds;
    return {
      headClass: 'dc-head',
      headHtml: `<span class="dc-badge">${icon('discord')}</span><span>Discord</span>${user ? `<span class="dc-user"><span>${escapeHtml(user.name)}</span><span class="dc-me">${avatarFor(user)}</span></span>` : ''}`,
      onOpen: () => this.loadDiscordView(),
      rows: [
        { type: 'dc', lead: 'phone', item: () => ({ name: 'Direct Voice Chats' }), run: () => this.openDcView({ type: 'direct', name: 'Direct Voice Chats' }) },
        ...(guilds
          ? guilds.map((g) => ({
              type: 'dc',
              lead: 'server',
              item: () => (this.dcGuilds || []).find((x) => x.id === g.id) || g,
              run: () => this.openDcView({ type: 'guild', id: g.id, name: g.name }),
            }))
          : failed(guilds)
            ? [retry()]
            : [{ icon: 'refresh', label: 'Loading your servers…', disabled: true }]),
      ],
    };
  }

  openDcView(view) {
    this.dcView = view;
    this.dcError = null;
    this.openPanel(this.panel.index, { keepIndex: 0 });
    this.panel.nav.set(0);
    this.zone = this.panel.nav.els.length ? 'panel' : 'rail';
    this.applyFocus();
    this.loadDiscordView();
  }

  /** Load what the Discord tab shows (servers, a server's voice channels, direct chats), then show it. */
  async loadDiscordView(fresh = false) {
    const view = this.dcView;
    try {
      if (!view) this.dcGuilds = await discordGuilds(fresh);
      else if (view.type === 'direct') this.dcDirect = await discordDirectChats();
      else this.dcChannels = { ...(this.dcChannels || {}), [view.id]: await discordVoiceChannels(view.id) };
      this.dcError = null;
    } catch (err) {
      // Keep what was shown; with nothing yet, the tab says it couldn't load (and can retry).
      this.dcError = String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
    if (this.baseTab('discord') && this.dcView === view) this.rebuildPanel();
  }

  /** Join a voice channel or a direct chat's call; a call nobody is in yet rings, so it asks first. */
  async joinVoiceChat(c, direct) {
    const cur = party.state && party.state.channel;
    if (cur && cur.id === c.id) {
      this.switchTab('party');
      return;
    }
    if (direct && !(c.members || []).length) {
      const ok = await confirmDialog({ title: t('Call {name}?', { name: c.name }), message: cur ? t('You’ll leave {name}.', { name: cur.name }) : '', confirmLabel: 'Call' });
      if (!ok) return;
    } else if (cur) {
      const ok = await confirmDialog({ title: t('Join {name}?', { name: c.name }), message: t('You’ll leave {name}.', { name: cur.name }), confirmLabel: 'Join' });
      if (!ok) return;
    }
    if (await joinVoice(c.id)) {
      sfx.select();
      this.dcView = null;
      this.switchTab('party');
    }
  }

  async leaveCall() {
    const ch = party.state && party.state.channel;
    if (!ch) return;
    if (await confirmDialog({ title: t('Leave {name}?', { name: ch.name }), confirmLabel: 'Leave', danger: true })) discordCmd('leave');
  }

  gamePanel(g) {
    const game = () => state.games.find((x) => x.id === g.id) || g;
    const pad = state.settings.controllerPassthrough
      ? [
          { icon: 'gamepad', label: 'Controller', value: () => controllerModeLabel(game()), chevron: true, run: (el) => pickControllerMode(game(), el) },
          {
            icon: 'gamepad',
            label: 'Emulated Controller',
            sub: () => (game().controllerMode === 'real' ? 'Not used with the real controller' : ''),
            value: () => (game().controllerMode === 'real' ? '' : padEmulationLabel(game())),
            disabled: () => game().controllerMode === 'real',
            chevron: true,
            run: (el) => pickPadEmulation(game(), el),
          },
        ]
      : [];
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
        ...pad,
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

  /** The DualSense battery on the Accessories icon, as in the PS5's control center. */
  updateBattery() {
    const el = this.barRow && this.barRow.querySelector('.qm-accessories .qm-batt');
    if (!el) return;
    const p = mainBattery();
    el.parentElement.classList.toggle('has-batt', !!p);
    if (!p) return;
    el.style.setProperty('--lvl', `${Math.max(6, p.battery)}%`);
    el.classList.toggle('low', p.battery <= 15 && p.power === 'discharging');
    el.classList.toggle('charging', p.power === 'charging');
  }

  accessoriesPanel() {
    // DualSense controllers come with what they report (battery, connection);
    // the browser's own entry for them (the virtual one, too) is left out.
    const ds = state.dualsense || [];
    const rows = ds.map((p) => ({
      icon: 'gamepad',
      label: modelName(p),
      sub: `${t(connectionLabel(p))} · ${t(p.power ? powerLabel(p) : 'Unknown')}`,
      value: batteryText(p),
      run: () => rumble(0.8, 260),
    }));
    const pads = connectedPads().filter((p) => !(ds.length && /product: 0?(ce6|df2)/i.test(p.id)));
    rows.push(
      ...pads.map((p) => ({
        icon: 'gamepad',
        label: p.id.replace(/\s*\(.*\)\s*$/, '') || 'Controller',
        sub: p.kind === 'ps' ? 'PlayStation controller' : 'Xbox / XInput controller',
        value: `#${p.index + 1}`,
        run: () => rumble(0.8, 260),
      }))
    );
    // Controller passthrough: what games see the DualSense as. In a game that
    // has its own choice (Options › Emulated Controller) that one shows, and
    // changing it here changes it for that game.
    if (state.settings.controllerPassthrough) {
      const st = state.passthrough || {};
      const game = () => {
        const g = currentGame();
        return g && g.controllerMode !== 'real' ? g : null;
      };
      rows.push({
        icon: 'gamepad',
        label: 'Emulate DualSense As',
        sub: () => {
          const g = game();
          if (st.realGame) return t('Off while {name} uses the real controller', { name: st.realGame });
          if (g) return g.padEmulation && g.padEmulation !== 'default' ? t('For {name}', { name: g.name }) : t('{name} uses the default', { name: g.name });
          return 'What games see your controller as';
        },
        value: () => {
          const g = game();
          return g ? padEmulationLabel(g) : emulationName(state.settings.passthroughEmulation);
        },
        run: async (el) => {
          const g = game();
          if (g) return pickPadEmulation(g, el);
          const cur = state.settings.passthroughEmulation || 'dualsense';
          const choice = await optionsMenu({
            title: 'Emulate DualSense As',
            anchor: el,
            index: Math.max(0, EMULATION.findIndex((m) => m.value === cur)),
            items: EMULATION.map((m) => ({ ...m, checked: m.value === cur })),
          });
          if (choice && choice.value !== cur) await setSetting('passthroughEmulation', choice.value);
        },
      });
    }
    return {
      title: 'Accessories',
      empty: 'No controllers connected. Press a button on your controller.',
      rows,
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
    const hdr = hdrDisplays();
    for (const d of hdr) {
      rows.push({
        type: 'toggle',
        icon: 'display',
        label: hdr.length > 1 ? `HDR · ${d.name || `Display ${d.index + 1}`}` : 'HDR',
        value: () => !!(sys.hdr[d.index] && sys.hdr[d.index].on),
        toggle: () => setHdr(d.index, !(sys.hdr[d.index] && sys.hdr[d.index].on)),
      });
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
        loadHdr();
      },
    };
  }

  messagesPanel() {
    const st = party.state;
    const openSetup = () => {
      this.close();
      this.router.open('settings', { category: 'users', section: 'Discord' });
    };
    if (!st || st.status !== 'ready') {
      return {
        title: 'Messages',
        rows: [{ icon: 'party', label: st && st.configured ? statusText(st) : 'Connect Discord', sub: 'See your Discord messages here', chevron: true, run: () => (st && st.configured ? discordConnect() : openSetup()) }],
      };
    }
    if (!st.messages) {
      return {
        title: 'Messages',
        rows: [{ icon: 'chat', label: 'Allow Messages', sub: 'Discord asks you to authorize the launcher once more', chevron: true, run: () => discordConnect() }],
      };
    }
    const list = conversations();
    return {
      title: 'Messages',
      empty: 'New Discord messages show up here.',
      rows: list.map((c) => ({
        icon: 'chat',
        label: c.name,
        sub: () => {
          const cur = conversations().find((x) => x.channelId === c.channelId) || c;
          return `${cur.last ? `${cur.last} · ` : ''}${timeAgo(cur.time)}`;
        },
        value: () => {
          const cur = conversations().find((x) => x.channelId === c.channelId) || c;
          return cur.unread ? String(cur.unread) : '';
        },
        chevron: true,
        run: () => openChat(c),
      })),
    };
  }

  notificationsPanel() {
    const list = state.notifications.slice(0, 8);
    // Steam updates under way come first, with their progress (opens Downloads).
    const dls = activeDownloads();
    const dlRows = dls.length
      ? [
          { type: 'section', label: () => t('Downloads in progress: {n}', { n: activeDownloads().length }) },
          ...dls.slice(0, 4).map((d) => ({
            type: 'download',
            download: () => activeDownloads().find((x) => x.appid === d.appid),
            run: () => {
              this.close();
              this.router.open('downloads', { appid: d.appid });
            },
          })),
          list.length ? { type: 'section', label: 'Notifications' } : null,
        ].filter(Boolean)
      : [];
    return {
      title: dls.length ? 'Downloads and Notifications' : 'Notifications',
      empty: 'You have no notifications.',
      dlIds: dls.map((d) => d.appid).join(','),
      onOpen: () => {
        state.notifications.forEach((n) => (n.read = true));
        this.updateBadge();
      },
      rows: list.length || dlRows.length
        ? [
            ...dlRows,
            ...list.map((n) => ({ icon: n.icon || 'bell', label: n.title, sub: `${n.body ? `${t(n.body)} · ` : ''}${timeAgo(n.time)}`, run: () => {} })),
            list.length ? {
              icon: 'trash',
              label: 'Clear All',
              run: () => {
                state.notifications = [];
                this.updateBadge();
                this.closePanel();
              },
            } : null,
          ].filter(Boolean)
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
      if (this.panel && this.baseTab('discord') && this.dcView) {
        this.dcView = null;
        sfx.back();
        this.openPanel(this.panel.index, { keepIndex: 0 });
        this.applyFocus();
        this.loadDiscordView();
      } else if (this.panel) this.closePanel();
      else this.close();
      return true;
    }
    if (this.zone === 'cards') {
      if (action === 'left' || action === 'right') {
        this.cardMouse = false;
        if (this.cardNav.move(action === 'left' ? -1 : 1)) sfx.move();
        else sfx.bump();
        this.layoutCards();
      }
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
        if (this.panel && this.panel.rail) {
          // Return to the selected Social tab, without jumping to the last server.
          this.zone = 'rail';
          sfx.move();
          this.applyFocus();
        } else if (this.panel && this.panel.nav.els.length) {
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
    if (this.zone === 'rail' && this.panel && this.panel.rail) {
      const p = this.panel;
      if (action === 'up' || action === 'down') {
        const next = p.railIndex + (action === 'up' ? -1 : 1);
        if (next < 0) sfx.bump();
        else if (next >= p.rail.length) {
          this.zone = 'bar';
          sfx.move();
          this.applyFocus();
        } else {
          p.railIndex = next;
          this.switchTab(p.tabs[next].id);
        }
      } else if (action === 'right' || action === 'confirm') {
        if (p.nav.els.length) {
          this.zone = 'panel';
          sfx.move();
          this.applyFocus();
        } else sfx.bump();
      } else sfx.bump();
      return true;
    }
    if (this.zone === 'panel' && this.panel) {
      const nav = this.panel.nav;
      // Left from the content goes to the Game Base's rail (sliders keep it, a row of buttons once at its first).
      if (action === 'left' && this.panel.rail) {
        const r = nav.current && nav.current._row;
        if (!r || (r.type !== 'range' && !(r.type === 'buttons' && r.bi > 0))) {
          this.zone = 'rail';
          sfx.move();
          this.applyFocus();
          return true;
        }
      }
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
