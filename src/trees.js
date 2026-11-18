// Procedural broadleaf trees: recursive skeleton -> bark tubes + leaf-cluster cards, two mesh LODs and a baked impostor.
import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { patch, ALPHA_SHARPEN, G } from './shaderlib.js';
import { ChunkedInstances, composeMatrices, makeInstanced, cascadePrefix, FADE_GLSL_VS, FADE_GLSL_FS, FADE_VS, FADE_FS, fadeUniforms } from './instancing.js';

export const SPECIES = [
  { name: 'oak', H: [13, 17], trunkFrac: 0.3, trunkR: 0.42, leader: 0.78, children: [7, 4, 3], angle: [64, 50, 44], lenRatio: [0.55, 0.62, 0.55],
    radRatio: [0.52, 0.6, 0.62], wobble: [0.07, 0.2, 0.28], grav: [0.0, 0.05, -0.02], env: 'round', cell: 0, leafSize: 1.59, leafDensity: 8.8, bark: 'oak', tint: [1, 1, 1] },
  { name: 'beech', H: [19, 24], trunkFrac: 0.42, trunkR: 0.36, leader: 1.0, children: [8, 4, 3], angle: [50, 44, 38], lenRatio: [0.42, 0.62, 0.55],
    radRatio: [0.48, 0.6, 0.62], wobble: [0.03, 0.12, 0.22], grav: [0.03, 0.03, -0.04], env: 'ellipse', cell: 1, leafSize: 1.52, leafDensity: 9.3, bark: 'beech', tint: [1, 1, 1] },
  { name: 'birch', H: [14, 18], trunkFrac: 0.28, trunkR: 0.19, leader: 1.0, children: [11, 3, 3], angle: [40, 36, 46], lenRatio: [0.36, 0.62, 0.62],
    radRatio: [0.42, 0.55, 0.6], wobble: [0.05, 0.14, 0.22], grav: [0.0, -0.07, -0.16], env: 'cone', cell: 2, leafSize: 1.22, leafDensity: 11.5, bark: 'birch', tint: [1, 1, 1] },
  { name: 'small', H: [6, 9], trunkFrac: 0.16, trunkR: 0.13, leader: 0.85, children: [6, 4, 3], angle: [52, 46, 40], lenRatio: [0.58, 0.62, 0.55],
    radRatio: [0.55, 0.6, 0.62], wobble: [0.1, 0.22, 0.28], grav: [0.02, 0.02, -0.03], env: 'round', cell: 1, leafSize: 1.28, leafDensity: 10.2, bark: 'small', tint: [0.86, 1.06, 0.8] },
];

const UP = new THREE.Vector3(0, 1, 0);

function envelope(kind, t) {
  if (kind === 'round') return 0.38 + 0.62 * Math.sin(Math.PI * (0.12 + 0.88 * t));
  if (kind === 'ellipse') return Math.pow(Math.max(0.05, Math.sin(Math.PI * (0.08 + 0.92 * t))), 0.7);
  if (kind === 'cone') return 1 - 0.72 * t;
  return 1;
}

function rotateOff(d, az, a) {
  const u = new THREE.Vector3().crossVectors(d, Math.abs(d.y) < 0.95 ? UP : new THREE.Vector3(1, 0, 0)).normalize();
  const v = new THREE.Vector3().crossVectors(d, u);
  const w = u.multiplyScalar(Math.cos(az)).add(v.multiplyScalar(Math.sin(az)));
  return d.clone().multiplyScalar(Math.cos(a)).add(w.multiplyScalar(Math.sin(a))).normalize();
}

export function genTree(sp, seed, opts = {}) {
  const rnd = mulberry32(seed);
  const rv = () => new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
  const H = sp.H[0] + rnd() * (sp.H[1] - sp.H[0]);
  const maxLevel = sp.children.length;
  const branches = [];

  function grow(start, dir, length, r0, level, parentT) {
    const segs = [12, 7, 5, 4][level];
    const pts = [start.clone()], radii = [r0], dirs = [dir.clone()];
    const p = start.clone(), d = dir.clone();
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      d.add(rv().multiplyScalar(sp.wobble[Math.min(level, 2)])).add(new THREE.Vector3(0, sp.grav[Math.min(level, 2)] * (level ? 1 : 0), 0)).normalize();
      if (level === 0) d.lerp(UP, 0.25).normalize();
      p.addScaledVector(d, length / segs);
      pts.push(p.clone());
      radii.push(r0 * Math.max(0.12, 1 - t * (level === 0 ? 0.82 : 0.88)));
      dirs.push(d.clone());
    }
    const b = { pts, radii, dirs, level, length, phase: rnd() * 6.28, parentT };
    branches.push(b);
    if (level >= maxLevel) return;
    const n = sp.children[level] + Math.floor(rnd() * 2);
    const tStart = level === 0 ? sp.trunkFrac : 0.25 + rnd() * 0.1;
    for (let k = 0; k < n; k++) {
      const t = tStart + (0.97 - tStart) * ((k + 0.3 + rnd() * 0.4) / n);
      const fi = t * segs, i0 = Math.min(segs - 1, Math.floor(fi)), f = fi - i0;
      const pos = pts[i0].clone().lerp(pts[i0 + 1], f);
      const rad = radii[i0] + (radii[i0 + 1] - radii[i0]) * f;
      const pd = dirs[i0].clone().lerp(dirs[i0 + 1], f).normalize();
      const az = k * 2.39996 + rnd() * 0.6;
      let a = sp.angle[level] * Math.PI / 180 * (0.8 + rnd() * 0.4);
      let len;
      if (level === 0) {
        const tc = (t - sp.trunkFrac) / (1 - sp.trunkFrac);
        a *= 1.15 - 0.45 * tc;
        len = H * sp.lenRatio[0] * envelope(sp.env, tc) * (0.8 + rnd() * 0.4);
      } else {
        len = length * sp.lenRatio[level] * (1 - t * 0.35) * (0.75 + rnd() * 0.5);
      }
      const cd = rotateOff(pd, az, a);
      grow(pos, cd, len, Math.min(rad * 0.85, r0 * sp.radRatio[level] * (0.8 + rnd() * 0.3)), level + 1, t);
    }
  }
  const lean = new THREE.Vector3(rnd() - 0.5, 0, rnd() - 0.5).multiplyScalar(0.12);
  grow(new THREE.Vector3(0, -0.4, 0), UP.clone().add(lean).normalize(), H * sp.leader, sp.trunkR, 0, 0);

  // crown centre from terminal branch tips
  const c = new THREE.Vector3(); let nc = 0;
  for (const b of branches) if (b.level >= maxLevel - 1) { c.add(b.pts[b.pts.length - 1]); nc++; }
  c.divideScalar(Math.max(1, nc));
  let cr = 0;
  for (const b of branches) if (b.level >= maxLevel - 1) cr = Math.max(cr, b.pts[b.pts.length - 1].distanceTo(c));
  cr *= 0.92;

  const leaves = [];
  const dens = sp.leafDensity * (opts.leafScale || 1);
  for (const b of branches) {
    if (b.level < maxLevel - 1) continue;
    const terminal = b.level === maxLevel;
    const t0 = terminal ? 0.25 : 0.62;
    const count = Math.round(b.length * (1 - t0) * dens * (terminal ? 1 : 0.5));
    for (let k = 0; k < count; k++) {
      const t = t0 + (1 - t0) * rnd();
      const fi = t * (b.pts.length - 1), i0 = Math.min(b.pts.length - 2, Math.floor(fi)), f = fi - i0;
      const anchor = b.pts[i0].clone().lerp(b.pts[i0 + 1], f).add(rv().multiplyScalar(0.18));
      const out = anchor.clone().sub(new THREE.Vector3(c.x, Math.min(anchor.y, c.y), c.z)).normalize();
      const bd = b.dirs[i0];
      const up = bd.clone().multiplyScalar(0.5).add(out.clone().multiplyScalar(0.7)).add(rv().multiplyScalar(0.45)).normalize();
      let nrm = rv().normalize();
      nrm.addScaledVector(up, -nrm.dot(up)).normalize();
      const size = sp.leafSize * (0.8 + rnd() * 0.4);
      leaves.push({ anchor, up, nrm, size, phase: rnd() * 6.28 });
    }
  }
  // crown filler: cards on a shell around the crown so silhouettes read as dense masses
  if (opts.fill !== 0) {
    const box = new THREE.Box3();
    for (const b of branches) if (b.level >= maxLevel - 1) box.expandByPoint(b.pts[b.pts.length - 1]);
    const ctr = box.getCenter(new THREE.Vector3()), half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    half.x = Math.max(half.x, 0.8); half.z = Math.max(half.z, 0.8); half.y = Math.max(half.y, 0.8);
    const area = 4 * Math.PI * Math.pow((half.x * half.y + half.y * half.z + half.x * half.z) / 3, 1);
    const nFill = Math.round(area / (sp.leafSize * sp.leafSize) * 1.5 * (opts.fill || 1) * (opts.leafScale || 1));
    for (let k = 0; k < nFill; k++) {
      const d = rv(); if (d.lengthSq() > 1 || d.lengthSq() < 1e-3) { k--; continue; }
      d.normalize();
      const r = 0.62 + 0.38 * Math.pow(rnd(), 0.6);
      const anchor = new THREE.Vector3(ctr.x + d.x * half.x * r, ctr.y + d.y * half.y * r * 0.92, ctr.z + d.z * half.z * r);
      if (anchor.y < sp.trunkFrac * H * 0.9) continue;
      const out = d.clone();
      const up = out.clone().multiplyScalar(0.6).add(new THREE.Vector3(0, 0.5, 0)).add(rv().multiplyScalar(0.5)).normalize();
      let nrm = rv().normalize(); nrm.addScaledVector(up, -nrm.dot(up)).normalize();
      leaves.push({ anchor, up, nrm, size: sp.leafSize * (0.85 + rnd() * 0.4), phase: rnd() * 6.28 });
    }
  }
  return { branches, leaves, H, crownC: c, crownR: cr, maxLevel, sp };
}

export function buildTrunkGeometry(tree, opt = {}) {
  const maxLevel = opt.maxLevel ?? 99;
  const radial = opt.radial || [11, 6, 4, 3];
  const step = opt.step || 1;
  const pos = [], nor = [], uv = [], wind = [], idx = [];
  let base = 0;
  for (const b of tree.branches) {
    if (b.level > maxLevel) continue;
    const R = radial[Math.min(b.level, radial.length - 1)];
    const pts = b.pts.filter((_, i) => i % step === 0 || i === b.pts.length - 1);
    const radii = b.radii.filter((_, i) => i % step === 0 || i === b.radii.length - 1);
    const n = pts.length;
    const T = [], N = [], B = [];
    for (let i = 0; i < n; i++) {
      const t = (i < n - 1 ? pts[i + 1].clone().sub(pts[i]) : pts[i].clone().sub(pts[i - 1])).normalize();
      T.push(t);
    }
    let nn = new THREE.Vector3().crossVectors(T[0], Math.abs(T[0].y) < 0.95 ? UP : new THREE.Vector3(1, 0, 0)).normalize();
    for (let i = 0; i < n; i++) {
      if (i > 0) { nn.addScaledVector(T[i], -nn.dot(T[i])).normalize(); }
      N.push(nn.clone()); B.push(new THREE.Vector3().crossVectors(T[i], nn));
    }
    const r0 = radii[0];
    const uRep = Math.max(1, Math.round(2 * Math.PI * r0 / 0.85));
    let acc = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) acc += pts[i].distanceTo(pts[i - 1]);
      const tAlong = i / (n - 1);
      for (let j = 0; j <= R; j++) {
        const th = j / R * Math.PI * 2;
        const cs = Math.cos(th), sn = Math.sin(th);
        let r = radii[i];
        if (b.level === 0) {
          const y = pts[i].y + 0.4;
          r *= 1 + 0.6 * Math.exp(-y * 2.0) * (1 + 0.25 * Math.sin(th * 5 + b.phase));
        }
        const dx = N[i].x * cs + B[i].x * sn, dy = N[i].y * cs + B[i].y * sn, dz = N[i].z * cs + B[i].z * sn;
        pos.push(pts[i].x + dx * r, pts[i].y + dy * r, pts[i].z + dz * r);
        nor.push(dx, dy, dz);
        uv.push(j / R * uRep, acc / 1.15);
        const sw = b.level === 0 ? 0 : Math.min(1, 0.25 * b.level + tAlong * 0.35 * b.level);
        wind.push(sw, b.phase);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < R; j++) {
        const a = base + i * (R + 1) + j, bq = a + R + 1;
        idx.push(a, bq, a + 1, a + 1, bq, bq + 1);
      }
    }
    base += n * (R + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aWind', new THREE.Float32BufferAttribute(wind, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export function buildLeafGeometry(tree, opt = {}) {
  const every = opt.every || 1, scale = opt.scale || 1;
  const cell = opt.cell ?? tree.sp.cell;
  const u0 = (cell % 2) * 0.5, v0 = Math.floor(cell / 2) * 0.5;
  const pos = [], nor = [], uv = [], leaf = [], idx = [];
  const c = tree.crownC, cr = Math.max(tree.crownR, 0.5);
  let v = 0;
  const right = new THREE.Vector3(), cn = new THREE.Vector3(), p = new THREE.Vector3();
  tree.leaves.forEach((L, i) => {
    if (i % every) return;
    const s = L.size * scale;
    right.crossVectors(L.up, L.nrm).normalize();
    const d = L.anchor.distanceTo(c) / cr;
    cn.copy(L.anchor).sub(c).normalize();
    const n = cn.clone().multiplyScalar(0.78).addScaledVector(L.nrm, 0.22 * Math.sign(L.nrm.dot(cn) || 1)).normalize();
    const hf = Math.min(1, Math.max(0, L.anchor.y / tree.H));
    const ao = Math.min(1, Math.max(0.42, 0.38 + 0.75 * Math.pow(d, 1.3))) * (0.8 + 0.2 * hf);
    const sway = Math.min(1, 0.35 + 0.65 * d);
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]];
    for (const [cx, cy] of corners) {
      p.copy(L.anchor).addScaledVector(right, (cx - 0.5) * s).addScaledVector(L.up, (cy - 0.06) * s);
      pos.push(p.x, p.y, p.z);
      nor.push(n.x, n.y, n.z);
      uv.push(u0 + (0.02 + cx * 0.96) * 0.5, v0 + (1 - (0.02 + cy * 0.96)) * 0.5);
      leaf.push(sway, L.phase, ao, cy);
    }
    idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    v += 4;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(leaf, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ---------------- materials ----------------
const TREE_WIND = /* glsl */`
  vec3 iorg = vec3(0.0);
  float s2 = 1.0;
  #ifdef USE_INSTANCING
  iorg = instanceMatrix[3].xyz;
  s2 = dot(instanceMatrix[0].xyz, instanceMatrix[0].xyz);
  #endif
  float ph0 = fract(iorg.x * 0.137 + iorg.z * 0.071) * 6.28;
  vec2 wb = windBend(iorg.xz, ph0);
  float hN = clamp(position.y / uTreeH, 0.0, 1.3);
  vec3 off = vec3(wb.x, 0.0, wb.y) * hN * hN * uSway;
  off.y -= dot(off.xz, off.xz) * 0.25 / uTreeH;
`;

function treeWindVertex(isLeaf) {
  return /* glsl */`
    vec3 pos = position;
    vec3 nrm = normal;
    ${TREE_WIND}
    ${isLeaf ? `
      float fl = aLeaf.x * (0.35 + uWind);
      float ph = aLeaf.y + ph0;
      off += vec3(sin(uTime * 2.1 + ph), sin(uTime * 1.6 + ph * 1.7) * 0.5, cos(uTime * 1.9 + ph * 0.7)) * fl * 0.06;
      off += nrm * sin(uTime * 7.0 + ph * 3.0) * 0.025 * fl * aLeaf.w;
      float ao = aLeaf.z;
    ` : `
      float fl = aWind.x * (0.3 + uWind);
      off += vec3(sin(uTime * 1.7 + aWind.y), 0.0, cos(uTime * 1.5 + aWind.y)) * fl * 0.05;
      float ao = clamp(0.55 + position.y * 0.12, 0.55, 1.0);
    `}
    #ifdef USE_INSTANCING
    pos += transpose(mat3(instanceMatrix)) * off / s2;
    #else
    pos += off;
    #endif
  `;
}

export function makeLeafMaterial(tex, q, sp, fade, isDepth = false) {
  const uniforms = Object.assign({ uTreeH: { value: 15 }, uSway: { value: 0.6 }, uTint: { value: new THREE.Vector3(...sp.tint) } }, fadeUniforms(fade[0], fade[1]));
  const mat = isDepth
    ? new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex.leaves, alphaTest: 0.5, side: THREE.DoubleSide })
    : new THREE.MeshLambertMaterial({ map: tex.leaves, alphaTest: 0.5, side: THREE.DoubleSide, alphaToCoverage: q.msaa > 0 });
  patch(mat, {
    key: isDepth ? 'leafD' : 'leaf',
    uniforms,
    foliage: isDepth ? null : { translucency: 0.75, wrap: 0.6 },
    defines: isDepth ? {} : { FOLIAGE_SPEC: '0.12' },
    vertexPars: 'attribute vec4 aLeaf; uniform float uTreeH; uniform float uSway;' + FADE_GLSL_VS,
    vertexMain: treeWindVertex(true),
    vertexEnd: FADE_VS,
    fragmentPars: 'uniform vec3 uTint;' + FADE_GLSL_FS + ALPHA_SHARPEN,
    fragmentColor: `
      ${FADE_FS}
      diffuseColor.rgb *= uTint * (1.0 - uWetness * 0.2);
      ${q.msaa > 0 && !isDepth ? 'diffuseColor.a = sharpenAlpha(diffuseColor.a, vMapUv, 1024.0, 0.5);' : ''}
    `,
    fragmentAlpha: q.msaa > 0 && !isDepth ? 'if (diffuseColor.a < 0.02) discard;' : undefined,
    fragmentNormal: 'vec3 normal = normalize(vNormal);',
  });
  mat.userData.u = uniforms;
  return mat;
}

export function makeBarkMaterial(barkTex, q, fade, birch, isDepth = false) {
  const uniforms = Object.assign({ uTreeH: { value: 15 }, uSway: { value: 0.6 } }, fadeUniforms(fade[0], fade[1]));
  const mat = isDepth
    ? new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    : new THREE.MeshLambertMaterial({ map: barkTex });
  patch(mat, {
    key: (isDepth ? 'barkD' : 'bark') + (birch ? 'B' : ''),
    uniforms,
    defines: birch ? { BIRCH: '' } : {},
    vertexPars: 'attribute vec2 aWind; uniform float uTreeH; uniform float uSway; varying float vH;' + FADE_GLSL_VS,
    vertexMain: treeWindVertex(false) + 'vH = position.y;',
    vertexEnd: FADE_VS,
    fragmentPars: 'varying float vH;' + FADE_GLSL_FS,
    fragmentColor: `
      ${FADE_FS}
      #ifdef BIRCH
      diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.32, 0.3, 0.28), diffuseColor.rgb, smoothstep(0.4, 2.2, vH + texture(uNoiseTex, vMapUv * 0.3).r * 0.8));
      #endif
      diffuseColor.rgb *= mix(vec3(0.75, 0.8, 0.62), vec3(1.0), smoothstep(0.0, 1.6, vH));
      diffuseColor.rgb *= 1.0 - uWetness * 0.4;
    `,
  });
  mat.userData.u = uniforms;
  return mat;
}

// ---------------- impostors ----------------
function bakeMaterial(kind, tex, sp, barkTex) {
  // kind: 'leafA' | 'leafN' | 'barkA' | 'barkN'
  const leaf = kind.startsWith('leaf');
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { uMap: { value: leaf ? tex.leaves : barkTex }, uTint: { value: new THREE.Vector3(...sp.tint) } },
    vertexShader: /* glsl */`
      ${leaf ? 'attribute vec4 aLeaf;' : ''}
      varying vec2 vUv; varying vec3 vN; varying float vAO;
      void main() {
        vUv = uv; vN = normal;
        vAO = ${leaf ? 'aLeaf.z' : 'clamp(0.55 + position.y * 0.12, 0.55, 1.0)'};
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap; uniform vec3 uTint;
      varying vec2 vUv; varying vec3 vN; varying float vAO;
      void main() {
        vec4 c = texture2D(uMap, vUv);
        ${leaf ? 'if (c.a < 0.5) discard;' : ''}
        ${kind.endsWith('A') ? `gl_FragColor = vec4(c.rgb * ${leaf ? 'uTint' : 'vec3(1.0)'}, vAO);` : 'gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, 1.0);'}
      }`,
  });
}

export class Trees {
  constructor(renderer, world, q, tex) {
    this.q = q;
    this.group = new THREE.Group();
    this.variants = [];
    const d0 = q.treeLod0, d1 = q.treeLod1, band = q.lodBand;
    // fades: lod0 out at d0, lod1 in at d0 / out at d1, impostor in at d1
    const f0 = [[-2, -1], [d0 - band, d0 + band]];
    const f1 = [[d0 - band, d0 + band], [d1 - band, d1 + band]];
    for (let v = 0; v < 8; v++) {
      const sp = SPECIES[v >> 1];
      const t = genTree(sp, 1000 + v * 77, { leafScale: q.leafScale });
      const lod0 = { trunk: buildTrunkGeometry(t, { maxLevel: 2, radial: [9, 5, 3] }), leaves: buildLeafGeometry(t) };
      const lod1 = { trunk: buildTrunkGeometry(t, { maxLevel: 1, radial: [6, 4], step: 2 }), leaves: buildLeafGeometry(t, { every: 3, scale: 1.55 }) };
      const birch = sp.name === 'birch';
      const mk = (fade) => {
        const lm = makeLeafMaterial(tex, q, sp, fade), ld = makeLeafMaterial(tex, q, sp, fade, true);
        const bm = makeBarkMaterial(tex.bark[sp.bark], q, fade, birch), bd = makeBarkMaterial(null, q, fade, birch, true);
        for (const m of [lm, ld, bm, bd]) { m.userData.u.uTreeH.value = t.H; m.userData.u.uSway.value = sp.name === 'small' ? 0.25 : sp.name === 'birch' ? 0.75 : 0.55; }
        return { lm, ld, bm, bd };
      };
      this.variants.push({ sp, tree: t, lod0, lod1, m0: mk(f0), m1: mk(f1) });
    }
    // instance data
    const T = world.trees, n = T.length / 8;
    const pos = new Float32Array(n * 4), variant = new Uint16Array(n);
    const matrices = composeMatrices(n, (i) => ({ x: T[i * 8], y: T[i * 8 + 1], z: T[i * 8 + 2], ry: T[i * 8 + 3], sx: T[i * 8 + 4] }));
    const vcount = new Array(8).fill(0);
    for (let i = 0; i < n; i++) {
      pos[i * 4] = T[i * 8]; pos[i * 4 + 1] = T[i * 8 + 1] + 6; pos[i * 4 + 2] = T[i * 8 + 2]; pos[i * 4 + 3] = 1e9;
      variant[i] = T[i * 8 + 5];
      vcount[variant[i]]++;
    }
    const meshes = this.variants.map((V, v) => {
      const cap0 = Math.min(vcount[v], q.treeCap0), cap1 = Math.min(vcount[v], q.treeCap1);
      const tr0 = makeInstanced(V.lod0.trunk, V.m0.bm, cap0), lf0 = makeInstanced(V.lod0.leaves, V.m0.lm, cap0);
      const tr1 = makeInstanced(V.lod1.trunk, V.m1.bm, cap1), lf1 = makeInstanced(V.lod1.leaves, V.m1.lm, cap1);
      tr0.customDepthMaterial = V.m0.bd; lf0.customDepthMaterial = V.m0.ld;
      tr1.customDepthMaterial = V.m1.bd; lf1.customDepthMaterial = V.m1.ld;
      for (const m of [tr0, lf0]) { m.castShadow = q.shadows > 0; m.receiveShadow = true; m.layers.set(1); cascadePrefix(m); }
      for (const m of [tr1, lf1]) {
        m.castShadow = q.shadows > 1; m.receiveShadow = true; m.layers.set(2);
        // far LOD only casts into the far cascade: skip the draw in near cascades
        m.onBeforeShadow = (r, o, c, shadowCam) => { if (shadowCam.userData.cascade < q.shadows - 1) { m.userData.saved = m.count; m.count = 0; } };
        m.onAfterShadow = () => { if (m.userData.saved !== undefined) { m.count = m.userData.saved; m.userData.saved = undefined; } };
      }
      this.group.add(tr0, lf0, tr1, lf1);
      return [[tr0, lf0], [tr1, lf1]];
    });
    this.chunked = new ChunkedInstances({ matrices, pos, variant }, [d0, d1], band, meshes);
    this.chunked.sortRadii = [q.cascadeSplits[0] + 14, (q.cascadeSplits[1] || 60) + 22];
    this.instanceCaps = [q.treeCap0, q.treeCap1];
    this.bakeImpostors(renderer, tex, world);
  }

  bakeImpostors(renderer, tex, world) {
    const q = this.q;
    const S = q.impostorRes;
    const W = S * 4, Hh = S * 2;
    const mkRT = () => {
      const rt = new THREE.WebGLRenderTarget(W, Hh, { depthBuffer: true });
      rt.texture.generateMipmaps = true;
      rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      return rt;
    };
    const rtA = mkRT(), rtN = mkRT();
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    const sizes = [];
    const prevRT = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const [rt, suffix] of [[rtA, 'A'], [rtN, 'N']]) {
      renderer.setRenderTarget(rt);
      renderer.clear();
      this.variants.forEach((V, v) => {
        const t = V.tree;
        const box = new THREE.Box3().setFromBufferAttribute(V.lod0.leaves.attributes.position);
        box.union(new THREE.Box3().setFromBufferAttribute(V.lod0.trunk.attributes.position));
        const halfW = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)) * 1.02;
        const bottom = -0.5, top = box.max.y * 1.02;
        if (suffix === 'A') sizes.push(new THREE.Vector3(halfW * 2, top - bottom, bottom));
        cam.left = -halfW; cam.right = halfW; cam.top = top; cam.bottom = bottom;
        cam.position.set(0, 0, 100); cam.lookAt(0, 0, 0);
        cam.updateProjectionMatrix();
        const trunk = new THREE.Mesh(V.lod0.trunk, bakeMaterial('bark' + suffix, tex, V.sp, tex.bark[V.sp.bark]));
        const leaves = new THREE.Mesh(V.lod0.leaves, bakeMaterial('leaf' + suffix, tex, V.sp));
        scene.add(trunk, leaves);
        const cx = (v % 4) * S, cy = Math.floor(v / 4) * S;
        rt.viewport.set(cx, cy, S, S); rt.scissor.set(cx, cy, S, S); rt.scissorTest = true;
        renderer.setRenderTarget(rt);
        renderer.render(scene, cam);
        scene.remove(trunk, leaves);
        trunk.material.dispose(); leaves.material.dispose();
      });
      rt.scissorTest = false;
      rt.viewport.set(0, 0, W, Hh);
    }
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevClear, prevAlpha);

    // instances: near-map trees + mountain canopy blobs, shuffled so a prefix is a uniform subset
    const T = world.trees, B = world.blobs;
    const nT = T.length / 8, nB = B.length / 6;
    const items = [];
    for (let i = 0; i < nT; i++) items.push([T[i * 8], T[i * 8 + 1], T[i * 8 + 2], T[i * 8 + 4], T[i * 8 + 5], T[i * 8 + 6]]);
    for (let i = 0; i < nB; i++) {
      const r = B[i * 6 + 5];
      const variant = r < 0.45 ? (r < 0.22 ? 0 : 1) : r < 0.85 ? (r < 0.65 ? 2 : 3) : 6 + (r < 0.93 ? 0 : 1);
      items.push([B[i * 6], B[i * 6 + 1], B[i * 6 + 2], B[i * 6 + 4], variant, (i * 0.6180339) % 1]);
    }
    items.sort((a, b) => a[5] - b[5]);
    const n = items.length;
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
    quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    quad.setIndex([0, 1, 2, 1, 3, 2]);
    const off = new Float32Array(n * 4), info = new Float32Array(n * 2);
    items.forEach((it, i) => {
      off.set([it[0], it[1], it[2], it[3]], i * 4);
      info[i * 2] = it[4]; info[i * 2 + 1] = (i * 7919) % 2;
    });
    quad.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
    quad.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 2));
    quad.instanceCount = Math.round(n * q.impostorFraction);
    const sizeArr = sizes.map((s) => new THREE.Vector3(s.x, s.y, s.z));
    const mat = new THREE.MeshLambertMaterial({ map: rtA.texture, alphaTest: 0.5, alphaToCoverage: q.msaa > 0, side: THREE.DoubleSide });
    const d1 = q.treeLod1, band = q.lodBand;
    const scaleUp = 1 / Math.sqrt(Math.max(0.2, q.impostorFraction));
    patch(mat, {
      key: 'impostor',
      uniforms: {
        uNormalAtlas: { value: rtN.texture },
        uSizes: { value: sizeArr },
        uFadeStart: { value: new THREE.Vector2(d1 - band, d1 + band) },
        uScaleUp: { value: Math.min(1.6, scaleUp) },
      },
      foliage: { translucency: 0.5, wrap: 0.55 },
      vertexPars: /* glsl */`
        attribute vec4 aOff; attribute vec2 aInfo;
        uniform vec3 uSizes[8];
        uniform vec2 uFadeStart;
        uniform float uScaleUp;
        varying vec2 vAtlasUv; varying vec3 vR; varying vec3 vF; varying float vFade; varying float vFlip;
      `,
      vertexMain: /* glsl */`
        int vi = int(aInfo.x + 0.5);
        vec3 sz = uSizes[vi];
        vec3 base = aOff.xyz;
        float dist = length(base - cameraPosition);
        float sc = aOff.w * mix(1.0, uScaleUp, smoothstep(uFadeStart.y, uFadeStart.y + 400.0, dist));
        vec3 toCam = cameraPosition - base; toCam.y = 0.0;
        vec3 F = normalize(toCam + vec3(1e-4, 0.0, 0.0));
        vec3 R = normalize(cross(vec3(0.0, 1.0, 0.0), F));
        float flip = aInfo.y > 0.5 ? -1.0 : 1.0;
        vec3 pos = base + R * position.x * sz.x * sc + vec3(0.0, 1.0, 0.0) * (position.y * sz.y + sz.z) * sc;
        // tilt the card slightly back when seen from above
        float collapse = dist < uFadeStart.x - 2.0 ? 0.0 : 1.0;
        pos = mix(base, pos, collapse);
        vec3 nrm = F;
        float cu = (float(vi % 4) + (flip > 0.0 ? uv.x : 1.0 - uv.x)) / 4.0;
        float cv = (float(vi / 4) + uv.y) / 2.0;
        vAtlasUv = vec2(cu, cv);
        #ifdef USE_MAP
        vMapUv = vAtlasUv;
        #endif
        vR = R * flip; vF = F;
        vFade = smoothstep(uFadeStart.x, uFadeStart.y, dist);
        float ao = 1.0;
      `,
      fragmentPars: /* glsl */`
        uniform sampler2D uNormalAtlas;
        varying vec2 vAtlasUv; varying vec3 vR; varying vec3 vF; varying float vFade;
      ` + ALPHA_SHARPEN,
      fragmentColor: /* glsl */`
        if (vFade <= ign(gl_FragCoord.xy)) discard;
        float bakedAO = diffuseColor.a;
        vec4 nt = texture2D(uNormalAtlas, vAtlasUv);
        diffuseColor.a = nt.a;
        ${q.msaa > 0 ? 'diffuseColor.a = sharpenAlpha(diffuseColor.a, vAtlasUv, ' + (S * 4).toFixed(1) + ', 0.5);' : ''}
        diffuseColor.rgb *= 1.0 - uWetness * 0.2;
        gImpAO = bakedAO;
      `,
      fragmentNormal: /* glsl */`
        vec3 nb = texture2D(uNormalAtlas, vAtlasUv).xyz * 2.0 - 1.0;
        vec3 wn = normalize(vR * nb.x + vec3(0.0, 1.0, 0.0) * nb.y + vF * nb.z);
        vec3 normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
      `,
      fragmentAlpha: q.msaa > 0 ? 'if (diffuseColor.a < 0.02) discard;' : undefined,
      ao: 'gImpAO',
      onShader: (s) => { s.fragmentShader = s.fragmentShader.replace('varying float vFade;', 'varying float vFade;\nfloat gImpAO = 1.0;'); },
    });
    const mesh = new THREE.Mesh(quad, mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = false;
    mesh.layers.set(3);
    this.impostors = mesh;
    this.impostorTargets = [rtA, rtN];
    this.group.add(mesh);
  }

  update(camera) {
    this.chunked.update(camera);
  }
}
