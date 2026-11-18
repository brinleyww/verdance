// Sky: analytic atmosphere + volumetric cumulus raymarched into an amortised panorama.
import * as THREE from 'three';
import { G } from './shaderlib.js';

export const SKY_GLSL = /* glsl */`
uniform float uOvercast;
uniform float uSunIntensity;
uniform float uSkyBright;
// Analytic clear sky: Rayleigh-like gradient, warm low-sun horizon, twilight glow and a Mie aureole.
// Mirrored in skyRadianceJS() for fog and ambient colours, keep the two in step.
vec3 skyRadiance(vec3 rd) {
  float se = uSunDir.y;
  float yy = max(rd.y, 0.0);
  float mu = dot(rd, uSunDir);
  float m = max(mu, 0.0);
  float hi = smoothstep(-0.04, 0.42, se);
  vec3 zenith = mix(vec3(0.028, 0.065, 0.19), vec3(0.075, 0.2, 0.55), hi);
  vec3 horizon = mix(vec3(0.82, 0.6, 0.45), vec3(0.62, 0.74, 0.9), smoothstep(0.03, 0.4, se));
  vec3 col = mix(zenith, horizon, pow(1.0 - yy, 4.0));
  // low sun: orange band hugging the horizon on the sun side, pink belt opposite
  vec2 hd = rd.xz / max(length(rd.xz), 1e-4);
  vec2 sd = uSunDir.xz / max(length(uSunDir.xz), 1e-4);
  float az = dot(hd, sd) * 0.5 + 0.5;
  float low = (1.0 - smoothstep(0.0, 0.3, se)) * smoothstep(-0.16, -0.01, se);
  float band = pow(1.0 - yy, 9.0);
  col += vec3(1.0, 0.38, 0.1) * band * pow(az, 3.0) * low * 1.1;
  col += vec3(0.32, 0.18, 0.28) * band * (1.0 - az) * low * 0.35;
  // aureole (forward Mie) around the sun, weakened by cloud cover
  float w = 1.0 - smoothstep(0.02, 0.35, se);
  vec3 tint = vec3(1.0, mix(0.9, 0.55, w), mix(0.75, 0.25, w));
  col += tint * (pow(m, 12.0) * 0.09 + pow(m, 120.0) * 0.22 + pow(m, 1800.0) * 1.2) * (1.0 - uOvercast * 0.85) * smoothstep(-0.1, 0.02, se);
  // overcast: flat grey, a touch brighter overhead and where the sun hides
  vec3 grey = vec3(0.52, 0.55, 0.59) * (0.8 + 0.2 * yy) + pow(m, 5.0) * 0.14;
  col = mix(col, grey, uOvercast);
  if (rd.y < 0.0) col = mix(col, horizon * 0.8 * (1.0 - uOvercast * 0.3) + grey * uOvercast * 0.3, smoothstep(0.0, -0.08, rd.y));
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
  return clamp(1.0 - md * 1.6, 0.0, 1.0);
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
uniform float uStratus;
uniform vec3 uCloudSun;
uniform vec3 uAmbTop;
uniform vec3 uAmbBottom;
uniform vec2 uPanoSize;

const float R_EARTH = 6371000.0;
const float CU_B = 1500.0;   // cumulus base
const float CU_H = 1800.0;   // tallest cumulus
const float SIGMA = 0.03;

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
float HG(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5); }

float stB() { return mix(1150.0, 650.0, uStratus); }
float stT() { return stB() + mix(300.0, 1100.0, uStratus); }

// local coverage (x), tower potential (y) and a smooth large-scale coverage (z) from the weather map;
// x matches cloudShadowAt() on the ground
vec3 weatherAt(vec2 xz, bool lite) {
  vec2 wuv = (xz + uCloudOffset) / 15000.0;
  vec4 a = textureLod(uWeatherMap, wuv, 0.0);
  float cov = lite ? a.r * 0.7 + 0.15 : a.r * 0.7 + textureLod(uWeatherMap, wuv * 3.1 + 0.37, 0.0).g * 0.3;
  float c = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.3, cov);
  float big = lite ? 0.5 : textureLod(uWeatherMap, wuv * 0.35 + 0.17, 0.0).b;
  // cloud height must not follow the fine coverage: it changes across a single cloud and would pull the top
  // into a cone where coverage peaks, so heights come from the 15 km field only and stay level across a cloud
  float cL = smoothstep(1.0 - uCloudCover - 0.05, 1.0 - uCloudCover + 0.35, a.r * 0.7 + 0.15);
  return vec3(c, big, cL);
}

float gCel = 0.0;  // strength of the stratus cell at the last density() sample (set as a side effect)
float gDeck = 0.0; // 1 when the last density() sample came from the stratus deck
// density; hRel returns the height inside the cloud (0 base .. 1 top) for ambient shading
float density(vec3 p, float alt, bool detail, bool lite, out float hRel) {
  hRel = 0.5;
  vec3 w = weatherAt(p.xz, lite);
  vec3 wind = vec3(uCloudOffset.x, 0.0, uCloudOffset.y);
  float d = 0.0;
  // cumulus: flat base, small cells stay low and flat, dense cells tower; dome-shaped height profile
  float hc = (alt - CU_B) / CU_H;
  if (w.x > 0.001 && hc > 0.0 && hc < 1.0) {
    float c2 = w.z * w.z;
    float topF = (mix(0.13, 0.44, c2) + 0.5 * c2 * smoothstep(0.5, 0.8, w.y)) * mix(0.8, 1.0, uCloudCover);
    float r = hc / topF;
    if (r < 1.0) {
      // keeps its width most of the way up, then rounds off into a dome (a plain sqrt(1 - r^2) dome peaks again)
      float r2 = r * r;
      float prof = smoothstep(0.0, 0.05 / topF, r) * sqrt(max(1.0 - r2 * r, 0.0));
      vec4 n = textureLod(uNoise3D, (p + wind) / 4200.0, 0.0);
      float base = clamp(remap(n.r, n.g * 0.42 - 0.3, 1.0, 0.0, 1.0), 0.0, 1.0);
      base = base * base * (3.0 - 2.0 * base);
      float cov = w.x * mix(0.62, 1.0, uCloudCover);
      float sh = clamp(remap(base * prof, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0) * cov;
      if (sh > 0.0 && detail) {
        vec4 dn = textureLod(uNoise3D, (p + wind * 1.25) / 900.0 + vec3(0.0, uTime * 0.0025, 0.0), 0.0);
        // wispy at the base, billowy cauliflower towards the top
        float er = mix(dn.a, 1.0 - dn.g, clamp(r * 3.0, 0.0, 1.0));
        sh = clamp(remap(sh, er * 0.3, 1.0, 0.0, 1.0), 0.0, 1.0);
      }
      hRel = r;
      d = sh;
    }
  }
  // stratiform deck for overcast, rain and storm. Not a flat sheet: stratocumulus cells in rolls across the wind,
  // thick cores hanging lower and reading darker, thin seams between them where the light glows through; in rain
  // and storm the deck drops, thickens, frays and trails soft virga under the heavy cores
  float rag = smoothstep(0.55, 0.9, uCloudDark);
  float b0 = stB() - 140.0 * rag;
  // cheap altitude test first: the cell lookup below is only needed inside the deck's possible span
  // a very thin deck (cloudy weather) almost never forms: skip it rather than pay for lookups on every ray
  if (uStratus > 0.2 && alt < stT() && alt > b0 - 160.0 * uStratus - 50.0 - 170.0 * step(0.001, rag)) {
    vec3 sq = p + wind * 0.8;
    vec4 ce = textureLod(uNoise3D, vec3(sq.x / 3300.0 + sq.z / 9500.0, alt / 2600.0, sq.z / 2000.0), 0.0);
    float cel = smoothstep(0.22, 0.82, ce.g);
    gCel = max(gCel, cel);
    float base = b0 - cel * mix(70.0, 160.0, uStratus) - (ce.b - 0.5) * 100.0;
    float top = stT();
    float hs = (alt - base) / (top - base);
    if (hs > 0.0 && hs < 1.0) {
      float sp = smoothstep(0.0, 0.12, hs) * smoothstep(1.0, 0.45, hs);
      vec4 n2 = textureLod(uNoise3D, (p + wind * 0.7) * vec3(1.0 / 7000.0, 1.0 / 2200.0, 1.0 / 7000.0), 0.0);
      float cov = uStratus * mix(0.6, 1.0, w.x) * mix(0.7, 1.12, cel);
      float sb = clamp(remap(n2.r * sp, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0);
      if (sb > 0.0 && detail) {
        // ragged, undulating underside
        float dn = textureLod(uNoise3D, (p + wind) / 1300.0, 0.0).a;
        sb = clamp(remap(sb, dn * mix(0.5, 0.8, rag) * (1.0 - hs), 1.0, 0.0, 1.0), 0.0, 1.0);
      }
      sb *= 0.5 * uStratus * mix(0.7, 1.15, n2.a) * mix(0.45, 1.35, cel) * (1.0 + rag * 0.45);
      // ambient by absolute height in the deck, so the hanging cores sit in darker light than the seams
      float hA = clamp((alt - (b0 - 210.0)) / (top - b0 + 210.0), 0.0, 1.0);
      if (sb > d) { d = sb; hRel = hA * 0.8; gDeck = 1.0; }
    } else if (rag > 0.0 && alt < base && alt > base - 170.0) {
      // virga: soft streaks of rain hanging under the heavy cores
      float vz = (base - alt) / 170.0;
      float st = textureLod(uNoise3D, vec3(sq.x / 600.0, alt / 9000.0, sq.z / 600.0), 0.0).r;
      float vg = rag * cel * smoothstep(0.45, 0.8, st) * (1.0 - vz) * (1.0 - vz) * 0.08 * uStratus;
      if (vg > d) { d = vg; hRel = 0.0; gDeck = 1.0; }
    }
  }
  return d * uCloudDensity;
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (uPhases > 1.0) {
    float k = mod(float(c.x) + float(c.y) * 5.0, uPhases);
    if (abs(k - uPhase) > 0.5) discard;
  }
  vec3 rd = panoDir(vUv);
  vec3 ro = vec3(0.0, max(uCamPos.y, 0.0), 0.0);
  if (rd.y < 0.01 * (1.0 - uStratus)) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float rag0 = smoothstep(0.55, 0.9, uCloudDark);
  // start exactly at the deck's lowest possible point (hanging cores plus virga), never at or below the camera:
  // every metre of empty air below it costs march steps
  float lo = uStratus > 0.2 ? min(max(stB() - 140.0 * rag0 - 160.0 * uStratus - 50.0 - 170.0 * step(0.001, rag0), ro.y + 80.0), CU_B) : CU_B;
  float t0 = shellT(ro, rd, lo);
  float t1 = shellT(ro, rd, CU_B + CU_H);
  float maxT = 45000.0;
  if (t0 > maxT) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  t1 = min(min(t1, t0 + 14000.0), maxT);
  float len = t1 - t0;
  // coarse steps through empty air, fine steps inside clouds
  float coarse = clamp(len / uSteps, 50.0, 700.0);
  float fine = clamp(coarse * 0.45, 25.0, 160.0);
  // R2 low-discrepancy jitter: even in both axes, stable over time
  float jit = fract(0.5 + dot(gl_FragCoord.xy, vec2(0.7548776662, 0.5698402910)));
  float t = t0 + coarse * jit;
  float T = 1.0;
  vec3 S = vec3(0.0);
  float tw = 0.0, tsum = 0.0;
  float mu = dot(rd, uSunDir);
  vec3 sunC = uCloudSun * (1.0 - uCloudDark * 0.85);
  bool inCloud = false;
  int zeros = 0;
  int maxIt = int(uSteps) * 3;
  float hRel;
  for (int i = 0; i < 256; i++) {
    if (i >= maxIt || T < 0.03 || t > t1) break;
    vec3 p = ro + rd * t;
    float alt = altitude(p);
    if (!inCloud) {
      if (density(p, alt, false, false, hRel) > 0.0) { inCloud = true; zeros = 0; t = max(t0, t - coarse * 0.7); continue; }
      t += coarse;
      continue;
    }
    gCel = 0.0; gDeck = 0.0;
    float d = density(p, alt, true, false, hRel);
    float celHere = gCel, deckHere = gDeck;
    if (d > 0.0005) {
      zeros = 0;
      float ld = 0.0;
      if (deckHere > 0.5) {
        // inside the deck the sun's path runs up through the deck above: estimate it from the local cell
        // instead of marching it (as far as the light march would reach), so thin seams still glow
        float above = min(max(stT() - alt, 0.0) / max(uSunDir.y, 0.12), 440.0);
        ld = above * 0.32 * uStratus * uCloudDensity * mix(0.45, 1.35, celHere);
      } else {
        // light march toward the sun with growing steps
        float ls = 35.0, dum;
        vec3 lp = p;
        for (int j = 0; j < 8; j++) {
          if (float(j) >= uLightSteps) break;
          lp += uSunDir * ls;
          ld += density(lp, altitude(lp), false, true, dum) * ls;
          ls *= 1.85;
        }
      }
      // multiple-scattering approximation (three octaves) with a dual-lobe phase: silver lining near the sun
      float lum = 0.0;
      float aa = 1.0, bb = 1.0, cc = 1.0;
      for (int k = 0; k < 3; k++) {
        float ph = mix(HG(mu, 0.8 * cc), HG(mu, -0.3 * cc), 0.3);
        lum += aa * exp(-ld * SIGMA * bb) * ph;
        aa *= 0.5; bb *= 0.35; cc *= 0.5;
      }
      float ext = d * SIGMA;
      // powder: thin edges facing away from the sun look darker
      float powder = mix(1.0 - exp(-ext * 70.0), 1.0, 0.45 + 0.55 * max(mu, 0.0));
      vec3 amb = mix(uAmbBottom, uAmbTop, pow(clamp(hRel, 0.0, 1.0), 0.7)) * (1.0 - uCloudDark * 0.35);
      // thick deck cores are darker underneath, the thin seams between them lighter
      amb *= mix(1.12, 0.66, celHere * smoothstep(0.0, 0.3, uStratus));
      vec3 Ls = sunC * (lum * powder * 0.5) + amb;
      float Tr = exp(-ext * fine);
      float wgt = T * (1.0 - Tr);
      S += Ls * wgt;
      tw += t * wgt; tsum += wgt;
      T *= Tr;
    } else {
      zeros++;
      if (zeros > 5) inCloud = false;
    }
    // steps grow as the ray goes opaque: deep inside, little of what is left reaches the eye
    t += fine * (1.0 + (1.0 - T) * 1.4);
  }
  // aerial perspective on distant clouds
  float th = tsum > 0.0 ? tw / tsum : t0;
  float fade = 1.0 - exp(-th / 18000.0);
  vec3 haze = skyRadiance(normalize(vec3(rd.x, max(rd.y, 0.02), rd.z))) * (1.0 - uCloudDark * 0.3);
  S = mix(S, haze * (1.0 - T), fade * 0.9);
  T = mix(T, 1.0, fade * 0.3);
  // fair-weather clouds thin out at the horizon; an overcast deck runs right down into the haze, so no bright
  // strip of open sky shows under it
  float horizonFade = mix(smoothstep(0.01, 0.05, rd.y), smoothstep(0.0, 0.01, rd.y), uStratus);
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
uniform vec2 uPanoSize;
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
  vec4 cl = vec4(0.0, 0.0, 0.0, 1.0);
  if (rd.y > 0.0) {
    // tent filter over the panorama hides the last of the raymarch noise
    vec2 uv = dirToPano(rd);
    vec2 px = 0.6 / uPanoSize;
    cl = texture(uPano, uv) * 0.4
       + (texture(uPano, uv + vec2(px.x, px.y)) + texture(uPano, uv + vec2(-px.x, px.y))
        + texture(uPano, uv + vec2(px.x, -px.y)) + texture(uPano, uv + vec2(-px.x, -px.y))) * 0.15;
  }
  float mu = dot(rd, uSunDir);
  // sun disc with limb darkening; slightly larger than the real 0.27 deg so it reads on screen
  float sinR = 0.0068;
  float r = sqrt(max(1.0 - mu * mu, 0.0)) / sinR;
  float disc = mu > 0.0 ? smoothstep(1.0, 0.9, r) : 0.0;
  float limb = 1.0 - 0.55 * (1.0 - sqrt(max(1.0 - min(r * r, 1.0), 0.0)));
  vec3 sun = uSunColor * uSunIntensity * disc * limb * 38.0 * (1.0 - uOvercast * 0.9);
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
      uStratus: { value: 0 },
      uCloudSun: { value: new THREE.Color(3, 3, 3) },
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
      uniforms: Object.assign({}, G, this.uniforms, { uPano: { value: this.pano.texture }, uPanoSize: { value: new THREE.Vector2(pw, ph) } }),
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

// JS mirror of skyRadiance() for fog colour and ambient light (no aureole spike).
export function skyRadianceJS(dir, sunDir, overcast, bright, out) {
  const ss = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const se = sunDir.y, yy = Math.max(dir.y, 0);
  const m = Math.max(0, dir.x * sunDir.x + dir.y * sunDir.y + dir.z * sunDir.z);
  const hi = ss(-0.04, 0.42, se), hs = ss(0.03, 0.4, se);
  const zr = lerp(0.028, 0.075, hi), zg = lerp(0.065, 0.2, hi), zb = lerp(0.19, 0.55, hi);
  const hr = lerp(0.82, 0.62, hs), hg = lerp(0.6, 0.74, hs), hb = lerp(0.45, 0.9, hs);
  const g = Math.pow(1 - yy, 4);
  let r = lerp(zr, hr, g), gg = lerp(zg, hg, g), b = lerp(zb, hb, g);
  const hl = Math.hypot(dir.x, dir.z) || 1e-4, sl = Math.hypot(sunDir.x, sunDir.z) || 1e-4;
  const az = (dir.x * sunDir.x + dir.z * sunDir.z) / (hl * sl) * 0.5 + 0.5;
  const low = (1 - ss(0, 0.3, se)) * ss(-0.16, -0.01, se);
  const band = Math.pow(1 - yy, 9);
  const k1 = band * Math.pow(az, 3) * low * 1.1, k2 = band * (1 - az) * low * 0.35;
  r += 1.0 * k1 + 0.32 * k2; gg += 0.38 * k1 + 0.18 * k2; b += 0.1 * k1 + 0.28 * k2;
  const w = 1 - ss(0.02, 0.35, se);
  const glow = (Math.pow(m, 12) * 0.09 + Math.pow(m, 120) * 0.22) * (1 - overcast * 0.85) * ss(-0.1, 0.02, se);
  r += 1.0 * glow; gg += lerp(0.9, 0.55, w) * glow; b += lerp(0.75, 0.25, w) * glow;
  const gl = 0.8 + 0.2 * yy, gs = Math.pow(m, 5) * 0.14;
  r = lerp(r, 0.52 * gl + gs, overcast); gg = lerp(gg, 0.55 * gl + gs, overcast); b = lerp(b, 0.59 * gl + gs, overcast);
  out.setRGB(r * bright, gg * bright, b * bright);
  return out;
}
