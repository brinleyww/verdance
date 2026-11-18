// Every texture in the game is generated here at load time (no image files).
import * as THREE from 'three';
import { mulberry32 } from './noise.js';

function canvas(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  return [c, c.getContext('2d', { willReadFrequently: true })];
}

// Periodic value noise for tileable textures.
function makePeriodicNoise(seed) {
  const rnd = mulberry32(seed);
  const P = 256;
  const tab = new Float32Array(P * P);
  for (let i = 0; i < tab.length; i++) tab[i] = rnd();
  const v = (ix, iy, px, py) => tab[((((iy % py) + py) % py) & 255) * P + ((((ix % px) + px) % px) & 255)];
  function n(x, y, px, py) {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = v(ix, iy, px, py), b = v(ix + 1, iy, px, py), c = v(ix, iy + 1, px, py), d = v(ix + 1, iy + 1, px, py);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }
  // fbm over a unit tile: u,v in [0,1), base period in cells
  return function fbm(u, v, period, oct = 4, gain = 0.5, stretchY = 1) {
    let s = 0, a = 1, norm = 0, p = period;
    for (let o = 0; o < oct; o++) {
      const py = Math.max(1, Math.round(p / stretchY));
      s += a * n(u * p + o * 13, v * py + o * 7, p, py);
      norm += a; a *= gain; p *= 2;
    }
    return s / norm;
  };
}

function dataTex(data, w, h, opts = {}) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = opts.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = opts.aniso || 4;
  if (opts.srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// Fill transparent texels with nearby opaque colour so mipmaps do not get dark fringes.
function dilate(img, w, h, passes = 6) {
  const d = img.data;
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = d[i * 4 + 3] > 8 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const add = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (filled[i]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = (x + dx + w) % w, yy = (y + dy + h) % h, j = yy * w + xx;
        if (filled[j]) { r += d[j * 4]; g += d[j * 4 + 1]; b += d[j * 4 + 2]; n++; }
      }
      if (n) add.push(i, r / n, g / n, b / n);
    }
    for (let k = 0; k < add.length; k += 4) {
      const i = add[k];
      d[i * 4] = add[k + 1]; d[i * 4 + 1] = add[k + 2]; d[i * 4 + 2] = add[k + 3];
      filled[i] = 1;
    }
  }
  // anything still empty gets the average
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < w * h; i++) if (d[i * 4 + 3] > 8) { r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; n++; }
  if (n) for (let i = 0; i < w * h; i++) if (!filled[i]) { d[i * 4] = r / n; d[i * 4 + 1] = g / n; d[i * 4 + 2] = b / n; }
}

const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

// ---------------- leaves ----------------
function drawLeafShape(ctx, kind, len, wid, rnd) {
  ctx.beginPath();
  if (kind === 'oak') {
    const lobes = 4 + Math.floor(rnd() * 2);
    ctx.moveTo(0, 0);
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const env = Math.sin(Math.PI * Math.pow(t, 0.8)) * (0.75 + 0.25 * t);
      const lobe = 0.62 + 0.38 * Math.abs(Math.sin(t * Math.PI * lobes));
      pts.push([t * len, env * wid * lobe]);
    }
    for (const p of pts) ctx.lineTo(p[0], -p[1]);
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i][0], pts[i][1] * (0.9 + 0.1 * rnd()));
  } else if (kind === 'beech') {
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(len * 0.25, -wid * 1.05, len * 0.75, -wid * 0.9, len, 0);
    ctx.bezierCurveTo(len * 0.75, wid * 0.9, len * 0.25, wid * 1.05, 0, 0);
  } else if (kind === 'birch') {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const env = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.65)), 0.9) * (1.15 - t * 0.55);
      const ser = 1 - 0.08 * (i % 2);
      pts.push([t * len, env * wid * ser]);
    }
    ctx.moveTo(0, 0);
    for (const p of pts) ctx.lineTo(p[0], -p[1]);
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i][0], pts[i][1]);
  } else {
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(len * 0.3, -wid, len * 0.8, -wid * 0.6, len, 0);
    ctx.bezierCurveTo(len * 0.8, wid * 0.6, len * 0.3, wid, 0, 0);
  }
  ctx.closePath();
}

function drawCluster(ctx, ox, oy, S, kind, seed) {
  const rnd = mulberry32(seed);
  ctx.save();
  ctx.translate(ox, oy);
  ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.clip();
  const conf = {
    oak: { n: 44, len: [80, 132], wid: 0.36, hue: [88, 104], sat: [32, 48], lit: [20, 34] },
    beech: { n: 50, len: [72, 112], wid: 0.33, hue: [86, 100], sat: [42, 60], lit: [22, 38] },
    birch: { n: 72, len: [44, 70], wid: 0.42, hue: [78, 96], sat: [40, 58], lit: [26, 42] },
  }[kind];
  // twig skeleton
  const tips = [];
  ctx.strokeStyle = '#4a3a2c';
  ctx.lineCap = 'round';
  const twig = (x, y, ang, len, w, depth) => {
    const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
    ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.quadraticCurveTo((x + x2) / 2 + (rnd() - 0.5) * 20, (y + y2) / 2 + (rnd() - 0.5) * 20, x2, y2);
    ctx.stroke();
    tips.push([x2, y2, ang]);
    for (let k = 0; k < 3; k++) tips.push([x + (x2 - x) * (0.35 + k * 0.2), y + (y2 - y) * (0.35 + k * 0.2), ang + (rnd() - 0.5) * 2]);
    if (depth > 0) {
      const n = 2 + Math.floor(rnd() * 2);
      for (let i = 0; i < n; i++) {
        const t = 0.35 + rnd() * 0.6;
        twig(x + (x2 - x) * t, y + (y2 - y) * t, ang + (rnd() < 0.5 ? -1 : 1) * (0.4 + rnd() * 0.6), len * (0.45 + rnd() * 0.25), w * 0.6, depth - 1);
      }
    }
  };
  twig(S * 0.5, S * 0.98, -Math.PI / 2 + (rnd() - 0.5) * 0.3, S * 0.62, 7, 2);
  // leaves, back layer first (darker)
  for (let layer = 0; layer < 2; layer++) {
    const n = Math.round(conf.n * (layer ? 0.7 : 0.55));
    for (let i = 0; i < n; i++) {
      const tp = tips[Math.floor(rnd() * tips.length)];
      const len = conf.len[0] + rnd() * (conf.len[1] - conf.len[0]);
      const wid = len * conf.wid * (0.85 + rnd() * 0.3);
      const ang = tp[2] + (rnd() - 0.5) * 2.4;
      const h = conf.hue[0] + rnd() * (conf.hue[1] - conf.hue[0]);
      const s = conf.sat[0] + rnd() * (conf.sat[1] - conf.sat[0]);
      let l = conf.lit[0] + rnd() * (conf.lit[1] - conf.lit[0]);
      if (!layer) l *= 0.72;
      ctx.save();
      ctx.translate(tp[0] + (rnd() - 0.5) * 14, tp[1] + (rnd() - 0.5) * 14);
      ctx.rotate(ang);
      const grad = ctx.createLinearGradient(0, 0, len, 0);
      grad.addColorStop(0, hsl(h - 4, s * 0.9, l * 0.82));
      grad.addColorStop(0.55, hsl(h, s, l));
      grad.addColorStop(1, hsl(h + 6, s * 1.05, l * 1.12));
      ctx.fillStyle = grad;
      drawLeafShape(ctx, kind, len, wid, rnd);
      ctx.fill();
      // side shading for curvature
      const g2 = ctx.createLinearGradient(0, -wid, 0, wid);
      g2.addColorStop(0, 'rgba(255,255,230,0.10)');
      g2.addColorStop(0.5, 'rgba(0,0,0,0)');
      g2.addColorStop(1, 'rgba(0,0,0,0.16)');
      ctx.fillStyle = g2;
      ctx.fill();
      // midrib + veins
      ctx.strokeStyle = hsl(h + 8, s * 0.7, Math.min(70, l * 1.6), 0.55);
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(2, 0); ctx.lineTo(len * 0.94, 0); ctx.stroke();
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = hsl(h + 8, s * 0.7, Math.min(70, l * 1.45), 0.32);
      for (let v = 1; v < 7; v++) {
        const t = v / 7.5;
        ctx.beginPath(); ctx.moveTo(len * t, 0); ctx.lineTo(len * (t + 0.12), -wid * 0.62 * Math.sin(Math.PI * t)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(len * t, 0); ctx.lineTo(len * (t + 0.12), wid * 0.62 * Math.sin(Math.PI * t)); ctx.stroke();
      }
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawFern(ctx, ox, oy, S, seed) {
  const rnd = mulberry32(seed);
  ctx.save();
  ctx.translate(ox, oy);
  ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.clip();
  // frond: rachis from bottom centre to top, pinnae on both sides
  const steps = 28;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([S * 0.5 + Math.sin(t * 2.2) * S * 0.02, S * (0.99 - t * 0.97)]);
  }
  ctx.strokeStyle = '#5c6a2c';
  ctx.lineWidth = 4;
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
  for (let i = 2; i < steps; i++) {
    const t = i / steps;
    const [x, y] = pts[i];
    const plen = S * 0.46 * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (1 - t * 0.35);
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(side > 0 ? -0.35 : Math.PI + 0.35);
      const nseg = 9;
      for (let k = 0; k < nseg; k++) {
        const u = k / nseg;
        const sl = plen / nseg * 1.25;
        const l = 24 + rnd() * 10;
        ctx.fillStyle = hsl(92 + rnd() * 10, 42 + rnd() * 12, l * (1 - u * 0.15));
        ctx.beginPath();
        ctx.ellipse(u * plen + sl * 0.5, 0, sl * 0.62, sl * 0.38 * (1 - u * 0.4), side * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(70,90,40,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(plen, 0); ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
}

export function makeLeafAtlas(size = 1024) {
  const [c, ctx] = canvas(size, size);
  const S = size / 2;
  drawCluster(ctx, 0, 0, S, 'oak', 11);
  drawCluster(ctx, S, 0, S, 'beech', 23);
  drawCluster(ctx, 0, S, S, 'birch', 37);
  drawFern(ctx, S, S, S, 41);
  const img = ctx.getImageData(0, 0, size, size);
  dilate(img, size, size, 5);
  return dataTex(new Uint8Array(img.data.buffer), size, size, { clamp: true, srgb: true, aniso: 4 });
}

// ---------------- bark ----------------
export function makeBark(kind, seed = 3) {
  const W = 256, H = 512;
  const fbm = makePeriodicNoise(seed);
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H;
    let r, g, b, hgt;
    if (kind === 'oak') {
      const fiss = fbm(u, v, 10, 4, 0.55, 0.25);
      const ridge = 1 - Math.abs(fiss * 2 - 1);
      const plate = Math.pow(ridge, 3);
      const fine = fbm(u, v, 48, 3, 0.5, 0.5);
      hgt = plate * 0.8 + fine * 0.2;
      const base = 0.17 + hgt * 0.22;
      const moss = Math.max(0, fbm(u + 0.3, v, 6, 3) - 0.58) * 2.2;
      r = base * 1.05; g = base * 0.96 + moss * 0.08; b = base * 0.86;
      r = r * (1 - moss * 0.4); b = b * (1 - moss * 0.5);
    } else if (kind === 'beech') {
      const n = fbm(u, v, 8, 4, 0.5, 2.0);
      const fine = fbm(u, v, 64, 2, 0.5, 1);
      const lichen = Math.max(0, fbm(u + 0.5, v + 0.2, 12, 3) - 0.62) * 3;
      const eye = Math.max(0, fbm(u * 1.0, v, 24, 2, 0.5, 4) - 0.78) * 4;
      hgt = n * 0.3 + fine * 0.15;
      const base = 0.40 + n * 0.12 + fine * 0.04;
      r = base * 0.95; g = base * 0.96; b = base * 0.92;
      r += lichen * 0.12; g += lichen * 0.16; b += lichen * 0.08;
      r -= eye * 0.18; g -= eye * 0.18; b -= eye * 0.18;
    } else if (kind === 'birch') {
      const n = fbm(u, v, 6, 4, 0.5, 1);
      const lent = fbm(u, v, 28, 3, 0.5, 0.06);
      const dash = Math.max(0, lent - 0.6) * 4.2;
      const patch = Math.max(0, fbm(u + 0.2, v, 5, 3) - 0.6) * 2.6;
      const peel = fbm(u, v, 40, 2, 0.5, 0.2);
      hgt = 0.5 - dash * 0.3 - patch * 0.3;
      let base = 0.82 + n * 0.1 + peel * 0.04;
      r = base; g = base * 0.985; b = base * 0.95;
      const dark = Math.min(1, dash + patch * 0.8);
      r = r * (1 - dark) + 0.08 * dark; g = g * (1 - dark) + 0.075 * dark; b = b * (1 - dark) + 0.07 * dark;
    } else {
      const n = fbm(u, v, 10, 4, 0.5, 0.5);
      const flute = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 5 + n * 3);
      hgt = flute * 0.4 + n * 0.3;
      const base = 0.3 + n * 0.12 + flute * 0.05;
      r = base * 0.98; g = base * 0.95; b = base * 0.88;
    }
    const k = (y * W + x) * 4;
    data[k] = Math.min(255, Math.max(0, r * 255));
    data[k + 1] = Math.min(255, Math.max(0, g * 255));
    data[k + 2] = Math.min(255, Math.max(0, b * 255));
    data[k + 3] = Math.min(255, Math.max(0, hgt * 255));
  }
  return dataTex(data, W, H, { srgb: true });
}

// ---------------- ground layers (texture array) ----------------
function wrapDraw(S, x, y, r, fn) {
  for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
    const xx = x + ox * S, yy = y + oy * S;
    if (xx + r < 0 || xx - r > S || yy + r < 0 || yy - r > S) continue;
    fn(xx, yy);
  }
}

function layerLitter(S, seed) {
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry32(seed);
  ctx.fillStyle = '#2f2418'; ctx.fillRect(0, 0, S, S);
  const n = Math.round(S * S / 90);
  for (let i = 0; i < n; i++) {
    const x = rnd() * S, y = rnd() * S, len = 5 + rnd() * 13, wid = len * (0.35 + rnd() * 0.25), a = rnd() * 6.28;
    const tone = rnd();
    const col = tone < 0.45 ? hsl(25 + rnd() * 15, 35 + rnd() * 25, 16 + rnd() * 14)
      : tone < 0.8 ? hsl(30 + rnd() * 12, 25 + rnd() * 20, 24 + rnd() * 14)
        : tone < 0.93 ? hsl(45 + rnd() * 15, 20 + rnd() * 15, 30 + rnd() * 10) : hsl(80 + rnd() * 30, 20, 20 + rnd() * 8);
    wrapDraw(S, x, y, len, (xx, yy) => {
      ctx.save(); ctx.translate(xx, yy); ctx.rotate(a);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo(-len / 2, 0); ctx.lineTo(len / 2, 0); ctx.stroke();
      ctx.restore();
    });
  }
  ctx.strokeStyle = 'rgba(40,28,18,0.9)';
  for (let i = 0; i < S / 6; i++) {
    const x = rnd() * S, y = rnd() * S, a = rnd() * 6.28, len = 10 + rnd() * 40;
    ctx.lineWidth = 1 + rnd() * 2;
    wrapDraw(S, x, y, len, (xx, yy) => { ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx + Math.cos(a) * len, yy + Math.sin(a) * len); ctx.stroke(); });
  }
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < S * S; i++) d[i * 4 + 3] = Math.min(255, (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) * 0.9);
  return d;
}

function layerRock(S, seed) {
  const fbm = makePeriodicNoise(seed);
  const d = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const n = fbm(u, v, 4, 5, 0.55);
    const strata = 0.5 + 0.5 * Math.sin((v * 18 + n * 3.5) * Math.PI);
    const crack = Math.pow(1 - Math.abs(fbm(u, v, 5, 3, 0.45) * 2 - 1), 22);
    const fine = fbm(u, v, 64, 2);
    const pit = fbm(u, v, 32, 3);
    const lich = Math.max(0, fbm(u + 0.4, v, 10, 3) - 0.62) * 2.5;
    let base = 0.52 + n * 0.2 + strata * 0.05 + fine * 0.07 + (pit - 0.5) * 0.1 - crack * 0.12;
    let r = base * 0.98, g = base * 0.96, b = base * 0.9;
    r += lich * 0.12; g += lich * 0.13; b -= lich * 0.05;
    const k = (y * S + x) * 4;
    d[k] = r * 255; d[k + 1] = g * 255; d[k + 2] = b * 255;
    d[k + 3] = (n * 0.6 + strata * 0.2 + fine * 0.2 - crack * 0.5) * 255;
  }
  return d;
}

function layerPebbles(S, seed) {
  const [c, ctx] = canvas(S, S);
  const rnd = mulberry32(seed);
  ctx.fillStyle = '#4a4236'; ctx.fillRect(0, 0, S, S);
  const n = Math.round(S * S / 260);
  for (let i = 0; i < n; i++) {
    const x = rnd() * S, y = rnd() * S, r = 4 + Math.pow(rnd(), 2) * 22, a = rnd() * 6.28, e = 0.6 + rnd() * 0.4;
    const tone = rnd();
    const L = 28 + rnd() * 30;
    const col = tone < 0.5 ? hsl(35, 8 + rnd() * 10, L) : tone < 0.8 ? hsl(28, 18 + rnd() * 14, L * 0.9) : hsl(210, 5, L * 0.85);
    wrapDraw(S, x, y, r, (xx, yy) => {
      ctx.save(); ctx.translate(xx, yy); ctx.rotate(a);
      const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
      g.addColorStop(0, col); g.addColorStop(1, 'rgba(20,18,14,1)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, 0, r, r * e, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    });
  }
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < S * S; i++) d[i * 4 + 3] = Math.min(255, (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) * 0.8);
  return d;
}

function layerDirt(S, seed) {
  const fbm = makePeriodicNoise(seed);
  const rnd = mulberry32(seed + 5);
  const d = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const n = fbm(u, v, 6, 5, 0.55);
    const fine = fbm(u, v, 90, 2);
    const base = 0.36 + n * 0.14 + fine * 0.08;
    const k = (y * S + x) * 4;
    d[k] = base * 1.0 * 255; d[k + 1] = base * 0.9 * 255; d[k + 2] = base * 0.76 * 255;
    d[k + 3] = (n * 0.7 + fine * 0.3) * 255;
  }
  // small stones
  for (let i = 0; i < S * S / 700; i++) {
    const cx = rnd() * S, cy = rnd() * S, r = 1 + rnd() * 3.5, L = 0.35 + rnd() * 0.3;
    for (let yy = -4; yy <= 4; yy++) for (let xx = -4; xx <= 4; xx++) {
      const dd = Math.hypot(xx, yy);
      if (dd > r) continue;
      const px = ((Math.round(cx + xx) % S) + S) % S, py = ((Math.round(cy + yy) % S) + S) % S;
      const k = (py * S + px) * 4;
      const sh = 1 - dd / r * 0.4;
      d[k] = L * 255 * sh; d[k + 1] = L * 0.95 * 255 * sh; d[k + 2] = L * 0.85 * 255 * sh; d[k + 3] = 255 * sh;
    }
  }
  return d;
}

export function makeGroundArray(S = 512) {
  const layers = [layerLitter(S, 5), layerRock(S, 9), layerPebbles(S, 13), layerDirt(S, 17)];
  const data = new Uint8Array(S * S * 4 * layers.length);
  layers.forEach((l, i) => data.set(l, i * S * S * 4));
  const t = new THREE.DataArrayTexture(data, S, S, layers.length);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------- flowers ----------------
export function makeFlowerAtlas(S = 256) {
  const [c, ctx] = canvas(S, S);
  const C = S / 2;
  const rnd = mulberry32(77);
  // buttercup
  ctx.save(); ctx.translate(C * 0.5, C * 0.5);
  for (let i = 0; i < 5; i++) {
    ctx.save(); ctx.rotate(i / 5 * Math.PI * 2);
    const g = ctx.createRadialGradient(0, -C * 0.18, 2, 0, -C * 0.18, C * 0.22);
    g.addColorStop(0, '#fff27a'); g.addColorStop(1, '#e8b908');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, -C * 0.2, C * 0.17, C * 0.21, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = '#c99a06'; ctx.beginPath(); ctx.arc(0, 0, C * 0.07, 0, 7); ctx.fill();
  ctx.restore();
  // daisy
  ctx.save(); ctx.translate(C * 1.5, C * 0.5);
  for (let i = 0; i < 22; i++) {
    ctx.save(); ctx.rotate(i / 22 * Math.PI * 2 + rnd() * 0.1);
    ctx.fillStyle = i % 3 ? '#f7f5ee' : '#ece8de';
    ctx.beginPath(); ctx.ellipse(0, -C * 0.24, C * 0.045, C * 0.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = '#e8b51c'; ctx.beginPath(); ctx.arc(0, 0, C * 0.1, 0, 7); ctx.fill();
  ctx.restore();
  // umbel (cow parsley)
  ctx.save(); ctx.translate(C * 0.5, C * 1.5);
  for (let i = 0; i < 70; i++) {
    const a = rnd() * 6.28, r = Math.sqrt(rnd()) * C * 0.42;
    ctx.fillStyle = rnd() < 0.5 ? '#f4f2ea' : '#e2e0d4';
    ctx.beginPath(); ctx.arc(Math.cos(a) * r, Math.sin(a) * r, C * (0.025 + rnd() * 0.02), 0, 7); ctx.fill();
  }
  ctx.restore();
  // clover
  ctx.save(); ctx.translate(C * 1.5, C * 1.5);
  for (let i = 0; i < 60; i++) {
    const a = rnd() * 6.28, r = Math.sqrt(rnd()) * C * 0.3;
    ctx.fillStyle = hsl(320 + rnd() * 20, 40 + rnd() * 20, 55 + rnd() * 20);
    ctx.beginPath(); ctx.ellipse(Math.cos(a) * r, Math.sin(a) * r, C * 0.03, C * 0.07, a, 0, 7); ctx.fill();
  }
  ctx.restore();
  const img = ctx.getImageData(0, 0, S, S);
  dilate(img, S, S, 6);
  return dataTex(new Uint8Array(img.data.buffer), S, S, { clamp: true, srgb: true });
}

// ---------------- misc ----------------
export function makeNoiseTex(S = 256) {
  const fbm = makePeriodicNoise(99);
  const rnd = mulberry32(5);
  const d = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, k = (y * S + x) * 4;
    d[k] = fbm(u, v, 4, 4) * 255;
    d[k + 1] = fbm(u + 0.37, v + 0.71, 8, 4) * 255;
    d[k + 2] = fbm(u, v, 32, 3) * 255;
    d[k + 3] = rnd() * 255;
  }
  const t = dataTex(d, S, S, {});
  return t;
}

export function makeWeatherMap(S = 512) {
  const fbm = makePeriodicNoise(1234);
  const fbm2 = makePeriodicNoise(4321);
  const d = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, k = (y * S + x) * 4;
    const a = fbm(u, v, 6, 5, 0.55);
    const b = fbm2(u, v, 12, 4, 0.5);
    d[k] = Math.min(255, Math.max(0, (a * 1.25 - 0.12) * 255));
    d[k + 1] = b * 255;
    d[k + 2] = fbm2(u + 0.5, v, 3, 3) * 255;
    d[k + 3] = 255;
  }
  return dataTex(d, S, S, {});
}

export function makeConcrete(S = 512) {
  const fbm = makePeriodicNoise(808);
  const d = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, k = (y * S + x) * 4;
    const n = fbm(u, v, 8, 5, 0.55);
    const streak = fbm(u, v, 40, 3, 0.5, 0.08);
    const fine = fbm(u, v, 128, 2);
    const seam = (Math.abs(((v * 4) % 1) - 0.5) > 0.492 || Math.abs(((u * 2) % 1) - 0.5) > 0.495) ? 0.75 : 1;
    let base = (0.5 + n * 0.14 + fine * 0.05 - Math.max(0, streak - 0.55) * 0.5) * seam;
    d[k] = base * 0.98 * 255; d[k + 1] = base * 0.97 * 255; d[k + 2] = base * 0.94 * 255; d[k + 3] = 255;
  }
  return dataTex(d, S, S, { srgb: true });
}

export function makeFenceTex(S = 128) {
  const [c, ctx] = canvas(S, S);
  ctx.strokeStyle = '#9aa0a2';
  ctx.lineWidth = 2.2;
  const n = 6;
  for (let i = -n; i <= 2 * n; i++) {
    ctx.beginPath(); ctx.moveTo(i * S / n, 0); ctx.lineTo(i * S / n + S, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i * S / n + S, 0); ctx.lineTo(i * S / n, S); ctx.stroke();
  }
  const img = ctx.getImageData(0, 0, S, S);
  dilate(img, S, S, 4);
  return dataTex(new Uint8Array(img.data.buffer), S, S, { srgb: true });
}
