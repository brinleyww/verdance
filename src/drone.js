// Survey drone: a folding quadcopter you set down, unfold and fly from its camera feed, then call home.
// States: docked -> deploy -> flying <-> returning -> cutback -> approach -> landing -> stow -> docked.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { patch, G } from './shaderlib.js';
import { chasmCentre } from './worldgen.js';

const EYE = 1.68;
const FOOT = 0.052;          // body centre above the ground when it stands on its feet
const IDLE = 300;            // rad/s, props idling on the ground
const HOVER = 680;           // rad/s at hover (blade pass ~216 Hz)
const RANGE_SOFT = 1150, RANGE_HARD = 1250;
const CAM_OFF = new THREE.Vector3(0, -0.054, -0.114);

const HIDE = { value: 0 };   // 1 while looking through the drone's own camera (it still casts its shadow)
const SPIN = { value: 0 };   // prop disc opacity
const HIDE_VS = 'if (uHide > 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sat = (x) => clamp(x, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const sstep = (a, b, x) => smooth(sat((x - a) / (b - a)));
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (k, dt) => 1 - Math.exp(-k * dt);
// a latch that travels a touch too far and settles back: arms locking into place
const detent = (t) => { if (t <= 0) return 0; if (t >= 1) return 1; const u = t - 1; return 1 + u * u * (2.2 * u + 1.2); };

// ---------------------------------------------------------------- geometry
function colorize(g, c) {
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c[0]; a[i * 3 + 1] = c[1]; a[i * 3 + 2] = c[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
function clean(g) {
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  g = mergeVertices(g);
  return g;
}
// box with rounded edges; shape(v) may taper or bend the result
function roundBox(w, h, d, r, segs = [8, 5, 10], shape = null) {
  let g = clean(new THREE.BoxGeometry(w, h, d, segs[0], segs[1], segs[2]));
  const p = g.attributes.position, v = new THREE.Vector3(), c = new THREE.Vector3();
  const hx = Math.max(0, w / 2 - r), hy = Math.max(0, h / 2 - r), hz = Math.max(0, d / 2 - r);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    c.set(clamp(v.x, -hx, hx), clamp(v.y, -hy, hy), clamp(v.z, -hz, hz));
    const ox = v.x - c.x, oy = v.y - c.y, oz = v.z - c.z, l = Math.hypot(ox, oy, oz);
    if (l > 1e-7) v.set(c.x + ox / l * r, c.y + oy / l * r, c.z + oz / l * r);
    if (shape) shape(v);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
function cyl(rt, rb, h, seg = 18) { const g = clean(new THREE.CylinderGeometry(rt, rb, h, seg, 1)); g.computeVertexNormals(); return g; }
function merge(list) {
  // positions, normals and colours only; every part is indexed
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.color) col.set(g.attributes.color.array, vo * 3); else col.fill(1, vo * 3, (vo + g.attributes.position.count) * 3);
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i++) idx[io + i] = ix[i] + vo;
    vo += g.attributes.position.count; io += ix.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

const C_BODY = [0.032, 0.033, 0.035], C_SHELL = [0.05, 0.051, 0.054], C_DARK = [0.012, 0.012, 0.013], C_SEAM = [0.008, 0.008, 0.009];

function bodyGeometry() {
  const parts = [];
  // fuselage: narrower and slightly lower at the nose
  parts.push(colorize(roundBox(0.096, 0.062, 0.214, 0.022, [10, 7, 16], (v) => {
    const t = sat(-v.z / 0.214 + 0.5);
    v.x *= 1 - 0.3 * t * t; v.y *= 1 - 0.16 * t; v.y -= 0.006 * t;
  }), C_BODY));
  // top shell with the battery in it
  parts.push(colorize(roundBox(0.074, 0.014, 0.13, 0.0065, [6, 3, 10]).translate(0, 0.031, 0.024), C_SHELL));
  // battery grip ridges at the back
  for (let i = 0; i < 5; i++) parts.push(colorize(roundBox(0.06, 0.003, 0.0025, 0.001, [2, 1, 1]).translate(0, 0.0395, 0.064 + i * 0.0045), C_DARK));
  // seam where the shell meets the frame, and side vents
  parts.push(colorize(roundBox(0.0915, 0.0016, 0.18, 0.0008, [2, 1, 6]).translate(0, 0.012, 0.012), C_SEAM));
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) parts.push(colorize(roundBox(0.0015, 0.004, 0.012, 0.0006, [1, 1, 2]).translate(s * 0.0475, -0.004, 0.035 + i * 0.008), C_DARK));
  }
  // nose plate around the forward sensors, bottom plate around the downward sensors
  parts.push(colorize(roundBox(0.054, 0.024, 0.01, 0.006, [4, 3, 1]).translate(0, 0.004, -0.104), C_DARK));
  parts.push(colorize(roundBox(0.044, 0.004, 0.06, 0.002, [3, 1, 4]).translate(0, -0.031, 0.02), C_DARK));
  // arm hinge knuckles
  for (const [x, y, z] of [[-0.04, 0.006, -0.07], [0.04, 0.006, -0.07], [-0.035, -0.01, 0.075], [0.035, -0.01, 0.075]]) {
    parts.push(colorize(cyl(0.0085, 0.0085, 0.022, 14).translate(x, y, z), C_SHELL));
  }
  // rear feet
  for (const s of [-1, 1]) parts.push(colorize(roundBox(0.012, 0.022, 0.012, 0.004, [2, 3, 2]).translate(s * 0.026, -0.038, 0.088), C_DARK));
  // gimbal mount under the nose
  parts.push(colorize(roundBox(0.046, 0.009, 0.02, 0.003, [3, 1, 2]).translate(0, -0.032, -0.093), C_DARK));
  return merge(parts);
}

function glassGeometry() {
  const parts = [];
  for (const s of [-1, 1]) {
    parts.push(cyl(0.0062, 0.0062, 0.004, 16).rotateX(Math.PI / 2).translate(s * 0.017, 0.006, -0.11));
    parts.push(cyl(0.005, 0.005, 0.003, 14).translate(s * 0.012, -0.0335, 0.03));
  }
  return merge(parts);
}

// arm along local +X from the hinge; L = hinge to motor axis
function armGeometry(L, front) {
  const parts = [];
  parts.push(colorize(roundBox(L, 0.013, 0.017, 0.005, [12, 3, 3], (v) => {
    const t = sat(v.x / L + 0.5);
    v.z *= 1 - 0.32 * t; v.y *= 1 - 0.18 * t; v.y += 0.002 * t;
  }).translate(L / 2, 0, 0), C_BODY));
  // motor mount pad
  parts.push(colorize(cyl(0.0125, 0.0115, 0.008, 16).translate(L, 0.004, 0), C_BODY));
  if (front) {
    // landing leg under the front motors
    parts.push(colorize(roundBox(0.008, 0.034, 0.01, 0.0035, [2, 4, 2]).translate(L - 0.01, -0.02, 0), C_DARK));
  }
  return merge(parts);
}

function motorGeometry(L) {
  const parts = [];
  parts.push(cyl(0.0132, 0.0138, 0.013, 20).translate(L, 0.0145, 0));
  parts.push(cyl(0.0105, 0.012, 0.004, 20).translate(L, 0.0225, 0));
  parts.push(cyl(0.0045, 0.0045, 0.004, 10).translate(L, 0.0265, 0));
  return merge(parts);
}

// one twisted, tapered blade along +X from its hinge
function bladeGeometry(dir) {
  const R = 0.104, n = 10, pos = [], idx = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, r = 0.004 + t * (R - 0.004);
    const chord = (0.008 + 0.014 * Math.sin(Math.PI * Math.min(1, t * 1.3))) * (1 - 0.45 * t * t);
    const tw = 0.38 - 0.27 * t;
    const le = chord * 0.35, te = chord * 0.65;
    pos.push(r, Math.sin(tw) * le, -Math.cos(tw) * le * dir);
    pos.push(r, -Math.sin(tw) * te, Math.cos(tw) * te * dir);
    if (i < n) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function gimbalHeadGeometry() {
  const parts = [];
  parts.push(colorize(roundBox(0.034, 0.03, 0.03, 0.009, [5, 5, 5]), C_BODY));
  parts.push(colorize(cyl(0.0122, 0.0128, 0.012, 20).rotateX(Math.PI / 2).translate(0, 0, -0.019), C_DARK));
  return merge(parts);
}
function gimbalYokeGeometry() {
  const parts = [];
  for (const s of [-1, 1]) parts.push(colorize(roundBox(0.005, 0.03, 0.014, 0.002, [1, 3, 2]).translate(s * 0.021, -0.012, 0), C_DARK));
  return merge(parts);
}

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.18, 'rgba(255,255,255,0.65)'); g.addColorStop(0.5, 'rgba(255,255,255,0.12)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- materials
function droneMat(params, key, extra = '') {
  const m = new THREE.MeshStandardMaterial(params);
  patch(m, {
    key, uniforms: { uHide: HIDE },
    vertexPars: 'uniform float uHide;',
    vertexEnd: HIDE_VS,
    fragmentColor: `diffuseColor.rgb *= 1.0 - uWetness * 0.2; ${extra}`,
  });
  return m;
}

// ---------------------------------------------------------------- sound
class DroneAudio {
  constructor(audio) { this.a = audio; this.ok = false; }
  build() {
    if (this.ok) return true;
    const ctx = this.a.context, bus = this.a.worldBus;
    if (!ctx || !bus) return false;
    this.ctx = ctx;
    this.out = ctx.createGain(); this.out.gain.value = 0;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 9000; this.lp.Q.value = 0.4;
    this.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    this.mix = ctx.createGain();
    this.mix.connect(this.lp);
    if (this.pan) { this.lp.connect(this.pan); this.pan.connect(this.out); } else this.lp.connect(this.out);
    this.out.connect(bus);
    // small props sing around 2-3 kHz
    const peak = ctx.createBiquadFilter(); peak.type = 'peaking'; peak.frequency.value = 2600; peak.Q.value = 1.1; peak.gain.value = 6;
    const body = ctx.createBiquadFilter(); body.type = 'lowpass'; body.frequency.value = 5200; body.Q.value = 0.7;
    peak.connect(body); body.connect(this.mix);
    this.motors = [0, 1, 2, 3].map((i) => {
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
      const o2 = ctx.createOscillator(); o2.type = 'triangle';
      const g = ctx.createGain(); g.gain.value = 0;
      const g2 = ctx.createGain(); g2.gain.value = 0.35;
      o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(peak);
      o1.frequency.value = 1; o2.frequency.value = 1;
      o1.start(); o2.start();
      return { o1, o2, g, det: 1 + (i - 1.5) * 0.011 };
    });
    // prop wash: broadband air
    const n = ctx.sampleRate * 2, buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; b = b * 0.6 + w * 0.4; d[i] = b; }
    this.noise = buf;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    this.washBP = ctx.createBiquadFilter(); this.washBP.type = 'bandpass'; this.washBP.frequency.value = 700; this.washBP.Q.value = 0.55;
    this.wash = ctx.createGain(); this.wash.gain.value = 0;
    src.connect(this.washBP); this.washBP.connect(this.wash); this.wash.connect(this.mix);
    src.start();
    this.ok = true;
    return true;
  }
  update(omegas, level, lpHz, panV) {
    if (!this.build()) return;
    const now = this.ctx.currentTime, tc = 0.04;
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const m = this.motors[i], w = Math.max(0, omegas[i]);
      const f = Math.max(1, w / Math.PI * m.det);
      m.o1.frequency.setTargetAtTime(f, now, tc);
      m.o2.frequency.setTargetAtTime(f * 2.97, now, tc);
      const a = Math.pow(Math.min(1.6, w / HOVER), 1.5);
      m.g.gain.setTargetAtTime(a * 0.05, now, tc);
      sum += w;
    }
    const avg = sum / 4 / HOVER;
    this.wash.gain.setTargetAtTime(Math.pow(Math.min(1.5, avg), 2) * 0.22, now, tc);
    this.washBP.frequency.setTargetAtTime(400 + avg * 700, now, 0.1);
    this.out.gain.setTargetAtTime(level, now, 0.05);
    this.lp.frequency.setTargetAtTime(lpHz, now, 0.05);
    if (this.pan) this.pan.pan.setTargetAtTime(panV, now, 0.05);
  }
  // little chirps from the drone itself
  beep(freqs, gap = 0.12, dur = 0.07, lvl = 0.06) {
    if (!this.build()) return;
    const ctx = this.ctx, t0 = ctx.currentTime + 0.01;
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = 0;
      g.gain.setTargetAtTime(lvl, t0 + i * gap, 0.004);
      g.gain.setTargetAtTime(0, t0 + i * gap + dur, 0.012);
      o.connect(g); g.connect(this.lp);
      o.start(t0 + i * gap); o.stop(t0 + i * gap + dur + 0.1);
    });
  }
  click(lvl = 0.12) {
    if (!this.build()) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = this.noise; s.playbackRate.value = 2.4;
    const hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 3200; hp.Q.value = 2.5;
    const g = ctx.createGain(); g.gain.value = 0;
    g.gain.setTargetAtTime(lvl, t0, 0.001); g.gain.setTargetAtTime(0, t0 + 0.012, 0.008);
    s.connect(hp); hp.connect(g); g.connect(this.lp);
    s.start(t0, Math.random()); s.stop(t0 + 0.08);
  }
  // the video link coming up / dropping, heard by the pilot (not spatial)
  link(up) {
    if (!this.build()) return;
    const ctx = this.ctx, t0 = ctx.currentTime + 0.01, bus = this.a.worldBus;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(up ? 880 : 1320, t0);
    o.frequency.exponentialRampToValueAtTime(up ? 1320 : 880, t0 + 0.14);
    const g = ctx.createGain(); g.gain.value = 0;
    g.gain.setTargetAtTime(0.035, t0, 0.01); g.gain.setTargetAtTime(0, t0 + 0.13, 0.03);
    o.connect(g); g.connect(bus); o.start(t0); o.stop(t0 + 0.4);
    const s = ctx.createBufferSource(); s.buffer = this.noise; s.playbackRate.value = 1.7;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 0.8;
    const g2 = ctx.createGain(); g2.gain.value = 0;
    g2.gain.setTargetAtTime(0.05, t0, 0.01); g2.gain.setTargetAtTime(0, t0 + 0.2, 0.06);
    s.connect(bp); bp.connect(g2); g2.connect(bus); s.start(t0); s.stop(t0 + 0.6);
  }
}

// ---------------------------------------------------------------- the drone
const ARMS = [
  // hinge, arm length, unfolded / folded yaw, folded droop, spin direction, front
  { p: [-0.04, 0.006, -0.07], L: 0.128, open: 2.65, shut: 1.64, droop: 0, spin: 1, front: true },
  { p: [0.04, 0.006, -0.07], L: 0.128, open: 0.49, shut: 1.5, droop: 0, spin: -1, front: true },
  { p: [-0.035, -0.01, 0.075], L: 0.122, open: -2.5, shut: -1.62, droop: -0.26, spin: -1, front: false },
  { p: [0.035, -0.01, 0.075], L: 0.122, open: -0.64, shut: -1.52, droop: -0.26, spin: 1, front: false },
];

export class Drone {
  constructor({ scene, camera, player, world, cliffs, audio, game, envMap }) {
    this.camera = camera; this.player = player; this.world = world; this.cliffs = cliffs; this.game = game;
    this.sound = new DroneAudio(audio);
    this.state = 'docked';
    this.view = 'fp';
    this.t = 0; this.time = 0;
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3(); this.acc = new THREE.Vector3();
    this.yaw = 0; this.tiltP = 0; this.tiltR = 0; this.carryP = 0; this.carryR = 0; this.crouch = 0;
    this.camYaw = 0; this.camPitch = 0; this.gYaw = 0; this.gPitch = 0;
    this.omega = 0; this.omegas = [0, 0, 0, 0]; this.spinA = [0, 0, 0, 0];
    this.armOpen = [0, 0, 0, 0]; this.bladeOpen = 0; this.led = 0;
    this.battery = 100; this.rec = 0; this.speedScale = 1; this.signal = 1;
    this.cut = 0; this.cutTarget = 0; this.home = new THREE.Vector3();
    this.keys = new Set(); this.inputOn = false;
    this.lowWarned = false; this.message = ''; this.messageT = 0;
    this._o = { x: 0, z: 0 }; this._row = [0, 0, 0, 0];
    this._q = new THREE.Quaternion(); this._e = new THREE.Euler(0, 0, 0, 'YXZ'); this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3();
    this._hudT = 0;

    this.build(scene, envMap);
    this.initHud();

    window.addEventListener('keydown', (e) => {
      if (!e.repeat) this.keys.add(e.code);
      if (this.view === 'feed' && (e.code === 'Space' || e.code === 'KeyC')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (!this.inputOn || document.pointerLockElement == null || this.view !== 'feed') return;
      const s = this.player.sens * 0.9;
      this.camYaw -= e.movementX * s;
      this.camPitch -= e.movementY * s * (this.player.invertY ? -1 : 1);
      this.camPitch = clamp(this.camPitch, -1.5, 0.45);   // gimbal: straight down to 25 deg up
    });
    window.addEventListener('wheel', (e) => {
      if (!this.inputOn || this.view !== 'feed') return;
      this.speedScale = clamp(this.speedScale * Math.exp(-e.deltaY * 0.0012), 0.3, 2.2);
      this.flash(`Speed ${Math.round(this.speedScale * 100)}%`);
    }, { passive: true });
  }

  get busy() { return this.state !== 'docked'; }
  get feed() { return this.view === 'feed'; }

  // ------------------------------------------------------------ model
  build(scene, envMap) {
    const g = this.group = new THREE.Group();
    g.visible = false;
    scene.add(g);
    const body = droneMat({ vertexColors: true, roughness: 0.46, metalness: 0.1, envMap, envMapIntensity: 0.9 }, 'droneBody');
    const metal = droneMat({ color: 0x9a9da2, roughness: 0.32, metalness: 0.9, envMap, envMapIntensity: 1.0 }, 'droneMetal');
    const glass = droneMat({ color: 0x050608, roughness: 0.06, metalness: 0.4, envMap, envMapIntensity: 1.5 }, 'droneGlass');
    const lens = droneMat({ color: 0x0a0d18, roughness: 0.04, metalness: 0.6, envMap, envMapIntensity: 1.8 }, 'droneLens');
    const blade = droneMat({ color: 0x15161a, roughness: 0.5, metalness: 0.05, envMap, envMapIntensity: 0.6, side: THREE.DoubleSide }, 'droneBlade');
    const disc = new THREE.MeshLambertMaterial({ color: 0x1a1b1e, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    patch(disc, {
      key: 'droneDisc', uniforms: { uHide: HIDE, uSpin: SPIN },
      vertexPars: 'uniform float uHide; varying vec2 vDUv;',
      vertexMain: 'vec3 pos = position; vec3 nrm = normal; float ao = 1.0; vDUv = uv;',
      vertexEnd: HIDE_VS,
      fragmentPars: 'uniform float uSpin; varying vec2 vDUv;',
      fragmentColor: `
        float rr = length(vDUv - 0.5) * 2.0;
        float a = smoothstep(0.08, 0.2, rr) * (1.0 - smoothstep(0.93, 1.0, rr));
        a *= 0.13 + 0.12 * smoothstep(0.7, 0.95, rr);
        diffuseColor.a = a * uSpin;
      `,
    });
    this.materials = [body, metal, glass, lens, blade];

    const add = (geo, mat, parent, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadow; m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    this.frame = new THREE.Group();   // the airframe: tilts and bobs inside the group
    g.add(this.frame);
    add(bodyGeometry(), body, this.frame);
    add(glassGeometry(), glass, this.frame, false);

    // gimbal: the yoke hangs from the body, the head is stabilised in world space
    this.gimbal = new THREE.Group();
    this.gimbal.position.set(0, -0.038, -0.094);
    this.frame.add(this.gimbal);
    add(gimbalYokeGeometry(), body, this.gimbal);
    this.head = new THREE.Group();
    this.head.position.set(0, -0.022, 0);
    this.gimbal.add(this.head);
    add(gimbalHeadGeometry(), body, this.head);
    add(cyl(0.0095, 0.0095, 0.002, 20).rotateX(Math.PI / 2).translate(0, 0, -0.0255), lens, this.head, false);

    this.glow = glowTexture();
    const ledMat = (c) => new THREE.MeshBasicMaterial({ color: c });
    const spriteMat = (c) => new THREE.SpriteMaterial({ map: this.glow, color: c, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
    this.leds = [];
    this.arms = ARMS.map((d, i) => {
      const pivot = new THREE.Group();
      pivot.position.set(d.p[0], d.p[1], d.p[2]);
      pivot.rotation.order = 'YZX';
      this.frame.add(pivot);
      add(armGeometry(d.L, d.front), body, pivot);
      add(motorGeometry(d.L), metal, pivot);
      const prop = new THREE.Group();
      prop.position.set(d.L, 0.029, 0);
      pivot.add(prop);
      const blades = [0, 1].map((k) => {
        const hinge = new THREE.Group();
        hinge.position.set(k ? -0.0045 : 0.0045, 0, 0);
        prop.add(hinge);
        const m = add(bladeGeometry(d.spin), blade, hinge, false);
        return { hinge, mesh: m, k };
      });
      const dsk = new THREE.Mesh(new THREE.CircleGeometry(0.106, 48).rotateX(-Math.PI / 2), disc);
      dsk.position.set(d.L, 0.03, 0);
      dsk.renderOrder = 5;
      pivot.add(dsk);
      // navigation light under each motor: white at the front, red at the back
      const col = d.front ? new THREE.Color(1, 0.97, 0.9) : new THREE.Color(1, 0.06, 0.03);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.0034, 10, 6), ledMat(0x000000));
      led.position.set(d.L, -0.0015, 0);
      pivot.add(led);
      const sp = new THREE.Sprite(spriteMat(col.clone()));
      sp.position.copy(led.position); sp.scale.setScalar(0.04);
      pivot.add(sp);
      this.leds.push({ mesh: led, sprite: sp, col, front: d.front, i });
      return { d, pivot, prop, blades, disc: dsk };
    });
    // status light at the back of the body
    const st = new THREE.Mesh(new THREE.SphereGeometry(0.003, 10, 6), ledMat(0x000000));
    st.position.set(0, 0.012, 0.108);
    this.frame.add(st);
    const stS = new THREE.Sprite(spriteMat(new THREE.Color(0.15, 1, 0.3)));
    stS.position.copy(st.position); stS.scale.setScalar(0.03);
    this.frame.add(stS);
    this.status = { mesh: st, sprite: stS, col: new THREE.Color(0.15, 1, 0.35) };
  }

  setEnv(t) { for (const m of this.materials) m.envMap = t; }

  // ------------------------------------------------------------ HUD
  initHud() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      hud: $('drone-hud'), rec: $('dh-rec'), mode: $('dh-mode'), sig: $('dh-sig'), batFill: $('dh-bat-fill'), batP: $('dh-batp'),
      h: $('dh-h'), d: $('dh-d'), hs: $('dh-hs'), vs: $('dh-vs'), head: $('dh-head'), horizon: $('dh-horizon'), warn: $('dh-warn'),
      fx: $('feed-fx'), cut: $('feed-cut'), noise: $('feed-noise'),
    };
    const c = this.el.noise;
    if (c) {
      c.width = 480; c.height = 270;
      this.nctx = c.getContext('2d');
      this.nimg = this.nctx.createImageData(480, 270);
    }
  }

  flash(text, secs = 1.6) { this.message = text; this.messageT = secs; }

  drawNoise(amount) {
    if (!this.nctx) return;
    const el = this.el.noise;
    if (amount < 0.004) { if (el.style.opacity !== '0') el.style.opacity = '0'; return; }
    const d = this.nimg.data;
    // grain, plus torn horizontal bands when the link is breaking up
    const tear = amount > 0.25 ? Math.random() : 1;
    for (let y = 0; y < 270; y++) {
      const band = tear < 0.5 && Math.abs(y - tear * 540) < 8 ? 1.8 : 1;
      for (let x = 0; x < 480; x++) {
        const v = Math.min(255, Math.random() * 255 * band);
        const k = (y * 480 + x) * 4;
        d[k] = d[k + 1] = d[k + 2] = v; d[k + 3] = 255;
      }
    }
    this.nctx.putImageData(this.nimg, 0, 0);
    el.style.opacity = String(Math.min(0.9, amount));
    el.style.transform = amount > 0.3 ? `translateX(${(Math.random() - 0.5) * 8}px)` : '';
  }

  updateHud(dt) {
    const el = this.el;
    if (!el.hud) return;
    const feed = this.view === 'feed';
    el.hud.classList.toggle('show', feed && this.cut < 0.6);
    el.fx.classList.toggle('show', feed);
    el.cut.style.opacity = String(this.cut);
    const noise = (feed ? 0.03 + (1 - this.signal) * 0.55 : 0) + this.cut * 0.32;
    this.drawNoise(noise);
    if (!feed) return;
    this._hudT -= dt;
    if (this._hudT > 0) return;
    this._hudT = 0.1;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const pp = this.player.pos;
    const dist = Math.hypot(this.pos.x - pp.x, this.pos.z - pp.z);
    el.h.textContent = (this.pos.y - this.home.y).toFixed(1);
    el.d.textContent = dist < 1000 ? dist.toFixed(0) : (dist / 1000).toFixed(2) + 'k';
    el.hs.textContent = hs.toFixed(1);
    el.vs.textContent = (Math.abs(this.vel.y) < 0.05 ? 0 : this.vel.y).toFixed(1);
    const b = Math.max(0, this.battery);
    el.batP.textContent = `${Math.round(b)}%`;
    el.batFill.style.width = `${b}%`;
    el.batFill.classList.toggle('low', b < 20);
    const bars = Math.ceil(this.signal * 4 - (this.signal < 0.5 && Math.random() < 0.3 ? 1 : 0));
    [...el.sig.children].forEach((s, i) => s.classList.toggle('on', i < bars));
    const r = Math.floor(this.rec);
    el.rec.textContent = `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
    const hd = ((-this.gYaw * 180 / Math.PI) % 360 + 360) % 360;
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    el.head.textContent = `${names[Math.round(hd / 45) % 8]} ${String(Math.round(hd) % 360).padStart(3, '0')}°`;
    el.mode.textContent = this.state === 'returning' ? 'RETURNING' : this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 'SPORT' : 'NORMAL';
    el.horizon.setAttribute('transform', `rotate(${(this.tiltR * 180 / Math.PI).toFixed(1)}) translate(0 ${(-this.tiltP * 40).toFixed(1)})`);
    let w = '';
    if (this.messageT > 0) w = this.message;
    else if (this.state === 'returning') w = this.battery < 11 ? 'Low battery · returning to pilot' : 'Returning to pilot · move to take over';
    else if (this.battery < 20) w = 'Battery low';
    else if (this.deep) w = 'Signal fading in the chasm';
    else if (this.signal < 0.45) w = 'Weak signal · fly back toward the pilot';
    el.warn.textContent = w;
    el.warn.classList.toggle('show', !!w);
  }

  // ------------------------------------------------------------ control
  toggle() {
    if (this.state === 'docked') return this.startDeploy();
    if (this.state === 'flying') return this.startReturn();
    return false;
  }

  spot(yaw, dist) {
    const p = this.player.pos;
    const x = p.x - Math.sin(yaw) * dist, z = p.z - Math.cos(yaw) * dist;
    return new THREE.Vector3(x, this.player.groundAt(x, z), z);
  }
  spotOk(s) {
    if (Math.abs(s.y - this.player.pos.y) > 0.9) return false;
    if (this.world.inChasm(s.x, s.z, -3)) return false;
    if (this.world.creekWaterAt(s.x, s.z) > s.y - 0.03) return false;
    const n = this.world.normalAt ? this.world.normalAt(s.x, s.z, this._v) : null;
    if (n && n.y < 0.8) return false;
    const o = this.world.collide(s.x, s.z, 0.32, s.y + 0.1, this._o);
    return Math.hypot(o.x - s.x, o.z - s.z) < 0.01;
  }
  // somewhere clear in front of the pilot: open ground beats tall grass, straight ahead beats off to the side
  findSpot(yaw) {
    let best = null, bs = 1e9;
    for (const off of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.2, -1.2]) for (const d of [1.25, 1.5, 1.8, 2.15]) {
      const s = this.spot(yaw + off, d);
      if (!this.spotOk(s)) continue;
      const score = this.world.grassAt(s.x, s.z) * 2.2 + Math.abs(off) * 0.3 + Math.abs(d - 1.3) * 0.35;
      if (score < bs) { bs = score; best = s; }
    }
    return best;
  }

  // tall grass would swallow a 35 cm drone: press it flat around the launch spot, like a pilot treading it down
  trample(s) {
    const w = this.world, tex = w.maskTex, d = tex && tex.image && tex.image.data;
    if (!d) return;
    this.untrample();
    const M = w.maskRes, cell = w.size / M;
    const fx = (s.x + w.size / 2) / cell - 0.5, fz = (s.z + w.size / 2) / cell - 0.5;
    const i0 = Math.floor(fx), j0 = Math.floor(fz);
    const list = [];
    for (let j = j0 - 1; j <= j0 + 2; j++) for (let i = i0 - 1; i <= i0 + 2; i++) {
      if (i < 0 || j < 0 || i >= M || j >= M) continue;
      const cx = (i + 0.5) * cell - w.size / 2, cz = (j + 0.5) * cell - w.size / 2;
      const dist = Math.hypot(cx - s.x, cz - s.z);
      const lim = dist < 1.8 ? 40 : dist < 3.2 ? 90 : 255;
      const k = (j * M + i) * 4 + 1;
      if (d[k] > lim) { list.push(k, d[k]); d[k] = lim; }
    }
    if (list.length) { this.trampled = list; tex.needsUpdate = true; }
  }
  untrample() {
    const tex = this.world.maskTex, l = this.trampled;
    if (!l || !tex) return;
    const d = tex.image.data;
    for (let i = 0; i < l.length; i += 2) d[l[i]] = l[i + 1];
    tex.needsUpdate = true;
    this.trampled = null;
  }

  startDeploy() {
    const pl = this.player;
    const L = this.findSpot(pl.yaw);
    if (!L) { this.game?.toast('No clear ground here to set the drone down', 3); return false; }
    const eye = this._v.set(pl.pos.x, pl.pos.y + EYE, pl.pos.z);
    const hd = Math.hypot(L.x - eye.x, L.z - eye.z);
    this.D = {
      L, yaw0: Math.atan2(-(L.x - pl.pos.x), -(L.z - pl.pos.z)), p0: pl.pitch, y0: pl.yaw,
      pDown: Math.atan2(L.y + 0.05 - eye.y, hd),
      from: new THREE.Vector3(eye.x - Math.sin(pl.yaw) * 0.3 + Math.cos(pl.yaw) * 0.14, eye.y - 0.62, eye.z - Math.cos(pl.yaw) * 0.3 - Math.sin(pl.yaw) * 0.14),
      clicks: [false, false, false, false], beeped: false, linked: false,
    };
    pl.enabled = false;
    if (this.world.grassAt(L.x, L.z) > 0.2) this.trample(L);
    this.state = 'deploy'; this.t = 0;
    this.omega = 0; this.armOpen.fill(0); this.bladeOpen = 0; this.led = 0;
    this.vel.set(0, 0, 0);
    this.yaw = this.D.yaw0;
    this.home.copy(L);
    return true;
  }

  startReturn() {
    if (this.state !== 'flying') return false;
    const pl = this.player;
    this.T = this.findSpot(pl.yaw) || this.spot(pl.yaw, 1.5);
    if (this.world.grassAt(this.T.x, this.T.z) > 0.2) this.trample(this.T);
    this.state = 'returning'; this.t = 0;
    this.cruise = null;
    return true;
  }

  // ------------------------------------------------------------ per frame
  update(dt, ctl) {
    this.time += dt;
    this.inputOn = !!(ctl && ctl.input) || !!this.forceInput;   // forceInput: automated tests without pointer lock
    this.t += dt;
    if (this.messageT > 0) this.messageT -= dt;
    const pl = this.player;
    switch (this.state) {
      case 'docked':
        this.battery = Math.min(100, this.battery + dt * 1.5);
        this.group.visible = false;
        this.cut += (0 - this.cut) * damp(8, dt);
        this.sound.ok && this.sound.update([0, 0, 0, 0], 0, 3000, 0);
        this.updateHud(dt);
        return;
      case 'deploy': this.deploy(dt); break;
      case 'flying': this.fly(dt, true); break;
      case 'returning': this.fly(dt, false); break;
      case 'cutback': this.fly(dt, false); this.cutback(dt); break;
      case 'approach': this.fly(dt, false); this.trackLook(dt, 3.2); break;
      case 'landing': this.land(dt); this.trackLook(dt, 3.2); break;
      case 'stow': this.stow(dt); break;
    }
    if (this.state === 'docked') { this.updateHud(dt); return; }
    this.pose(dt);
    if (this.view === 'feed') {
      this.rec += dt;
      this.applyFeedCamera(dt);
    } else {
      pl.applyCamera(0);
      if (this.crouch > 0.001) {
        const c = this.camera, ln = this.crouch * 0.35;
        c.position.y -= this.crouch;
        c.position.x -= Math.sin(pl.yaw) * ln; c.position.z -= Math.cos(pl.yaw) * ln;
      }
    }
    this.lights(dt);
    this.audioUpdate();
    this.updateHud(dt);
  }

  // deploy timeline (seconds): look down, set it down, unfold, lights, spin up, lift off, switch to the feed
  deploy(dt) {
    const D = this.D, t = this.t, pl = this.player;
    // the pilot crouches to set it down and stands again as the motors spool up
    this.crouch = 0.68 * (smoother(sat((t - 0.1) / 0.9)) - smoother(sat((t - 3.4) / 0.9)));
    const lean = this.crouch * 0.35;
    const eyeY = pl.pos.y + EYE - this.crouch;
    const hdL = Math.max(0.4, Math.hypot(D.L.x - pl.pos.x, D.L.z - pl.pos.z) - lean);
    // the pilot's head: down to the ground, then up after the drone
    if (t <= 4.2) pl.pitch = lerp(D.p0, Math.atan2(D.L.y + 0.05 - eyeY, hdL), smoother(sat(t / 1.2)));
    else {
      // the head follows the drone up with a little lag, as a person's does
      const hd = Math.hypot(this.pos.x - pl.pos.x, this.pos.z - pl.pos.z) - lean;
      const track = Math.atan2(this.pos.y - eyeY, Math.max(0.6, hd));
      pl.pitch += (track - pl.pitch) * damp(3.8 * smooth(sat((t - 4.2) / 0.5)), dt);
    }
    // carried in from below the view and set down
    this.group.visible = t > 0.4;
    if (t < 1.55) {
      const u = sat((t - 0.4) / 1.15), e = smoother(u);
      // from just below the bottom of the view, wherever the head is right now
      D.from.set(pl.pos.x - Math.sin(pl.yaw) * (0.3 + lean) + Math.cos(pl.yaw) * 0.14, eyeY - 0.55, pl.pos.z - Math.cos(pl.yaw) * (0.3 + lean) - Math.sin(pl.yaw) * 0.14);
      const p1 = this._v2.set(D.L.x + (D.from.x - D.L.x) * 0.25, D.L.y + 0.42, D.L.z + (D.from.z - D.L.z) * 0.25);
      const a = (1 - e) * (1 - e), b = 2 * (1 - e) * e, c = e * e;
      this.pos.set(a * D.from.x + b * p1.x + c * D.L.x, a * D.from.y + b * p1.y + c * (D.L.y + FOOT), a * D.from.z + b * p1.z + c * D.L.z);
      this.yaw = D.yaw0 + 0.55 * (1 - e);
      this.carryP = 0.32 * (1 - e); this.carryR = 0.18 * (1 - e);
    } else {
      const s = t - 1.55;
      // a small settle on the feet
      this.pos.set(D.L.x, D.L.y + FOOT - 0.0025 * Math.exp(-s * 9) * Math.sin(s * 30), D.L.z);
      this.carryP = 0; this.carryR = 0; this.yaw = D.yaw0;
    }
    // arms swing out one after another and click into place
    for (let i = 0; i < 4; i++) {
      const a = (t - (1.75 + i * 0.24)) / 0.55;
      this.armOpen[i] = detent(sat(a));
      if (a >= 1 && !D.clicks[i]) { D.clicks[i] = true; this.sound.click(); }
    }
    this.led = sat((t - 2.95) / 0.25);
    if (t > 3.0 && !D.beeped) { D.beeped = true; this.sound.beep([1320, 1760, 2093]); }
    if (t > 3.3) this.omega = IDLE * smooth(sat((t - 3.3) / 1.0));
    if (t > 4.3) {
      const u = sat((t - 4.3) / 1.4);
      const h = (EYE + 0.62) * smoother(u);
      this.omega = lerp(IDLE, HOVER * (1.08 - 0.08 * u), sat((t - 4.25) / 0.25));
      const sway = Math.sin(t * 3.1) * 0.012 * u;
      this.pos.set(D.L.x + sway, D.L.y + FOOT + h, D.L.z + Math.cos(t * 2.3) * 0.008 * u);
      this.vel.set(0, (EYE + 0.62) * 30 * u * u * (1 - u) * (1 - u) / 1.4, 0);
    }
    this.bladeOpen = sstep(25, 110, this.omega);
    for (let i = 0; i < 4; i++) this.omegas[i] = this.omega * (1 + (i - 1.5) * 0.004);
    // into the video feed
    this.cut = t < 5.3 ? 0 : t < 5.58 ? smooth((t - 5.3) / 0.28) : Math.max(0, 1 - (t - 5.58) / 0.42);
    if (t >= 5.58 && this.view === 'fp') {
      this.view = 'feed';
      HIDE.value = 1;
      this.camYaw = this.gYaw = D.y0; this.camPitch = this.gPitch = -0.08;
      this.yaw = D.yaw0;
      this.sound.link(true);
      this.rec = 0;
    }
    if (t >= 6.0) { this.state = 'flying'; this.t = 0; this.cut = 0; this.crouch = 0; }
  }

  // shared flight: manual input or the return autopilot
  fly(dt, manual) {
    const k = this.keys, pl = this.player;
    let f = 0, s = 0, u = 0;
    const fast = k.has('ShiftLeft') || k.has('ShiftRight');
    if (this.inputOn && this.view === 'feed') {
      f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
      s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
      u = (k.has('Space') ? 1 : 0) - (k.has('KeyC') ? 1 : 0);
    }
    // taking the sticks cancels a return (unless the battery forces it)
    if (!manual && this.state === 'returning' && (f || s || u) && this.battery > 11) { this.state = 'flying'; this.t = 0; manual = true; this.flash('Return cancelled'); }
    let tvx, tvy, tvz, kH = 2.4;
    if (manual) {
      const vmax = (fast ? 21 : 8.5) * this.speedScale;
      const cy = Math.cos(this.camYaw), sy = Math.sin(this.camYaw);
      let mx = -sy * f + cy * s, mz = -cy * f - sy * s;
      const l = Math.hypot(mx, mz); if (l > 1) { mx /= l; mz /= l; }
      tvx = mx * vmax; tvz = mz * vmax; tvy = u * (fast ? 6 : 3.4);
      // the body turns to where the camera looks
      const dy = wrapA(this.camYaw - this.yaw);
      this.yaw += clamp(dy * damp(5, dt), -2.4 * dt, 2.4 * dt);
      this.fast = fast;
    } else {
      [tvx, tvy, tvz] = this.autopilot(dt);
      kH = 1.8;
    }
    this.physics(dt, tvx, tvy, tvz, kH);
    // battery: hover costs, sprinting and climbing cost more
    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.battery -= dt * (0.11 + 0.07 * hs / 21 + 0.05 * Math.max(0, this.vel.y) / 6);
    if (this.battery < 20 && !this.lowWarned) { this.lowWarned = true; this.sound.beep([988, 988, 988], 0.18, 0.09, 0.05); }
    if (this.battery < 10 && this.state === 'flying') { this.startReturn(); this.flash('Battery low · returning to pilot', 3); }
    if (this.battery > 25) this.lowWarned = false;
    // back in sight of the pilot: switch to their eyes and watch it come in
    if (this.state === 'returning') {
      const dh = Math.hypot(this.pos.x - this.T.x, this.pos.z - this.T.z);
      if (dh < 18 && Math.abs(this.pos.y - this.T.y) < 30) { this.state = 'cutback'; this.t = 0; }
    }
  }

  autopilot(dt) {
    const T = this.T, p = this.pos;
    const dx = T.x - p.x, dz = T.z - p.z, dh = Math.hypot(dx, dz) || 1e-6;
    // cruise height: clear the ground and trees along the way, decided once
    if (this.cruise == null) {
      let top = Math.max(p.y, T.y + 6);
      for (let i = 0; i <= 24; i++) {
        const t = i / 24, x = p.x + dx * t, z = p.z + dz * t;
        top = Math.max(top, this.world.heightAt(x, z) + (this.world.forestAt(x, z) > 0.2 ? 32 : 14));
      }
      this.cruise = top;
    }
    const vmax = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 22 : 15);
    const vh = Math.min(vmax, Math.sqrt(2 * 2.6 * Math.max(0, dh - 0.3)));
    // climb before flying far, glide down over the last 70 m to 2.4 m above the landing spot
    const climbFirst = p.y < this.cruise - 4 && dh > 70;
    const hFactor = climbFirst ? 0.25 : 1;
    let ty;
    if (dh > 70) ty = this.cruise;
    else ty = lerp(T.y + 2.4, Math.max(this.cruise, T.y + 2.4), smooth(sat((dh - 6) / 64)));
    const tvy = clamp((ty - p.y) * 1.1, -4, 5);
    // keep the camera on the way home
    const head = Math.atan2(-dx, -dz);
    if (this.view === 'feed') {
      // turn toward home at an aircraft's pace, not a snap pan
      this.camYaw += clamp(wrapA(head - this.camYaw) * damp(1.6, dt), -1.3 * dt, 1.3 * dt);
      this.camPitch += (-0.22 - this.camPitch) * damp(1.2, dt);
    }
    this.yaw += clamp(wrapA(head - this.yaw) * damp(3, dt), -2 * dt, 2 * dt);
    // close in: hand over to the landing
    if ((this.state === 'approach') && dh < 0.45 && p.y - T.y < 3.2) { this.state = 'landing'; this.t = 0; }
    return [dx / dh * vh * hFactor, tvy, dz / dh * vh * hFactor];
  }

  physics(dt, tvx, tvy, tvz, kH) {
    const v = this.vel, p = this.pos, T = this.time;
    let ax = (tvx - v.x) * kH, az = (tvz - v.z) * kH, ay = (tvy - v.y) * 3.2;
    const amax = this.fast ? 15 : 10;
    const ah = Math.hypot(ax, az);
    if (ah > amax) { ax *= amax / ah; az *= amax / ah; }
    ay = clamp(ay, -7, 8);
    // gusts: the flight controller cancels most of the push, the rest shows as buffeting
    const w = G.uWind.value, wd = G.uWindDir.value;
    const gust = 0.5 + 0.5 * Math.sin(T * 0.7 + Math.sin(T * 0.23) * 2);
    const bx = (Math.sin(T * 1.9) + Math.sin(T * 3.1 + 1)) * 0.5, bz = (Math.sin(T * 2.3 + 2) + Math.sin(T * 3.7)) * 0.5, by = Math.sin(T * 2.9 + 0.5);
    ax += (wd.x * gust * 0.5 + bx * 0.6) * w * 1.4;
    az += (wd.y * gust * 0.5 + bz * 0.6) * w * 1.4;
    ay += by * w * 0.6;
    v.x += ax * dt; v.y += ay * dt; v.z += az * dt;
    this.acc.set(ax, ay, az);
    p.addScaledVector(v, dt);
    this.constrain(dt);
    // attitude: lean into the acceleration, and against the drag at speed
    const tx = (ax + v.x * 0.3) / 9.81, tz = (az + v.z * 0.3) / 9.81;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const fwd = -tx * sy - tz * cy, right = tx * cy - tz * sy;
    const pT = clamp(Math.atan(fwd), -0.44, 0.44), rT = clamp(Math.atan(right), -0.44, 0.44);
    this.pErr = pT - this.tiltP; this.rErr = rT - this.tiltR;
    this.tiltP += this.pErr * damp(8, dt);
    this.tiltR += this.rErr * damp(8, dt);
    // motors: hover thrust, plus what it takes to climb and to tilt
    const base = (9.81 + ay) / 9.81 / Math.max(0.6, Math.cos(this.tiltP) * Math.cos(this.tiltR));
    const yawRate = this._lastYaw == null ? 0 : wrapA(this.yaw - this._lastYaw) / Math.max(dt, 1e-3);
    this._lastYaw = this.yaw;
    for (let i = 0; i < 4; i++) {
      const d = ARMS[i];
      const th = Math.max(0.2, base * (1 + 0.6 * (d.front ? -1 : 1) * this.pErr + 0.6 * (d.p[0] < 0 ? 1 : -1) * this.rErr + 0.08 * d.spin * yawRate));
      const target = HOVER * Math.sqrt(th);
      this.omegas[i] += (target - this.omegas[i]) * damp(14, dt);
    }
    this.omega = (this.omegas[0] + this.omegas[1] + this.omegas[2] + this.omegas[3]) / 4;
    this.bladeOpen = 1;
  }

  constrain(dt) {
    const p = this.pos, v = this.vel, pl = this.player;
    // range: the link weakens, then the drone refuses to go further
    const dx = p.x - pl.pos.x, dz = p.z - pl.pos.z, d = Math.hypot(dx, dz);
    this.signal = 1 - sstep(880, RANGE_HARD - 30, d);
    if (d > RANGE_SOFT) {
      const k = (d - RANGE_SOFT) / (RANGE_HARD - RANGE_SOFT);
      v.x -= dx / d * k * 9 * dt; v.z -= dz / d * k * 9 * dt;
      if (d > RANGE_HARD) {
        p.x = pl.pos.x + dx / d * RANGE_HARD; p.z = pl.pos.z + dz / d * RANGE_HARD;
        const out = (v.x * dx + v.z * dz) / d;
        if (out > 0) { v.x -= dx / d * out; v.z -= dz / d * out; }
      }
    }
    // trunks, towers and other solid things
    const o = this.world.collide(p.x, p.z, 0.3, p.y - 0.12, this._o);
    if (Math.abs(o.x - p.x) + Math.abs(o.z - p.z) > 1e-4) {
      const nx = o.x - p.x, nz = o.z - p.z, nl = Math.hypot(nx, nz);
      const vn = (v.x * nx + v.z * nz) / nl;
      if (vn < 0) { v.x -= nx / nl * vn * 1.3; v.z -= nz / nl * vn * 1.3; }
      p.x = o.x; p.z = o.z;
    }
    // the chasm walls are rock: stay off the face
    const cs = this.cliffs && this.cliffs.shape;
    let floor = null;
    if (cs && this.world.cliffRow) {
      const zc = chasmCentre(p.x);
      if (Math.abs(p.z - zc) < 230) {
        const wall = p.z >= zc ? 0 : 1, side = wall === 0 ? 1 : -1;
        const row = this.world.cliffRow(p.x, wall, this._row);
        if (p.y < row[1] - 0.2) {
          const fz = cs.faceZ(p.x, p.y, wall);
          const pen = side * (p.z - fz) + 0.8;
          if (pen > 0) { p.z -= side * pen; const vn = side * v.z; if (vn > 0) v.z -= side * vn * 1.4; }
        }
        // over the drop the ground below is the chasm floor; the heightmap there is the hidden batter behind the rock
        if (this.world.chasmEdgeDist(p.x, p.z) < -0.5) {
          // the link dies in the mist and the rock walls: about 70 m down is as deep as it goes
          floor = Math.max(row[3], row[1] - 70.8);
          this.signal *= 1 - 0.75 * sstep(35, 70, row[1] - p.y);
          this.deep = row[1] - p.y > 55;
        } else this.deep = false;
      }
    }
    // ground, water and the ceiling
    const gx = p.x + v.x * 0.35, gz = p.z + v.z * 0.35;
    const g0 = floor ?? Math.max(pl.groundAt(p.x, p.z), this.world.creekWaterAt(p.x, p.z));
    const g1 = floor ?? Math.max(pl.groundAt(gx, gz), this.world.creekWaterAt(gx, gz));
    const n = this.world.normalAt(p.x, p.z, this._v2);
    const landing = this.state === 'landing';
    // steep ground is drawn as rock that stands proud of the heightmap: keep well off it
    const clear = landing ? FOOT : floor == null && 1 - n.y > 0.35 ? 3.0 : 0.8;
    const minY = (landing ? g0 : Math.max(g0, g1 - 0.4)) + clear;
    if (!landing && p.y < minY + 0.6) v.y += (minY + 0.6 - p.y) * 6 * dt;   // cushion
    if (p.y < minY) { p.y = minY; if (v.y < 0) v.y = 0; }
    const maxY = g0 + 300;
    if (p.y > maxY) { p.y = maxY; if (v.y > 0) v.y = 0; }
  }

  cutback(dt) {
    const t = this.t;
    this.cut = t < 0.25 ? smooth(t / 0.25) : Math.max(0, 1 - (t - 0.25) / 0.4);
    if (t >= 0.25 && this.view === 'feed') {
      this.view = 'fp';
      HIDE.value = 0;
      this.sound.link(false);
      // the pilot starts out looking at the drone
      this.trackLook(1, 1000);
    }
    if (t >= 0.65) { this.state = 'approach'; this.t = 0; this.cut = 0; }
  }

  // the pilot's head follows the drone in
  trackLook(dt, k) {
    const pl = this.player;
    const ex = pl.pos.x, ey = pl.pos.y + EYE, ez = pl.pos.z;
    const dx = this.pos.x - ex, dy = this.pos.y - ey, dz = this.pos.z - ez;
    const hd = Math.max(0.5, Math.hypot(dx, dz));
    const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, hd);
    const a = k >= 1000 ? 1 : damp(k, dt);
    pl.yaw += wrapA(yaw - pl.yaw) * a;
    pl.pitch += (clamp(pitch, -1.2, 1.2) - pl.pitch) * a;
  }

  land(dt) {
    const T = this.T, p = this.pos;
    const hAbove = p.y - (T.y + FOOT);
    const vy = -clamp(hAbove * 0.6, 0.18, 0.75);
    this.physics(dt, (T.x - p.x) * 1.5, vy, (T.z - p.z) * 1.5, 2.6);
    this.yaw += clamp(wrapA(this.D.yaw0 - this.yaw) * damp(1.5, dt), -dt, dt);
    if (p.y <= T.y + FOOT + 0.004) {
      p.set(T.x, T.y + FOOT, T.z);
      this.vel.set(0, 0, 0);
      this.state = 'stow'; this.t = 0;
      this.S = { from: p.clone(), yaw: this.yaw, pitch0: this.player.pitch, yaw0: this.player.yaw, folded: [false, false, false, false], pick: null };
      this.tiltP = 0; this.tiltR = 0;
      this.sound.beep([1760, 1320], 0.14, 0.08, 0.05);
    }
  }

  // touchdown: props spin down, lights off, arms fold, picked up out of view
  stow(dt) {
    const S = this.S, t = this.t, pl = this.player;
    this.omega *= Math.exp(-dt * (this.omega > 150 ? 1.7 : 2.6));
    if (this.omega < 4) this.omega = 0;
    for (let i = 0; i < 4; i++) this.omegas[i] = this.omega * (1 + (i - 1.5) * 0.01);
    if (this.omega < 30) this.bladeOpen += (0 - this.bladeOpen) * damp(3, dt);
    this.led = 1 - sat((t - 1.6) / 0.3);
    for (let i = 3, k = 0; i >= 0; i--, k++) {
      const a = sat((t - (2.0 + k * 0.22)) / 0.5);
      this.armOpen[i] = 1 - smoother(a);
      if (a >= 1 && !S.folded[i]) { S.folded[i] = true; this.sound.click(0.08); }
    }
    // the pilot looks down at it, crouches to pick it up, and stands with it
    this.crouch = 0.68 * (smoother(sat((t - 2.4) / 0.9)) - smoother(sat((t - 3.75) / 0.9)));
    const lean = this.crouch * 0.35;
    const eye = pl.pos.y + EYE - this.crouch;
    const hd = Math.max(0.5, Math.hypot(S.from.x - pl.pos.x, S.from.z - pl.pos.z) - lean);
    const lookDown = Math.atan2(S.from.y - eye, hd);
    let pitch = lerp(S.pitch0, lookDown, smoother(sat(t / 0.8)));
    if (t > 3.5) pitch = lerp(pitch, -0.05, smoother(sat((t - 3.5) / 1.1)));
    pl.pitch = pitch;
    if (t > 3.35) {
      if (!S.pick) S.pick = new THREE.Vector3();
      S.pick.set(pl.pos.x - Math.sin(pl.yaw) * (0.3 + lean) + Math.cos(pl.yaw) * 0.14, eye - 0.6, pl.pos.z - Math.cos(pl.yaw) * (0.3 + lean) - Math.sin(pl.yaw) * 0.14);
      const e = smoother(sat((t - 3.35) / 1.0));
      const mid = this._v2.set(S.from.x + (S.pick.x - S.from.x) * 0.25, S.from.y + 0.42, S.from.z + (S.pick.z - S.from.z) * 0.25);
      const a = (1 - e) * (1 - e), b = 2 * (1 - e) * e, c = e * e;
      this.pos.set(a * S.from.x + b * mid.x + c * S.pick.x, a * S.from.y + b * mid.y + c * S.pick.y, a * S.from.z + b * mid.z + c * S.pick.z);
      this.yaw = S.yaw + 0.55 * e;
      this.carryP = 0.32 * e; this.carryR = 0.18 * e;
    }
    if (t >= 4.65) {
      this.state = 'docked'; this.t = 0;
      this.group.visible = false;
      this.carryP = this.carryR = 0; this.crouch = 0;
      this.omega = 0; this.omegas.fill(0);
      pl.pitch = -0.05;
      pl.enabled = true;
      this.untrample();
    }
  }

  // ------------------------------------------------------------ pose, lights, camera, sound
  pose(dt) {
    const T = this.time;
    // hover bob and a little life while airborne
    const air = this.omega > HOVER * 0.7 && this.state !== 'deploy' ? 1 : 0;
    const bob = air * (Math.sin(T * 1.3) * 0.006 + Math.sin(T * 2.7 + 1) * 0.003);
    this.group.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    this._e.set(-this.tiltP - this.carryP + air * Math.sin(T * 2.1) * 0.006, this.yaw, -this.tiltR - this.carryR + air * Math.sin(T * 1.7 + 2) * 0.007, 'YXZ');
    this.group.quaternion.setFromEuler(this._e);
    // arms and props
    for (let i = 0; i < 4; i++) {
      const A = this.arms[i], d = A.d, o = this.armOpen[i];
      A.pivot.rotation.y = lerp(d.shut, d.open, o);
      A.pivot.rotation.z = d.droop * (1 - o);
      const w = this.omegas[i];
      this.spinA[i] += w * dt * d.spin;
      // a stopped prop is turned back in line with its arm so the blades can fold along it
      if (w < 2 && this.state === 'stow') { const tw = Math.PI * 2; this.spinA[i] += (Math.round(this.spinA[i] / tw) * tw - this.spinA[i]) * damp(5, dt); }
      // fast props are a blur: the eye (and a camera) sees a disc, not blades
      const fast = w > 150;
      A.prop.rotation.y = fast ? 0 : this.spinA[i];
      for (const b of A.blades) {
        b.mesh.visible = !fast;
        // folded blades trail back along the arm; spinning flings them straight
        const folded = Math.PI * 0.94;
        b.hinge.rotation.y = b.k ? Math.PI + (1 - this.bladeOpen) * -0.05 : lerp(folded, 0, this.bladeOpen);
      }
      A.disc.visible = w > 60;
    }
    SPIN.value = sstep(60, 260, this.omega);
  }

  lights(dt) {
    const T = this.time, lv = this.led;
    const cam = this.camera.position;
    const dist = this.view === 'fp' ? cam.distanceTo(this.pos) : 0;
    const vis = this.view === 'fp';
    for (const L of this.leds) {
      // front: steady white; back: red double-blink like an aircraft beacon
      const ph = (T % 1.2);
      const on = L.front ? 1 : (ph < 0.07 || (ph > 0.18 && ph < 0.25)) ? 1 : 0.06;
      const k = lv * on;
      L.mesh.material.color.copy(L.col).multiplyScalar(k * 6);
      L.sprite.visible = vis && k > 0.02;
      L.sprite.material.opacity = k * (L.front ? 0.55 : 0.9);
      L.sprite.scale.setScalar(Math.max(0.035, dist * 0.0055));
      L.mesh.visible = vis;
    }
    const sb = lv * (Math.sin(T * 5.5) > 0.6 ? 1 : 0.15);
    this.status.mesh.material.color.copy(this.status.col).multiplyScalar(sb * 4);
    this.status.sprite.visible = vis && sb > 0.2;
    this.status.sprite.material.opacity = sb * 0.6;
    this.status.sprite.scale.setScalar(Math.max(0.025, dist * 0.004));
    this.status.mesh.visible = vis;
  }

  applyFeedCamera(dt) {
    // the gimbal smooths the stick and cancels the airframe's tilt, with a hint of lag
    this.gYaw += wrapA(this.camYaw - this.gYaw) * damp(14, dt);
    this.gPitch += (this.camPitch - this.gPitch) * damp(14, dt);
    const c = this.camera;
    const q = this.group.quaternion;
    this._v.copy(CAM_OFF).applyQuaternion(q).add(this.group.position);
    c.position.copy(this._v);
    c.rotation.set(this.gPitch, this.gYaw, -this.tiltR * 0.03, 'YXZ');
    // the head of the gimbal points where the camera does
    this.head.quaternion.copy(this.gimbal.getWorldQuaternion(this._q).invert()).multiply(c.quaternion);
  }

  audioUpdate() {
    let level, lp, pan = 0;
    if (this.view === 'feed') { level = 0.42; lp = 6500; }
    else {
      const cam = this.camera;
      const d = cam.position.distanceTo(this.pos);
      level = 0.42 / (1 + Math.pow(d / 1.6, 1.5));
      lp = 11000 / (1 + d / 18);
      const r = this._v.set(1, 0, 0).applyQuaternion(cam.quaternion);
      const dir = this._v2.copy(this.pos).sub(cam.position).normalize();
      pan = clamp(r.dot(dir), -1, 1) * 0.8;
    }
    this.sound.update(this.omegas, level, lp, pan);
  }
}
