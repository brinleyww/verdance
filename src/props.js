// Undergrowth and ground props: shrubs, ferns, rocks, fallen logs.
import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { patch } from './shaderlib.js';
import { genTree, buildLeafGeometry, makeLeafMaterial, makeBarkMaterial } from './trees.js';
import { ChunkedInstances, composeMatrices, makeInstanced, cascadePrefix } from './instancing.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROCK_GLSL } from './cliffs.js';

const SHRUBS = [
  { name: 'hazel', H: [1.4, 2.2], trunkFrac: 0.02, trunkR: 0.035, leader: 0.55, children: [7, 3], angle: [48, 40], lenRatio: [0.85, 0.6], radRatio: [0.7, 0.6],
    wobble: [0.25, 0.25, 0.3], grav: [0.06, 0.02, -0.02], env: 'round', cell: 1, leafSize: 0.7, leafDensity: 15, bark: 'small', tint: [0.92, 1.05, 0.82] },
  { name: 'bramble', H: [0.8, 1.3], trunkFrac: 0.02, trunkR: 0.025, leader: 0.4, children: [8, 3], angle: [70, 45], lenRatio: [1.1, 0.55], radRatio: [0.7, 0.6],
    wobble: [0.3, 0.3, 0.3], grav: [-0.05, -0.05, -0.05], env: 'round', cell: 0, leafSize: 0.6, leafDensity: 17, bark: 'small', tint: [0.72, 0.85, 0.62] },
  { name: 'sapling', H: [1.6, 2.6], trunkFrac: 0.3, trunkR: 0.03, leader: 1.0, children: [6, 3], angle: [40, 40], lenRatio: [0.45, 0.6], radRatio: [0.6, 0.6],
    wobble: [0.1, 0.2, 0.25], grav: [0.0, -0.02, -0.06], env: 'cone', cell: 2, leafSize: 0.65, leafDensity: 16, bark: 'birch', tint: [1, 1, 1] },
];

function fernGeometry(seed) {
  const rnd = mulberry32(seed);
  const pos = [], nor = [], uv = [], leaf = [], idx = [];
  const fronds = 8 + Math.floor(rnd() * 3);
  let v = 0;
  const segs = 5;
  for (let f = 0; f < fronds; f++) {
    const az = f / fronds * Math.PI * 2 + rnd() * 0.4;
    const len = 0.7 + rnd() * 0.45;
    const lift = 0.9 + rnd() * 0.5;
    const wid = 0.32 + rnd() * 0.1;
    const dir = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const out = len * t;
      const y = Math.sin(t * Math.PI * 0.8) * lift * len * 0.55 - t * t * 0.15;
      const c = dir.clone().multiplyScalar(out).add(new THREE.Vector3(0, y + 0.02, 0));
      const tw = (rnd() - 0.5) * 0.3;
      const n = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -Math.cos(t * Math.PI * 0.8) * 0.6).normalize();
      for (const sx of [-1, 1]) {
        const p = c.clone().addScaledVector(side, sx * wid * 0.5).add(new THREE.Vector3(0, sx * tw * t, 0));
        pos.push(p.x, p.y, p.z);
        nor.push(n.x, n.y, n.z);
        uv.push(0.5 + (sx < 0 ? 0.02 : 0.98) * 0.5, 0.5 + (1 - (0.02 + t * 0.96)) * 0.5);
        leaf.push(t, f * 1.7, 0.45 + t * 0.55, t);
      }
    }
    for (let s = 0; s < segs; s++) {
      const a = v + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    v += (segs + 1) * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(leaf, 4));
  g.setIndex(idx);
  return g;
}

// 3D value noise for rock displacement
function noise3(seed) {
  const rnd = mulberry32(seed);
  const P = 64, tab = new Float32Array(P * P * P);
  for (let i = 0; i < tab.length; i++) tab[i] = rnd() * 2 - 1;
  const at = (x, y, z) => tab[((x & 63) * P + (y & 63)) * P + (z & 63)];
  const n = (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let fx = x - ix, fy = y - iy, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const l = (a, b, t) => a + (b - a) * t;
    return l(l(l(at(ix, iy, iz), at(ix + 1, iy, iz), fx), l(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), fx), fy),
      l(l(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), fx), l(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), fx), fy), fz);
  };
  return (x, y, z, oct = 4) => { let s = 0, a = 1, f = 1, t = 0; for (let o = 0; o < oct; o++) { s += a * n(x * f + o * 7, y * f, z * f); t += a; a *= 0.5; f *= 2.1; } return s / t; };
}

function rockGeometry(seed, detail) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const n3 = noise3(seed);
  const p = g.attributes.position;
  const ao = new Float32Array(p.count);
  const rnd = mulberry32(seed);
  const sx = 0.9 + rnd() * 0.5, sz = 0.8 + rnd() * 0.5;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const big = n3(v.x * 1.3, v.y * 1.3, v.z * 1.3, 3);
    const strata = Math.sin((v.y * 6 + n3(v.x * 2, v.y * 2, v.z * 2, 2) * 2) * Math.PI) * 0.035;
    const fine = n3(v.x * 5, v.y * 5, v.z * 5, 3) * 0.06;
    // facets: quantise along a few planes to get chunky limestone breaks
    let r = 1 + big * 0.38 + strata + fine;
    r = Math.min(r, 1.24 - Math.abs(v.x * 0.35 + v.z * 0.2) * 0.12);
    const y = v.y * r;
    v.multiplyScalar(r);
    v.x *= sx; v.z *= sz;
    if (y < -0.35) v.y = -0.35 + (y + 0.35) * 0.25;
    v.y *= 0.82;
    p.setXYZ(i, v.x, v.y, v.z);
    ao[i] = Math.min(1, Math.max(0.35, 0.65 + (big + fine) * 1.4));
  }
  g.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

// Angular limestone block: a boxy superellipsoid with chipped corners, a flat bedding-plane top and a
// groove or two along the beds. LOD0 and LOD1 share the same shape function, so the switch does not pop.
function blockGeometry(seed, segs) {
  const rnd = mulberry32(seed * 7 + 3);
  let g = new THREE.BoxGeometry(2, 2, 2, segs, segs, segs);
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  g = mergeVertices(g);
  const n3 = noise3(seed + 900);
  const P = 4.5 + rnd() * 2.5;
  const chips = [];
  // chips take off vertical corners (not the top edges), so blocks keep flat bedding-plane tops
  const nc = 2 + Math.floor(rnd() * 2);
  for (let i = 0; i < nc; i++) {
    const d = new THREE.Vector3(rnd() * 2 - 1, (rnd() * 2 - 1) * 0.2, rnd() * 2 - 1).normalize();
    chips.push({ d, o: 0.85 + rnd() * 0.2 });
  }
  const topCut = 0.45 + rnd() * 0.3;
  const lay0 = rnd();
  const p = g.attributes.position;
  const ao = new Float32Array(p.count);
  const v = new THREE.Vector3(), dir = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    dir.fromBufferAttribute(p, i).normalize();
    const r = Math.pow(Math.abs(dir.x) ** P + Math.abs(dir.y) ** P + Math.abs(dir.z) ** P, -1 / P);
    v.copy(dir).multiplyScalar(r);
    const warp = n3(dir.x * 0.9, dir.y * 0.9, dir.z * 0.9, 2);
    v.x *= 1 + warp * 0.14; v.z *= 1 - warp * 0.1;
    for (const c of chips) { const t = v.dot(c.d) - c.o; if (t > 0) v.addScaledVector(c.d, -t); }
    if (v.y > topCut) v.y = topCut + (v.y - topCut) * 0.06;
    if (v.y < -0.7) v.y = -0.7;
    const f = (v.y * 1.4 + lay0) % 1, gr = 1 - Math.min(1, Math.min(Math.abs(f), 1 - Math.abs(f)) / 0.1);
    v.x *= 1 - 0.06 * gr; v.z *= 1 - 0.06 * gr;
    v.addScaledVector(dir, n3(dir.x * 4, dir.y * 4, dir.z * 4, 3) * 0.035);
    p.setXYZ(i, v.x, v.y, v.z);
    ao[i] = Math.min(1, Math.max(0.4, 0.62 + (v.y + 0.8) * 0.18 - gr * 0.25 + warp * 0.5));
  }
  g.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
  g.computeVertexNormals();
  // vertices squashed onto a chip plane can end up with a zero normal
  const nr = g.attributes.normal;
  for (let i = 0; i < nr.count; i++) {
    if (!(Math.hypot(nr.getX(i), nr.getY(i), nr.getZ(i)) > 0.5)) { dir.fromBufferAttribute(p, i).normalize(); nr.setXYZ(i, dir.x, dir.y, dir.z); }
  }
  return g;
}

function makeRockMaterial(tex) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  patch(mat, {
    key: 'rock',
    wet: true,
    uniforms: { uGround: { value: tex.ground } },
    vertexPars: 'attribute float aAO;',
    vertexMain: 'vec3 pos = position; vec3 nrm = normal; float ao = aAO;',
    fragmentPars: 'precision highp sampler2DArray; uniform sampler2DArray uGround;' + ROCK_GLSL,
    fragmentColor: /* glsl */`
      {
        vec3 wn = normalize((vec4(normalize(vNormal), 0.0) * viewMatrix).xyz);
        float hgt;
        vec3 col = limestone(vWPos, wn, hgt);
        vec4 m = groundMask(vWPos.xz);
        float moss = smoothstep(0.45, 0.85, wn.y + texture(uNoiseTex, vWPos.xz * 0.15).r * 0.35 - 0.15) * (0.25 + m.r * 0.75);
        col = mix(col, vec3(0.09, 0.13, 0.035) * (0.8 + hgt * 0.4), moss * 0.85);
        float dirtBase = smoothstep(0.6, 0.0, vWPos.y - terrainHeight(vWPos.xz));
        col = mix(col, col * vec3(0.55, 0.5, 0.42), dirtBase * 0.7);
        gWet = uWetness * (1.0 - moss * 0.5);
        col *= 1.0 - gWet * 0.35;
        diffuseColor.rgb = col;
      }
    `,
  });
  return mat;
}

export class Props {
  constructor(world, q, tex) {
    this.group = new THREE.Group();
    this.updaters = [];
    const band = q.lodBand * 0.5;

    // ----- shrubs -----
    {
      const S = world.shrubs, n = S.length / 6;
      const fade = [[-2, -1], [q.shrubDist - band, q.shrubDist + band]];
      const meshes = SHRUBS.map((sp, i) => {
        const t = genTree(sp, 300 + i * 11, { leafScale: q.leafScale });
        const geo = buildLeafGeometry(t);
        const m = makeLeafMaterial(tex, q, sp, fade), d = makeLeafMaterial(tex, q, sp, fade, true);
        m.userData.u.uTreeH.value = d.userData.u.uTreeH.value = t.H;
        m.userData.u.uSway.value = d.userData.u.uSway.value = 0.12;
        const mesh = makeInstanced(geo, m, q.shrubCap);
        mesh.customDepthMaterial = d;
        mesh.castShadow = q.shadows > 0 && q.shrubShadows;
        cascadePrefix(mesh);
        mesh.receiveShadow = true;
        this.group.add(mesh);
        return [[mesh]];
      });
      const pos = new Float32Array(n * 4), variant = new Uint16Array(n);
      const matrices = composeMatrices(n, (i) => ({ x: S[i * 6], y: S[i * 6 + 1], z: S[i * 6 + 2], ry: S[i * 6 + 3], sx: S[i * 6 + 4] }));
      for (let i = 0; i < n; i++) { pos.set([S[i * 6], S[i * 6 + 1], S[i * 6 + 2], 1e9], i * 4); variant[i] = S[i * 6 + 5]; }
      const ci = new ChunkedInstances({ matrices, pos, variant }, [q.shrubDist], band, meshes);
      ci.sortRadii = [q.cascadeSplits[0] + 10, (q.cascadeSplits[1] || 60) + 15];
      this.updaters.push(ci);
    }

    // ----- ferns -----
    {
      const F = world.ferns, n = F.length / 5;
      const fade = [[-2, -1], [q.fernDist - band, q.fernDist + band]];
      const sp = { tint: [1, 1, 1], cell: 3 };
      const meshes = [0, 1].map((k) => {
        const geo = fernGeometry(500 + k);
        const m = makeLeafMaterial(tex, q, sp, fade);
        m.userData.u.uTreeH.value = 1; m.userData.u.uSway.value = 0.06;
        const mesh = makeInstanced(geo, m, q.fernCap);
        mesh.receiveShadow = true;
        this.group.add(mesh);
        return [[mesh]];
      });
      const pos = new Float32Array(n * 4), variant = new Uint16Array(n);
      const matrices = composeMatrices(n, (i) => ({ x: F[i * 5], y: F[i * 5 + 1], z: F[i * 5 + 2], ry: F[i * 5 + 3], sx: F[i * 5 + 4] }));
      for (let i = 0; i < n; i++) { pos.set([F[i * 5], F[i * 5 + 1], F[i * 5 + 2], 1e9], i * 4); variant[i] = i & 1; }
      this.updaters.push(new ChunkedInstances({ matrices, pos, variant }, [q.fernDist], band, meshes));
    }

    // ----- rocks: 0-3 rounded stones, 4-7 angular limestone blocks; one LOD at a time, no dithered crossfade -----
    {
      const R = world.rocks, n = R.length / 8;
      const l0 = q.rockLod0, lmax = 2600;
      const m0 = makeRockMaterial(tex), m1 = m0;
      const meshes = [];
      const segs0 = [4, 4, 4, 6, 8][Math.min(q.rockDetail, 4)];
      for (let v = 0; v < 8; v++) {
        const g0 = v < 4 ? rockGeometry(40 + v * 13, q.rockDetail) : blockGeometry(v, segs0);
        const g1 = v < 4 ? rockGeometry(40 + v * 13, 2) : blockGeometry(v, 3);
        const a = makeInstanced(g0, m0, q.rockCap0), b = makeInstanced(g1, m1, q.rockCap1);
        a.castShadow = b.castShadow = q.shadows > 0;
        a.receiveShadow = b.receiveShadow = true;
        this.group.add(a, b);
        meshes.push([[a], [b]]);
      }
      const pos = new Float32Array(n * 4), variant = new Uint16Array(n);
      const matrices = composeMatrices(n, (i) => ({ x: R[i * 8], y: R[i * 8 + 1], z: R[i * 8 + 2], ry: R[i * 8 + 3], sx: R[i * 8 + 4], sy: R[i * 8 + 5], sz: R[i * 8 + 6], rx: (R[i * 8 + 3] % 0.3) - 0.15 }));
      for (let i = 0; i < n; i++) {
        const s = Math.max(R[i * 8 + 4], R[i * 8 + 5], R[i * 8 + 6]);
        pos.set([R[i * 8], R[i * 8 + 1], R[i * 8 + 2], s > 4 ? 2600 : s > 1.4 ? 700 : s > 0.6 ? 220 : 110], i * 4);
        variant[i] = R[i * 8 + 7];
        if (s > 0.55) world.addCollider(R[i * 8], R[i * 8 + 2], Math.max(R[i * 8 + 4], R[i * 8 + 6]) * 0.85, R[i * 8 + 1] + R[i * 8 + 5] * 0.6);
      }
      this.updaters.push(new ChunkedInstances({ matrices, pos, variant }, [l0, lmax], band, meshes, 2048, { exclusive: true, endBand: 0 }));
    }

    // ----- logs -----
    {
      const L = world.logs, n = L.length / 6;
      const geo = new THREE.CylinderGeometry(1, 1, 1, 10, 4, false);
      geo.rotateZ(Math.PI / 2);
      geo.translate(0, 0, 0);
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 3, uv.getY(i) * 4);
      const wind = new Float32Array(geo.attributes.position.count * 2);
      geo.setAttribute('aWind', new THREE.BufferAttribute(wind, 2));
      const fade = [[-2, -1], [q.logDist - band, q.logDist + band]];
      const m = makeBarkMaterial(tex.bark.oak, q, fade, false);
      m.userData.u.uSway.value = 0;
      const mesh = makeInstanced(geo, m, 600);
      mesh.castShadow = q.shadows > 0; mesh.receiveShadow = true;
      this.group.add(mesh);
      const matrices = composeMatrices(n, (i) => {
        const x = L[i * 6], z = L[i * 6 + 2], ry = L[i * 6 + 3], len = L[i * 6 + 4], r = L[i * 6 + 5];
        const dx = Math.cos(ry) * len * 0.5, dz = -Math.sin(ry) * len * 0.5;
        const h1 = world.heightAt(x - dx, z - dz), h2 = world.heightAt(x + dx, z + dz);
        const pitch = Math.atan2(h2 - h1, len);
        return { x, y: (h1 + h2) / 2 + r * 0.6, z, ry, rz: pitch, sx: len, sy: r, sz: r };
      });
      const pos = new Float32Array(n * 4), variant = new Uint16Array(n);
      for (let i = 0; i < n; i++) {
        pos.set([L[i * 6], L[i * 6 + 1], L[i * 6 + 2], 1e9], i * 4);
        const x = L[i * 6], z = L[i * 6 + 2], ry = L[i * 6 + 3], len = L[i * 6 + 4], r = L[i * 6 + 5];
        for (let k = -1; k <= 1; k++) world.addCollider(x + Math.cos(ry) * len * 0.4 * k, z - Math.sin(ry) * len * 0.4 * k, r + 0.25, world.heightAt(x, z) + r * 1.4);
      }
      this.updaters.push(new ChunkedInstances({ matrices, pos, variant }, [q.logDist], band, [[[mesh]]]));
    }
  }

  update(camera) {
    for (const u of this.updaters) u.update(camera);
  }
}
