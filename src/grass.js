// GPU grass + wildflowers. Blades live in tile-sized patches; tiles are picked on the CPU (frustum + distance),
// every blade is positioned, shaded and thinned on the GPU. Patches for far tiles are rank-ordered subsets of the
// near patch, so density falls off smoothly without popping.
import * as THREE from 'three';
import { patch, G } from './shaderlib.js';
import { mulberry32 } from './noise.js';

const TILE = 8;

function makeBlades(count, seed) {
  const rnd = mulberry32(seed);
  const blades = [];
  const n = Math.ceil(Math.sqrt(count));
  const cell = TILE / n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (blades.length >= count) break;
    blades.push([(i + rnd()) * cell, (j + rnd()) * cell, rnd(), rnd()]);
  }
  blades.sort((a, b) => a[2] - b[2]);
  return blades;
}

function bladeGeometry(blades, segs) {
  const pos = [], bl = [], idx = [];
  let v = 0;
  for (const b of blades) {
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      if (s === segs) { pos.push(0, t, 0); bl.push(...b); v++; }
      else { pos.push(-1, t, 0, 1, t, 0); bl.push(...b, ...b); v += 2; }
    }
    const base = v - (segs * 2 + 1);
    for (let s = 0; s < segs; s++) {
      const a = base + s * 2;
      if (s === segs - 1) idx.push(a, a + 1, a + 2);
      else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(bl, 4));
  g.setIndex(idx);
  return g;
}

function flowerGeometry(blades) {
  // thin two-segment stem + two crossed head quads
  const pos = [], bl = [], uv = [], kind = [], idx = [];
  let v = 0;
  for (const b of blades) {
    const base = v;
    // stem (part = 0): x side, y t
    pos.push(-1, 0, 0, 1, 0, 0, -1, 0.5, 0, 1, 0.5, 0, 0, 1, 0);
    for (let k = 0; k < 5; k++) { bl.push(...b); uv.push(0, 0); kind.push(0); }
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
    v += 5;
    // head quads (part = 1): x,z in [-1,1], y offset
    for (let q = 0; q < 2; q++) {
      const hb = v;
      const a = q * Math.PI / 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      const tilt = 0.35;
      pos.push(-cx, 1 - tilt, -cz, cx, 1 - tilt, cz, -cx, 1 + tilt, -cz, cx, 1 + tilt, cz);
      uv.push(0, 0, 1, 0, 0, 1, 1, 1);
      for (let k = 0; k < 4; k++) { bl.push(...b); kind.push(1); }
      idx.push(hb, hb + 1, hb + 2, hb + 1, hb + 3, hb + 2);
      v += 4;
    }
    // flat-ish head facing up for a top-down read
    const hb = v;
    pos.push(-1, 1, -1, 1, 1, -1, -1, 1, 1, 1, 1, 1);
    uv.push(0, 0, 1, 0, 0, 1, 1, 1);
    for (let k = 0; k < 4; k++) { bl.push(...b); kind.push(2); }
    idx.push(hb, hb + 2, hb + 1, hb + 1, hb + 2, hb + 3);
    v += 4;
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(bl, 4));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(kind, 1));
  g.setIndex(idx);
  return g;
}

const DENSITY_GLSL = /* glsl */`
uniform float uR0;
uniform float uR1;
uniform float uR;
float densityAt(float d) {
  if (d < uR0) return mix(1.0, 0.3, smoothstep(uR0 * 0.45, uR0, d));
  if (d < uR1) return mix(0.3, 0.1, smoothstep(uR0, uR1, d));
  return mix(0.1, 0.0, smoothstep(uR1, uR, d));
}
`;

export class Grass {
  constructor(world, q, tex) {
    this.world = world;
    this.q = q;
    this.R0 = q.grassR0; this.R1 = q.grassR1; this.R = q.grassRadius;
    const perTile = Math.round(q.grassDensity * TILE * TILE);
    const blades = makeBlades(perTile, 21);
    this.uniforms = {
      uR0: { value: this.R0 }, uR1: { value: this.R1 }, uR: { value: this.R },
    };
    // rank thresholds the far patches must cover
    const frac1 = 0.31, frac2 = 0.11;
    const lods = [
      { blades, segs: q.grassSegs },
      { blades: blades.slice(0, Math.ceil(blades.length * frac1)), segs: 2 },
      { blades: blades.slice(0, Math.ceil(blades.length * frac2)), segs: 1 },
    ];
    this.maxTiles = Math.ceil((2 * this.R / TILE + 2) ** 2);
    this.group = new THREE.Group();
    const mat = makeGrassMaterial(this.uniforms, q);
    this.lods = lods.map((l) => {
      const g = bladeGeometry(l.blades, l.segs);
      const arr = new Float32Array(this.maxTiles * 2);
      const attr = new THREE.InstancedBufferAttribute(arr, 2);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aTile', attr);
      g.instanceCount = 0;
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.renderOrder = -20;
      this.group.add(mesh);
      return { mesh, attr, arr, n: 0 };
    });
    // flowers: fewer, same tiles
    const fl = makeBlades(Math.round(q.flowerDensity * TILE * TILE), 77);
    this.flowerLods = [fl].map((b) => {
      const g = flowerGeometry(b);
      const arr = new Float32Array(this.maxTiles * 2);
      const attr = new THREE.InstancedBufferAttribute(arr, 2);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aTile', attr);
      g.instanceCount = 0;
      const mesh = new THREE.Mesh(g, makeFlowerMaterial(this.uniforms, tex.flowers, q));
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.renderOrder = -19;
      this.group.add(mesh);
      return { mesh, attr, arr, n: 0 };
    });
    this._frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this._last = new THREE.Vector3(1e9, 0, 0);
    this._lastQ = new THREE.Quaternion();
  }

  update(camera) {
    const p = camera.position;
    if (p.distanceToSquared(this._last) < 0.25 && camera.quaternion.angleTo(this._lastQ) < 0.02) return;
    this._last.copy(p); this._lastQ.copy(camera.quaternion);
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m);
    for (const l of this.lods) l.n = 0;
    for (const l of this.flowerLods) l.n = 0;
    const R = this.R;
    const x0 = Math.floor((p.x - R) / TILE), x1 = Math.floor((p.x + R) / TILE);
    const z0 = Math.floor((p.z - R) / TILE), z1 = Math.floor((p.z + R) / TILE);
    const w = this.world;
    const d1 = this.R0, d2 = this.R1;
    for (let tz = z0; tz <= z1; tz++) {
      for (let tx = x0; tx <= x1; tx++) {
        const ox = tx * TILE, oz = tz * TILE;
        // nearest point of tile to camera
        const nx = Math.max(ox, Math.min(p.x, ox + TILE)), nz = Math.max(oz, Math.min(p.z, oz + TILE));
        const dn = Math.hypot(nx - p.x, nz - p.z);
        if (dn > R) continue;
        if (w.grassAt(ox + TILE / 2, oz + TILE / 2) < 0.02 && w.grassMax(ox, oz, TILE) < 0.02) continue;
        const hc = w.heightAt(ox + TILE / 2, oz + TILE / 2);
        this._box.min.set(ox - 1, hc - 6, oz - 1);
        this._box.max.set(ox + TILE + 1, hc + 6, oz + TILE + 1);
        if (dn > 3 && !this._frustum.intersectsBox(this._box)) continue;
        const lod = dn < d1 ? 0 : dn < d2 ? 1 : 2;
        const l = this.lods[lod];
        l.arr[l.n * 2] = ox; l.arr[l.n * 2 + 1] = oz; l.n++;
        if (dn < d2) {
          const f = this.flowerLods[0];
          f.arr[f.n * 2] = ox; f.arr[f.n * 2 + 1] = oz; f.n++;
        }
      }
    }
    for (const l of this.lods.concat(this.flowerLods)) {
      l.mesh.geometry.instanceCount = l.n;
      l.attr.clearUpdateRanges();
      l.attr.addUpdateRange(0, l.n * 2);
      l.attr.needsUpdate = true;
      l.mesh.visible = l.n > 0;
    }
  }
}

function makeGrassMaterial(uniforms, q) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  patch(mat, {
    key: 'grass',
    uniforms,
    foliage: { translucency: 0.55, wrap: 0.55 },
    defines: { FOLIAGE_SPEC: '0.18' },
    vertexPars: /* glsl */`
      attribute vec4 aBlade;
      attribute vec2 aTile;
      varying vec3 vGrassCol;
      ${DENSITY_GLSL}
    `,
    vertexMain: /* glsl */`
      vec2 xz = aTile + aBlade.xy;
      float rnk = aBlade.z, r = aBlade.w;
      float dist = length(xz - cameraPosition.xz);
      vec4 gm = groundMask(xz);
      float amount = gm.g;
      vec4 nz = texture(uNoiseTex, xz * 0.013);
      float D = densityAt(dist) * smoothstep(0.06, 0.45, amount);
      float vis = clamp((D - rnk) / 0.035, 0.0, 1.0);
      float widen = 1.0 + (1.0 - clamp(D, 0.08, 1.0)) * 1.9;
      float meadowH = mix(0.55, 1.15, smoothstep(0.25, 0.75, nz.r)) * mix(0.5, 1.0, amount);
      float hgt = mix(0.32, 0.92, pow(fract(r * 3.17), 1.4)) * meadowH * vis;
      float wid = mix(0.013, 0.03, fract(r * 7.31)) * widen * (0.4 + 0.6 * vis);
      float ang = fract(r * 13.7) * 6.2831853;
      vec2 facing = vec2(cos(ang), sin(ang));
      vec2 perp = vec2(-facing.y, facing.x);
      float t = position.y, side = position.x;
      vec2 lean = vec2(cos(ang * 1.7 + 1.0), sin(ang * 1.7 + 1.0)) * (0.12 + 0.3 * fract(r * 5.1));
      vec2 w = windBend(xz, r * 6.2831853);
      float flutter = sin(uTime * (4.0 + r * 3.0) + r * 40.0) * 0.04 * uWind;
      vec2 bend = (lean + w * 0.95 + facing * flutter);
      float bl = length(bend);
      float t2 = t * t;
      float ground = terrainHeight(xz);
      vec3 pos;
      pos.xz = xz + perp * side * wid * (1.0 - t * 0.92) + bend * hgt * t2;
      pos.y = ground - 0.03 + hgt * t * (1.0 - 0.35 * min(bl, 1.2) * t);
      vec3 up = vec3(0.0, 1.0, 0.0);
      vec3 fN = normalize(vec3(facing.x, 0.0, facing.y));
      vec3 bendDir = normalize(vec3(bend.x, 0.0001, bend.y));
      vec3 nrm = normalize(up * 0.75 + fN * 0.35 + vec3(perp.x, 0.0, perp.y) * side * 0.45 - bendDir * 0.25 * t);
      // colour: lush green to straw, darker at the base
      vec3 green = mix(vec3(0.12, 0.21, 0.045), vec3(0.19, 0.27, 0.06), fract(r * 23.1));
      green = mix(green, vec3(0.11, 0.19, 0.08), smoothstep(0.6, 0.9, fract(r * 41.7)) * 0.6);
      vec3 dry = vec3(0.36, 0.33, 0.15);
      float dryness = smoothstep(0.55, 0.85, nz.g * 0.7 + fract(r * 3.9) * 0.45) * 0.6 + smoothstep(0.7, 1.0, t) * 0.2;
      vec3 c = mix(green, dry, dryness);
      c = mix(c * 0.38, c, smoothstep(0.0, 0.7, t));
      c *= mix(0.85, 1.12, nz.b);
      vGrassCol = c * (1.0 - uWetness * 0.25);
      float ao = mix(0.32, 1.0, smoothstep(0.0, 0.85, t)) * (1.0 - gm.r * 0.4);
    `,
    fragmentPars: 'varying vec3 vGrassCol;',
    fragmentColor: 'diffuseColor.rgb = vGrassCol;',
    fragmentNormal: 'vec3 normal = normalize(vNormal);',
  });
  return mat;
}

function makeFlowerMaterial(uniforms, flowerTex, q) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, map: flowerTex, alphaTest: 0.45, alphaToCoverage: q.msaa > 0 });
  patch(mat, {
    key: 'flower',
    uniforms,
    foliage: { translucency: 0.35, wrap: 0.6 },
    vertexPars: /* glsl */`
      attribute vec4 aBlade;
      attribute vec2 aTile;
      attribute float aPart;
      varying vec3 vFlowCol;
      varying float vPart;
      varying vec2 vUv;
      ${DENSITY_GLSL}
    `,
    vertexMain: /* glsl */`
      vec2 xz = aTile + aBlade.xy;
      float rnk = aBlade.z, r = aBlade.w;
      float dist = length(xz - cameraPosition.xz);
      vec4 gm = groundMask(xz);
      vec4 nz = texture(uNoiseTex, xz * 0.006 + 0.3);
      float patchF = smoothstep(0.45, 0.7, nz.g) * gm.g * (1.0 - gm.r);
      // presence depends only on the patch, never on distance, so flowers never grow in as you walk up;
      // they only shrink in the last few metres of their range where they are a pixel or two wide
      float vis = clamp((patchF - rnk) / 0.04, 0.0, 1.0);
      float nearF = 1.0 - smoothstep(uR1 * 0.8, uR1, dist);
      float kindSel = fract(r * 11.3);
      // 0 buttercup (most), 1 daisy, 2 umbel, 3 clover
      float kind = kindSel < 0.6 ? 0.0 : kindSel < 0.75 ? 1.0 : kindSel < 0.9 ? 2.0 : 3.0;
      float hgt = (kind == 2.0 ? mix(0.7, 1.1, fract(r * 5.3)) : kind == 3.0 ? 0.2 : mix(0.35, 0.75, fract(r * 5.3))) * vis;
      float hs = (kind == 2.0 ? 0.062 : kind == 3.0 ? 0.03 : 0.038) * vis * nearF;
      vec2 w = windBend(xz, r * 6.28) * 0.8;
      vec2 lean = vec2(cos(r * 40.0), sin(r * 40.0)) * 0.15;
      vec2 bend = w + lean;
      float ground = terrainHeight(xz);
      vec3 pos;
      vec3 nrm = vec3(0.0, 1.0, 0.0);
      vec2 headXZ = xz + bend * hgt;
      float headY = ground + hgt * (1.0 - 0.2 * length(bend));
      if (aPart < 0.5) {
        float t = position.y;
        float ang = r * 6.28;
        vec2 perp = vec2(-sin(ang), cos(ang));
        float sw = max(0.005, dist * 0.0006) * (1.0 - t * 0.4);
        pos.xz = xz + perp * position.x * sw + bend * hgt * t * t;
        pos.y = ground + (headY - ground) * t;
        vUv = vec2(0.02, 0.02);
      } else {
        float ang = r * 6.28;
        float ca = cos(ang), sa = sin(ang);
        vec2 lx = vec2(position.x * ca - position.z * sa, position.x * sa + position.z * ca);
        pos.xz = headXZ + lx * hs;
        pos.y = headY + (position.y - 1.0) * hs;
        vec2 cell = vec2(mod(kind, 2.0), 1.0 - floor(kind / 2.0)) * 0.5;
        vUv = cell + uv * 0.5;
        #ifdef USE_MAP
        vMapUv = vUv;
        #endif
      }
      vPart = aPart;
      vFlowCol = aPart < 0.5 ? vec3(0.16, 0.28, 0.06) : vec3(1.0);
      float ao = aPart < 0.5 ? 0.6 : 1.0;
    `,
    fragmentPars: 'varying vec3 vFlowCol; varying float vPart; varying vec2 vUv;',
    vertexEnd: '',
    fragmentColor: `
      if (vPart < 0.5) diffuseColor = vec4(vFlowCol, 1.0);
      else diffuseColor.rgb *= 0.8;
    `,
    fragmentNormal: 'vec3 normal = normalize(vNormal);',
  });
  return mat;
}
