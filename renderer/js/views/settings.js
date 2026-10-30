// Settings: a root list of categories, then a two-pane page per category
// (section nav on the left, items on the right).

import { h, escapeHtml, clamp, replayClass } from '../util.js';
import { icon } from '../icons.js';
import { state, on, setSetting, api, refreshInfo } from '../state.js';
import { sfx } from '../sound.js';
import { mouseActive } from '../input.js';
import { FocusList } from '../ui/overlay.js';
import { optionsMenu, textDialog, sliderDialog } from '../ui/dialogs.js';
import { renderHints } from '../ui/glyphs.js';
import { buildSchema } from './settingsSchema.js';
import { sliderHtml } from '../ui/slider.js';
import { loadVolume, loadBrightness, loadNightLight, loadHdr } from '../system.js';
import { t } from '../i18n.js';

export class SettingsView {
  constructor(router) {
    this.router = router;
    this.name = 'settings';
    this.usesHero = false;
    this.usesCanvas = true; // the animated theme background shows through
    this.mode = 'root';
    this.cat = null;
    this.section = 0;
    this.zone = 'list';
    this.schema = buildSchema(router);
    this.build();
    const rerender = () => this.active && this.mode === 'page' && this.renderList(true);
    on('settings', rerender);
    on('games', rerender);
    on('gamepad', rerender);
    on('volume', () => this.active && this.cat && this.cat.id === 'sound' && rerender());
    on('outputs', () => this.active && this.cat && this.cat.id === 'sound' && rerender());
    on('soundpacks', () => this.active && this.cat && this.cat.id === 'sound' && rerender());
    on('passthrough', () => this.active && this.cat && this.cat.id === 'system' && rerender());
    on('capture-state', () => this.active && this.cat && this.cat.id === 'captures' && rerender());
    on('capture-encoders', () => this.active && this.cat && this.cat.id === 'captures' && rerender());
    on('brightness', () => this.active && this.cat && this.cat.id === 'screen' && rerender());
    on('nightlight', () => this.active && this.cat && this.cat.id === 'screen' && rerender());
    on('hdr', () => this.active && this.cat && this.cat.id === 'screen' && rerender());
    on('bluetooth', () => this.active && this.cat && this.cat.id === 'bluetooth' && rerender());
    on('dualsense', () => this.active && this.cat && this.cat.id === 'accessories' && rerender());
    on('storage', () => this.active && this.cat && this.cat.id === 'storage' && rerender());
    on('emulators', () => this.active && this.cat && this.cat.id === 'library' && rerender());
    on('btscan', () => this.active && this.cat && this.cat.id === 'bluetooth' && rerender());
    on('discord', () => this.active && this.cat && this.cat.id === 'users' && rerender());
    on('steamfriends', () => this.active && this.cat && this.cat.id === 'users' && rerender());
    on('update', () => this.active && this.cat && this.cat.id === 'system' && rerender());
    on('ytdlp', () => this.active && this.cat && this.cat.id === 'sound' && rerender());
  }

  build() {
    this.rootList = h('div', { class: 'set-root-list' });
    this.rootEls = this.schema.map((c, i) =>
      h('button', {
        class: 'set-root-item fx fx-in',
        html: `<span class="sri-icon">${icon(c.icon)}</span><span class="sri-label">${escapeHtml(t(c.label))}</span>`,
        onmouseenter: () => mouseActive() && this.rootNav.set(i),
        onclick: () => {
          this.rootNav.set(i);
          this.openCategory(i);
        },
      })
    );
    this.rootList.append(...this.rootEls);
    this.rootNav = new FocusList(this.rootEls, { onChange: () => this.scrollRoot() });
    this.rootWrap = h('div', { class: 'set-root-wrap' }, this.rootList);
    this.rootWrap.addEventListener(
      'wheel',
      (e) => {
        const now = performance.now();
        if (now - (this.lastRootWheel || 0) < 70) return;
        this.lastRootWheel = now;
        if (this.rootNav.move(e.deltaY > 0 ? 1 : -1)) sfx.move();
      },
      { passive: true }
    );
    this.rootThumb = h('i');
    this.rootBar = h('div', { class: 'set-scrollbar' }, this.rootThumb);
    this.root = h('div', { class: 'set-root' }, h('div', { class: 'set-root-title', text: t('Settings') }), this.rootWrap, this.rootBar);

    this.titleEl = h('div', { class: 'set-title' });
    this.nav = h('nav', { class: 'set-nav' });
    this.list = h('div', { class: 'set-list' });
    this.listWrap = h('div', { class: 'set-list-wrap' }, this.list);
    this.listWrap.addEventListener(
      'wheel',
      (e) => {
        const now = performance.now();
        if (now - (this.lastWheel || 0) < 70) return;
        this.lastWheel = now;
        this.setZone('list');
        this.listNav.move(e.deltaY > 0 ? 1 : -1) && sfx.move();
      },
      { passive: true }
    );
    this.page = h('div', { class: 'set-page' }, this.titleEl, this.nav, this.listWrap);

    this.hints = h('div', { class: 'set-hints' });
    renderHints(this.hints, [
      ['confirm', 'Select'],
      ['back', 'Back'],
    ]);
    this.el = h('section', { class: 'view settings-view' }, h('div', { class: 'set-bg' }), this.root, this.page, this.hints);
  }

  /* ---------------------------------------------------------------- */

  scrollRoot(instant = false) {
    const el = this.rootNav.current;
    const wrapH = this.rootWrap.clientHeight;
    const listH = this.rootList.scrollHeight;
    let y = 0;
    if (el && listH > wrapH) {
      const prev = -(parseFloat((this.rootList.style.transform.match(/-?[\d.]+/) || [0])[0]) || 0);
      y = prev;
      const pad = el.offsetHeight * 0.6;
      if (el.offsetTop + el.offsetHeight + pad > prev + wrapH) y = el.offsetTop + el.offsetHeight + pad - wrapH;
      if (el.offsetTop - pad < prev) y = el.offsetTop - pad;
      y = clamp(y, 0, listH - wrapH);
    }
    if (instant) this.rootList.style.transition = 'none';
    this.rootList.style.transform = `translateY(${-y}px)`;
    this.rootWrap.classList.toggle('fade-top', y > 4);
    if (instant) {
      void this.rootList.offsetWidth;
      this.rootList.style.transition = '';
    }
    // Scroll indicator
    const show = listH > wrapH + 1;
    this.rootBar.style.opacity = show ? '1' : '0';
    if (show) {
      const ratio = wrapH / listH;
      this.rootThumb.style.height = `${ratio * 100}%`;
      this.rootThumb.style.transform = `translateY(${(y / wrapH) * 100}%)`;
    }
  }

  openCategory(i, { sound = true, section = 0 } = {}) {
    if (this.mode === 'page') this.leaveSection();
    this.cat = this.schema[i];
    this.mode = 'page';
    if (typeof section === 'string') section = Math.max(0, this.cat.sections.findIndex((s) => s.label === section));
    this.section = Math.min(section, this.cat.sections.length - 1);
    this.zone = 'list';
    if (sound) sfx.select();
    // The root's "return" animation must not keep it visible behind the page.
    this.root.classList.remove('enter');
    this.zoomAbout(this.rootNav.current);
    this.ringLater('page-entering');
    this.el.classList.add('in-page');
    this.page.classList.remove('enter');
    void this.page.offsetWidth;
    this.page.classList.add('enter');
    this.titleEl.textContent = t(this.cat.label);
    if (this.cat.id === 'storage') {
      state.cacheSize = null;
      api.cacheSize().then((n) => {
        state.cacheSize = n;
        this.active && this.mode === 'page' && this.renderList(true);
      });
    }
    if (this.cat.id === 'library' || this.cat.id === 'users') refreshInfo().then(() => this.active && this.renderList(true));
    if (this.cat.id === 'sound') loadVolume();
    if (this.cat.id === 'screen') {
      loadBrightness();
      loadNightLight();
      loadHdr();
    }
    if (this.cat.onEnter) this.cat.onEnter();
    this.renderNav();
    this.enterSection();
    this.renderList();
  }

  enterSection() {
    const sec = this.cat && this.cat.sections[this.section];
    if (sec && sec.onEnter) sec.onEnter();
  }

  leaveSection() {
    const sec = this.cat && this.cat.sections[this.section];
    if (sec && sec.onLeave) sec.onLeave();
  }

  // Both pages shrink towards / grow from the chosen row, as on the PS5.
  zoomAbout(row) {
    const v = this.el.getBoundingClientRect();
    const r = row && row.getBoundingClientRect();
    const x = r && r.width ? r.left + r.width / 2 - v.left : v.width / 2;
    const y = r && r.width ? r.top + r.height / 2 - v.top : v.height / 2;
    for (const el of [this.rootWrap, this.rootBar, this.nav, this.listWrap]) el.style.transformOrigin = `${x - el.offsetLeft}px ${y - el.offsetTop}px`;
  }

  // The focus ring of the page coming in lights up once it has nearly settled.
  ringLater(cls) {
    clearTimeout(this.ringTimer);
    this.el.classList.remove('page-entering', 'root-entering');
    this.el.classList.add(cls);
    this.ringTimer = setTimeout(() => this.el.classList.remove(cls), 300);
  }

  closeCategory() {
    this.leaveSection();
    this.mode = 'root';
    this.zoomAbout(this.rootNav.current);
    this.ringLater('root-entering');
    this.el.classList.remove('in-page');
    replayClass(this.root, 'enter', 600);
    requestAnimationFrame(() => this.scrollRoot(true));
  }

  renderNav() {
    this.nav.innerHTML = '';
    this.navEls = this.cat.sections.map((s, i) =>
      h('button', {
        class: 'set-nav-item fx fx-in',
        text: t(s.label),
        onmouseenter: () => {
          if (mouseActive()) {
            this.setZone('nav', true);
            this.navList.set(i);
          }
        },
        onclick: () => {
          this.setZone('nav', true);
          this.navList.set(i);
        },
      })
    );
    this.nav.append(...this.navEls);
    this.navList = new FocusList(this.navEls, {
      index: this.section,
      onChange: (el, i, silent) => {
        if (silent) return;
        this.leaveSection();
        this.section = i;
        this.enterSection();
        this.renderList();
      },
    });
    this.applyZone();
  }

  items() {
    return this.cat.sections[this.section].items().filter(Boolean);
  }

  renderList(keep = false) {
    const prev = keep && this.listNav ? this.listNav.index : 0;
    const defs = this.items();
    // Skip identical re-renders so the focused row keeps its animations.
    const sig = `${this.cat.id}|${this.section}|` + defs.map((d) => `${d.type}|${d.label}|${d.busy || ''}|${d.disabled || ''}|${d.valueClass || ''}|${this.itemHtml(d)}`).join('\n');
    if (keep && sig === this.listSig) return;
    this.listSig = sig;
    // The same rows with new values (a percentage, a polling rate…): only those rows change.
    const shape = `${this.cat.id}|${this.section}|` + defs.map((d) => `${d.type}|${d.label}|${d.n || ''}`).join('\n');
    if (keep && shape === this.listShape && this.patchList(defs)) return;
    this.listShape = shape;
    this.defs = defs;
    this.list.innerHTML = '';
    const focusables = [];
    this.navEls.forEach((el, i) => el.classList.toggle('active', i === this.section));

    for (const d of defs) {
      let el;
      if (d.type === 'header') {
        el = h('div', { class: 'set-header', html: `${escapeHtml(t(d.label))}${d.busy ? '<span class="spinner sm"></span>' : ''}` });
      } else if (d.type === 'note') {
        el = h('div', { class: 'set-note', text: t(d.label) });
      } else {
        el =
          d.type === 'step'
            ? h('button', { class: 'set-step fx fx-in' }, h('span', { class: 'ss-num', text: String(d.n) }), h('span', { class: 'ss-text', text: t(d.label) }))
            : h('button', { class: `set-item fx fx-in t-${d.type}${d.danger ? ' danger' : ''}${d.disabled ? ' disabled' : ''}` });
        if (d.type !== 'step') el.innerHTML = el._html = this.itemHtml(d);
        const idx = focusables.length;
        // el._def, not d: patchList() swaps in newer definitions.
        el.addEventListener('mouseenter', () => {
          if (mouseActive() && !el._def.disabled) {
            this.setZone('list', true);
            this.listNav.set(idx);
          }
        });
        el.addEventListener('click', () => {
          if (el._def.disabled) return;
          this.setZone('list', true);
          this.listNav.set(idx);
          this.activate(el._def, el);
        });
        el._def = d;
        focusables.push(el);
      }
      this.list.append(el);
    }
    if (!keep) {
      this.list.classList.remove('enter');
      void this.list.offsetWidth;
      this.list.classList.add('enter');
    }
    let start = clamp(prev, 0, Math.max(0, focusables.length - 1));
    while (focusables[start] && focusables[start].classList.contains('disabled') && start < focusables.length - 1) start++;
    this.listNav = new FocusList(focusables, { index: start, onChange: () => this.scrollList() });
    this.applyZone();
    this.scrollList(!keep);
  }

  /**
   * Update the rows in place (their values, busy and disabled states), keeping
   * the list, focus and scroll as they are. False when it can't (then the list
   * is built again).
   */
  patchList(defs) {
    const rows = [...this.list.children];
    if (rows.length !== defs.length) return false;
    defs.forEach((d, i) => {
      const el = rows[i];
      if (d.type === 'header') {
        const html = `${escapeHtml(t(d.label))}${d.busy ? '<span class="spinner sm"></span>' : ''}`;
        if (el.innerHTML !== html) el.innerHTML = html;
      } else if (d.type === 'note') {
        if (el.textContent !== t(d.label)) el.textContent = t(d.label);
      } else {
        if (d.type !== 'step') {
          const html = this.itemHtml(d);
          if (el._html !== html) el.innerHTML = html;
          el._html = html;
        }
        el.classList.toggle('danger', !!d.danger);
        el.classList.toggle('disabled', !!d.disabled);
        el._def = d;
      }
    });
    this.defs = defs;
    return true;
  }

  itemHtml(d) {
    const s = state.settings;
    const label = `<span class="si-label">${d.icon ? icon(d.icon) : ''}<span>${escapeHtml(t(d.label))}</span></span>`;
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
        return `${label}${d.value !== undefined ? `<span class="si-value dim ${d.valueClass || ''}"><bdi>${escapeHtml(t(d.value))}</bdi></span>` : ''}<span class="si-chev">${icon('chevronRight')}</span>`;
      case 'info':
        return `${label}<span class="si-value dim">${escapeHtml(t(d.value ?? ''))}</span>`;
      case 'drive':
        return d.html();
    }
    return label;
  }

  scrollList(instant = false) {
    const el = this.listNav.current;
    const wrapH = this.listWrap.clientHeight;
    const listH = this.list.scrollHeight;
    let y = 0;
    if (el && listH > wrapH) {
      const top = el.offsetTop;
      const center = top + el.offsetHeight / 2;
      // Reading pages (the User Guide) only scroll as far as needed, so the
      // text above the buttons stays in view.
      y = this.cat && this.cat.readable ? clamp(top + el.offsetHeight + 40 - wrapH, 0, listH - wrapH + 40) : clamp(center - wrapH * 0.42, 0, listH - wrapH + 40);
    }
    if (instant) this.list.style.transition = 'none';
    this.list.style.transform = `translateY(${-y}px)`;
    this.listWrap.classList.toggle('fade-top', y > 4);
    if (instant) {
      void this.list.offsetWidth;
      this.list.style.transition = '';
    }
  }

  setZone(zone, silent = false) {
    if (zone === this.zone) return;
    if (zone === 'list' && !this.listNav.els.length) return;
    this.zone = zone;
    if (!silent) sfx.move();
    this.applyZone();
  }

  applyZone() {
    if (!this.navList || !this.listNav) return;
    this.navList.blur();
    this.listNav.blur();
    if (this.zone === 'nav') this.navList.refocus();
    else this.listNav.refocus();
    this.el.classList.toggle('nav-focus', this.zone === 'nav');
  }

  async activate(d, el) {
    if (d.disabled) return;
    const s = state.settings;
    switch (d.type) {
      case 'toggle':
        sfx.toggle(!(d.get ? d.get() : s[d.key]));
        if (d.set) await d.set(!d.get());
        else await setSetting(d.key, !s[d.key]);
        this.renderList(true);
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
          this.renderList(true);
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
        this.renderList(true);
        break;
      }
      case 'text': {
        sfx.select();
        const initial = d.get ? (d.secret ? '' : d.get() || '') : s[d.key] || '';
        const v = await textDialog({ title: t(d.label), value: initial, secret: d.secret, placeholder: d.placeholder || '' });
        if (v !== null) {
          if (d.set) await d.set(v.trim());
          else await setSetting(d.key, v.trim());
        }
        this.renderList(true);
        break;
      }
      case 'action':
      case 'drive':
        sfx.select();
        await d.run(el);
        this.active && this.renderList(true);
        break;
      default:
        sfx.bump();
    }
  }

  /* ---------------------------------------------------------------- */

  handle(action) {
    if (this.mode === 'root') {
      switch (action) {
        case 'up':
        case 'down':
          this.rootNav.move(action === 'up' ? -1 : 1) ? sfx.move() : sfx.bump();
          return true;
        case 'confirm':
        case 'right':
          this.openCategory(this.rootNav.index);
          return true;
        case 'back':
          return false;
      }
      return true;
    }

    if (action === 'back') {
      sfx.back();
      if (this.zone === 'list' && this.navEls.length > 1) {
        this.setZone('nav', true);
      } else {
        this.closeCategory();
      }
      return true;
    }
    if (this.zone === 'nav') {
      switch (action) {
        case 'up':
        case 'down':
          this.navList.move(action === 'up' ? -1 : 1) ? sfx.move() : sfx.bump();
          return true;
        case 'right':
        case 'confirm':
          this.setZone('list');
          return true;
        case 'left':
          sfx.back();
          this.closeCategory();
          return true;
      }
      return true;
    }
    switch (action) {
      case 'up':
      case 'down':
        this.listNav.move(action === 'up' ? -1 : 1) ? sfx.move() : sfx.bump();
        return true;
      case 'left':
        if (this.navEls.length > 1) this.setZone('nav');
        else {
          sfx.back();
          this.closeCategory();
        }
        return true;
      case 'confirm': {
        const el = this.listNav.current;
        if (el) this.activate(el._def, el);
        return true;
      }
      case 'right':
        sfx.bump();
        return true;
    }
    return true;
  }

  show(params = {}, dir) {
    this.active = true;
    if (dir === 'forward' && !params.category) this.mode = 'root';
    if (params.category) {
      const i = this.schema.findIndex((c) => c.id === params.category);
      if (i >= 0) {
        this.rootNav.set(i, { silent: true });
        this.openCategory(i, { sound: false, section: params.section || 0 });
        return;
      }
    }
    if (this.mode === 'page' && this.cat) {
      this.enterSection();
      this.renderList(true);
    } else {
      this.mode = 'root';
      this.root.classList.remove('enter');
      this.el.classList.remove('in-page');
      requestAnimationFrame(() => this.scrollRoot(true));
    }
  }

  hide() {
    this.active = false;
    if (this.mode === 'page') this.leaveSection();
  }
}
