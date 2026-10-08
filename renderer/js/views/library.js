// Game Library: header, collection tabs, a round sort / filter button and a
// grid of large covers. The focused cover shows its name and store badge.

import { h, escapeHtml, bump, clamp } from '../util.js';
import { icon } from '../icons.js';
import { state, on, gamesIn, sortGames, api, sourceLabel } from '../state.js';
import { sfx } from '../sound.js';
import { rumble, mouseActive } from '../input.js';
import { FocusList } from '../ui/overlay.js';
import { tileArt } from '../ui/tiles.js';
import { optionsMenu } from '../ui/dialogs.js';
import { gameOptions, isRunning, launchGame } from '../ui/gameactions.js';
import { addGamesMenu } from '../ui/gamehub.js';
import { t } from '../i18n.js';

const COLS = 5;
const SORTS = [
  { value: 'recent', label: 'Recently Played' },
  { value: 'added', label: 'Recently Added' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'playtime', label: 'Play Time' },
];
const SOURCES = [
  { value: 'all', label: 'All Sources' },
  { value: 'steam', label: 'Steam' },
  { value: 'epic', label: 'Epic Games' },
  { value: 'xbox', label: 'Xbox' },
  { value: 'ubisoft', label: 'Ubisoft Connect' },
  { value: 'pc', label: 'Shortcuts & PC' },
];
const TABS = [
  { key: 'game', label: 'Your Collection' },
  { key: 'favorites', label: 'Favorites' },
  { key: 'media', label: 'Media' },
  { key: 'hidden', label: 'Hidden' },
];

export class LibraryView {
  constructor(router) {
    this.router = router;
    this.name = 'library';
    this.usesHero = false;
    this.tab = 'game';
    this.sort = 'recent';
    this.source = 'all';
    this.zone = 'grid';
    this.games = [];
    this.build();
    on('games', () => this.active && this.render(true));
    on('running', () => this.active && this.render(true));
    on('settings', (k) => (k === 'tileStyle' || k === null) && this.active && this.render(true));
  }

  build() {
    this.tabEls = TABS.map((tab, i) =>
      h('button', {
        class: 'lib-tab fx',
        text: t(tab.label),
        onclick: () => {
          this.setZone('tabs', i, true);
          this.setTab(t.key);
        },
        onmouseenter: () => mouseActive() && this.setZone('tabs', i, true),
      })
    );
    this.tabNav = new FocusList(this.tabEls);

    this.filterBtn = h('button', {
      class: 'lib-filter fx',
      title: 'Sort and filter',
      html: icon('sort'),
      onclick: () => {
        this.setZone('filter', null, true);
        this.openFilterMenu();
      },
      onmouseenter: () => mouseActive() && this.setZone('filter', null, true),
    });

    this.grid = h('div', { class: 'lib-grid' });
    this.gridWrap = h('div', { class: 'lib-grid-wrap' }, this.grid);
    this.empty = h('div', { class: 'lib-empty' });
    this.gridWrap.addEventListener(
      'wheel',
      (e) => {
        const now = performance.now();
        if (now - (this.lastWheel || 0) < 90) return;
        this.lastWheel = now;
        this.setZone('grid', null, true);
        this.moveGrid(e.deltaY > 0 ? COLS : -COLS, true);
      },
      { passive: true }
    );

    this.el = h(
      'section',
      { class: 'view lib-view' },
      h(
        'header',
        { class: 'lib-header' },
        h('div', { class: 'lib-badge', html: icon('fLibrary') }),
        h('div', { class: 'lib-title', text: t('Game Library') })
      ),
      h('nav', { class: 'lib-tabs' }, ...this.tabEls),
      this.filterBtn,
      this.gridWrap,
      this.empty
    );
  }

  /* ---------------------------------------------------------------- */

  list() {
    let list;
    if (this.tab === 'favorites') list = state.games.filter((g) => g.favorite);
    else if (this.tab === 'hidden') list = state.games.filter((g) => g.hidden);
    else list = gamesIn(this.tab);
    if (this.source !== 'all') {
      list = list.filter((g) => {
        const src = sourceLabel(g);
        if (this.source === 'steam') return src === 'STEAM';
        if (this.source === 'epic') return src === 'EPIC';
        if (this.source === 'xbox') return src === 'XBOX';
        if (this.source === 'ubisoft') return src === 'UBISOFT';
        return src === 'PC';
      });
    }
    return sortGames(list, this.sort);
  }

  render(keep = false) {
    const prevId = keep && this.games[this.gridIndex] ? this.games[this.gridIndex].id : null;
    const list = this.list();
    const sig = `${this.tab}|${this.sort}|${this.source}|${state.settings.tileStyle}|` + list.map((g) => `${g.id}:${g.artVersion}:${g.name}:${g.favorite}:${isRunning(g)}`).join(',');
    if (keep && sig === this.renderSig) return;
    this.renderSig = sig;
    this.games = list;

    this.tabEls.forEach((el, i) => {
      el.classList.toggle('active', TABS[i].key === this.tab);
      if (TABS[i].key === 'hidden') el.style.display = state.games.some((g) => g.hidden) || this.tab === 'hidden' ? '' : 'none';
    });
    this.filterBtn.classList.toggle('filtered', this.source !== 'all');

    this.tileEls = this.games.map((g, i) =>
      h(
        'button',
        {
          class: 'lib-tile fx',
          style: { '--i': Math.min(i, 20) },
          onclick: () => {
            this.setZone('grid', null, true);
            this.gridNav.set(i);
            this.openGame(g);
          },
          onmouseenter: () => {
            if (mouseActive()) {
              this.setZone('grid', null, true);
              this.gridNav.set(i);
            }
          },
        },
        h(
          'div',
          { class: 'lt-art' },
          tileArt(g),
          h(
            'div',
            { class: 'lt-info' },
            h('span', { class: 'lt-badge', text: sourceLabel(g) }),
            h('span', { class: 'lt-name', text: g.name })
          ),
          g.favorite ? h('div', { class: 'lt-fav', html: icon('starFill') }) : null,
          isRunning(g) ? h('div', { class: 'tile-running' }) : null
        )
      )
    );
    this.grid.replaceChildren(...this.tileEls);
    if (!keep) {
      this.grid.classList.remove('stagger');
      void this.grid.offsetWidth;
      this.grid.classList.add('stagger');
    }

    const n = this.games.length;
    let idx = prevId ? this.games.findIndex((g) => g.id === prevId) : 0;
    if (idx < 0) idx = clamp(this.gridIndex || 0, 0, Math.max(0, n - 1));
    this.gridNav = new FocusList(this.tileEls, { index: idx, onChange: () => this.scrollToFocus() });
    if (!n && this.zone === 'grid') this.zone = 'tabs';

    this.empty.style.display = n ? 'none' : '';
    this.empty.innerHTML = n
      ? ''
      : `<div class="le-icon">${icon(this.tab === 'favorites' ? 'star' : this.tab === 'media' ? 'music' : 'library')}</div>
         <div class="le-title">${escapeHtml(t(
           this.tab === 'favorites' ? 'No favorites yet' : this.tab === 'media' ? 'No media apps' : this.tab === 'hidden' ? 'Nothing hidden' : this.source !== 'all' ? 'No games from this source' : 'Your library is empty'
         ))}</div>
         <div class="le-text">${escapeHtml(t(
           this.tab === 'favorites'
             ? 'Press Favorite on any game to pin it here.'
             : this.tab === 'media'
               ? 'Use Options › Move to Media on any entry.'
               : 'Add a folder of game shortcuts or scan Steam and Epic Games.'
         ))}</div>`;
    this.scrollToFocus(true);
    this.applyZone();
  }

  get gridIndex() {
    return this.gridNav ? this.gridNav.index : 0;
  }

  scrollToFocus(instant = false) {
    const el = this.gridNav && this.gridNav.current;
    if (!el) {
      this.grid.style.transform = '';
      return;
    }
    // Keep the focused row as the second visible row once we scroll past the first.
    const row = Math.floor(this.gridNav.index / COLS);
    const rowH = el.offsetHeight + parseFloat(getComputedStyle(this.grid).rowGap || 0);
    const offset = Math.max(0, row - 1) * rowH;
    if (instant) this.grid.style.transition = 'none';
    this.grid.style.transform = `translateY(${-offset}px)`;
    this.el.classList.toggle('grid-scrolled', offset > 0);
    if (instant) {
      void this.grid.offsetWidth;
      this.grid.style.transition = '';
    }
  }

  setTab(key) {
    if (key === this.tab) return;
    this.tab = key;
    sfx.select();
    this.gridNav = null;
    this.render();
  }

  setZone(zone, index = null, silent = false) {
    if (zone === 'grid' && !this.games.length) return;
    const changed = zone !== this.zone;
    this.zone = zone;
    if (index !== null && zone === 'tabs') this.tabNav.set(index, { silent: true });
    if (changed && !silent) sfx.move();
    this.applyZone();
  }

  applyZone() {
    this.tabNav.blur();
    this.filterBtn.classList.remove('focused');
    this.gridNav && this.gridNav.blur();
    if (this.zone === 'tabs') this.tabNav.refocus();
    else if (this.zone === 'filter') this.filterBtn.classList.add('focused');
    else if (this.gridNav) this.gridNav.refocus();
  }

  visibleTabIndex(d) {
    let i = this.tabNav.index;
    do {
      i += d;
    } while (i >= 0 && i < this.tabEls.length && this.tabEls[i].style.display === 'none');
    return i;
  }

  focusActiveTab() {
    this.tabNav.set(
      TABS.findIndex((t) => t.key === this.tab),
      { silent: true }
    );
    this.setZone('tabs');
  }

  moveGrid(delta, fromWheel = false) {
    const n = this.games.length;
    const i = this.gridIndex;
    let ni = i + delta;
    if (delta === -1 && i % COLS === 0) {
      if (!fromWheel) this.setZone('filter');
      return;
    }
    if (Math.abs(delta) === 1 && Math.floor(ni / COLS) !== Math.floor(i / COLS)) ni = -1;
    if (delta > 1 && ni >= n && Math.floor(i / COLS) < Math.floor((n - 1) / COLS)) ni = n - 1;
    if (ni < 0 || ni >= n) {
      if (delta === -COLS && !fromWheel) {
        this.focusActiveTab();
        return;
      }
      if (!fromWheel) {
        sfx.bump();
        rumble(0.3);
        bump(this.gridNav.current, delta === 1 ? 'right' : delta === -1 ? 'left' : delta > 0 ? 'down' : 'up');
      }
      return;
    }
    this.gridNav.set(ni);
    sfx.move();
  }

  openGame(g) {
    sfx.select();
    this.router.open('hub', { id: g.id });
  }

  async openFilterMenu() {
    sfx.select();
    const sortText = SORTS.find((s) => s.value === this.sort).label;
    const sourceText = SOURCES.find((s) => s.value === this.source).label;
    await optionsMenu({
      title: 'Sort and Filter',
      anchor: this.filterBtn,
      items: [
        {
          label: 'Sort By',
          hint: sortText,
          icon: 'sort',
          submenu: true,
          run: async () => {
            const choice = await optionsMenu({ title: 'Sort By', anchor: this.filterBtn, items: SORTS.map((s) => ({ ...s, checked: s.value === this.sort })) });
            if (choice) {
              this.sort = choice.value;
              this.render();
            }
          },
        },
        {
          label: 'Show',
          hint: sourceText,
          icon: 'filter',
          submenu: true,
          run: async () => {
            const choice = await optionsMenu({ title: 'Show', anchor: this.filterBtn, items: SOURCES.map((s) => ({ ...s, checked: s.value === this.source })) });
            if (choice) {
              this.source = choice.value;
              this.render();
            }
          },
        },
        { label: 'Add Games', icon: 'plus', submenu: true, run: () => addGamesMenu(this.filterBtn) },
      ],
    });
  }

  handle(action) {
    if (action === 'l1' || action === 'r1') {
      const ni = this.visibleTabIndex(action === 'l1' ? -1 : 1);
      if (ni >= 0 && ni < this.tabEls.length) {
        this.tabNav.set(ni, { silent: true });
        this.setTab(TABS[ni].key);
      } else sfx.bump();
      return true;
    }
    if (this.zone === 'tabs') {
      if (action === 'left' || action === 'right') {
        const ni = this.visibleTabIndex(action === 'left' ? -1 : 1);
        if (ni >= 0 && ni < this.tabEls.length) {
          this.tabNav.set(ni);
          sfx.move();
          this.setTab(TABS[ni].key);
        } else sfx.bump();
      } else if (action === 'confirm') this.setTab(TABS[this.tabNav.index].key);
      else if (action === 'down') {
        if (this.games.length) this.setZone('grid');
        else this.setZone('filter');
      } else if (action === 'up') sfx.bump();
      else return false;
      return true;
    }
    if (this.zone === 'filter') {
      if (action === 'confirm') this.openFilterMenu();
      else if (action === 'right') {
        if (this.games.length) {
          // Return to the first cover of the row that is in view.
          const row = Math.floor(this.gridIndex / COLS);
          this.gridNav.set(Math.min(row * COLS, this.games.length - 1), { silent: true });
          this.setZone('grid');
        } else sfx.bump();
      } else if (action === 'up') this.focusActiveTab();
      else if (action === 'left' || action === 'down') sfx.bump();
      else return false;
      return true;
    }
    const g = this.games[this.gridIndex];
    switch (action) {
      case 'left':
        this.moveGrid(-1);
        return true;
      case 'right':
        this.moveGrid(1);
        return true;
      case 'up':
        this.moveGrid(-COLS);
        return true;
      case 'down':
        this.moveGrid(COLS);
        return true;
      case 'confirm':
        if (g) this.openGame(g);
        return true;
      case 'x':
        if (g) launchGame(g);
        return true;
      case 'y':
        if (g) {
          sfx.toggle();
          api.updateGame(g.id, { favorite: !g.favorite });
        }
        return true;
      case 'options':
        if (g) gameOptions(g, this.gridNav.current);
        return true;
    }
    return false;
  }

  show(params = {}, dir) {
    this.active = true;
    const keep = dir === 'back' || !!params.keep;
    if (params.tab && params.tab !== this.tab) this.tab = params.tab;
    if (params.sort) this.sort = params.sort;
    if (!keep) {
      this.zone = 'grid';
      this.gridNav = null;
    }
    this.render(keep);
  }

  hide() {
    this.active = false;
  }
}
