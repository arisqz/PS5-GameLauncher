// Modal UI: options menus, confirmations, text entry, sliders, Steam match
// picker and the screenshot viewer.

import { h, escapeHtml, clamp } from '../util.js';
import { icon } from '../icons.js';
import { sfx } from '../sound.js';
import { api } from '../state.js';
import { mountOverlay, FocusList } from './overlay.js';
import { renderHints } from './glyphs.js';
import { createOSK } from './osk.js';
import { mouseActive } from '../input.js';
import { sliderHtml, setSlider, dragSlider } from './slider.js';
import { t } from '../i18n.js';

/* ------------------------------------------------------------------ */
/* Options menu                                                        */
/* ------------------------------------------------------------------ */

/**
 * items: [{ label, icon?, value?, run?, danger?, disabled?, checked?, hint? }]
 * anchor: DOMRect | Element | null  (null = centred)
 * Resolves with the chosen item (after running item.run) or null.
 */
export function optionsMenu({ title = '', items, anchor = null, index = 0, side = 'right' }) {
  return new Promise((resolve) => {
    const list = h('div', { class: 'menu-list' });
    const panel = h('div', { class: 'menu-panel' }, title ? h('div', { class: 'menu-title', text: t(title) }) : null, list);
    const root = h('div', { class: 'overlay menu-overlay' }, panel);

    const els = items.map((it, i) =>
      h(
        'button',
        {
          class: `menu-item fx fx-in${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`,
          onmouseenter: () => {
            if (mouseActive() && !it.disabled) nav.set(i);
          },
          onclick: (e) => {
            e.stopPropagation();
            if (!it.disabled) choose(i);
          },
          html: `
            <span class="mi-icon">${it.icon ? icon(it.icon) : ''}</span>
            <span class="mi-label">${escapeHtml(t(it.label))}</span>
            ${it.hint ? `<span class="mi-hint">${escapeHtml(t(it.hint))}</span>` : ''}
            ${it.checked ? `<span class="mi-check">${icon('check')}</span>` : ''}
            ${it.submenu ? `<span class="mi-check">${icon('chevronRight')}</span>` : ''}`,
        }
      )
    );
    list.append(...els);
    const firstEnabled = items.findIndex((it) => !it.disabled);
    const nav = new FocusList(els, { index: items[index] && !items[index].disabled ? index : Math.max(0, firstEnabled) });
    root.addEventListener('click', (e) => {
      if (e.target === root) close(null);
    });

    // Position next to the anchor.
    requestAnimationFrame(() => {
      const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const m = 16;
      let x;
      let y;
      if (!rect) {
        x = (vw - pw) / 2;
        y = (vh - ph) / 2;
      } else if (side === 'above') {
        x = rect.left + rect.width / 2 - pw / 2;
        y = rect.top - ph - m;
      } else if (side === 'below-right') {
        x = rect.right - pw;
        y = rect.bottom + m * 0.6;
        if (y + ph > vh - m) y = rect.top - ph - m * 0.6;
      } else {
        x = rect.right + m * 1.5;
        if (x + pw > vw - m) x = rect.left - pw - m * 1.5;
        y = rect.top;
      }
      panel.style.left = `${clamp(x, m, vw - pw - m)}px`;
      panel.style.top = `${clamp(y, m, vh - ph - m)}px`;
    });

    const ctl = mountOverlay(root, (action) => {
      if (action === 'up' || action === 'down') {
        if (nav.move(action === 'up' ? -1 : 1)) sfx.move();
        else sfx.bump();
        return true;
      }
      if (action === 'confirm') {
        choose(nav.index);
        return true;
      }
      if (action === 'back' || action === 'options') {
        sfx.back();
        close(null);
        return true;
      }
      return true;
    });
    sfx.open();

    function close(v) {
      ctl.close();
      resolve(v);
    }
    async function choose(i) {
      const it = items[i];
      if (!it || it.disabled) return;
      sfx.select();
      ctl.close();
      try {
        if (it.run) await it.run();
      } finally {
        resolve(it);
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* Confirm                                                             */
/* ------------------------------------------------------------------ */

export function confirmDialog({ title, message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const btns = [h('button', { class: `dlg-btn fx${danger ? ' danger' : ''}`, text: t(confirmLabel) }), h('button', { class: 'dlg-btn fx', text: t(cancelLabel) })];
    const root = h(
      'div',
      { class: 'overlay dialog-overlay' },
      h('div', { class: 'dialog' }, h('div', { class: 'dlg-title', text: t(title) }), message ? h('div', { class: 'dlg-msg', html: escapeHtml(t(message)).replace(/\n/g, '<br>') }) : null, h('div', { class: 'dlg-btns' }, ...btns))
    );
    const nav = new FocusList(btns, { index: danger ? 1 : 0 });
    btns.forEach((b, i) => {
      b.addEventListener('mouseenter', () => mouseActive() && nav.set(i));
      b.addEventListener('click', () => done(i === 0));
    });
    const ctl = mountOverlay(
      root,
      (action) => {
        if (action === 'left' || action === 'right') {
          if (nav.move(action === 'left' ? -1 : 1)) sfx.move();
          return true;
        }
        if (action === 'confirm') {
          done(nav.index === 0);
          return true;
        }
        if (action === 'back') {
          done(false);
          return true;
        }
        return true;
      },
      { dimApp: true }
    );
    sfx.open();
    function done(v) {
      v ? sfx.select() : sfx.back();
      ctl.close();
      resolve(v);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Text entry                                                          */
/* ------------------------------------------------------------------ */

export function textDialog({ title, value = '', placeholder = '', secret = false, okLabel = 'OK' }) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'dlg-input', type: secret ? 'password' : 'text', placeholder: t(placeholder), spellcheck: 'false' });
    input.value = value;
    const osk = createOSK({
      onChar: (c) => insert(c),
      onBackspace: () => {
        const s = input.selectionStart ?? input.value.length;
        const e = input.selectionEnd ?? s;
        if (s !== e) input.setRangeText('', s, e, 'end');
        else if (s > 0) input.setRangeText('', s - 1, s, 'end');
      },
      onDone: () => done(input.value),
    });
    function insert(c) {
      const s = input.selectionStart ?? input.value.length;
      const e = input.selectionEnd ?? s;
      input.setRangeText(c, s, e, 'end');
    }
    const root = h(
      'div',
      { class: 'overlay dialog-overlay text-overlay' },
      h('div', { class: 'dialog text-dialog' }, h('div', { class: 'dlg-title', text: t(title) }), input, osk.el)
    );
    const ctl = mountOverlay(
      root,
      (action, meta) => {
        if (meta && meta.source === 'keyboard' && action === 'confirm') {
          done(input.value);
          return true;
        }
        if (action === 'back') {
          sfx.back();
          ctl.close();
          resolve(null);
          return true;
        }
        osk.handle(action);
        return true;
      },
      { dimApp: true }
    );
    sfx.open();
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 60);
    function done(v) {
      sfx.select();
      ctl.close();
      resolve(v);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Slider                                                              */
/* ------------------------------------------------------------------ */

export function sliderDialog({ title, value, min = 0, max = 100, step = 5, unit = '%', onChange }) {
  return new Promise((resolve) => {
    let v = value;
    const num = h('div', { class: 'slider-val' });
    const track = h('div', { class: 'slider-wrap', html: sliderHtml(0) });
    const hints = h('div', { class: 'dlg-hints' });
    renderHints(hints, [['adjust', 'Adjust'], ['confirm', 'OK'], ['back', 'Cancel']]);
    const root = h('div', { class: 'overlay dialog-overlay' }, h('div', { class: 'dialog slider-dialog' }, h('div', { class: 'dlg-title', text: t(title) }), num, track, hints));
    const render = () => {
      setSlider(track, ((v - min) / (max - min)) * 100);
      num.textContent = `${v}${unit}`;
    };
    render();
    const set = (nv, quiet) => {
      nv = clamp(Math.round(nv / step) * step, min, max);
      if (nv === v) return quiet ? null : sfx.bump();
      v = nv;
      render();
      sfx.tick();
      onChange && onChange(v);
    };
    dragSlider(track.firstElementChild, (p) => set(min + (p / 100) * (max - min), true));
    const ctl = mountOverlay(
      root,
      (action) => {
        if (action === 'left' || action === 'down') set(v - step);
        else if (action === 'right' || action === 'up') set(v + step);
        else if (action === 'confirm') {
          sfx.select();
          ctl.close();
          resolve(v);
        } else if (action === 'back') {
          sfx.back();
          ctl.close();
          resolve(null);
        }
        return true;
      },
      { dimApp: true }
    );
    sfx.open();
  });
}

/* ------------------------------------------------------------------ */
/* Steam match picker                                                  */
/* ------------------------------------------------------------------ */

export function matchDialog(game) {
  return new Promise((resolve) => {
    let term = game.name;
    const listEl = h('div', { class: 'match-list' });
    const termEl = h('div', { class: 'match-term' });
    const root = h(
      'div',
      { class: 'overlay dialog-overlay' },
      h(
        'div',
        { class: 'dialog match-dialog' },
        h('div', { class: 'dlg-title', text: t('Find on Steam') }),
        h('div', { class: 'dlg-msg', text: t('Pick the store entry that matches this game. Its artwork and details will be used.') }),
        termEl,
        listEl
      )
    );
    let nav = new FocusList([]);
    let results = [];

    async function search() {
      termEl.innerHTML = `${icon('search')}<span>${escapeHtml(term)}</span>`;
      listEl.innerHTML = '<div class="match-loading"><div class="spinner"></div></div>';
      results = await api.searchSteam(term);
      const rows = [
        { kind: 'search', label: 'Search for a different name…', icon: 'search' },
        ...results.map((r) => ({ kind: 'result', ...r })),
        { kind: 'none', label: 'No match — use generated artwork', icon: 'close' },
      ];
      listEl.innerHTML = '';
      const els = rows.map((r, i) => {
        const el = h('button', {
          class: `match-row fx fx-in ${r.kind}`,
          html:
            r.kind === 'result'
              ? `<img src="${r.image || ''}" alt=""><span class="mr-name">${escapeHtml(r.name)}</span><span class="mr-id">${r.appid}</span>${String(r.appid) === String(game.steamAppId) ? `<span class="mr-cur">${icon('check')}</span>` : ''}`
              : `<span class="mr-ic">${icon(r.icon)}</span><span class="mr-name">${escapeHtml(t(r.label))}</span>`,
          onmouseenter: () => mouseActive() && nav.set(i),
          onclick: () => pick(i),
        });
        el._row = r;
        return el;
      });
      listEl.append(...els);
      if (!results.length) listEl.insertBefore(h('div', { class: 'match-empty', text: t('No results on Steam.') }), els[els.length - 1]);
      nav = new FocusList(els, { index: results.length ? 1 : 0, onChange: (el) => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) });
    }

    async function pick(i) {
      const r = nav.els[i]?._row;
      if (!r) return;
      sfx.select();
      if (r.kind === 'search') {
        const t = await textDialog({ title: 'Search Steam', value: term });
        if (t && t.trim()) {
          term = t.trim();
          search();
        }
        return;
      }
      ctl.close();
      resolve(r.kind === 'result' ? r.appid : 'none');
    }

    const ctl = mountOverlay(
      root,
      (action) => {
        if (action === 'up' || action === 'down') {
          nav.move(action === 'up' ? -1 : 1) ? sfx.move() : sfx.bump();
        } else if (action === 'confirm') pick(nav.index);
        else if (action === 'back') {
          sfx.back();
          ctl.close();
          resolve(null);
        }
        return true;
      },
      { dimApp: true }
    );
    sfx.open();
    search();
  });
}

/* ------------------------------------------------------------------ */
/* Screenshot viewer                                                   */
/* ------------------------------------------------------------------ */

export function screenshotViewer(shots, index = 0) {
  let i = index;
  const img = h('img', { class: 'viewer-img', alt: '' });
  const counter = h('div', { class: 'viewer-count' });
  const hints = h('div', { class: 'viewer-hints' });
  renderHints(hints, [['back', 'Close']]);
  const root = h('div', { class: 'overlay viewer-overlay' }, img, counter, hints, h('button', { class: 'viewer-nav prev', html: icon('chevronLeft'), onclick: () => go(-1) }), h('button', { class: 'viewer-nav next', html: icon('chevronRight'), onclick: () => go(1) }));
  const show = () => {
    img.classList.remove('in');
    img.src = shots[i].full;
    img.onload = () => img.classList.add('in');
    counter.textContent = `${i + 1} / ${shots.length}`;
  };
  const go = (d) => {
    const n = i + d;
    if (n < 0 || n >= shots.length) return sfx.bump();
    i = n;
    sfx.move();
    show();
  };
  show();
  const ctl = mountOverlay(root, (action) => {
    if (action === 'left') go(-1);
    else if (action === 'right') go(1);
    else if (action === 'back' || action === 'confirm') {
      sfx.back();
      ctl.close();
    }
    return true;
  });
  root.addEventListener('click', (e) => {
    if (e.target === root || e.target === img) ctl.close();
  });
  sfx.open();
}

/* ------------------------------------------------------------------ */
/* Info                                                                */
/* ------------------------------------------------------------------ */

export function infoDialog({ title, html }) {
  return new Promise((resolve) => {
    const body = h('div', { class: 'info-body', html });
    const hints = h('div', { class: 'dlg-hints' });
    renderHints(hints, [['back', 'Close']]);
    const root = h('div', { class: 'overlay dialog-overlay' }, h('div', { class: 'dialog info-dialog' }, h('div', { class: 'dlg-title', text: t(title) }), body, hints));
    const ctl = mountOverlay(
      root,
      (action) => {
        if (action === 'up' || action === 'down') {
          body.scrollBy({ top: action === 'up' ? -120 : 120, behavior: 'smooth' });
        } else if (action === 'back' || action === 'confirm') {
          sfx.back();
          ctl.close();
          resolve();
        }
        return true;
      },
      { dimApp: true }
    );
    root.addEventListener('click', (e) => {
      if (e.target === root) {
        ctl.close();
        resolve();
      }
    });
    sfx.open();
  });
}
