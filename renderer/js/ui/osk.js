// The on-screen keyboard, as the PS5's (measured from a video of it, frame by
// frame): a dark panel with an empty suggestions bar, four rows of eleven keys
// and two rows of function keys, each labelled with its controller shortcut.
// Keys are focused like list rows (.fx-in): the arrival flash runs across the
// key in the direction of the move and its ring comes in after it; the focused
// character turns bold. A press shrinks the key a little and lights it.
//
// It types straight into the <input> it is given (so the caret, selection and
// a physical keyboard all keep working) and says when the text changed.

import { h, replayClass } from '../util.js';
import { sfx } from '../sound.js';
import { state, on } from '../state.js';
import { getPromptStyle, mouseActive } from '../input.js';
import { t } from '../i18n.js';

/* Layouts: eleven keys a row. Shift gives the capitals (and, on the letters
   page, the PS5's alternates for its punctuation). */
const PAGES = {
  abc: [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '@'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '#'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'", '/'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '?', '!'],
  ],
  sym: [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '@'],
    ['!', '?', '#', '$', '%', '&', '*', '(', ')', '-', '_'],
    ['+', '=', '/', '\\', '|', ':', ';', '"', "'", '`', '~'],
    ['<', '>', '[', ']', '{', '}', '^', ',', '.', '€', '£'],
  ],
  acc: [
    ['à', 'á', 'â', 'ä', 'ã', 'å', 'æ', 'ç', 'è', 'é', 'ê'],
    ['ë', 'ì', 'í', 'î', 'ï', 'ñ', 'ò', 'ó', 'ô', 'ö', 'õ'],
    ['ø', 'œ', 'ù', 'ú', 'û', 'ü', 'ý', 'ÿ', 'ß', '¡', '¿'],
    ['ā', 'ē', 'ī', 'ō', 'ū', 'ł', 'ś', 'ź', 'ż', 'ć', 'ń'],
  ],
};
const SHIFTED = { "'": '"', ',': '-', '.': '_' };
const TABS = ['abc', 'sym', 'acc'];

const svg = (vb, body) => `<svg class="osk-ic" viewBox="${vb}" aria-hidden="true">${body}</svg>`;
const ICONS = {
  shift: svg('0 0 24 24', '<path d="M12 3.6 3.8 12.1h4.6v7.6h7.2v-7.6h4.6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>'),
  shiftOn: svg('0 0 24 24', '<path d="M12 3.6 3.8 12.1h4.6v7.6h7.2v-7.6h4.6z" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>'),
  shiftLock: svg('0 0 24 24', '<path d="M12 2.6 3.8 11.1h4.6v5.6h7.2v-5.6h4.6z" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><rect x="8.4" y="18.6" width="7.2" height="2.4" rx=".4" fill="currentColor"/>'),
  space: svg('0 0 28 12', '<path d="M2.5 1.5v7.5h23V1.5" fill="none" stroke="currentColor" stroke-width="3.2"/>'),
  back: svg('0 0 30 20', '<path d="M9.5 1H27a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9.5L1 10z" fill="currentColor"/><path d="m14 5.5 9 9m0-9-9 9" stroke="var(--osk-x, #2c2e33)" stroke-width="2.8" stroke-linecap="round"/>'),
  left: svg('0 0 20 20', '<path d="M14.5 2.5 4.5 10l10 7.5z" fill="currentColor"/>'),
  right: svg('0 0 20 20', '<path d="m5.5 2.5 10 7.5-10 7.5z" fill="currentColor"/>'),
  more: svg('0 0 30 8', '<circle cx="4" cy="4" r="3.1" fill="currentColor"/><circle cx="15" cy="4" r="3.1" fill="currentColor"/><circle cx="26" cy="4" r="3.1" fill="currentColor"/>'),
  pointer: svg(
    '0 0 34 30',
    '<circle cx="10" cy="10" r="5.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="10" r="1.6" fill="currentColor"/><path d="M10 1.5v3.3M10 15.2v3.3M1.5 10h3.3M15.2 10h3.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M15.4 19.6c.9-2.1 2.7-3 5-3h5.4c2.3 0 4.1.9 5 3l1.6 5.5c.5 1.8-1.3 3.1-2.8 2l-3.3-2.6h-6.4l-3.3 2.6c-1.5 1.1-3.3-.2-2.8-2z" fill="currentColor"/>'
  ),
};

/* The controller shortcut printed in each function key's corner. */
const SHAPE = {
  triangle: svg('0 0 20 20', '<path d="M10 3 18 17H2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'),
  square: svg('0 0 20 20', '<rect x="3" y="3" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"/>'),
};
const BTN = {
  ps: { l2: 'L2', r2: 'R2', l1: 'L1', r1: 'R1', r3: 'R3', pointer: 'L3+R3', y: SHAPE.triangle, x: SHAPE.square },
  xbox: { l2: 'LT', r2: 'RT', l1: 'LB', r1: 'RB', r3: 'RS', pointer: 'LS+RS', y: 'Y', x: 'X' },
};
function btnLabel(action) {
  // On a keyboard and mouse there's no button to name.
  const style = getPromptStyle(state.settings.prompts);
  return (BTN[style] && BTN[style][action]) || '';
}
on('device', () => document.querySelectorAll('.osk [data-btn]').forEach((el) => (el.innerHTML = btnLabel(el.dataset.btn))));

/**
 * @param {{
 *   input: HTMLInputElement,          // where the text goes
 *   onChange?: () => void,             // the text changed
 *   onDone: () => void,                // Done (R2)
 *   doneLabel?: string,
 *   capitalize?: boolean,              // shift the first letter, as for a name
 * }} opts
 */
export function createOSK({ input, onChange = () => {}, onDone, doneLabel = 'Done', capitalize = false }) {
  let page = 'abc';
  let shift = 'off'; // off | once | lock
  const rows = []; // focusable elements, by row: four of keys, then the two function rows
  let row = 2;
  let col = 4; // G, where the PS5 starts
  let focused = false;

  const keep = (e) => e.preventDefault(); // a click mustn't take the focus (and the caret) from the input
  const keyRows = PAGES.abc.map((chars, ri) => {
    rows[ri] = chars.map((_, ci) =>
      h('button', {
        class: 'osk-key fx fx-in',
        tabindex: '-1',
        onmousedown: keep,
        onmouseenter: () => mouseActive() && setFocus(ri, ci),
        onclick: () => activate(ri, ci),
      })
    );
    return h('div', { class: 'osk-row' }, rows[ri]);
  });

  const cell = (id, html, { btn = null, cls = '', grow = 1 } = {}) =>
    h(
      'button',
      {
        class: `osk-cell fx fx-in k-${id}${cls ? ` ${cls}` : ''}`,
        tabindex: '-1',
        style: { flexGrow: grow },
        dataset: { k: id },
        onmousedown: keep,
        onclick: (e) => {
          const r = rows.findIndex((list) => list.includes(e.currentTarget));
          if (r >= 0) activate(r, rows[r].indexOf(e.currentTarget));
        },
        onmouseenter: (e) => {
          if (!mouseActive()) return;
          const r = rows.findIndex((list) => list.includes(e.currentTarget));
          if (r >= 0) setFocus(r, rows[r].indexOf(e.currentTarget));
        },
      },
      h('span', { class: 'osk-lbl', html }),
      btn ? h('span', { class: 'osk-btn', dataset: { btn }, html: btnLabel(btn) }) : null
    );

  const shiftEl = cell('shift', ICONS.shift, { btn: 'l2', grow: 230 });
  const tabEls = [cell('abc', 'ABC', { cls: 'tab' }), cell('sym', '@#:', { cls: 'tab' }), cell('acc', 'à', { cls: 'tab', btn: 'r3' })];
  const spaceEl = cell('space', ICONS.space, { btn: 'y', grow: 143 });
  const backEl = cell('back', ICONS.back, { btn: 'x', grow: 143 });
  const leftEl = cell('left', ICONS.left, { btn: 'l1', grow: 114 });
  const rightEl = cell('right', ICONS.right, { btn: 'r1', grow: 114 });
  const moreEl = cell('more', ICONS.more, { grow: 172 });
  const pointerEl = cell('pointer', ICONS.pointer, { btn: 'pointer', grow: 172 });
  const doneEl = cell('done', t(doneLabel), { btn: 'r2', grow: 289 });
  rows[4] = [shiftEl, ...tabEls, spaceEl, backEl];
  rows[5] = [leftEl, rightEl, moreEl, pointerEl, doneEl];

  const el = h(
    'div',
    { class: 'osk' },
    h('div', { class: 'osk-bar' }),
    h('div', { class: 'osk-keys' }, keyRows),
    h(
      'div',
      { class: 'osk-fn' },
      h('div', { class: 'osk-fn-row' }, shiftEl, h('div', { class: 'osk-tabs', style: { flexGrow: 347 } }, tabEls), spaceEl, backEl),
      h('div', { class: 'osk-fn-row' }, rows[5])
    )
  );

  /* ---- What the keys show ---------------------------------------------- */
  const charAt = (ri, ci) => {
    const c = PAGES[page][ri][ci];
    if (shift === 'off') return c;
    if (page === 'abc' && SHIFTED[c]) return SHIFTED[c];
    const up = c.toLocaleUpperCase();
    return up.length === 1 ? up : c;
  };
  function paint() {
    for (let ri = 0; ri < 4; ri++) rows[ri].forEach((k, ci) => (k.textContent = charAt(ri, ci)));
    shiftEl.querySelector('.osk-lbl').innerHTML = shift === 'lock' ? ICONS.shiftLock : shift === 'once' ? ICONS.shiftOn : ICONS.shift;
    shiftEl.classList.toggle('on', shift !== 'off');
    tabEls.forEach((e) => e.classList.toggle('active', e.dataset.k === page));
  }

  /* ---- Focus ------------------------------------------------------------ */
  function setFocus(r, c) {
    const next = rows[r][c];
    if (!next) return;
    if (focused) rows[row][col]?.classList.remove('focused');
    row = r;
    col = c;
    focused = true;
    next.classList.add('focused');
  }
  const center = (e) => {
    const b = e.getBoundingClientRect();
    return b.left + b.width / 2;
  };
  function moveVert(d) {
    const nr = row + d;
    if (nr < 0 || nr >= rows.length) return false;
    const x = center(rows[row][col]);
    let best = 0;
    let bestD = Infinity;
    rows[nr].forEach((e, ci) => {
      const dd = Math.abs(center(e) - x);
      if (dd < bestD) {
        bestD = dd;
        best = ci;
      }
    });
    setFocus(nr, best);
    return true;
  }

  /* ---- Editing ---------------------------------------------------------- */
  const changed = () => {
    if (capitalize && !input.value && shift === 'off') {
      shift = 'once';
      paint();
    }
    onChange();
  };
  function insert(text) {
    const s = input.selectionStart ?? input.value.length;
    const e = input.selectionEnd ?? s;
    input.setRangeText(text, s, e, 'end');
    changed();
  }
  function backspace() {
    const s = input.selectionStart ?? input.value.length;
    const e = input.selectionEnd ?? s;
    if (s !== e) input.setRangeText('', s, e, 'end');
    else if (s > 0) input.setRangeText('', s - 1, s, 'end');
    else return false;
    changed();
    return true;
  }
  function caret(d) {
    const s = input.selectionStart ?? input.value.length;
    const e = input.selectionEnd ?? s;
    const p = s !== e ? (d < 0 ? s : e) : Math.max(0, Math.min(input.value.length, s + d));
    input.setSelectionRange(p, p);
    return p !== s || s !== e;
  }
  async function paste() {
    let text = '';
    try {
      text = await (window.api && window.api.clipboardText ? window.api.clipboardText() : navigator.clipboard.readText());
    } catch {}
    text = String(text || '').replace(/[\r\n]+/g, ' ');
    if (!text) return sfx.bump();
    insert(text);
    sfx.select();
  }
  function setShift(next) {
    shift = next;
    paint();
  }
  function setPage(p) {
    page = p;
    paint();
  }

  const pressFx = (e) => e && replayClass(e, 'press');

  /** A key or function key, chosen with the cross (or clicked). */
  function activate(r, c) {
    const target = rows[r][c];
    if (r < 4) {
      insert(charAt(r, c));
      sfx.type();
      if (shift === 'once') setShift('off');
      pressFx(target);
      return;
    }
    run(target.dataset.k, target);
  }

  /** What a function key (or its controller shortcut) does. */
  function run(k, target) {
    pressFx(target);
    switch (k) {
      case 'shift':
        // once → for one letter; again → caps lock; again → off
        setShift(shift === 'off' ? 'once' : shift === 'once' ? 'lock' : 'off');
        sfx.toggle(shift !== 'off');
        break;
      case 'abc':
      case 'sym':
      case 'acc':
        if (page !== k) setPage(k);
        sfx.tab();
        break;
      case 'space':
        insert(' ');
        sfx.type();
        break;
      case 'back':
        if (backspace()) sfx.type();
        else sfx.bump();
        break;
      case 'left':
      case 'right':
        if (caret(k === 'left' ? -1 : 1)) sfx.move();
        else sfx.bump();
        break;
      case 'more':
        sfx.select();
        moreMenu();
        break;
      case 'pointer':
        paste();
        break;
      case 'done':
        onDone();
        break;
    }
  }

  async function moreMenu() {
    const { optionsMenu } = await import('./dialogs.js');
    const pick = await optionsMenu({
      title: 'Keyboard',
      items: [
        { id: 'paste', label: 'Paste' },
        { id: 'all', label: 'Select All', disabled: !input.value },
        { id: 'clear', label: 'Clear Text', disabled: !input.value },
      ],
      anchor: moreEl,
      side: 'above',
    });
    const id = pick && pick.id;
    if (id === 'paste') paste();
    else if (id === 'all') input.setSelectionRange(0, input.value.length);
    else if (id === 'clear') {
      input.value = '';
      changed();
    }
  }

  // L3 and R3 together: the pointer key. R3 alone: the next page.
  let stickAt = { l3: 0, r3: 0 };
  let pageBefore = null;
  function stick(which) {
    const now = performance.now();
    const other = which === 'l3' ? 'r3' : 'l3';
    stickAt[which] = now;
    if (now - stickAt[other] < 250) {
      if (pageBefore) setPage(pageBefore); // R3 came first: undo its page turn
      pageBefore = null;
      stickAt = { l3: 0, r3: 0 };
      run('pointer', pointerEl);
      return;
    }
    if (which === 'r3') {
      pageBefore = page;
      setTimeout(() => (pageBefore = null), 260);
      run(TABS[(TABS.indexOf(page) + 1) % TABS.length], tabEls[(TABS.indexOf(page) + 1) % TABS.length]);
    }
  }

  if (capitalize && !input.value) shift = 'once';
  paint();
  setFocus(row, col);

  return {
    el,
    /** Controller / arrow keys. False when a move runs off the keyboard. */
    handle(action) {
      switch (action) {
        case 'left':
        case 'right': {
          const c = col + (action === 'left' ? -1 : 1);
          if (c < 0 || c >= rows[row].length) return false;
          setFocus(row, c);
          sfx.move();
          return true;
        }
        case 'up':
        case 'down':
          if (!moveVert(action === 'up' ? -1 : 1)) return false;
          sfx.move();
          return true;
        case 'confirm':
          activate(row, col);
          return true;
        case 'x':
          run('back', backEl);
          return true;
        case 'y':
          run('space', spaceEl);
          return true;
        case 'l2':
          run('shift', shiftEl);
          return true;
        case 'l1':
          run('left', leftEl);
          return true;
        case 'r1':
          run('right', rightEl);
          return true;
        case 'l3':
        case 'r3':
          stick(action);
          return true;
        case 'r2':
        case 'options':
          run('done', doneEl);
          return true;
      }
      return false;
    },
    /** Typed on a physical keyboard: keep the one-letter shift in step. */
    typed() {
      if (shift === 'once' && input.value) setShift('off');
      if (capitalize && !input.value && shift === 'off') setShift('once');
    },
    focusRow(r) {
      setFocus(Math.max(0, Math.min(rows.length - 1, r)), 0);
    },
    blur() {
      rows[row][col]?.classList.remove('focused');
      focused = false;
    },
    refocus() {
      setFocus(row, col);
    },
  };
}
