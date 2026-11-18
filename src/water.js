// Creek surface, waterfalls into the chasm and drifting chasm mist.
import * as THREE from 'three';
import { G, COMMON_GLSL } from './shaderlib.js';
import { SKY_GLSL } from './sky.js';
import { chasmCentre } from './worldgen.js';
import { fallList } from './cliffs.js';

const WATER_VS = /* glsl */`
${COMMON_GLSL}
attribute float aDist;
attribute float aSpeed;
varying vec3 vW;
varying vec2 vUv2;
varying float vSpeed;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vUv2 = vec2(uv.x, aDist);
  vSpeed = aSpeed;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const WATER_FS = /* glsl */`
${COMMON_GLSL}
${SKY_GLSL}
uniform float uRain;
varying vec3 vW;
varying vec2 vUv2;
varying float vSpeed;
vec3 waterNormal(vec2 uv, float t) {
  vec2 a = uv * vec2(0.9, 0.35) + vec2(0.0, -t * vSpeed * 0.55);
  vec2 b = uv * vec2(1.7, 0.7) + vec2(0.31, -t * vSpeed * 0.9);
  float h0 = texture(uNoiseTex, a * 0.25).b + texture(uNoiseTex, b * 0.25).b * 0.6;
  float hx = texture(uNoiseTex, (a + vec2(0.02, 0.0)) * 0.25).b + texture(uNoiseTex, (b + vec2(0.02, 0.0)) * 0.25).b * 0.6;
  float hy = texture(uNoiseTex, (a + vec2(0.0, 0.02)) * 0.25).b + texture(uNoiseTex, (b + vec2(0.0, 0.02)) * 0.25).b * 0.6;
  vec3 n = normalize(vec3((h0 - hx) * 6.0, 1.0, (h0 - hy) * 6.0));
  if (uRain > 0.01) {
    vec2 cell = floor(vW.xz * 3.0);
    vec2 f = fract(vW.xz * 3.0) - 0.5;
    float ph = fract(uTime * 1.3 + hash12(cell));
    float r = length(f - (hash22(cell) - 0.5) * 0.4);
    float ring = sin((r - ph * 0.5) * 60.0) * smoothstep(0.5 * ph + 0.05, 0.5 * ph, r) * (1.0 - ph);
    n.xz += (f / max(r, 1e-3)) * ring * 0.35 * uRain;
    n = normalize(n);
  }
  return n;
}
void main() {
  float t = uTime;
  vec3 n = waterNormal(vec2(vUv2.x * 2.0, vUv2.y), t);
  vec3 V = normalize(cameraPosition - vW);
  float bed = terrainHeight(vW.xz);
  float depth = max(vW.y - bed, 0.0);
  vec3 R = reflect(-V, n);
  R.y = abs(R.y);
  vec3 sky = skyRadiance(R);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  float sh = cloudShadowAt(vW);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(n, H), 0.0), 380.0) * 60.0 * sh * (1.0 - uOvercast);
  vec3 deepCol = vec3(0.015, 0.03, 0.025);
  vec3 col = mix(deepCol, sky, fres) + uSunColor * uSunIntensity * spec * 0.06;
  float foam = smoothstep(0.12, 0.0, depth) * smoothstep(0.45, 0.75, texture(uNoiseTex, vec2(vUv2.x * 1.3, vUv2.y * 0.4 - t * vSpeed * 0.5) * 0.4).g);
  col = mix(col, vec3(0.75) * (0.4 + 0.6 * sh) * uSkyBright, foam * 0.6);
  float alpha = clamp(fres * 0.9 + smoothstep(0.0, 0.7, depth) * 0.55 + foam * 0.5 + spec, 0.0, 1.0);
  alpha *= smoothstep(0.0, 0.04, depth + 0.01);
  col = applyFog(col, vW);
  gl_FragColor = vec4(col, alpha);
}
`;

const FALL_VS = /* glsl */`
${COMMON_GLSL}
varying vec3 vW;
varying vec2 vUv2;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz; vUv2 = uv;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const FALL_FS = /* glsl */`
${COMMON_GLSL}
${SKY_GLSL}
uniform float uTop;
varying vec3 vW;
varying vec2 vUv2;
void main() {
  float t = uTime;
  float s1 = texture(uNoiseTex, vec2(vUv2.x * 1.6, vUv2.y * 0.04 + t * 0.9)).b;
  float s2 = texture(uNoiseTex, vec2(vUv2.x * 3.1 + 0.3, vUv2.y * 0.07 + t * 1.6)).g;
  float streak = smoothstep(0.35, 0.8, s1 * 0.6 + s2 * 0.6);
  float edge = smoothstep(0.0, 0.18, vUv2.x) * smoothstep(1.0, 0.82, vUv2.x);
  float drop = uTop - vW.y;
  float fade = 1.0 - smoothstep(40.0, 150.0, drop);
  float sh = cloudShadowAt(vW);
  vec3 lit = vec3(0.82, 0.86, 0.88) * (0.45 + 0.55 * sh * max(uSunDir.y, 0.2)) * uSkyBright;
  vec3 col = applyFog(lit, vW);
  float a = (0.35 + 0.65 * streak) * edge * fade * 0.85;
  gl_FragColor = vec4(col, a);
}
`;

const MIST_FS = /* glsl */`
${COMMON_GLSL}
${SKY_GLSL}
uniform float uMistAmount;
varying vec3 vW;
varying vec2 vUv2;
void main() {
  vec2 p = vUv2 - 0.5;
  float r = length(p) * 2.0;
  float n = texture(uNoiseTex, vUv2 * 0.6 + vec2(uTime * 0.004, 0.0) + vW.xz * 0.0007).r;
  float a = smoothstep(1.0, 0.2, r) * smoothstep(0.3, 0.75, n) * 0.22 * uMistAmount;
  vec3 col = mix(uFogColor, vec3(0.85, 0.88, 0.9), 0.4) * (0.6 + 0.4 * max(uSunDir.y, 0.0)) * uSkyBright;
  gl_FragColor = vec4(col, a);
}
`;

export class Water {
  constructor(world, skyUniforms, cliffs) {
    this.group = new THREE.Group();
    const extra = { uRain: { value: 0 }, uTop: { value: 0 }, uMistAmount: { value: 1 } };
    this.extra = extra;
    const uni = Object.assign({}, G, skyUniforms, extra);

    // creek ribbon (above the rim only)
    const pos = [], uv = [], dist = [], speed = [], idx = [];
    const pts = world.creek.filter((c) => world.chasmEdgeDist(c.x, c.z) > 1.5);
    let acc = 0;
    for (let i = 0; i < pts.length; i++) {
      const c = pts[i];
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b.x - a.x, dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      if (i > 0) acc += Math.hypot(c.x - pts[i - 1].x, c.z - pts[i - 1].z);
      const w = c.width + 0.9;
      const slope = i > 0 ? Math.max(0, pts[i - 1].water - c.water) / Math.max(0.1, Math.hypot(c.x - pts[i - 1].x, c.z - pts[i - 1].z)) : 0;
      pos.push(c.x - dz * w, c.water, c.z + dx * w, c.x + dz * w, c.water, c.z - dx * w);
      uv.push(0, 0, 1, 0);
      dist.push(acc, acc);
      const sp = 0.6 + Math.min(2.5, slope * 60);
      speed.push(sp, sp);
      if (i < pts.length - 1) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1));
    g.setAttribute('aSpeed', new THREE.Float32BufferAttribute(speed, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const wm = new THREE.ShaderMaterial({ vertexShader: WATER_VS, fragmentShader: WATER_FS, uniforms: uni, transparent: true, depthWrite: false });
    const creek = new THREE.Mesh(g, wm);
    creek.renderOrder = 10;
    this.group.add(creek);

    // waterfalls: the creek's own fall plus springs on the far wall; each pours over the rock lip and down
    // the slot the cliff keeps clear for it, arcing out from the wall as it falls
    const falls = cliffs ? cliffs.falls : fallList(world);
    this.fallTops = falls;
    const fm = new THREE.ShaderMaterial({ vertexShader: FALL_VS, fragmentShader: FALL_FS, uniforms: uni, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    for (const f of falls) {
      const side = f.wall === 0 ? 1 : -1;
      const edgeZ = world.cliffRow(f.x, f.wall)[0];
      const path = [[f.z, f.y, 0], [edgeZ - side * 0.7, f.y - 0.1, 0.1]];
      const segs = 24;
      for (let s = 1; s <= segs; s++) {
        const drop = Math.pow(s / segs, 1.35) * 180;
        const y = f.y - 0.25 - drop;
        const wallZ = cliffs ? cliffs.shape.faceZ(f.x, y, f.wall) : edgeZ - side * (1 + drop / 14.3);
        path.push([wallZ - side * (0.9 + Math.sqrt(drop) * 1.3), y, drop]);
      }
      const fp = [], fuv = [], fi = [];
      for (let s = 0; s < path.length; s++) {
        const [z, y, drop] = path[s];
        const spread = 1 + Math.min(1, drop / 180) * 1.8;
        for (const sx of [-1, 1]) {
          fp.push(f.x + sx * f.w * 0.5 * spread, y, z);
          fuv.push(sx < 0 ? 0 : 1, f.y - y);
        }
        if (s < path.length - 1) { const k = s * 2; fi.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
      }
      const fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
      fg.setAttribute('uv', new THREE.Float32BufferAttribute(fuv, 2));
      fg.setIndex(fi);
      fg.computeBoundingSphere();
      const mat = fm.clone();
      mat.uniforms = Object.assign({}, uni, { uTop: { value: f.y } });
      const m = new THREE.Mesh(fg, mat);
      m.renderOrder = 11;
      this.group.add(m);
    }

    // mist banks drifting inside the chasm
    const mm = new THREE.ShaderMaterial({ vertexShader: FALL_VS, fragmentShader: MIST_FS, uniforms: uni, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.mist = [];
    for (let i = 0; i < 26; i++) {
      const x = -900 + i * 72 + Math.random() * 30;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(150, 70), mm);
      m.position.set(x, -25 - Math.random() * 60, chasmCentre(x) + (Math.random() - 0.5) * 50);
      m.userData.base = m.position.clone();
      m.userData.ph = Math.random() * 6;
      m.renderOrder = 12;
      this.group.add(m);
      this.mist.push(m);
    }
  }

  update(camera, t, rain) {
    this.extra.uRain.value = rain;
    for (const m of this.mist) {
      m.position.x = m.userData.base.x + Math.sin(t * 0.02 + m.userData.ph) * 25;
      m.position.y = m.userData.base.y + Math.sin(t * 0.05 + m.userData.ph) * 4;
      m.quaternion.copy(camera.quaternion);
    }
  }
}
