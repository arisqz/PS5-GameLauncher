// Start-up, PS5 style: the spotlight stage fades in from black, "Welcome Back"
// and the user row build in over drifting particles. Choosing a user clears
// the scene and the home screen assembles itself (HomeView.playBootIntro).

import { h, sleep } from '../util.js';
import { api, on, emit } from '../state.js';
import { sfx, unlockAudio } from '../sound.js';
import { avatarHtml, AVATARS } from '../ui/avatar.js';
import { glyph } from '../ui/glyphs.js';
import { icon } from '../icons.js';
import { mouseActive } from '../input.js';
import { BootStage } from '../ui/bootstage.js';
import { optionsMenu, confirmDialog, textDialog } from '../ui/dialogs.js';
import { profiles, activeProfileId, useProfile, addProfile, updateProfile, removeProfile, pickProfileImage } from '../profiles.js';
import { t } from '../i18n.js';

const STEP = 35.2; // rem between avatar centres

/**
 * @param {{ welcome: boolean, setHandler: Function, intro: (stage: BootStage) => Promise<void> }} o
 *   intro plays the home screen's build-in; it resolves once the home screen
 *   can take input.
 */
export async function runBoot({ welcome, setHandler, intro }) {
  const stage = new BootStage().mount();
  sfx.boot();
  setHandler(() => {});
  if (!welcome) {
    stage.dimParticles();
    await sleep(700);
    await intro(stage);
    return;
  }
  await new Welcome(stage, setHandler).run();
  await intro(stage);
}

class Welcome {
  constructor(stage, setHandler) {
    this.stage = stage;
    this.setHandler = setHandler;
    this.zone = 'row'; // 'row' | 'power'
    this.busy = false;
  }

  run() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.el = h(
        'div',
        { class: 'welcome' },
        h('div', { class: 'ws-clock', dataset: { clock: '' } }),
        h('div', { class: 'ws-title', text: t('Welcome Back to PS5 Game Launcher') }),
        h('div', { class: 'ws-sub', text: "Who's using this controller?" }),
        (this.rowEl = h('div', { class: 'ws-row' })),
        (this.powerBtn = h('button', { class: 'ws-power fx', html: icon('power'), title: t('Power'), onclick: () => this.focusPower(true) && this.powerMenu() })),
        h('div', { class: 'ws-select', html: `<span data-glyph="confirm">${glyph('confirm')}</span><span>${t('Select')}</span>` })
      );
      this.powerBtn.addEventListener('mouseenter', () => mouseActive() && this.focusPower());
      this.stage.el.append(this.el);
      emit('clock');
      this.items = this.buildItems();
      this.sel = Math.max(0, this.items.findIndex((it) => it.profile && it.profile.id === activeProfileId()));
      this.render(true);
      this.offSettings = on('settings', () => {
        if (this.leaving) return;
        const key = this.items[this.sel] && this.items[this.sel].key;
        this.items = this.buildItems();
        const i = this.items.findIndex((it) => it.key === key);
        if (i >= 0) this.sel = i;
        this.render(false);
      });
      this.setHandler((action) => this.handle(action));
      // Build-in: title, then the avatars, then everything else. Input waits
      // until the row is in place.
      this.busy = true;
      requestAnimationFrame(() => this.el.classList.add('in'));
      setTimeout(() => this.el.classList.add('ready'), 1000);
      setTimeout(() => (this.busy = false), 1300);
    });
  }

  buildItems() {
    return [{ key: 'add', type: 'add' }, ...profiles().map((p) => ({ key: p.id, type: 'user', profile: p }))];
  }

  render(first) {
    const keep = new Map((this.itemEls || []).map((el) => [el._key, el]));
    this.itemEls = this.items.map((it, i) => {
      let el = keep.get(it.key);
      const sig = it.profile ? `${it.profile.name}|${it.profile.avatar}|${it.profile.image}` : 'add';
      if (!el || el._sig !== sig) {
        if (el) el.remove();
        const av = h('button', {
          class: 'ws-av fx',
          html: it.type === 'add' ? `<div class="ws-plus">${icon('plus')}</div>` : avatarHtml('ws-avatar', it.profile),
        });
        el = h(
          'div',
          { class: `ws-item ws-${it.type}` },
          h('div', { class: 'ws-pad', html: `<span>1</span>${icon('gamepad')}` }),
          av,
          h('div', { class: 'ws-name', text: it.type === 'add' ? t('Add User') : it.profile.name }),
          h('div', { class: 'ws-opt', html: `<span data-glyph="options">${glyph('options')}</span><span>${t('Options')}</span>` })
        );
        el._key = it.key;
        el._sig = sig;
        av.addEventListener('click', () => {
          const idx = this.items.findIndex((x) => x.key === el._key);
          if (idx === this.sel && this.zone === 'row') this.choose();
          else {
            this.zone = 'row';
            this.select(idx);
          }
        });
        el.querySelector('.ws-opt').addEventListener('click', () => this.options());
        this.rowEl.append(el);
      }
      el.style.setProperty('--i', i);
      return el;
    });
    for (const [key, el] of keep) if (!this.items.some((it) => it.key === key)) el.remove();
    this.layout(first);
  }

  layout() {
    this.itemEls.forEach((el, i) => {
      el.style.setProperty('--x', `${(i - this.sel) * STEP}rem`);
      el.classList.toggle('sel', i === this.sel);
      el.querySelector('.ws-av').classList.toggle('focused', i === this.sel && this.zone === 'row');
    });
    this.powerBtn.classList.toggle('focused', this.zone === 'power');
  }

  select(i) {
    if (i < 0 || i >= this.items.length) {
      sfx.bump();
      return;
    }
    if (i !== this.sel) sfx.move();
    this.sel = i;
    this.layout();
  }

  focusPower(silent = false) {
    if (this.zone === 'power') return true;
    this.zone = 'power';
    if (!silent) sfx.move();
    this.layout();
    return true;
  }

  handle(action) {
    if (this.busy) return;
    unlockAudio();
    if (this.zone === 'power') {
      if (action === 'up' || action === 'back') {
        this.zone = 'row';
        sfx.move();
        this.layout();
      } else if (action === 'confirm') this.powerMenu();
      else sfx.bump();
      return;
    }
    if (action === 'left') this.select(this.sel - 1);
    else if (action === 'right') this.select(this.sel + 1);
    else if (action === 'down') this.focusPower();
    else if (action === 'confirm') this.choose();
    else if (action === 'options') this.options();
  }

  async choose() {
    const it = this.items[this.sel];
    if (!it || this.busy) return;
    if (it.type === 'add') {
      sfx.select();
      this.busy = true;
      const name = await textDialog({ title: 'Add User', placeholder: 'Name', okLabel: 'Add' });
      this.busy = false;
      if (name && name.trim()) {
        const p = await addProfile(name.trim());
        this.items = this.buildItems();
        this.sel = this.items.findIndex((x) => x.key === p.id);
        this.render(false);
      }
      return;
    }
    this.busy = true;
    this.leaving = true;
    sfx.select();
    if (it.profile.id !== activeProfileId()) await useProfile(it.profile.id);
    this.offSettings();
    await this.leave();
    this.resolve();
  }

  async options() {
    const it = this.items[this.sel];
    if (!it || it.type !== 'user' || this.busy) return;
    sfx.select();
    this.busy = true;
    const p = it.profile;
    const anchor = this.itemEls[this.sel].querySelector('.ws-av');
    await optionsMenu({
      title: p.name,
      anchor,
      items: [
        {
          label: 'Change Name…',
          icon: 'edit',
          run: async () => {
            const name = await textDialog({ title: 'Profile Name', value: p.name });
            if (name && name.trim()) await updateProfile(p.id, { name: name.trim() });
          },
        },
        { label: 'Choose Picture…', icon: 'image', run: () => pickProfileImage(p.id) },
        p.image ? { label: 'Remove Picture', icon: 'close', run: () => (api.removeProfileImage(p.image).catch(() => {}), updateProfile(p.id, { image: null })) } : null,
        { label: 'Change Color', icon: 'sliders', run: () => updateProfile(p.id, { avatar: ((p.avatar || 0) + 1) % AVATARS.length }) },
        profiles().length > 1
          ? {
              label: 'Delete User',
              icon: 'trash',
              danger: true,
              run: async () => {
                if (await confirmDialog({ title: t('Delete {name}?', { name: p.name }), message: 'Only the profile is removed. Your games and settings stay.', confirmLabel: 'Delete', danger: true })) {
                  await removeProfile(p.id);
                }
              },
            }
          : null,
      ].filter(Boolean),
    });
    this.busy = false;
  }

  async powerMenu() {
    if (this.busy) return;
    sfx.select();
    this.busy = true;
    const ask = (title, message, label, fn) => async () => {
      if (await confirmDialog({ title, message, confirmLabel: label, danger: true })) fn();
    };
    await optionsMenu({
      title: 'Power',
      anchor: this.powerBtn,
      side: 'above',
      items: [
        { label: 'Exit Launcher', icon: 'exit', run: () => api.windowAction('close') },
        { label: 'Minimize Launcher', icon: 'minimize', run: () => api.windowAction('minimize') },
        { label: 'Sleep', icon: 'moon', run: ask('Put the PC to sleep?', '', 'Sleep', () => api.power('sleep')) },
        { label: 'Restart PC', icon: 'restart', run: ask('Restart the PC?', 'Unsaved work in other apps will be lost.', 'Restart', () => api.power('restart')) },
        { label: 'Turn Off PC', icon: 'power', danger: true, run: ask('Turn off the PC?', 'Unsaved work in other apps will be lost.', 'Turn Off', () => api.power('shutdown')) },
      ],
    });
    this.busy = false;
  }

  /** The other users and the text go first, then the chosen avatar, then the particles. */
  async leave() {
    this.el.classList.add('chosen');
    await sleep(140);
    this.el.classList.add('out');
    await sleep(320);
    this.stage.dimParticles();
    await sleep(380);
    this.el.remove();
  }
}
