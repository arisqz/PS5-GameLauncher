// Notification toasts (top-right) and the persistent scan progress card.

import { h, escapeHtml } from '../util.js';
import { icon } from '../icons.js';
import { on, state } from '../state.js';
import { sfx } from '../sound.js';
import { t } from '../i18n.js';

const box = document.getElementById('toasts');

export function toast({ title, body = '', icon: ic = 'bell', image = null, duration = 4600, sound = true }) {
  const el = h('div', {
    class: 'toast',
    html: `
      <div class="toast-icon">${image ? `<img src="${image}" alt="">` : icon(ic)}</div>
      <div class="toast-text">
        <div class="toast-title">${escapeHtml(t(title))}</div>
        ${body ? `<div class="toast-body">${escapeHtml(t(body))}</div>` : ''}
      </div>`,
  });
  box.prepend(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  if (sound) sfx.notify();
  const remove = () => {
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 450);
  };
  setTimeout(remove, duration);
  // Never stack too many.
  [...box.querySelectorAll('.toast')].slice(4).forEach((t) => t.remove());
  return el;
}

let progressEl = null;

function renderProgress(p) {
  if (!p || !p.active) {
    if (progressEl) {
      const el = progressEl;
      progressEl = null;
      el.classList.remove('in');
      el.classList.add('out');
      setTimeout(() => el.remove(), 450);
    }
    return;
  }
  if (!progressEl) {
    progressEl = h('div', {
      class: 'toast progress-toast',
      html: `
        <div class="toast-icon spin-ic">${icon('refresh')}</div>
        <div class="toast-text">
          <div class="toast-title">${t('Updating library')}</div>
          <div class="toast-body"></div>
          <div class="toast-bar"><i></i></div>
        </div>`,
    });
    box.append(progressEl);
    requestAnimationFrame(() => requestAnimationFrame(() => progressEl && progressEl.classList.add('in')));
  }
  progressEl.querySelector('.toast-body').textContent = t(p.label || '');
  const bar = progressEl.querySelector('.toast-bar');
  if (p.total) {
    bar.classList.remove('indeterminate');
    bar.querySelector('i').style.width = `${Math.round((p.current / p.total) * 100)}%`;
  } else {
    bar.classList.add('indeterminate');
  }
}

on('toast', (n) => toast(n));
on('scan', (p) => renderProgress(p));

export function initToasts() {
  if (state.scan.active) renderProgress(state.scan);
}
