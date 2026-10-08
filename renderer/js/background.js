// Animated "theme" background: drifting colour fields, silky light ribbons
// and floating particles. Rendered at reduced resolution for performance.

const canvas = document.getElementById('bg-canvas');
const ctx = canvas.getContext('2d', { alpha: false });

let mode = 'animated';
let visible = true;
let raf = 0;
let last = 0;
let t0 = performance.now();
let W = 0;
let H = 0;
const SCALE = 0.5;

const blobs = [
  { c: [38, 86, 255], a: 0.42, r: 0.62, px: 0.72, py: 0.18, sx: 0.05, sy: 0.04, ph: 0 },
  { c: [126, 58, 242], a: 0.32, r: 0.55, px: 0.25, py: 0.7, sx: 0.06, sy: 0.05, ph: 1.7 },
  { c: [0, 170, 255], a: 0.22, r: 0.45, px: 0.5, py: 0.45, sx: 0.07, sy: 0.06, ph: 3.1 },
  { c: [236, 72, 153], a: 0.12, r: 0.4, px: 0.9, py: 0.8, sx: 0.04, sy: 0.05, ph: 4.4 },
];

let particles = [];

function resize() {
  W = Math.max(2, Math.floor(window.innerWidth * SCALE));
  H = Math.max(2, Math.floor(window.innerHeight * SCALE));
  canvas.width = W;
  canvas.height = H;
  particles = Array.from({ length: 70 }, () => spawn(true));
  if (mode !== 'animated') drawFrame(performance.now());
}

function spawn(anywhere) {
  return {
    x: Math.random() * W,
    y: anywhere ? Math.random() * H : H + 10,
    r: 0.4 + Math.random() * 1.6,
    vy: 4 + Math.random() * 10,
    vx: -3 + Math.random() * 6,
    tw: Math.random() * Math.PI * 2,
    a: 0.25 + Math.random() * 0.6,
  };
}

function drawFrame(now) {
  const t = (now - t0) / 1000;
  // Base gradient
  const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
  g.addColorStop(0, '#070d2a');
  g.addColorStop(0.55, '#050820');
  g.addColorStop(1, '#0b0623');
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Colour fields
  ctx.globalCompositeOperation = 'lighter';
  for (const b of blobs) {
    const x = (b.px + Math.sin(t * b.sx + b.ph) * 0.18) * W;
    const y = (b.py + Math.cos(t * b.sy + b.ph * 1.3) * 0.15) * H;
    const r = b.r * Math.max(W, H);
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(${b.c[0]},${b.c[1]},${b.c[2]},${b.a})`);
    rg.addColorStop(1, `rgba(${b.c[0]},${b.c[1]},${b.c[2]},0)`);
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  }

  // Light ribbons
  ctx.lineWidth = 1;
  for (let band = 0; band < 2; band++) {
    const baseY = H * (band === 0 ? 0.62 : 0.72);
    const amp = H * (band === 0 ? 0.09 : 0.06);
    for (let i = 0; i < 18; i++) {
      const k = i / 18;
      ctx.strokeStyle = band === 0 ? `rgba(140,190,255,${0.05 + k * 0.05})` : `rgba(190,150,255,${0.04 + k * 0.04})`;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const u = x / W;
        const y =
          baseY +
          Math.sin(u * 3.2 + t * (0.18 + band * 0.07) + k * 0.9) * amp * (0.6 + k * 0.6) +
          Math.sin(u * 7.1 - t * 0.11 + k * 2.1) * amp * 0.25;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  // Particles
  for (const p of particles) {
    const tw = 0.55 + Math.sin(t * 1.7 + p.tw) * 0.45;
    ctx.fillStyle = `rgba(200,220,255,${p.a * tw})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Vignette
  ctx.globalCompositeOperation = 'source-over';
  const vg = ctx.createRadialGradient(W * 0.5, H * 0.45, Math.min(W, H) * 0.2, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

function step(now) {
  raf = 0;
  if (!visible || mode !== 'animated') return;
  const dt = Math.min(0.1, (now - last) / 1000);
  if (now - last >= 32) {
    for (const p of particles) {
      p.y -= p.vy * dt;
      p.x += p.vx * dt;
      if (p.y < -10 || p.x < -10 || p.x > W + 10) Object.assign(p, spawn(false));
    }
    drawFrame(now);
    last = now;
  }
  raf = requestAnimationFrame(step);
}

function kick() {
  if (!raf && visible && mode === 'animated') {
    last = performance.now();
    raf = requestAnimationFrame(step);
  }
}

export const background = {
  init() {
    resize();
    window.addEventListener('resize', resize);
    kick();
  },
  setMode(m) {
    mode = m || 'animated';
    canvas.style.opacity = mode === 'off' ? '0' : '1';
    if (mode === 'static') drawFrame(performance.now());
    kick();
  },
  setVisible(v) {
    visible = v;
    if (v) kick();
  },
};
