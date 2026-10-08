// Synthesised UI sounds + an optional generative ambient pad (no audio files).

let ctx = null;
let master = null;
let sfxBus = null;
let reverb = null;
let enabled = true;
let volume = 0.6;

function ensure() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = volume;
    sfxBus.connect(master);
    reverb = makeReverb(2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    reverb.connect(wet).connect(master);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function makeReverb(seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  const conv = ctx.createConvolver();
  conv.buffer = buf;
  return conv;
}

function tone({ freq, to, type = 'sine', dur = 0.08, gain = 0.2, attack = 0.003, delay = 0, wet = 0.4, filter = null }) {
  const c = ensure();
  const t = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let node = osc;
  if (filter) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = filter;
    osc.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(sfxBus);
  if (wet > 0) {
    const w = c.createGain();
    w.gain.value = wet;
    g.connect(w).connect(reverb);
  }
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function noise({ dur = 0.3, gain = 0.08, from = 400, to = 4000, q = 1.2, delay = 0 }) {
  const c = ensure();
  const t = c.currentTime + delay;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = q;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(sfxBus);
  const w = c.createGain();
  w.gain.value = 0.3;
  g.connect(w).connect(reverb);
  src.start(t);
}

let lastMove = 0;

export const sfx = {
  move() {
    if (!enabled) return;
    const now = performance.now();
    if (now - lastMove < 28) return;
    lastMove = now;
    tone({ freq: 2350, dur: 0.035, gain: 0.07, wet: 0.15 });
    tone({ freq: 1175, type: 'triangle', dur: 0.06, gain: 0.05, wet: 0.2 });
  },
  tick() {
    if (!enabled) return;
    tone({ freq: 1900, dur: 0.03, gain: 0.05, wet: 0.1 });
  },
  select() {
    if (!enabled) return;
    tone({ freq: 1318.5, dur: 0.12, gain: 0.09, wet: 0.35 });
    tone({ freq: 1975.5, dur: 0.18, gain: 0.07, delay: 0.045, wet: 0.45 });
  },
  back() {
    if (!enabled) return;
    tone({ freq: 1046.5, dur: 0.09, gain: 0.08, wet: 0.3 });
    tone({ freq: 784, dur: 0.14, gain: 0.07, delay: 0.04, wet: 0.35 });
  },
  toggle() {
    if (!enabled) return;
    tone({ freq: 1567.98, dur: 0.07, gain: 0.08, type: 'triangle', wet: 0.2 });
  },
  bump() {
    if (!enabled) return;
    tone({ freq: 190, to: 120, dur: 0.12, gain: 0.16, type: 'sine', wet: 0.05 });
  },
  open() {
    if (!enabled) return;
    noise({ dur: 0.38, gain: 0.05, from: 300, to: 3200 });
    tone({ freq: 880, dur: 0.22, gain: 0.05, delay: 0.08, wet: 0.6 });
    tone({ freq: 1318.5, dur: 0.3, gain: 0.04, delay: 0.14, wet: 0.7 });
  },
  close() {
    if (!enabled) return;
    noise({ dur: 0.3, gain: 0.04, from: 2800, to: 400 });
  },
  notify() {
    if (!enabled) return;
    tone({ freq: 1760, dur: 0.25, gain: 0.07, wet: 0.6 });
    tone({ freq: 2349.3, dur: 0.4, gain: 0.06, delay: 0.09, wet: 0.7 });
  },
  launch() {
    if (!enabled) return;
    noise({ dur: 1.2, gain: 0.05, from: 200, to: 6000, q: 0.8 });
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone({ freq: f, dur: 0.9, gain: 0.05, delay: i * 0.07, wet: 0.8, type: 'triangle', filter: 4000 }));
  },
  boot() {
    if (!enabled) return;
    [261.63, 392, 523.25, 659.25, 987.77].forEach((f, i) => tone({ freq: f, dur: 2.8, gain: 0.035, attack: 0.6, delay: i * 0.12, wet: 1, type: 'sine' }));
  },
  error() {
    if (!enabled) return;
    tone({ freq: 330, dur: 0.16, gain: 0.1, type: 'triangle', wet: 0.2 });
    tone({ freq: 247, dur: 0.22, gain: 0.1, type: 'triangle', delay: 0.11, wet: 0.2 });
  },
};

export function configureSound({ uiSounds, uiVolume }) {
  enabled = uiSounds !== false;
  volume = Math.max(0, Math.min(1, (uiVolume ?? 60) / 100));
  if (sfxBus) sfxBus.gain.setTargetAtTime(volume, ctx.currentTime, 0.05);
}

/* ------------------------------------------------------------------ */
/* Ambient pad                                                         */
/* ------------------------------------------------------------------ */

const CHORDS = [
  [146.83, 220, 277.18, 329.63], // Dmaj9-ish
  [123.47, 185, 246.94, 293.66], // Bm7
  [110, 164.81, 220, 277.18], // A
  [130.81, 196, 246.94, 329.63], // Cmaj7
];

let amb = null;

export function setAmbient(on, vol = 0.35) {
  if (!on) {
    if (amb) {
      const a = amb;
      amb = null;
      a.out.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.8);
      clearInterval(a.timer);
      clearInterval(a.sparkle);
      setTimeout(() => a.voices.forEach((v) => v.forEach((o) => o.stop())), 4000);
    }
    return;
  }
  const c = ensure();
  if (amb) {
    amb.out.gain.setTargetAtTime(vol * 0.5, c.currentTime, 0.5);
    return;
  }
  const out = c.createGain();
  out.gain.value = 0.0001;
  out.connect(master);
  const wet = c.createGain();
  wet.gain.value = 0.6;
  out.connect(wet).connect(reverb);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  lp.Q.value = 0.4;
  lp.connect(out);
  const lfo = c.createOscillator();
  const lfoGain = c.createGain();
  lfo.frequency.value = 0.05;
  lfoGain.gain.value = 380;
  lfo.connect(lfoGain).connect(lp.frequency);
  lfo.start();

  const voices = [];
  const gains = [];
  for (let i = 0; i < 4; i++) {
    const g = c.createGain();
    g.gain.value = 0.05;
    g.connect(lp);
    const oscs = [-6, 6].map((det) => {
      const o = c.createOscillator();
      o.type = i === 0 ? 'sine' : 'triangle';
      o.detune.value = det;
      o.frequency.value = CHORDS[0][i];
      o.connect(g);
      o.start();
      return o;
    });
    voices.push(oscs);
    gains.push(g);
  }
  voices.push([lfo]);
  let step = 0;
  const change = () => {
    step = (step + 1) % CHORDS.length;
    const t = c.currentTime;
    CHORDS[step].forEach((f, i) => voices[i].forEach((o) => o.frequency.setTargetAtTime(f, t, 1.6)));
  };
  const sparkle = () => {
    const chord = CHORDS[step];
    const f = chord[Math.floor(Math.random() * chord.length)] * (Math.random() < 0.5 ? 4 : 8);
    const t = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.018, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 2.5);
  };
  amb = { out, voices, timer: setInterval(change, 9000), sparkle: setInterval(sparkle, 2300) };
  out.gain.setTargetAtTime(vol * 0.5, c.currentTime, 1.5);
}

/**
 * Throw the audio graph away; the next sound builds a fresh one. Used when the
 * launcher comes back from a game and when the audio device changes: games can
 * change or take over the output, and a stale Chromium output stream then plays
 * UI sounds with a faint ghost copy about a second later.
 */
export function resetAudio() {
  if (!ctx) return;
  const old = ctx;
  ctx = null;
  master = null;
  sfxBus = null;
  reverb = null;
  if (amb) {
    clearInterval(amb.timer);
    clearInterval(amb.sparkle);
    amb = null;
  }
  old.close().catch(() => {});
}

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => resetAudio());
}

export function unlockAudio() {
  ensure();
}
