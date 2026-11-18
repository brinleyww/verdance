// Verdance soundscape: fully procedural WebAudio. No audio files, no libraries, nothing fetched.

const TAU = Math.PI * 2;
const TICK = 0.1; // seconds between real updates
const MAX_VOICES = 24; // short one-shots: steps, drops, bubbles, clicks
const MAX_THUNDER = 3;
const NOISE_FS = 24000; // looping noise beds don't need full bandwidth
const BROWN_FS = 22050;
const BIRD_LEVEL = 0.1;
const STEP_BUS = 0.16;
const STEP_LEVEL = { grass: 0.55, leaves: 0.7, dirt: 0.6, rock: 0.7, water: 0.6, wood: 0.55 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (a, b) => a + (b - a) * Math.random();
const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const fin = (v, d) => (Number.isFinite(v) ? v : d);
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// 1 at the source, 0 at `max` (Infinity/NaN -> 0)
function falloff(d, ref, max) {
  if (!(d < max)) return 0;
  d = d > 0 ? d : 0;
  const k = 1 - d / max;
  return (k * Math.sqrt(k)) / (1 + d / ref);
}

// setTargetAtTime that ignores non-finite values and skips exact repeats
function set(param, v, t, tau) {
  if (!Number.isFinite(v) || param.__v === v) return;
  param.__v = v;
  param.setTargetAtTime(v, t, tau);
}

// ---------- node helpers ----------

function gain(ctx, v, dest) {
  const g = ctx.createGain();
  g.gain.value = v;
  if (dest) g.connect(dest);
  return g;
}

function filt(ctx, type, f, q, dest) {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  if (dest) b.connect(dest);
  return b;
}

function osc(ctx, type, f, dest) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = f;
  if (dest) o.connect(dest);
  return o;
}

const NO_PARAM = { value: 0, setTargetAtTime() {}, setValueAtTime() {} };

function panNode(ctx, p, dest) {
  let n;
  if (ctx.createStereoPanner) {
    n = ctx.createStereoPanner();
    n.pan.value = p;
  } else {
    n = ctx.createGain();
    n.pan = NO_PARAM;
  }
  if (dest) n.connect(dest);
  return n;
}

function loopSrc(ctx, buf, dest) {
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  if (dest) s.connect(dest);
  return s;
}

function dropAll(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    try {
      nodes[i].disconnect();
    } catch (e) {
      /* already gone */
    }
  }
}

function monoBuf(ctx, x, sr) {
  const b = ctx.createBuffer(1, x.length, sr);
  b.getChannelData(0).set(x);
  return b;
}

// ---------- offline DSP for generated buffers ----------

function biquad(x, fs, type, f, q) {
  const w = (TAU * Math.min(f, fs * 0.45)) / fs;
  const cw = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'bp') {
    b0 = al;
    b1 = 0;
    b2 = -al;
  } else if (type === 'lp') {
    b0 = (1 - cw) / 2;
    b1 = 1 - cw;
    b2 = b0;
  } else {
    b0 = (1 + cw) / 2;
    b1 = -(1 + cw);
    b2 = b0;
  }
  const a0 = 1 + al;
  const a1 = (-2 * cw) / a0;
  const a2 = (1 - al) / a0;
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
  return x;
}

function hp1(x, fs, f) {
  const k = 1 / (1 + (TAU * f) / fs);
  let px = 0, py = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    py = k * (py + xi - px);
    px = xi;
    x[i] = py;
  }
  return x;
}

function normRms(x, target) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  const r = Math.sqrt(s / x.length);
  if (r > 0) {
    const k = target / r;
    for (let i = 0; i < x.length; i++) x[i] *= k;
  }
  return x;
}

function normPeak(x, target) {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > m) m = a;
  }
  if (m > 0) {
    const k = target / m;
    for (let i = 0; i < x.length; i++) x[i] *= k;
  }
  return x;
}

// x holds n + f samples of one continuous signal; returns n samples that loop without a seam
function loopify(x, n, f) {
  const out = x.slice(0, n);
  for (let i = 0; i < f; i++) {
    const u = (i / f) * Math.PI * 0.5;
    out[i] = x[i] * Math.sin(u) + x[n + i] * Math.cos(u);
  }
  return out;
}

function genWhite(n) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.random() * 2 - 1;
  return x;
}

function genPink(n) {
  const x = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return x;
}

// red noise: flat below ~70 Hz, -6 dB/oct above, subsonics removed
function genBrown(n, fs) {
  const x = new Float32Array(n);
  const a = (TAU * 70) / fs;
  let b = 0;
  for (let i = 0; i < n; i++) {
    b += a * (Math.random() * 2 - 1 - b);
    x[i] = b;
  }
  return hp1(x, fs, 22);
}

// dense rain patter: many tiny damped "tik"s
function genPatter(n, fs) {
  const x = new Float32Array(n);
  const count = Math.floor((n / fs) * 45);
  for (let k = 0; k < count; k++) {
    const i0 = Math.floor(Math.random() * n);
    const a = 0.1 + 0.9 * Math.pow(Math.random(), 3);
    const f = rnd(1400, 5200);
    const tau = rnd(0.0015, 0.005) * fs;
    const m = Math.min(n - i0, Math.floor(tau * 5));
    const up = rnd(0, 0.5);
    let ph = 0;
    for (let j = 0; j < m; j++) {
      ph += (TAU * f * (1 + (up * j) / m)) / fs;
      x[i0 + j] += a * Math.sin(ph) * Math.exp(-j / tau);
    }
    x[i0] += a * 0.5 * (Math.random() * 2 - 1);
  }
  return hp1(x, fs, 250);
}

// radio static: band-limited hiss with slow fading, pops and choppy bursts
function genStatic(n, fs) {
  const x = biquad(genWhite(n), fs, 'bp', 1700, 0.55);
  let e = 0.8, target = 0.8;
  for (let i = 0; i < n; i++) {
    if ((i & 255) === 0) target = 0.5 + 0.5 * Math.random();
    e += (target - e) * 0.003;
    x[i] *= e;
  }
  normRms(x, 0.25);
  const pops = Math.floor((n / fs) * 30);
  for (let k = 0; k < pops; k++) {
    const i0 = Math.floor(Math.random() * n);
    const a = 0.3 + 2 * Math.pow(Math.random(), 4);
    const m = 1 + Math.floor(Math.random() * fs * 0.002);
    for (let j = 0; j < m && i0 + j < n; j++) x[i0 + j] += a * (Math.random() * 2 - 1) * (1 - j / m);
  }
  for (let b = 0, nb = rint(2, 4); b < nb; b++) {
    let i = Math.floor(Math.random() * n);
    const end = Math.min(n, i + Math.floor(rnd(0.04, 0.15) * fs));
    while (i < end) {
      const seg = Math.floor(rnd(0.004, 0.014) * fs);
      const k = Math.random() < 0.5 ? 1.8 : 0.15;
      for (let j = 0; j < seg && i < end; j++, i++) x[i] *= k;
    }
  }
  return x;
}

// ---------- one-shot synthesis kit (adds into x) ----------

function addNoise(x, sr, t0, len, att, tau, amp, type, f, q) {
  const i0 = Math.floor(t0 * sr);
  const n = Math.min(Math.floor(len * sr), x.length - i0);
  if (n < 8) return;
  const tmp = new Float32Array(n);
  const na = Math.max(1, att * sr), nt = Math.max(1, tau * sr);
  for (let i = 0; i < n; i++) tmp[i] = (Math.random() * 2 - 1) * (i < na ? i / na : Math.exp(-(i - na) / nt));
  if (type) biquad(tmp, sr, type, f, q);
  normPeak(tmp, amp);
  const nf = Math.min(n, Math.floor(0.004 * sr));
  for (let i = 0; i < n; i++) x[i0 + i] += i > n - nf ? (tmp[i] * (n - i)) / nf : tmp[i];
}

function addClick(x, sr, t0, amp, f, q) {
  const i0 = Math.floor(t0 * sr);
  const n = Math.min(Math.floor(0.012 * sr), x.length - i0);
  if (n < 8) return;
  const tmp = new Float32Array(n);
  tmp[0] = 1;
  tmp[1] = Math.random() * 0.4 - 0.5;
  tmp[2] = Math.random() - 0.5;
  biquad(tmp, sr, 'bp', f, q);
  normPeak(tmp, amp);
  for (let i = 0; i < n; i++) x[i0 + i] += tmp[i] * (1 - i / n);
}

// damped sine; `drop` > 0 starts it sharp and falls to f (a thud)
function addTone(x, sr, t0, amp, f, tau, len, drop = 0) {
  const i0 = Math.floor(t0 * sr);
  const n = Math.min(Math.floor(len * sr), x.length - i0);
  if (n < 8) return;
  const na = Math.max(1, 0.0015 * sr);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (TAU * f * (1 + drop * Math.exp(-t / 0.012))) / sr;
    const e = (i < na ? i / na : 1) * Math.exp(-t / tau) * (i > n - 64 ? (n - i) / 64 : 1);
    x[i0 + i] += Math.sin(ph) * e * amp;
  }
}

// rising damped sine, like a small air bubble
function addBubble(x, sr, t0, amp, f0, rise, tau) {
  const i0 = Math.floor(t0 * sr);
  const n = Math.min(Math.floor(tau * 5 * sr), x.length - i0);
  if (n < 8) return;
  const na = Math.max(1, 0.001 * sr);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (TAU * f0 * (1 + (rise * t) / tau)) / sr;
    const e = (i < na ? i / na : 1) * Math.exp(-t / tau) * (i > n - 32 ? (n - i) / 32 : 1);
    x[i0 + i] += Math.sin(ph) * e * amp;
  }
}

// ---------- bird songs ----------
// A syllable is [start, dur, f0, f1, amp, fMid?, midFrac?]; frequencies sweep exponentially.

function songWarble(p) {
  const n = rint(8, 13);
  const fa = rnd(5000, 6200) * p, fb = rnd(2700, 3400) * p, d0 = rnd(0.045, 0.065);
  const syl = [];
  let t = 0;
  for (let k = 0; k < n; k++) {
    const u = k / (n - 1);
    const fc = fa * Math.pow(fb / fa, u) * rnd(0.96, 1.04);
    const d = d0 * rnd(0.85, 1.15);
    const a = (0.5 + 0.5 * Math.sin(Math.PI * Math.min(1, 0.15 + u))) * rnd(0.8, 1);
    syl.push([t, d, fc * 1.12, fc * 1.03, a, fc * 0.84, 0.45]);
    t += d + rnd(0.012, 0.03);
  }
  return { syl, wave: Math.random() < 0.7 ? 'sine' : 'triangle', vib: [rnd(28, 48), rnd(8, 25)], att: 0.006 };
}

function songTit(p) {
  const pairs = rint(3, 6);
  const fh = rnd(4500, 5600) * p, ratio = rnd(0.6, 0.74);
  const dh = rnd(0.07, 0.1), dl = rnd(0.08, 0.12), g1 = rnd(0.02, 0.04), g2 = rnd(0.06, 0.1);
  const syl = [];
  let t = 0;
  for (let k = 0; k < pairs; k++) {
    const fade = k === pairs - 1 ? 0.75 : 1;
    const j = rnd(0.98, 1.02);
    syl.push([t, dh, fh * 0.9 * j, fh * 0.97 * j, 0.9 * fade, fh * 1.02 * j, 0.2]);
    t += dh + g1;
    syl.push([t, dl, fh * ratio * 1.04 * j, fh * ratio * 0.95 * j, 0.75 * fade]);
    t += dl + g2 * rnd(0.9, 1.1);
  }
  return { syl, wave: 'sine', vib: [rnd(30, 60), rnd(5, 12)], att: 0.005 };
}

function songTrill(p) {
  const n = rint(14, 30);
  const fc0 = rnd(4200, 6400) * p, d = rnd(0.018, 0.03), gap = rnd(0.012, 0.024), drift = rnd(-0.25, 0.15);
  const syl = [];
  let t = 0;
  for (let k = 0; k < n; k++) {
    const u = k / (n - 1);
    const fc = fc0 * (1 + drift * u) * rnd(0.98, 1.02);
    const a = Math.min(1, (k + 1) / 4) * (1 - 0.3 * u) * rnd(0.85, 1);
    const dk = d * rnd(0.9, 1.1);
    syl.push([t, dk, fc * rnd(1.2, 1.32), fc * 0.78, a]);
    t += dk + gap;
  }
  if (Math.random() < 0.4) {
    const fe = fc0 * rnd(0.55, 0.7);
    for (let k = 0, m = rint(2, 3); k < m; k++) {
      syl.push([t, 0.06, fe * 1.05, fe * 0.95, 0.7]);
      t += 0.09;
    }
  }
  return { syl, wave: 'sine', vib: null, att: 0.003 };
}

function songFluty(p) {
  const n = rint(4, 8);
  const syl = [];
  let t = 0;
  for (let k = 0; k < n; k++) {
    const d = rnd(0.07, 0.22), f = rnd(1700, 3400) * p, a = rnd(0.6, 1);
    switch (Math.floor(Math.random() * 4)) {
      case 0: syl.push([t, d, f * 0.98, f * 1.02, a]); break;
      case 1: syl.push([t, d, f * 0.85, f * 1.15, a]); break;
      case 2: syl.push([t, d, f * 1.15, f * 0.85, a]); break;
      default: syl.push([t, d, f * 0.9, f * 0.95, a, f * 1.12, 0.5]);
    }
    t += d + rnd(0.02, 0.07);
  }
  if (Math.random() < 0.6) {
    const ft = rnd(4800, 6200) * p;
    for (let k = 0, m = rint(3, 6); k < m; k++) {
      const d = rnd(0.018, 0.03);
      syl.push([t, d, ft * 1.15, ft * 0.85, rnd(0.3, 0.5)]);
      t += d + 0.012;
    }
  }
  return { syl, wave: Math.random() < 0.6 ? 'sine' : 'triangle', vib: [rnd(5, 8), rnd(12, 30)], att: 0.012 };
}

function songChip(p) {
  const n = rint(1, 3);
  const f = (Math.random() < 0.5 ? rnd(5800, 6800) : rnd(3400, 4400)) * p;
  const syl = [];
  let t = 0;
  for (let k = 0; k < n; k++) {
    const d = rnd(0.025, 0.05);
    syl.push([t, d, f * 1.12, f * 0.86, rnd(0.7, 1)]);
    t += d + rnd(0.12, 0.35);
  }
  return { syl, wave: Math.random() < 0.5 ? 'sine' : 'triangle', vib: null, att: 0.003 };
}

// a distant cuckoo sits at its real pitch (~600 Hz), well below the songbirds
function songCuckoo() {
  const f1 = rnd(640, 720), f2 = f1 * rnd(0.8, 0.85), period = rnd(0.85, 1.05);
  const syl = [];
  for (let r = 0, reps = rint(2, 4); r < reps; r++) {
    const t = r * period;
    syl.push([t, 0.17, f1 * 1.01, f1 * 0.985, 0.9]);
    syl.push([t + 0.27, 0.28, f2 * 1.005, f2 * 0.97, 0.8]);
  }
  return { syl, wave: 'sine', vib: [rnd(4, 6), 6], att: 0.03 };
}

const SPECIES = [
  { meadow: 1.0, forest: 0.7, gap: [3.5, 8], level: 0.8, song: songWarble },
  { meadow: 0.35, forest: 1.0, gap: [2.5, 6], level: 0.75, song: songTit },
  { meadow: 0.8, forest: 0.6, gap: [4, 9], level: 0.65, song: songTrill },
  { meadow: 0.3, forest: 1.0, gap: [3, 7], level: 0.85, song: songFluty },
  { meadow: 0.6, forest: 0.55, gap: [1.5, 5], level: 0.45, song: songChip },
  { meadow: 0.22, forest: 0.18, gap: [6, 13], level: 0.7, song: songCuckoo, far: true },
];

// ---------- the soundscape ----------

export class Soundscape {
  constructor() {
    this._ctx = null;
    this._ready = false;
    this._volume = 0.8;
    this._paused = false;
    this._userSuspended = false;
    this._suspendToken = 0;
    this._acc = 0;
    this._voices = 0;
    this._thunders = 0;
    this._lx = 0;
    this._ly = 0;
    this._lz = 0;
    this._rx = 1;
    this._rz = 0;
    this._gSlow = 0;
    this._gFast = 0;
    this._lastSurface = 'grass';
    this._stepSide = 0;
    this._radio = null;
    this._charge = null;
    this._sphere = null;
    this._finaleEnd = 0;
    this._birds = [];
    this._spW = new Float32Array(SPECIES.length);
  }

  get started() {
    return this._ready;
  }

  // for systems that synthesise their own sounds (the drone): the shared context and the world bus (fades on pause)
  get context() {
    return this._ready ? this._ctx : null;
  }

  get worldBus() {
    return this._ready ? this._world : null;
  }

  async start() {
    if (this._ctx) {
      this._userSuspended = false;
      this._suspendToken++;
      try {
        if (this._ctx.state !== 'running') await this._ctx.resume();
      } catch (e) {
        /* ignore */
      }
      if (this._ready) this._fadeMaster(0.05);
      return;
    }
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return;
    let ctx;
    try {
      ctx = new AC({ latencyHint: 'balanced' });
    } catch (e) {
      try {
        ctx = new AC();
      } catch (e2) {
        return;
      }
    }
    this._ctx = ctx;
    try {
      this._build();
      this._ready = true;
    } catch (e) {
      console.warn('Soundscape: audio graph failed to build', e);
      this._ctx = null;
      try {
        ctx.close();
      } catch (e2) {
        /* ignore */
      }
      return;
    }
    try {
      if (ctx.state !== 'running') await ctx.resume();
    } catch (e) {
      /* ignore */
    }
  }

  setMasterVolume(v) {
    this._volume = clamp01(fin(v, 0.8));
    if (this._ready) this._fadeMaster(0.05);
  }

  suspend() {
    if (!this._ready) return;
    this._userSuspended = true;
    this._fadeMaster(0.03);
    const token = ++this._suspendToken;
    setTimeout(() => {
      if (token !== this._suspendToken || !this._userSuspended || !this._ctx) return;
      if (this._ctx.state === 'running') this._ctx.suspend().catch(() => {});
    }, 150);
  }

  resume() {
    if (!this._ready) return;
    this._userSuspended = false;
    this._suspendToken++;
    if (this._ctx.state !== 'running') this._ctx.resume().catch(() => {});
    this._fadeMaster(0.12);
  }

  // ---------- per-frame ----------

  update(dt, s) {
    if (!this._ready || !s || this._userSuspended) return;
    const ctx = this._ctx;
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;

    const paused = !!s.paused;
    if (paused !== this._paused) {
      this._paused = paused;
      this._world.gain.setTargetAtTime(paused ? 0 : 1, now, paused ? 0.05 : 0.25);
    }

    // the radio key reacts within a frame
    const radioOn = !!s.radioActive && !paused;
    const r = this._radio;
    if (radioOn) {
      if (!r) this._radioStart(now, s);
      else if (r.off) this._radioRevive(now, s);
    } else if (r && !r.off) {
      this._radioStop(now);
    }
    if (this._radio && this._radio.off && now >= this._radio.off) this._radioKill();
    if (this._charge && this._charge.off && now >= this._charge.off) this._chargeKill();

    this._acc += dt > 0 ? Math.min(dt, 0.5) : 0;
    if (this._acc < TICK) return;
    const tdt = Math.min(this._acc, 0.25);
    this._acc = 0;
    if (!paused) this._tick(now, tdt, s);
  }

  _tick(now, dt, s) {
    // listener frame, horizontal only
    const cp = s.camPos, cr = s.camRight, cf = s.camForward;
    this._lx = fin(cp.x, 0);
    this._ly = fin(cp.y, 0);
    this._lz = fin(cp.z, 0);
    let rx = fin(cr.x, 0), rz = fin(cr.z, 0), fx = fin(cf.x, 0), fz = fin(cf.z, 0);
    let l = Math.hypot(rx, rz);
    if (l > 1e-3) {
      rx /= l;
      rz /= l;
    } else {
      l = Math.hypot(fx, fz);
      if (l > 1e-3) {
        rx = -fz / l;
        rz = fx / l;
      } else {
        rx = this._rx;
        rz = this._rz;
      }
    }
    l = Math.hypot(fx, fz);
    if (l > 1e-3) {
      fx /= l;
      fz /= l;
    } else {
      fx = rz;
      fz = -rx;
    }
    this._rx = rx;
    this._rz = rz;

    const forest = clamp01(fin(s.forest, 0));
    const rain = clamp01(fin(s.rain, 0));
    const fog = clamp01(fin(s.fog, 0));
    const storm = clamp01(fin(s.storm, 0));
    const day = clamp01(fin(s.daylight, 1));
    const w = clamp01(fin(s.wind, 0) + 0.35 * storm);
    const move = clamp01(fin(s.speed, 0) / 8);

    // gusts: two Ornstein-Uhlenbeck processes, slow and fast
    const sq = Math.sqrt(dt);
    this._gSlow += (-this._gSlow * dt) / 7 + (Math.random() * 2 - 1) * 0.2 * sq;
    this._gFast += (-this._gFast * dt) / 1.3 + (Math.random() * 2 - 1) * 0.4 * sq;
    const gust = clamp(0.6 + this._gSlow + 0.55 * this._gFast * (0.4 + w), 0.15, 1.5);
    const fogDamp = 1 - 0.35 * fog;

    // wind bed
    const wg = (0.05 + 0.32 * Math.pow(w, 1.4)) * gust * (1 - 0.35 * forest) * fogDamp * (1 + 0.15 * move);
    set(this._windG.gain, wg, now, 0.45);
    set(this._windLP.frequency, (200 + 750 * w) * (0.5 + 0.6 * gust) * (1 - 0.3 * forest), now, 0.5);

    // leaf rustle flutters on every tick
    const rust = 0.16 * Math.pow(w, 1.5) * (0.2 + 0.8 * forest) * (0.4 + 0.6 * gust) * (0.55 + 0.45 * Math.random()) * fogDamp;
    set(this._rustleG.gain, rust, now, 0.12);
    set(this._rustleBP.frequency, 2600 + 1800 * forest + 600 * Math.random(), now, 0.2);

    // chasm drone
    const ch = smooth(120, 15, fin(s.chasmDist, 1e9));
    set(this._chasmG.gain, 0.06 * ch * (0.6 + 0.4 * gust) * (0.7 + 0.5 * w), now, 0.8);
    set(this._chasmMoan.frequency, 170 + 45 * clamp(this._gSlow * 2, -1, 1), now, 1.2);

    // creek
    const cd = fin(s.creekDist, 1e9);
    const cl = falloff(cd, 8, 60);
    set(this._creekG.gain, 0.9 * cl, now, 0.3);
    if (cl > 0.0005) {
      const dir = s.creekDir;
      const dx = fin(dir.x, 0), dz = fin(dir.z, 0);
      const front = dx * fx + dz * fz;
      set(this._creekPan.pan, clamp((dx * rx + dz * rz) * 0.6 * smooth(1, 10, cd), -1, 1), now, 0.15);
      set(this._creekLP.frequency, (2000 + 9000 / (1 + cd / 12)) * (0.8 + 0.1 * front), now, 0.3);
      const bands = this._creekBands;
      // two jittered targets per tick so the babble has no audible 10 Hz grid
      for (let i = 0; i < bands.length; i++) {
        const b = bands[i];
        const tau = (i < 2 ? 0.07 : 0.035) * rnd(0.6, 1.5);
        const t1 = now + rnd(0, 0.4) * dt, t2 = now + rnd(0.5, 0.9) * dt;
        set(b.bp.frequency, b.f * Math.pow(2, rnd(-0.35, 0.35)), t1, tau);
        set(b.g.gain, b.lvl * (0.25 + 0.95 * Math.random() * Math.random()), t1, tau);
        set(b.bp.frequency, b.f * Math.pow(2, rnd(-0.35, 0.35)), t2, tau);
        set(b.g.gain, b.lvl * (0.25 + 0.95 * Math.random() * Math.random()), t2, tau);
      }
      const near = falloff(cd, 4, 22);
      for (let k = 7 * near * dt; k > 0; k--) {
        if (Math.random() < Math.min(1, k)) {
          this._play(this._bubbles[rint(0, this._bubbles.length - 1)], this._creekPan, rnd(0.012, 0.05) * near, now + Math.random() * dt, rnd(0.75, 1.35));
        }
      }
    }

    // waterfall
    const wd = fin(s.waterfallDist, 1e9);
    const wl = falloff(wd, 35, 400);
    set(this._fallG.gain, 0.7 * wl, now, 0.4);
    if (wl > 0.0005) {
      const dir = s.waterfallDir;
      const dx = fin(dir.x, 0), dz = fin(dir.z, 0);
      const front = dx * fx + dz * fz;
      set(this._fallPan.pan, clamp((dx * rx + dz * rz) * 0.55 * smooth(3, 25, wd), -1, 1), now, 0.2);
      set(this._fallLP.frequency, (450 + 11000 / (1 + wd / 40)) * (0.85 + 0.15 * front), now, 0.4);
      const bands = this._fallBands;
      for (let i = 0; i < bands.length; i++) set(bands[i].g.gain, bands[i].lvl * rnd(0.85, 1.15), now, 0.25);
    }

    // rain
    const rr = rain < 0.005 ? 0 : rain;
    set(this._rainG.gain, 0.2 * Math.pow(rr, 1.2) * (0.85 + 0.35 * forest), now, 0.6);
    set(this._rainLP.frequency, 4500 + 3000 * forest + 1500 * rr, now, 0.8);
    set(this._rainHP.frequency, 700 - 400 * rr, now, 0.8);
    set(this._patterG.gain, 0.22 * Math.pow(rr, 1.3) * (0.4 + 0.6 * forest), now, 0.6);
    if (rr > 0.01) {
      const rate = (1.5 + 8 * rr) * (0.6 + 0.8 * forest);
      for (let k = rate * dt; k > 0; k--) {
        if (Math.random() < Math.min(1, k)) {
          const pan = this._tickPans[rint(0, this._tickPans.length - 1)];
          this._play(this._drops[rint(0, this._drops.length - 1)], pan, rnd(0.01, 0.05) * (0.6 + 0.6 * rr), now + Math.random() * dt, rnd(0.7, 1.4));
        }
      }
    }

    this._birdTick(now, forest, rain, fog, storm, day, w, fx, fz);

    // sphere hum
    const sh = clamp01(fin(s.sphereHum, 0));
    if (sh > 0.001 && !this._sphere) this._sphereBuild(now);
    if (this._sphere) set(this._sphere.out.gain, 0.03 * sh, now, 0.8);

    // forest reverb is a bit wetter under the canopy
    set(this._spaceOut.gain, 0.22 + 0.3 * forest, now, 1);

    if (this._radio && !this._radio.off) this._radioTick(now, s, 0.12);
  }

  // ---------- birds ----------

  _birdTick(now, forest, rain, fog, storm, day, w, fx, fz) {
    const dayF = smooth(0.12, 0.4, day);
    const wet = rain >= 0.65 ? 0 : 1 - rain / 0.65;
    const habitat = 0.45 + 0.55 * (1 - Math.min(1, Math.abs(forest - 0.5) * 2));
    const density = dayF * wet * wet * (1 - 0.75 * fog) * (1 - storm) * (1 - storm) * (1 - 0.5 * w * w) * habitat;
    set(this._birdBus.gain, BIRD_LEVEL * (1 - 0.4 * fog) * (1 - 0.5 * rain), now, 1);

    const rx = this._rx, rz = this._rz;
    for (let i = 0; i < this._birds.length; i++) {
      const b = this._birds[i];
      const ind = b.ind;
      if (ind) {
        const front = ind.dx * fx + ind.dz * fz;
        set(b.pan.pan, (ind.dx * rx + ind.dz * rz) * 0.7, now, 0.2);
        set(b.lp.frequency, ind.lp * (0.8 + 0.2 * (0.5 + 0.5 * front)), now, 0.2);
      }
      if (b.busy || now < b.next) continue;
      if (!ind) {
        if (Math.random() < density * 0.8) {
          this._birdArrive(b, forest, day, now);
        } else {
          b.next = now + rnd(1.5, 5);
          continue;
        }
      } else if (Math.random() > 0.3 + 1.2 * density) {
        b.ind = null; // conditions turned bad: this bird goes quiet
        b.next = now + rnd(3, 8);
        continue;
      }
      const end = this._birdSing(b, now + 0.02 + Math.random() * 0.08);
      const cur = b.ind;
      if (--cur.songs <= 0) {
        b.ind = null;
        b.next = end + rnd(4, 12);
      } else {
        b.next = end + rnd(cur.sp.gap[0], cur.sp.gap[1]);
      }
    }
  }

  _birdArrive(b, forest, day, now) {
    const wts = this._spW;
    let total = 0;
    for (let i = 0; i < SPECIES.length; i++) {
      const sp = SPECIES[i];
      wts[i] = sp.far && day < 0.5 ? 0 : lerp(sp.meadow, sp.forest, forest);
      total += wts[i];
    }
    let r = Math.random() * total, sp = SPECIES[0];
    for (let i = 0; i < SPECIES.length; i++) {
      r -= wts[i];
      if (r <= 0) {
        sp = SPECIES[i];
        break;
      }
    }
    const ang = Math.random() * TAU;
    const dist = sp.far ? rnd(0.75, 1) : Math.pow(Math.random(), 0.6);
    const ind = {
      sp,
      p: rnd(0.9, 1.12),
      loud: rnd(0.7, 1),
      dx: Math.cos(ang),
      dz: Math.sin(ang),
      lp: 2200 + 12000 * (1 - dist) * (1 - dist),
      songs: sp.far ? rint(1, 3) : rint(2, 6),
    };
    b.ind = ind;
    set(b.g.gain, 1 - 0.85 * dist, now, 0.03);
    set(b.lp.frequency, ind.lp, now, 0.03);
    set(b.pan.pan, (ind.dx * this._rx + ind.dz * this._rz) * 0.7, now, 0.03);
  }

  // one oscillator per song; returns the song's end time
  _birdSing(b, t0) {
    const ctx = this._ctx, ind = b.ind, sp = ind.sp;
    const song = sp.song(ind.p);
    const syl = song.syl;
    const o = ctx.createOscillator();
    o.type = song.wave;
    o.frequency.value = syl[0][2];
    const env = gain(ctx, 0, b.g);
    o.connect(env);
    const f = o.frequency, g = env.gain, A = sp.level * ind.loud;
    for (let k = 0; k < syl.length; k++) {
      const y = syl[k];
      const ts = t0 + y[0], d = y[1], te = ts + d, a = y[4] * A * rnd(0.9, 1.05);
      const at = Math.min(song.att, d * 0.3);
      f.setValueAtTime(y[2], ts);
      if (y[5]) f.exponentialRampToValueAtTime(y[5], ts + d * y[6]);
      f.exponentialRampToValueAtTime(y[3], te);
      g.setValueAtTime(0, ts);
      g.linearRampToValueAtTime(a, ts + at);
      g.linearRampToValueAtTime(a * 0.7, ts + d * 0.7);
      g.linearRampToValueAtTime(0, te);
    }
    const last = syl[syl.length - 1];
    const end = t0 + last[0] + last[1] + 0.03;
    let v = null, vg = null;
    if (song.vib) {
      v = osc(ctx, 'sine', song.vib[0] * rnd(0.9, 1.1));
      vg = gain(ctx, song.vib[1], o.detune);
      v.connect(vg);
      v.start(t0);
      v.stop(end);
    }
    o.start(t0);
    o.stop(end);
    b.busy = true;
    o.onended = () => {
      o.disconnect();
      env.disconnect();
      if (v) {
        v.disconnect();
        vg.disconnect();
      }
      b.busy = false;
    };
    return end;
  }

  // ---------- one-shots ----------

  _live() {
    return this._ready && !this._userSuspended && this._ctx.state === 'running';
  }

  _play(buf, dest, level, when, rate) {
    if (this._voices >= MAX_VOICES) return;
    const ctx = this._ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate || 1;
    const g = gain(ctx, level, dest);
    src.connect(g);
    this._voices++;
    src.onended = () => {
      this._voices--;
      src.disconnect();
      g.disconnect();
    };
    src.start(Math.max(when, ctx.currentTime));
  }

  footstep(surface, intensity) {
    if (!this._live() || this._voices >= MAX_VOICES) return;
    const surf = STEP_LEVEL[surface] ? surface : 'grass';
    this._lastSurface = surf;
    const I = clamp01(fin(intensity, 0.5));
    this._stepSide ^= 1;
    const lvl = STEP_LEVEL[surf] * (0.35 + 0.65 * I) * rnd(0.85, 1.1);
    this._play(this._synthStep(surf, I), this._footPans[this._stepSide], lvl, this._ctx.currentTime, rnd(0.94, 1.06));
  }

  land(intensity) {
    if (!this._live()) return;
    const I = clamp01(fin(intensity, 0.7));
    const now = this._ctx.currentTime, surf = this._lastSurface;
    const si = Math.min(1, 0.6 + 0.5 * I), lvl = STEP_LEVEL[surf] * (0.5 + 0.5 * I);
    this._play(this._synthThump(), this._steps, 0.6 * (0.4 + 0.6 * I), now, rnd(0.9, 1.05));
    this._play(this._synthStep(surf, si), this._footPans[0], lvl, now, rnd(0.95, 1.05));
    this._play(this._synthStep(surf, si), this._footPans[1], lvl * 0.8, now + rnd(0.02, 0.05), rnd(0.95, 1.05));
  }

  uiClick() {
    if (!this._live()) return;
    this._play(this._clickBuf, this._master, 0.035, this._ctx.currentTime, rnd(0.96, 1.04));
  }

  thunder(distanceMeters) {
    if (!this._live() || this._thunders >= MAX_THUNDER) return;
    const ctx = this._ctx;
    const d = clamp(fin(distanceMeters, 1500), 0, 15000);
    const close = clamp01(1 - d / 3000);
    const t0 = ctx.currentTime + d / 343 + 0.02;
    const T = clamp(4 + 3 * Math.random() + 3 * (1 - close), 4, 10);
    const N = Math.max(16, Math.ceil(T * 25));

    // rolling envelope: several peaks, each a ramp up and an exponential tail
    const np = rint(2, 5);
    const pt = [], pa = [], pr = [], pd = [];
    for (let k = 0; k < np; k++) {
      if (k === 0) {
        pt.push(close > 0.6 ? rnd(0, 0.1) : rnd(0.15, 0.7));
        pa.push(1);
        pr.push(lerp(0.7, 0.05, close));
        pd.push(rnd(0.5, 1.1));
      } else {
        pt.push(rnd(0.4, T * 0.6));
        pa.push(rnd(0.3, 0.85));
        pr.push(rnd(0.15, 0.6));
        pd.push(rnd(0.6, 1.8));
      }
    }
    const env = new Float32Array(N), fq = new Float32Array(N);
    let mx = 0;
    for (let j = 0; j < N; j++) {
      const t = (j / (N - 1)) * T;
      let v = 0;
      for (let k = 0; k < np; k++) {
        const u = t - pt[k];
        if (u > 0) v += pa[k] * (u < pr[k] ? u / pr[k] : Math.exp(-(u - pr[k]) / pd[k]));
      }
      v *= Math.min(1, (T - t) / 1.5) * rnd(0.85, 1.15);
      env[j] = v;
      if (v > mx) mx = v;
    }
    mx = mx || 1;
    const amp = 0.12 + 0.68 * close * close;
    const f0 = 300 + 1500 * close * close, f1 = 110 + 70 * close;
    for (let j = 0; j < N; j++) {
      const t = (j / (N - 1)) * T, e = env[j] / mx;
      fq[j] = f1 + (f0 - f1) * Math.exp(-t / (T * 0.3)) * (0.55 + 0.45 * e) + 120 * e;
      env[j] = e * amp;
    }
    env[0] = 0;
    env[N - 1] = 0;

    const p = panNode(ctx, rnd(-0.6, 0.6), this._world);
    const g = gain(ctx, 0, p);
    const lp2 = filt(ctx, 'lowpass', 1200, 0.6, g);
    const lp = filt(ctx, 'lowpass', fq[0], 0.8, lp2);
    const src = loopSrc(ctx, this._brownBuf, lp);
    src.playbackRate.value = rnd(0.75, 1.05);
    lp.frequency.setValueCurveAtTime(fq, t0, T);
    g.gain.setValueCurveAtTime(env, t0, T);
    src.start(t0, Math.random() * 6);
    src.stop(t0 + T + 0.05);
    const nodes = [src, lp, lp2, g, p];

    // close strikes open with a sharp crackling rip
    if (close > 0.55) {
      const M = 120, CT = 0.6, ca = 0.45 * smooth(0.55, 1, close);
      const cv = new Float32Array(M);
      for (let j = 2; j < M - 1; j++) {
        const t = (j / M) * CT;
        cv[j] = ca * Math.exp(-t / 0.11) * (Math.random() < 0.4 ? rnd(0.6, 1) : rnd(0.05, 0.3));
      }
      cv[1] = ca;
      const cg = gain(ctx, 0, p);
      const send = gain(ctx, 0.5, this._spaceIn);
      cg.connect(send);
      const chp = filt(ctx, 'highpass', 450, 0.7, cg);
      const cs = loopSrc(ctx, this._whiteBuf, chp);
      cg.gain.setValueCurveAtTime(cv, t0, CT);
      cs.start(t0, Math.random() * 3);
      cs.stop(t0 + CT + 0.02);
      nodes.push(cs, chp, cg, send);
    }
    this._thunders++;
    src.onended = () => {
      this._thunders--;
      dropAll(nodes);
    };
  }

  relayProgress(t) {
    if (!this._ready) return;
    const now = this._ctx.currentTime;
    if (!(t >= 0)) {
      this._chargeStop(now);
      return;
    }
    if (!this._live()) return;
    t = Math.min(1, t);
    let c = this._charge;
    if (!c) c = this._charge = this._chargeBuild(now);
    const revived = c.off !== 0;
    c.off = 0;
    if (!revived && now - c.last < 0.03) return; // called every frame; 30 ms is plenty
    c.last = now;
    set(c.saw.frequency, 55 + 150 * t, now, 0.06);
    set(c.lp.frequency, 220 + 2000 * t * t, now, 0.06);
    set(c.whine.frequency, 1200 + 2600 * Math.pow(t, 1.6), now, 0.06);
    set(c.whineG.gain, 0.006 + 0.028 * t * t, now, 0.08);
    set(c.lfo.frequency, 5 + 20 * t, now, 0.1);
    set(c.out.gain, 0.035 + 0.07 * t, now, 0.08);
  }

  relayActivate(pos) {
    if (!this._live()) return;
    const ctx = this._ctx, now = ctx.currentTime;
    this._chargeStop(now);
    const dx = fin(pos && pos.x, this._lx) - this._lx;
    const dy = fin(pos && pos.y, this._ly) - this._ly;
    const dz = fin(pos && pos.z, this._lz) - this._lz;
    const dh = Math.hypot(dx, dz), d = Math.hypot(dh, dy);
    const pan = dh > 0.5 ? clamp((dx * this._rx + dz * this._rz) / dh, -1, 1) * 0.75 : 0;
    const att = 1 / (1 + d / 12);
    const p = panNode(ctx, pan, this._world);
    const send = gain(ctx, 0.25, this._spaceIn);

    // contactor clunk
    const cg = gain(ctx, 0.28 * att, p);
    cg.connect(send);
    const src = ctx.createBufferSource();
    src.buffer = this._synthClunk();
    src.connect(cg);
    src.start(now);

    // transformer hum: sags under load, recovers, settles, fades
    const hg = gain(ctx, 0, p);
    const hlp = filt(ctx, 'lowpass', 650, 1.1, hg);
    const h1 = osc(ctx, 'sawtooth', 100, hlp), h2 = osc(ctx, 'sine', 200, hlp);
    const ts = now + 0.02;
    h1.frequency.setValueAtTime(86, ts);
    h1.frequency.setTargetAtTime(100, ts + 0.03, 0.4);
    h2.frequency.setValueAtTime(172, ts);
    h2.frequency.setTargetAtTime(200, ts + 0.03, 0.4);
    const g = hg.gain;
    g.setValueAtTime(0, ts);
    g.linearRampToValueAtTime(0.05 * att, ts + 0.43);
    g.setTargetAtTime(0.02 * att, ts + 0.48, 0.9);
    g.setTargetAtTime(0, ts + 4.5, 1.6);
    h1.start(ts);
    h2.start(ts);
    h1.stop(ts + 12);
    h2.stop(ts + 12);
    h1.onended = () => dropAll([src, cg, send, hg, hlp, h1, h2, p]);
  }

  finale() {
    if (!this._live()) return;
    const ctx = this._ctx, now = ctx.currentTime;
    if (now < this._finaleEnd) return;
    const t0 = now + 0.05, T = 12, end = t0 + T + 4;
    this._finaleEnd = end;
    if (!this._sphere) this._sphereBuild(now);

    const nodes = [];
    const out = gain(ctx, 0, this._world);
    const send = gain(ctx, 0.45, this._spaceIn);
    out.connect(send);
    const lp = filt(ctx, 'lowpass', 90, 2, out);
    const sh = gain(ctx, 0, out);
    nodes.push(out, send, lp, sh);
    // every voice glides up a fourth as the sphere spins up
    const voice = (type, f, lvl, dest) => {
      const g = gain(ctx, lvl, dest);
      const o = osc(ctx, type, f, g);
      o.detune.setValueAtTime(-500, t0);
      o.detune.setTargetAtTime(0, t0, 2.2);
      o.start(t0);
      o.stop(end);
      nodes.push(g, o);
      return o;
    };
    const first = voice('sawtooth', 55, 0.32, lp);
    voice('sawtooth', 55.21, 0.3, lp);
    voice('sawtooth', 82.5, 0.22, lp);
    voice('sawtooth', 110.35, 0.16, lp);
    voice('triangle', 164.8, 0.14, lp);
    voice('sine', 55, 0.5, out);
    voice('sine', 440, 0.5, sh);
    voice('sine', 441.2, 0.4, sh);
    voice('sine', 659.6, 0.3, sh);

    // breath of air through a sweeping band
    const ag = gain(ctx, 0, out);
    const abp = filt(ctx, 'bandpass', 500, 0.9, ag);
    const air = loopSrc(ctx, this._pinkBuf, abp);
    air.start(t0, Math.random() * 5);
    air.stop(end);
    nodes.push(ag, abp, air);

    const g = out.gain;
    g.setValueAtTime(0, t0);
    g.setTargetAtTime(0.17, t0, 2.6);
    g.setTargetAtTime(0, t0 + 8.2, 1.5);
    lp.frequency.setValueAtTime(90, t0);
    lp.frequency.exponentialRampToValueAtTime(1400, t0 + 7.8);
    lp.frequency.exponentialRampToValueAtTime(220, t0 + T);
    lp.Q.setValueAtTime(2, t0);
    lp.Q.linearRampToValueAtTime(7, t0 + 7.8);
    lp.Q.linearRampToValueAtTime(3, t0 + T);
    sh.gain.setValueAtTime(0, t0 + 4);
    sh.gain.linearRampToValueAtTime(0.05, t0 + 8);
    sh.gain.linearRampToValueAtTime(0, t0 + T + 1);
    ag.gain.setValueAtTime(0, t0);
    ag.gain.linearRampToValueAtTime(0.05, t0 + 7.5);
    ag.gain.linearRampToValueAtTime(0, t0 + T + 0.5);
    abp.frequency.setValueAtTime(500, t0);
    abp.frequency.exponentialRampToValueAtTime(2400, t0 + 7.5);
    abp.frequency.exponentialRampToValueAtTime(800, t0 + T);

    // the world holds its breath
    this._amb.gain.setTargetAtTime(0.5, t0, 1.5);
    this._amb.gain.setTargetAtTime(1, t0 + 9, 2.5);
    first.onended = () => dropAll(nodes);
  }

  // ---------- internals ----------

  _fadeMaster(tau) {
    const g = this._master.gain;
    g.setTargetAtTime(this._userSuspended ? 0 : this._volume, this._ctx.currentTime, tau);
  }

  _loopBuffer(chs, fs, sec, gen, rms) {
    const n = Math.floor(sec * fs), f = Math.floor(0.08 * fs);
    const buf = this._ctx.createBuffer(chs, n, fs);
    for (let c = 0; c < chs; c++) {
      const x = normRms(loopify(gen(n + f, fs), n, f), rms);
      for (let i = 0; i < n; i++) x[i] = x[i] > 1 ? 1 : x[i] < -1 ? -1 : x[i];
      buf.getChannelData(c).set(x);
    }
    return buf;
  }

  _build() {
    const ctx = this._ctx, now = ctx.currentTime;

    // shared buffers, generated once
    this._brownBuf = this._loopBuffer(2, BROWN_FS, 7, genBrown, 0.25);
    this._whiteBuf = this._loopBuffer(2, NOISE_FS, 6, genWhite, 0.25);
    this._pinkBuf = this._loopBuffer(1, NOISE_FS, 8, genPink, 0.25);
    this._patterBuf = this._loopBuffer(2, NOISE_FS, 5, genPatter, 0.08);
    this._staticBuf = this._loopBuffer(1, NOISE_FS, 7, genStatic, 0.2);
    this._drops = this._makeDrops();
    this._bubbles = this._makeBubbles();
    this._clickBuf = this._makeClick();

    // master chain: world (pause fade) -> master (volume) -> compressor -> out
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.008;
    comp.release.value = 0.35;
    comp.connect(ctx.destination);
    this._master = gain(ctx, this._volume, comp);
    this._world = gain(ctx, 0, this._master);
    this._world.gain.setTargetAtTime(1, now, 0.6);
    this._amb = gain(ctx, 1, this._world);

    // small forest reverb (mono send)
    const conv = ctx.createConvolver();
    conv.buffer = this._makeIR();
    this._spaceOut = gain(ctx, 0.3, this._world);
    conv.connect(this._spaceOut);
    this._spaceIn = gain(ctx, 1, conv);
    this._spaceIn.channelCount = 1;
    this._spaceIn.channelCountMode = 'explicit';

    // wind + chasm drone share one red-noise source
    const windSrc = loopSrc(ctx, this._brownBuf);
    this._windG = gain(ctx, 0, this._amb);
    this._windLP = filt(ctx, 'lowpass', 400, 0.6, this._windG);
    windSrc.connect(this._windLP);
    this._chasmG = gain(ctx, 0, this._amb);
    windSrc.connect(filt(ctx, 'lowpass', 90, 0.7, this._chasmG));
    this._chasmMoan = filt(ctx, 'bandpass', 170, 5, gain(ctx, 2.5, this._chasmG));
    windSrc.connect(this._chasmMoan);

    // rain wash + leaf rustle share one white source
    const whiteSrc = loopSrc(ctx, this._whiteBuf);
    this._rainG = gain(ctx, 0, this._amb);
    this._rainLP = filt(ctx, 'lowpass', 6000, 0.5, this._rainG);
    this._rainHP = filt(ctx, 'highpass', 700, 0.5, this._rainLP);
    whiteSrc.connect(this._rainHP);
    this._rustleG = gain(ctx, 0, this._amb);
    this._rustleBP = filt(ctx, 'bandpass', 3500, 0.8, this._rustleG);
    whiteSrc.connect(this._rustleBP);
    this._patterG = gain(ctx, 0, this._amb);
    const patterSrc = loopSrc(ctx, this._patterBuf, this._patterG);
    this._tickPans = [-0.75, -0.3, 0.3, 0.75].map((p) => panNode(ctx, p, this._amb));

    // creek and waterfall share one pink source
    const pinkSrc = loopSrc(ctx, this._pinkBuf);
    this._creekPan = panNode(ctx, 0, this._amb);
    this._creekLP = filt(ctx, 'lowpass', 8000, 0.5, this._creekPan);
    this._creekG = gain(ctx, 0, this._creekLP);
    this._creekBands = [
      [420, 2.5, 1.6],
      [850, 3.5, 1.6],
      [1600, 4, 1.4],
      [3100, 3, 1.0],
    ].map(([f, q, lvl]) => {
      const g = gain(ctx, lvl * 0.5, this._creekG);
      const bp = filt(ctx, 'bandpass', f, q, g);
      pinkSrc.connect(bp);
      return { bp, g, f, lvl };
    });
    this._fallPan = panNode(ctx, 0, this._amb);
    this._fallLP = filt(ctx, 'lowpass', 6000, 0.5, this._fallPan);
    this._fallG = gain(ctx, 0, this._fallLP);
    this._fallBands = [
      ['lowpass', 380, 0.6, 1.0],
      ['bandpass', 1000, 0.7, 0.8],
      ['bandpass', 3000, 0.8, 0.55],
    ].map(([type, f, q, lvl]) => {
      const g = gain(ctx, lvl, this._fallG);
      pinkSrc.connect(filt(ctx, type, f, q, g));
      return { g, lvl };
    });

    // birds: a few persistent slots, each one individual at a time
    this._birdBus = gain(ctx, BIRD_LEVEL, this._amb);
    this._birdBus.connect(gain(ctx, 0.5, this._spaceIn));
    this._birds = [];
    for (let i = 0; i < 3; i++) {
      const pan = panNode(ctx, 0, this._birdBus);
      const lp = filt(ctx, 'lowpass', 8000, 0.5, pan);
      const g = gain(ctx, 0, lp);
      this._birds.push({ g, lp, pan, ind: null, busy: false, next: now + rnd(0.5, 4) + i * 1.5 });
    }

    // footsteps alternate feet, slightly off-centre
    this._steps = gain(ctx, STEP_BUS, this._world);
    this._footPans = [panNode(ctx, -0.07, this._steps), panNode(ctx, 0.07, this._steps)];

    const bufs = [windSrc, whiteSrc, patterSrc, pinkSrc];
    for (let i = 0; i < bufs.length; i++) bufs[i].start(now, Math.random() * bufs[i].buffer.duration);
  }

  _makeIR() {
    const ctx = this._ctx, sr = ctx.sampleRate;
    const n = Math.floor(1.2 * sr), pre = Math.floor(0.01 * sr);
    const buf = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const x = buf.getChannelData(c);
      let lp = 0;
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / sr;
        lp += (0.08 + 0.55 * Math.exp(-t * 4)) * (Math.random() * 2 - 1 - lp); // tail darkens
        x[i] = lp * Math.exp((-t * 6.9) / 0.95);
      }
      for (let k = 0; k < 8; k++) x[pre + Math.floor(Math.random() * 0.07 * sr)] += (Math.random() * 2 - 1) * 0.5;
    }
    return buf;
  }

  _makeDrops() {
    const ctx = this._ctx, sr = ctx.sampleRate, out = [];
    for (let k = 0; k < 10; k++) {
      const x = new Float32Array(Math.floor(0.06 * sr));
      const leaf = k % 3 === 0;
      addBubble(x, sr, 0.0005, 1, leaf ? rnd(700, 1300) : rnd(1800, 4500), rnd(0.05, 0.25), leaf ? rnd(0.006, 0.012) : rnd(0.003, 0.007));
      addClick(x, sr, 0, leaf ? 0.6 : 0.4, rnd(3000, 6000), 1.5);
      out.push(monoBuf(ctx, normPeak(x, 1), sr));
    }
    return out;
  }

  _makeBubbles() {
    const ctx = this._ctx, sr = ctx.sampleRate, out = [];
    for (let k = 0; k < 8; k++) {
      const x = new Float32Array(Math.floor(0.2 * sr));
      addBubble(x, sr, 0, 1, rnd(350, 1100), rnd(0.15, 0.5), rnd(0.012, 0.035));
      out.push(monoBuf(ctx, normPeak(x, 1), sr));
    }
    return out;
  }

  _makeClick() {
    const ctx = this._ctx, sr = ctx.sampleRate;
    const x = new Float32Array(Math.floor(0.04 * sr));
    addTone(x, sr, 0, 0.8, 1750, 0.003, 0.03);
    addTone(x, sr, 0, 0.5, 900, 0.006, 0.04);
    addClick(x, sr, 0, 0.3, 4000, 1);
    return monoBuf(ctx, normPeak(x, 1), sr);
  }

  _synthStep(surf, I) {
    const ctx = this._ctx, sr = ctx.sampleRate;
    let x;
    switch (surf) {
      case 'leaves': {
        const len = 0.24 + 0.1 * I;
        x = new Float32Array(Math.floor(len * sr));
        addNoise(x, sr, 0, 0.2 + 0.06 * I, 0.006, rnd(0.04, 0.06), 0.45, 'bp', rnd(2800, 4200), 0.6);
        for (let k = 0, n = rint(16, 30) + Math.floor(10 * I); k < n; k++) {
          const t = (0.17 + 0.05 * I) * Math.pow(Math.random(), 1.6);
          addClick(x, sr, t, rnd(0.25, 1) * (1 - 2.5 * Math.min(0.3, t)), rnd(1800, 6500), rnd(1.5, 4));
        }
        addTone(x, sr, 0, 0.3, rnd(90, 130), 0.018, 0.06, 0.7);
        break;
      }
      case 'dirt': {
        x = new Float32Array(Math.floor(0.2 * sr));
        addTone(x, sr, 0, 0.7, rnd(70, 105), 0.027, 0.09, 0.7);
        addNoise(x, sr, 0, 0.12, 0.003, rnd(0.02, 0.035), 0.6, 'bp', rnd(800, 1400), 0.8);
        for (let k = 0, n = rint(6, 14); k < n; k++) {
          addClick(x, sr, 0.1 * Math.pow(Math.random(), 1.4), rnd(0.2, 0.6), rnd(1200, 3500), rnd(1.5, 3));
        }
        addNoise(x, sr, rnd(0.03, 0.06), 0.08, 0.004, 0.02, 0.35, 'bp', rnd(900, 1600), 0.9);
        break;
      }
      case 'rock': {
        x = new Float32Array(Math.floor(0.16 * sr));
        addClick(x, sr, 0, 1, rnd(1800, 3200), rnd(5, 9));
        addTone(x, sr, 0, 0.35, rnd(800, 1400), rnd(0.008, 0.014), 0.06);
        addTone(x, sr, 0, 0.35, rnd(110, 160), 0.015, 0.05, 0.7);
        addClick(x, sr, rnd(0.025, 0.055), rnd(0.45, 0.7), rnd(2000, 3800), rnd(4, 8));
        addNoise(x, sr, 0.005, 0.06, 0.004, 0.018, 0.18 + 0.15 * I, 'bp', rnd(4000, 6500), 1.2);
        break;
      }
      case 'water': {
        const len = 0.42 + 0.15 * I;
        x = new Float32Array(Math.floor(len * sr));
        addNoise(x, sr, 0, 0.3 + 0.12 * I, 0.008, rnd(0.05, 0.09) + 0.03 * I, 1, 'bp', rnd(1100, 2000), 0.6);
        addNoise(x, sr, rnd(0.01, 0.03), 0.25, 0.015, rnd(0.06, 0.1), 0.6, 'bp', rnd(350, 550), 1);
        for (let k = 0, n = rint(3, 7); k < n; k++) {
          addBubble(x, sr, rnd(0.02, 0.28), rnd(0.15, 0.45), rnd(500, 1400), rnd(0.1, 0.4), rnd(0.01, 0.03));
        }
        addTone(x, sr, 0, 0.3, rnd(140, 200), 0.018, 0.06, 0.7);
        break;
      }
      case 'wood': {
        x = new Float32Array(Math.floor(0.22 * sr));
        const f1 = rnd(150, 230);
        const knock = (t, a) => {
          addClick(x, sr, t, 0.35 * a, rnd(2200, 3200), 2);
          addTone(x, sr, t, 0.9 * a, f1 * rnd(0.97, 1.03), rnd(0.035, 0.06), 0.18);
          addTone(x, sr, t, 0.45 * a, f1 * rnd(2.5, 3.1), rnd(0.018, 0.03), 0.1);
          addTone(x, sr, t, 0.2 * a, rnd(1000, 1500), rnd(0.006, 0.012), 0.04);
        };
        knock(0, 1);
        knock(rnd(0.03, 0.06), rnd(0.4, 0.6));
        break;
      }
      default: {
        // grass: a soft swish, a second brush as the foot rolls, a few stem ticks
        const len = 0.26 + 0.12 * I;
        x = new Float32Array(Math.floor(len * sr));
        const f = rnd(2200, 3600) + 500 * I;
        addNoise(x, sr, 0, len * 0.75, rnd(0.012, 0.03), rnd(0.035, 0.06) + 0.03 * I, 1, 'bp', f, rnd(0.7, 1.1));
        addNoise(x, sr, rnd(0.05, 0.09), len * 0.6, rnd(0.02, 0.04), rnd(0.03, 0.05), rnd(0.35, 0.6), 'bp', f * rnd(0.75, 1.2), 0.9);
        for (let k = 0, n = rint(3, 8); k < n; k++) addClick(x, sr, rnd(0, 0.15), rnd(0.08, 0.22), rnd(3000, 6500), rnd(2, 4));
        addTone(x, sr, 0, 0.25 + 0.2 * I, rnd(80, 120), 0.02, 0.07, 0.7);
      }
    }
    return monoBuf(ctx, normPeak(x, 1), sr);
  }

  _synthThump() {
    const ctx = this._ctx, sr = ctx.sampleRate;
    const x = new Float32Array(Math.floor(0.3 * sr));
    addTone(x, sr, 0, 1, rnd(55, 75), 0.065, 0.25, 0.8);
    addNoise(x, sr, 0, 0.15, 0.004, 0.04, 0.4, 'lp', 400, 0.7);
    return monoBuf(ctx, normPeak(x, 1), sr);
  }

  _synthClunk() {
    const ctx = this._ctx, sr = ctx.sampleRate;
    const x = new Float32Array(Math.floor(0.9 * sr));
    addClick(x, sr, 0, 1, rnd(2600, 3400), 3);
    addNoise(x, sr, 0, 0.04, 0.0008, 0.008, 0.7, 'hp', 2500, 0.7);
    addTone(x, sr, 0.002, 1, rnd(62, 75), 0.07, 0.3, 0.8);
    addTone(x, sr, 0.001, 0.3, 365, 0.2, 0.8);
    addTone(x, sr, 0.001, 0.18, 1047, 0.13, 0.6);
    addTone(x, sr, 0.001, 0.1, 2213, 0.07, 0.4);
    addTone(x, sr, 0.001, 0.05, 3390, 0.04, 0.3);
    const b = rnd(0.035, 0.055); // armature bounce
    addClick(x, sr, b, 0.35, 3000, 3);
    addTone(x, sr, b, 0.1, 1057, 0.08, 0.4);
    return monoBuf(ctx, normPeak(x, 0.95), sr);
  }

  _sphereBuild(now) {
    const ctx = this._ctx;
    const out = gain(ctx, 0, this._world);
    const lp = filt(ctx, 'lowpass', 210, 1.4, out);
    // detuned pairs beat slowly; the filtered saw gives harmonics small speakers can play
    const parts = [
      ['sine', 48, 0.55, out],
      ['sine', 48.31, 0.45, out],
      ['sawtooth', 48.12, 0.3, lp],
      ['triangle', 72.2, 0.18, lp],
      ['sine', 96.4, 0.14, out],
    ];
    for (let i = 0; i < parts.length; i++) {
      const [type, f, lvl, dest] = parts[i];
      osc(ctx, type, f, gain(ctx, lvl, dest)).start(now);
    }
    this._sphere = { out };
  }

  // ---------- radio ----------

  _radioStart(now, s) {
    const ctx = this._ctx;
    const out = gain(ctx, 0, this._world);
    const stat = gain(ctx, 1.3, out); // key-up squelch, settles on the first tick
    const src = loopSrc(ctx, this._staticBuf, stat);
    const toneG = gain(ctx, 0, out);
    const pulse = gain(ctx, 0.7, toneG);
    const tone = osc(ctx, 'sine', 1000, pulse);
    const lfo = osc(ctx, 'sine', rnd(1.1, 1.6));
    const lfoG = gain(ctx, 0.3, pulse.gain);
    lfo.connect(lfoG);
    src.start(now, Math.random() * 6.5);
    tone.start(now);
    lfo.start(now);
    this._radio = { out, stat, toneG, tone, t0: now, off: 0, srcs: [src, tone, lfo], nodes: [out, stat, src, toneG, pulse, tone, lfo, lfoG] };
    this._radioTick(now, s, 0.03);
  }

  _radioTick(now, s, tauOut) {
    const r = this._radio;
    const sig = clamp01(fin(s.radioSignal, 0));
    const near = clamp01(1 - fin(s.radioDist, 1e9) / 300);
    const lock = smooth(0.45, 0.97, sig);
    set(r.out.gain, 0.15 * (0.75 + 0.45 * near), now, tauOut);
    const crackle = Math.random() < 0.15 ? rnd(0.25, 0.6) : rnd(0.8, 1.05);
    set(r.stat.gain, (1 - 0.85 * lock) * crackle, Math.max(now, r.t0 + 0.08), 0.03);
    set(r.toneG.gain, 0.32 * Math.pow(lock, 1.4), now, 0.08);
    set(r.tone.detune, (1 - lock) * rnd(-70, 70), now, 0.15);
  }

  _radioStop(now) {
    const r = this._radio;
    r.off = now + 0.4;
    r.out.gain.setTargetAtTime(0, now, 0.05);
    r.out.gain.__v = undefined;
  }

  _radioRevive(now, s) {
    const r = this._radio;
    r.off = 0;
    r.t0 = now - 1;
    this._radioTick(now, s, 0.03);
  }

  _radioKill() {
    const r = this._radio;
    this._radio = null;
    for (let i = 0; i < r.srcs.length; i++) {
      try {
        r.srcs[i].stop();
      } catch (e) {
        /* ignore */
      }
    }
    dropAll(r.nodes);
  }

  // ---------- relay charge-up ----------

  _chargeBuild(now) {
    const ctx = this._ctx;
    const out = gain(ctx, 0, this._world);
    const trem = gain(ctx, 0.7, out);
    const lp = filt(ctx, 'lowpass', 220, 4, trem);
    const saw = osc(ctx, 'sawtooth', 55, lp);
    const lfo = osc(ctx, 'sine', 5);
    const lfoG = gain(ctx, 0.3, trem.gain);
    lfo.connect(lfoG);
    const whineG = gain(ctx, 0, out);
    const whine = osc(ctx, 'sine', 1200, whineG);
    saw.start(now);
    lfo.start(now);
    whine.start(now);
    return { out, saw, lp, lfo, whine, whineG, off: 0, last: -1, oscs: [saw, lfo, whine], nodes: [out, trem, lp, saw, lfo, lfoG, whineG, whine] };
  }

  _chargeStop(now) {
    const c = this._charge;
    if (!c || c.off) return;
    c.out.gain.setTargetAtTime(0, now, 0.07);
    c.out.gain.__v = undefined;
    c.off = now + 0.5;
  }

  _chargeKill() {
    const c = this._charge;
    this._charge = null;
    for (let i = 0; i < c.oscs.length; i++) {
      try {
        c.oscs[i].stop();
      } catch (e) {
        /* ignore */
      }
    }
    dropAll(c.nodes);
  }
}
