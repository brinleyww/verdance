// Main-thread view of the generated world: textures for the GPU, height/mask queries and collisions.
import * as THREE from 'three';
import { WORLD, sampleArr, chasmCentre, CLIFF } from './worldgen.js';
import { G } from './shaderlib.js';

const CELL = 8;

export class World {
  constructor(d) {
    Object.assign(this, d);
    this.size = WORLD.size; this.res = WORLD.res; this.maskRes = WORLD.maskRes;
    this.farRes = WORLD.farRes; this.farSize = WORLD.farSize;

    const ht = new THREE.DataTexture(d.heights, this.res, this.res, THREE.RedFormat, THREE.FloatType);
    ht.minFilter = ht.magFilter = THREE.NearestFilter;
    ht.generateMipmaps = false;
    ht.needsUpdate = true;
    const nt = new THREE.DataTexture(d.normals, this.res, this.res, THREE.RGBAFormat, THREE.UnsignedByteType);
    nt.minFilter = THREE.LinearMipmapLinearFilter; nt.magFilter = THREE.LinearFilter; nt.generateMipmaps = true;
    nt.needsUpdate = true;
    const mt = new THREE.DataTexture(d.mask, this.maskRes, this.maskRes, THREE.RGBAFormat, THREE.UnsignedByteType);
    mt.minFilter = THREE.LinearMipmapLinearFilter; mt.magFilter = THREE.LinearFilter; mt.generateMipmaps = true;
    mt.needsUpdate = true;
    this.heightTex = ht; this.normalTex = nt; this.maskTex = mt;
    // cliff edge table: x = metres from CLIFF.x0, y = wall (0 south, 1 north); rgba = edge z, rim at edge, rim 4 m back, floor
    const ct = new THREE.DataTexture(d.cliff, CLIFF.n, 2, THREE.RGBAFormat, THREE.FloatType);
    ct.minFilter = ct.magFilter = THREE.NearestFilter;
    ct.generateMipmaps = false;
    ct.needsUpdate = true;
    this.cliffTex = ct;
    G.uHeightTex.value = ht; G.uNormalTex.value = nt; G.uMaskTex.value = mt;
    G.uWorld.value.set(this.size, this.res, this.maskRes, 0);

    // collision grid
    this.grid = new Map();
    const T = d.trees;
    for (let i = 0; i < T.length; i += 8) this.addCollider(T[i], T[i + 2], T[i + 7] + 0.15, T[i + 1] + 30);
  }

  heightAt(x, z) {
    const h = this.size / 2;
    if (Math.abs(x) < h - 1 && Math.abs(z) < h - 1) return sampleArr(this.heights, this.res, this.size, x, z);
    return sampleArr(this.far, this.farRes, this.farSize, x, z);
  }

  normalAt(x, z, out) {
    const e = 0.75;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  maskAt(x, z, ch) {
    const M = this.maskRes, cell = this.size / M;
    const i = Math.floor((x + this.size / 2) / cell), j = Math.floor((z + this.size / 2) / cell);
    if (i < 0 || j < 0 || i >= M || j >= M) return 0;
    return this.mask[(j * M + i) * 4 + ch] / 255;
  }
  grassAt(x, z) { return this.maskAt(x, z, 1); }
  forestAt(x, z) { return this.maskAt(x, z, 0); }
  pathAt(x, z) { return this.maskAt(x, z, 2); }
  wetAt(x, z) { return this.maskAt(x, z, 3); }
  grassMax(ox, oz, s) {
    return Math.max(this.grassAt(ox, oz), this.grassAt(ox + s, oz), this.grassAt(ox, oz + s), this.grassAt(ox + s, oz + s));
  }

  // cliff table row for wall `wall` (0 south, 1 north) at x, linearly interpolated: [edgeZ, rimEdge, rimBack, floor]
  cliffRow(x, wall, out = [0, 0, 0, 0]) {
    const f = Math.min(Math.max(x - CLIFF.x0, 0), CLIFF.n - 1.001);
    const i = Math.floor(f), t = f - i, c = this.cliff;
    const a = (wall * CLIFF.n + i) * 4, b = a + 4;
    for (let k = 0; k < 4; k++) out[k] = c[a + k] * (1 - t) + c[b + k] * t;
    return out;
  }
  // signed distance from the real rim edge (negative = over the drop)
  chasmEdgeDist(x, z) {
    const wall = z >= chasmCentre(x) ? 0 : 1;
    const ze = this.cliffRow(x, wall, _row)[0];
    return wall === 0 ? z - ze : ze - z;
  }
  // margin is relative to a line 3.6 m back from the edge: the player passes -3 and stops 0.6 m short of the drop
  inChasm(x, z, margin = 0) {
    return this.chasmEdgeDist(x, z) < margin + 3.6;
  }

  surfaceAt(x, z, y) {
    if (this.creekWaterAt(x, z) > y - 0.05) return 'water';
    if (this.pathAt(x, z) > 0.5) return 'dirt';
    const n = this.normalAt(x, z, _v);
    if (n.y < 0.7) return 'rock';
    if (this.grassAt(x, z) > 0.35) return 'grass';
    return 'leaves';
  }

  addCollider(x, z, r, top = 1e9) {
    const i0 = Math.floor((x - r) / CELL), i1 = Math.floor((x + r) / CELL);
    const j0 = Math.floor((z - r) / CELL), j1 = Math.floor((z + r) / CELL);
    const c = { x, z, r, top };
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = i * 73856093 ^ j * 19349663;
      let list = this.grid.get(k);
      if (!list) this.grid.set(k, (list = []));
      list.push(c);
    }
  }

  // push a circle (player) out of colliders; returns adjusted x,z
  collide(x, z, r, feetY, out) {
    const i = Math.floor(x / CELL), j = Math.floor(z / CELL);
    for (let jj = j - 1; jj <= j + 1; jj++) for (let ii = i - 1; ii <= i + 1; ii++) {
      const list = this.grid.get(ii * 73856093 ^ jj * 19349663);
      if (!list) continue;
      for (const c of list) {
        if (feetY > c.top) continue;
        const dx = x - c.x, dz = z - c.z;
        const d2 = dx * dx + dz * dz, rr = c.r + r;
        if (d2 < rr * rr && d2 > 1e-8) {
          const d = Math.sqrt(d2);
          x = c.x + dx / d * rr; z = c.z + dz / d * rr;
        }
      }
    }
    out.x = x; out.z = z;
    return out;
  }

  // nearest creek point (coarse search then refine)
  creekNearest(x, z) {
    const c = this.creek;
    let best = 1e18, bi = 0;
    for (let i = 0; i < c.length; i += 8) {
      const d = (c[i].x - x) ** 2 + (c[i].z - z) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    for (let i = Math.max(0, bi - 8); i < Math.min(c.length, bi + 8); i++) {
      const d = (c[i].x - x) ** 2 + (c[i].z - z) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    return { i: bi, d: Math.sqrt(best), p: c[bi] };
  }
  creekWaterAt(x, z) {
    const n = this.creekNearest(x, z);
    if (n.d > n.p.width + 0.3) return -1e9;
    return n.p.water;
  }
}
const _v = new THREE.Vector3();
const _row = [0, 0, 0, 0];
