// Full-screen hero artwork with cross-fades and tint extraction.

import { background } from '../background.js';

const root = document.getElementById('hero-bg');
const layers = [...root.querySelectorAll('.hero-layer')];
let active = 0;
let current = null;
let token = 0;
const tintCache = new Map();
const appEl = document.getElementById('app');

function extractTint(img) {
  try {
    const c = document.createElement('canvas');
    c.width = 24;
    c.height = 12;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, 24, 12);
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
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export const heroBg = {
  async set(url, { blur = false } = {}) {
    root.classList.toggle('blur-art', !!blur);
    if (url === current) return;
    current = url;
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
    if (!tintCache.has(url)) tintCache.set(url, extractTint(img));
    const tint = tintCache.get(url);
    if (tint) appEl.style.setProperty('--tint', tint);

    const next = layers[active ^ 1];
    const prev = layers[active];
    next.style.backgroundImage = `url("${url}")`;
    next.classList.remove('show');
    void next.offsetWidth;
    next.classList.add('show');
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
    root.classList.remove('blur-art');
    this.deep(false);
  },
  setMotion(on) {
    root.classList.toggle('hero-motion', !!on);
  },
};
