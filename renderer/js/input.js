// Unified input: keyboard, gamepads (standard mapping) and mouse-idle cursor
// hiding. Everything is reduced to semantic actions:
//   up down left right confirm back options guide x y l1 r1 l2 r2 select

import { emit } from './state.js';

const KEYS = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'confirm',
  NumpadEnter: 'confirm',
  ' ': 'confirm',
  Escape: 'back',
  Backspace: 'back',
  BrowserBack: 'back',
  Home: 'guide',
  F1: 'guide',
  '`': 'guide',
  ContextMenu: 'options',
  F2: 'options',
  PageUp: 'l1',
  PageDown: 'r1',
};
// Letter shortcuts only when no text field has focus.
const LETTER_KEYS = { o: 'options', q: 'l1', e: 'r1', x: 'x', y: 'y', f: 'y', '/': 'search', s: 'search' };

const BUTTONS = {
  0: 'confirm',
  1: 'back',
  2: 'x',
  3: 'y',
  4: 'l1',
  5: 'r1',
  6: 'l2',
  7: 'r2',
  8: 'select',
  9: 'options',
  12: 'up',
  13: 'down',
  14: 'left',
  15: 'right',
  16: 'guide',
  17: 'select',
};

const REPEATABLE = new Set(['up', 'down', 'left', 'right']);
const FIRST_DELAY = 360;

let handler = () => false;
let device = 'keyboard';
let padKind = 'xbox';
let lastPad = null;
const held = new Map(); // action -> { next, count }
let cursorTimer = null;
let suppressMouseUntil = 0;

export function setHandler(fn) {
  handler = fn;
}

export function getDevice() {
  return device;
}

/** 'xbox' | 'ps' | 'keyboard' — used for button prompts. */
export function getPromptStyle(pref = 'auto') {
  if (pref && pref !== 'auto') return pref;
  if (device === 'gamepad') return padKind;
  return 'keyboard';
}

function setDevice(d, kind) {
  const changed = d !== device || (kind && kind !== padKind);
  device = d;
  if (kind) padKind = kind;
  document.body.dataset.input = d;
  if (d !== 'mouse') {
    document.body.classList.add('hide-cursor');
    suppressMouseUntil = performance.now() + 400;
  }
  if (changed) emit('device', { device, padKind });
}

// The Guide button can arrive twice (browser gamepad + native helper).
let lastGuideAt = 0;

function fire(action, source) {
  if (action === 'guide') {
    const now = performance.now();
    if (now - lastGuideAt < 350) return;
    lastGuideAt = now;
  }
  try {
    handler(action, { source, repeat: false });
  } catch (err) {
    console.error('[input] handler error', err);
  }
}

function fireRepeat(action) {
  try {
    handler(action, { source: 'gamepad', repeat: true });
  } catch (err) {
    console.error('[input] handler error', err);
  }
}

function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && !a.readOnly;
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

window.addEventListener(
  'keydown',
  (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = isTyping();
    let action = KEYS[e.key];
    if (typing) {
      // Inside text fields, only a handful of keys navigate.
      if (!['ArrowUp', 'ArrowDown', 'Escape', 'Enter', 'NumpadEnter', 'F1', 'Home'].includes(e.key)) return;
      if (e.key === 'Home') return;
    } else if (!action) {
      action = LETTER_KEYS[e.key.toLowerCase()];
    }
    if (!action) return;
    e.preventDefault();
    setDevice('keyboard');
    handler(action, { source: 'keyboard', repeat: e.repeat });
  },
  true
);

/* ------------------------------------------------------------------ */
/* Mouse                                                               */
/* ------------------------------------------------------------------ */

window.addEventListener('mousemove', () => {
  if (performance.now() < suppressMouseUntil) return;
  document.body.classList.remove('hide-cursor');
  if (device !== 'mouse') setDevice('mouse');
  document.body.classList.remove('hide-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.add('hide-cursor'), 3500);
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 3) {
    e.preventDefault();
    handler('back', { source: 'mouse' });
  }
});

// Right-click opens the options menu for whatever is under the cursor.
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (e.target.closest('input, textarea')) return;
  const tile = e.target.closest('.tile:not(.sel)');
  if (tile) tile.click();
  setTimeout(() => handler('options', { source: 'mouse' }), tile ? 60 : 0);
});

/** True if the mouse is the active device (so hover may move focus). */
export function mouseActive() {
  return device === 'mouse' && performance.now() > suppressMouseUntil;
}

/* ------------------------------------------------------------------ */
/* Gamepad                                                             */
/* ------------------------------------------------------------------ */

function kindOf(pad) {
  const id = (pad.id || '').toLowerCase();
  if (/054c|dualsense|dualshock|wireless controller|playstation|ps4|ps5/.test(id)) return 'ps';
  return 'xbox';
}

const prevButtons = new Map(); // pad index -> Set(actions)

let pollPads = true;

/** The overlay window gets controller input from the native helper instead. */
export function setGamepadPolling(on) {
  pollPads = !!on;
}

/** Input that arrives from the main process (native controller reading). */
export function externalAction(action, { repeat = false } = {}) {
  setDevice('gamepad');
  if (repeat) fireRepeat(action);
  else fire(action, 'gamepad');
}

let hadFocus = true;

/** Buttons currently held on all pads (used to swallow presses across focus changes). */
function currentPressed(pad) {
  const pressed = new Set();
  pad.buttons.forEach((b, i) => {
    const a = BUTTONS[i];
    if (a && (b.pressed || b.value > 0.6)) pressed.add(a);
  });
  return pressed;
}

function poll(now) {
  if (!pollPads) {
    requestAnimationFrame(poll);
    return;
  }
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  // Chromium keeps reporting the controller to background windows. The launcher
  // must ignore it while a game (or the overlay) has focus — and a button that
  // is still held when we get focus back must not count as a new press.
  const focused = document.hasFocus();
  if (!focused || !hadFocus) {
    held.clear();
    for (const pad of pads) if (pad && pad.connected) prevButtons.set(pad.index, currentPressed(pad));
    hadFocus = focused;
    requestAnimationFrame(poll);
    return;
  }
  const active = new Set();
  for (const pad of pads) {
    if (!pad || !pad.connected) continue;
    const pressed = new Set();
    pad.buttons.forEach((b, i) => {
      const a = BUTTONS[i];
      if (a && (b.pressed || b.value > 0.6)) pressed.add(a);
    });
    const [ax = 0, ay = 0] = pad.axes;
    if (Math.abs(ax) > 0.55 && Math.abs(ax) > Math.abs(ay)) pressed.add(ax < 0 ? 'left' : 'right');
    else if (Math.abs(ay) > 0.55) pressed.add(ay < 0 ? 'up' : 'down');

    const prev = prevButtons.get(pad.index) || new Set();
    for (const a of pressed) {
      if (!prev.has(a)) {
        lastPad = pad.index;
        setDevice('gamepad', kindOf(pad));
        if (REPEATABLE.has(a)) {
          // Only one direction auto-repeats at a time.
          for (const k of [...held.keys()]) if (REPEATABLE.has(k)) held.delete(k);
          held.set(a, { next: now + FIRST_DELAY, count: 0 });
        }
        fire(a, 'gamepad');
      }
      active.add(a);
    }
    prevButtons.set(pad.index, pressed);
  }

  for (const [a, st] of held) {
    if (!active.has(a)) {
      held.delete(a);
      continue;
    }
    if (now >= st.next) {
      st.count++;
      st.next = now + (st.count > 6 ? 62 : st.count > 2 ? 85 : 115);
      fireRepeat(a);
    }
  }
  requestAnimationFrame(poll);
}
requestAnimationFrame(poll);

window.addEventListener('gamepadconnected', (e) => {
  emit('gamepad', { connected: true, pad: e.gamepad, kind: kindOf(e.gamepad) });
});
window.addEventListener('gamepaddisconnected', (e) => {
  prevButtons.delete(e.gamepad.index);
  emit('gamepad', { connected: false, pad: e.gamepad, kind: kindOf(e.gamepad) });
});

export function connectedPads() {
  return [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter((p) => p && p.connected).map((p) => ({ index: p.index, id: p.id, kind: kindOf(p) }));
}

export function rumble(strength = 0.25, duration = 40) {
  if (device !== 'gamepad' || lastPad === null) return;
  const pad = navigator.getGamepads()[lastPad];
  const act = pad && pad.vibrationActuator;
  if (!act || !act.playEffect) return;
  act.playEffect('dual-rumble', { duration, strongMagnitude: strength * 0.4, weakMagnitude: strength }).catch(() => {});
}
