import { t, language } from './i18n.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Hyperscript-style element builder.
 * h('div', { class: 'a', onclick: fn, html: '<b>x</b>' }, child, 'text')
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function fmtPlaytime(min) {
  min = Math.round(min || 0);
  if (min <= 0) return '0h';
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  const rest = min % 60;
  return hrs < 10 && rest ? `${hrs}h ${rest}m` : `${hrs}h`;
}

export function timeAgo(ts) {
  if (!ts) return t('Never');
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return t('Just now');
  const rtf = new Intl.RelativeTimeFormat(language(), { numeric: 'auto' });
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  if (m < 60) return cap(rtf.format(-m, 'minute'));
  const hr = Math.round(m / 60);
  if (hr < 24) return cap(rtf.format(-hr, 'hour'));
  const days = Math.round(hr / 24);
  if (days < 7) return cap(rtf.format(-days, 'day'));
  if (days < 30) return cap(rtf.format(-Math.round(days / 7), 'week'));
  return fmtDate(ts);
}

export function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(language(), { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtBytes(n) {
  if (!n) return '0 MB';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 1 ? 1 : 0)} ${u[i]}`;
}

export function hashHue(s) {
  let x = 0;
  for (const ch of String(s)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return x % 360;
}

/** Restart a CSS animation class on an element. */
export function replayClass(el, cls, ms = 0) {
  if (!el) return;
  clearTimeout(el['_rc_' + cls]);
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  if (ms) {
    el['_rc_' + cls] = setTimeout(() => el.classList.remove(cls), ms);
    return;
  }
  const done = (e) => {
    if (e && (e.target !== el || e.pseudoElement)) return;
    el.removeEventListener('animationend', done);
    el.classList.remove(cls);
  };
  el.addEventListener('animationend', done);
  el['_rc_' + cls] = setTimeout(done, 2000);
}

export function bump(el, dir) {
  replayClass(el, `bump-${dir}`);
}

export function remToPx(rem) {
  return rem * parseFloat(getComputedStyle(document.documentElement).fontSize);
}
