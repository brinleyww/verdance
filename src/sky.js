// Sky: analytic atmosphere + volumetric cumulus raymarched into an amortised panorama.
import * as THREE from 'three';
import { G } from './shaderlib.js';

export const SKY_GLSL = /* glsl */`
uniform float uOvercast;
uniform float uSunIntensity;
uniform float uSkyBright;
vec3 skyRadiance(vec3 rd) {
  float y = rd.y;
  float yy = max(y, 0.0);
  float mu = dot(rd, uSunDir);
  float sunUp = clamp(uSunDir.y, 0.0, 1.0);
  vec3 zenith = mix(vec3(0.055, 0.15, 0.42), vec3(0.09, 0.24, 0.62), sunUp);
  vec3 horizon = mix(vec3(0.75, 0.62, 0.52), vec3(0.58, 0.70, 0.86), smoothstep(0.0, 0.35, sunUp));
  float h = pow(1.0 - yy, 5.0);
  vec3 col = mix(zenith, horizon, h);
  col += vec3(0.30, 0.22, 0.12) * pow(1.0 - yy, 12.0) * (1.0 - smoothstep(0.0, 0.3, sunUp)) * pow(max(mu, 0.0) * 0.5 + 0.5, 4.0);
  float glow = pow(max(mu, 0.0), 5.0) * 0.22 + pow(max(mu, 0.0), 48.0) * 0.55 + pow(max(mu, 0.0), 600.0) * 2.0;
  col += vec3(1.0, 0.88, 0.72) * glow * (1.0 - uOvercast * 0.8);
  vec3 grey = vec3(0.50, 0.53, 0.57) * (0.82 + 0.18 * yy) + pow(max(mu, 0.0), 6.0) * 0.12;
  col = mix(col, grey, uOvercast);
  if (y < 0.0) col = mix(col, horizon * 0.82 * (1.0 - uOvercast * 0.3) + grey * uOvercast * 0.3, smoothstep(0.0, -0.08, y));
  return col * uSkyBright;
}
`;

const FS_QUAD_VS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Tileable 3D Perlin-Worley noise rendered into a 3D texture (once, on the GPU).
const NOISE3D_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uLayer;
uniform float uRes;
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float worley(vec3 p, float per) {
  vec3 id = floor(p), f = fract(p);
  float md = 1.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    vec3 o = vec3(x, y, z);
    vec3 c = mod(id + o, per);
    vec3 r = o + hash33(c) - f;
    md = min(md, dot(r, r));
  }
  return 1.0 - sqrt(md);
}
float gnoise(vec3 p, float per) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n = 0.0;
  float r[8];
  for (int k = 0; k < 8; k++) {
    vec3 o = vec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    vec3 g = hash33(mod(i + o, per)) * 2.0 - 1.0;
    r[k] = dot(normalize(g + 1e-4), f - o);
  }
  return mix(mix(mix(r[0], r[1], u.x), mix(r[2], r[3], u.x), u.y), mix(mix(r[4], r[5], u.x), mix(r[6], r[7], u.x), u.y), u.z);
}
float pfbm(vec3 p, float per) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * gnoise(p, per); p *= 2.0; per *= 2.0; a *= 0.5; }
  return s;
}
float wfbm(vec3 p, float per) {
  return worley(p, per) * 0.625 + worley(p * 2.0, per * 2.0) * 0.25 + worley(p * 4.0, per * 4.0) * 0.125;
}
float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
void main() {
  vec3 p = vec3(vUv, (uLayer + 0.5) / uRes);
  float per = 4.0;
  float perlin = pfbm(p * per, per) * 0.5 + 0.5;
  perlin = clamp(remap(perlin, 0.0, 1.0, -0.15, 1.15), 0.0, 1.0);
  float w1 = wfbm(p * per, per);
  float pw = clamp(remap(perlin, w1 - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);
  float w2 = wfbm(p * per * 2.0, per * 2.0);
  float w3 = wfbm(p * per * 4.0, per * 4.0);
  gl_FragColor = vec4(pw, w1 * 0.625 + w2 * 0.25 + w3 * 0.125, w2, perlin);
}
`;

const CLOUD_FS = /* glsl */`
precision highp float;
precision highp sampler3D;
varying vec2 vUv;
uniform sampler3D uNoise3D;
uniform vec3 uCamPos;
uniform float uPhase;
uniform float uPhases;
uniform float uSteps;
uniform float uLightSteps;
uniform float uCloudDensity;
uniform float uCloudDark;
uniform vec3 uAmbTop;
uniform vec3 uAmbBottom;
uniform vec2 uPanoSize;
${'\n'}
const float R_EARTH = 6371000.0;
const float CB = 1400.0;
const float CT = 2900.0;

vec3 panoDir(vec2 uv) {
  float az = uv.x * 6.2831853;
  float el = uv.y * uv.y * 1.5707963;
  return vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
}
float altitude(vec3 p) { return p.y + dot(p.xz, p.xz) / (2.0 * R_EARTH); }
float shellT(vec3 ro, vec3 rd, float H) {
  float b = ro.x * rd.x + (R_EARTH + ro.y) * rd.y + ro.z * rd.z;
  float c = ro.x * ro.x + ro.z * ro.z + (ro.y - H) * (2.0 * R_EARTH + ro.y + H);
  float d = b * b - c;
  return -b + sqrt(max(d, 0.0));
}
float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
float HG(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

float density(vec3 p, bool detail) {
  float h = clamp((altitude(p) - CB) / (CT - CB), 0.0, 1.0);
  vec2 wuv = (p.xz + uCloudOffset) / 15000.0;
  float cov = textureLod(uWeatherMap, wuv, 0.0).r * 0.7 + textureLod(uWeatherMap, wuv * 3.1 + 0.37, 0.0).g * 0.3;
  float coverage = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.3, cov);
  if (coverage <= 0.001) return -1.0;
  // cumulus: flat base, density threshold rising with height gives rounded domes
  float big = textureLod(uWeatherMap, wuv * 0.35 + 0.17, 0.0).b;
  float top = mix(0.24, 1.0, clamp(big * 1.25 * (0.35 + uCloudCover), 0.0, 1.0));
  float prof = smoothstep(0.0, 0.04, h) * (1.0 - pow(clamp(h / top, 0.0, 1.0), 3.0));
  vec3 wind = vec3(uCloudOffset.x, 0.0, uCloudOffset.y);
  vec4 n = textureLod(uNoise3D, (p + wind) / 2900.0, 0.0);
  float base = clamp(remap(n.r, n.g * 0.35 - 0.2, 1.0, 0.0, 1.0), 0.0, 1.0);
  float c2 = coverage * prof;
  float shape = clamp(remap(base, 1.0 - c2, 1.0, 0.0, 1.0), 0.0, 1.0);
  if (shape <= 0.0) return 0.0;
  if (detail) {
    float d = textureLod(uNoise3D, (p + wind * 1.3) / 720.0 + vec3(0.0, uTime * 0.003, 0.0), 0.0).g;
    float er = mix(d, 1.0 - d, clamp(h * 4.0, 0.0, 1.0));
    shape = clamp(remap(shape, er * 0.38 * smoothstep(0.0, 0.2, h), 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  return shape * shape * (3.0 - 2.0 * shape) * uCloudDensity * smoothstep(0.0, 0.035, h);
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (uPhases > 1.0) {
    float k = mod(float(c.x) + float(c.y) * 3.0, uPhases);
    if (abs(k - uPhase) > 0.5) discard;
  }
  vec3 rd = panoDir(vUv);
  vec3 ro = vec3(0.0, max(uCamPos.y, 0.0), 0.0);
  if (rd.y < 0.012) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float t0 = shellT(ro, rd, CB);
  float t1 = shellT(ro, rd, CT);
  t1 = min(t1, t0 + 9000.0);
  float maxT = 42000.0;
  if (t0 > maxT) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  t1 = min(t1, maxT);
  float len = t1 - t0;
  float steps = min(uSteps * mix(1.6, 1.0, smoothstep(0.03, 0.35, rd.y)), 120.0);
  float dt = len / steps;
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float t = t0 + dt * jit;
  float T = 1.0;
  vec3 S = vec3(0.0);
  float mu = dot(rd, uSunDir);
  float phase = mix(HG(mu, 0.72), HG(mu, -0.2), 0.42) * 12.566 * 0.9 + 0.25;
  vec3 sunC = uSunColor * uSunIntensity;
  float sigma = 0.022;
  float zeroRun = 0.0;
  for (int i = 0; i < 128; i++) {
    if (float(i) >= steps || T < 0.01 || t > t1) break;
    vec3 p = ro + rd * t;
    float d = density(p, true);
    if (d < 0.0) { t += dt * 1.5; continue; }
    if (d > 0.002) {
      float ld = 0.0;
      float ls = 60.0;
      vec3 lp = p;
      for (int j = 0; j < 8; j++) {
        if (float(j) >= uLightSteps) break;
        lp += uSunDir * ls;
        ld += max(density(lp, false), 0.0) * ls;
        ls *= 1.7;
      }
      float beer = exp(-ld * sigma * 0.55) * 0.75 + exp(-ld * sigma * 0.12) * 0.25;
      float powder = 1.0 - exp(-d * dt * sigma * 2.0);
      float h = clamp((altitude(p) - CB) / (CT - CB), 0.0, 1.0);
      vec3 amb = mix(uAmbBottom, uAmbTop, smoothstep(0.0, 1.0, h)) * (1.0 - uCloudDark * 0.6);
      vec3 Ls = sunC * beer * mix(1.0, powder * 2.0, 0.5) * phase * (1.0 - uCloudDark * 0.85) + amb;
      float ext = d * sigma;
      float dT = exp(-ext * dt);
      S += T * Ls * (1.0 - dT);
      T *= dT;
    }
    t += dt;
  }
  // aerial perspective on distant clouds
  float fade = 1.0 - exp(-t0 / 16000.0);
  vec3 haze = skyRadiance(normalize(vec3(rd.x, max(rd.y, 0.02), rd.z)));
  S = mix(S, haze * (1.0 - T), fade);
  T = mix(T, 1.0, fade * 0.35);
  float horizonFade = smoothstep(0.012, 0.06, rd.y);
  S *= horizonFade; T = mix(1.0, T, horizonFade);
  gl_FragColor = vec4(S, T);
}
`;

const DOME_VS = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
  gl_Position.z = gl_Position.w * 0.99999;
}
`;
const DOME_FS = /* glsl */`
varying vec3 vDir;
uniform sampler2D uPano;
uniform float uFlash;
vec2 dirToPano(vec3 d) {
  float az = atan(d.z, d.x);
  float u = fract(az / 6.2831853 + 1.0);
  float el = asin(clamp(d.y, 0.0, 1.0));
  float v = sqrt(el / 1.5707963);
  return vec2(u, v);
}
void main() {
  vec3 rd = normalize(vDir);
  vec3 sky = skyRadiance(rd);
  vec4 cl = rd.y > 0.0 ? texture(uPano, dirToPano(rd)) : vec4(0.0, 0.0, 0.0, 1.0);
  float mu = dot(rd, uSunDir);
  float disk = smoothstep(0.99996, 0.999985, mu) * (1.0 - uOvercast);
  vec3 sun = uSunColor * uSunIntensity * disk * 30.0;
  vec3 col = (sky + sun) * cl.a + cl.rgb;
  col += vec3(0.75, 0.8, 1.0) * uFlash * (0.6 + 0.4 * (1.0 - cl.a));
  // horizon haze matches terrain fog
  float hz = 1.0 - smoothstep(-0.02, 0.12, rd.y);
  col = mix(col, mix(uFogColor, uFogSunColor, pow(max(mu, 0.0), 6.0) * 0.6), hz * 0.55 * (1.0 - exp(-uFogDensity * 9000.0)) );
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Sky {
  constructor(renderer, q) {
    this.renderer = renderer;
    this.q = q;
    this.uniforms = {
      uOvercast: { value: 0 },
      uSunIntensity: { value: 3.2 },
      uSkyBright: { value: 1 },
      uCloudDensity: { value: 1 },
      uCloudDark: { value: 0 },
      uAmbTop: { value: new THREE.Color(0.5, 0.6, 0.8) },
      uAmbBottom: { value: new THREE.Color(0.3, 0.32, 0.36) },
      uFlash: { value: 0 },
    };
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);

    this.makeNoise3D(q.cloudNoiseRes);

    const [pw, ph] = q.cloudPano;
    this.pano = new THREE.WebGLRenderTarget(pw, ph, { type: THREE.HalfFloatType, depthBuffer: false });
    this.pano.texture.wrapS = THREE.RepeatWrapping;
    this.pano.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.pano.texture.minFilter = THREE.LinearFilter;
    this.pano.texture.generateMipmaps = false;

    this.cloudMat = new THREE.ShaderMaterial({
      vertexShader: FS_QUAD_VS,
      fragmentShader: shaderPrelude() + CLOUD_FS,
      uniforms: Object.assign({}, G, this.uniforms, {
        uNoise3D: { value: this.noise3D.texture },
        uCamPos: { value: new THREE.Vector3() },
        uPhase: { value: 0 },
        uPhases: { value: q.cloudPhases },
        uSteps: { value: q.cloudSteps },
        uLightSteps: { value: q.cloudLightSteps },
        uPanoSize: { value: new THREE.Vector2(pw, ph) },
      }),
      depthTest: false, depthWrite: false,
    });
    this.phase = 0;

    this.domeMat = new THREE.ShaderMaterial({
      vertexShader: DOME_VS,
      fragmentShader: shaderPrelude() + DOME_FS,
      uniforms: Object.assign({}, G, this.uniforms, { uPano: { value: this.pano.texture } }),
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 900;
    this.envScene = new THREE.Scene();
    this.envDome = new THREE.Mesh(this.dome.geometry, this.domeMat);
    this.envDome.frustumCulled = false;
    this.envScene.add(this.envDome);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;
    this.envKey = '';
  }

  makeNoise3D(res) {
    const rt = new THREE.WebGL3DRenderTarget(res, res, res, { depthBuffer: false });
    rt.texture.wrapS = rt.texture.wrapT = rt.texture.wrapR = THREE.RepeatWrapping;
    rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
    rt.texture.generateMipmaps = false;
    const mat = new THREE.ShaderMaterial({
      vertexShader: FS_QUAD_VS, fragmentShader: NOISE3D_FS,
      uniforms: { uLayer: { value: 0 }, uRes: { value: res } },
      depthTest: false, depthWrite: false,
    });
    this.quad.material = mat;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    for (let z = 0; z < res; z++) {
      mat.uniforms.uLayer.value = z;
      r.setRenderTarget(rt, z);
      r.render(this.quadScene, this.quadCam);
    }
    r.setRenderTarget(prev);
    mat.dispose();
    this.noise3D = rt;
  }

  // Update a slice of the cloud panorama. full=true redraws everything (startup / big jumps).
  updateClouds(camPos, full = false) {
    const r = this.renderer;
    const u = this.cloudMat.uniforms;
    u.uCamPos.value.copy(camPos);
    this.quad.material = this.cloudMat;
    const prevRT = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.autoClear = false;
    const phases = this.q.cloudPhases;
    const n = full ? phases : 1;
    r.setRenderTarget(this.pano);
    for (let i = 0; i < n; i++) {
      u.uPhase.value = this.phase;
      this.phase = (this.phase + 1) % phases;
      r.render(this.quadScene, this.quadCam);
    }
    r.setRenderTarget(prevRT);
    r.autoClear = prevAuto;
  }

  updateEnv(force = false) {
    const key = [G.uCloudCover.value.toFixed(2), this.uniforms.uOvercast.value.toFixed(2), G.uSunDir.value.y.toFixed(2)].join('|');
    if (!force && key === this.envKey) return;
    this.envKey = key;
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 10);
    if (old) old.dispose();
    return this.envRT.texture;
  }
}

function shaderPrelude() {
  return /* glsl */`
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uCloudCover;
uniform vec2 uCloudOffset;
uniform sampler2D uWeatherMap;
uniform vec3 uFogColor;
uniform vec3 uFogSunColor;
uniform float uFogDensity;
` + SKY_GLSL;
}

// JS mirror of skyRadiance() for fog colour and ambient light.
export function skyRadianceJS(dir, sunDir, overcast, bright, out) {
  const y = dir.y, yy = Math.max(y, 0);
  const mu = Math.max(0, dir.x * sunDir.x + dir.y * sunDir.y + dir.z * sunDir.z);
  const sunUp = Math.min(Math.max(sunDir.y, 0), 1);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ss = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
  const zr = lerp(0.055, 0.09, sunUp), zg = lerp(0.15, 0.24, sunUp), zb = lerp(0.42, 0.62, sunUp);
  const hs = ss(0, 0.35, sunUp);
  const hr = lerp(0.75, 0.58, hs), hg = lerp(0.62, 0.70, hs), hb = lerp(0.52, 0.86, hs);
  const h = Math.pow(1 - yy, 5);
  let r = lerp(zr, hr, h), g = lerp(zg, hg, h), b = lerp(zb, hb, h);
  const glow = (Math.pow(mu, 5) * 0.22 + Math.pow(mu, 48) * 0.55) * (1 - overcast * 0.8);
  r += 1.0 * glow; g += 0.88 * glow; b += 0.72 * glow;
  const gl = 0.82 + 0.18 * yy, gs = Math.pow(mu, 6) * 0.12;
  r = lerp(r, 0.50 * gl + gs, overcast); g = lerp(g, 0.53 * gl + gs, overcast); b = lerp(b, 0.57 * gl + gs, overcast);
  out.setRGB(r * bright, g * bright, b * bright);
  return out;
}
