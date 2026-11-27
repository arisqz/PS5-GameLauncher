// Square game tile artwork, shared by the home carousel, library and search.

import { h, escapeHtml, hashHue } from '../util.js';
import { icon } from '../icons.js';
import { artUrl, state } from '../state.js';
import { t } from '../i18n.js';

// Watch visible artwork only; detached/offscreen tiles must not keep retrying.
const imageLoaders = new WeakMap();
const artworkObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) imageLoaders.get(entry.target)?.visible(entry.isIntersecting);
}, { rootMargin: '200px' });

function img(src, cls) {
  // Attach handlers before assigning src, including for cached local artwork.
  const el = h('img', { class: cls, alt: '', decoding: 'async', loading: 'lazy' });
  let visible = false;
  let failed = false;
  let finished = false;
  let retries = 0;
  let timer;
  const clear = () => { clearTimeout(timer); timer = null; };
  const updateBroken = () => {
    const art = el.closest('.tile-art');
    if (art) art.classList.toggle('broken', [...art.querySelectorAll('img')].some((image) => image.dataset.artFailed === 'true'));
  };
  const stop = () => {
    clear();
    finished = true;
    artworkObserver.unobserve(el);
    imageLoaders.delete(el);
  };
  const schedule = () => {
    clear();
    if (!visible || finished) return;
    // Give an in-flight request time to finish; back off after explicit errors.
    timer = setTimeout(retry, failed ? 500 * (2 ** retries) : 12000);
  };
  const retry = () => {
    timer = null;
    if (!el.isConnected) { stop(); return; }
    if (!visible || finished) return;
    if (el.complete && el.naturalWidth > 0) { loaded(); return; }
    if (retries >= 3) {
      el.dataset.artFailed = 'true';
      updateBroken();
      stop();
      return;
    }
    retries++;
    failed = false;
    const url = new URL(src, document.baseURI);
    // Keep artVersion and bypass a cached failed response for this attempt.
    url.searchParams.set('artRetry', String(retries));
    el.loading = 'eager';
    el.src = url.href;
    schedule();
  };
  const loaded = () => {
    if (!el.naturalWidth) return;
    delete el.dataset.artFailed;
    updateBroken();
    stop();
  };
  el.addEventListener('load', loaded);
  el.addEventListener('error', () => {
    if (finished) return;
    failed = true;
    el.dataset.artFailed = 'true';
    updateBroken();
    schedule();
  });
  imageLoaders.set(el, {
    visible(value) {
      if (!el.isConnected) { stop(); return; }
      visible = value;
      if (value && el.complete && el.naturalWidth > 0) loaded();
      else if (value) schedule();
      else clear();
    },
  });
  el.src = src;
  artworkObserver.observe(el);
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
  if (kind === 'explore') {
    return h('div', { class: 'tile-art special explore-art', html: icon('explore') });
  }
  if (kind === 'media') {
    return h('div', { class: 'tile-art special media-art', html: icon('music') });
  }
  if (kind === 'add') {
    return h('div', { class: 'tile-art special add-art', html: icon('plus') });
  }
  return h('div', { class: 'tile-art special' });
}
