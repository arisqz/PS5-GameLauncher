// The dark "stage" behind the welcome screen: a spotlight from the upper left,
// a hazy floor, and warm bokeh particles drifting along a diagonal band (the
// PS5 user-select backdrop). It sits between the hero art and the views, so
// fading it out reveals the home screen's hero underneath.

import { h } from '../util.js';

const COLORS = [
  [255, 168, 72], // gold
  [255, 196, 118], // pale gold
  [255, 232, 196], // warm white
];

function sprite(rgb, soft) {
  const size = 96;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const [r, gg, b] = rgb;
  if (soft) {
    // Out-of-focus disc: an even body that softens towards the edge.
    g.addColorStop(0, `rgba(${r},${gg},${b},0.9)`);
    g.addColorStop(0.5, `rgba(${r},${gg},${b},0.82)`);
    g.addColorStop(0.75, `rgba(${r},${gg},${b},0.5)`);
    g.addColorStop(0.92, `rgba(${r},${gg},${b},0.12)`);
    g.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  } else {
    // In-focus speck: bright core with a small glow.
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, `rgba(${r},${gg},${b},0.95)`);
    g.addColorStop(0.42, `rgba(${r},${gg},${b},0.22)`);
    g.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  }
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  return c;
}

function gauss() {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
}

export class BootStage {
  constructor() {
    this.canvas = h('canvas', { class: 'bs-particles' });
    this.el = h(
      'div',
      { class: 'boot-stage' },
      h('div', { class: 'bs-base' }),
      h('div', { class: 'bs-beam' }, h('div', { class: 'bs-shafts' })),
      h('div', { class: 'bs-source' }),
      h('div', { class: 'bs-floor' }),
      this.canvas,
      h('div', { class: 'bs-black' })
    );
    this.ctx = this.canvas.getContext('2d');
    this.sprites = { soft: COLORS.map((c) => sprite(c, true)), sharp: COLORS.map((c) => sprite(c, false)) };
    this.parts = [];
    this.raf = 0;
    this.last = 0;
    this.onResize = () => this.resize();
  }

  mount() {
    const app = document.getElementById('app');
    app.insertBefore(this.el, document.getElementById('views'));
    window.addEventListener('resize', this.onResize);
    this.resize();
    this.last = performance.now();
    const loop = (now) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.draw(dt, now / 1000);
    };
    this.raf = requestAnimationFrame(loop);
    // Fade in from black.
    requestAnimationFrame(() => this.el.classList.add('lit'));
    return this;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const r = this.el.getBoundingClientRect();
    this.W = Math.max(2, Math.round(r.width * dpr));
    this.H = Math.max(2, Math.round(r.height * dpr));
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.unit = this.H / 1080; // sizes below are in 1080p pixels
    const area = (this.W * this.H) / (1920 * 1080 * dpr * dpr);
    const n = Math.round(460 * Math.max(0.6, Math.min(1.6, area)));
    this.parts = Array.from({ length: n }, () => this.spawn(true));
  }

  /**
   * A particle somewhere along the band that runs from the lower left up to
   * the right, denser towards the right. Particles live for a while, fade
   * out and come back somewhere else, so the band keeps its shape.
   */
  spawn(first) {
    const { W, H, unit } = this;
    const layer = Math.random();
    // 0 = far specks, 1 = mid, 2 = near bokeh
    const depth = layer < 0.64 ? 0 : layer < 0.88 ? 1 : 2;
    const x = W * (depth === 2 ? Math.random() : Math.pow(Math.random(), 0.62));
    const t = x / W;
    const center = H * (0.9 - 0.42 * t);
    const spread = H * (0.045 + 0.085 * t) * (depth === 2 ? 1.7 : 1);
    let y = center + gauss() * spread * 1.7;
    // A few strays outside the band.
    if (Math.random() < 0.06) y = H * (0.3 + Math.random() * 0.7);
    // A few bright sparkles among the far specks.
    const sparkle = depth === 0 && Math.random() < 0.05;
    const size = sparkle ? 6 + Math.random() * 4 : depth === 0 ? 2 + Math.random() * 4 : depth === 1 ? 5 + Math.random() * 9 : 16 + Math.random() * 34;
    return {
      x,
      y,
      depth,
      soft: depth === 2 || (depth === 1 && Math.random() < 0.6),
      color: sparkle ? 2 : Math.random() < 0.5 ? 0 : Math.random() < 0.7 ? 1 : 2,
      size: size * unit,
      vx: (depth === 0 ? 5 : depth === 1 ? 9 : 16) * unit * (0.6 + Math.random() * 0.8),
      vy: -(depth === 0 ? 1.2 : depth === 1 ? 2 : 3.5) * unit * (0.4 + Math.random()),
      alpha: depth === 0 ? 0.45 + Math.random() * 0.55 : depth === 1 ? 0.28 + Math.random() * 0.45 : 0.1 + Math.random() * 0.2,
      tw: 0.4 + Math.random() * 1.6,
      ph: Math.random() * Math.PI * 2,
      age: first ? Math.random() * 8 : 0,
      ttl: 7 + Math.random() * 10,
    };
  }

  draw(dt, t) {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.parts.length; i++) {
      let p = this.parts[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt + Math.sin(t * 0.5 + p.ph) * 0.15 * this.unit;
      p.age += dt;
      if (p.age > p.ttl || p.x - p.size > W || p.y + p.size < 0) {
        p = this.parts[i] = this.spawn(false);
      }
      // Fade in over 1.5 s, out over the last 1.5 s.
      const life = Math.min(1, p.age / 1.5, (p.ttl - p.age) / 1.5);
      const twinkle = 0.65 + 0.35 * Math.sin(t * p.tw + p.ph);
      const a = p.alpha * twinkle * life;
      if (a < 0.01) continue;
      ctx.globalAlpha = a;
      const img = (p.soft ? this.sprites.soft : this.sprites.sharp)[p.color];
      const s = p.soft ? p.size : p.size * 2.2;
      ctx.drawImage(img, p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Fade the particles out (the spotlight stays). */
  dimParticles() {
    this.el.classList.add('no-particles');
  }

  /** Fade the whole stage away, then remove it. */
  async leave(ms = 700) {
    this.el.style.setProperty('--leave', `${ms}ms`);
    this.el.classList.add('leave');
    await new Promise((r) => setTimeout(r, ms + 50));
    this.destroy();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.el.remove();
  }
}
