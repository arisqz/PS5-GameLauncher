// The "game hub" content shown under the carousel (and in the stand-alone hub
// view): logo, description, Play / options buttons and activity cards.

import { h, escapeHtml, fmtPlaytime, timeAgo, fmtDate, fmtBytes } from '../util.js';
import { icon } from '../icons.js';
import { api, artUrl, state, on, playtimeOf, lastActive, sourceLabel, sourceName, gamesIn, sortGames, findGame, downloadFor, isInstalled } from '../state.js';
import { FocusList } from './overlay.js';
import { mouseActive } from '../input.js';
import { launchGame, gameOptions, isRunning } from './gameactions.js';
import { addGameFolder, addGameFiles, showGameLocation } from './filebrowser.js';
import { screenshotViewer, infoDialog } from './dialogs.js';
import { tileArt } from './tiles.js';
import { sliderHtml, setSlider, dragSlider } from './slider.js';
import { sys, mediaCommand, mediaPosition, seekLocal, selectSession, appName, fmtTime } from '../system.js';
import { t, language } from '../i18n.js';
import { ACTIVE, statusText, progressOf, fmtLeft, fmtSpeed, startUpdate, startInstall, pulsing } from './downloads.js';
import { ExploreHub } from './explore.js';

/*
 * Game logos are decoded before they go on screen. A picture the page shows
 * for the first time is otherwise decoded while the frame that shows it waits
 * (traced: a 1280 × 720 logo held a frame for 300 ms), which is a hitch when
 * moving through the games fast. Decoded ones are remembered; the next games'
 * logos are decoded ahead while nothing else happens (warmLogos).
 */
// Decoded into an ImageBitmap at the size it's shown (off the main thread) and
// drawn into a canvas: an <img>, even decoded beforehand, is decoded again by
// the compositor the first time it's drawn, and the frame waits for that.
const decodedLogos = new Map(); // url → Promise<ImageBitmap | null>

function decodeLogo(url) {
  let p = decodedLogos.get(url);
  if (!p) {
    const img = new Image();
    img.src = url;
    p = img
      .decode()
      .then(() => {
        // Never larger than the logo's box (64 × 22rem) at up to twice its pixels.
        const k = Math.min(1, 1000 / img.naturalWidth, 360 / img.naturalHeight);
        return createImageBitmap(img, { resizeWidth: Math.max(1, Math.round(img.naturalWidth * k)), resizeHeight: Math.max(1, Math.round(img.naturalHeight * k)), resizeQuality: 'high' });
      })
      .catch(() => null);
    decodedLogos.set(url, p);
    // A few dozen at most (about 1.4 MB each).
    if (decodedLogos.size > 40) {
      const old = decodedLogos.keys().next().value;
      decodedLogos.get(old).then((b) => b && b.close());
      decodedLogos.delete(old);
    }
  }
  return p;
}

/** The logo as an element: shown once decoded (the name in its place if it can't be). */
function logoImage(url, name) {
  const wrap = h('div', { class: 'hub-logo-slot' });
  decodeLogo(url).then((bmp) => {
    if (!wrap.parentNode) return;
    let el;
    try {
      el = h('canvas', { class: 'hub-logo', title: name });
      el.width = bmp.width;
      el.height = bmp.height;
      el.getContext('2d').drawImage(bmp, 0, 0);
    } catch {
      el = h('div', { class: 'hub-title', text: name });
    }
    wrap.replaceWith(el);
  });
  return wrap;
}

/** Decode these logos in idle time, so selecting their games shows them at once. */
export function warmLogos(urls) {
  const todo = urls.filter((u) => u && !decodedLogos.has(u));
  const next = () => {
    const u = todo.shift();
    if (!u) return;
    decodeLogo(u).finally(() => (window.requestIdleCallback || setTimeout)(next));
  };
  (window.requestIdleCallback || setTimeout)(next);
}

export class HubPanel {
  /**
   * @param {{ onFocusRequest(zone:string, index:number):void, openView(name:string):void }} host
   */
  constructor(host) {
    this.host = host;
    this.item = null;
    this.main = h('div', { class: 'hub-main' });
    this.cardsTrack = h('div', { class: 'hub-cards-track' });
    this.cards = h('div', { class: 'hub-cards' }, this.cardsTrack);
    // Explore's widgets (home only: hosts that can focus them pass onWidgetFocus).
    this.explore = host.onWidgetFocus
      ? new ExploreHub({
          openView: (name, params) => host.openView(name, params),
          focusGame: (id) => host.focusGame(id),
          openQuick: (id, tab) => host.openQuick(id, tab),
          onFocusRequest: (i, how) => host.onWidgetFocus(i, how),
        })
      : null;
    this.el = h('div', { class: 'hub' }, this.main, this.cards, this.explore ? this.explore.el : null);
    this.actions = new FocusList([]);
    this.cardNav = new FocusList([], { onChange: (el) => this.scrollCards(el) });
    this.actionDefs = [];
    this.cardDefs = [];
    // A Steam update starting, moving on or finishing for the game shown.
    on('downloads', () => this.onDownloads());
  }

  onDownloads() {
    if (!this.item || this.item.type !== 'game') return;
    const g = findGame(this.item.game.id) || this.item.game;
    const d = downloadFor(g);
    const mode = d ? (ACTIVE.has(d.status) ? 'active' : 'update') : isInstalled(g) ? 'play' : 'download';
    if (mode !== this.dlMode) {
      // Update ↔ Play: rebuild the buttons (focus stays on the same one).
      this.setItem({ ...this.item, game: g }, { animate: false });
      this.host.onDownloadsChanged && this.host.onDownloadsChanged();
      return;
    }
    this.paintDownload(d);
  }

  /** The progress strip under the buttons. */
  paintDownload(d) {
    const el = this.main.querySelector('.hub-dl');
    if (!el) return;
    const active = !!d && ACTIVE.has(d.status);
    el.classList.toggle('show', !!d);
    if (!d) return;
    el.querySelector('.hdl-state').textContent = statusText(d);
    const bits = [];
    if (active && d.total) bits.push(`${Math.floor(progressOf(d) * 100)}%`);
    if (d.status === 'downloading') bits.push(fmtSpeed(d.speed), fmtLeft(d.eta));
    if (!active && d.total) bits.push(t('{size} to download', { size: fmtBytes(d.total) }));
    el.querySelector('.hdl-info').textContent = bits.filter(Boolean).join(' · ');
    el.querySelector('.hdl-bar').style.display = active ? '' : 'none';
    el.querySelector('.hdl-bar').classList.toggle('pulse', pulsing(d));
    el.querySelector('.hdl-bar i').style.width = `${Math.max(1, progressOf(d) * 100)}%`;
    el.classList.toggle('error', d.status === 'error');
  }

  /** item: { type: 'game'|'library'|'explore'|'add', game? } */
  setItem(item, { animate = true } = {}) {
    const sameItem = !!(this.item && item && this.item.key && this.item.key === item.key);
    this.item = item;
    const keepAction = this.actions.index;
    this.main.innerHTML = '';
    this.cardsTrack.innerHTML = '';
    if (!item) {
      this.el.classList.remove('explore-on');
      return;
    }
    if (item.type === 'game') this.buildGame(item.game);
    else if (item.type === 'library') this.buildLibrary();
    else if (item.type === 'explore') this.buildExplore(animate);
    else if (item.type === 'media-empty') this.buildMediaEmpty();
    else if (item.type === 'nowplaying') this.buildNowPlaying();
    else this.buildWelcome();

    this.el.classList.toggle('explore-on', item.type === 'explore');
    if (animate) {
      this.main.classList.remove('enter');
      void this.main.offsetWidth;
      this.main.classList.add('enter');
    }
    this.renderActions(keepAction);
    this.renderCards(sameItem);
  }

  /* ---------------------------------------------------------------- */

  buildGame(g) {
    const logo = artUrl(g, 'logo');
    const desc = (g.meta && g.meta.description) || '';
    const running = isRunning(g);
    const titleEl = logo ? logoImage(logo, g.name) : h('div', { class: 'hub-title', text: g.name });
    const pt = playtimeOf(g);
    this.main.append(
      h('div', { class: 'hub-logo-wrap' }, titleEl),
      desc ? h('div', { class: 'hub-desc', text: desc }) : h('div', { class: 'hub-desc dim', text: g.metaStatus === 'pending' ? 'Fetching artwork and details…' : '' }),
      h(
        'div',
        { class: 'hub-stats' },
        running ? h('div', { class: 'pill running', html: `<i class="dot"></i>Running` }) : null,
        isInstalled(g) ? null : h('div', { class: 'pill', html: `${icon('download')}<span>${escapeHtml(t('Not installed'))}</span>` }),
        h('div', { class: 'pill', html: `${icon('tag')}<span>${escapeHtml(sourceLabel(g))}</span>` }),
        pt ? h('div', { class: 'pill', html: `${icon('clock')}<span>${fmtPlaytime(pt)}</span>` }) : null
      )
    );
    // A Steam update waiting: "Update" instead of "Play" (like the PS5).
    // While it downloads, the button opens Downloads and the strip below shows how far it is.
    const dl = downloadFor(g);
    this.dlMode = dl ? (ACTIVE.has(dl.status) ? 'active' : 'update') : isInstalled(g) ? 'play' : 'download';
    const primary = running
      ? { label: 'Continue', icon: 'play', primary: true, run: (el) => launchGame(findGame(g.id) || g, { from: el }) }
      : this.dlMode === 'update'
        ? { label: dl.status === 'error' ? 'Try Again' : 'Update', icon: 'download', primary: true, run: () => (isInstalled(g) ? startUpdate : startInstall)(findGame(g.id) || g) }
        : this.dlMode === 'active'
          ? { label: dl.status === 'paused' ? 'Resume' : 'View Download', icon: 'download', primary: true, run: () => (dl.status === 'paused' ? startUpdate(findGame(g.id) || g) : this.host.openView('downloads')) }
          : this.dlMode === 'download'
            ? { label: 'Download', icon: 'download', primary: true, run: () => startInstall(findGame(g.id) || g) }
            : { label: 'Play', icon: 'play', primary: true, run: (el) => launchGame(findGame(g.id) || g, { from: el }) };
    this.actionDefs = [primary, { icon: 'more', round: true, label: 'Options', run: (el) => gameOptions(findGame(g.id) || g, el) }];
    if (this.dlMode === 'active' && dl.status === 'paused' && isInstalled(g)) this.actionDefs.splice(1, 0, { label: 'Play', icon: 'play', run: (el) => launchGame(findGame(g.id) || g, { from: el }) });

    const shots = g.screenshots || [];
    const m = g.meta || {};
    this.cardDefs = [
      {
        cls: 'card-progress',
        html: `
          <div class="card-head">${icon('trophy')}<span>${t('Your Activity')}</span></div>
          <div class="stats3">
            <div><b>${pt ? fmtPlaytime(pt) : '—'}</b><span>${t('Play time')}</span></div>
            <div><b>${lastActive(g) ? escapeHtml(shortAgo(lastActive(g))) : '—'}</b><span>${t('Last played')}</span></div>
            <div><b>${g.launchCount || 0}</b><span>${t('Launches')}</span></div>
          </div>
          <div class="card-foot">${escapeHtml(t('Added {date}', { date: fmtDate(g.addedAt) }))}</div>`,
        run: (el) => launchGame(findGame(g.id) || g, { from: el }),
      },
      {
        cls: 'card-about',
        html: `
          <div class="card-head">${icon('info')}<span>${t('About')}</span></div>
          <div class="about-text">${escapeHtml(m.description || 'No description available yet. Use Options › Change Artwork › Find on Steam to match this game.')}</div>
          <div class="card-foot">${escapeHtml([m.developer, m.released ? new Date(m.released).getFullYear() : ''].filter(Boolean).join(' · '))}</div>`,
        run: () => this.showDetails(g),
      },
    ];
    if (shots.length) {
      this.cardDefs.push({
        cls: 'card-media',
        html: `
          <div class="card-head">${icon('camera')}<span>${t('Screenshots')}</span><em>${shots.length}</em></div>
          <div class="shots">${shots
            .slice(0, 4)
            .map((s) => `<div class="shot" style="background-image:url('${s.thumb}')"></div>`)
            .join('')}</div>`,
        run: () => screenshotViewer(shots, 0),
      });
    }
    this.cardDefs.push({
      cls: 'card-details',
      html: `
        <div class="card-head">${icon('folder')}<span>${t('Game Details')}</span></div>
        <dl class="kv">
          <dt>${t('Source')}</dt><dd>${escapeHtml(sourceName(g))}</dd>
          ${m.publisher ? `<dt>${t('Publisher')}</dt><dd>${escapeHtml(m.publisher)}</dd>` : ''}
          ${m.released ? `<dt>${t('Released')}</dt><dd>${escapeHtml(fmtDate(m.released))}</dd>` : ''}
          ${g.sizeOnDisk ? `<dt>${t('Size')}</dt><dd>${escapeHtml(fmtBytes(g.sizeOnDisk))}</dd>` : ''}
          ${g.steamAppId ? `<dt>${t('Steam App')}</dt><dd>${escapeHtml(g.steamAppId)}</dd>` : ''}
        </dl>
        ${isInstalled(g) ? `<div class="card-foot">${icon('external')} ${t('Open file location')}</div>` : ''}`,
      run: () => (isInstalled(g) ? showGameLocation(g) : this.showDetails(g)),
    });
  }

  buildLibrary() {
    const games = gamesIn('game');
    const media = gamesIn('media');
    this.main.append(
      h('div', { class: 'hub-logo-wrap' }, h('div', { class: 'hub-title big', text: t('Game Library') })),
      h('div', { class: 'hub-desc', text: t(games.length === 1 ? '1 game' : '{n} games', { n: games.length }) + (media.length ? ` · ${t(media.length === 1 ? '1 media app' : '{n} media apps', { n: media.length })}` : '') + ` ${t('in your collection')}` })
    );
    this.actionDefs = [
      { label: 'Open Library', icon: 'library', primary: true, run: () => this.host.openView('library', { tab: 'game' }) },
      { label: 'Add Games', icon: 'plus', run: (el) => addGamesMenu(el) },
    ];
    const recent = sortGames(games, 'added').slice(0, 4);
    this.cardDefs = [];
    if (recent.length) {
      this.cardDefs.push({
        cls: 'card-recent',
        build: () => {
          const wrap = h('div', {}, h('div', { class: 'card-head', html: `${icon('sparkle')}<span>${t('Recently Added')}</span>` }));
          const row = h('div', { class: 'mini-tiles' });
          for (const g of recent) row.append(h('div', { class: 'mini-tile' }, tileArt(g)));
          wrap.append(row);
          return wrap;
        },
        run: () => this.host.openView('library', { tab: 'game', sort: 'added' }),
      });
    }
    this.cardDefs.push(
      {
        cls: 'card-action',
        html: `<div class="card-head">${icon('folderPlus')}<span>${t('Add a Game Folder')}</span></div><div class="about-text">${t('Pick a folder with game shortcuts (.lnk, .url, .exe). Artwork is fetched from Steam automatically.')}</div>`,
        run: () => addGameFolder(),
      },
      {
        cls: 'card-action',
        html: `<div class="card-head">${icon('refresh')}<span>${t('Scan for Games')}</span></div><div class="about-text">${t('Look for new games in Steam, Epic Games and your folders.')}</div>`,
        run: () => api.scan(),
      }
    );
  }

  /** Explore: no buttons or cards, its widgets instead (ui/explore.js). */
  buildExplore(animate) {
    this.actionDefs = [];
    this.cardDefs = [];
    if (!this.explore) return;
    this.explore.refresh();
    if (animate) {
      this.explore.el.classList.remove('enter');
      void this.explore.el.offsetWidth;
      this.explore.el.classList.add('enter');
    }
  }

  buildNowPlaying() {
    const m = sys.media || {};
    const cover = sys.art ? h('img', { class: 'np-cover', src: sys.art, alt: '' }) : h('div', { class: 'np-cover empty', html: icon('music') });
    this.main.append(
      h(
        'div',
        { class: 'hub-logo-wrap np-head' },
        cover,
        h(
          'div',
          { class: 'np-text' },
          h('div', { class: 'np-app', text: `${appName(m.app)} · ${t(m.status === 'Playing' ? 'Now playing' : m.status || '')}` }),
          h('div', { class: 'np-title', text: m.title || 'Unknown title' }),
          h('div', { class: 'np-artist', text: [m.artist, m.album].filter(Boolean).join(' · ') })
        )
      ),
      h('div', { class: 'np-progress' }, h('span', { class: 'np-t0' }), h('div', { class: 'np-bar', html: sliderHtml(0, 'thin') }), h('span', { class: 'np-t1' }))
    );
    const bar = this.main.querySelector('.np-bar');
    dragSlider(bar, (p) => {
      const cur = sys.media;
      if (!cur || !cur.canSeek || !(cur.duration > 0)) return;
      const sec = (p / 100) * cur.duration;
      seekLocal(sec);
      this.tickNowPlaying();
      clearTimeout(this.seekTimer);
      this.seekTimer = setTimeout(() => mediaCommand('seek', Math.round(sec)), 120);
    });
    const playing = m.status === 'Playing';
    this.actionDefs = [
      { label: playing ? 'Pause' : 'Play', icon: playing ? 'pause' : 'play', primary: true, withIcon: true, run: () => mediaCommand('toggle') },
      { icon: 'skipPrev', round: true, label: 'Previous', run: () => mediaCommand('prev') },
      { icon: 'skipNext', round: true, label: 'Next', run: () => mediaCommand('next') },
    ];
    const sessions = (m.sessions || []).filter((x) => x.app);
    if (sessions.length > 1) {
      this.actionDefs.push({
        icon: 'refresh',
        label: 'Switch Source',
        run: () => {
          const i = sessions.findIndex((x) => x.app === m.app);
          const next = sessions[(i + 1) % sessions.length];
          if (next) selectSession(next.app);
        },
      });
    }
    this.cardDefs = [];
    this.tickNowPlaying();
  }

  tickNowPlaying() {
    if (!this.item || this.item.type !== 'nowplaying') return;
    const m = sys.media;
    if (!m || !m.active) return;
    // Playback changes update existing controls so tab-entry animations keep running.
    const playing = m.status === 'Playing';
    const label = playing ? 'Pause' : 'Play';
    const app = this.main.querySelector('.np-app');
    if (app) app.textContent = `${appName(m.app)} · ${t(playing ? 'Now playing' : m.status || '')}`;
    const action = this.actionDefs[0];
    if (action) {
      action.label = label;
      action.icon = playing ? 'pause' : 'play';
      const button = this.main.querySelector('.hub-actions .hub-btn.primary');
      if (button && button.title !== t(label)) {
        button.title = t(label);
        button.innerHTML = `${icon(action.icon)}<span>${escapeHtml(t(label))}</span>`;
      }
    }
    const pos = mediaPosition();
    setSlider(this.main.querySelector('.np-bar'), m.duration > 0 ? (pos / m.duration) * 100 : 0);
    const t0 = this.main.querySelector('.np-t0');
    const t1 = this.main.querySelector('.np-t1');
    if (t0) t0.textContent = fmtTime(pos);
    if (t1) t1.textContent = m.duration > 0 ? fmtTime(m.duration) : '';
  }

  buildMediaEmpty() {
    this.main.append(
      h('div', { class: 'hub-logo-wrap' }, h('div', { class: 'hub-title big', text: t('Media') })),
      h('div', {
        class: 'hub-desc',
        text: t('Keep apps like music, video and streaming services here. Open the options menu on any entry and choose “Move to Media”.'),
      })
    );
    this.actionDefs = [{ label: 'Open Library', icon: 'library', primary: true, run: () => this.host.openView('library', { tab: 'media' }) }];
    this.cardDefs = [];
  }

  buildWelcome() {
    this.main.append(
      h('div', { class: 'hub-logo-wrap' }, h('div', { class: 'hub-title big', text: t('Welcome') })),
      h('div', {
        class: 'hub-desc',
        text: t('Add your games to get started. Choose a folder that contains game shortcuts, or scan Steam and Epic Games. Banners, hero art and logos are downloaded automatically.'),
      })
    );
    this.actionDefs = [
      { label: 'Add Game Folder', icon: 'folderPlus', primary: true, run: () => addGameFolder() },
      { label: 'Scan for Games', icon: 'refresh', run: () => api.scan() },
    ];
    this.cardDefs = [];
  }

  /* ---------------------------------------------------------------- */

  renderActions(keep = 0) {
    const row = h('div', { class: 'hub-actions' });
    const els = this.actionDefs.map((a, i) => {
      const el = h('button', {
        class: `hub-btn${a.primary ? ' primary' : ''}${a.round ? ' round' : ''} fx`,
        html: `${a.round ? icon(a.icon) : `${a.primary && !a.withIcon ? '' : icon(a.icon)}<span>${escapeHtml(t(a.label))}</span>`}`,
        title: t(a.label),
        onmouseenter: () => mouseActive() && this.host.onFocusRequest('actions', i, 'hover'),
        onclick: () => {
          this.host.onFocusRequest('actions', i, 'click');
          this.activateAction(i);
        },
      });
      return el;
    });
    row.append(...els);
    this.main.append(row);
    if (this.item && this.item.type === 'game') {
      this.main.append(
        h('div', { class: 'hub-dl' }, h('div', { class: 'hdl-text' }, h('span', { class: 'hdl-state' }), h('span', { class: 'hdl-info' })), h('div', { class: 'hdl-bar' }, h('i')))
      );
      this.paintDownload(downloadFor(findGame(this.item.game.id) || this.item.game));
    }
    const wasFocused = this.actions.current && this.actions.current.classList.contains('focused');
    this.actions = new FocusList(els, { index: Math.min(Math.max(keep, 0), els.length - 1) });
    if (!wasFocused) this.actions.blur();
  }

  renderCards(keepScroll = false) {
    const els = this.cardDefs.map((c, i) => {
      const el = h('button', {
        class: `hub-card fx ${c.cls || ''}`,
        html: c.html || '',
        onmouseenter: () => mouseActive() && this.host.onFocusRequest('cards', i, 'hover'),
        onclick: () => {
          this.host.onFocusRequest('cards', i, 'click');
          this.activateCard(i);
        },
      });
      if (c.build) el.append(c.build());
      el.style.animationDelay = `${0.05 * i}s`;
      return el;
    });
    this.cardsTrack.append(...els);
    this.cards.classList.toggle('empty', !els.length);
    const wasFocused = this.cardNav.current && this.cardNav.current.classList.contains('focused');
    const keepIdx = keepScroll && this.cardNav.index > 0 ? this.cardNav.index : 0;
    this.cardNav = new FocusList(els, { index: Math.min(keepIdx, Math.max(0, els.length - 1)), onChange: (el) => this.scrollCards(el) });
    if (!wasFocused) this.cardNav.blur();
    if (!keepScroll) this.cardsTrack.style.transform = '';
    else if (this.cardNav.current) this.scrollCards(this.cardNav.current);
  }

  scrollCards(el) {
    if (!el) return;
    const vw = this.cards.clientWidth;
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    const cur = -(parseFloat((this.cardsTrack.style.transform.match(/-?[\d.]+/) || [0])[0]) || 0);
    let next = cur;
    const pad = vw * 0.09;
    if (right - cur > vw - pad) next = right - vw + pad;
    if (left - cur < pad) next = Math.max(0, left - pad);
    this.cardsTrack.style.transform = `translateX(${-next}px)`;
  }

  /** from: what was pressed instead of the button (a game's cover on the home screen). */
  activateAction(i, from = null) {
    const a = this.actionDefs[i];
    if (a && a.run) a.run(from || this.actions.els[i]);
  }

  activateCard(i) {
    const c = this.cardDefs[i];
    if (c && c.run) c.run(this.cardNav.els[i]);
  }

  hasCards() {
    return this.cardDefs.length > 0;
  }

  showDetails(g) {
    const m = g.meta || {};
    const rows = [
      ['Developer', m.developer],
      ['Publisher', m.publisher],
      ['Franchise', m.franchise],
      ['Released', m.released ? fmtDate(m.released) : ''],
      ['Source', sourceName(g)],
      ['Steam App ID', g.steamAppId],
      ['Title ID', g.titleId],
      ['Install folder', g.installDir],
      [g.source === 'emulator' ? 'Game File' : 'Shortcut', g.path],
      ['Launch', g.launch ? g.launch.target : ''],
    ].filter(([, v]) => v);
    infoDialog({
      title: g.name,
      html: `${m.description ? `<p>${escapeHtml(m.description)}</p>` : ''}<dl class="kv big">${rows.map(([k, v]) => `<dt>${escapeHtml(t(k))}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`,
    });
  }
}

function shortAgo(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days < 1) return t('Today');
  if (days === 1) return t('Yesterday');
  if (days < 30) return t('{n}d ago', { n: days });
  return new Date(ts).toLocaleDateString(language(), { month: 'short', day: 'numeric' });
}

export async function addGamesMenu(anchor, beforeBrowse = () => {}) {
  const { optionsMenu } = await import('./dialogs.js');
  return optionsMenu({
    title: 'Add Games',
    anchor,
    items: [
      { label: 'Add Game Folder…', icon: 'folderPlus', run: () => { beforeBrowse(); return addGameFolder(); } },
      { label: 'Add Games from Files…', icon: 'file', run: () => { beforeBrowse(); return addGameFiles(); } },
      { label: 'Scan for Games Now', icon: 'refresh', run: () => api.scan() },
    ],
  });
}

export { timeAgo };
