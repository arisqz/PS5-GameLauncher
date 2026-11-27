// Full-screen hero artwork with cross-fades and tint extraction.

import { background } from '../background.js';

const root = document.getElementById('hero-bg');
const layers = [...root.querySelectorAll('.hero-layer')];
let active = 0;
let current = null;
let currentBlur = false;
let token = 0;
const tintCache = new Map();
const appEl = document.getElementById('app');

// The colour is read from a 24 × 12 copy made off the main thread: drawing the
// full picture (3840 × 1240 for a Steam hero) onto a canvas decoded it right
// there, freezing the screen for up to half a second the first time each game
// was selected.
async function extractTint(img) {
  try {
    const small = await createImageBitmap(img, { resizeWidth: 24, resizeHeight: 12, resizeQuality: 'low' });
    const c = document.createElement('canvas');
    c.width = 24;
    c.height = 12;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(small, 0, 0);
    small.close();
    const d = x.getImageData(0, 0, 24, 12).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const w = 1 + (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])) / 40;
      r += d[i] * w;
      g += d[i + 1] * w;
      b += d[i + 2] * w;
      n += w;
    }
    // Darken for use under text.
    const k = 0.38;
    return `${Math.round((r / n) * k)}, ${Math.round((g / n) * k)}, ${Math.round((b / n) * k)}`;
  } catch {
    return null;
  }
}

function load(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onerror = () => resolve(null);
    img.src = url;
    // Decoded off the main thread before it's shown, so the fade doesn't wait on it.
    img.decode().then(
      () => resolve(img),
      () => resolve(img.complete && img.naturalWidth ? img : null)
    );
  });
}

/** The picture as a canvas at about the screen's size (it drifts at up to 1.09×, so a little more). */
async function heroCanvas(img) {
  const want = Math.round(Math.min(img.naturalWidth, window.innerWidth * Math.min(window.devicePixelRatio || 1, 2) * 1.12));
  const h = Math.max(1, Math.round((img.naturalHeight * want) / img.naturalWidth));
  const c = document.createElement('canvas');
  c.className = 'hero-img';
  try {
    const bmp = await createImageBitmap(img, { resizeWidth: want, resizeHeight: h, resizeQuality: 'high' });
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    return c;
  } catch {
    img.className = 'hero-img';
    img.alt = '';
    return img;
  }
}

export const heroBg = {
  async set(url, { blur = false } = {}) {
    blur = !!blur;
    if (url === current && blur === currentBlur) return;
    current = url;
    currentBlur = blur;
    const my = ++token;
    if (!url) {
      layers.forEach((l) => l.classList.remove('show'));
      root.classList.remove('has-image');
      background.setVisible(true);
      return;
    }
    const img = await load(url);
    if (my !== token) return;
    if (!img) {
      layers.forEach((l) => l.classList.remove('show'));
      root.classList.remove('has-image');
      background.setVisible(true);
      return;
    }
    if (!tintCache.has(url)) tintCache.set(url, await extractTint(img));
    if (my !== token) return;
    const tint = tintCache.get(url);
    if (tint) appEl.style.setProperty('--tint', tint);

    const next = layers[active ^ 1];
    const prev = layers[active];
    // On screen as a canvas, decoded (off the main thread) and scaled to the
    // screen beforehand. An <img> or CSS background is decoded again by the
    // compositor the first time it's drawn, and the frame waits for it: a
    // 3840 × 1240 PNG hero (Fortnite's) held one for 210 ms (startup trace).
    const pic = await heroCanvas(img);
    if (my !== token) return;
    next.replaceChildren(pic);
    // Keep each image's treatment through its entire fade, including hide().
    next.classList.toggle('blur-art', blur);
    // Restart only the incoming layer. The outgoing layer keeps its drift
    // while opacity fades, so it never snaps back to its unscaled artwork.
    next.classList.remove('show', 'drifting');
    void next.offsetWidth;
    next.classList.add('show', 'drifting');
    prev.classList.remove('show');
    active ^= 1;
    root.classList.add('has-image');
    // The canvas is fully covered once the fade finishes.
    setTimeout(() => {
      if (my === token && current) background.setVisible(false);
    }, 900);
  },
  deep(on) {
    root.classList.toggle('deep', !!on);
  },
  hide() {
    this.set(null);
    this.deep(false);
  },
  setMotion(on) {
    root.classList.toggle('hero-motion', !!on);
  },
};
