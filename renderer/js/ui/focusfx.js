// Plays the focus ring's light, the glint and the arrival flash (base.css draws
// them) on whatever is focused. Driven from here rather than by CSS animations:
// an animated custom property or background restyles the page every frame (360
// times a second on a 360 Hz screen), while the ring's light only needs 15 steps
// a second and the glint moves only 1.58 s in every 5 s. Also marks round
// elements (.fx-round), whose ring is wrapped around a circle instead of a box.
//
// All measured from videos of the PS5, frame by frame:
//  - The glint: a soft band, 1.74 times the element's diagonal, crosses it from
//    the top-left corner to the bottom-right one (its brightest line runs from
//    the top-right corner to the bottom-left one) at a steady speed, in 1.58 s,
//    1.5 s after the element is focused and then every 5 s. Each point is lit
//    for a second (±0.5 s); the far end of a row 0.29 s after the near one.
//  - Moving onto a list row or a tab (.fx-in) with the controller: the ring
//    left behind goes at once; on the new one a flash of light with a tail
//    shoots towards its far edge in the direction of the move, slowing all the
//    way, and fades (0.3 s); its ring fades in from 0.17 s to 0.27 s.

import { RING_STEP, RING_FRAMES } from './ringlight.js';
import { recentMove } from '../input.js';

const ACTIVE = '.fx.focused, .focused > .fx, .fx.sel:not(.tile), .qm.customizing .qm-btn.fx.press';
const RING_FPS = 15; // the light's steps: it drifts slowly, and 15 a second look as smooth as more
const GLINT_DELAY = 1.5; // s after focus
const GLINT_EVERY = 5;
// The band's middle (it's 1.74 diagonals wide) along the element's diagonal, from
// where its front just reaches the top-left corner to where its back just leaves
// the bottom-right one (base.css, --gx): 2.74 diagonals at the PS5's speed, which
// crosses the element's width (half a diagonal on this scale) in 0.288 s.
const GLINT_FROM = -87;
const GLINT_TO = 187;
const GLINT_SWEEP = ((GLINT_TO - GLINT_FROM) / 100) * (0.288 / 0.5);

// The arrival flash: the distance its head has left to the far edge (a fraction
// of the element along the move) is a quick jump plus a long glide, each
// shrinking by e every tau seconds; it adds light (the PS5's adds ~50 of 255,
// whatever it's on), fading by e every 0.14 s; the ring comes in after RING_IN.
const FLASH = 0.28;
const FLASH_FADE = 0.14;
const FLASH_END = 0.3;
const ACROSS = { jump: [0.6, 0.012], glide: [0.25, 0.06] };
const DOWN = { jump: [0.4, 0.012], glide: [0.5, 0.09] };
const MOVE = { left: ACROSS, right: ACROSS, up: DOWN, down: DOWN };
const RING_IN = 0.17;
const RING_IN_FOR = 0.1;
// The flash: a soft capsule, bright at its head, fading along its tail.
const comet = (vertical, reverse) => {
  const [x1, y1, x2, y2] = vertical ? (reverse ? [0, 1, 0, 0] : [0, 0, 0, 1]) : reverse ? [1, 0, 0, 0] : [0, 0, 1, 0];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" preserveAspectRatio="none"><defs><linearGradient id="g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.8" stop-color="#fff" stop-opacity="0.75"/><stop offset="1" stop-color="#fff"/></linearGradient><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${vertical ? '10 8' : '8 14'}"/></filter></defs><rect x="${vertical ? 12 : 6}" y="${vertical ? 6 : 40}" width="${vertical ? 176 : 188}" height="${vertical ? 188 : 120}" rx="${vertical ? 60 : 50}" fill="url(#g)" filter="url(#b)"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
};
const COMETS = { right: comet(false, false), left: comet(false, true), down: comet(true, false), up: comet(true, true) };

const LOOP = (RING_FRAMES.length - 1) * RING_STEP;
const active = new Map(); // element → { start, ring (last frame drawn), glint (sweeping), rules, flash }
const checked = new WeakSet();
let raf = 0;
let timer = 0;
let seq = 0;
// The colours and the glint go to the ring's own ::before / ::after through rules
// of their own: set on the element, they'd restyle everything inside it too.
let sheet = null;
function rulesFor(el) {
  if (!sheet) {
    const style = document.createElement('style');
    style.id = 'fx-live';
    document.head.append(style);
    sheet = style.sheet;
  }
  const id = String(++seq);
  el.dataset.fx = id;
  const add = (pseudo) => sheet.cssRules[sheet.insertRule(`[data-fx="${id}"]${pseudo}{}`, sheet.cssRules.length)];
  return { ring: add('::before'), glint: add('::after') };
}
function dropRules(el, rules) {
  for (const rule of [rules.ring, rules.glint]) {
    const i = [...sheet.cssRules].indexOf(rule);
    if (i >= 0) sheet.deleteRule(i);
  }
  delete el.dataset.fx;
}

function markRound(el) {
  if (checked.has(el)) return;
  const ring = getComputedStyle(el, '::before');
  const w = parseFloat(ring.width);
  const h = parseFloat(ring.height);
  if (!w || !h) return; // not laid out yet: look again next time
  checked.add(el);
  const radius = parseFloat(ring.borderTopLeftRadius) || 0;
  el.classList.toggle('fx-round', Math.abs(w - h) < w * 0.06 && radius >= Math.min(w, h) * 0.45);
}

function ringAt(t) {
  const x = (((t % LOOP) + LOOP) % LOOP) / RING_STEP;
  const i = Math.floor(x);
  // 12 steps between measured frames (30 a second), as the light was sampled
  const f = Math.floor((x - i) * RING_STEP * RING_FPS) / (RING_STEP * RING_FPS);
  const a = RING_FRAMES[i];
  const b = RING_FRAMES[Math.min(i + 1, RING_FRAMES.length - 1)];
  return a.map((c, k) => {
    const d = b[k];
    return `rgba(${Math.round(c[0] + (d[0] - c[0]) * f)},${Math.round(c[1] + (d[1] - c[1]) * f)},${Math.round(c[2] + (d[2] - c[2]) * f)},${(c[3] + (d[3] - c[3]) * f).toFixed(3)})`;
  });
}

/** One frame of the arrival flash (false once it's over). */
function drawFlash(st, t) {
  const { dir, w, h } = st.flash;
  const glint = st.rules.glint.style;
  const ring = st.rules.ring.style;
  ring.setProperty('opacity', String(Math.max(0, Math.min(1, (t - RING_IN) / RING_IN_FOR))), 'important');
  if (t >= FLASH_END) {
    for (const p of ['background-image', 'background-size', 'background-position', 'opacity', 'mix-blend-mode']) glint.removeProperty(p);
    if (t >= RING_IN + RING_IN_FOR) {
      ring.removeProperty('opacity');
      return false;
    }
    return true;
  }
  const { jump, glide } = MOVE[dir];
  const left = jump[0] * Math.exp(-t / jump[1]) + glide[0] * Math.exp(-t / glide[1]); // of the way still to go
  const vertical = dir === 'up' || dir === 'down';
  // the flash: half the element long along the move (its tail), most of it across
  const along = (vertical ? h : w) * (vertical ? 0.55 : 0.5);
  const across = (vertical ? w : h) * (vertical ? 0.9 : 0.9);
  const span = vertical ? h : w;
  const head = dir === 'right' || dir === 'down' ? span * (1 - left) : span * left;
  const start = dir === 'right' || dir === 'down' ? head - along : head;
  const sw = vertical ? across : along;
  const sh = vertical ? along : across;
  const x = vertical ? (w - across) / 2 : start;
  const y = vertical ? start : (h - across) / 2;
  glint.setProperty('background-image', COMETS[dir], 'important');
  glint.setProperty('background-size', `${sw.toFixed(1)}px ${sh.toFixed(1)}px`, 'important');
  glint.setProperty('background-position', `${x.toFixed(1)}px ${y.toFixed(1)}px`, 'important');
  glint.setProperty('opacity', (FLASH * Math.exp(-t / FLASH_FADE)).toFixed(3), 'important');
  glint.setProperty('mix-blend-mode', 'plus-lighter', 'important');
  return true;
}

function stop(el) {
  const st = active.get(el);
  active.delete(el);
  if (st) dropRules(el, st.rules);
}

function tick(now) {
  raf = 0;
  timer = 0;
  if (!active.size) return;
  const still = document.body.classList.contains('reduce-motion');
  let fast = false;
  for (const [el, st] of active) {
    if (!el.isConnected || !el.matches(ACTIVE)) {
      stop(el);
      continue;
    }
    // Left focused on a screen that isn't showing: nothing to draw.
    if (still || el.closest('.view:not(.active)')) continue;
    const t = (now - st.start) / 1000;
    if (st.flash) {
      if (drawFlash(st, t)) fast = true;
      else st.flash = null;
    }
    const step = Math.floor(t * RING_FPS);
    if (step !== st.ring) {
      st.ring = step;
      const ring = st.rules.ring.style;
      ringAt(t).forEach((c, k) => ring.setProperty(`--r${k}`, c));
    }
    const g = t - GLINT_DELAY;
    const p = g >= 0 ? (g % GLINT_EVERY) / GLINT_SWEEP : 2;
    if (p < 1) {
      fast = true;
      st.glint = true;
      st.rules.glint.style.setProperty('--glint-o', '1');
      st.rules.glint.style.setProperty('--glint-x', `${(GLINT_FROM + (GLINT_TO - GLINT_FROM) * p).toFixed(2)}%`);
    } else if (st.glint) {
      st.glint = false;
      st.rules.glint.style.setProperty('--glint-o', '0');
    }
  }
  if (!active.size || still) return;
  // The flash and the glint move smoothly (up to 60 frames a second); otherwise
  // only the ring's steps. Asleep in between, then in step with the screen.
  const wait = fast ? 1000 / 60 : 1000 / RING_FPS;
  timer = setTimeout(() => {
    timer = 0;
    raf = requestAnimationFrame(tick);
  }, wait - 6);
}

function kick() {
  if (active.size && !raf && !timer) raf = requestAnimationFrame(tick);
}

function start(el) {
  markRound(el);
  if (active.has(el)) return;
  const st = { start: performance.now(), ring: -1, glint: false, rules: rulesFor(el), flash: null };
  // Reached by a move of the controller or the arrow keys: the arrival flash (list rows and tabs).
  const dir = el.classList.contains('fx-in') && !document.body.classList.contains('reduce-motion') ? recentMove() : null;
  if (dir) {
    st.flash = { dir, w: el.offsetWidth, h: el.offsetHeight };
    st.rules.ring.style.setProperty('opacity', '0', 'important');
  }
  active.set(el, st);
  kick();
}

function look(el) {
  if (!el.classList) return;
  if (el.matches(ACTIVE)) start(el);
  else if (active.has(el)) stop(el);
  if (el.classList.contains('focused')) for (const child of el.children) if (child.matches(ACTIVE)) start(child);
}

export function watchFocusRings() {
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.target === document.body) kick(); // Reduce Motion turned off: moving again
        look(r.target);
        // .focused > .fx: the parent lost its focus
        if (!r.target.classList.contains('focused')) for (const child of r.target.children) if (active.has(child)) stop(child);
      } else
        for (const node of r.addedNodes) {
          if (node.nodeType !== 1) continue;
          look(node);
          node.querySelectorAll('.focused, .sel, .press').forEach(look);
        }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  document.querySelectorAll('.focused, .sel').forEach(look);
}
