// The Settings background, as on the PS5: a dark room lit by a spotlight above
// the top-left corner. Its light falls as a few broad, soft beams that slowly
// merge and part; a cool haze lies on the floor at the bottom left.
//
// The picture is a light model fitted to the PS5's own (a video of its
// Settings, averaged over time): after the fit the two differ by about one
// brightness level in 255. It is computed small and scaled up by the page:
// it has no detail to lose, and a frame costs well under a millisecond.

const W = 480;
const H = 270;
const FPS = 20;

// The fitted shapes. Lengths are in screen heights, angles in radians from
// straight down (positive to the right), the screen is 16:9 (x = 0..1.78).
const P = {
  sx: 0.177, sy: -0.2772, // the lamp: above the screen, a tenth in from the left
  phi0: 0.2819, sL: 0.4305, sR: 0.2511, pw: 3.0452, // the cone: where it points, how far it opens to each side
  r0: 0.02, q: 0.6426, // ... and how it fades with distance
  phi2: 0.6749, s2: 0.2656, r2: 0.02, q2: 1.1694, // a fainter skirt of light further to the right
  g3: 0.3729, // the glow close to the lamp
  vf: 0.8675, hfU: 0.0878, hfD: 0.1123, uf: 0.2166, wfL: 0.434, wfR: 0.1803, // the haze on the floor
};
// Each part's colour (at strength 1).
const BASE = [34.9, 34.1, 41.4];
const BASE_U = [-20.0, -17.6, -12.7]; // darker towards the right
const BASE_V = [1.0, 0.8, -0.5];
const SPOT = [312.5, 279.7, 240.4];
const SKIRT = [2185.3, 1869.0, 1543.1];
const GLOW = [111.1, 82.7, 77.4];
const FLOOR = [23.8, 29.2, 30.5];

// The beams: how much the light varies across the cone, strongest near the
// lamp (about a fifth), fading with distance (measured: the PS5's picture
// changes by ~9 levels near the top edge, ~2 halfway down).
const BEAMS = 0.19;
const BEAMS_REACH = 0.45;
const LUT = 512;

let field = null; // the fixed part and the lit part of every pixel

function build() {
  const n = W * H;
  const still = new Float32Array(n * 3);
  const lit = new Float32Array(n * 3);
  const depth = new Float32Array(n);
  const angle = new Uint16Array(n);
  const phis = new Float32Array(n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const u = (i + 0.5) / W;
      const v = (j + 0.5) / H;
      const dx = (u * 16) / 9 - P.sx;
      const dy = v - P.sy;
      const r = Math.hypot(dx, dy);
      const phi = Math.atan2(dx, dy);
      const a = phi - P.phi0;
      const cone = Math.exp(-Math.pow(Math.abs(a) / (a < 0 ? P.sL : P.sR), P.pw));
      const spot = cone / (1 + Math.pow(r / P.r0, P.q));
      const b = phi - P.phi2;
      const skirt = Math.exp(-(b * b) / (P.s2 * P.s2)) / (1 + Math.pow(r / P.r2, P.q2));
      const glow = Math.exp(-(r * r) / (P.g3 * P.g3)) * cone;
      const fv = v - P.vf;
      const fh = fv < 0 ? P.hfU : P.hfD;
      const fu = u - P.uf;
      const floor = Math.exp(-(fv * fv) / (fh * fh)) * (fu < 0 ? Math.exp(-(fu * fu) / (P.wfL * P.wfL)) : 1 / (1 + (fu * fu) / (P.wfR * P.wfR)));
      // A touch of noise under the rounding keeps the dark gradients from banding.
      const grain = Math.random() - 0.5;
      for (let c = 0; c < 3; c++) {
        still[k * 3 + c] = BASE[c] + BASE_U[c] * u + BASE_V[c] * v + FLOOR[c] * floor + grain;
        lit[k * 3 + c] = SPOT[c] * spot + SKIRT[c] * skirt + GLOW[c] * glow;
      }
      depth[k] = BEAMS * Math.exp(-(r + P.sy) / BEAMS_REACH);
      phis[k] = phi;
      if (phi < lo) lo = phi;
      if (phi > hi) hi = phi;
    }
  }
  for (let k = 0; k < n; k++) angle[k] = Math.round(((phis[k] - lo) / (hi - lo)) * (LUT - 1));
  field = { still, lit, depth, angle, lo, hi, beams: new Float32Array(LUT) };
}

// Brighter and darker directions across the cone at time t: three widths of
// beam, each swaying a little and coming and going, so they merge and part.
function beamsAt(t) {
  const { lo, hi, beams } = field;
  const p1 = 0.5 + 1.2 * Math.sin(0.52 * t);
  const p2 = 2.2 + 1.5 * Math.sin(0.37 * t + 2.0);
  const p3 = 4.0 + 1.7 * Math.sin(0.61 * t + 4.0);
  const a1 = 0.55 * (0.65 + 0.35 * Math.sin(0.43 * t + 1.0));
  const a2 = 0.38 * (0.6 + 0.4 * Math.sin(0.71 * t + 0.3));
  const a3 = 0.22 * (0.6 + 0.4 * Math.sin(0.57 * t + 2.5));
  for (let i = 0; i < LUT; i++) {
    const phi = lo + ((hi - lo) * i) / (LUT - 1);
    beams[i] = a1 * Math.sin(13 * phi + p1) + a2 * Math.sin(24 * phi + p2) + a3 * Math.sin(39 * phi + p3);
  }
}

export function lightBackground() {
  const el = document.createElement('canvas');
  el.className = 'set-bg';
  el.width = W;
  el.height = H;
  const ctx = el.getContext('2d', { alpha: false });
  const image = ctx.createImageData(W, H);
  const px = image.data;
  for (let k = 3; k < px.length; k += 4) px[k] = 255;
  let raf = 0;
  let last = 0;
  let running = false;

  const draw = (t) => {
    if (!field) build();
    beamsAt(t);
    const { still, lit, depth, angle, beams } = field;
    for (let k = 0, o = 0, c = 0; k < W * H; k++, o += 4, c += 3) {
      const f = 1 + depth[k] * beams[angle[k]];
      px[o] = still[c] + lit[c] * f;
      px[o + 1] = still[c + 1] + lit[c + 1] * f;
      px[o + 2] = still[c + 2] + lit[c + 2] * f;
    }
    ctx.putImageData(image, 0, 0);
  };

  const frame = (now) => {
    raf = 0;
    if (!running) return;
    if (now - last >= 1000 / FPS - 4) {
      last = now;
      draw(now / 1000);
    }
    raf = requestAnimationFrame(frame);
  };

  return {
    el,
    /** Start (or keep) the light moving; still with reduced motion. */
    start() {
      const still = document.body.classList.contains('reduce-motion');
      running = !still;
      if (still) draw(0);
      else if (!raf) raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
