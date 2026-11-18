// Cascaded sun shadows. Each cascade is a DirectionalLight shadow fitted to a slice of the view frustum
// (bounding sphere + texel snapping so edges don't crawl). Far cascades refresh less often.
import * as THREE from 'three';
import { G } from './shaderlib.js';

export class SunShadows {
  constructor(scene, q) {
    this.q = q;
    this.n = q.shadows;
    this.lights = [];
    this.splits = q.cascadeSplits.slice(0, Math.max(1, this.n));
    this.frame = 0;
    const count = Math.max(1, this.n);
    for (let i = 0; i < count; i++) {
      const L = new THREE.DirectionalLight(0xffffff, i === 0 ? 3 : 0);
      L.castShadow = this.n > 0;
      if (this.n > 0) {
        L.shadow.mapSize.set(q.shadowRes[i], q.shadowRes[i]);
        L.shadow.bias = -0.0004;
        L.shadow.normalBias = 0.02;
        L.shadow.autoUpdate = false;
        L.shadow.needsUpdate = true;
        L.shadow.camera.userData.cascade = i;
        L.shadow.radius = 1;
      }
      scene.add(L, L.target);
      this.lights.push(L);
    }
    this.main = this.lights[0];
    const arr = G.uCascadeSplits.value;
    for (let i = 0; i < 4; i++) arr[i] = i < this.splits.length ? this.splits[i] : 1e9;
    this._corners = Array.from({ length: 8 }, () => new THREE.Vector3());
    this._c = new THREE.Vector3();
    this._lx = new THREE.Vector3(); this._ly = new THREE.Vector3();
  }

  update(camera, sunDir) {
    this.frame++;
    const sd = sunDir;
    for (const L of this.lights) { L.color.copy(this.main.color); }
    if (this.n === 0) { this.main.position.copy(camera.position).addScaledVector(sd, 100); this.main.target.position.copy(camera.position); return; }
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const tanY = Math.tan(fov / 2), tanX = tanY * camera.aspect;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    let near = camera.near;
    // light basis for texel snapping
    const lz = sd.clone().normalize();
    const lx = this._lx.crossVectors(Math.abs(lz.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0), lz).normalize();
    const ly = this._ly.crossVectors(lz, lx);
    for (let i = 0; i < this.lights.length; i++) {
      const far = this.splits[i];
      const every = this.q.cascadeEvery[i] || 1;
      const due = (this.frame + i) % every === 0;
      if (due) {
        // bounding sphere of the frustum slice [near, far]
        const zm = (near + far) / 2;
        const hfar = far * Math.hypot(tanX, tanY);
        const k = hfar * hfar / (far * far);
        let cz = Math.min(far, zm * (1 + k));
        const radius = Math.hypot(far * tanX, far * tanY, far - cz) * 1.04;
        const c = this._c.copy(camera.position).addScaledVector(fwd, cz);
        const L = this.lights[i];
        const res = L.shadow.mapSize.x;
        const texel = (2 * radius) / res;
        // snap centre in light space
        const px = c.dot(lx), py = c.dot(ly), pz = c.dot(lz);
        const sx = Math.round(px / texel) * texel, sy = Math.round(py / texel) * texel;
        c.copy(lx).multiplyScalar(sx).addScaledVector(ly, sy).addScaledVector(lz, pz);
        const back = 260;
        L.target.position.copy(c);
        L.position.copy(c).addScaledVector(lz, back);
        L.target.updateMatrixWorld();
        L.updateMatrixWorld();
        const cam = L.shadow.camera;
        cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
        cam.near = 1; cam.far = back + radius + 60;
        cam.updateProjectionMatrix();
        L.shadow.normalBias = texel * 1.4;
        L.shadow.bias = -0.00025 * (i + 1);
        L.shadow.needsUpdate = true;
      }
      near = far;
    }
    // the shading light follows the sun even on frames its cascade is not refreshed
    if ((this.frame) % (this.q.cascadeEvery[0] || 1) !== 0) {
      // nothing: light 0 direction is unchanged between refreshes of cascade 0 (always 1)
    }
  }
}
