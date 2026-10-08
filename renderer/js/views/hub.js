// Stand-alone game hub (opened from the library / search).

import { h, escapeHtml } from '../util.js';
import { state, on, findGame, artUrl, sourceLabel } from '../state.js';
import { sfx } from '../sound.js';
import { heroBg } from '../ui/herobg.js';
import { HubPanel } from '../ui/gamehub.js';
import { gameOptions } from '../ui/gameactions.js';
import { renderHints } from '../ui/glyphs.js';
import { t } from '../i18n.js';

export class HubView {
  constructor(router) {
    this.router = router;
    this.name = 'hub';
    this.usesHero = true;
    this.gameId = null;
    this.zone = 'actions';
    this.hub = new HubPanel({
      onFocusRequest: (zone, i, how) => {
        // Hovering must not scroll the page between the hero and the cards.
        if (how === 'hover' && (zone === 'cards') !== (this.zone === 'cards')) return;
        this.focusZone(zone, i, true);
      },
      openView: (name, params) => this.router.open(name, params),
    });
    this.titleEl = h('div', { class: 'hubv-title' });
    this.hints = h('div', { class: 'hubv-hints' });
    renderHints(this.hints, [
      ['options', 'Options'],
      ['back', 'Back'],
    ]);
    this.el = h('section', { class: 'view hub-view' }, h('div', { class: 'hubv-scroller' }, this.titleEl, this.hub.el), this.hints);
    this.el.addEventListener(
      'wheel',
      (e) => {
        if (e.deltaY > 0 && this.zone !== 'cards') this.focusZone('cards', 0);
        else if (e.deltaY < 0 && this.zone === 'cards') this.focusZone('actions', 0);
      },
      { passive: true }
    );
    on('games', () => this.active && this.refresh(false));
    on('running', () => this.active && this.refresh(false));
  }

  refresh(animate) {
    const g = findGame(this.gameId);
    if (!g) {
      if (this.active) this.router.back();
      return;
    }
    this.titleEl.innerHTML = `<span class="badge">${escapeHtml(sourceLabel(g))}</span><span>${escapeHtml(g.name)}</span>`;
    this.hub.setItem({ type: 'game', game: g, key: `g:${g.id}` }, { animate });
    heroBg.set(artUrl(g, 'hero'));
    this.applyZone();
  }

  focusZone(zone, index = null, fromMouse = false) {
    if (zone === 'cards' && !this.hub.hasCards()) return;
    if (zone !== this.zone && !fromMouse) sfx.move();
    this.zone = zone;
    if (index !== null) (zone === 'actions' ? this.hub.actions : this.hub.cardNav).set(index);
    this.applyZone();
  }

  applyZone() {
    this.hub.actions.blur();
    this.hub.cardNav.blur();
    (this.zone === 'actions' ? this.hub.actions : this.hub.cardNav).refocus();
    this.el.classList.toggle('scrolled', this.zone === 'cards');
    heroBg.deep(this.zone === 'cards');
  }

  handle(action) {
    const nav = this.zone === 'actions' ? this.hub.actions : this.hub.cardNav;
    switch (action) {
      case 'left':
      case 'right':
        nav.move(action === 'left' ? -1 : 1) ? sfx.move() : sfx.bump();
        return true;
      case 'down':
        if (this.zone === 'actions' && this.hub.hasCards()) this.focusZone('cards', 0);
        else sfx.bump();
        return true;
      case 'up':
        if (this.zone === 'cards') this.focusZone('actions', 0);
        else sfx.bump();
        return true;
      case 'confirm':
        if (this.zone === 'actions') this.hub.activateAction(nav.index);
        else {
          sfx.select();
          this.hub.activateCard(nav.index);
        }
        return true;
      case 'options':
        gameOptions(findGame(this.gameId), this.hub.actions.current);
        return true;
      case 'back':
        if (this.zone === 'cards') {
          sfx.back();
          this.focusZone('actions', 0, true);
          return true;
        }
        return false;
    }
    return false;
  }

  show(params = {}) {
    this.active = true;
    if (params.id) {
      this.gameId = params.id;
      this.zone = 'actions';
      this.hub.actions.index = 0;
    }
    this.refresh(true);
    this.hub.actions.set(0);
    this.applyZone();
  }

  hide() {
    this.active = false;
    heroBg.deep(false);
  }
}
