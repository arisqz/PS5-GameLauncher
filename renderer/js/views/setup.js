// First-time setup, like a new PS5's: a full-screen flow over the Settings
// light rays and the welcome screen's particles, the first thing a new user
// sees. Choosing the language comes first and can't be skipped; the rest
// (better artwork, Discord, game folders, sounds, game theme music) can.
// Progress shows bottom left, one bar per part, as on the PS5.
//
// Shown by app.js at start-up while setupDone isn't set (over the boot stage,
// which then carries on into the home screen), or from Settings › System ›
// Startup › Run Setup Again (with a stage of its own).

import { h, sleep, clamp, escapeHtml } from '../util.js';
import { icon } from '../icons.js';
import { api, state, on, setSetting, pushNotification } from '../state.js';
import { sfx, unlockAudio } from '../sound.js';
import { mouseActive, getPromptStyle } from '../input.js';
import { mountOverlay, FocusList } from '../ui/overlay.js';
import { BootStage } from '../ui/bootstage.js';
import { rowHtml, activateRow } from '../ui/rows.js';
import { glyph } from '../ui/glyphs.js';
import { optionsMenu, confirmDialog } from '../ui/dialogs.js';
import { addGameFolder, addGameFiles } from '../ui/filebrowser.js';
import { LANGUAGES, t } from '../i18n.js';
import { party, loadDiscord, discordSetup } from '../discord.js';
import { loadYtdlp } from '../thememusic.js';
import { discordItems, themeMusicItems, packChoiceItems, loadPacks } from './settingsSchema.js';
import { checkSgdbKey, sgdbKeyAdded } from '../ui/sgdbkey.js';
import { WebPointer } from '../ui/webpointer.js';

const SGDB_API = 'https://www.steamgriddb.com/profile/preferences/api';
const DISCORD_APPS = 'https://discord.com/developers/applications';

// The web pages a step can show on the right: where each starts and the
// session it keeps (main/main.js lets each stay on its own sites only).
const WEB = {
  sgdb: { home: SGDB_API, partition: 'persist:sgdb' },
  discord: { home: DISCORD_APPS, partition: 'persist:discord' },
};

/** SHA-256 of a string, in hex. */
async function digest(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** The setup's rows from Settings › Network › Discord, less the ones the page beside them does. */
function discordSetupRows() {
  const st = party.state || {};
  const got = !!st.configured;
  const items = discordItems().filter((d) => d.label !== 'Open Discord Developer Portal');
  // Once it's all in, the status and connecting come first.
  const top = got ? items.filter((d) => d.label === 'Status' || (d.type === 'action' && /Connect/i.test(d.label))) : [];
  const rest = items.filter((d) => !top.includes(d));
  return [
    ...top,
    { type: 'step', n: 1, label: 'Sign in to Discord on the right. Scanning the QR code with the Discord app on your phone is quickest.' },
    { type: 'step', n: 2, label: 'Select New Application, give it any name and create it.', run: () => current && current.discordNewApp() },
    { type: 'step', n: 3, label: 'Open OAuth2 on the left of the page, add http://localhost under Redirects and save.', run: () => current && current.discordOAuth() },
    { type: 'step', n: 4, label: got ? 'The Client ID and Secret have been added to the launcher.' : 'Select Reset Secret there. The Client ID and Secret are added to the launcher by themselves.' },
    ...rest,
    { type: 'action', icon: 'refresh', label: 'Back to Your Applications', run: () => current && current.reloadWeb() },
  ];
}

// The parts of the progress bar, and the steps in each.
const SECTIONS = ['Language', 'Games and Friends', 'Sound'];

// Rows the setup leaves to Settings (removing things, long explanations go to the side).
const keepRow = (d) => d && d.type !== 'note' && !d.danger && !/^(Remove|Delete|Install)\b/.test(d.label || '');

const STEPS = [
  {
    id: 'language',
    section: 0,
    title: 'Select Your Language',
    required: true,
  },
  {
    id: 'artwork',
    section: 1,
    title: 'Get Better Artwork',
    sub: 'Steam has artwork for Steam games. For everything else, a free SteamGridDB API key gets you covers, backgrounds and logos.',
    // SteamGridDB itself on the right (signing in with Steam, then its API
    // page); the key it shows is picked up by itself (Setup.watchSgdb).
    web: 'sgdb',
    done: () => !!state.settings.sgdbKey,
    desc: () =>
      state.settings.sgdbKey
        ? 'Your SteamGridDB API key is in the launcher. Covers, backgrounds and logos now come from SteamGridDB too.'
        : 'Signing in happens on SteamGridDB’s own page, and the key is stored on this PC only. It’s also in Settings › Library › Artwork.',
    rows: () => [
      { type: 'step', n: 1, label: 'Sign in on the right with your Steam account. It’s free.' },
      { type: 'step', n: 2, label: 'Select Generate API Key on the page if there isn’t a key yet.', run: () => current && current.generateSgdbKey() },
      { type: 'step', n: 3, label: state.settings.sgdbKey ? 'Your key has been added to the launcher.' : 'The key is added to the launcher by itself.' },
      {
        type: 'text',
        key: 'sgdbKey',
        label: 'SteamGridDB API Key',
        icon: 'image',
        secret: true,
        placeholder: 'Paste or type your key',
        after: async (v) => v && current && (await current.checkSgdbKey()) && sgdbKeyAdded(),
      },
      { type: 'action', icon: 'refresh', label: 'Back to the API Page', run: () => current && current.reloadSgdb() },
    ],
  },
  {
    id: 'discord',
    section: 1,
    title: 'Connect Discord',
    sub: 'See your voice channel and party in the quick menu, mute and leave calls with the controller, and read your messages.',
    // The Discord Developer Portal on the right, where the application the
    // launcher signs in with is made; its Client ID and a new Client Secret
    // are picked up by themselves (Setup.watchDiscord).
    web: 'discord',
    onEnter: () => loadDiscord(),
    done: () => !!(party.state && party.state.configured),
    desc: () =>
      party.state && party.state.status === 'ready'
        ? 'Discord is connected. Your voice channel and party are in the quick menu.'
        : party.state && party.state.configured
          ? 'Choose Connect to Discord, then Authorize in the Discord app on this PC.'
          : 'The application is yours alone: it’s what lets the launcher see and control your voice. The secret is stored on this PC only.',
    rows: () => discordSetupRows(),
  },
  {
    id: 'folders',
    section: 1,
    title: 'Add Your Games',
    sub: 'Steam, Epic Games, Xbox and Ubisoft Connect games are found by themselves. Add folders with your other games.',
    art: 'folders',
    onEnter: () => api.scan().catch(() => {}),
    done: () => (state.settings.folders || []).length > 0,
    desc: () => 'A folder with shortcuts to your games (.lnk, .url or .exe), or with games installed in it. Artwork is downloaded automatically.',
    rows: () => {
      const found = state.games.filter((g) => g.category !== 'media').length;
      return [
        { type: 'info', label: 'Games Found', icon: 'gamepad', value: found ? String(found) : 'Looking…' },
        ...(state.settings.folders || []).map((f) => ({
          type: 'action',
          icon: 'folder',
          label: f.split(/[\\/]/).filter(Boolean).pop() || f,
          value: f,
          valueClass: 'path',
          run: async (el) => {
            await optionsMenu({
              title: f,
              anchor: el,
              items: [
                {
                  label: 'Remove Folder',
                  icon: 'trash',
                  danger: true,
                  run: async () => {
                    if (await confirmDialog({ title: 'Remove this folder?', message: t('Games found in\n{folder}\nwill be removed from the library.', { folder: f }), confirmLabel: 'Remove', danger: true })) await api.removeFolder(f);
                  },
                },
              ],
            });
          },
        })),
        { type: 'action', icon: 'folderPlus', label: 'Add Folder…', run: () => addGameFolder() },
        { type: 'action', icon: 'file', label: 'Add Games from Files…', run: () => addGameFiles() },
      ];
    },
  },
  {
    id: 'sounds',
    section: 2,
    title: 'Choose Your Sounds',
    sub: 'Music for the menus and the sounds of moving around them. More themes can be downloaded right here.',
    art: 'sounds',
    onEnter: () => loadPacks(),
    done: () => true,
    // (Their own switches head each half: no headings over them.)
    rows: () => [...packChoiceItems('music'), ...packChoiceItems('ui')].filter((d) => keepRow(d) && !(d.type === 'header' && !d.busy)),
  },
  {
    id: 'themes',
    section: 2,
    title: 'Game Theme Music',
    sub: 'Play each game’s own theme music while it’s selected, like on the PS5.',
    art: 'themes',
    onEnter: () => loadYtdlp(),
    done: () => state.settings.themeMusic === true,
    rows: () => themeMusicItems(),
  },
];

// Line drawings beside the rows, in the spirit of the PS5's setup pictures.
const ART = {
  artwork:
    '<g transform="rotate(8 64 62)"><rect x="34" y="20" width="58" height="76" rx="5"/></g><g transform="rotate(-6 52 68)"><rect x="22" y="28" width="58" height="76" rx="5"/><circle cx="38" cy="48" r="6"/><path d="M28 94 44 70l11 13 8-9 12 20z"/></g><path class="thin" d="M100 14v12M94 20h12M108 40v7M104.5 43.5h7"/>',
  discord:
    '<path class="open" d="M28 74V60a32 32 0 0 1 64 0v14"/><rect x="20" y="66" width="15" height="28" rx="6"/><rect x="85" y="66" width="15" height="28" rx="6"/><path class="open" d="M92 94c0 10-8 15-20 15h-6"/><rect x="54" y="104" width="12" height="9" rx="4.5"/><path d="M78 8h30a6 6 0 0 1 6 6v16a6 6 0 0 1-6 6H92l-8 7v-7h-6a6 6 0 0 1-6-6V14a6 6 0 0 1 6-6z"/><path class="thin" d="M85 22h.01M93 22h.01M101 22h.01"/>',
  folders:
    '<path d="M12 34a5 5 0 0 1 5-5h25l8 9h53a5 5 0 0 1 5 5v54a5 5 0 0 1-5 5H17a5 5 0 0 1-5-5z"/><path d="M12 50h96v47a5 5 0 0 1-5 5H17a5 5 0 0 1-5-5z"/><g class="thin" transform="translate(36 54) scale(2)"><path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59l-.9 7.2A2.7 2.7 0 0 0 4.5 19c.9 0 1.7-.5 2.1-1.3L8 15h8l1.4 2.7c.4.8 1.2 1.3 2.1 1.3a2.7 2.7 0 0 0 2.7-3.2l-.9-7.2A4 4 0 0 0 17.32 5z"/></g>',
  sounds:
    '<path d="M16 48h16l22-18v60L32 72H16a4 4 0 0 1-4-4V52a4 4 0 0 1 4-4z"/><path class="open" d="M66 46a17 17 0 0 1 0 28M76 36a31 31 0 0 1 0 48M86 26a45 45 0 0 1 0 68"/><path class="open thin" d="M24 8v20M24 8l12-4v20"/><circle cx="20" cy="28" r="4"/><circle cx="32" cy="24" r="4"/>',
  themes:
    '<circle cx="54" cy="56" r="38"/><circle class="open thin" cx="54" cy="56" r="28"/><circle class="open thin" cx="54" cy="56" r="19"/><circle cx="54" cy="56" r="7"/><g transform="translate(64 66) scale(2.1)"><path class="pad" d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59l-.9 7.2A2.7 2.7 0 0 0 4.5 19c.9 0 1.7-.5 2.1-1.3L8 15h8l1.4 2.7c.4.8 1.2 1.3 2.1 1.3a2.7 2.7 0 0 0 2.7-3.2l-.9-7.2A4 4 0 0 0 17.32 5z"/><path class="thin" d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/></g><path class="open thin" d="M96 12v18M96 12l10-3v16"/><circle cx="93" cy="30" r="3.2"/><circle cx="103" cy="25" r="3.2"/>',
};

// A DualSense from above, as the PS5 draws it on its first setup screen (in the
// coordinates of a 2000 × 1125 screen; bottom right, cut off by the screen's edge).
const PAD_SVG = `<svg class="su-pad-art" viewBox="1100 800 700 325" aria-hidden="true">
  <g class="pad-line">
    <path d="M1112 1130C1118 1040 1135 960 1160 895c12-33 32-55 65-61l65-4c20-1 28-8 36-14h212c8 6 16 13 36 14l65 4c33 6 53 28 65 61 25 65 42 145 48 235"/>
    <path d="M1196 838c10-26 45-32 95-30 15 1 22 6 26 12M1668 838c-10-26-45-32-95-30-15 1-22 6-26 12"/>
    <path d="M1332 824h200l12 104c2 20-10 32-30 32h-164c-20 0-32-12-30-32z"/>
    <path d="M1292 850l3 18M1572 850l-3 18"/>
    <path d="M1228 920v-18q0-6 6-6h6q6 0 6 6v18l-9 8zM1228 952v18q0 6 6 6h6q6 0 6-6v-18l-9-8zM1221 927h-14q-6 0-6 6v6q0 6 6 6h14l8-9zM1253 927h14q6 0 6 6v6q0 6-6 6h-14l-8-9z"/>
    <circle cx="1628" cy="888" r="21"/><path d="M1628 878l9 15h-18z"/>
    <circle cx="1582" cy="934" r="21"/><rect x="1573" y="925" width="18" height="18" rx="1.5"/>
    <circle cx="1674" cy="934" r="21"/><circle cx="1674" cy="934" r="9"/>
    <circle cx="1330" cy="1022" r="46"/><circle cx="1330" cy="1022" r="34"/>
    <circle cx="1534" cy="1022" r="46"/><circle cx="1534" cy="1022" r="34"/>
    <path d="M1422 1014h20q6 0 6 6v0q0 6-6 6h-20q-6 0-6-6v0q0-6 6-6zM1424 1052h16"/>
  </g>
  <g class="pad-dots">${[0, 1, 2, 3, 4].map((i) => `<circle cx="${1412 + i * 10}" cy="976" r="2.6"/><circle cx="${1417 + i * 10}" cy="986" r="2.6"/>`).join('')}</g>
  <circle class="pad-x" cx="1628" cy="980" r="22"/>
  <path class="pad-x-mark" d="M1620 972l16 16M1636 972l-16 16"/>
</svg>`;

/** The setup on screen (null when it isn't). */
let current = null;

/**
 * Where the setup should carry on after the window reloads (choosing a
 * language rebuilds the interface), or -1 when it isn't running.
 */
export function setupResume() {
  return current ? current.resumeAt ?? current.index : -1;
}

/**
 * Run the setup. stage: the boot stage to draw over (at start-up); without one
 * the setup brings its own. start: the step to begin with. Resolves when done.
 */
export function runSetup({ stage = null, start = 0 } = {}) {
  if (current) return current.done;
  current = new Setup({ stage, start });
  return current.done;
}

class Setup {
  constructor({ stage, start }) {
    this.index = clamp(start, 0, STEPS.length - 1);
    this.resumeAt = null;
    this.zone = 'list';
    this.busy = false;
    this.offs = [];
    this.done = new Promise((resolve) => (this.resolve = resolve));

    this.ownStage = !stage;
    this.stage = stage;
    this.page = h('div', { class: 'su-page' });
    this.progress = h('div', { class: 'su-progress' });
    this.hints = h('div', { class: 'su-hints' });
    this.padEl = h('div', { class: 'su-pad', html: `${PAD_SVG}<span class="su-pad-label">${escapeHtml(t('Select'))}</span>` });
    this.el = h('div', { class: `overlay setup${this.ownStage ? ' own-stage' : ''}` }, this.page, this.progress, this.hints, this.padEl);
    this.ctl = mountOverlay(this.el, (a) => this.handle(a), { closeDelay: 700 });
    // Pop-ups (library updates and the like) wait: the setup has the screen to itself, as on the PS5.
    document.body.classList.add('in-setup');
    if (this.ownStage) {
      // Its own backdrop (on screen first, so the particles know its size).
      this.stage = new BootStage({ rays: true });
      this.stage.mount(this.el);
      this.el.prepend(this.stage.el);
    }

    const rerender = () => this.renderRows(true);
    for (const evt of ['settings', 'games', 'discord', 'soundpacks', 'ytdlp', 'info']) this.offs.push(on(evt, rerender));
    this.offs.push(on('device', () => this.renderHints()));
    this.show(0);
  }

  get step() {
    return STEPS[this.index];
  }

  /* ---------------------------------------------------------------- */
  /* Pages                                                             */
  /* ---------------------------------------------------------------- */

  /** Show the current step; dir: 1 forward, -1 back, 0 the first one. */
  async show(dir) {
    const st = this.step;
    this.busy = true;
    // The SteamGridDB page (if it was up) goes with its step, and its pointer.
    clearInterval(this.webTimer);
    this.web = null;
    if (this.pointer) this.pointer.destroy();
    this.pointer = null;
    if (dir) {
      this.page.classList.remove('in');
      this.page.classList.add('out');
      await sleep(180);
    }
    this.page.className = `su-page su-${st.id}${dir < 0 ? ' back' : ''}`;
    this.page.innerHTML = '';
    this.sig = null;
    this.zone = st.id === 'language' ? 'langs' : 'list';
    this.el.classList.toggle('on-language', st.id === 'language');
    this.page.append(h('h1', { class: 'su-title', text: t(st.title) }));
    if (st.sub) this.page.append(h('div', { class: 'su-sub', text: t(st.sub) }));
    if (st.id === 'language') this.buildLanguages();
    else this.buildStep(st);
    this.renderProgress();
    this.renderHints();
    if (st.onEnter) st.onEnter();
    void this.page.offsetWidth;
    this.page.classList.add('in');
    this.busy = false;
  }

  buildLanguages() {
    const cur = state.settings.language || 'auto';
    this.langList = h('div', { class: 'su-lang-list' });
    const els = LANGUAGES.map((l, i) => {
      const el = h('button', {
        class: `su-lang fx fx-in${l.value === cur ? ' current' : ''}`,
        html: `<span class="su-check">${l.value === cur ? icon('check') : ''}</span><span>${escapeHtml(l.value === 'auto' ? t(l.label) : l.label)}</span>`,
        onmouseenter: () => mouseActive() && this.langNav.set(i),
        onclick: () => {
          this.langNav.set(i);
          this.chooseLanguage();
        },
      });
      return el;
    });
    this.langList.append(...els);
    this.langWrap = h('div', { class: 'su-lang-wrap' }, this.langList);
    this.page.append(this.langWrap);
    this.langNav = new FocusList(els, { index: Math.max(0, LANGUAGES.findIndex((l) => l.value === cur)), onChange: () => this.scrollLanguages() });
    requestAnimationFrame(() => this.scrollLanguages(true));
  }

  /** The chosen language row sits in the middle of the screen, as on the PS5. */
  scrollLanguages(instant = false) {
    const el = this.langNav.current;
    if (!el) return;
    const wrapH = this.langWrap.clientHeight;
    const y = el.offsetTop + el.offsetHeight / 2 - wrapH / 2;
    if (instant) this.langList.style.transition = 'none';
    this.langList.style.transform = `translateY(${-y}px)`;
    if (instant) {
      void this.langList.offsetWidth;
      this.langList.style.transition = '';
    }
  }

  async chooseLanguage() {
    const l = LANGUAGES[this.langNav.index];
    if (!l || this.busy) return;
    sfx.select();
    if ((state.settings.language || 'auto') === l.value) return this.go(1);
    // The interface is built again in the new language (app.js reloads the
    // window), and the setup carries on with its next step.
    this.busy = true;
    this.resumeAt = this.index + 1;
    await setSetting('language', l.value);
  }

  buildStep(st) {
    this.list = h('div', { class: 'set-list su-list' });
    this.listWrap = h('div', { class: 'su-list-wrap' }, this.list);
    this.listWrap.addEventListener(
      'wheel',
      (e) => {
        const now = performance.now();
        if (now - (this.lastWheel || 0) < 70 || !this.listNav) return;
        this.lastWheel = now;
        this.setZone('list');
        if (this.listNav.move(e.deltaY > 0 ? 1 : -1)) sfx.move();
      },
      { passive: true }
    );
    this.descEl = h('div', { class: 'su-desc' });
    this.btnRow = h('div', { class: 'su-btns' });
    const side = st.web ? this.buildWeb(st.web) : h('div', { class: 'su-art', html: `<svg viewBox="0 0 120 120" aria-hidden="true">${ART[st.art] || ''}</svg>` });
    this.page.append(this.listWrap, side, this.descEl, this.btnRow);
    this.renderRows(false);
  }

  /* ---------------------------------------------------------------- */
  /* Web pages in the setup (SteamGridDB, the Discord Developer Portal) */
  /* ---------------------------------------------------------------- */

  /**
   * A site's own pages where the picture would be: SteamGridDB's API page
   * (which asks to sign in with Steam first), or Discord's applications.
   * main/main.js keeps each view on its own sites, in a session of its own.
   */
  buildWeb(kind) {
    this.webKind = kind;
    this.webBox = h('div', { class: 'su-web loading' }, h('div', { class: 'su-web-load', html: '<span class="spinner"></span>' }));
    this.mountWeb(WEB[kind].home);
    if (kind === 'sgdb') this.watchSgdb();
    else this.watchDiscord();
    // The right stick moves a pointer over the page (cross clicks, a text field gets the keyboard).
    this.pointer = new WebPointer(this.webBox, { getWeb: () => this.web, onWake: () => this.setZone('web', true) });
    return this.webBox;
  }

  /** The page the step's view starts on, again. */
  reloadWeb() {
    if (this.web && this.webKind) this.web.loadURL(WEB[this.webKind].home).catch(() => {});
  }

  /**
   * A (new) view of the page. Also after signing in: SteamGridDB's page Steam
   * returns to says "Success! You may close this window" and closes itself (it
   * expects to be a pop-up), which ends the view; the next one opens on the
   * API page, now signed in.
   */
  mountWeb(url) {
    if (this.web) this.web.remove();
    const { home, partition } = WEB[this.webKind];
    const web = document.createElement('webview');
    web.className = 'su-webview';
    web.setAttribute('partition', partition);
    // "Login via Steam" opens a pop-up: main/main.js shows it in this same view instead (no window ever opens).
    web.setAttribute('allowpopups', '');
    // As a plain Chrome (sites can turn away a browser they don't know).
    web.setAttribute('useragent', navigator.userAgent.replace(/ (?:Electron|ps5[\w-]*)\/\S+/gi, ''));
    web.setAttribute('src', url);
    this.web = web;
    this.webBox.prepend(web);
    web.addEventListener('close', () => {
      if (this.web === web) setTimeout(() => this.web === web && this.mountWeb(home), 300);
    });
    // The spinner follows the page itself, not what it keeps loading in frames
    // (SteamGridDB's front page never stops: the spinner stayed up for good).
    const busy = (on) => {
      clearTimeout(this.webBusyTimer);
      this.webBox.classList.toggle('loading', on);
      if (on) this.webBusyTimer = setTimeout(() => this.webBox.classList.remove('loading'), 6000);
    };
    web.addEventListener('did-start-navigation', (e) => e.isMainFrame && !e.isInPlace && busy(true));
    web.addEventListener('dom-ready', () => {
      web._ready = true;
      busy(false);
    });
    web.addEventListener('did-fail-load', (e) => e.isMainFrame && busy(false));
    web.addEventListener('dom-ready', () => {
      // About 900 CSS pixels across, whatever the screen: the page's layout, readable from the couch.
      const w = this.webBox.clientWidth || 900;
      try {
        web.setZoomFactor(Math.max(0.6, Math.min(1.6, w / 900)));
      } catch {}
    });
  }

  /**
   * Once a second while the page is up, from where it is (not from navigation
   * events: the page's frames send plenty of their own):
   *  - signed in on another SteamGridDB page (where it lands after signing in,
   *    its front page): on to the API page;
   *  - still on the page Steam sends back to after 3 s: on to the API page too;
   *  - on the API page: the key it shows goes into the launcher.
   */
  watchSgdb() {
    clearInterval(this.webTimer);
    this.webTimer = setInterval(async () => {
      if (!this.web || !this.web.isConnected) return clearInterval(this.webTimer);
      let url = '';
      try {
        url = this.web.getURL();
      } catch {
        // The page behind the view is gone (it closed itself): a new view, on
        // the API page. (A view still starting up can't answer yet either.)
        if (this.web._ready && !this.webGone) {
          this.webGone = true;
          this.mountWeb(SGDB_API);
          setTimeout(() => (this.webGone = false), 3000);
        }
        return;
      }
      this.webUrl = url;
      const onSgdb = /^https:\/\/(www\.)?steamgriddb\.com\//i.test(url);
      const onApi = onSgdb && /\/profile\/preferences\/api/i.test(url);
      if (!onApi) {
        // Been through Steam's sign-in: the next SteamGridDB page it lands on means signed in.
        if (/^https:\/\/([a-z0-9-]+\.)*(steamcommunity|steampowered)\.com\//i.test(url) || /\/login\/steam/i.test(url)) this.webSawSteam = true;
        this.webBackSince = onSgdb && /\/login\/steam/i.test(url) ? this.webBackSince || Date.now() : 0;
        if (!onSgdb || state.settings.sgdbKey || (/\/login(\/|$|\?)/i.test(url) && !this.webBackSince)) return;
        let signedIn = false;
        if (this.webBackSince) signedIn = Date.now() - this.webBackSince > 3000;
        else if (this.webSawSteam) signedIn = true;
        else {
          try {
            // Signed out, SteamGridDB shows a "Login" link to Steam's sign-in at the top of
            // every page. (Not document.readyState: its front page never finishes loading.)
            signedIn = await this.web.executeJavaScript(
              `!!document.body && ![...document.querySelectorAll('a[href*="steamcommunity.com/openid"]')].some((a) => a.offsetParent !== null)`
            );
          } catch {}
        }
        if (signedIn) {
          this.webBackSince = 0;
          this.webSawSteam = false;
          this.web.loadURL(SGDB_API).catch(() => {});
        }
        return;
      }
      let key = null;
      try {
        // The key as the page shows it: a visible field or a short line of text
        // that is nothing but 32 hex digits (never hidden form tokens).
        key = await this.web.executeJavaScript(`(() => {
          const re = /^[0-9a-f]{32}$/i;
          const shown = (el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
          for (const el of document.querySelectorAll('input:not([type=hidden]), textarea')) if (re.test((el.value || '').trim()) && shown(el)) return el.value.trim();
          for (const el of document.querySelectorAll('code, pre, kbd, span, div, p, td, strong, b')) {
            if (el.children.length) continue;
            const v = (el.textContent || '').trim();
            if (re.test(v) && shown(el)) return v;
          }
          return null;
        })()`);
      } catch {}
      if (!key || key.toLowerCase() === state.settings.sgdbKey || key.toLowerCase() === this.sgdbRejected) return;
      const before = state.settings.sgdbKey || '';
      await setSetting('sgdbKey', key.toLowerCase());
      if (await this.checkSgdbKey()) await sgdbKeyAdded();
      else {
        // Not a key SteamGridDB knows: the one before stays.
        this.sgdbRejected = key.toLowerCase();
        await setSetting('sgdbKey', before);
      }
      this.renderRows(true);
    }, 1000);
  }

  /** The key picked up: does SteamGridDB take it? */
  async checkSgdbKey() {
    const { ok, error } = await checkSgdbKey();
    this.sgdbError = error;
    this.onRowFocus();
    // Only a key SteamGridDB turns down is wrong (not a moment without a connection).
    return ok !== false;
  }

  /** "Generate API Key" on the page, for a controller (only when it shows no key yet). */
  async generateSgdbKey() {
    if (!this.web) return;
    if (!/\/profile\/preferences\/api/i.test(this.webUrl || '')) {
      this.reloadSgdb();
      return;
    }
    try {
      await this.web.executeJavaScript(`(() => {
        if (/\\b[0-9a-f]{32}\\b/i.test(document.body.innerText)) return false;
        const b = [...document.querySelectorAll('button, a, [role=button]')].find((x) => /generate/i.test(x.textContent) && !/re-?generate/i.test(x.textContent));
        if (b) b.click();
        return !!b;
      })()`);
    } catch {}
  }

  reloadSgdb() {
    this.reloadWeb();
  }

  /**
   * Once a second while the Discord Developer Portal is up: on one of the
   * user's applications, its ID is the Client ID (taken while none is set
   * up); on its OAuth2 page after Reset Secret, the new secret the page shows
   * goes into the launcher with it.
   */
  watchDiscord() {
    clearInterval(this.webTimer);
    this.webTimer = setInterval(async () => {
      if (!this.web || !this.web.isConnected) return clearInterval(this.webTimer);
      let url = '';
      try {
        url = this.web.getURL();
      } catch {
        return;
      }
      this.webUrl = url;
      const m = /^https:\/\/(?:www\.)?discord\.com\/developers\/applications\/(\d{15,22})(?:[/?#]|$)/i.exec(url);
      if (!m) return;
      const id = m[1];
      this.discordApp = id;
      const st = party.state || {};
      if (!st.configured && st.clientId !== id && !this.discordBusy) {
        this.discordBusy = true;
        await discordSetup({ clientId: id });
        this.discordBusy = false;
      }
      if (!/\/oauth2(?:[/?#]|$)/i.test(url)) return;
      let secret = null;
      try {
        // The secret as the page shows it once, after Reset Secret: a line of
        // 32 letters, digits, - and _ on its own (never the ID, all digits).
        secret = await this.web.executeJavaScript(`(() => {
          const re = /^[A-Za-z0-9_-]{32}$/;
          const ok = (v) => re.test(v) && !/^[0-9]+$/.test(v);
          const shown = (el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
          for (const el of document.querySelectorAll('input:not([type=hidden]), textarea')) if (ok((el.value || '').trim()) && shown(el)) return el.value.trim();
          for (const el of document.querySelectorAll('code, pre, kbd, span, div, p, strong, b')) {
            if (el.children.length) continue;
            const v = (el.textContent || '').trim();
            if (ok(v) && shown(el)) return v;
          }
          return null;
        })()`);
      } catch {}
      // (Only a hash of it is kept, to know it's been taken.)
      const seen = secret && (await digest(`${id}:${secret}`));
      if (!secret || seen === this.discordSeen || this.discordBusy) return;
      this.discordSeen = seen;
      this.discordBusy = true;
      const ok = await discordSetup({ clientId: id, secret });
      this.discordBusy = false;
      if (ok) {
        pushNotification({
          title: 'Discord Application Added',
          body: 'Choose Connect to Discord to finish.',
          icon: 'party',
          kind: 'system',
          duringSetup: true,
        });
      }
      this.renderRows(true);
    }, 1000);
  }

  /** "New Application" on the applications page, for a controller. */
  async discordNewApp() {
    if (!this.web) return;
    if (!/\/developers\/applications\/?(?:[?#]|$)/i.test(this.webUrl || '')) {
      this.reloadWeb();
      return;
    }
    try {
      await this.web.executeJavaScript(`(() => {
        const b = [...document.querySelectorAll('button, a, [role=button]')].find((x) => /^\\s*new application\\s*$/i.test(x.textContent));
        if (b) b.click();
        return !!b;
      })()`);
    } catch {}
  }

  /** The application's OAuth2 page (or the applications, to pick one first). */
  discordOAuth() {
    if (!this.web) return;
    if (this.discordApp) this.web.loadURL(`${DISCORD_APPS}/${this.discordApp}/oauth2`).catch(() => {});
    else this.reloadWeb();
  }

  /** The step's rows (again, when something they show has changed). */
  renderRows(keep) {
    const st = this.step;
    if (!st || st.id === 'language' || !this.list) return;
    const all = st.rows().filter(Boolean);
    const notes = all.filter((d) => d.type === 'note').map((d) => t(d.label));
    const defs = all.filter(keepRow);
    this.notes = notes;
    const sig = defs.map((d) => `${d.type}|${d.label}|${d.disabled || ''}|${d.type === 'header' || d.type === 'step' ? '' : rowHtml(d)}`).join('\n') + `|${st.done ? st.done() : ''}`;
    if (keep && sig === this.sig) return;
    this.sig = sig;
    const prev = keep && this.listNav ? this.listNav.index : 0;
    this.list.innerHTML = '';
    const focusables = [];
    for (const d of defs) {
      let el;
      if (d.type === 'header') el = h('div', { class: 'set-header', text: t(d.label) });
      else {
        el =
          d.type === 'step'
            ? h('button', { class: 'set-step fx fx-in' }, h('span', { class: 'ss-num', text: String(d.n) }), h('span', { class: 'ss-text', text: t(d.label) }))
            : h('button', { class: `set-item fx fx-in t-${d.type}${d.disabled ? ' disabled' : ''}`, html: rowHtml(d) });
        const i = focusables.length;
        el._def = d;
        el.addEventListener('mouseenter', () => {
          if (!mouseActive() || d.disabled) return;
          this.setZone('list', true);
          this.listNav.set(i);
        });
        el.addEventListener('click', () => {
          if (d.disabled) return;
          this.setZone('list', true);
          this.listNav.set(i);
          this.activate();
        });
        focusables.push(el);
      }
      this.list.append(el);
    }
    this.listNav = new FocusList(focusables, { index: clamp(prev, 0, Math.max(0, focusables.length - 1)), onChange: () => this.onRowFocus() });
    this.renderButtons();
    if (!focusables.length && this.zone === 'list') this.zone = 'btns';
    this.applyZone();
    this.onRowFocus(!keep);
  }

  renderButtons() {
    const st = this.step;
    const last = this.index === STEPS.length - 1;
    const defs = [];
    if (!st.required && !(st.done && st.done())) defs.push({ label: 'Skip', run: () => this.go(1) });
    defs.push({ label: last ? 'Done' : 'Next', primary: true, run: () => this.go(1) });
    const keepPrimary = this.btnNav ? this.btnNav.current && this.btnNav.current.classList.contains('primary') : true;
    this.btnRow.innerHTML = '';
    const els = defs.map((b, i) =>
      h('button', {
        class: `su-btn fx${b.primary ? ' primary' : ''}`,
        text: t(b.label),
        onmouseenter: () => {
          if (!mouseActive()) return;
          this.setZone('btns', true);
          this.btnNav.set(i);
        },
        onclick: () => {
          this.setZone('btns', true);
          this.btnNav.set(i);
          sfx.select();
          b.run();
        },
      })
    );
    els.forEach((el, i) => (el._run = defs[i].run));
    this.btnRow.append(...els);
    this.btnNav = new FocusList(els, { index: keepPrimary ? els.length - 1 : 0 });
  }

  /** The focused row's explanation (or the step's) beside the rows. */
  onRowFocus(instant = false) {
    const el = this.listNav && this.zone === 'list' ? this.listNav.current : null;
    const d = el && el._def;
    const st = this.step;
    const text = (st.id === 'artwork' && this.sgdbError) || (d && d.desc) || (st.desc && st.desc()) || (this.notes && this.notes[0]) || '';
    if (this.descEl && this.descEl.textContent !== t(text)) {
      this.descEl.textContent = t(text);
      // A long explanation in smaller type, under a smaller picture.
      this.page.classList.toggle('long-desc', t(text).length > 150);
    }
    this.scrollList(instant);
  }

  scrollList(instant = false) {
    if (!this.listWrap) return;
    const el = this.listNav && this.listNav.current;
    const wrapH = this.listWrap.clientHeight;
    const listH = this.list.scrollHeight;
    let y = 0;
    if (el && listH > wrapH) y = clamp(el.offsetTop + el.offsetHeight / 2 - wrapH * 0.42, 0, listH - wrapH + 40);
    if (instant) this.list.style.transition = 'none';
    this.list.style.transform = `translateY(${-y}px)`;
    this.listWrap.classList.toggle('fade-top', y > 4);
    this.listWrap.classList.toggle('fade-bottom', listH - y > wrapH + 4);
    if (instant) {
      void this.list.offsetWidth;
      this.list.style.transition = '';
    }
  }

  setZone(zone, silent = false) {
    if (zone === this.zone) return;
    if (zone === 'list' && !(this.listNav && this.listNav.els.length)) return;
    if (zone === 'web' && !this.pointer) return;
    this.zone = zone;
    if (!silent) sfx.move();
    this.applyZone();
    this.onRowFocus();
  }

  applyZone() {
    if (this.listNav) this.listNav.blur();
    if (this.btnNav) this.btnNav.blur();
    if (this.zone === 'list' && this.listNav) this.listNav.refocus();
    if (this.zone === 'btns' && this.btnNav) this.btnNav.refocus();
    if (this.pointer) this.zone === 'web' ? this.pointer.show() : this.pointer.hide();
    this.renderHints();
  }

  async activate() {
    const el = this.listNav && this.listNav.current;
    if (!el) return;
    await activateRow(el._def, el, () => this.renderRows(true));
  }

  /** Bottom left: one bar per part; done parts get a tick, the current one its name. */
  renderProgress() {
    const sec = this.step.section;
    const inSec = STEPS.filter((s) => s.section === sec);
    const pos = inSec.indexOf(this.step);
    if (!this.progress.children.length) {
      this.progress.append(
        ...SECTIONS.map(() => h('div', { class: 'su-sec' }, h('span', { class: 'su-sec-label' }), h('i', { class: 'su-seg' }, h('b'))))
      );
    }
    [...this.progress.children].forEach((el, i) => {
      const done = i < sec;
      const cur = i === sec;
      el.classList.toggle('done', done);
      el.classList.toggle('cur', cur);
      el.querySelector('.su-sec-label').innerHTML = done ? icon('check') : cur ? escapeHtml(t(SECTIONS[i])) : '';
      el.querySelector('b').style.width = `${done ? 100 : cur ? ((pos + 1) / (inSec.length + 1)) * 100 : 0}%`;
    });
  }

  renderHints() {
    let list = this.index > 0 ? [['confirm', 'Select'], ['back', 'Back']] : [];
    if (this.zone === 'web') list = [['rstick', 'Move'], ['confirm', 'Click'], ['back', 'Back']];
    else if (this.pointer && getPromptStyle(state.settings.prompts) !== 'keyboard') list = [['rstick', 'Pointer'], ...list];
    this.hints.innerHTML = list.map(([a, label]) => `<span class="su-hint">${glyph(a)}<span>${escapeHtml(t(label))}</span></span>`).join('');
  }

  /* ---------------------------------------------------------------- */
  /* Moving on                                                         */
  /* ---------------------------------------------------------------- */

  async go(d) {
    if (this.busy) return;
    const i = this.index + d;
    if (i < 0) return sfx.bump();
    if (i >= STEPS.length) return this.finish();
    this.index = i;
    if (d < 0) sfx.back();
    await this.show(d);
  }

  async finish() {
    this.busy = true;
    clearInterval(this.webTimer);
    if (this.pointer) this.pointer.destroy();
    this.pointer = null;
    await setSetting('setupDone', true);
    this.el.classList.add('leaving');
    document.body.classList.remove('in-setup');
    for (const off of this.offs) off();
    this.ctl.close();
    current = null;
    if (this.ownStage) setTimeout(() => this.stage.destroy(), 760);
    await sleep(this.ownStage ? 200 : 520);
    this.resolve();
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  handle(action) {
    unlockAudio();
    if (this.busy) return;
    // On the page: the pointer's buttons; Back (or left / right) leaves it.
    if (this.zone === 'web') {
      switch (action) {
        case 'confirm':
          this.pointer.click();
          return;
        case 'up':
        case 'down':
          this.pointer.scroll(action === 'up' ? -1 : 1);
          return;
        case 'back':
        case 'left':
          this.setZone('list');
          return;
        case 'right':
          this.setZone('btns');
          return;
      }
      sfx.bump();
      return;
    }
    if (action === 'back') {
      if (this.index > 0) this.go(-1);
      else sfx.bump();
      return;
    }
    if (this.zone === 'langs') {
      if (action === 'up' || action === 'down') {
        if (this.langNav.move(action === 'up' ? -1 : 1)) sfx.move();
        else sfx.bump();
      } else if (action === 'confirm') this.chooseLanguage();
      else sfx.bump();
      return;
    }
    if (this.zone === 'list') {
      switch (action) {
        case 'up':
          if (this.listNav.move(-1)) sfx.move();
          else sfx.bump();
          return;
        case 'down':
          if (this.listNav.move(1)) sfx.move();
          else this.setZone('btns');
          return;
        case 'confirm':
          this.activate();
          return;
        case 'right':
          this.setZone('btns');
          return;
      }
      sfx.bump();
      return;
    }
    // The buttons at the bottom right.
    switch (action) {
      case 'left':
      case 'right':
        if (this.btnNav.move(action === 'left' ? -1 : 1)) sfx.move();
        else if (action === 'left' && this.listNav && this.listNav.els.length) this.setZone('list');
        else sfx.bump();
        return;
      case 'up':
        if (this.listNav && this.listNav.els.length) this.setZone('list');
        else sfx.bump();
        return;
      case 'confirm': {
        const el = this.btnNav.current;
        if (el) {
          sfx.select();
          el._run();
        }
        return;
      }
    }
    sfx.bump();
  }
}
