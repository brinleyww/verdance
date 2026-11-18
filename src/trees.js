// Procedural broadleaf trees: recursive skeleton down to twigs -> bark tubes + small leafy sprays attached to the twigs,
// a full-detail LOD that morphs into a lighter LOD (no dithering), and a baked impostor for the far distance.
import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { patch, ALPHA_SHARPEN } from './shaderlib.js';
import { ChunkedInstances, composeMatrices, makeInstanced, cascadePrefix, FADE_GLSL_VS, FADE_GLSL_FS, FADE_VS, FADE_FS, fadeUniforms } from './instancing.js';

// spray: card size in metres; sprayDensity: sprays per metre of leafy branch; t0: where sprays start on
// [inner, terminal] branches (0 = the base of the branch)
export const SPECIES = [
  { name: 'oak', H: [13, 17], trunkFrac: 0.3, trunkR: 0.42, leader: 0.78, children: [8, 5, 5], angle: [64, 50, 46], lenRatio: [0.55, 0.6, 0.52],
    radRatio: [0.52, 0.6, 0.62], wobble: [0.07, 0.2, 0.3], grav: [0.0, 0.05, -0.03], env: 'round', cells: [0, 1], spray: 0.95, sprayDensity: 8.5, t0: [0.45, 0.06], bark: 'oak', tint: [1, 1, 1] },
  { name: 'beech', H: [19, 24], trunkFrac: 0.42, trunkR: 0.36, leader: 1.0, children: [8, 5, 5], angle: [50, 46, 42], lenRatio: [0.42, 0.6, 0.52],
    radRatio: [0.48, 0.6, 0.62], wobble: [0.03, 0.12, 0.24], grav: [0.03, 0.02, -0.05], env: 'ellipse', cells: [2, 3], spray: 0.9, sprayDensity: 8.5, t0: [0.45, 0.06], bark: 'beech', tint: [1, 1, 1] },
  { name: 'birch', H: [14, 18], trunkFrac: 0.28, trunkR: 0.19, leader: 1.0, children: [11, 4, 5], angle: [40, 38, 48], lenRatio: [0.36, 0.6, 0.6],
    radRatio: [0.42, 0.55, 0.6], wobble: [0.05, 0.14, 0.24], grav: [0.0, -0.07, -0.18], env: 'cone', cells: [4, 5], spray: 0.74, sprayDensity: 10, t0: [0.4, 0.05], bark: 'birch', tint: [1, 1, 1] },
  { name: 'small', H: [6, 9], trunkFrac: 0.16, trunkR: 0.13, leader: 0.85, children: [6, 5, 5], angle: [52, 48, 42], lenRatio: [0.58, 0.6, 0.55],
    radRatio: [0.55, 0.6, 0.62], wobble: [0.1, 0.22, 0.3], grav: [0.02, 0.02, -0.04], env: 'round', cells: [7, 2], spray: 0.72, sprayDensity: 9, t0: [0.35, 0.05], bark: 'small', tint: [0.88, 1.04, 0.82] },
];

// LOD1 keeps every LOD1_EVERY-th spray, grown by LOD1_SCALE so the crown keeps its coverage.
export const LOD1_EVERY = 4, LOD1_SCALE = 1.85;
const FOLD = 0.42;

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
    const tStart = level === 0 ? sp.trunkFrac : 0.2 + rnd() * 0.1;
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

  // leafy sprays: each one starts exactly on a twig or branch and points outwards and up, with its leaves facing the sky
  const sprays = [];
  const dens = sp.sprayDensity * (opts.leafScale || 1);
  const t0s = sp.t0 || [0.45, 0.06];
  for (const b of branches) {
    if (b.level < maxLevel - 1) continue;
    const terminal = b.level === maxLevel;
    const t0 = terminal ? t0s[1] : t0s[0];
    const count = Math.max(terminal ? 2 : 0, Math.round(b.length * (1 - t0) * dens * (terminal ? 1 : 0.55)));
    for (let k = 0; k < count; k++) {
      const t = k === count - 1 && terminal ? 1 : t0 + (1 - t0) * ((k + rnd()) / count);
      const fi = t * (b.pts.length - 1), i0 = Math.min(b.pts.length - 2, Math.floor(fi)), f = fi - i0;
      const anchor = b.pts[i0].clone().lerp(b.pts[i0 + 1], f);
      const bd = b.dirs[i0].clone().lerp(b.dirs[i0 + 1], f).normalize();
      const out = anchor.clone().sub(new THREE.Vector3(c.x, Math.min(anchor.y, c.y), c.z));
      out.y *= 0.5;
      if (out.lengthSq() < 1e-4) out.copy(bd); else out.normalize();
      const axis = (t === 1 ? bd.clone() : rotateOff(bd, rnd() * Math.PI * 2, (28 + rnd() * 34) * Math.PI / 180))
        .addScaledVector(out, 0.45).addScaledVector(UP, 0.3).normalize();
      if (sp.grav[2] < -0.1) axis.y -= 0.35 * rnd(); // weeping birch sprays hang
      axis.normalize();
      const nrm = UP.clone().multiplyScalar(0.6).addScaledVector(out, 0.5).add(rv().multiplyScalar(0.75));
      nrm.addScaledVector(axis, -nrm.dot(axis));
      if (nrm.lengthSq() < 1e-3) nrm.crossVectors(axis, out).normalize(); else nrm.normalize();
      const size = sp.spray * (0.8 + rnd() * 0.4) * (terminal ? 1 : 0.92);
      sprays.push({ anchor, up: axis, nrm, size, phase: rnd() * 6.28, cell: sp.cells[rnd() < 0.5 ? 0 : 1], flip: rnd() < 0.5 });
    }
  }
  return { branches, sprays, H, crownC: c, crownR: cr, maxLevel, sp };
}

// opt.maxLevel: deepest branch level drawn; opt.shrinkFrom: levels at or above this get an aShr radius so the
// LOD0 material can thin them away while it morphs into LOD1
export function buildTrunkGeometry(tree, opt = {}) {
  const maxLevel = opt.maxLevel ?? 99;
  const radial = opt.radial || [11, 6, 4, 3];
  const step = opt.step || 1;
  const shrinkFrom = opt.shrinkFrom ?? 99;
  const pos = [], nor = [], uv = [], wind = [], shr = [], idx = [];
  let base = 0;
  for (const b of tree.branches) {
    if (b.level > maxLevel) continue;
    const R = radial[Math.min(b.level, radial.length - 1)];
    const st = b.level >= 3 ? Math.max(step, 2) : step;
    const pts = b.pts.filter((_, i) => i % st === 0 || i === b.pts.length - 1);
    const radii = b.radii.filter((_, i) => i % st === 0 || i === b.radii.length - 1);
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
        // twigs taper to a point so they meet the spray stems
        if (b.level >= 3) r *= 1 - tAlong * 0.6;
        const dx = N[i].x * cs + B[i].x * sn, dy = N[i].y * cs + B[i].y * sn, dz = N[i].z * cs + B[i].z * sn;
        pos.push(pts[i].x + dx * r, pts[i].y + dy * r, pts[i].z + dz * r);
        nor.push(dx, dy, dz);
        uv.push(j / R * uRep, acc / 1.15);
        const sw = b.level === 0 ? 0 : Math.min(1, 0.25 * b.level + tAlong * 0.35 * b.level);
        wind.push(sw, b.phase);
        shr.push(b.level >= shrinkFrom ? r : 0);
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
  g.setAttribute('aShr', new THREE.Float32BufferAttribute(shr, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// Spray cards. LOD0 (opt.every 1): 3x2 vertices so the shader can fold each card along its stem into a shallow V;
// every LOD1_EVERY-th card is flagged as the one that survives into LOD1. LOD1 (opt.every > 1): flat quads of the
// flagged cards at their grown size, identical to where the LOD0 morph ends.
export function buildLeafGeometry(tree, opt = {}) {
  const every = opt.every || 1, scale = opt.scale || 1;
  const subset = opt.subset ?? LOD1_EVERY; // 0: no card survives (shrubs, ferns shrink away completely)
  const lod1 = every > 1;
  const pos = [], nor = [], uv = [], leaf = [], ctr = [], tan = [], idx = [];
  const c = tree.crownC, cr = Math.max(tree.crownR, 0.5);
  let v = 0;
  const right = new THREE.Vector3(), p = new THREE.Vector3();
  tree.sprays.forEach((L, i) => {
    if (i % every) return;
    const s = L.size * scale;
    right.crossVectors(L.up, L.nrm).normalize();
    const d = L.anchor.distanceTo(c) / cr;
    const hf = Math.min(1, Math.max(0, L.anchor.y / tree.H));
    const ao = Math.min(1, Math.max(0.32, 0.28 + 0.78 * Math.pow(d, 1.25))) * (0.78 + 0.22 * hf);
    const sway = Math.min(1, 0.35 + 0.65 * d);
    const flag = !lod1 && subset > 0 && i % subset === 0 ? 1 : 0;
    const u0 = (L.cell % 4) * 0.25, v0 = Math.floor(L.cell / 4) * 0.5;
    const cols = lod1 ? [-1, 1] : [-1, 0, 1];
    for (const cy of [0, 1]) {
      for (const side of cols) {
        p.copy(L.anchor).addScaledVector(right, side * 0.5 * s).addScaledVector(L.up, (cy - 0.02) * s);
        pos.push(p.x, p.y, p.z);
        nor.push(L.nrm.x, L.nrm.y, L.nrm.z);
        const uu = 0.5 + side * 0.49 * (L.flip ? -1 : 1);
        uv.push(u0 + uu * 0.25, v0 + (1 - (0.005 + cy * 0.99)) * 0.5);
        leaf.push(sway, L.phase, ao, cy);
        ctr.push(L.anchor.x, L.anchor.y, L.anchor.z, flag + 2 * (side + 1) + 6 * (L.flip ? 1 : 0));
        tan.push(right.x, right.y, right.z);
      }
    }
    if (lod1) idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    else idx.push(v, v + 1, v + 3, v + 1, v + 4, v + 3, v + 1, v + 2, v + 4, v + 2, v + 5, v + 4);
    v += cols.length * 2;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(leaf, 4));
  g.setAttribute('aCtr', new THREE.Float32BufferAttribute(ctr, 4));
  g.setAttribute('aTan', new THREE.Float32BufferAttribute(tan, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ---------------- materials ----------------
// uMorph: x..y distance range over which LOD0 turns into LOD1 (y <= x disables), z LOD1 card scale,
// w height offset matching the CPU's LOD distance point.
const TREE_PARS = 'uniform float uTreeH; uniform float uSway; uniform vec4 uMorph;';
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
  float mdist = length(iorg + vec3(0.0, uMorph.w, 0.0) - uCamPos);
  float mm = uMorph.y > uMorph.x ? smoothstep(uMorph.x, uMorph.y, mdist) : 0.0;
`;
const APPLY_OFF = /* glsl */`
  #ifdef USE_INSTANCING
  pos += transpose(mat3(instanceMatrix)) * off / s2;
  #else
  pos += off;
  #endif
`;

const LEAF_VERTEX = /* glsl */`
  ${TREE_WIND}
  float pk = aCtr.w + 0.5;
  float flag = mod(floor(pk), 2.0);
  float side = mod(floor(pk / 2.0), 3.0) - 1.0;
  vFlip = floor(pk / 6.0) > 0.5 ? -1.0 : 1.0;
  float sc = flag > 0.5 ? mix(1.0, uMorph.z, mm) : 1.0 - mm;
  vec3 rel = position - aCtr.xyz;
  float fold = uFold * (1.0 - mm);
  float hw = abs(dot(rel, aTan)) * sc;
  vec3 pos = aCtr.xyz + rel * sc + normal * hw * fold;
  vec3 nrm = normalize(normal - aTan * side * fold);
  float fl = aLeaf.x * (0.35 + uWind);
  float ph = aLeaf.y + ph0;
  off += vec3(sin(uTime * 2.1 + ph), sin(uTime * 1.6 + ph * 1.7) * 0.5, cos(uTime * 1.9 + ph * 0.7)) * fl * 0.05;
  off += nrm * sin(uTime * 7.0 + ph * 3.0) * 0.02 * fl * aLeaf.w;
  float ao = aLeaf.z;
  ${APPLY_OFF}
  vVar = fract(aLeaf.y * 7.13);
  vec3 sph = normalize(aCtr.xyz - uCrown.xyz + vec3(0.0, 0.001, 0.0));
  #ifdef USE_INSTANCING
  vTanV = normalize((viewMatrix * vec4(mat3(instanceMatrix) * aTan, 0.0)).xyz);
  vSphV = normalize((viewMatrix * vec4(mat3(instanceMatrix) * sph, 0.0)).xyz);
  #else
  vTanV = normalize((viewMatrix * vec4(aTan, 0.0)).xyz);
  vSphV = normalize((viewMatrix * vec4(sph, 0.0)).xyz);
  #endif
`;

// fade: [[inStart, inEnd], [outStart, outEnd]] distance pairs (dithered, or alpha-faded with MSAA)
// morph: [start, end, lod1Scale, heightOffset]; fold: V fold of the cards (LOD0 only)
export function makeLeafMaterial(tex, q, sp, fade, isDepth = false, opts = {}) {
  const morph = opts.morph || [0, -1, 1, 0];
  const uniforms = Object.assign({
    uTreeH: { value: 15 }, uSway: { value: 0.6 }, uTint: { value: new THREE.Vector3(...sp.tint) },
    uMorph: { value: new THREE.Vector4(...morph) }, uFold: { value: opts.fold ?? 0 },
    uCrown: { value: new THREE.Vector4(0, 5, 0, 4) },
    uLeafNormal: { value: tex.leafNormals }, uAtlasSize: { value: new THREE.Vector2(tex.leaves.image.width, tex.leaves.image.height) },
  }, fadeUniforms(fade[0], fade[1]));
  const msaa = q.msaa > 0 && !isDepth;
  const mat = isDepth
    ? new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex.leaves, alphaTest: 0.5, side: THREE.DoubleSide })
    : new THREE.MeshLambertMaterial({ map: tex.leaves, alphaTest: 0.5, side: THREE.DoubleSide, alphaToCoverage: msaa });
  patch(mat, {
    key: isDepth ? 'leafD' : 'leaf',
    uniforms,
    foliage: isDepth ? null : { translucency: 0.85, wrap: 0.5 },
    defines: isDepth ? {} : { FOLIAGE_SPEC: '0.1' },
    vertexPars: 'attribute vec4 aLeaf; attribute vec4 aCtr; attribute vec3 aTan; uniform float uFold; uniform vec4 uCrown;' +
      'varying vec3 vTanV; varying vec3 vSphV; varying float vFlip; varying float vVar;' + TREE_PARS + FADE_GLSL_VS,
    vertexMain: LEAF_VERTEX,
    vertexEnd: FADE_VS,
    fragmentPars: 'uniform vec3 uTint; uniform sampler2D uLeafNormal; uniform vec2 uAtlasSize; varying vec3 vTanV; varying vec3 vSphV; varying float vFlip; varying float vVar;' + FADE_GLSL_FS + ALPHA_SHARPEN,
    fragmentColor: isDepth ? FADE_FS : `
      ${msaa ? '' : FADE_FS}
      diffuseColor.rgb *= uTint * (0.88 + 0.24 * vVar) * (1.0 - uWetness * 0.2);
      // leaf undersides are paler
      if (!gl_FrontFacing) diffuseColor.rgb *= vec3(1.1, 1.14, 1.0);
      // cards seen edge-on fade out instead of showing as streaks
      float facing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
      float edgeF = smoothstep(0.04, 0.24, facing);
      ${msaa
        ? 'diffuseColor.a = sharpenAlpha2(diffuseColor.a, vMapUv, uAtlasSize, 0.5) * edgeF * vFadeIn * (1.0 - vFadeOut);'
        : 'diffuseColor.a *= mix(0.35, 1.0, edgeF);'}
    `,
    fragmentAlpha: msaa ? 'if (diffuseColor.a < 0.02) discard;' : undefined,
    fragmentNormal: `
      vec3 N0 = normalize(vNormal);
      vec3 T0 = normalize(vTanV - N0 * dot(N0, vTanV));
      vec3 B0 = cross(N0, T0);
      vec3 ln = texture2D(uLeafNormal, vMapUv).xyz * 2.0 - 1.0;
      ln.x *= vFlip;
      vec3 normal = normalize(T0 * ln.x + B0 * ln.y + N0 * max(ln.z, 0.15)) * faceDirection;
      normal = normalize(normal + vSphV * 0.45);
    `,
  });
  mat.userData.u = uniforms;
  return mat;
}

export function makeBarkMaterial(barkTex, q, fade, birch, isDepth = false, morph = null) {
  const uniforms = Object.assign({ uTreeH: { value: 15 }, uSway: { value: 0.6 }, uMorph: { value: new THREE.Vector4(...(morph || [0, -1, 1, 0])) } }, fadeUniforms(fade[0], fade[1]));
  const mat = isDepth
    ? new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    : new THREE.MeshLambertMaterial({ map: barkTex });
  patch(mat, {
    key: (isDepth ? 'barkD' : 'bark') + (birch ? 'B' : ''),
    uniforms,
    defines: birch ? { BIRCH: '' } : {},
    vertexPars: 'attribute vec2 aWind; attribute float aShr; varying float vH;' + TREE_PARS + FADE_GLSL_VS,
    vertexMain: `
      ${TREE_WIND}
      vec3 nrm = normal;
      vec3 pos = position - normal * aShr * mm;
      float fl = aWind.x * (0.3 + uWind);
      off += vec3(sin(uTime * 1.7 + aWind.y), 0.0, cos(uTime * 1.5 + aWind.y)) * fl * 0.05;
      float ao = clamp(0.55 + position.y * 0.12, 0.55, 1.0);
      ${APPLY_OFF}
      vH = position.y;
    `,
    vertexEnd: FADE_VS,
    fragmentPars: 'varying float vH;' + FADE_GLSL_FS,
    fragmentColor: `
      ${FADE_FS}
      #ifdef BIRCH
      diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.32, 0.3, 0.28), diffuseColor.rgb, smoothstep(0.4, 2.2, vH + texture(uNoiseTex, vMapUv * 0.3).r * 0.8));
      #endif
      diffuseColor.rgb *= mix(vec3(0.75, 0.8, 0.62), vec3(1.0), smoothstep(0.0, 1.6, vH));
      diffuseColor.rgb *= 1.3 * (1.0 - uWetness * 0.4);
    `,
  });
  mat.userData.u = uniforms;
  return mat;
}

// ---------------- impostors ----------------
function bakeMaterial(kind, tex, sp, barkTex, crown) {
  // kind: 'leafA' | 'leafN' | 'barkA' | 'barkN'
  const leaf = kind.startsWith('leaf');
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { uMap: { value: leaf ? tex.leaves : barkTex }, uTint: { value: new THREE.Vector3(...sp.tint) }, uCrown: { value: crown } },
    vertexShader: /* glsl */`
      ${leaf ? 'attribute vec4 aLeaf;' : ''}
      uniform vec4 uCrown;
      varying vec2 vUv; varying vec3 vN; varying float vAO; varying vec3 vS;
      void main() {
        vUv = uv; vN = normal;
        vS = normalize(position - uCrown.xyz + vec3(0.0, 0.001, 0.0));
        vAO = ${leaf ? 'aLeaf.z' : 'clamp(0.55 + position.y * 0.12, 0.55, 1.0)'};
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap; uniform vec3 uTint;
      varying vec2 vUv; varying vec3 vN; varying float vAO; varying vec3 vS;
      void main() {
        vec4 c = texture2D(uMap, vUv);
        ${leaf ? 'if (c.a < 0.5) discard;' : ''}
        vec3 n = normalize(vN);
        if (n.z < 0.0) n = -n;
        ${leaf ? 'n = normalize(n * 0.55 + vS * 0.8);' : ''}
        ${kind.endsWith('A') ? `gl_FragColor = vec4(c.rgb * ${leaf ? 'uTint' : 'vec3(1.0)'}, vAO);` : 'gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);'}
      }`,
  });
}

export class Trees {
  constructor(renderer, world, q, tex) {
    this.q = q;
    this.group = new THREE.Group();
    this.variants = [];
    const d0 = q.treeLod0, d1 = q.treeLod1, band = q.lodBand;
    // LOD0 morphs into exactly the LOD1 shape before the hand-off at d0, so the switch is invisible and nothing dithers.
    // LOD1 fades out at d1 while the impostor fades in.
    const morph0 = [d0 - 2 * band, d0 - 1.6, LOD1_SCALE, 6];
    const f0 = [[-2, -1], [1e8, 1e8 + 1]];
    const f1 = [[-2, -1], [d1 - band, d1 + band]];
    for (let v = 0; v < 8; v++) {
      const sp = SPECIES[v >> 1];
      const t = genTree(sp, 1000 + v * 77, { leafScale: q.leafScale });
      const lod0 = { trunk: buildTrunkGeometry(t, { maxLevel: 3, radial: [9, 5, 4, 3], shrinkFrom: 2 }), leaves: buildLeafGeometry(t) };
      const lod1 = { trunk: buildTrunkGeometry(t, { maxLevel: 1, radial: [6, 4], step: 2 }), leaves: buildLeafGeometry(t, { every: LOD1_EVERY, scale: LOD1_SCALE }) };
      const birch = sp.name === 'birch';
      const crown = new THREE.Vector4(t.crownC.x, t.crownC.y, t.crownC.z, t.crownR);
      const mk = (fade, morph, fold) => {
        const lm = makeLeafMaterial(tex, q, sp, fade, false, { morph, fold }), ld = makeLeafMaterial(tex, q, sp, fade, true, { morph, fold });
        const bm = makeBarkMaterial(tex.bark[sp.bark], q, fade, birch, false, morph), bd = makeBarkMaterial(null, q, fade, birch, true, morph);
        for (const m of [lm, ld, bm, bd]) { m.userData.u.uTreeH.value = t.H; m.userData.u.uSway.value = sp.name === 'small' ? 0.25 : sp.name === 'birch' ? 0.75 : 0.55; }
        for (const m of [lm, ld]) m.userData.u.uCrown.value.copy(crown);
        return { lm, ld, bm, bd };
      };
      this.variants.push({ sp, tree: t, crown, lod0, lod1, m0: mk(f0, morph0, FOLD), m1: mk(f1, null, 0) });
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
    this.chunked = new ChunkedInstances({ matrices, pos, variant }, [d0, d1], band, meshes, 2048, { exclusive: true });
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
        const box = new THREE.Box3().setFromBufferAttribute(V.lod1.leaves.attributes.position);
        box.union(new THREE.Box3().setFromBufferAttribute(V.lod0.leaves.attributes.position));
        box.union(new THREE.Box3().setFromBufferAttribute(V.lod0.trunk.attributes.position));
        const halfW = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)) * 1.02;
        const bottom = -0.5, top = box.max.y * 1.02;
        if (suffix === 'A') sizes.push(new THREE.Vector3(halfW * 2, top - bottom, bottom));
        cam.left = -halfW; cam.right = halfW; cam.top = top; cam.bottom = bottom;
        cam.position.set(0, 0, 100); cam.lookAt(0, 0, 0);
        cam.updateProjectionMatrix();
        const trunk = new THREE.Mesh(V.lod0.trunk, bakeMaterial('bark' + suffix, tex, V.sp, tex.bark[V.sp.bark], V.crown));
        const leaves = new THREE.Mesh(V.lod1.leaves, bakeMaterial('leaf' + suffix, tex, V.sp, null, V.crown));
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
        ${q.msaa > 0 ? '' : 'if (vFade <= ign(gl_FragCoord.xy)) discard;'}
        float bakedAO = diffuseColor.a;
        vec4 nt = texture2D(uNormalAtlas, vAtlasUv);
        diffuseColor.a = nt.a;
        ${q.msaa > 0 ? 'diffuseColor.a = sharpenAlpha2(diffuseColor.a, vAtlasUv, vec2(' + (S * 4).toFixed(1) + ', ' + (S * 2).toFixed(1) + '), 0.5) * vFade;' : ''}
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
