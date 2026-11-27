// Choosing a value on a settings row, as the PS5 does it (measured from PS5
// videos, frame by frame):
//  - selectMenu(): the screen dims to half, all but the row's name (and its
//    description); the options come in beside it, the ticked one level with
//    the name and the panel's right edge at the row's. Leaving, the panel goes
//    at once and the screen lightens in 0.1 s.
//  - adjustSlider(): the same dimming while a slider row's value is moved; its
//    knob grows and a ring settles round it (css/base.css, .adjusting).
// Both draw the row again above the dimmed screen (the PS5 leaves it lit).

import { h, escapeHtml, clamp } from '../util.js';
import { icon } from '../icons.js';
import { sfx } from '../sound.js';
import { mountOverlay, FocusList } from './overlay.js';
import { mouseActive } from '../input.js';
import { setSlider, dragSlider } from './slider.js';
import { t } from '../i18n.js';

const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;

/** A copy of the row where it is on screen, above the dimmed screen. */
function liftRow(row) {
  const r = row.getBoundingClientRect();
  const keep = row.cloneNode(true);
  keep.classList.remove('focused', 'psel-src');
  keep.classList.add('psel-row');
  keep.querySelectorAll('.fx-wave').forEach((w) => w.remove());
  keep.removeAttribute('id');
  keep.tabIndex = -1;
  Object.assign(keep.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  return keep;
}

/** The overlay both use: the dimmed screen and the lifted row. */
function mount(anchor, cls, extra, handle) {
  const dim = h('div', { class: 'psel-dim' });
  const keep = liftRow(anchor);
  const root = h('div', { class: `overlay psel-overlay ${cls}` }, dim, keep, ...extra);
  anchor.classList.add('psel-src');
  const ctl = mountOverlay(root, handle, { closeDelay: 110, onClose: () => anchor.classList.remove('psel-src') });
  // The row can still be settling (the one above closing its description, the
  // list scrolling): the copy follows it until it's gone.
  let last = '';
  const follow = () => {
    if (!root.isConnected) return;
    if (anchor.isConnected) {
      const r = anchor.getBoundingClientRect();
      const at = `${r.left}|${r.top}|${r.width}|${r.height}`;
      if (at !== last) {
        last = at;
        Object.assign(keep.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      }
    }
    requestAnimationFrame(follow);
  };
  requestAnimationFrame(follow);
  // The focus ring of what's chosen lights up once the rest has come in.
  setTimeout(() => root.classList.add('ready'), 170);
  return { root, dim, keep, ctl };
}

/**
 * The PS5's drop-down. items: [{ label, value?, id?, checked?, hint?, disabled?, run? }].
 * Resolves with the chosen item (after its run()) or null.
 */
export function selectMenu({ anchor, items, index = 0 }) {
  return new Promise((resolve) => {
    let done = false;
    const list = h('div', { class: 'psel-list' });
    const panel = h('div', { class: 'psel-panel' }, list);
    const els = items.map((it, i) =>
      h('button', {
        class: `psel-item fx fx-in${it.disabled ? ' disabled' : ''}${it.danger ? ' danger' : ''}`,
        html: `<span class="psel-check">${it.checked ? icon('check') : ''}</span><span class="psel-label">${escapeHtml(t(it.label))}</span>${it.hint ? `<span class="psel-hint">${escapeHtml(t(it.hint))}</span>` : ''}`,
        onmouseenter: () => mouseActive() && !it.disabled && nav.set(i),
        onclick: (e) => {
          e.stopPropagation();
          if (!it.disabled) choose(i);
        },
      })
    );
    list.append(...els);
    const { root, dim, ctl } = mount(anchor, 'is-select', [panel], (action) => {
      if (action === 'up' || action === 'down') {
        if (nav.move(action === 'up' ? -1 : 1)) sfx.move();
        else sfx.bump();
      } else if (action === 'confirm') choose(nav.index);
      else if (action === 'back' || action === 'options') {
        sfx.back();
        finish(null);
      }
      return true;
    });
    dim.addEventListener('click', () => {
      sfx.back();
      finish(null);
    });
    const first = items.findIndex((it) => !it.disabled);
    const nav = new FocusList(els, { index: items[index] && !items[index].disabled ? index : Math.max(0, first), onChange: (el) => show(el) });

    // Where it goes: the ticked option level with the row's name, the panel's
    // right edge 0.9rem in from the row's (measured), inside the screen.
    const u = rem();
    const m = 3 * u;
    const row = anchor.getBoundingClientRect();
    const head = (anchor.querySelector(':scope > .si-head') || anchor).getBoundingClientRect();
    const level = head.top + head.height / 2;
    const pw = panel.offsetWidth;
    const full = panel.offsetHeight;
    const ph = Math.min(full, innerHeight - 2 * m);
    const pad = (full - list.offsetHeight) / 2;
    if (ph < full) list.style.height = `${ph - 2 * pad}px`;
    const cur = nav.current;
    const mid = cur ? cur.offsetTop + cur.offsetHeight / 2 : 0;
    let top = level - pad - mid;
    if (ph < full) {
      // A long list: as near the row as the screen allows, scrolled so the ticked one is level with it.
      top = clamp(top, m, innerHeight - ph - m);
      list.scrollTop = clamp(pad + mid - (level - top), 0, list.scrollHeight - list.clientHeight);
    } else top = clamp(top, m, innerHeight - ph - m);
    panel.style.left = `${clamp(row.right - 0.9 * u - pw, m, innerWidth - pw - m)}px`;
    panel.style.top = `${top}px`;
    sfx.open();

    function show(el) {
      const a = el.offsetTop;
      const b = a + el.offsetHeight;
      if (a < list.scrollTop) list.scrollTop = a;
      else if (b > list.scrollTop + list.clientHeight) list.scrollTop = b - list.clientHeight;
    }
    function finish(v) {
      if (done) return;
      done = true;
      root.classList.remove('ready');
      ctl.close();
      resolve(v);
    }
    async function choose(i) {
      const it = items[i];
      if (!it || it.disabled || done) return;
      sfx.select();
      done = true;
      root.classList.remove('ready');
      ctl.close();
      try {
        if (it.run) await it.run();
      } finally {
        resolve(it);
      }
    }
  });
}

/**
 * Move a slider row's value in place. onChange(v) runs as it moves (the value
 * takes effect at once, as on the PS5); ✕ or ○ ends it. Resolves with the value.
 */
export function adjustSlider({ anchor, value, min = 0, max = 100, step = 5, unit = '', onChange }) {
  return new Promise((resolve) => {
    let v = value;
    let done = false;
    const { root, dim, keep, ctl } = mount(anchor, 'is-slider', [], (action) => {
      if (action === 'left' || action === 'down') set(v - step);
      else if (action === 'right' || action === 'up') set(v + step);
      else if (action === 'confirm' || action === 'back' || action === 'options') {
        if (action === 'confirm') sfx.select();
        else sfx.back();
        finish();
      }
      return true;
    });
    const slider = keep.querySelector('.ps-slider');
    const render = () => {
      const p = ((v - min) / (max - min || 1)) * 100;
      for (const el of [keep, anchor]) {
        setSlider(el, p);
        const n = el.querySelector('.si-num');
        if (n) n.textContent = `${v}${unit}`;
      }
    };
    const set = (nv, quiet) => {
      nv = clamp(Math.round(nv / step) * step, min, max);
      if (nv === v) return quiet ? null : sfx.bump();
      sfx.slider(nv > v);
      v = nv;
      render();
      onChange && onChange(v);
    };
    if (slider) {
      dragSlider(slider, (p) => set(min + (p / 100) * (max - min), true));
      // Grows once it's on screen (the transition needs a frame at rest first).
      requestAnimationFrame(() => requestAnimationFrame(() => !done && slider.classList.add('adjusting')));
    }
    dim.addEventListener('click', () => {
      sfx.back();
      finish();
    });

    function finish() {
      if (done) return;
      done = true;
      if (slider) slider.classList.remove('adjusting');
      root.classList.remove('ready');
      ctl.close();
      resolve(v);
    }
  });
}
