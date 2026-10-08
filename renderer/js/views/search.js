// Search overlay with on-screen keyboard and live results.

import { h, escapeHtml } from '../util.js';
import { icon } from '../icons.js';
import { state, sortGames } from '../state.js';
import { sfx } from '../sound.js';
import { mouseActive, getDevice } from '../input.js';
import { mountOverlay, FocusList } from '../ui/overlay.js';
import { createOSK } from '../ui/osk.js';
import { tileArt } from '../ui/tiles.js';
import { renderHints } from '../ui/glyphs.js';
import { launchGame, gameOptions } from '../ui/gameactions.js';
import { t } from '../i18n.js';

function score(g, q) {
  const n = g.name.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.split(/[\s:\-–]+/).some((w) => w.startsWith(q))) return 60;
  if (n.includes(q)) return 40;
  const m = g.meta || {};
  if ((m.developer || '').toLowerCase().includes(q) || (m.publisher || '').toLowerCase().includes(q)) return 20;
  const compact = n.replace(/[^a-z0-9]/g, '');
  if (compact.includes(q.replace(/[^a-z0-9]/g, '')) && q.length > 2) return 15;
  return 0;
}

let open = false;

export function openSearch(router) {
  if (open) return;
  open = true;
  sfx.open();
  let zone = 'osk';
  let results = [];

  const input = h('input', { class: 'search-input', placeholder: 'Search your games', spellcheck: 'false' });
  const resultsRow = h('div', { class: 'search-results' });
  const label = h('div', { class: 'search-label' });
  const osk = createOSK({
    onChar: (c) => {
      const s = input.selectionStart ?? input.value.length;
      input.setRangeText(c, s, input.selectionEnd ?? s, 'end');
      update();
    },
    onBackspace: () => {
      const s = input.selectionStart ?? input.value.length;
      const e = input.selectionEnd ?? s;
      if (s !== e) input.setRangeText('', s, e, 'end');
      else if (s > 0) input.setRangeText('', s - 1, s, 'end');
      update();
    },
    onDone: () => {
      if (results.length) setZone('results');
      else sfx.bump();
    },
  });
  const hints = h('div', { class: 'search-hints' });
  renderHints(hints, [
    ['confirm', 'Select'],
    ['back', 'Close'],
  ]);
  const el = h(
    'div',
    { class: 'overlay search-overlay' },
    h('div', { class: 'search-field' }, h('span', { class: 'sf-icon', html: icon('search') }), input),
    label,
    resultsRow,
    h('div', { class: 'search-osk' }, osk.el),
    hints
  );
  let nav = new FocusList([]);

  function update() {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      results = sortGames(state.games, 'recent').slice(0, 12);
      label.textContent = t('Recently played');
    } else {
      results = state.games
        .map((g) => [g, score(g, q)])
        .filter(([, s]) => s > 0)
        .sort((a, b) => b[1] - a[1] || a[0].name.localeCompare(b[0].name))
        .slice(0, 24)
        .map(([g]) => g);
      label.textContent = results.length ? t(results.length === 1 ? '1 result' : '{n} results', { n: results.length }) : t('No results for “{q}”', { q: input.value.trim() });
    }
    resultsRow.innerHTML = '';
    const els = results.map((g, i) =>
      h(
        'button',
        {
          class: 'sr-tile',
          style: { animationDelay: `${Math.min(i, 10) * 0.025}s` },
          onmouseenter: () => {
            if (mouseActive()) {
              setZone('results', true);
              nav.set(i);
            }
          },
          onclick: () => openGame(g),
        },
        h('div', { class: 'sr-art fx' }, tileArt(g)),
        h('div', { class: 'sr-name', html: escapeHtml(g.name) })
      )
    );
    resultsRow.append(...els);
    nav = new FocusList(els, { onChange: (e) => e.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }) });
    if (zone !== 'results') nav.blur();
    if (zone === 'results' && !els.length) setZone('osk', true);
  }

  function setZone(z, silent = false) {
    if (z === zone) return;
    if (z === 'results' && !results.length) return;
    zone = z;
    if (!silent) sfx.move();
    nav.blur();
    osk.blur();
    if (z === 'results') {
      if (nav.index < 0) nav.set(0);
      nav.refocus();
    } else osk.refocus();
    el.classList.toggle('results-focus', z === 'results');
  }

  function close() {
    open = false;
    ctl.close();
  }

  function openGame(g) {
    sfx.select();
    close();
    router.open('hub', { id: g.id });
  }

  const ctl = mountOverlay(
    el,
    (action, meta) => {
      if (action === 'back') {
        sfx.back();
        close();
        return true;
      }
      if (zone === 'results') {
        const g = results[nav.index];
        if (action === 'left' || action === 'right') nav.move(action === 'left' ? -1 : 1) ? sfx.move() : sfx.bump();
        else if (action === 'down') setZone('osk');
        else if (action === 'up') sfx.bump();
        else if (action === 'confirm' && g) openGame(g);
        else if (action === 'x' && g) {
          close();
          launchGame(g);
        } else if (action === 'options' && g) gameOptions(g, nav.current);
        return true;
      }
      if (meta && meta.source === 'keyboard' && action === 'confirm') {
        setZone('results');
        return true;
      }
      if (!osk.handle(action)) {
        if (action === 'up') setZone('results');
        else sfx.bump();
      }
      return true;
    },
    {
      dimApp: true,
      onClose: () => {
        open = false;
      },
    }
  );
  input.addEventListener('input', update);
  update();
  setTimeout(() => input.focus(), 50);
  if (getDevice() !== 'gamepad') el.classList.add('kb');
}
