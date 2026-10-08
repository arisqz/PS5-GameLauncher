// Controller-friendly on-screen keyboard.

import { h } from '../util.js';
import { icon } from '../icons.js';
import { sfx } from '../sound.js';
import { glyph } from './glyphs.js';
import { t } from '../i18n.js';

const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '-'],
  [
    { k: 'shift', w: 1.5, label: icon('shift') },
    { k: ':', w: 1 },
    { k: 'space', w: 4.5, label: 'Space' },
    { k: 'back', w: 1.5, label: icon('backspace') },
    { k: 'done', w: 1.5, label: 'Done' },
  ],
];

/**
 * @param {{ onChar(c:string):void, onBackspace():void, onDone():void }} cb
 */
export function createOSK(cb) {
  let shift = false;
  let row = 1;
  let col = 0;
  const keyEls = [];

  const el = h('div', { class: 'osk' });
  ROWS.forEach((r, ri) => {
    const rowEl = h('div', { class: 'osk-row' });
    keyEls[ri] = [];
    r.forEach((k, ci) => {
      const def = typeof k === 'string' ? { k, w: 1 } : k;
      const keyEl = h('button', {
        class: `osk-key k-${def.k.length > 1 ? def.k : 'char'}`,
        style: { flex: `${def.w} 1 0` },
        html: def.label || def.k,
        dataset: { k: def.k },
        onmouseenter: () => setFocus(ri, ci),
        onclick: () => press(def.k),
      });
      if (def.k === 'done') keyEl.classList.add('primary');
      rowEl.append(keyEl);
      keyEls[ri].push(keyEl);
    });
    el.append(rowEl);
  });
  el.append(h('div', { class: 'osk-hints', html: `<span>${glyph('x')} Delete</span><span>${glyph('y')} Space</span><span>${glyph('options')} Done</span>` }));

  function setFocus(r, c) {
    keyEls[row][col]?.classList.remove('focused');
    row = r;
    col = c;
    keyEls[row][col].classList.add('focused');
  }

  function centerOf(r, c) {
    const e = keyEls[r][c];
    return e.offsetLeft + e.offsetWidth / 2;
  }

  function moveVert(d) {
    const nr = row + d;
    if (nr < 0 || nr >= keyEls.length) return false;
    const x = centerOf(row, col);
    let best = 0;
    let bestD = Infinity;
    keyEls[nr].forEach((_, ci) => {
      const dd = Math.abs(centerOf(nr, ci) - x);
      if (dd < bestD) {
        bestD = dd;
        best = ci;
      }
    });
    setFocus(nr, best);
    return true;
  }

  function refreshCase() {
    keyEls.flat().forEach((k) => {
      if (k.classList.contains('k-char')) k.textContent = shift ? k.dataset.k.toUpperCase() : k.dataset.k;
    });
    el.querySelector('.k-shift')?.classList.toggle('on', shift);
  }

  function press(k) {
    if (k === 'shift') {
      shift = !shift;
      refreshCase();
      sfx.toggle();
    } else if (k === 'space') {
      cb.onChar(' ');
      sfx.tick();
    } else if (k === 'back') {
      cb.onBackspace();
      sfx.tick();
    } else if (k === 'done') {
      cb.onDone();
    } else {
      cb.onChar(shift ? k.toUpperCase() : k);
      sfx.tick();
      if (shift) {
        shift = false;
        refreshCase();
      }
    }
  }

  setFocus(1, 0);

  return {
    el,
    handle(action) {
      switch (action) {
        case 'left':
          if (col > 0) setFocus(row, col - 1);
          else return false;
          sfx.move();
          return true;
        case 'right':
          if (col < keyEls[row].length - 1) setFocus(row, col + 1);
          else return false;
          sfx.move();
          return true;
        case 'up':
          if (!moveVert(-1)) return false;
          sfx.move();
          return true;
        case 'down':
          if (!moveVert(1)) return false;
          sfx.move();
          return true;
        case 'confirm':
          press(keyEls[row][col].dataset.k);
          return true;
        case 'x':
          press('back');
          return true;
        case 'y':
          press('space');
          return true;
        case 'l2':
          press('shift');
          return true;
        case 'options':
        case 'r2':
          press('done');
          return true;
      }
      return false;
    },
    focusRow(r) {
      setFocus(Math.max(0, Math.min(keyEls.length - 1, r)), 0);
    },
    blur() {
      keyEls[row][col]?.classList.remove('focused');
    },
    refocus() {
      keyEls[row][col]?.classList.add('focused');
    },
  };
}
