// The "game hub" content shown under the carousel (and in the stand-alone hub
// view): logo, description, Play / options buttons and activity cards.

import { h, escapeHtml, fmtPlaytime, timeAgo, fmtDate, fmtBytes } from '../util.js';
import { icon } from '../icons.js';
import { api, artUrl, state, playtimeOf, lastActive, sourceLabel, sourceName, gamesIn, sortGames, findGame } from '../state.js';
import { FocusList } from './overlay.js';
import { mouseActive } from '../input.js';
import { launchGame, gameOptions, isRunning } from './gameactions.js';
import { screenshotViewer, infoDialog } from './dialogs.js';
import { tileArt } from './tiles.js';
import { sliderHtml, setSlider, dragSlider } from './slider.js';
import { sys, mediaCommand, mediaPosition, seekLocal, selectSession, appName, fmtTime } from '../system.js';
import { t, language } from '../i18n.js';

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
    this.el = h('div', { class: 'hub' }, this.main, this.cards);
    this.actions = new FocusList([]);
    this.cardNav = new FocusList([], { onChange: (el) => this.scrollCards(el) });
    this.actionDefs = [];
    this.cardDefs = [];
  }

  /** item: { type: 'game'|'library'|'store'|'add', game? } */
  setItem(item, { animate = true } = {}) {
    const sameItem = !!(this.item && item && this.item.key && this.item.key === item.key);
    this.item = item;
    const keepAction = this.actions.index;
    this.main.innerHTML = '';
    this.cardsTrack.innerHTML = '';
    if (!item) return;
    if (item.type === 'game') this.buildGame(item.game);
    else if (item.type === 'library') this.buildLibrary();
    else if (item.type === 'store') this.buildStore();
    else if (item.type === 'media-empty') this.buildMediaEmpty();
    else if (item.type === 'nowplaying') this.buildNowPlaying();
    else this.buildWelcome();

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
    const titleEl = logo
      ? h('img', { class: 'hub-logo', src: logo, alt: g.name, onerror: (e) => e.target.replaceWith(h('div', { class: 'hub-title', text: g.name })) })
      : h('div', { class: 'hub-title', text: g.name });
    const pt = playtimeOf(g);
    this.main.append(
      h('div', { class: 'hub-logo-wrap' }, titleEl),
      desc ? h('div', { class: 'hub-desc', text: desc }) : h('div', { class: 'hub-desc dim', text: g.metaStatus === 'pending' ? 'Fetching artwork and details…' : '' }),
      h(
        'div',
        { class: 'hub-stats' },
        running ? h('div', { class: 'pill running', html: `<i class="dot"></i>Running` }) : null,
        h('div', { class: 'pill', html: `${icon('tag')}<span>${escapeHtml(sourceLabel(g))}</span>` }),
        pt ? h('div', { class: 'pill', html: `${icon('clock')}<span>${fmtPlaytime(pt)}</span>` }) : null
      )
    );
    this.actionDefs = [
      { label: running ? 'Continue' : 'Play Game', icon: 'play', primary: true, run: () => launchGame(findGame(g.id) || g) },
      { icon: 'more', round: true, label: 'Options', run: (el) => gameOptions(findGame(g.id) || g, el) },
    ];

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
        run: () => launchGame(findGame(g.id) || g),
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
        <div class="card-foot">${icon('external')} ${t('Open file location')}</div>`,
      run: () => api.openLocation(g.id),
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
      { label: 'Open Library', icon: 'library', primary: true, run: () => this.host.openView('library') },
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
        run: () => this.host.openView('library', { sort: 'added' }),
      });
    }
    this.cardDefs.push(
      {
        cls: 'card-action',
        html: `<div class="card-head">${icon('folderPlus')}<span>${t('Add a Game Folder')}</span></div><div class="about-text">${t('Pick a folder with game shortcuts (.lnk, .url, .exe). Artwork is fetched from Steam automatically.')}</div>`,
        run: () => api.addFolder(),
      },
      {
        cls: 'card-action',
        html: `<div class="card-head">${icon('refresh')}<span>${t('Scan for Games')}</span></div><div class="about-text">${t('Look for new games in Steam, Epic Games and your folders.')}</div>`,
        run: () => api.scan(),
      }
    );
  }

  buildStore() {
    this.main.append(
      h('div', { class: 'hub-logo-wrap' }, h('div', { class: 'hub-title big', text: t('Steam Store') })),
      h('div', { class: 'hub-desc', text: t('Browse new releases, deals and your wishlist in the Steam client.') })
    );
    this.actionDefs = [
      { label: 'Open Store', icon: 'bag', primary: true, run: () => api.openExternal('steam://store') },
      { label: 'Wishlist', icon: 'star', run: () => api.openExternal('steam://openurl/https://store.steampowered.com/wishlist/') },
    ];
    this.cardDefs = [];
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
    this.actionDefs = [{ label: 'Open Library', icon: 'library', primary: true, run: () => this.host.openView('library', { tab: 'game' }) }];
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
      { label: 'Add Game Folder', icon: 'folderPlus', primary: true, run: () => api.addFolder() },
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

  activateAction(i) {
    const a = this.actionDefs[i];
    if (a && a.run) a.run(this.actions.els[i]);
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
      ['Install folder', g.installDir],
      ['Shortcut', g.path],
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

export async function addGamesMenu(anchor) {
  const { optionsMenu } = await import('./dialogs.js');
  return optionsMenu({
    title: 'Add Games',
    anchor,
    items: [
      { label: 'Add Game Folder…', icon: 'folderPlus', run: () => api.addFolder() },
      { label: 'Add Games from Files…', icon: 'file', run: () => api.addFiles() },
      { label: 'Scan for Games Now', icon: 'refresh', run: () => api.scan() },
    ],
  });
}

export { timeAgo };
