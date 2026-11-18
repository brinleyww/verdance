// HDR post chain: scene -> (bloom) -> filmic tonemap + grade -> (FXAA).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1.0 },
    uTime: { value: 0 },
    uSat: { value: 1.08 },
    uContrast: { value: 1.06 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0.035 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uExposure, uTime, uSat, uContrast, uVignette, uGrain;
    uniform vec3 uTint;
    varying vec2 vUv;
    vec3 RRTAndODTFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 acesFilmic(vec3 c) {
      const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      c = inM * c;
      c = RRTAndODTFit(c);
      return clamp(outM * c, 0.0, 1.0);
    }
    vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure * uTint;
      c = acesFilmic(c * 1.25);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = max(mix(vec3(l), c, uSat), 0.0);
      c = toSRGB(c);
      c = (c - 0.5) * uContrast + 0.5;
      vec2 q = vUv - 0.5;
      c *= mix(1.0, smoothstep(0.95, 0.25, length(q * vec2(1.0, 0.85))), uVignette);
      float g = h(vUv * 1000.0 + fract(uTime) * 91.7) - 0.5;
      c += g * uGrain * (1.0 - l * 0.6);
      c += (h(gl_FragCoord.xy + 0.5) - 0.5) / 255.0;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};


// Volumetric sun shafts: march each view ray through the cascaded sun shadow maps at reduced resolution,
// blur with depth awareness and add the in-scattered light to the HDR image before bloom and grading.
const QUAD_VS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const MARCH_FS = /* glsl */`
precision highp float;
#include <packing>
varying vec2 vUv;
uniform sampler2D tDepth;
uniform sampler2D uSM0;
uniform sampler2D uSM1;
uniform sampler2D uSM2;
uniform mat4 uSMat0;
uniform mat4 uSMat1;
uniform mat4 uSMat2;
uniform vec3 uSplits;
uniform int uCascades;
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uAmount;
uniform float uScatter;
uniform float uMaxDist;
uniform float uSteps;
uniform vec2 uRes;
uniform sampler2D uWeatherMap;
uniform vec2 uCloudOffset;
uniform float uCloudCover;
uniform float uCloudShadow;

float cloudShadowAt(vec3 wpos) {
  float sy = max(uSunDir.y, 0.12);
  vec2 p = wpos.xz + uSunDir.xz / sy * (1600.0 - wpos.y);
  vec2 uv = (p + uCloudOffset) / 15000.0;
  float c = textureLod(uWeatherMap, uv, 0.0).r * 0.7 + textureLod(uWeatherMap, uv * 3.1 + 0.37, 0.0).g * 0.3;
  float cov = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.3, c);
  return 1.0 - cov * uCloudShadow;
}
float tap(sampler2D sm, mat4 m, vec3 p) {
  vec4 c = m * vec4(p, 1.0);
  c.xyz /= c.w;
  float lit = step(c.z - 0.0008, unpackRGBAToDepth(textureLod(sm, clamp(c.xy, 0.0, 1.0), 0.0)));
  bool inside = c.x >= 0.0 && c.x <= 1.0 && c.y >= 0.0 && c.y <= 1.0 && c.z <= 1.0;
  return inside ? lit : 1.0;
}
float litAt(vec3 p, float vz) {
  float r;
  if (vz < uSplits.x || uCascades == 1) r = tap(uSM0, uSMat0, p);
  else if (vz < uSplits.y || uCascades == 2) r = tap(uSM1, uSMat1, p);
  else r = tap(uSM2, uSMat2, p);
  return r;
}
void main() {
  float dz = texture(tDepth, vUv).r;
  vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, dz * 2.0 - 1.0, 1.0);
  vp /= vp.w;
  vec3 wp = (uCamWorld * vp).xyz;
  vec3 rd = wp - uCamPos;
  float dist = length(rd);
  rd /= max(dist, 1e-4);
  if (dz >= 0.99999) dist = 1e6;
  float L = min(dist, uMaxDist);
  vec3 fwd = -normalize(uCamWorld[2].xyz);
  float fz = dot(rd, fwd);
  float n = uSteps;
  float dt = L / n;
  // interleaved gradient noise; the blur pass removes the pattern
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float sum = 0.0;
  float ext = uScatter * 1.4;
  for (int i = 0; i < 48; i++) {
    if (float(i) >= n) break;
    float t = (float(i) + jit) * dt;
    vec3 p = uCamPos + rd * t;
    // denser air near the ground
    float h = exp(-max(p.y - uCamPos.y + 4.0, 0.0) / 70.0);
    sum += litAt(p, t * fz) * exp(-ext * t) * h;
  }
  sum *= dt;
  float mu = dot(rd, uSunDir);
  float g = 0.6, g2 = g * g;
  float hg = (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * mu, 1.5);
  float phase = hg * 0.7 + 0.3;
  float cs = cloudShadowAt(uCamPos + rd * min(L, 60.0));
  vec3 col = uSunColor * uAmount * uScatter * phase * sum * cs;
  // linear view depth rides along for the depth-aware blur and upsample
  gl_FragColor = vec4(col, dz >= 0.99999 ? 4000.0 : min(-vp.z, 4000.0));
}
`;
const BLUR_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uDir;
void main() {
  vec4 c = texture(tSrc, vUv);
  vec3 acc = c.rgb * 0.2;
  float wsum = 0.2;
  for (int i = 1; i <= 4; i++) {
    float w = exp(-float(i * i) / 8.0) * 0.2;
    for (int sgn = -1; sgn <= 1; sgn += 2) {
      vec4 s = texture(tSrc, vUv + uDir * float(i * sgn));
      float dw = exp(-abs(s.a - c.a) / (0.08 * c.a + 0.5));
      acc += s.rgb * w * dw;
      wsum += w * dw;
    }
  }
  gl_FragColor = vec4(acc / wsum, c.a);
}
`;
const COMP_FS = /* glsl */`
precision highp float;
#include <packing>
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tShaft;
uniform sampler2D tDepth;
uniform vec2 uLowSize;
uniform float uNear;
uniform float uFar;
void main() {
  vec4 c = texture(tDiffuse, vUv);
  // bilateral upsample: low-res texels at a different depth (sky behind a leaf) get little weight
  float d = texture(tDepth, vUv).r;
  float z = d >= 0.99999 ? 4000.0 : min(-perspectiveDepthToViewZ(d, uNear, uFar), 4000.0);
  vec2 p = vUv * uLowSize - 0.5;
  vec2 f = fract(p);
  ivec2 i0 = ivec2(floor(p));
  ivec2 hi = ivec2(uLowSize) - 1;
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    vec4 s = texelFetch(tShaft, clamp(i0 + o, ivec2(0), hi), 0);
    float bw = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    float w = bw / (0.02 + abs(s.a - z) / max(z, 0.5)) + 1e-6;
    acc += s.rgb * w; ws += w;
  }
  vec3 sh = acc / ws;
  // soft roll-off keeps the brightest beams from flattening into white
  sh = sh / (1.0 + max(max(sh.r, sh.g), sh.b) * 0.6);
  gl_FragColor = vec4(c.rgb + sh, c.a);
}
`;

class ShaftPass extends Pass {
  constructor(camera, cfg, shadows, G) {
    super();
    this.camera = camera;
    this.cfg = cfg;
    this.shadows = shadows;
    this.needsSwap = true;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.rtA = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, opts);
    const L = shadows.lights;
    this.march = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: MARCH_FS,
      uniforms: {
        tDepth: { value: null },
        uSM0: { value: null }, uSM1: { value: null }, uSM2: { value: null },
        uSMat0: { value: L[0].shadow.matrix }, uSMat1: { value: (L[1] || L[0]).shadow.matrix }, uSMat2: { value: (L[2] || L[0]).shadow.matrix },
        uSplits: { value: new THREE.Vector3(shadows.splits[0] || 1e9, shadows.splits[1] || 1e9, shadows.splits[2] || 1e9) },
        uCascades: { value: Math.min(3, shadows.lights.length) },
        uProjInv: { value: camera.projectionMatrixInverse },
        uCamWorld: { value: camera.matrixWorld },
        uCamPos: { value: new THREE.Vector3() },
        uSunDir: G.uSunDir, uSunColor: G.uSunColor,
        uWeatherMap: G.uWeatherMap, uCloudOffset: G.uCloudOffset, uCloudCover: G.uCloudCover, uCloudShadow: G.uCloudShadow,
        uAmount: { value: 0 }, uScatter: { value: 0.002 },
        uMaxDist: { value: Math.min(cfg.dist, shadows.splits[shadows.splits.length - 1] || cfg.dist) },
        uSteps: { value: cfg.steps },
        uRes: { value: new THREE.Vector2(1, 1) },
      },
      depthTest: false, depthWrite: false,
    });
    this.blur = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: BLUR_FS,
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false,
    });
    this.comp = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: COMP_FS,
      uniforms: { tDiffuse: { value: null }, tShaft: { value: this.rtA.texture }, tDepth: { value: null }, uLowSize: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.2 }, uFar: { value: 24000 } },
      depthTest: false, depthWrite: false,
    });
    this.fsq = new FullScreenQuad(this.march);
    // stands in for a shadow map that has not been rendered yet (packed depth 1 = fully lit)
    this.dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.dummy.needsUpdate = true;
  }

  setSize(w, h) {
    const s = this.cfg.scale;
    const sw = Math.max(1, Math.round(w * s)), sh = Math.max(1, Math.round(h * s));
    this.rtA.setSize(sw, sh); this.rtB.setSize(sw, sh);
    this.march.uniforms.uRes.value.set(sw, sh);
    this.comp.uniforms.uLowSize.value.set(sw, sh);
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.march.uniforms;
    const L = this.shadows.lights;
    u.tDepth.value = readBuffer.depthTexture;
    const sm = (l) => (l && l.shadow.map ? l.shadow.map.texture : this.dummy);
    u.uSM0.value = sm(L[0]); u.uSM1.value = sm(L[1] || L[0]); u.uSM2.value = sm(L[2] || L[0]);
    u.uCamPos.value.setFromMatrixPosition(this.camera.matrixWorld);
    // march at reduced resolution
    renderer.setRenderTarget(this.rtA);
    this.fsq.material = this.march;
    this.fsq.render(renderer);
    // separable depth-aware blur
    const b = this.blur.uniforms;
    this.fsq.material = this.blur;
    b.tSrc.value = this.rtA.texture; b.uDir.value.set(1 / this.rtA.width, 0);
    renderer.setRenderTarget(this.rtB); this.fsq.render(renderer);
    b.tSrc.value = this.rtB.texture; b.uDir.value.set(0, 1 / this.rtA.height);
    renderer.setRenderTarget(this.rtA); this.fsq.render(renderer);
    // composite
    const cu = this.comp.uniforms;
    cu.tDiffuse.value = readBuffer.texture;
    cu.tDepth.value = readBuffer.depthTexture;
    cu.uNear.value = this.camera.near; cu.uFar.value = this.camera.far;
    this.fsq.material = this.comp;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsq.render(renderer);
  }
}

export class Post {
  constructor(renderer, scene, camera, q, shadows, G) {
    this.renderer = renderer;
    this.q = q;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: q.msaa || 0 });
    const useShafts = !!(q.shafts && shadows && shadows.n > 0);
    if (useShafts) rt.depthTexture = new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType);
    this.composer = new EffectComposer(renderer, rt);
    // the composer clones rt, and a cloned DepthTexture shares its image source, which three maps to the same GL
    // texture: without MSAA that becomes a read/write feedback loop. Give the second target its own depth texture.
    if (useShafts) this.composer.renderTarget2.depthTexture = new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType);
    this.composer.addPass(new RenderPass(scene, camera));
    if (useShafts) {
      this.shafts = new ShaftPass(camera, q.shafts, shadows, G);
      this.composer.addPass(this.shafts);
    }
    if (q.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.16, 0.55, 1.6);
      this.composer.addPass(this.bloom);
    }
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    if (q.fxaa) {
      this.fxaa = new ShaderPass(FXAAShader);
      this.composer.addPass(this.fxaa);
    }
  }

  setSize(w, h, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
    if (this.fxaa) this.fxaa.material.uniforms.resolution.value.set(1 / (w * pixelRatio), 1 / (h * pixelRatio));
  }

  // amount: sun light reaching the ground; scatter: haze coefficient (1/m); canopy: 0 open meadow .. 1 forest
  setShafts(amount, scatter, canopy) {
    if (!this.shafts) return;
    const k = amount * (0.12 + 0.88 * canopy);
    this.shafts.enabled = k > 0.02;
    this.shafts.march.uniforms.uAmount.value = k;
    this.shafts.march.uniforms.uScatter.value = scatter;
  }

  render(dt) {
    this.grade.uniforms.uTime.value += dt;
    this.composer.render(dt);
  }
}
