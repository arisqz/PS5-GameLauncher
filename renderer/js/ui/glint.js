/**
 * The focus shine (.fx::after, see base.css) is a CSS animation that only
 * runs while its element is focused, so losing focus mid-sweep would make
 * the light vanish in one frame. This lets it finish fading instead: it
 * notes when each element starts shining and, if focus leaves during a
 * sweep, carries the band on from where it was while it fades out, as the
 * ring does.
 */

// Keep in step with the glint animation in base.css.
const DELAY = 1500;
const PERIOD = 5000;
const SWEEP = 1500;
const FROM = 150;
const TO = -50;
const FADE = 250;

const started = new WeakMap();

// The elements the glint animation runs on (the .fx::after rules in base.css).
const SHINES = '.fx.focused, .focused > .fx, .fx.sel:not(.tile)';

/** The element that may draw the shine for an element whose class changed. */
function hostOf(el) {
  return el.classList.contains('fx') ? el : el.querySelector(':scope > .fx');
}

const at = (t) => `${FROM + ((TO - FROM) * t) / SWEEP}% 0`;

function fadeOut(host, since) {
  if (document.body.classList.contains('reduce-motion')) return;
  const t = (document.timeline.currentTime - since - DELAY) % PERIOD;
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
        started.set(host, now);
        // Use the animation's own start once the browser has started it.
        requestAnimationFrame(() => {
          const a = host.getAnimations({ subtree: true }).find((x) => x.animationName === 'glint' && x.effect && x.effect.target === host);
          if (!a) return;
          a.ready
            .then(() => {
              if (a.startTime !== null && started.has(host)) started.set(host, a.startTime);
            })
            .catch(() => {});
        });
      }
      else if (!shines && started.has(host)) {
        fadeOut(host, started.get(host));
        started.delete(host);
      }
    }
  }).observe(root, { subtree: true, attributes: true, attributeFilter: ['class'] });
}
