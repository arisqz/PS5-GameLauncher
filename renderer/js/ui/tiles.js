// Square game tile artwork, shared by the home carousel, library and search.

import { h, escapeHtml, hashHue } from '../util.js';
import { icon } from '../icons.js';
import { artUrl, state } from '../state.js';
import { t } from '../i18n.js';

function img(src, cls) {
  const el = h('img', { class: cls, src, alt: '', decoding: 'async', loading: 'lazy' });
  el.addEventListener('error', () => el.closest('.tile-art')?.classList.add('broken'));
  return el;
}

export function placeholder(game) {
  const hue = hashHue(game.name);
  const iconUrl = artUrl(game, 'icon');
  return h(
    'div',
    {
      class: 'tile-art placeholder',
      style: { background: `linear-gradient(140deg, hsl(${hue} 55% 36%), hsl(${(hue + 50) % 360} 60% 16%))` },
    },
    iconUrl ? img(iconUrl, 'ph-icon') : null,
    h('div', { class: 'ph-name', html: escapeHtml(game.name) })
  );
}

/** Build the artwork element for a game tile according to the tile style. */
export function tileArt(game, style = state.settings.tileStyle || 'auto') {
  const grid = artUrl(game, 'grid');
  const hero = artUrl(game, 'hero');
  const logo = artUrl(game, 'logo');
  const capsule = artUrl(game, 'capsule');
  const banner = artUrl(game, 'banner');

  const composite = () =>
    hero && logo ? h('div', { class: 'tile-art composite' }, img(hero, 'ta-bg'), h('div', { class: 'ta-shade' }), img(logo, 'ta-logo')) : null;
  const cover = (src, pos = 'center') => (src ? h('div', { class: `tile-art cover pos-${pos}` }, img(src, 'ta-img')) : null);

  const orders = {
    auto: [() => (grid ? cover(grid) : null), composite, () => cover(capsule, 'top'), () => cover(banner), () => cover(hero)],
    hero: [composite, () => cover(capsule, 'top'), () => cover(banner), () => (grid ? cover(grid) : null)],
    capsule: [() => cover(capsule, 'top'), composite, () => cover(banner)],
    banner: [() => cover(banner), composite, () => cover(capsule, 'top')],
    grid: [() => (grid ? cover(grid) : null), composite, () => cover(capsule, 'top'), () => cover(banner)],
  };
  for (const make of orders[style] || orders.auto) {
    const el = make();
    if (el) return el;
  }
  return placeholder(game);
}

export function specialArt(kind) {
  if (kind === 'library') {
    return h('div', { class: 'tile-art special library-art', html: icon('library') });
  }
  if (kind === 'store') {
    return h('div', { class: 'tile-art special store-art', html: icon('bag') });
  }
  if (kind === 'media') {
    return h('div', { class: 'tile-art special media-art', html: icon('music') });
  }
  if (kind === 'add') {
    return h('div', { class: 'tile-art special add-art', html: icon('plus') });
  }
  return h('div', { class: 'tile-art special' });
}
