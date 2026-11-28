// Overlay stack: the top overlay receives input before the active view.

import { emit } from '../state.js';
import { mouseActive, lastMoveAngle } from '../input.js';

const stack = [];
const root = document.getElementById('overlays');

export function topOverlay() {
  return stack[stack.length - 1] || null;
}

export function overlayCount() {
  return stack.length;
}

/**
 * Mount an overlay element. `handle(action, meta)` receives input while it is
 * on top. Returns a controller with close().
 */
export function mountOverlay(el, handle, { onClose, closeDelay = 260, dimApp = false } = {}) {
  let closed = false;
  const o = {
    el,
    handle,
    dimApp,
    close(result) {
      if (closed) return;
      closed = true;
      const i = stack.indexOf(o);
      if (i >= 0) stack.splice(i, 1);
      el.classList.remove('open');
      el.classList.add('closing');
      setTimeout(() => el.remove(), closeDelay);
      syncDim();
      emit('overlay', stack.length);
      onClose && onClose(result);
    },
    get closed() {
      return closed;
    },
  };
  root.append(el);
  stack.push(o);
  syncDim();
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
  emit('overlay', stack.length);
  return o;
}

function syncDim() {
  document.getElementById('app').classList.toggle('dimmed', stack.some((o) => o.dimApp));
}

/**
 * PS5 focus move: a band of light sweeps across the newly focused element in
 * the direction focus travelled, at any angle (up, down, sideways or
 * diagonal). Measured frame by frame from a video of a PS5 (profile cards,
 * Settings rows, home tiles), the lit area
 * - is shaped like the item itself with very rounded corners: its front
 *   bows forward by about the same depth on any item (~2.6% of the screen's
 *   height: a gentle arc right across a long row, a round tip on a short
 *   one) and its corners sweep back along the item's borders over ~90% of
 *   the length, within ~17% of its smaller side, so it hugs the borders
 *   (on squarish items; on long rows the front is just the arc);
 * - comes in over the near edge, sweeps across and lands on the far one,
 *   slowing down; as it lands its front flattens into the far edge, so the
 *   light ends in the item's own shape there; the next item's wave starts
 *   where this one lands, so a run of moves reads as one wave;
 * - is brightest over the front quarter (~14% white) and fades out over a
 *   tail ~60% of the length that shortens to ~40%;
 * - fades out as it lands, in about 0.28 s whichever way it goes (even on an
 *   item still sliding into place), while the focus ring fades in.
 * Its geometry is in container units of the wave box, so it keeps covering
 * an item that grows or shrinks as it gains focus (the quick menu's cards),
 * and it plays where a sliding item (a carousel tile) is going, not on the
 * way there (see settle).
 * It is driven by the .focused class (see initFocusWave), so every view gets
 * it without wiring.
 */
const WAVE_MS = 280;

/**
 * When the host is still sliding or scaling into place as it gains focus (a
 * carousel tile moving into the focus slot), move the wave's frame against
 * that motion, so the light plays where the host is going rather than riding
 * along with it, as on the PS5: the tile slides in under the light.
 */
function settle(host, frame) {
  const moving = [];
  for (let el = host; el && el !== document.body; el = el.parentElement) {
    for (const a of el.getAnimations()) {
      if (a.playState !== 'running' || !a.effect || !Number.isFinite(a.effect.getComputedTiming().endTime)) continue;
      const props = a.transitionProperty ? [a.transitionProperty] : a.effect.getKeyframes().flatMap((k) => Object.keys(k));
      if (props.some((p) => /^(transform|translate|scale|left|top|right|bottom|margin)/.test(p))) moving.push(a);
    }
  }
  if (!moving.length) return;
  const w = host.offsetWidth;
  const start = moving.map((a) => a.currentTime);
  const left = Math.min(600, Math.max(...moving.map((a, i) => a.effect.getComputedTiming().endTime - start[i])));
  if (!(left > 30)) return;
  // Sample where the host will be over the rest of its motion.
  const at = (t) => {
    moving.forEach((a, i) => (a.currentTime = start[i] + t));
    const r = host.getBoundingClientRect();
    return { x: r.left, y: r.top, s: r.width / w };
  };
  const samples = [];
  for (let t = 0; t < left; t += 10) samples.push([t, at(t)]);
  const end = at(left);
  moving.forEach((a, i) => (a.currentTime = start[i]));
  if (!end.s) return;
  // In the host's own units: where its final place is, at each moment.
  const frames = samples.map(([t, p]) => ({
    offset: t / left,
    transform: `translate(${(end.x - p.x) / p.s}px, ${(end.y - p.y) / p.s}px) scale(${end.s / p.s})`,
  }));
  frames.push({ offset: 1, transform: 'none' });
  frame.animate(frames, { duration: left, fill: 'both' });
}

/** Plays the wave on host (the element that draws the focus ring), travelling at angle (radians, screen axes: 0 = right, PI/2 = down). */
export function playWave(host, angle) {
  if (!host || document.body.classList.contains('reduce-motion')) return;
  const old = host.querySelector(':scope > .fx-wave');
  if (old) old.remove();
  const w = host.offsetWidth;
  const h = host.offsetHeight;
  if (!w || !h) return;
  // The light is a copy of the item's own box (kept square to it, never
  // turned) that slides in along the move, so at any angle its edges follow
  // the item's borders and its leading corners round off like the item's.
  // Sizes are in container units of the wave box (which fills the host), so
  // they follow the host while it resizes.
  // How much the light moves along each axis: the main direction in full,
  // the other by the cube of its share, so a mostly vertical move (Up onto
  // an item a little to the side) moves and looks like a vertical one, with
  // the light across the whole item and its corners on the item's, while a
  // true diagonal moves both ways and leads with a corner.
  const cx = Math.cos(angle);
  const cy = Math.sin(angle);
  const m = Math.max(Math.abs(cx), Math.abs(cy));
  const ex = Math.sign(cx) * (Math.abs(cx) / m) ** 3;
  const ey = Math.sign(cy) * (Math.abs(cy) / m) ** 3;
  // How much each side leads the move (0 for the sides it leaves behind).
  const lead = { r: Math.max(0, ex), l: Math.max(0, -ex), b: Math.max(0, ey), t: Math.max(0, -ey) };

  const wave = document.createElement('span');
  wave.className = 'fx-wave';
  wave.dataset.angle = String(angle);
  // light: the lit area, its leading sides bowed (clips the fill); fill: the
  // light itself, its leading corners sweeping back along the borders.
  const light = document.createElement('span');
  light.className = 'fx-wave-light';
  const fill = document.createElement('span');
  fill.className = 'fx-wave-fill';
  // Brightest over the front, fading out over the back ~60% (CSS angles:
  // 90deg is to the right).
  const travel = Math.atan2(ey * h, ex * w);
  fill.style.background = `linear-gradient(${(travel * 180) / Math.PI + 90}deg, rgba(255, 255, 255, 0) 40%, rgba(255, 255, 255, var(--wave, 0.14)) 76%)`;
  light.append(fill);
  const frame = document.createElement('span');
  frame.className = 'fx-wave-frame';
  frame.append(light);
  wave.append(frame);
  host.append(wave);
  // On an item still sliding into place, the light plays where it is going.
  // It keeps its own pace, so a move along a sliding row is as quick as one
  // across it.
  settle(host, frame);
  const ms = WAVE_MS;

  // It comes in over the near edge, sweeps across and lands on the item,
  // slowing down as it gets there; the next item's wave starts where this
  // one lands, so a run of moves reads as one wave passing along.
  // From just outside the item (by its own size along each axis it moves on)
  // to on it.
  const at = (k) => `translate(${(-k * ex * 100).toFixed(3)}cqw, ${(-k * ey * 100).toFixed(3)}cqh)`;
  const timing = { duration: ms, easing: 'cubic-bezier(0.25, 0.7, 0.3, 1)', fill: 'both' };
  light.animate([{ transform: at(1) }, { transform: at(0) }], timing);
  // As it lands its front flattens into the far edge, so the light ends up
  // in the item's own shape (the wave box clips it to the item's rounded
  // corners). k: how much of the travelling shape is left, over time.
  const land = [
    [0, 1],
    [0.25, 0.75],
    [0.45, 0.4],
    [0.7, 0.12],
    [1, 0],
  ];
  const shape = { duration: ms, fill: 'both' };
  // Corner radii (horizontal / vertical) from how much the sides meeting at
  // each corner lead: a leading side gets `deep` across it and `half` along it.
  const radii = (deepX, deepY, halfX, halfY) => {
    const corner = (sx, sy) => [
      `max(${deepX(lead[sx])}, ${halfX(lead[sy])})`,
      `max(${halfY(lead[sx])}, ${deepY(lead[sy])})`,
    ];
    const tl = corner('l', 't');
    const tr = corner('r', 't');
    const br = corner('r', 'b');
    const bl = corner('l', 'b');
    return `${tl[0]} ${tr[0]} ${br[0]} ${bl[0]} / ${tl[1]} ${tr[1]} ${br[1]} ${bl[1]}`;
  };
  const px = (v) => `${v.toFixed(4)}px`;
  // On a round item (its corners at least ~half its size) the light is round
  // too, so its front is a semicircle that curves like the item and lands as
  // its far edge.
  const round = (parseFloat(getComputedStyle(wave).borderTopLeftRadius) || 0) >= 0.45 * Math.min(w, h);
  // The leading sides bow forward by about the same depth on any item (~2.6%
  // of the screen's height: a gentle arc across a long row, a round tip on a
  // short one), flattening as it lands.
  const bow = (k) =>
    round
      ? '50%'
      : radii(
          (a) => `min(${(2.6 * k * a).toFixed(4)}vh, 50cqw)`,
          (a) => `min(${(2.6 * k * a).toFixed(4)}vh, 50cqh)`,
          (a) => `${(50 * a).toFixed(3)}cqw`,
          (a) => `${(50 * a).toFixed(3)}cqh`,
        );
  light.animate(
    land.map(([offset, k]) => ({ offset, borderRadius: bow(k) })),
    shape,
  );
  // On squarish items (cards, tiles) the leading corners also sweep back
  // along the borders, over most of the item, within a share of its smaller
  // side, so the lit area looks like the item with very rounded corners.
  const q = Math.min(w, h) / Math.max(w, h);
  const deep = round ? 0 : q * q;
  const side = Math.min(w, h);
  const corners = (k) =>
    radii(
      (a) => `${(90 * k * deep * a).toFixed(3)}cqw`,
      (a) => `${(90 * k * deep * a).toFixed(3)}cqh`,
      (a) => px(0.17 * k * deep * a * side),
      (a) => px(0.17 * k * deep * a * side),
    );
  fill.animate(
    land.map(([offset, k]) => ({ offset, borderRadius: corners(k) })),
    shape,
  );
  const fade = wave.animate(
    [
      { opacity: 1, offset: 0 },
      { opacity: 0.9, offset: 0.35 },
      { opacity: 0.45, offset: 0.7 },
      { opacity: 0, offset: 1 },
    ],
    shape,
  );
  // Drop it once it has played: a view that is hidden and shown again would
  // otherwise show it again. (The timer too, in case animations are paused,
  // e.g. while the window is hidden.)
  const done = () => wave.remove();
  fade.onfinish = fade.oncancel = done;
  setTimeout(done, ms + 100);
}

/**
 * Direction of a move from rect a to rect b, as an angle, or null if they are
 * in the same place. Along an axis where the two overlap (a row of tiles, a
 * column of list rows), the offset on that axis is dropped, so moves within a
 * row or column are straight even when the items differ in size; items that
 * don't line up give a diagonal.
 */
export function moveAngle(a, b) {
  const overlap = (a0, a1, b0, b1, size) => Math.min(1, Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / Math.max(1, size));
  let dx = b.left + b.width / 2 - (a.left + a.width / 2);
  let dy = b.top + b.height / 2 - (a.top + a.height / 2);
  dx *= 1 - overlap(a.left, a.right, b.left, b.right, Math.min(a.width, b.width));
  dy *= 1 - overlap(a.top, a.bottom, b.top, b.bottom, Math.min(a.height, b.height));
  if (Math.hypot(dx, dy) < 2) return null;
  return Math.atan2(dy, dx);
}

/**
 * The wave's direction: the way the move was pressed, turned 30% of the way
 * towards where focus actually went. Measured on a PS5 (Up from a home tile
 * to the Games tab, which sits up and to the left): the band went up, tilted
 * about 14 deg to the left, where the two items' centres are 44 deg off
 * vertical. So moves along a row or column stay straight, and jumps to an
 * item off to the side lean that way, at any angle. If focus went against
 * the press (a list wrapping round) or didn't move on screen, the press.
 * (geom is null when it didn't move; pressed null: no press, use geom.)
 */
export function waveAngle(geom, pressed) {
  if (pressed === null) return geom;
  if (geom === null) return pressed;
  const diff = Math.atan2(Math.sin(geom - pressed), Math.cos(geom - pressed));
  if (Math.abs(diff) > (100 * Math.PI) / 180) return pressed;
  return pressed + 0.3 * diff;
}

/** The element that draws the ring for a focused element: itself, or its .fx child. */
function ringOf(el) {
  if (el.classList.contains('fx')) return el;
  return el.querySelector(':scope > .fx');
}

/** The view or overlay an element belongs to: waves only link moves within one. */
function scopeOf(el) {
  return el.closest('#overlays > *, .view');
}

function shown(el) {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  return r.width || r.height ? r : null;
}

const HAS_FOCUSED = /(^|\s)focused(\s|$)/;
let lastFocus = null;

/** For an element that just gained focus, the one focus moved from (or null). */
function previousOf(el, lost) {
  const scope = scopeOf(el);
  const related = (o) => o !== el && !o.contains(el) && !el.contains(o) && scopeOf(o) === scope;
  // Usually the element that lost .focused in the same update. With several
  // (a zone change that also clears another list), the one closest to el in
  // the page structure, then on screen.
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let best = null;
  let bestKey = null;
  for (const o of lost) {
    if (!related(o)) continue;
    let depth = 0;
    for (let p = el.parentElement; p && !p.contains(o); p = p.parentElement) depth++;
    const q = o.getBoundingClientRect();
    const dist = Math.hypot(q.left + q.width / 2 - cx, q.top + q.height / 2 - cy);
    if (!best || depth < bestKey[0] || (depth === bestKey[0] && dist < bestKey[1])) {
      best = o;
      bestKey = [depth, dist];
    }
  }
  if (best) return best;
  // Otherwise, the last element that gained focus if it still has it (one list
  // keeps its focus mark while another gets focus, e.g. a menu and its page).
  return lastFocus && lastFocus.classList.contains('focused') && related(lastFocus) ? lastFocus : null;
}

/**
 * Watches for elements gaining .focused after a move is pressed and plays
 * the wave on them, in the direction of the move. Call once.
 */
export function initFocusWave(root = document.body) {
  new MutationObserver((records) => {
    // Whether each element had .focused before this update (its first record's old value).
    const before = new Map();
    for (const m of records) {
      if (!before.has(m.target)) before.set(m.target, HAS_FOCUSED.test(m.oldValue || ''));
    }
    const gained = [];
    const lost = [];
    for (const [el, was] of before) {
      const is = el.classList.contains('focused');
      if (is && !was) gained.push(el);
      else if (was && !is) lost.push(el);
    }
    // Only for moves pressed on the controller or keyboard: the PS5 plays no
    // wave when a page opens or focus is put somewhere by the app.
    const pressed = gained.length ? lastMoveAngle() : null;
    for (const el of gained) {
      const prev = previousOf(el, lost);
      lastFocus = el;
      if (!prev || pressed === null || mouseActive()) continue;
      const ring = ringOf(el);
      if (!ring || ring.closest('.no-wave') || /^(INPUT|TEXTAREA|IMG|SELECT)$/.test(ring.tagName)) continue;
      const a = shown(prev);
      const b = shown(el);
      if (!a || !b) continue;
      playWave(ring, waveAngle(moveAngle(a, b), pressed));
    }
  }).observe(root, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
}

/** Simple focus list used by menus, dialogs and settings. */
export class FocusList {
  constructor(els = [], { index = 0, onChange = null, wrap = false } = {}) {
    this.els = els;
    this.index = -1;
    this.onChange = onChange;
    this.wrap = wrap;
    if (els.length) this.set(Math.min(index, els.length - 1), { silent: true });
  }

  setItems(els, index = 0) {
    this.els = els;
    this.index = -1;
    if (els.length) this.set(Math.max(0, Math.min(index, els.length - 1)), { silent: true });
  }

  get current() {
    return this.els[this.index] || null;
  }

  set(i, { silent = false } = {}) {
    if (i === this.index || i < 0 || i >= this.els.length) return false;
    const prev = this.current;
    if (prev) prev.classList.remove('focused');
    this.index = i;
    const cur = this.current;
    cur.classList.add('focused');
    if (this.onChange && !silent) this.onChange(cur, i, silent);
    return true;
  }

  move(delta) {
    if (!this.els.length) return false;
    let i = this.index + delta;
    if (this.wrap) i = (i + this.els.length) % this.els.length;
    if (i < 0 || i >= this.els.length) return false;
    // Skip disabled entries
    while (this.els[i] && this.els[i].classList.contains('disabled')) {
      i += Math.sign(delta);
      if (i < 0 || i >= this.els.length) return false;
    }
    return this.set(i);
  }

  blur() {
    if (this.current) this.current.classList.remove('focused');
  }

  refocus() {
    if (this.current) this.current.classList.add('focused');
  }
}
