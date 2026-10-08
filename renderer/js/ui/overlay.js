// Overlay stack: the top overlay receives input before the active view.

import { emit } from '../state.js';

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
