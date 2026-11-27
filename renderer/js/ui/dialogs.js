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
import { themePreview } from '../thememusic.js';

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
    const nav = new FocusList(els, {
      index: items[index] && !items[index].disabled ? index : Math.max(0, firstEnabled),
      onChange: (el) => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    });
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
/* Sort / filter panel (PS5 library and media gallery)                 */
/* ------------------------------------------------------------------ */

/**
 * The panel that opens beside the round sort button: "Sort by  Date", a line,
 * "Filters", filter rows and a "Reset Filters" button. It stays open while
 * choices are made (each row opens its own small menu) and closes with Back.
 * rows(): [{ type: 'value', label, value?: () => string, run(el, close) },
 *          { type: 'divider' }, { type: 'header', label },
 *          { type: 'button', label, disabled?: () => bool, run() }]
 */
export function filterPanel({ anchor = null, rows }) {
  return new Promise((resolve) => {
    const list = h('div', { class: 'fp-list' });
    const panel = h('div', { class: 'fp-panel' }, list);
    const root = h('div', { class: 'overlay menu-overlay fp-overlay' }, panel);
    let defs = [];
    let nav = new FocusList([]);
    let busy = false;

    function render(keep = 0) {
      defs = rows().filter(Boolean);
      const els = [];
      list.replaceChildren(
        ...defs.map((r) => {
          if (r.type === 'divider') return h('i', { class: 'fp-divider' });
          if (r.type === 'header') return h('div', { class: 'fp-header', text: t(r.label) });
          const disabled = !!(r.disabled && r.disabled());
          const el =
            r.type === 'button'
              ? h('button', { class: `fp-btn fx${disabled ? ' disabled' : ''}`, text: t(r.label) })
              : h(
                  'button',
                  { class: 'fp-row fx' },
                  h('span', { class: 'fp-label', text: t(r.label) }),
                  h('span', { class: 'fp-value', text: r.value ? t(r.value() || '') : '' })
                );
          const i = els.length;
          el._def = r;
          el.addEventListener('mouseenter', () => mouseActive() && !el.classList.contains('disabled') && nav.set(i));
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            nav.set(i);
            choose();
          });
          els.push(el);
          return el;
        })
      );
      nav = new FocusList(els, { index: Math.min(keep, els.length - 1) });
      if (nav.current && nav.current.classList.contains('disabled')) nav.move(-1) || nav.move(1);
    }

    async function choose() {
      const el = nav.current;
      if (!el || busy) return;
      if (el.classList.contains('disabled')) return sfx.bump();
      busy = true;
      sfx.select();
      try {
        await el._def.run(el, close);
      } finally {
        busy = false;
      }
      if (!ctl.closed) render(nav.index);
    }

    render();
    root.addEventListener('click', (e) => {
      if (e.target === root) close();
    });
    requestAnimationFrame(() => {
      const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
      const m = 16;
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      let x = rect ? rect.right + m * 0.6 : (window.innerWidth - pw) / 2;
      let y = rect ? rect.top - m * 0.4 : (window.innerHeight - ph) / 2;
      panel.style.left = `${clamp(x, m, window.innerWidth - pw - m)}px`;
      panel.style.top = `${clamp(y, m, window.innerHeight - ph - m)}px`;
    });

    const ctl = mountOverlay(
      root,
      (action) => {
        if (busy) return true;
        if (action === 'up' || action === 'down') nav.move(action === 'up' ? -1 : 1) ? sfx.move() : sfx.bump();
        else if (action === 'confirm' || action === 'right') choose();
        else if (action === 'back' || action === 'options' || action === 'left') {
          sfx.back();
          close();
        }
        return true;
      },
      { dimApp: true }
    );
    sfx.open();

    function close() {
      ctl.close();
      resolve();
    }
  });
}

/**
 * Tick boxes beside the filter panel (Video Clips, Screenshots). Confirm ticks
 * or unticks; onChange(items) runs after each change; Back closes.
 */
export function checkMenu({ items, anchor = null, onChange }) {
  return new Promise((resolve) => {
    const els = items.map((it, i) =>
      h(
        'button',
        {
          class: `cm-item fx${it.checked ? ' on' : ''}`,
          onmouseenter: () => mouseActive() && nav.set(i),
          onclick: (e) => {
            e.stopPropagation();
            nav.set(i);
            toggle();
          },
        },
        h('span', { class: 'cm-box', html: icon('check') }),
        h('span', { class: 'cm-label', text: t(it.label) })
      )
    );
    const panel = h('div', { class: 'cm-panel' }, ...els);
    const root = h('div', { class: 'overlay menu-overlay cm-overlay' }, panel);
    const nav = new FocusList(els);
    root.addEventListener('click', (e) => {
      if (e.target === root) close();
    });
    requestAnimationFrame(() => {
      const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
      const m = 16;
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      const x = rect ? rect.right + m * 0.6 : (window.innerWidth - pw) / 2;
      const y = rect ? rect.top - m * 0.4 : (window.innerHeight - ph) / 2;
      panel.style.left = `${clamp(x, m, window.innerWidth - pw - m)}px`;
      panel.style.top = `${clamp(y, m, window.innerHeight - ph - m)}px`;
    });
    function toggle() {
      const it = items[nav.index];
      it.checked = !it.checked;
      nav.current.classList.toggle('on', it.checked);
      sfx.toggle(it.checked);
      onChange && onChange(items);
    }
    const ctl = mountOverlay(root, (action) => {
      if (action === 'up' || action === 'down') nav.move(action === 'up' ? -1 : 1) ? sfx.move() : sfx.bump();
      else if (action === 'confirm') toggle();
      else if (action === 'back' || action === 'left' || action === 'options') {
        sfx.back();
        close();
      }
      return true;
    });
    sfx.open();
    function close() {
      ctl.close();
      resolve(items);
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

/** What the user was on when a keyboard was asked for: the focused element of the screen in front. */
function focusAnchor() {
  const layers = [...document.querySelectorAll('#overlays > .overlay:not(.closing)')];
  const scope = layers[layers.length - 1] || document.querySelector('.view.active') || document;
  const visible = [...scope.querySelectorAll('.focused')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  return visible[visible.length - 1] || null;
}

/**
 * Where a floating keyboard goes, as on the PS5: just below what it's for, or
 * just above it when there's no room below, lined up with its left edge; with
 * no room either way, beside it; kept on screen. Nothing to go by: bottom centre.
 */
function placeKeyboard(win, anchor) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rem = vw / 192;
  const w = win.offsetWidth;
  const hgt = win.offsetHeight;
  const m = 4 * rem;
  const gap = 1.6 * rem;
  const r = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : null;
  let x = (vw - w) / 2;
  let y = vh - m - hgt;
  if (r && r.width) {
    x = r.left;
    if (r.bottom + gap + hgt <= vh - m) y = r.bottom + gap;
    else if (r.top - gap - hgt >= m) y = r.top - gap - hgt;
    else {
      // Taller than the room above or below: beside it if it fits, else over its lower part.
      y = Math.max(m, Math.min(vh - m - hgt, r.top + r.height / 2 - hgt / 2));
      if (r.right + gap + w <= vw - m) x = r.right + gap;
      else if (r.left - gap - w >= m) x = r.left - gap - w;
      else y = vh - m - hgt;
    }
  }
  win.style.left = `${Math.round(clamp(x, m, vw - m - w))}px`;
  win.style.top = `${Math.round(clamp(y, m, vh - m - hgt))}px`;
}

/**
 * Text entry: the PS5's floating keyboard, a window with the text field on top,
 * placed next to what was selected (or `anchor`).
 */
export function textDialog({ title, value = '', placeholder = '', secret = false, okLabel = 'Done', capitalize = false, anchor = undefined }) {
  return new Promise((resolve) => {
    const from = anchor === undefined ? focusAnchor() : anchor;
    const input = h('input', { class: 'okb-input', type: secret ? 'password' : 'text', placeholder: t(placeholder || ''), spellcheck: 'false', autocomplete: 'off' });
    input.value = value;
    const osk = createOSK({ input, onDone: () => done(input.value), doneLabel: okLabel === 'OK' ? 'Done' : okLabel, capitalize });
    input.addEventListener('input', () => osk.typed());
    const win = h('div', { class: 'okb' }, h('label', { class: 'okb-field' }, title ? h('span', { class: 'okb-title', text: t(title) }) : null, input), osk.el);
    const root = h('div', { class: 'overlay okb-overlay' }, win);
    // A click beside the keyboard puts it away, as Back does.
    root.addEventListener('mousedown', (e) => {
      if (e.target !== root) return;
      e.preventDefault();
      cancel();
    });
    let closed = false;
    const ctl = mountOverlay(
      root,
      (action, meta) => {
        if (meta && meta.source === 'keyboard' && action === 'confirm') {
          done(input.value);
          return true;
        }
        if (action === 'back') {
          cancel();
          return true;
        }
        if (!osk.handle(action) && ['up', 'down', 'left', 'right'].includes(action)) sfx.bump();
        return true;
      },
      { closeDelay: 200 }
    );
    placeKeyboard(win, from);
    sfx.open();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    function cancel() {
      if (closed) return;
      closed = true;
      sfx.back();
      ctl.close();
      resolve(null);
    }
    function done(v) {
      if (closed) return;
      closed = true;
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
      sfx.slider(nv > v);
      v = nv;
      render();
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
/* Theme music track picker                                            */
/* ------------------------------------------------------------------ */

const duration = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');

/** Options › Theme Music › Choose from YouTube: videos for the game; the focused one plays. */
export function themeTrackDialog(game) {
  return new Promise((resolve) => {
    let term = game.name;
    let isGame = true; // the game's name (searched as "<name> theme music") until another is typed
    let gen = 0;
    const listEl = h('div', { class: 'match-list' });
    const termEl = h('div', { class: 'match-term' });
    const root = h(
      'div',
      { class: 'overlay dialog-overlay' },
      h(
        'div',
        { class: 'dialog match-dialog theme-dialog' },
        h('div', { class: 'dlg-title', text: t('Choose Theme Music') }),
        h('div', { class: 'dlg-msg', text: t('Videos found on YouTube. The selected one plays (the first time, it takes a few seconds to download).') }),
        termEl,
        listEl
      )
    );
    let nav = new FocusList([]);
    let previewTimer = null;
    const cur = game.themeMusic && game.themeMusic.mode === 'track' ? `yt:${game.themeMusic.id}` : null;

    // Play the focused video (after a moment, so scrolling through doesn't download each one).
    const focusRow = (el) => {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      clearTimeout(previewTimer);
      const r = el._row;
      previewTimer = setTimeout(() => themePreview(r.kind === 'track' ? r : null), 500);
    };

    async function search() {
      const my = ++gen;
      termEl.innerHTML = `${icon('search')}<span>${escapeHtml(isGame ? `${term} theme music` : term)}</span>`;
      listEl.innerHTML = '<div class="match-loading"><div class="spinner"></div></div>';
      let tracks = [];
      let error = '';
      try {
        tracks = await api.themeCandidates(term, isGame);
      } catch (err) {
        error = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      }
      if (my !== gen || ctl.closed) return;
      const rows = [{ kind: 'search', label: 'Search for a different name…', icon: 'search' }, ...tracks.map((x) => ({ kind: 'track', ...x }))];
      const els = rows.map((r, i) => {
        const el = h('button', {
          class: `match-row fx fx-in ${r.kind}`,
          html:
            r.kind === 'track'
              ? `<span class="mr-ic">${icon('music')}</span><span class="mr-name">${escapeHtml(r.title)}<span class="mr-sub">${escapeHtml([r.channel, duration(r.duration)].filter(Boolean).join(' · '))}</span></span>${r.key === cur ? `<span class="mr-cur">${icon('check')}</span>` : ''}`
              : `<span class="mr-ic">${icon(r.icon)}</span><span class="mr-name">${escapeHtml(t(r.label))}</span>`,
          onmouseenter: () => mouseActive() && nav.set(i),
          onclick: () => pick(i),
        });
        el._row = r;
        return el;
      });
      listEl.replaceChildren(...els);
      if (!tracks.length) listEl.append(h('div', { class: 'match-empty', text: error || t('Nothing found. Try another name.') }));
      const at = Math.max(1, rows.findIndex((r) => r.key && r.key === cur));
      nav = new FocusList(els, { index: tracks.length ? at : 0, onChange: focusRow });
      if (nav.current) focusRow(nav.current);
    }

    function close(value) {
      clearTimeout(previewTimer);
      themePreview(null);
      ctl.close();
      resolve(value);
    }

    async function pick(i) {
      const r = nav.els[i]?._row;
      if (!r) return;
      sfx.select();
      if (r.kind === 'search') {
        const v = await textDialog({ title: 'Search YouTube', value: isGame ? `${term} theme music` : term });
        if (v && v.trim() && !ctl.closed) {
          term = v.trim();
          isGame = false;
          search();
        }
        return;
      }
      close(r);
    }

    const ctl = mountOverlay(
      root,
      (action) => {
        if (action === 'up' || action === 'down') {
          nav.move(action === 'up' ? -1 : 1) ? sfx.move() : sfx.bump();
        } else if (action === 'confirm') pick(nav.index);
        else if (action === 'back') {
          sfx.back();
          close(null);
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
