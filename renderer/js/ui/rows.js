// Settings rows (toggle, choice, range, text, action, info, drive, step),
// shared by the Settings view and the first-time setup: what a row shows and
// what pressing it does.

import { escapeHtml } from '../util.js';
import { icon } from '../icons.js';
import { state, setSetting } from '../state.js';
import { sfx } from '../sound.js';
import { optionsMenu, textDialog, sliderDialog } from './dialogs.js';
import { sliderHtml } from './slider.js';
import { t } from '../i18n.js';

/** The row's inside: its label, and its value or switch. */
export function rowHtml(d) {
  const s = state.settings;
  // dot: a coloured dot before the label (Storage's key to its bar).
  const label = `<span class="si-label">${d.dot ? `<b class="si-dot ${d.dot}"></b>` : ''}${d.icon ? icon(d.icon) : ''}<span>${escapeHtml(t(d.label))}</span></span>`;
  switch (d.type) {
    case 'toggle':
      return `${label}<span class="switch${(d.get ? d.get() : s[d.key]) ? ' on' : ''}"><i></i></span>`;
    case 'choice': {
      const cur = d.get ? d.get() : s[d.key];
      const opt = d.options.find((o) => String(o.value) === String(cur));
      return `${label}<span class="si-value">${escapeHtml(opt ? t(opt.label) : String(cur ?? ''))}</span>`;
    }
    case 'range': {
      const v = (d.get ? d.get() : s[d.key]) ?? 0;
      return `${label}<span class="si-value si-range">${sliderHtml(((v - (d.min || 0)) / ((d.max || 100) - (d.min || 0))) * 100, 'thin')}<span class="si-num">${v}${d.unit || ''}</span></span>`;
    }
    case 'text': {
      const v = (d.get ? d.get() : s[d.key]) || '';
      const shown = v ? (d.secret ? '•'.repeat(Math.min(12, v.length)) : v) : d.placeholder ? t('Not set') : '';
      return `${label}<span class="si-value${v ? '' : ' dim'}">${escapeHtml(shown)}</span>`;
    }
    case 'action':
      return `${label}${d.value !== undefined ? `<span class="si-value dim ${d.valueClass || ''}"><bdi>${escapeHtml(t(d.value))}</bdi></span>` : ''}${d.chev === false ? '' : `<span class="si-chev">${icon('chevronRight')}</span>`}`;
    case 'info':
      return `${label}<span class="si-value dim">${escapeHtml(t(d.value ?? ''))}</span>`;
    case 'drive':
    case 'block':
      return d.html();
  }
  return label;
}

/** Press a row. rerender: draw the rows again (with their new values). */
export async function activateRow(d, el, rerender) {
  if (d.disabled) return;
  const s = state.settings;
  switch (d.type) {
    case 'toggle':
      sfx.toggle(!(d.get ? d.get() : s[d.key]));
      if (d.set) await d.set(!d.get());
      else await setSetting(d.key, !s[d.key]);
      rerender();
      break;
    case 'choice': {
      sfx.select();
      // get/set: a value that isn't a setting of its own (one encoder's settings, say).
      const cur = d.get ? d.get() : s[d.key];
      const choice = await optionsMenu({
        title: t(d.label),
        anchor: el,
        side: 'below-right',
        index: Math.max(0, d.options.findIndex((o) => String(o.value) === String(cur))),
        items: d.options.map((o) => ({ label: t(o.label), hint: o.hint, value: o.value, checked: String(o.value) === String(cur) })),
      });
      if (choice && String(choice.value) !== String(cur)) {
        if (d.set) await d.set(choice.value);
        else await setSetting(d.key, choice.value);
        rerender();
      }
      break;
    }
    case 'range': {
      sfx.select();
      const get = d.get || (() => s[d.key]);
      const set = d.set || ((nv) => setSetting(d.key, nv));
      const orig = get() ?? 0;
      const v = await sliderDialog({ title: t(d.label), value: orig, min: d.min, max: d.max, step: d.step, unit: d.unit, onChange: (nv) => set(nv) });
      if (v === null) await set(orig);
      rerender();
      break;
    }
    case 'text': {
      sfx.select();
      const initial = d.get ? (d.secret ? '' : d.get() || '') : s[d.key] || '';
      const v = await textDialog({ title: t(d.label), value: initial, secret: d.secret, placeholder: d.placeholder || '' });
      if (v !== null) {
        const before = d.get ? d.get() : s[d.key];
        if (d.set) await d.set(v.trim());
        else await setSetting(d.key, v.trim());
        // Something to do once a new value is in (a key to check, say).
        if (d.after && v.trim() !== (before || '')) await d.after(v.trim());
      }
      rerender();
      break;
    }
    case 'action':
    case 'drive':
    case 'step':
      if (!d.run) {
        sfx.bump();
        break;
      }
      sfx.select();
      await d.run(el);
      rerender();
      break;
    default:
      sfx.bump();
  }
}
