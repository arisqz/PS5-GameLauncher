// Notification toasts (top-right) and the persistent scan progress card.

import { h, escapeHtml } from '../util.js';
import { icon } from '../icons.js';
import { on, state, api } from '../state.js';
import { sfx } from '../sound.js';
import { t } from '../i18n.js';

const box = document.getElementById('toasts');

export function toast({ title, body = '', icon: ic = 'bell', image = null, duration = 4600, sound = true, preview = true, kind = 'system', duringSetup = false }) {
  if (!preview) body = '';
  const el = h('div', {
    // (The first-time setup holds pop-ups back, except the ones about the setup itself.)
    class: `toast${duringSetup ? ' during-setup' : ''}`,
    html: `
      <div class="toast-icon">${image ? `<img src="${escapeHtml(image)}" alt="">` : icon(ic)}</div>
      <div class="toast-text">
        <div class="toast-title">${escapeHtml(t(title))}</div>
        ${body ? `<div class="toast-body">${escapeHtml(t(body))}</div>` : ''}
      </div>`,
  });
  box.prepend(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  if (sound) kind === 'discord' ? sfx.message() : sfx.notify();
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

const DURATIONS = { short: 3000, default: 5000, long: 8000 };

/**
 * Settings › Notifications decide whether a notification pops up:
 * pop-ups on/off, and per kind "always", "not while a game is running" or
 * "never". It still lands in the notification list either way. While a game
 * is in front, the pop-up appears over the game (in the overlay window).
 */
export function popupFor(n) {
  const s = state.settings;
  if (s.notifPopups === false) return null;
  const rule = s[`notif_${n.kind || 'system'}`] || 'always';
  const inGame = state.running.size > 0;
  if (rule === 'never' || (rule === 'notInGame' && inGame)) return null;
  return { ...n, duration: DURATIONS[s.notifDuration] || DURATIONS.default, preview: s.notifPreview !== false };
}

on('toast', (n) => {
  const p = popupFor(n);
  if (!p) return;
  const launcherInFront = state.window.focused !== false && document.visibilityState === 'visible';
  if (!launcherInFront && state.running.size > 0 && state.settings.overlay !== false && api.popupInGame) {
    api.popupInGame({ title: t(p.title), body: p.preview ? t(p.body || '') : '', icon: p.icon, image: p.image || null, duration: p.duration, kind: p.kind }).catch(() => {});
    return;
  }
  toast(p);
});
on('scan', (p) => renderProgress(p));

export function initToasts() {
  if (state.scan.active) renderProgress(state.scan);
}
