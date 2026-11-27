// A pointer for a web page shown in the launcher (the setup's SteamGridDB
// <webview>), for the controller: the right stick moves it, cross clicks
// where it is, up and down (or pushing it against the top or bottom edge)
// scroll, and a text field it clicks gets the on-screen keyboard, whose text
// is then typed into the page.

import { h, clamp, replayClass, sleep } from '../util.js';
import { rightStick } from '../input.js';
import { sfx } from '../sound.js';
import { t } from '../i18n.js';

const DEAD = 0.18; // stick travel ignored around the middle
const WHEEL = 120; // one notch of a mouse wheel

export class WebPointer {
  /**
   * @param {HTMLElement} box   what the page fills (the pointer is drawn in it)
   * @param {{ getWeb: () => any, onWake: () => void }} opts
   *   getWeb: the <webview> now (it can be replaced); onWake: the stick was
   *   pushed while the pointer was away (show it, the caller's focus moves to it)
   */
  constructor(box, { getWeb, onWake }) {
    this.box = box;
    this.getWeb = getWeb;
    this.onWake = onWake;
    this.el = h('div', { class: 'wp-cursor' });
    box.append(this.el);
    this.x = null;
    this.y = null;
    this.on = false;
    this.last = 0;
    this.wheelAcc = 0;
    this.typing = false;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.el.remove();
  }

  show() {
    if (this.x === null) {
      this.x = this.box.clientWidth / 2;
      this.y = this.box.clientHeight / 2;
    }
    this.on = true;
    this.box.classList.add('pointing');
    this.place();
    this.hover();
  }

  hide() {
    this.on = false;
    this.box.classList.remove('pointing');
  }

  place() {
    this.el.style.transform = `translate(${this.x.toFixed(1)}px, ${this.y.toFixed(1)}px)`;
  }

  /** Where the pointer is, in the page view (which fills the box). */
  at() {
    return { x: Math.round(this.x), y: Math.round(this.y) };
  }

  send(ev) {
    const web = this.getWeb();
    if (!web || !web.isConnected) return false;
    try {
      web.sendInputEvent(ev);
      return true;
    } catch {
      return false;
    }
  }

  hover() {
    this.send({ type: 'mouseMove', ...this.at() });
  }

  loop(now) {
    if (this.dead || !this.box.isConnected) return;
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    const { x, y } = rightStick();
    const mag = Math.hypot(x, y);
    // Not while the on-screen keyboard (or anything else) is up over the page.
    const covered = this.typing || !!document.querySelector('#overlays > .overlay:not(.setup):not(.closing)');
    if (mag > DEAD && !covered) {
      if (!this.on) this.onWake();
      if (this.on) {
        // Slow near the middle for aiming, about the page's width a second at full tilt.
        const k = Math.pow(Math.min(1, (mag - DEAD) / (1 - DEAD)), 1.8);
        const speed = k * this.box.clientWidth * 1.05;
        const w = this.box.clientWidth;
        const hgt = this.box.clientHeight;
        this.x = clamp(this.x + (x / mag) * speed * dt, 0, w - 1);
        this.y = clamp(this.y + (y / mag) * speed * dt, 0, hgt - 1);
        this.place();
        this.hover();
        // Held against the top or bottom edge: the page scrolls that way.
        const edge = (this.y <= 1 && y < -0.4) || (this.y >= hgt - 2 && y > 0.4) ? y : 0;
        if (edge) {
          this.wheelAcc += edge * 1400 * dt;
          if (Math.abs(this.wheelAcc) >= 40) {
            this.wheel(this.wheelAcc);
            this.wheelAcc = 0;
          }
        } else this.wheelAcc = 0;
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Scroll the page under the pointer by px (down when positive). */
  wheel(px) {
    // A wheel turned towards you (down the page) is a negative delta here.
    this.send({ type: 'mouseWheel', ...this.at(), deltaX: 0, deltaY: -Math.round(px), canScroll: true });
  }

  scroll(dir) {
    this.wheel(dir * WHEEL * 2.5);
  }

  /** Cross: a click where the pointer is; a text field gets the keyboard. */
  async click() {
    const web = this.getWeb();
    if (!web) return;
    const p = this.at();
    try {
      web.focus();
    } catch {}
    this.send({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 });
    this.send({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 });
    replayClass(this.el, 'press');
    sfx.select();
    await sleep(200);
    if (!(await this.typeIfField())) this.release();
  }

  /** The launcher takes the focus back from the page (the controller and keys are its own). */
  release() {
    const web = this.getWeb();
    if (web && document.activeElement === web) web.blur();
  }

  /** The page's focused element, if it takes text: open the keyboard for it (true if it did). */
  async typeIfField() {
    const web = this.getWeb();
    if (!web || this.typing) return false;
    let field = null;
    try {
      field = await web.executeJavaScript(`(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const type = (el.type || '').toLowerCase();
        const text = el.isContentEditable || el.tagName === 'TEXTAREA' ||
          (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'].includes(type));
        if (!text || el.disabled || el.readOnly) return null;
        const r = el.getBoundingClientRect();
        const label = (el.getAttribute('aria-label') || el.placeholder || (el.labels && el.labels[0] && el.labels[0].textContent) || '').trim();
        return { password: type === 'password', value: el.isContentEditable ? el.textContent : el.value, label: label.slice(0, 60), rect: [r.left, r.top, r.width, r.height] };
      })()`);
    } catch {}
    if (!field) return false;
    // Where the field is on screen, for the keyboard to go next to it.
    let zoom = 1;
    try {
      zoom = web.getZoomFactor() || 1;
    } catch {}
    const wr = web.getBoundingClientRect();
    const [fx, fy, fw, fh] = field.rect;
    const left = wr.left + fx * zoom;
    const top = wr.top + fy * zoom;
    const anchor = { left, top, width: fw * zoom, height: fh * zoom, right: left + fw * zoom, bottom: top + fh * zoom };
    this.typing = true;
    try {
      const { textDialog } = await import('./dialogs.js');
      const v = await textDialog({ title: field.label || t('Text'), value: field.password ? '' : field.value || '', secret: field.password, anchor });
      if (v === null) return true;
      // Replace what the field holds, as typing would (the page sees the keystrokes' input events).
      await web.executeJavaScript(`(() => {
        const el = document.activeElement;
        if (!el) return;
        if (el.select) el.select();
        else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      })()`);
      web.focus();
      if (v) await web.insertText(v);
      else await web.executeJavaScript(`document.execCommand('delete')`);
    } catch {
    } finally {
      this.typing = false;
      this.release();
    }
    return true;
  }
}
