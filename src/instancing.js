// Chunked instancing: items are bucketed into 64 m chunks; each update picks visible chunks, sorts items into
// LOD buckets by distance and copies precomputed matrices into InstancedMeshes. Only runs when the camera moved.
import * as THREE from 'three';

const CHUNK = 64;

export const FADE_GLSL_VS = /* glsl */`
uniform vec2 uFadeIn;
uniform vec2 uFadeOut;
varying float vFadeIn;
varying float vFadeOut;
`;
export const FADE_GLSL_FS = /* glsl */`
varying float vFadeIn;
varying float vFadeOut;
`;
// call in vertex main once the instance origin is known
export const FADE_VS = /* glsl */`
{
  #ifdef USE_INSTANCING
  vec3 io = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  #else
  vec3 io = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  #endif
  float dd = length(io - uCamPos);
  vFadeIn = smoothstep(uFadeIn.x, uFadeIn.y, dd);
  vFadeOut = smoothstep(uFadeOut.x, uFadeOut.y, dd);
}
`;
export const FADE_FS = /* glsl */`
{
  float nn = ign(gl_FragCoord.xy);
  if (vFadeIn <= nn || vFadeOut > nn) discard;
}
`;

export function fadeUniforms(fadeIn, fadeOut) {
  return {
    uFadeIn: { value: new THREE.Vector2(fadeIn[0], fadeIn[1]) },
    uFadeOut: { value: new THREE.Vector2(fadeOut[0], fadeOut[1]) },
  };
}

/**
 * items: { matrices: Float32Array(16n), pos: Float32Array(4n) [x,y,z,maxDist], variant: Uint16Array(n) }
 * lods: array of distances where each LOD ends (last = absolute max)
 * meshes: meshes[variant][lod] = [InstancedMesh, ...] (all meshes of one LOD get the same matrices)
 */
export class ChunkedInstances {
  constructor(items, lods, band, meshes, worldSize = 2048) {
    this.items = items;
    this.lods = lods;
    this.band = band;
    this.meshes = meshes;
    this.n = items.variant.length;
    this.grid = Math.ceil(worldSize / CHUNK);
    this.half = worldSize / 2;
    const lists = Array.from({ length: this.grid * this.grid }, () => []);
    const yr = Array.from({ length: this.grid * this.grid }, () => [1e9, -1e9]);
    for (let i = 0; i < this.n; i++) {
      const x = items.pos[i * 4], y = items.pos[i * 4 + 1], z = items.pos[i * 4 + 2];
      const cx = Math.min(this.grid - 1, Math.max(0, Math.floor((x + this.half) / CHUNK)));
      const cz = Math.min(this.grid - 1, Math.max(0, Math.floor((z + this.half) / CHUNK)));
      const c = cz * this.grid + cx;
      lists[c].push(i);
      yr[c][0] = Math.min(yr[c][0], y); yr[c][1] = Math.max(yr[c][1], y);
    }
    this.chunks = lists.map((l, c) => ({
      idx: Int32Array.from(l),
      cx: (c % this.grid) * CHUNK - this.half + CHUNK / 2,
      cz: Math.floor(c / this.grid) * CHUNK - this.half + CHUNK / 2,
      cy: (yr[c][0] + yr[c][1]) / 2,
      r: Math.hypot(CHUNK / 2, CHUNK / 2, (yr[c][1] - yr[c][0]) / 2 + 25),
    })).filter((c) => c.idx.length);
    this._frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._s = new THREE.Sphere();
    this._last = new THREE.Vector3(1e9, 0, 0);
    this._lastQ = new THREE.Quaternion();
    this.maxD = lods[lods.length - 1] + band;
  }

  update(camera, force = false) {
    const p = camera.position;
    if (!force && p.distanceToSquared(this._last) < 2.0 && camera.quaternion.angleTo(this._lastQ) < 0.035) return false;
    this._last.copy(p); this._lastQ.copy(camera.quaternion);
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m);
    const { matrices, pos, variant } = this.items;
    const lods = this.lods, band = this.band, nl = lods.length;
    const meshes = this.meshes;
    const maxD = this.maxD;
    // gather (index, distance) per variant/LOD
    if (!this._bins) this._bins = meshes.map((v) => v.map(() => []));
    const bins = this._bins;
    for (const v of bins) for (const b of v) b.length = 0;
    for (const ch of this.chunks) {
      const dc = Math.hypot(ch.cx - p.x, ch.cz - p.z);
      if (dc - ch.r > maxD) continue;
      this._s.center.set(ch.cx, ch.cy, ch.cz);
      this._s.radius = ch.r + 22; // margin so off-screen casters still throw shadows
      if (dc > ch.r + 30 && !this._frustum.intersectsSphere(this._s)) continue;
      const idx = ch.idx;
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        const dx = pos[i * 4] - p.x, dy = pos[i * 4 + 1] - p.y, dz = pos[i * 4 + 2] - p.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > pos[i * 4 + 3] + band) continue;
        const v = variant[i];
        for (let l = 0; l < nl; l++) {
          const lo = l === 0 ? -1e9 : lods[l - 1] - band;
          const hi = lods[l] + band;
          if (d >= lo && d < hi && meshes[v][l]) bins[v][l].push(d, i);
        }
      }
    }
    const sortR = this.sortRadii;
    for (let v = 0; v < meshes.length; v++) {
      for (let l = 0; l < meshes[v].length; l++) {
        const list = meshes[v][l];
        if (!list) continue;
        const bin = bins[v][l];
        let n = bin.length / 2;
        const cap = list[0].instanceMatrix.count;
        // near LOD is ordered by distance so near shadow cascades can draw just a prefix
        let order = null;
        if (l === 0 && sortR) {
          order = new Array(n);
          for (let k = 0; k < n; k++) order[k] = k;
          order.sort((a, b) => bin[a * 2] - bin[b * 2]);
        }
        n = Math.min(n, cap);
        const cc = [0, 0];
        for (let k = 0; k < n; k++) {
          const e = order ? order[k] : k;
          const d = bin[e * 2], i = bin[e * 2 + 1];
          for (let mI = 0; mI < list.length; mI++) list[mI].instanceMatrix.array.set(matrices.subarray(i * 16, i * 16 + 16), k * 16);
          if (sortR) { if (d < sortR[0]) cc[0] = k + 1; if (d < sortR[1]) cc[1] = k + 1; }
        }
        for (const m of list) {
          m.count = n;
          m.visible = n > 0;
          m.userData.cascadeCounts = sortR && l === 0 ? [cc[0], cc[1], n] : null;
          m.instanceMatrix.clearUpdateRanges();
          m.instanceMatrix.addUpdateRange(0, n * 16);
          m.instanceMatrix.needsUpdate = true;
        }
      }
    }
    return true;
  }
}

// near cascades only need the closest instances: draw a distance-sorted prefix
export function cascadePrefix(mesh) {
  mesh.onBeforeShadow = (r, o, c, shadowCam) => {
    const cc = mesh.userData.cascadeCounts;
    const k = shadowCam.userData.cascade;
    if (cc && k < 2) { mesh.userData.saved = mesh.count; mesh.count = cc[k]; }
  };
  mesh.onAfterShadow = () => {
    if (mesh.userData.saved !== undefined) { mesh.count = mesh.userData.saved; mesh.userData.saved = undefined; }
  };
}

export function composeMatrices(n, get) {
  const out = new Float32Array(n * 16);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3(), e = new THREE.Euler();
  for (let i = 0; i < n; i++) {
    const r = get(i); // {x,y,z,ry,sx,sy,sz,rx,rz}
    t.set(r.x, r.y, r.z);
    e.set(r.rx || 0, r.ry || 0, r.rz || 0, 'YXZ');
    q.setFromEuler(e);
    s.set(r.sx, r.sy ?? r.sx, r.sz ?? r.sx);
    m.compose(t, q, s);
    m.toArray(out, i * 16);
  }
  return out;
}

export function makeInstanced(geo, mat, capacity) {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, capacity));
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.count = 0;
  m.frustumCulled = false;
  return m;
}
