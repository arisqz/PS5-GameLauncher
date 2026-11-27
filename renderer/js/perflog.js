// Hitch log: every frame that takes 100 ms or more (a visible stutter) goes to
// logs\hitches.log in the launcher's data folder, with what was on screen, the
// last button pressed and, from Chromium's long-animation-frame timing, which
// code ran in that frame and how long style, layout and painting took.
// main/main.js writes the file and adds the main process's own stalls.

import { api } from './state.js';
import { lastAction } from './input.js';

const LIMIT = 100; // ms

let router = null;
let started = 0;

/** What the screen showed, in a few words. */
function where() {
  const v = router && router.current;
  if (!v) return 'boot';
  let s = v.name;
  if (v.name === 'home') {
    const it = v.items && v.items[v.sel];
    s += ` · ${v.zone} · ${it ? (it.game ? it.game.name : it.type) : '-'}`;
  } else if (v.name === 'settings' && v.cat) s += ` · ${v.cat.id}`;
  if (document.querySelector('.overlay.setup')) s += ' · setup';
  else if (document.querySelector('#overlays > .overlay')) s += ' · overlay open';
  return s;
}

function send(entry) {
  // The window's first frames (loading the page) are slow by nature.
  if (performance.now() - started < 3000) return;
  const a = lastAction();
  entry.screen = where();
  entry.input = a.action ? `${a.action} ${Math.round(performance.now() - a.at)} ms before` : '';
  entry.uptime = Math.round((performance.now() - started) / 1000);
  api.perfHitch(entry).catch(() => {});
}

export function startHitchLog(r) {
  router = r;
  started = performance.now();
  if (!api.perfHitch) return;
  try {
    new PerformanceObserver((list) => {
      if (document.visibilityState !== 'visible') return;
      for (const e of list.getEntries()) {
        if (e.duration < LIMIT) continue;
        const end = e.startTime + e.duration;
        send({
          kind: 'frame',
          ms: Math.round(e.duration),
          blocking: Math.round(e.blockingDuration || 0),
          // Rendering after the scripts: style and layout, then paint (images decoded, layers drawn).
          styleLayout: e.styleAndLayoutStart ? Math.round(end - e.styleAndLayoutStart) : 0,
          render: e.renderStart ? Math.round(end - e.renderStart) : 0,
          scripts: (e.scripts || [])
            .filter((s) => s.duration >= 5)
            .sort((x, y) => y.duration - x.duration)
            .slice(0, 5)
            .map((s) => `${Math.round(s.duration)} ms ${s.invoker || ''} ${s.sourceFunctionName || ''} ${(s.sourceURL || '').split('/').pop()}:${s.sourceCharPosition}${s.forcedStyleAndLayoutDuration > 1 ? ` (forced layout ${Math.round(s.forcedStyleAndLayoutDuration)} ms)` : ''}`.replace(/\s+/g, ' ')),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch {
    // Without long-animation-frame timing: frames that came late, timed here.
    let last = performance.now();
    const tick = (now) => {
      if (now - last >= LIMIT && document.visibilityState === 'visible') send({ kind: 'frame', ms: Math.round(now - last) });
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
