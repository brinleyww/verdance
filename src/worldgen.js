// Procedural world layout. Pure data, no three.js: runs inside a Web Worker.
import { Simplex, mulberry32, clamp, lerp, smoothstep } from './noise.js';

export const WORLD = {
  size: 2048,        // near heightmap extent (m), centred on the origin
  res: 2048,         // near heightmap texels (1 m)
  farSize: 16384,    // far heightmap extent (m)
  farRes: 512,       // far heightmap texels (32 m)
  maskRes: 1024,     // ground mask texels (2 m)
  playRadius: 900,
};

export const SPAWN = { x: -24, z: 318, yaw: 0.12 };

// Points of interest. Heights are filled in by the generator.
export const RELAYS = [
  { id: 0, name: 'Knoll Relay', x: -58, z: 62 },
  { id: 1, name: 'Ridge Relay', x: 432, z: -226 },
  { id: 2, name: 'Clearing Relay', x: -430, z: -70 },
  { id: 3, name: 'Hollow Relay', x: 282, z: 318 },
  { id: 4, name: 'Rim Relay', x: -150, z: -478 },
];

export const AREAS = [
  { name: 'The Long Meadow', x: -10, z: 200, r: 210 },
  { name: 'Limestone Ridge', x: 430, z: -230, r: 120 },
  { name: 'Old Wood', x: -460, z: -40, r: 230 },
  { name: 'Birch Hollow', x: 330, z: 290, r: 150 },
  { name: 'The Chasm', x: 0, z: -600, r: 260 },
  { name: 'Stonewater Creek', x: 160, z: 20, r: 60 },
];

// Creek control points, from the spring in the south-east hills to the chasm rim.
const CREEK_CTRL = [
  [640, 560], [560, 470], [470, 420], [400, 352], [330, 262], [262, 176], [196, 112],
  [150, 40], [124, -46], [142, -150], [196, -262], [206, -360], [178, -452], [168, -520], [166, -575],
];

// Trails (polylines). The Long Meadow trail fans out to every relay.
const TRAILS = [
  [[SPAWN.x, SPAWN.z + 20], [-30, 250], [-48, 170], [-62, 100], [-58, 70]],
  [[-58, 70], [-140, 40], [-230, 10], [-320, -30], [-400, -62], [-430, -70]],
  [[-58, 70], [10, 40], [80, 4], [132, -44], [200, -96], [290, -148], [360, -196], [432, -226]],
  [[-58, 70], [-70, -40], [-96, -160], [-118, -280], [-136, -390], [-150, -478], [-60, -500], [-10, -506]],
  [[-30, 250], [60, 270], [150, 300], [230, 316], [282, 318]],
];

// The chasm is a long east-west rift north of the meadow.
export function chasmCentre(x) { return -650 + 36 * Math.sin(x / 290) + 18 * Math.sin(x / 113 + 1.3); }
export function chasmHalfWidth(x) { return 118 + 16 * Math.sin(x / 210 + 0.7); }

// Cliff edge table: per metre of x and per wall, the rim edge z, rim heights and floor (see cliffs.js).
// The terrain wall behind the cliff mesh is a straight batter of CLIFF.slope metres down per metre in.
export const CLIFF = { x0: -2048, n: 4096, slope: 14.3 };
// Decorative springs that pour over the north wall: [x, width]
export const NORTH_FALLS = [[-430, 9], [-120, 5], [330, 12], [610, 7]];

export const SPHERE = { x: 0, z: chasmCentre(0), radius: 26 };
export const PYLONS = [
  { x: -6, z: chasmCentre(0) + chasmHalfWidth(0) + 26 },
  { x: 6, z: chasmCentre(0) - chasmHalfWidth(0) - 26 },
];

// A transmission line crossing the valley (decor).
export const POWERLINE = [[-1150, -40], [-820, -95], [-520, -150], [-225, -205], [70, -262], [365, -318], [660, -372], [960, -428]];

function catmull(points, step) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(2, Math.ceil(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(points[points.length - 1].slice());
  return out;
}

export function generateWorld(seed = 1337, progress = () => {}) {
  const S = new Simplex(seed);
  const S2 = new Simplex(seed + 101);
  const S3 = new Simplex(seed + 202);
  const rnd = mulberry32(seed + 7);

  // ---------- base height field (no creek/trail carving) ----------
  function baseHeight(x, z, detail = true) {
    let h = 32;
    h += 15 * S.fbm(x / 560, z / 560, 4);
    h += 5.5 * S.fbm(x / 170 + 3.1, z / 170 - 7.7, 4);
    if (detail) h += 1.1 * S.fbm(x / 42, z / 42, 3);
    h += 0.034 * z;
    // soft knoll for the first relay and a bump for the lone-tree hill near spawn
    h += 9 * Math.exp(-((x + 58) ** 2 + (z - 62) ** 2) / (2 * 58 * 58));
    h += 6 * Math.exp(-((x - 95) ** 2 + (z - 150) ** 2) / (2 * 45 * 45));
    // limestone ridge (NE), elongated
    {
      const dx = x - 440, dz = z + 228;
      const u = dx * 0.8 + dz * 0.6, v = -dx * 0.6 + dz * 0.8;
      const g = Math.exp(-(u * u) / (2 * 150 * 150) - (v * v) / (2 * 62 * 62));
      h += g * (48 + 18 * S2.ridged(x / 90, z / 90, 4));
    }
    // mountains around the valley bowl
    const cx = x, cz = z - 80;
    const r = Math.hypot(cx, cz * 1.08);
    const ang = Math.atan2(cz, cx);
    const bowl = 700 + 120 * Math.sin(ang * 3 + 1.0) + 80 * Math.sin(ang * 5 - 0.6);
    let m = smoothstep(bowl - 80, bowl + 650, r);
    // north side: the land beyond the chasm stays a plateau until far away
    const north = smoothstep(-420, -760, z);
    m *= 1 - north * 0.85;
    if (m > 0) {
      const rr = S.ridged(x / 1300, z / 1300, 5);
      h += m * (70 + 330 * rr) + m * m * 160;
    }
    // far northern mountains beyond the plateau
    const fn = smoothstep(-1500, -3200, z);
    if (fn > 0) h += fn * (120 + 520 * S3.ridged(x / 1500, z / 1500, 5));
    return h;
  }

  // rim edge distance from the centre line; side +1 = south wall, -1 = north wall
  function edgeW(x, side) {
    let w = chasmHalfWidth(x) + 5.5 * S2.fbm(x / 38, side * 3.7 + 50, 3) + 1.5 * S.noise2(x / 11, side * 9.1 + 2.0);
    if (side > 0) w -= 9 * Math.exp(-(((x + 10) / 24) ** 2)); // rocky promontory at the end of the rim trail
    return w;
  }
  const edgeTab = new Float32Array(CLIFF.n * 2);
  for (let i = 0; i < CLIFF.n; i++) {
    edgeTab[i] = edgeW(CLIFF.x0 + i, 1);
    edgeTab[CLIFF.n + i] = edgeW(CLIFF.x0 + i, -1);
  }
  function edgeAt(x, side) {
    const f = x - CLIFF.x0;
    if (f < 0 || f >= CLIFF.n - 1) return edgeW(x, side);
    const i = Math.floor(f), t = f - i, o = side > 0 ? 0 : CLIFF.n;
    return edgeTab[o + i] * (1 - t) + edgeTab[o + i + 1] * t;
  }
  // signed distance from the rim edge (negative = over the chasm)
  function edgeDist(x, z) {
    const zc = chasmCentre(x);
    return Math.abs(z - zc) - edgeAt(x, z >= zc ? 1 : -1);
  }
  // plateau, then a straight steep batter down to the floor: a convex profile, so coarser terrain rings
  // (chords between vertices) always stay inside the rock, behind the cliff mesh
  function chasmCarve(x, z, h) {
    const zc = chasmCentre(x);
    const side = z >= zc ? 1 : -1;
    const d = Math.abs(z - zc), we = edgeAt(x, side);
    if (d >= we) return h;
    const drop = h - (we - d) * CLIFF.slope;
    if (drop > -310) return drop;
    return Math.max(drop, -340 + 30 * S.fbm(x / 120, z / 120, 3));
  }

  // ---------- creek ----------
  const creekPts = catmull(CREEK_CTRL, 2.0);
  const creek = [];
  {
    let prev = Infinity;
    for (let i = 0; i < creekPts.length; i++) {
      const [x, z] = creekPts[i];
      const ground = chasmCarve(x, z, baseHeight(x, z));
      const width = 1.7 + 1.1 * (0.5 + 0.5 * S3.noise2(i * 0.021, 3.3)) + Math.min(1.2, i * 0.0016);
      let bed = Math.min(prev - 0.012, ground - 0.9);
      if (z < chasmCentre(x) + edgeAt(x, 1) - 0.5) bed = Math.min(prev - 0.6, ground - 0.4); // falls
      prev = bed;
      creek.push({ x, z, bed, width, water: bed + 0.32 });
    }
    // gentle smoothing so the water does not step
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i < creek.length - 1; i++) {
        const c = creek[i];
        if (c.z < chasmCentre(c.x) + edgeAt(c.x, 1) + 1) continue;
        const s = (creek[i - 1].bed + c.bed + creek[i + 1].bed) / 3;
        c.bed = Math.min(c.bed, Math.max(s, creek[i + 1].bed + 0.012));
        c.water = c.bed + 0.32;
      }
    }
  }
  progress(0.08);

  // ---------- coarse height (2 m), then upsample to 1 m ----------
  const N = WORLD.res, size = WORLD.size, cell = size / N;
  const CN = N / 2, ccell = size / CN;
  const coarse = new Float32Array((CN + 3) * (CN + 3));
  const CW = CN + 3;
  for (let j = 0; j < CW; j++) {
    const z = -size / 2 + (j - 1 + 0.5) * ccell;
    for (let i = 0; i < CW; i++) {
      const x = -size / 2 + (i - 1 + 0.5) * ccell;
      coarse[j * CW + i] = baseHeight(x, z, false); // chasm carved later at full resolution
    }
    if ((j & 63) === 0) progress(0.08 + 0.3 * j / CW);
  }

  const heights = new Float32Array(N * N);
  const zcCol = new Float32Array(N), weS = new Float32Array(N), weN = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = -size / 2 + (i + 0.5) * cell;
    zcCol[i] = chasmCentre(x); weS[i] = edgeAt(x, 1); weN[i] = edgeAt(x, -1);
  }
  const cub = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  for (let j = 0; j < N; j++) {
    const z = -size / 2 + (j + 0.5) * cell;
    const fz = (z + size / 2) / ccell - 0.5 + 1;
    const jz = Math.floor(fz), tz = fz - jz;
    for (let i = 0; i < N; i++) {
      const x = -size / 2 + (i + 0.5) * cell;
      const fx = (x + size / 2) / ccell - 0.5 + 1;
      const ix = Math.floor(fx), tx = fx - ix;
      const x0 = clamp(ix - 1, 0, CW - 1), x1 = clamp(ix, 0, CW - 1), x2 = clamp(ix + 1, 0, CW - 1), x3 = clamp(ix + 2, 0, CW - 1);
      const r0 = clamp(jz - 1, 0, CW - 1) * CW, r1 = clamp(jz, 0, CW - 1) * CW, r2 = clamp(jz + 1, 0, CW - 1) * CW, r3 = clamp(jz + 2, 0, CW - 1) * CW;
      let h = cub(
        cub(coarse[r0 + x0], coarse[r0 + x1], coarse[r0 + x2], coarse[r0 + x3], tx),
        cub(coarse[r1 + x0], coarse[r1 + x1], coarse[r1 + x2], coarse[r1 + x3], tx),
        cub(coarse[r2 + x0], coarse[r2 + x1], coarse[r2 + x2], coarse[r2 + x3], tx),
        cub(coarse[r3 + x0], coarse[r3 + x1], coarse[r3 + x2], coarse[r3 + x3], tx), tz);
      // detail octaves on the land, then the chasm carve at full resolution
      const dz = z - zcCol[i], we = dz >= 0 ? weS[i] : weN[i], d = Math.abs(dz);
      if (d > we - 2) h += 1.1 * S.fbm(x / 42, z / 42, 3) + 0.22 * S2.noise2(x / 9, z / 9);
      if (d < we) {
        h -= (we - d) * CLIFF.slope;
        if (h < -310) h = Math.max(h, -340 + 30 * S.fbm(x / 120, z / 120, 3));
      }
      heights[j * N + i] = h;
    }
    if ((j & 63) === 0) progress(0.38 + 0.25 * j / N);
  }

  // ---------- rasterise creek + trails into distance buffers ----------
  const creekDist = new Float32Array(N * N).fill(1e9);
  const creekBed = new Float32Array(N * N);
  const creekW = new Float32Array(N * N);
  const BANK = 26;
  for (let s = 0; s < creek.length - 1; s++) {
    const a = creek[s], b = creek[s + 1];
    const minx = Math.min(a.x, b.x) - BANK, maxx = Math.max(a.x, b.x) + BANK;
    const minz = Math.min(a.z, b.z) - BANK, maxz = Math.max(a.z, b.z) + BANK;
    const i0 = Math.max(0, Math.floor((minx + size / 2) / cell)), i1 = Math.min(N - 1, Math.ceil((maxx + size / 2) / cell));
    const j0 = Math.max(0, Math.floor((minz + size / 2) / cell)), j1 = Math.min(N - 1, Math.ceil((maxz + size / 2) / cell));
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
    for (let j = j0; j <= j1; j++) {
      const z = -size / 2 + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const x = -size / 2 + (i + 0.5) * cell;
        let t = ((x - a.x) * dx + (z - a.z) * dz) / L2;
        t = clamp(t, 0, 1);
        const px = a.x + dx * t, pz = a.z + dz * t;
        const d = Math.hypot(x - px, z - pz);
        const k = j * N + i;
        if (d < creekDist[k]) {
          creekDist[k] = d;
          creekBed[k] = lerp(a.bed, b.bed, t);
          creekW[k] = lerp(a.width, b.width, t);
        }
      }
    }
  }
  const trailDist = new Float32Array(N * N).fill(1e9);
  const trailPts = TRAILS.map((t) => catmull(t, 3));
  for (const pts of trailPts) {
    for (let s = 0; s < pts.length - 1; s++) {
      const a = pts[s], b = pts[s + 1];
      const R = 8;
      const minx = Math.min(a[0], b[0]) - R, maxx = Math.max(a[0], b[0]) + R;
      const minz = Math.min(a[1], b[1]) - R, maxz = Math.max(a[1], b[1]) + R;
      const i0 = Math.max(0, Math.floor((minx + size / 2) / cell)), i1 = Math.min(N - 1, Math.ceil((maxx + size / 2) / cell));
      const j0 = Math.max(0, Math.floor((minz + size / 2) / cell)), j1 = Math.min(N - 1, Math.ceil((maxz + size / 2) / cell));
      const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
      for (let j = j0; j <= j1; j++) {
        const z = -size / 2 + (j + 0.5) * cell;
        for (let i = i0; i <= i1; i++) {
          const x = -size / 2 + (i + 0.5) * cell;
          const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / L2, 0, 1);
          const d = Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
          const k = j * N + i;
          if (d < trailDist[k]) trailDist[k] = d;
        }
      }
    }
  }
  progress(0.68);

  // ---------- carve: creek channel, trail tread, relay pads ----------
  for (const r of RELAYS) r.y = sampleArr(heights, N, size, r.x, r.z);
  for (const p of PYLONS) p.y = sampleArr(heights, N, size, p.x, p.z);
  for (let k = 0; k < N * N; k++) {
    let h = heights[k];
    const cd = creekDist[k];
    if (cd < BANK) {
      const w = creekW[k];
      const bed = creekBed[k];
      let prof;
      if (cd < w) prof = bed + 0.28 * (cd / w) ** 2;
      else prof = bed + 0.28 + (cd - w) * 0.55 + 0.04 * (cd - w) ** 2;
      if (prof < h) h = lerp(h, prof, smoothstep(BANK, BANK * 0.55, cd));
      if (cd < w + 1) h = Math.min(h, prof);
    }
    const td = trailDist[k];
    if (td < 2.2) h -= 0.07 * smoothstep(2.2, 0.6, td);
    heights[k] = h;
  }
  // flatten pads under relays and pylons
  const pads = RELAYS.map((r) => ({ x: r.x, z: r.z, y: r.y, r0: 9, r1: 20 })).concat(PYLONS.map((p) => ({ x: p.x, z: p.z, y: p.y, r0: 18, r1: 34 })));
  for (const p of pads) {
    const i0 = Math.max(0, Math.floor((p.x - p.r1 + size / 2) / cell)), i1 = Math.min(N - 1, Math.ceil((p.x + p.r1 + size / 2) / cell));
    const j0 = Math.max(0, Math.floor((p.z - p.r1 + size / 2) / cell)), j1 = Math.min(N - 1, Math.ceil((p.z + p.r1 + size / 2) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = -size / 2 + (i + 0.5) * cell, z = -size / 2 + (j + 0.5) * cell;
      const d = Math.hypot(x - p.x, z - p.z);
      const t = smoothstep(p.r1, p.r0, d);
      const k = j * N + i;
      heights[k] = lerp(heights[k], p.y, t);
    }
  }
  progress(0.72);

  // ---------- far heightmap ----------
  const FN = WORLD.farRes, fsize = WORLD.farSize, fcell = fsize / FN;
  const far = new Float32Array(FN * FN);
  for (let j = 0; j < FN; j++) {
    const z = -fsize / 2 + (j + 0.5) * fcell;
    for (let i = 0; i < FN; i++) {
      const x = -fsize / 2 + (i + 0.5) * fcell;
      far[j * FN + i] = (Math.abs(x) < size / 2 - 40 && Math.abs(z) < size / 2 - 40)
        ? sampleArr(heights, N, size, x, z)
        : chasmCarve(x, z, baseHeight(x, z, false));
    }
  }
  progress(0.78);

  // ---------- normals (+ cavity in alpha) ----------
  const normals = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const hl = heights[j * N + Math.max(0, i - 1)], hr = heights[j * N + Math.min(N - 1, i + 1)];
      const hd = heights[Math.max(0, j - 1) * N + i], hu = heights[Math.min(N - 1, j + 1) * N + i];
      let nx = -(hr - hl) / (2 * cell), nz = -(hu - hd) / (2 * cell), ny = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const lap = (hl + hr + hd + hu) * 0.25 - heights[k];
      const cav = clamp(0.5 + lap * 1.2, 0, 1);
      normals[k * 4] = (nx * 0.5 + 0.5) * 255;
      normals[k * 4 + 1] = (ny * 0.5 + 0.5) * 255;
      normals[k * 4 + 2] = (nz * 0.5 + 0.5) * 255;
      normals[k * 4 + 3] = cav * 255;
    }
  }
  progress(0.84);

  // ---------- ground masks (2 m) ----------
  const M = WORLD.maskRes, mcell = size / M;
  const mask = new Uint8Array(M * M * 4);
  const forestAt = (x, z) => {
    let f = 0.72 + 0.85 * S2.fbm(x / 420, z / 420, 4) + 0.25 * S3.fbm(x / 90, z / 90, 3);
    f += 0.55 * Math.exp(-((x + 480) ** 2 + (z + 40) ** 2) / (2 * 220 * 220));   // Old Wood
    f += 0.5 * Math.exp(-((x - 340) ** 2 + (z - 280) ** 2) / (2 * 120 * 120));   // Birch Hollow
    f += 0.35 * smoothstep(380, 560, Math.hypot(x, z - 60));
    const mr = Math.hypot((x + 10) / 1.25, (z - 150) / 1.0);
    const meadow = smoothstep(250, 420, mr + 70 * S.noise2(x / 160, z / 160));
    f = Math.min(f, -0.25 + meadow * 1.6);
    // grassy strip along the chasm rim
    const rim = Math.abs(z - chasmCentre(x)) - chasmHalfWidth(x);
    f *= smoothstep(30, 110, rim);
    // ridge top is sparse
    const ridge = Math.hypot((x - 440) / 1.6, z + 228);
    f *= 0.25 + 0.75 * smoothstep(40, 110, ridge);
    // powerline corridor
    f *= corridor(x, z);
    return clamp(f, 0, 1);
  };
  function corridorDist(x, z) {
    let best = 1e9;
    for (let s = 0; s < POWERLINE.length - 1; s++) {
      const a = POWERLINE[s], b = POWERLINE[s + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz), 0, 1);
      best = Math.min(best, Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t));
    }
    return best;
  }
  function corridor(x, z) {
    return smoothstep(16, 30, corridorDist(x, z));
  }
  const forest = new Float32Array(M * M);
  for (let j = 0; j < M; j++) {
    const z = -size / 2 + (j + 0.5) * mcell;
    for (let i = 0; i < M; i++) {
      const x = -size / 2 + (i + 0.5) * mcell;
      forest[j * M + i] = forestAt(x, z);
    }
  }
  for (let j = 0; j < M; j++) {
    const z = -size / 2 + (j + 0.5) * mcell;
    for (let i = 0; i < M; i++) {
      const x = -size / 2 + (i + 0.5) * mcell;
      const k = j * M + i;
      const hi = Math.min(N - 1, Math.floor((x + size / 2) / cell)), hj = Math.min(N - 1, Math.floor((z + size / 2) / cell));
      const hk = hj * N + hi;
      const ny = normals[hk * 4 + 1] / 255 * 2 - 1;
      const slope = 1 - ny;
      // blurred canopy for ambient occlusion
      let fsum = 0, fn = 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const ii = clamp(i + di, 0, M - 1), jj = clamp(j + dj, 0, M - 1);
        fsum += forest[jj * M + ii]; fn++;
      }
      const canopy = fsum / fn;
      const cd = creekDist[hk], td = trailDist[hk];
      const h = heights[hk];
      let grass = 1 - smoothstep(0.28, 0.72, canopy) * 0.94;
      grass *= 1 - smoothstep(0.25, 0.55, slope);
      grass *= smoothstep(1.0, 2.6, td);
      const cw = creekW[hk] || 2;
      grass *= smoothstep(cw * 0.9, cw + 1.6, cd);
      grass *= 1 - smoothstep(380, 520, h); // above tree line: short alpine grass handled by terrain
      grass *= smoothstep(3.0, 7.0, edgeDist(x, z)); // bare rock lip along the cliff edge (the lip rides over the turf to ~3 m)
      let pad = 0;
      for (const r of RELAYS) { const d = Math.hypot(x - r.x, z - r.z); grass *= smoothstep(8.5, 11.0, d); pad = Math.max(pad, 1 - smoothstep(8.0, 10.5, d)); }
      for (const p of PYLONS) { const d = Math.hypot(x - p.x, z - p.z); grass *= smoothstep(11, 16, d); }
      const dirt = Math.max(1 - smoothstep(0.7, 2.0, td), pad * 0.85);
      const wet = 1 - smoothstep(cw, cw + 5, cd);
      mask[k * 4] = canopy * 255;
      mask[k * 4 + 1] = clamp(grass, 0, 1) * 255;
      mask[k * 4 + 2] = dirt * 255;
      mask[k * 4 + 3] = wet * 255;
    }
  }
  progress(0.9);

  // ---------- placements ----------
  const H = (x, z) => sampleArr(heights, N, size, x, z);
  const slopeAt = (x, z) => {
    const e = 1.5;
    const dx = H(x + e, z) - H(x - e, z), dz = H(x, z + e) - H(x, z - e);
    return Math.hypot(dx, dz) / (2 * e);
  };
  const maskAt = (x, z, ch) => {
    const i = clamp(Math.floor((x + size / 2) / mcell), 0, M - 1), j = clamp(Math.floor((z + size / 2) / mcell), 0, M - 1);
    return mask[(j * M + i) * 4 + ch] / 255;
  };
  const fAt = (x, z) => {
    const i = clamp(Math.floor((x + size / 2) / mcell), 0, M - 1), j = clamp(Math.floor((z + size / 2) / mcell), 0, M - 1);
    return forest[j * M + i];
  };
  const blocked = (x, z, rad) => {
    const ci = clamp(Math.floor((x + size / 2) / cell), 0, N - 1), cj = clamp(Math.floor((z + size / 2) / cell), 0, N - 1);
    const k = cj * N + ci;
    if (creekDist[k] < (creekW[k] || 2) + rad) return true;
    if (trailDist[k] < 1.6 + rad) return true;
    for (const r of RELAYS) if (Math.hypot(x - r.x, z - r.z) < 13 + rad) return true;
    for (const p of PYLONS) if (Math.hypot(x - p.x, z - p.z) < 26 + rad) return true;
    for (const p of POWERLINE) if (Math.hypot(x - p[0], z - p[1]) < 9 + rad) return true;
    if (edgeDist(x, z) < 6) return true;
    if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 6) return true;
    return false;
  };

  // species weights: 0 oak, 1 beech, 2 birch, 3 small (hornbeam/maple)
  const speciesAt = (x, z, r) => {
    const birch = smoothstep(120, 260, x) * smoothstep(60, 180, z) + 0.15;
    const beech = smoothstep(-150, -400, x) * 0.8 + 0.25 * (0.5 + 0.5 * S3.noise2(x / 300, z / 300));
    const oak = 0.7 + 0.3 * S2.noise2(x / 260 + 9, z / 260);
    const small = 0.35;
    const tot = birch + beech + oak + small;
    let t = r * tot;
    if ((t -= oak) < 0) return 0;
    if ((t -= beech) < 0) return 1;
    if ((t -= birch) < 0) return 2;
    return 3;
  };

  const trees = [];
  const TCELL = 6.2;
  const half = size / 2 - 8;
  for (let gz = -half; gz < half; gz += TCELL) {
    for (let gx = -half; gx < half; gx += TCELL) {
      const x = gx + rnd() * TCELL, z = gz + rnd() * TCELL;
      const f = fAt(x, z);
      const h = H(x, z);
      if (h > 470) continue;
      const treeline = 1 - smoothstep(360, 470, h);
      let p = f * 0.62 * treeline;
      // lone trees in the meadow
      if (f < 0.05) p = 0.0028 + 0.012 * smoothstep(0.0, 0.05, f);
      if (rnd() > p) continue;
      if (slopeAt(x, z) > 0.9) continue;
      if (blocked(x, z, 2.5)) continue;
      if (corridorDist(x, z) < 21) continue; // cleared strip under the wires
      const sp = f < 0.05 ? (rnd() < 0.62 ? 0 : 1) : speciesAt(x, z, rnd());
      const variant = sp * 2 + (rnd() < 0.5 ? 0 : 1);
      let scale = 0.78 + rnd() * 0.42;
      if (sp === 3) scale = 0.65 + rnd() * 0.4;
      if (f < 0.05) scale *= 1.18; // open-grown trees are bigger
      const trunkR = [0.55, 0.45, 0.22, 0.2][sp] * scale;
      trees.push(x, h - 0.15, z, rnd() * Math.PI * 2, scale, variant, rnd(), trunkR);
    }
  }
  // feature trees placed by hand: the lone oak on the hill near spawn
  trees.push(95, H(95, 150) - 0.2, 150, 1.3, 1.38, 0, 0.01, 0.75);
  trees.push(-150, H(-150, 236) - 0.2, 236, 4.1, 1.22, 1, 0.02, 0.6);
  progress(0.94);

  // far canopy blobs on the mountains outside the near map
  const blobs = [];
  for (let gz = -3000; gz < 3000; gz += 14) {
    for (let gx = -3000; gx < 3000; gx += 14) {
      if (Math.abs(gx) < half && Math.abs(gz) < half) continue;
      const x = gx + rnd() * 14, z = gz + rnd() * 14;
      const h = sampleArr(far, FN, fsize, x, z);
      if (h > 520 || h < -30) continue;
      const fm = 0.5 + 0.8 * S2.fbm(x / 420, z / 420, 3);
      if (rnd() > clamp(fm, 0, 1) * (1 - smoothstep(380, 520, h))) continue;
      blobs.push(x, h - 0.5, z, rnd() * 6.28, 0.9 + rnd() * 0.6, rnd());
    }
  }

  const shrubs = [];
  for (let gz = -half; gz < half; gz += 3.4) {
    for (let gx = -half; gx < half; gx += 3.4) {
      const x = gx + rnd() * 3.4, z = gz + rnd() * 3.4;
      const f = fAt(x, z);
      const edge = f * (1 - f) * 4;
      const wet = maskAt(x, z, 3);
      const p = f * 0.2 + edge * 0.3 + wet * 0.12;
      if (rnd() > p) continue;
      if (blocked(x, z, 0.4)) continue;
      if (slopeAt(x, z) > 0.8) continue;
      shrubs.push(x, H(x, z) - 0.1, z, rnd() * 6.28, 0.55 + rnd() * 0.9, Math.floor(rnd() * 3));
    }
  }
  const ferns = [];
  for (let gz = -half; gz < half; gz += 2.2) {
    for (let gx = -half; gx < half; gx += 2.2) {
      const x = gx + rnd() * 2.2, z = gz + rnd() * 2.2;
      const f = fAt(x, z);
      const wet = maskAt(x, z, 3);
      const p = f * f * 0.34 + wet * 0.25 * f;
      if (rnd() > p) continue;
      if (blocked(x, z, 0.2)) continue;
      ferns.push(x, H(x, z) - 0.05, z, rnd() * 6.28, 0.6 + rnd() * 0.7);
    }
  }

  const rocks = [];
  const addRock = (x, z, s, sy, sink = 0.35, variant = -1) => {
    const y = H(x, z);
    rocks.push(x, y - s * sy * sink, z, rnd() * 6.28, s * (0.8 + rnd() * 0.5), s * sy, s * (0.8 + rnd() * 0.5), variant < 0 ? Math.floor(rnd() * 4) : variant);
  };
  // variants 0-3 are water-worn and rounded, 4-7 are angular limestone blocks
  const block = () => 4 + Math.floor(rnd() * 4);
  // outcrops on steep ground and the ridge: mostly jointed limestone
  for (let gz = -half; gz < half; gz += 9) {
    for (let gx = -half; gx < half; gx += 9) {
      const x = gx + rnd() * 9, z = gz + rnd() * 9;
      const sl = slopeAt(x, z);
      if (edgeDist(x, z) < 10) continue;
      const ridge = Math.exp(-((x - 440) ** 2 + (z + 228) ** 2) / (2 * 90 * 90));
      const p = smoothstep(0.38, 0.9, sl) * 0.75 + ridge * 0.22 + 0.006;
      if (rnd() > p) continue;
      if (blocked(x, z, 1.2) && rnd() < 0.9) continue;
      const big = sl > 0.5 || ridge > 0.3;
      const ang = big || rnd() < 0.6;
      addRock(x, z, big ? 2.2 + rnd() * 4.5 : 0.5 + rnd() * 1.2, ang ? 0.45 + rnd() * 0.3 : 0.55 + rnd() * 0.4, big ? 0.38 : 0.35, ang ? block() : -1);
    }
  }
  // broken blocks along the cliff edge: clusters of strata-aligned slabs, half sunk into the rock lip
  let creekLipX = 0;
  for (let i = creek.length - 1; i >= 0; i--) {
    if (creek[i].z > chasmCentre(creek[i].x) + edgeAt(creek[i].x, 1) + 1.5) { creekLipX = creek[i].x; break; }
  }
  const fallX = NORTH_FALLS.map(([x, w]) => ({ x, w, side: -1 })).concat([{ x: creekLipX, w: 6, side: 1 }]);
  const nearPylon = (x, z) => PYLONS.some((p) => Math.hypot(x - p.x, z - p.z) < 30);
  for (let cx = -1012; cx < 1012; cx += 11) {
    for (const side of [1, -1]) {
      if (rnd() > 0.55) continue;
      const x0 = cx + rnd() * 11;
      if (fallX.some((f) => f.side === side && Math.abs(f.x - x0) < f.w + 8)) continue;
      const pieces = 1 + Math.floor(rnd() * 3.2);
      const main = 1.3 + rnd() * 2.4;
      for (let k = 0; k < pieces; k++) {
        const x = x0 + (k ? (rnd() - 0.5) * main * 3 : 0);
        const back = k ? 0.5 + rnd() * main * 1.6 : Math.pow(rnd(), 1.7) * 6;
        const z = chasmCentre(x) + side * (edgeAt(x, side) + 0.4 + back);
        if (Math.abs(z) > half || nearPylon(x, z)) continue;
        const ci = clamp(Math.floor((x + size / 2) / cell), 0, N - 1), cj = clamp(Math.floor((z + size / 2) / cell), 0, N - 1);
        if (creekDist[cj * N + ci] < (creekW[cj * N + ci] || 2) + 3 || trailDist[cj * N + ci] < 2.2) continue;
        const s = k ? main * (0.3 + rnd() * 0.35) : main;
        addRock(x, z, s, 0.45 + rnd() * 0.35, 0.3, block());
      }
    }
  }
  // stones along the creek
  for (let i = 0; i < creek.length; i += 2) {
    const c = creek[i];
    if (rnd() < 0.5) {
      const a = rnd() * 6.28, d = c.width * (0.3 + rnd() * 1.4);
      addRock(c.x + Math.cos(a) * d, c.z + Math.sin(a) * d, 0.25 + rnd() * 0.55, 0.6, 0.45);
    }
  }

  const logs = [];
  for (let gz = -half; gz < half; gz += 16) {
    for (let gx = -half; gx < half; gx += 16) {
      const x = gx + rnd() * 16, z = gz + rnd() * 16;
      if (fAt(x, z) < 0.6 || rnd() > 0.32) continue;
      if (blocked(x, z, 3)) continue;
      logs.push(x, H(x, z), z, rnd() * 6.28, 4 + rnd() * 6, 0.18 + rnd() * 0.22);
    }
  }
  progress(0.98);

  // cliff edge table, sampled from the final terrain so the rock lip follows the ground (and the creek channel)
  const cliff = new Float32Array(CLIFF.n * 2 * 4);
  for (let s2 = 0; s2 < 2; s2++) {
    const side = s2 === 0 ? 1 : -1;
    for (let i = 0; i < CLIFF.n; i++) {
      const x = CLIFF.x0 + i;
      const zc = chasmCentre(x), we = edgeAt(x, side), ze = zc + side * we;
      const nearMap = Math.abs(x) < size / 2 - 45 && Math.abs(ze) < size / 2 - 45;
      const Hh = (zz) => nearMap ? sampleArr(heights, N, size, x, zz) : baseHeight(x, zz, false);
      const zf = zc + side * (we - 45);
      const k = (s2 * CLIFF.n + i) * 4;
      cliff[k] = ze;
      cliff[k + 1] = Hh(ze + side * 0.6);
      cliff[k + 2] = Hh(ze + side * 4.5);
      cliff[k + 3] = -340 + 30 * S.fbm(x / 120, zf / 120, 3);
    }
  }

  // relays: final heights after pads
  for (const r of RELAYS) r.y = sampleArr(heights, N, size, r.x, r.z);
  for (const p of PYLONS) p.y = sampleArr(heights, N, size, p.x, p.z);
  const power = POWERLINE.map(([x, z]) => ({ x, z, y: Math.abs(x) < half && Math.abs(z) < half ? sampleArr(heights, N, size, x, z) : sampleArr(far, FN, fsize, x, z) }));

  return {
    heights, far, normals, mask,
    trees: new Float32Array(trees), blobs: new Float32Array(blobs), shrubs: new Float32Array(shrubs),
    ferns: new Float32Array(ferns), rocks: new Float32Array(rocks), logs: new Float32Array(logs),
    creek, trails: trailPts, relays: RELAYS, pylons: PYLONS, power, cliff,
  };
}

export function sampleArr(arr, N, size, x, z) {
  const cell = size / N;
  let fx = (x + size / 2) / cell - 0.5, fz = (z + size / 2) / cell - 0.5;
  fx = clamp(fx, 0, N - 1.001); fz = clamp(fz, 0, N - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz);
  const tx = fx - i, tz = fz - j;
  const k = j * N + i;
  const a = arr[k], b = arr[k + 1], c = arr[k + N], d = arr[k + N + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}
