// Home screen: top bar, game carousel (selected tile is larger), hero art and
// the game hub content beneath it.

import { h, debounce, bump, replayClass, sleep } from '../util.js';
import { icon } from '../icons.js';
import { state, on, emit, homeGames, gamesIn, artUrl, sourceLabel, api } from '../state.js';
import { sfx } from '../sound.js';
import { rumble, mouseActive } from '../input.js';
import { FocusList } from '../ui/overlay.js';
import { heroBg } from '../ui/herobg.js';
import { tileArt, specialArt } from '../ui/tiles.js';
import { HubPanel } from '../ui/gamehub.js';
import { launchGame, gameOptions, isRunning } from '../ui/gameactions.js';
import { optionsMenu } from '../ui/dialogs.js';
import { avatarHtml } from '../ui/avatar.js';
import { sys, watchMedia, pollMedia, appName } from '../system.js';
import { t } from '../i18n.js';

const BIG = 16.8;
const SMALL = 10.6;
const GAP = 1.25;
const ANCHOR = 17.4;

export class HomeView {
  constructor(router) {
    this.router = router;
    this.name = 'home';
    this.usesHero = true;
    this.tab = 'game';
    this.items = [];
    this.sel = 0;
    this.zone = 'carousel';
    this.selByTab = { game: null, media: null };
    this.tileEls = new Map();
    this.build();
    this.updateHeroSoon = debounce(() => this.updateHero(), 110);

    on('games', () => this.refresh());
    on('media', () => {
      if (this.tab !== 'media') return;
      this.refresh();
      this.hub.tickNowPlaying();
      if (this.active && this.items[this.sel]?.type === 'nowplaying') this.updateHero();
    });
    setInterval(() => this.active && this.tab === 'media' && this.hub.tickNowPlaying(), 500);
    on('running', () => this.refresh());
    on('settings', (k) => {
      if (k === null || ['homeCount', 'homeSort', 'showStore', 'tileStyle', 'profileName', 'avatar'].includes(k)) this.refresh(true);
    });
  }

  build() {
    this.tabs = [h('button', { class: 'tb-tab fx', text: t('Games'), dataset: { tab: 'game' } }), h('button', { class: 'tb-tab fx', text: t('Media'), dataset: { tab: 'media' } })];
    this.searchBtn = h('button', { class: 'tb-icon fx', html: icon('search'), title: 'Search' });
    this.settingsBtn = h('button', { class: 'tb-icon fx', html: icon('settings'), title: 'Settings' });
    this.profileBtn = h('button', { class: 'tb-icon tb-profile fx', title: 'Profile' });
    this.clockEl = h('div', { class: 'tb-clock', dataset: { clock: '' } });
    this.topItems = [...this.tabs, this.searchBtn, this.settingsBtn, this.profileBtn];
    this.topNav = new FocusList(this.topItems);
    this.topNav.blur();
    this.topItems.forEach((el, i) => {
      el.addEventListener('mouseenter', () => mouseActive() && this.focusZone('top', i, true));
      el.addEventListener('click', () => {
        this.focusZone('top', i, true);
        this.activateTop(i);
      });
    });

    this.topbar = h(
      'header',
      { class: 'topbar' },
      h('nav', { class: 'tb-tabs' }, ...this.tabs),
      h('div', { class: 'tb-right' }, this.searchBtn, this.settingsBtn, this.profileBtn, this.clockEl)
    );

    this.carousel = h('div', { class: 'carousel' });
    this.titleEl = h('div', { class: 'tile-title' });
    this.carousel.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const now = performance.now();
        if (now - (this.lastWheel || 0) < 80) return;
        this.lastWheel = now;
        this.focusZone('carousel');
        this.moveSel((e.deltaY || e.deltaX) > 0 ? 1 : -1);
      },
      { passive: false }
    );

    this.hub = new HubPanel({
      onFocusRequest: (zone, i, how) => {
        // Hovering must not scroll the page between the hero and the cards.
        if (how === 'hover' && (zone === 'cards') !== (this.zone === 'cards')) return;
        this.focusZone(zone, i, true);
      },
      openView: (name, params) => this.router.open(name, params),
    });

    this.scroller = h('div', { class: 'home-scroller' }, this.carousel, this.titleEl, this.hub.el);
    this.el = h('section', { class: 'view home-view' }, this.topbar, this.scroller);
    this.el.addEventListener(
      'wheel',
      (e) => {
        if (this.carousel.contains(e.target)) return;
        const now = performance.now();
        if (now - (this.lastPageWheel || 0) < 350) return;
        this.lastPageWheel = now;
        if (e.deltaY > 0 && this.zone !== 'cards' && this.hub.hasCards()) this.focusZone('cards', 0);
        else if (e.deltaY < 0 && this.zone === 'cards') this.focusZone('actions', 0);
      },
      { passive: true }
    );
  }

  /* ---------------------------------------------------------------- */
  /* Data                                                              */
  /* ---------------------------------------------------------------- */

  buildItems() {
    const s = state.settings;
    const items = [];
    if (this.tab === 'game') {
      const list = homeGames('game');
      if (s.showStore !== false) items.push({ type: 'store', key: 'store' });
      if (!state.games.length) items.push({ type: 'add', key: 'add' });
      for (const g of list) items.push({ type: 'game', key: `g:${g.id}`, game: g });
    } else {
      const list = homeGames('media');
      if (sys.media && sys.media.active) items.push({ type: 'nowplaying', key: 'nowplaying' });
      for (const g of list) items.push({ type: 'game', key: `g:${g.id}`, game: g });
      if (!list.length && !items.length) items.push({ type: 'media-empty', key: 'media-empty' });
    }
    items.push({ type: 'library', key: 'library' });
    return items;
  }

  defaultIndex(items) {
    const i = items.findIndex((it) => it.type === 'game' || it.type === 'add' || it.type === 'media-empty' || it.type === 'nowplaying');
    return i >= 0 ? i : 0;
  }

  refresh(force = false) {
    const prevKey = this.items[this.sel] && this.items[this.sel].key;
    const items = this.buildItems();
    const sig =
      items.map((i) => `${i.key}|${i.game ? `${i.game.artVersion}|${i.game.name}|${isRunning(i.game)}` : ''}`).join(',') +
      state.settings.tileStyle +
      (this.tab === 'media' && sys.media && sys.media.active ? `|${sys.media.app}|${sys.media.key}|${sys.media.status}|${sys.artKey}` : '');
    if (!force && sig === this.sig) {
      // Data may still have changed (playtime etc.) — refresh hub quietly.
      const cur = this.items[this.sel];
      if (cur && cur.game) {
        const fresh = items.find((i) => i.key === cur.key);
        if (fresh) {
          this.items = items;
          const g = fresh.game;
          const hubSig = JSON.stringify([g.name, g.meta, g.art, g.artVersion, g.playtime, g.steamPlaytime, g.lastPlayed, g.steamLastPlayed, g.launchCount, g.favorite, isRunning(g)]);
          if (hubSig !== this.hubSig) {
            this.hubSig = hubSig;
            this.hub.setItem(fresh, { animate: false });
            this.restoreFocusVisual();
          }
        }
      }
      return;
    }
    this.sig = sig;
    this.items = items;
    let idx = items.findIndex((i) => i.key === prevKey);
    if (idx < 0) idx = this.defaultIndex(items);
    this.sel = idx;
    this.renderTiles();
    this.layout();
    this.updateTitle(false);
    const cur = this.items[this.sel];
    this.hub.setItem(cur, { animate: cur && cur.key !== this.hubKey });
    this.hubKey = cur && cur.key;
    if (this.zone === 'cards' && !this.hub.hasCards()) this.zone = 'actions';
    this.restoreFocusVisual();
    this.updateHeroSoon();
    this.profileBtn.innerHTML = `${avatarHtml('tb-avatar')}<i class="tb-online"></i>`;
  }

  renderTiles() {
    const keep = new Map();
    const frag = document.createDocumentFragment();
    this.items.forEach((it, i) => {
      const sig = it.game
        ? `${it.game.artVersion}|${it.game.name}|${state.settings.tileStyle}|${isRunning(it.game)}`
        : it.type === 'nowplaying'
          ? `np|${sys.artKey}`
          : it.type;
      let el = this.tileEls.get(it.key);
      if (!el || el._sig !== sig) {
        const art =
          it.type === 'game'
            ? tileArt(it.game)
            : it.type === 'nowplaying'
              ? sys.art
                ? h('div', { class: 'tile-art cover' }, h('img', { class: 'ta-img', src: sys.art, alt: '' }))
                : specialArt('media')
              : specialArt(it.type === 'media-empty' ? 'media' : it.type);
        const inner = h('div', { class: 'tile-inner' }, art);
        el = h('div', { class: `tile tile-${it.type} fx` }, inner);
        if (it.game && isRunning(it.game)) el.append(h('div', { class: 'tile-running' }));
        el._sig = sig;
        el.addEventListener('click', () => this.onTileClick(el));
      }
      el._index = i;
      el.style.setProperty('--i', i);
      keep.set(it.key, el);
      frag.append(el);
    });
    this.carousel.innerHTML = '';
    this.carousel.append(frag);
    this.tileEls = keep;
  }

  onTileClick(el) {
    const i = el._index;
    if (i === this.sel && this.zone === 'carousel') {
      this.activateTile();
      return;
    }
    this.focusZone('carousel');
    this.select(i);
  }

  layout() {
    const k = SMALL / BIG;
    this.items.forEach((it, i) => {
      const el = this.tileEls.get(it.key);
      if (!el) return;
      let x;
      let s = k;
      if (i === this.sel) {
        x = ANCHOR;
        s = 1;
      } else if (i > this.sel) x = ANCHOR + BIG + GAP + (i - this.sel - 1) * (SMALL + GAP);
      else x = ANCHOR - (this.sel - i) * (SMALL + GAP);
      el.style.transform = `translate3d(${x}rem,0,0) scale(${s})`;
      el.classList.toggle('sel', i === this.sel);
      el.classList.toggle('off', x < -SMALL || x > 260);
      el.classList.toggle('before', i < this.sel);
    });
  }

  updateTitle(animate = true) {
    const it = this.items[this.sel];
    let html = '';
    if (it) {
      if (it.type === 'game') html = `<span class="badge">${sourceLabel(it.game)}</span><span class="tt-name"></span>`;
      else if (it.type === 'nowplaying') html = `<span class="badge">${t('NOW PLAYING')}</span><span class="tt-name"></span>`;
      else html = '<span class="tt-name"></span>';
    }
    this.titleEl.innerHTML = html;
    const nameEl = this.titleEl.querySelector('.tt-name');
    if (nameEl) {
      nameEl.textContent =
        it.type === 'game'
          ? it.game.name
          : it.type === 'nowplaying'
            ? appName(sys.media && sys.media.app)
            : t({ library: 'Game Library', store: 'Steam Store', add: 'Add Games', 'media-empty': 'Media' }[it.type] || '');
    }
    if (animate) replayClass(this.titleEl, 'swap');
  }

  updateHero() {
    if (!this.active) return;
    const it = this.items[this.sel];
    if (it && it.type === 'nowplaying') {
      heroBg.set(sys.art, { blur: true });
      return;
    }
    const url = it && it.type === 'game' ? artUrl(it.game, 'hero') : null;
    heroBg.set(url);
  }

  /* ---------------------------------------------------------------- */
  /* Focus                                                             */
  /* ---------------------------------------------------------------- */

  select(i, { sound = true } = {}) {
    if (i < 0 || i >= this.items.length || i === this.sel) return false;
    this.sel = i;
    this.selByTab[this.tab] = this.items[i].key;
    if (sound) sfx.move();
    this.layout();
    this.updateTitle();
    const cur = this.items[i];
    this.hub.setItem(cur);
    this.hubKey = cur.key;
    this.restoreFocusVisual();
    this.updateHeroSoon();
    return true;
  }

  moveSel(d) {
    if (!this.select(this.sel + d)) {
      sfx.bump();
      rumble(0.3);
      const el = this.tileEls.get(this.items[this.sel]?.key);
      bump(el?.firstElementChild, d < 0 ? 'left' : 'right');
    }
  }

  focusZone(zone, index = null, fromMouse = false) {
    if (zone === 'cards' && !this.hub.hasCards()) return;
    const changed = zone !== this.zone;
    this.zone = zone;
    if (zone === 'top' && index !== null) this.topNav.set(index, { silent: true });
    if (zone === 'actions' && index !== null) this.hub.actions.set(index);
    if (zone === 'cards' && index !== null) this.hub.cardNav.set(index);
    if (changed && !fromMouse) sfx.move();
    this.restoreFocusVisual();
  }

  restoreFocusVisual() {
    const z = this.zone;
    this.topNav.blur();
    this.hub.actions.blur();
    this.hub.cardNav.blur();
    this.tileEls.forEach((el) => el.classList.remove('focused'));
    if (z === 'top') this.topNav.refocus();
    else if (z === 'carousel') {
      const el = this.tileEls.get(this.items[this.sel]?.key);
      if (el) el.classList.add('focused');
    } else if (z === 'actions') this.hub.actions.refocus();
    else if (z === 'cards') this.hub.cardNav.refocus();

    this.el.classList.toggle('scrolled', z === 'cards');
    heroBg.deep(z === 'cards');
    this.tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === this.tab));
  }

  switchTab(tab) {
    if (tab === this.tab) return;
    this.selByTab[this.tab] = this.items[this.sel]?.key;
    this.tab = tab;
    sfx.select();
    this.syncMediaWatch();
    if (tab === 'media' && !sys.media) pollMedia();
    this.carousel.classList.add('switching');
    this.titleEl.classList.add('switching');
    setTimeout(() => {
      this.sig = null;
      const want = this.selByTab[tab];
      this.items = [];
      this.refresh(true);
      const idx = want ? this.items.findIndex((i) => i.key === want) : -1;
      if (idx >= 0 && idx !== this.sel) this.select(idx, { sound: false });
      this.carousel.classList.remove('switching');
      this.titleEl.classList.remove('switching');
      replayClass(this.carousel, 'tab-in');
    }, 170);
  }

  activateTop(i) {
    const el = this.topItems[i];
    if (el.dataset.tab) return this.switchTab(el.dataset.tab);
    sfx.select();
    if (el === this.searchBtn) this.router.openSearch();
    else if (el === this.settingsBtn) this.router.open('settings');
    else if (el === this.profileBtn) this.profileMenu();
  }

  profileMenu() {
    optionsMenu({
      title: state.settings.profileName || 'Player',
      anchor: this.profileBtn,
      items: [
        { label: 'Profile Settings', icon: 'user', run: () => this.router.open('settings', { category: 'users' }) },
        { label: state.window.fullscreen ? 'Switch to Window' : 'Switch to Full Screen', icon: state.window.fullscreen ? 'minimize' : 'maximize', run: () => api.windowAction('toggleFullscreen') },
        { label: 'Minimize Launcher', icon: 'minimize', run: () => api.windowAction('minimize') },
        { label: 'Exit Launcher', icon: 'exit', run: () => api.windowAction('close') },
      ],
    });
  }

  activateTile() {
    const it = this.items[this.sel];
    if (!it) return;
    const el = this.tileEls.get(it.key);
    replayClass(el?.firstElementChild, 'press');
    if (it.type === 'game') launchGame(it.game);
    else if (it.type === 'library' || it.type === 'media-empty') {
      sfx.select();
      this.router.open('library', { tab: this.tab === 'media' ? 'media' : 'game' });
    } else if (it.type === 'store') {
      sfx.select();
      api.openExternal('steam://store');
    } else if (it.type === 'add') {
      sfx.select();
      api.addFolder();
    }
  }

  /** Bring a specific game into focus (used by search / library). */
  focusGame(id) {
    const idx = this.items.findIndex((i) => i.game && i.game.id === id);
    if (idx >= 0) {
      this.zone = 'carousel';
      this.select(idx, { sound: false });
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  handle(action) {
    if (action === 'l1') return this.switchTab('game'), true;
    if (action === 'r1') return this.switchTab('media'), true;
    if (action === 'search') return this.router.openSearch(), true;

    switch (this.zone) {
      case 'top':
        return this.handleTop(action);
      case 'carousel':
        return this.handleCarousel(action);
      case 'actions':
        return this.handleActions(action);
      case 'cards':
        return this.handleCards(action);
    }
    return false;
  }

  handleTop(action) {
    if (action === 'left' || action === 'right') {
      if (this.topNav.move(action === 'left' ? -1 : 1)) sfx.move();
      else sfx.bump();
    } else if (action === 'down' || action === 'back') {
      if (action === 'back') sfx.back();
      this.focusZone('carousel');
    } else if (action === 'confirm') {
      this.activateTop(this.topNav.index);
    } else if (action === 'up') sfx.bump();
    return true;
  }

  handleCarousel(action) {
    switch (action) {
      case 'left':
        this.moveSel(-1);
        break;
      case 'right':
        this.moveSel(1);
        break;
      case 'up':
        this.topNav.set(this.tab === 'media' ? 1 : 0, { silent: true });
        this.focusZone('top');
        break;
      case 'down':
        this.focusZone('actions', 0);
        break;
      case 'confirm':
        this.activateTile();
        break;
      case 'options': {
        const it = this.items[this.sel];
        if (it && it.type === 'game') gameOptions(it.game, this.tileEls.get(it.key));
        break;
      }
      case 'back': {
        const first = this.defaultIndex(this.items);
        if (this.sel !== first) {
          sfx.back();
          this.select(first, { sound: false });
        }
        break;
      }
      default:
        return false;
    }
    return true;
  }

  handleActions(action) {
    switch (action) {
      case 'left':
      case 'right':
        if (this.hub.actions.move(action === 'left' ? -1 : 1)) sfx.move();
        else sfx.bump();
        break;
      case 'up':
      case 'back':
        if (action === 'back') sfx.back();
        this.focusZone('carousel');
        break;
      case 'down':
        if (this.hub.hasCards()) this.focusZone('cards', 0);
        else sfx.bump();
        break;
      case 'confirm':
        this.hub.activateAction(this.hub.actions.index);
        break;
      case 'options': {
        const it = this.items[this.sel];
        if (it && it.type === 'game') gameOptions(it.game, this.hub.actions.current);
        break;
      }
      default:
        return false;
    }
    return true;
  }

  handleCards(action) {
    switch (action) {
      case 'left':
      case 'right':
        if (this.hub.cardNav.move(action === 'left' ? -1 : 1)) sfx.move();
        else sfx.bump();
        break;
      case 'up':
        this.focusZone('actions', 0);
        break;
      case 'back':
        sfx.back();
        this.focusZone('carousel');
        break;
      case 'confirm':
        sfx.select();
        this.hub.activateCard(this.hub.cardNav.index);
        break;
      case 'down':
        sfx.bump();
        break;
      default:
        return false;
    }
    return true;
  }

  /* ---------------------------------------------------------------- */

  syncMediaWatch() {
    const want = this.active && this.tab === 'media';
    if (want && !this.unwatch) this.unwatch = watchMedia();
    if (!want && this.unwatch) {
      this.unwatch();
      this.unwatch = null;
    }
  }

  show(params = {}) {
    this.active = true;
    this.syncMediaWatch();
    if (!this.items.length) this.refresh(true);
    if (params.focusGame) this.focusGame(params.focusGame);
    this.restoreFocusVisual();
    this.updateHero();
  }

  hide() {
    this.active = false;
    this.syncMediaWatch();
    heroBg.deep(false);
  }

  /**
   * The PS5 boot build-in, played over the boot stage: the tile row grows out
   * of the middle of the screen, the stage fades to reveal the hero, the
   * selected tile grows, the top bar drops in and the rest fades up.
   * Resolves as soon as the screen can take input.
   */
  async playBootIntro(stage) {
    const el = this.el;
    const reduce = document.body.classList.contains('reduce-motion');
    el.classList.add('boot-in');
    document.body.classList.remove('booting');
    emit('clock');
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
    const mid = this.carousel.getBoundingClientRect().width / remPx / 2;
    const k = SMALL / BIG;
    const rowX = (i) => ANCHOR + (i - this.sel) * (SMALL + GAP);
    const tiles = this.items.map((it, i) => [i, this.tileEls.get(it.key)]).filter(([, t]) => t);

    if (!reduce) {
      // Start: tiny tiles bunched up around the middle of the screen.
      tiles.forEach(([i, t]) => {
        const cx = mid + (rowX(i) + SMALL / 2 - mid) * 0.3;
        const s = k * 0.14;
        t.style.transition = 'none';
        t.style.transform = `translate3d(${cx - (BIG * s) / 2}rem, ${(SMALL - BIG * s) / 2}rem, 0) scale(${s})`;
        t.style.opacity = '0';
        t.classList.remove('off');
      });
      void this.carousel.offsetWidth;
      // Spread out into a row of equal small tiles, the middle ones first.
      tiles.forEach(([i, t]) => {
        const x = rowX(i);
        const delay = Math.min(1, Math.abs(x + SMALL / 2 - mid) / mid) * 0.14;
        t.style.transition = `transform 0.9s var(--ease-out) ${delay}s, opacity 0.4s var(--ease) ${delay}s`;
        t.style.transform = `translate3d(${x}rem,0,0) scale(${k})`;
        t.style.opacity = '';
        t.classList.toggle('off', x < -SMALL || x > 260);
      });
      await sleep(820);
    }

    // Reveal the hero, settle into the normal layout (the selected tile grows).
    tiles.forEach(([, t]) => (t.style.transition = ''));
    stage.leave(reduce ? 300 : 800);
    this.layout();
    el.classList.remove('boot-in');
    el.classList.add('boot-ring');
    const steps = reduce
      ? [[0, 'boot-top boot-title boot-hub']]
      : [
          [180, 'boot-top'],
          [380, 'boot-title'],
          [650, 'boot-hub'],
        ];
    (async () => {
      let t = 0;
      for (const [at, cls] of steps) {
        await sleep(at - t);
        t = at;
        el.classList.add(...cls.split(' '));
      }
      await sleep(1100);
      el.classList.remove('boot-ring', 'boot-top', 'boot-title', 'boot-hub');
    })();
  }
}
