/**
 * The focus shine (.fx::after, see base.css) is a CSS animation that only
 * runs while its element is focused, so losing focus mid-sweep would make
 * the light vanish in one frame. This lets it finish fading instead: it
 * notes when each element starts shining and, if focus leaves during a
 * sweep, carries the band on from where it was while it fades out, as the
 * ring does. While the animation is paused (behind a dimmed app) it notes
 * where it was held instead.
 */

// Keep in step with the glint animation in base.css.
const DELAY = 1500;
const PERIOD = 5000;
const SWEEP = 1500;
const FROM = 150;
const TO = -50;
const FADE = 250;

// Each shining element: { since: when its sweep cycle started, held: how far
// along its paused animation is held (or null), anim: the animation }.
const started = new Map();

/** Brings an element's entry up to date with its animation. */
function sync(entry) {
  const a = entry.anim;
  if (!a || a.playState === 'idle') return;
  if (a.playState === 'paused') entry.held = a.currentTime;
  else if (a.startTime !== null) {
    entry.since = a.startTime;
    entry.held = null;
  }
}

// The elements the glint animation runs on (the .fx::after rules in base.css).
const SHINES = '.fx.focused, .focused > .fx, .fx.sel:not(.tile)';

/** The element that may draw the shine for an element whose class changed. */
function hostOf(el) {
  return el.classList.contains('fx') ? el : el.querySelector(':scope > .fx');
}

const at = (t) => `${FROM + ((TO - FROM) * t) / SWEEP}% 0`;

function fadeOut(host, { since, held }) {
  if (document.body.classList.contains('reduce-motion')) return;
  const t = ((held ?? document.timeline.currentTime - since) - DELAY) % PERIOD;
  if (!(t >= 0 && t < SWEEP)) return;
  const end = Math.min(SWEEP, t + FADE);
  host.animate(
    [
      { backgroundPosition: at(t), opacity: 1 },
      { backgroundPosition: at(end), opacity: 0 },
    ],
    { duration: FADE, pseudoElement: '::after' },
  );
}

/** Watches focus changes. Call once. */
export function initGlintFade(root = document.body) {
  new MutationObserver((records) => {
    const now = document.timeline.currentTime;
    const seen = new Set();
    for (const m of records) {
      const host = hostOf(m.target);
      if (!host || seen.has(host)) continue;
      seen.add(host);
      const shines = host.matches(SHINES);
      if (shines && !started.has(host)) {
        const entry = { since: now, held: null, anim: null };
        started.set(host, entry);
        // Use the animation's own start once the browser has started it.
        requestAnimationFrame(() => {
          if (started.get(host) !== entry) return;
          entry.anim = host.getAnimations({ subtree: true }).find((x) => x.animationName === 'glint' && x.effect && x.effect.target === host) || null;
          if (entry.anim) entry.anim.ready.then(() => sync(entry)).catch(() => {});
        });
      }
      else if (!shines && started.has(host)) {
        fadeOut(host, started.get(host));
        started.delete(host);
      }
    }
    // A class change elsewhere (the app dimming behind the quick menu) can
    // pause or resume the shines: note it once the styles have caught up.
    requestAnimationFrame(() => {
      for (const [host, entry] of started) {
        if (!host.isConnected) {
          started.delete(host);
          continue;
        }
        sync(entry);
        if (entry.anim) entry.anim.ready.then(() => sync(entry)).catch(() => {});
      }
    });
  }).observe(root, { subtree: true, attributes: true, attributeFilter: ['class'] });
}
