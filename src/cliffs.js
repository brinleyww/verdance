// Chasm cliff walls. The heightmap only holds a steep straight batter; this mesh sits just in front of it and
// carries the real rock: limestone beds with ledges and grooves, staggered joints, buttresses, a cracked lip that
// sinks into the rim, and slots where the waterfalls pour. Shared grid patches are displaced on the GPU, chunked
// along the chasm with four LODs; a JS mirror of the shape places the waterfalls and the blocks resting on ledges.
import * as THREE from 'three';
import { patch, G } from './shaderlib.js';
import { mulberry32 } from './noise.js';
import { CLIFF, NORTH_FALLS, chasmCentre } from './worldgen.js';

const CHUNK = 64;          // metres of wall per instance
const GROW = 2.5;          // row spacing growth: dense under the rim, coarse in the mist
const MARGIN = 1.0;        // metres in front of the terrain batter
const INV_SLOPE = 1 / CLIFF.slope;
const TIERS = {
  low: { cols: 32, rows: 96, lod: [45, 140, 400] },
  medium: { cols: 64, rows: 160, lod: [70, 200, 520] },
  high: { cols: 64, rows: 224, lod: [110, 300, 700] },
  ultra: { cols: 64, rows: 256, lod: [150, 420, 900] },
};

// ---------------------------------------------------------------- shared limestone
// World-space bedding shared by every rock surface, so a boulder, a ridge outcrop and the chasm wall at the same
// height carry the same beds. BED_GLSL needs only the noise texture (vertex or fragment); ROCK_GLSL adds uGround.
export const BED_GLSL = /* glsl */`
// beds 2-6 m thick, gently warped and dipping
float rockBedCoord(vec3 p) {
  vec4 a = textureLod(uNoiseTex, vec2(p.x * 0.0021, 0.61), 0.0);
  float yw = p.y + (a.r - 0.5) * 9.0 + (a.b - 0.5) * 2.0 + p.x * 0.004;
  vec4 t = textureLod(uNoiseTex, vec2(0.13, yw * 0.0047 + 0.5), 0.0);
  return yw / 3.2 + (t.g - 0.5) * 1.5;
}
// units of four beds: hard massive units stand proud, thin-bedded ones weather back
float rockUnitHard(float k) { return hash12(vec2(floor(k / 4.0), 3.0)); }
float rockBedOut(float k) { return smoothstep(0.3, 0.9, rockUnitHard(k)) * 3.4 + hash12(vec2(k, 7.0)) * 2.2; }
float rockGroove(float k) { return 0.5 + 1.1 * (1.0 - rockUnitHard(k)) * hash12(vec2(k, 11.0)); }
// how far a bed stands out (m) at bed coordinate bb; groove = 1 on a bedding plane
float rockStrata(float bb, out float groove) {
  float k = floor(bb), f = bb - k;
  float P = rockBedOut(k);
  float Qt = min(P, rockBedOut(k + 1.0)) - rockGroove(k);
  float Qb = min(P, rockBedOut(k - 1.0)) - rockGroove(k - 1.0);
  float top = smoothstep(0.88, 1.0, f), bot = 1.0 - smoothstep(0.0, 0.1, f);
  groove = max(top, bot);
  return mix(mix(P, Qt, top), Qb, bot);
}
`;

export const ROCK_GLSL = /* glsl */`
${BED_GLSL}
vec3 rockBedTint(float k) {
  float h1 = hash12(vec2(k, 7.0)), h2 = hash12(vec2(k, 23.0)), hu = rockUnitHard(k);
  vec3 c = mix(vec3(0.31, 0.29, 0.25), vec3(0.275, 0.27, 0.255), h2);
  c = mix(c, vec3(0.32, 0.255, 0.18), smoothstep(0.7, 0.95, hash12(vec2(floor(k / 4.0), 29.0))) * 0.6);
  c = mix(c, vec3(0.19, 0.185, 0.175), smoothstep(0.9, 0.995, h1) * 0.6);
  return c * mix(0.93, 1.05, hu);
}
// p world position, n world normal; returns albedo and a micro height for derivative bumps
vec3 limestone(vec3 p, vec3 n, out float hgt) {
  float bb = rockBedCoord(p);
  float k = floor(bb), f = bb - k;
  vec3 col = mix(rockBedTint(k), rockBedTint(k + 1.0), smoothstep(0.93, 1.0, f) * 0.5);
  vec3 w = pow(abs(n), vec3(4.0)); w /= w.x + w.y + w.z;
  vec4 t = texture(uGround, vec3(p.zy * 0.23, 1.0)) * w.x + texture(uGround, vec3(p.xz * 0.23, 1.0)) * w.y + texture(uGround, vec3(p.xy * 0.23, 1.0)) * w.z;
  vec4 t2 = texture(uGround, vec3(p.zy * 0.051 + 0.3, 1.0)) * w.x + texture(uGround, vec3(p.xz * 0.051 + 0.3, 1.0)) * w.y + texture(uGround, vec3(p.xy * 0.051 + 0.3, 1.0)) * w.z;
  float grain = dot(t.rgb, vec3(0.333)) / 0.33, grain2 = dot(t2.rgb, vec3(0.333)) / 0.33;
  col *= mix(1.0, grain, 0.15) * mix(1.0, grain2, 0.3);
  float hz = p.x + p.z;
  // grey weathered patina and fresher buff scars at the scale of whole slabs
  vec4 pn = texture(uNoiseTex, vec2(hz * 0.0071, p.y * 0.0093));
  col = mix(col, col * vec3(0.72, 0.75, 0.8), smoothstep(0.45, 0.7, pn.g) * 0.6);
  col = mix(col, col * vec3(1.14, 1.0, 0.84), smoothstep(0.62, 0.8, pn.r) * 0.5);
  // laminae inside each bed and a dark bedding plane at its base
  float lam = texture(uNoiseTex, vec2(hz * 0.0035, bb * 1.37)).b;
  col *= 0.92 + 0.16 * lam;
  float plane = 1.0 - smoothstep(0.0, 0.06, f);
  col *= 1.0 - plane * 0.4;
  // patchy water staining, rusty seeps, pale lichen
  float st = texture(uNoiseTex, vec2(hz * 0.083, p.y * 0.0042)).g;
  float st2 = texture(uNoiseTex, vec2(hz * 0.017 + 0.4, p.y * 0.0021)).r;
  float streak = smoothstep(0.58, 0.8, st) * smoothstep(0.58, 0.8, st2) * (1.0 - max(n.y, 0.0));
  col = mix(col, col * vec3(0.45, 0.45, 0.47), streak * 0.65);
  col = mix(col, col * vec3(1.1, 0.84, 0.62), smoothstep(0.66, 0.88, st2) * smoothstep(0.55, 0.85, 1.0 - st) * 0.5);
  float li = texture(uNoiseTex, vec2(hz * 0.13, p.y * 0.17)).b;
  col = mix(col, vec3(0.42, 0.43, 0.36), smoothstep(0.72, 0.86, li) * 0.3);
  // relief is derived per pixel, so it only takes smooth inputs (pixel-scale texture detail would turn into noise)
  hgt = t2.a * 0.5 - plane * 0.6 + lam * 0.2;
  // close up: grain at 1 m and 30 cm and angular joint cracks, each faded by the pixel footprint so nothing aliases
  float dcam = length(p - cameraPosition);
  if (dcam < 70.0) {
    float nearF = 1.0 - smoothstep(35.0, 70.0, dcam);
    float fp = length(fwidth(p));          // metres covered by one pixel
    float f3 = 1.0 - smoothstep(0.1, 0.3, fp), f4 = 1.0 - smoothstep(0.025, 0.07, fp);
    vec4 t3 = texture(uGround, vec3(p.zy * 0.93 + 0.7, 1.0)) * w.x + texture(uGround, vec3(p.xz * 0.93 + 0.7, 1.0)) * w.y + texture(uGround, vec3(p.xy * 0.93 + 0.7, 1.0)) * w.z;
    vec4 t4 = texture(uGround, vec3(p.zy * 3.1 + 0.2, 1.0)) * w.x + texture(uGround, vec3(p.xz * 3.1 + 0.2, 1.0)) * w.y + texture(uGround, vec3(p.xy * 3.1 + 0.2, 1.0)) * w.z;
    // joints: edges of a warped cellular pattern on the dominant face, so they run straight and meet at angles
    vec2 q = w.y > max(w.x, w.z) ? p.xz : (w.x > w.z ? p.zy : p.xy);
    q += (texture(uNoiseTex, q * 0.023).rg - 0.5) * 2.2;
    vec2 cx = q / 1.9, ci = floor(cx), cf = cx - ci;
    float d1 = 8.0, d2 = 8.0;
    vec2 g1 = vec2(0.0), g2 = vec2(0.0);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 r = g + hash22(ci + g) * 0.85 + 0.075 - cf;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; g2 = g1; d1 = d; g1 = g; } else if (d < d2) { d2 = d; g2 = g; }
    }
    float edge = sqrt(d2) - sqrt(d1);
    float fe = fwidth(edge);
    // only some cell borders are open joints, so cracks run as sparse lines instead of a paving pattern
    float open = step(0.62, hash12(ci * 2.0 + g1 + g2 + 17.0));
    float ck = open * (1.0 - smoothstep(0.012, 0.012 + fe * 1.5, edge)) * (1.0 - smoothstep(0.1, 0.3, fe));
    float g3 = dot(t3.rgb, vec3(0.333)) / 0.33, g4 = dot(t4.rgb, vec3(0.333)) / 0.33;
    // weathering: pale lichen rosettes and darker water-worn patches at the scale of a hand to a stride
    float lich = smoothstep(0.64, 0.8, texture(uNoiseTex, q * 0.41 + 0.2).r) * f3;
    float dark = smoothstep(0.58, 0.82, texture(uNoiseTex, q * 0.13 + 0.6).g);
    vec3 det = vec3(mix(1.0, g3, 0.22 * f3) * mix(1.0, g4, 0.1 * f4) * (1.0 - ck * 0.35) * (1.0 - dark * 0.18));
    col = mix(col, mix(col * det, vec3(0.5, 0.51, 0.44), lich * 0.3), nearF);
    float t3h = (texture(uGround, vec3(p.zy * 0.93 + 0.7, 1.0), 3.0) * w.x + texture(uGround, vec3(p.xz * 0.93 + 0.7, 1.0), 3.0) * w.y + texture(uGround, vec3(p.xy * 0.93 + 0.7, 1.0), 3.0) * w.z).a;
    hgt += (t3h - 0.5) * 0.35 * f3 * nearF;
  }
  return col;
}
`;

// ---------------------------------------------------------------- the rim edge (GPU), also used by the terrain
export const EDGE_GLSL = /* glsl */`
uniform sampler2D uCliffTex;
vec4 clRow(float x, float wall) {
  float f = clamp(x - (${CLIFF.x0.toFixed(1)}), 0.0, ${(CLIFF.n - 1.001).toFixed(3)});
  float i = floor(f);
  vec4 a = texelFetch(uCliffTex, ivec2(int(i), int(wall)), 0);
  vec4 b = texelFetch(uCliffTex, ivec2(int(i) + 1, int(wall)), 0);
  return mix(a, b, f - i);
}
// signed distance from the rim edge (negative = over the drop); only meaningful near the chasm
float cliffEdgeDist(vec2 xz) {
  float zc = -650.0 + 36.0 * sin(xz.x / 290.0) + 18.0 * sin(xz.x / 113.0 + 1.3);
  float wall = xz.y >= zc ? 0.0 : 1.0;
  float ze = clRow(xz.x, wall).x;
  return wall < 0.5 ? xz.y - ze : ze - xz.y;
}
`;

// ---------------------------------------------------------------- the wall shape (GPU)
export const SHAPE_GLSL = /* glsl */`
${EDGE_GLSL}
${BED_GLSL}
uniform vec4 uFalls[6];
uniform float uCliffE;
float clDep01(float s) { return (exp(${GROW.toFixed(2)} * s) - 1.0) / (exp(${GROW.toFixed(2)}) - 1.0); }
float clSlot(float x, float wall, float dep) {
  float slot = 0.0;
  for (int i = 0; i < 6; i++) {
    vec4 F = uFalls[i];
    if (abs(F.y - wall) < 0.5) {
      float hw = F.z * 0.5 * (1.0 + clamp(dep / 180.0, 0.0, 1.0) * 1.8) + 2.0;
      slot = max(slot, 1.0 - smoothstep(hw, hw + 5.0, abs(x - F.x)));
    }
  }
  return slot;
}
// displacement toward the chasm (m); info = (joint closeness 0 at a crack .. 1 clear, bed groove, slot, bed coordinate)
float clDisp(float x, float y, float dep, float wall, out vec4 info) {
  float bb = rockBedCoord(vec3(x, y, 0.0));
  float groove;
  float strata = rockStrata(bb, groove);
  // irregular joints: one candidate per 11 m cell and pair of beds, about 60% of them open, some wide chimneys
  float g = floor(bb / 2.0);
  vec4 b = textureLod(uNoiseTex, vec2(x * 0.0051 + 0.13, y * 0.0031 + 0.71), 0.0);
  float xs = x + (b.g - 0.5) * 6.0;
  float cell = floor(xs / 11.0);
  float jd = 99.0, jw = 0.6, jdepth = 0.0;
  for (int i = -1; i <= 1; i++) {
    float c = cell + float(i);
    if (hash12(vec2(c, g + 7.0)) < 0.6) {
      float d = abs(xs - (c + 0.15 + 0.7 * hash12(vec2(c, g))) * 11.0);
      if (d < jd) { jd = d; float hw = hash12(vec2(c, g + 13.0)); jw = mix(0.5, 2.6, hw * hw); jdepth = mix(0.9, 2.6, hw); }
    }
  }
  float joint = jdepth * (1.0 - smoothstep(0.0, jw, jd));
  // big blocky scars where slabs fell away, edged by beds and joints
  float mr = floor(bb / 6.0);
  float mc = floor(xs / 27.0 + hash12(vec2(mr, 43.0)));
  float mega = max((hash12(vec2(mc, mr + 41.0)) - 0.35) * 5.0, -1.5);
  // buttresses and alcoves
  vec4 c4 = textureLod(uNoiseTex, vec2(x * 0.005 + 0.37 + wall * 0.29, y * 0.0028 + 0.19), 0.0);
  float butt = 6.0 * smoothstep(0.38, 0.75, c4.r) * smoothstep(10.0, 80.0, dep);
  vec4 e = textureLod(uNoiseTex, vec2(x * 0.017 + 0.5, y * 0.023 + 0.3), 0.0);
  // metre-scale roughness, faded out on LODs too coarse to carry it
  float rough = (textureLod(uNoiseTex, vec2(x * 0.047 + 0.21, y * 0.061 + 0.4), 0.0).g - 0.5) * 1.6 * (1.0 - smoothstep(1.2, 3.0, uCliffE));
  float slot = clSlot(x, wall, dep);
  // near the rim the wall stays close to the edge line (a narrow lip, no bulge to look down on) and only leans
  // out gradually; the beds, joints and scars keep their relief at every depth
  float topF = smoothstep(0.0, 30.0, dep);
  float D = 0.3 + 2.9 * smoothstep(0.0, 60.0, dep) + (strata + mega - joint + rough - 1.5) * mix(0.15, 1.0, topF) + butt + (e.r - 0.5) * mix(0.3, 0.9, topF);
  D *= 1.0 - 0.9 * slot;
  D = 0.5 * (D - 0.5 + sqrt((D + 0.5) * (D + 0.5) + 0.36)) ;  // soft floor at -0.5
  info = vec4(clamp(jd / max(jw, 0.5), 0.0, 1.0), groove, slot, bb);
  return D;
}
float clZ(float x, float y, float wall, vec4 row) {
  vec4 info;
  float dep = max(row.y - y, 0.0);
  float side = wall < 0.5 ? 1.0 : -1.0;
  return row.x - side * (${MARGIN.toFixed(2)} + dep * ${INV_SLOPE.toFixed(5)} + clDisp(x, y, dep, wall, info));
}
float clCrag(float x, float wall, float slot) {
  vec4 n = textureLod(uNoiseTex, vec2(x * 0.019 + 0.77, wall * 0.5 + 0.11), 0.0);
  vec4 m = textureLod(uNoiseTex, vec2(x * 0.11 + 0.3, wall * 0.5 + 0.61), 0.0);
  return (0.22 * smoothstep(0.35, 0.85, n.g) + 0.08 * n.b + 0.12 * smoothstep(0.3, 0.8, m.r)) * (1.0 - slot);  // a low broken lip; the rim blocks carry the height
}
`;

const VS_PARS = /* glsl */`
attribute vec2 aChunk;
varying vec4 vCl;   // depth below rim, displacement, joint distance, slot
varying vec2 vCl2;  // lip (0 land side .. 1 face), bed groove
varying vec3 vWN;
${SHAPE_GLSL}
`;

const VS_MAIN = /* glsl */`
  float cx = aChunk.x + position.x;
  float cwall = aChunk.y;
  float cside = cwall < 0.5 ? 1.0 : -1.0;
  vec4 crow = clRow(cx, cwall);
  float cH = max(crow.y - crow.w, 10.0);
  float cs = position.y;
  vec3 pos;
  vec3 nrm;
  vec4 cinfo = vec4(1.0, 0.0, 0.0, 0.0);
  float cD = 0.0, cdep = 0.0, clip = 1.0;
  float cslot0 = clSlot(cx, cwall, 0.0);
  float ccrag = clCrag(cx, cwall, cslot0);
  vec3 up = vec3(0.0, 1.0, 0.0);
  // face normal from central differences of the wall surface z = Z(x, y)
  float yRef = cs >= 0.0 ? crow.y - cH * clDep01(cs) : crow.y - 0.5;
  float ce = uCliffE;
  float zx1 = clZ(cx + ce, yRef, cwall, clRow(cx + ce, cwall)), zx0 = clZ(cx - ce, yRef, cwall, clRow(cx - ce, cwall));
  float zy1 = clZ(cx, yRef + ce, cwall, crow), zy0 = clZ(cx, yRef - ce, cwall, crow);
  float Zx = (zx1 - zx0) / (2.0 * ce), Zy = (zy1 - zy0) / (2.0 * ce);
  vec3 faceN = normalize(cside * vec3(Zx, Zy, -1.0));
  if (cs < -2.5) {          // lip, buried under the grass 4.5 m back
    pos = vec3(cx, crow.z - 0.6, crow.x + cside * 4.5);
    nrm = up; clip = 0.0;
  } else if (cs < -1.5) {   // lip, just breaking the turf
    pos = vec3(cx, mix(crow.y, crow.z, 0.42) + 0.06 + ccrag * 0.12, crow.x + cside * 2.2);
    nrm = up; clip = 0.35;
  } else if (cs < -0.5) {   // lip, over the edge of the plateau
    pos = vec3(cx, crow.y + 0.05 + ccrag * 0.25, crow.x + cside * 0.5);
    nrm = normalize(up + faceN * 0.35); clip = 0.7;
  } else {                  // the face
    cdep = cH * clDep01(cs);
    float y = crow.y - cdep;
    cD = clDisp(cx, y, cdep, cwall, cinfo);
    float lift = (0.02 + ccrag * 0.15) * (1.0 - smoothstep(0.0, 1.5, cdep));  // the edge rolls over rather than rising
    pos = vec3(cx, y + lift, crow.x - cside * (${MARGIN.toFixed(2)} + cdep * ${INV_SLOPE.toFixed(5)} + cD));
    // the top row belongs to the flat lip; the corner turns between it and the next row down
    nrm = cs < 1e-6 ? normalize(up + faceN * 0.35) : normalize(faceN + up * (0.5 * (1.0 - smoothstep(0.3, 1.5, cdep))));
  }
  if (position.z > 0.5 && cs > 0.0) pos.z += cside * 3.0;  // skirt below the rim: hides T-junction cracks between LODs
  #ifdef CLIFF_DEPTH
  pos -= nrm * 0.3;  // shadow casters sit a little inside the rock: no self-shadow speckle on steep faces
  #endif
  // crevices, bedding grooves and canyon depth darken the sky light
  float ao = (0.5 + 0.5 * cinfo.x) * (1.0 - 0.35 * cinfo.y) * mix(1.0, 0.45, smoothstep(8.0, 170.0, cdep));
  vCl = vec4(cdep, cD, cinfo.x, cinfo.z);
  vCl2 = vec2(clip, cinfo.y);
  vWN = nrm;
`;

const FS_PARS = /* glsl */`
precision highp sampler2DArray;
// normals can interpolate to ~zero across a sharp ledge; a NaN pixel would spread through the bloom
vec3 clSafeN(vec3 v, vec3 fb) { float l = length(v); return l > 1e-4 ? v / l : fb; }
uniform sampler2DArray uGround;
varying vec4 vCl;
varying vec2 vCl2;
varying vec3 vWN;
vec3 gN;
${EDGE_GLSL}
${ROCK_GLSL}
`;

const FS_COLOR = /* glsl */`
{
  vec3 p = vWPos;
  vec3 n = clSafeN(vWN, vec3(0.0, 1.0, 0.0));
  float dep = vCl.x;
  float dist = length(p - cameraPosition);
  vec3 up = vec3(0.0, 1.0, 0.0);
  // beds stay crisp at every LOD: tilt the normal by the strata profile's slope, where the mesh is too coarse
  {
    float bb = rockBedCoord(p);
    float eps = max(0.03, fwidth(bb));
    float g0, g1;
    float dS = (rockStrata(bb + eps, g1) - rockStrata(bb - eps, g0)) / (2.0 * eps) / 3.2;
    float k = smoothstep(10.0, 70.0, dist) * (1.0 - abs(n.y)) * mix(0.35, 1.0, smoothstep(0.0, 8.0, dep)) * (1.0 - vCl.w);
    n = clSafeN(n - up * clamp(dS, -6.0, 6.0) * k, n);
  }
  float hgt;
  vec3 col = limestone(p, n, hgt);
  col *= mix(0.72, 1.0, vCl.z);   // the inside of cracks
  vec4 nz = texture(uNoiseTex, p.xz * 0.043 + p.y * 0.011);
  float ed = cliffEdgeDist(p.xz);
  // moss and grass on ledge tops, thickest under the rim and in the waterfall slots
  float upF = smoothstep(0.6, 0.9, n.y + (nz.r - 0.5) * 0.3);
  // patchy, never a carpet: the rim lip stays mostly bare pale rock
  float moss = upF * smoothstep(0.55, 0.8, nz.g) * mix(0.35, 0.9, 1.0 - smoothstep(0.0, 70.0, dep));
  moss = max(moss, vCl.w * smoothstep(0.3, 0.7, nz.g) * 0.8);
  vec3 mossCol = mix(vec3(0.06, 0.09, 0.025), vec3(0.12, 0.14, 0.045), nz.b);
  col = mix(col, mossCol, clamp(moss, 0.0, 1.0) * 0.85);
  // ivy and grass trailing down from the lip
  float hang = smoothstep(0.6, 0.8, texture(uNoiseTex, vec2((p.x + p.z) * 0.06, 0.37)).g) * (1.0 - smoothstep(0.5, 5.0 + nz.a * 9.0, dep)) * step(ed, 0.3);
  col = mix(col, vec3(0.05, 0.08, 0.025), hang * 0.8);
  // turf creeping over the land side of the lip
  vec4 tz = texture(uNoiseTex, p.xz * 0.11 + 0.5);
  float turf = smoothstep(1.3, 3.0, ed + (tz.g - 0.5) * 3.0) * smoothstep(0.6, 0.9, n.y);
  vec3 soil = mix(vec3(0.07, 0.085, 0.035), vec3(0.11, 0.13, 0.045), smoothstep(0.4, 0.7, tz.r));
  col = mix(col, soil, turf);
  gWet = clamp(uWetness * (0.5 + 0.5 * (1.0 - n.y)) + vCl.w * 0.85 + moss * 0.2, 0.0, 1.0);
  gSpec = 1.0 - moss * 0.6 - turf * 0.6;
  col *= 1.0 - gWet * 0.36;
  diffuseColor.rgb = col;
  gN = n;
  float bumpS = 0.09 * (1.0 - smoothstep(12.0, 70.0, dist)) * (1.0 - turf);
  float bumpR = 0.5 * smoothstep(3.0, 12.0, dist) * (1.0 - smoothstep(60.0, 180.0, dist)) * (1.0 - turf);
  if (bumpS + bumpR > 0.0) {
    vec2 fq = vec2(p.x + p.z, p.y);
    float rough = (texture(uNoiseTex, fq * 0.19).r * 0.6 + texture(uNoiseTex, fq * 0.53 + 0.3).g * 0.3) * (1.0 - abs(n.y));
    float Hh = hgt * bumpS + rough * bumpR;
    vec3 dpx = dFdx(p), dpy = dFdy(p);
    float hx = dFdx(Hh), hy = dFdy(Hh);
    vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det) * (hx * r1 + hy * r2);
    gN = clSafeN(abs(det) * n - grad, n);
  }
}
`;

function patchGeometry(cols, rows, wall) {
  // columns -1 and cols+1 are skirts; rows: 3 lip rows (codes -3..-1) then face rows s = i / rows
  const pos = [];
  const C = cols + 3, R = rows + 4;
  const span = CHUNK / cols;
  for (let r = 0; r < R; r++) {
    const s = r < 3 ? r - 3 : (r - 3) / rows;
    for (let c = -1; c <= cols + 1; c++) {
      const skirt = c < 0 || c > cols ? 1 : 0;
      pos.push(Math.min(Math.max(c, 0), cols) * span, s, skirt);
    }
  }
  const idx = [];
  for (let r = 0; r < R - 1; r++) {
    for (let c = 0; c < C - 1; c++) {
      const a = r * C + c, b = a + 1, d = a + C, e = d + 1;
      if (wall === 0) idx.push(a, b, d, b, e, d);
      else idx.push(a, d, b, b, d, e);
    }
  }
  const g = new THREE.InstancedBufferGeometry(); // a plain BufferGeometry would only ever draw instance 0
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

// waterfalls over the rim: the creek's own fall on the south wall and the springs on the north wall
export function fallList(world) {
  const falls = [];
  const pts = world.creek.filter((c) => world.chasmEdgeDist(c.x, c.z) > 1.5);
  const lip = pts[pts.length - 1];
  falls.push({ x: lip.x, z: lip.z, wall: 0, w: lip.width * 1.6, y: lip.water, creek: true });
  for (const [x, w] of NORTH_FALLS) {
    const row = world.cliffRow(x, 1);
    falls.push({ x, z: row[0] - 1.2, wall: 1, w, y: row[1] + 0.12, creek: false });
  }
  return falls;
}

export class Cliffs {
  constructor(world, q, tex) {
    this.world = world;
    const T = TIERS[q.name] || TIERS.medium;
    this.T = T;
    this.group = new THREE.Group();
    this.falls = fallList(world);
    const fallU = [];
    for (let i = 0; i < 6; i++) {
      const f = this.falls[i];
      fallU.push(f ? new THREE.Vector4(f.x, f.wall, f.w, 0) : new THREE.Vector4(1e6, 9, 0, 0));
    }
    const shared = { uCliffTex: { value: world.cliffTex }, uFalls: { value: fallU }, uGround: { value: tex.ground } };
    this.meshes = [[], []];
    this.lods = 4;
    for (let L = 0; L < this.lods; L++) {
      const cols = T.cols >> L, rows = T.rows >> L;
      const u = Object.assign({}, shared, { uCliffE: { value: Math.max(0.6, CHUNK / cols * 0.75) } });
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      patch(mat, { key: 'cliff', uniforms: u, wet: true, vertexPars: VS_PARS, vertexMain: VS_MAIN, fragmentPars: FS_PARS, fragmentColor: FS_COLOR, fragmentNormal: 'vec3 normal = normalize((viewMatrix * vec4(gN, 0.0)).xyz);', ao: '1.0' });
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      patch(depth, { key: 'cliffDepth', uniforms: u, defines: { CLIFF_DEPTH: '' }, vertexPars: VS_PARS, vertexMain: VS_MAIN });
      for (let wall = 0; wall < 2; wall++) {
        const g = patchGeometry(cols, rows, wall);
        const arr = new Float32Array(CLIFF.n / CHUNK * 2);
        const attr = new THREE.InstancedBufferAttribute(arr, 2);
        attr.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('aChunk', attr);
        g.instanceCount = 0;
        const mesh = new THREE.Mesh(g, mat);
        mesh.customDepthMaterial = depth;
        mesh.frustumCulled = false;
        mesh.castShadow = q.shadows > 0;
        mesh.receiveShadow = true;
        mesh.renderOrder = -12;
        this.group.add(mesh);
        this.meshes[wall].push({ mesh, attr, arr, n: 0 });
      }
    }
    // chunk bounds from the edge table
    this.chunks = [];
    const row = [0, 0, 0, 0];
    for (let wall = 0; wall < 2; wall++) {
      for (let c = 0; c < CLIFF.n / CHUNK; c++) {
        const x0 = CLIFF.x0 + c * CHUNK;
        let zmin = 1e9, zmax = -1e9, ymin = 1e9, ymax = -1e9;
        for (let x = x0; x <= x0 + CHUNK; x += 8) {
          world.cliffRow(x, wall, row);
          zmin = Math.min(zmin, row[0] - 45); zmax = Math.max(zmax, row[0] + 45);
          ymin = Math.min(ymin, row[3]); ymax = Math.max(ymax, row[1] + 3, row[2] + 3);
        }
        this.chunks.push({ wall, x0, box: new THREE.Box3(new THREE.Vector3(x0, ymin, zmin), new THREE.Vector3(x0 + CHUNK, ymax, zmax)) });
      }
    }
    this._frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._last = new THREE.Vector3(1e9, 0, 0);
    this._lastQ = new THREE.Quaternion();
    this.shape = new CliffShape(world, this.falls);
  }

  // blocks resting on ledges in the visible upper wall, appended to the world's rocks before Props reads them
  addLedgeRocks(count = 300) {
    const rnd = mulberry32(4242);
    const W = this.world;
    const add = [];
    for (const l of this.shape.findLedges(rnd, count)) {
      const s = Math.min(0.7 + rnd() * 1.8, l.step * 1.1);
      const sy = 0.45 + rnd() * 0.3, h = s * sy;
      add.push(l.x, l.y + h * 0.5, l.z, rnd() * 6.28, s * (0.8 + rnd() * 0.5), h, s * (0.8 + rnd() * 0.4), 4 + Math.floor(rnd() * 4));
    }
    const r = new Float32Array(W.rocks.length + add.length);
    r.set(W.rocks); r.set(add, W.rocks.length);
    W.rocks = r;
    this.ledgeRocks = add.length / 8;
  }

  update(camera) {
    const p = camera.position;
    if (p.distanceToSquared(this._last) < 1 && camera.quaternion.angleTo(this._lastQ) < 0.03) return;
    this._last.copy(p); this._lastQ.copy(camera.quaternion);
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m);
    for (const w of this.meshes) for (const l of w) l.n = 0;
    const lod = this.T.lod;
    for (const ch of this.chunks) {
      const d = ch.box.distanceToPoint(p);
      // near chunks stay even when off screen: they cast shadows into view
      if (d > 160 && !this._frustum.intersectsBox(ch.box)) continue;
      const L = d < lod[0] ? 0 : d < lod[1] ? 1 : d < lod[2] ? 2 : 3;
      const l = this.meshes[ch.wall][L];
      l.arr[l.n * 2] = ch.x0; l.arr[l.n * 2 + 1] = ch.wall; l.n++;
    }
    for (const w of this.meshes) {
      for (const l of w) {
        l.mesh.geometry.instanceCount = l.n;
        l.attr.clearUpdateRanges();
        l.attr.addUpdateRange(0, l.n * 2);
        l.attr.needsUpdate = true;
        l.mesh.visible = l.n > 0;
      }
    }
  }
}

// ---------------------------------------------------------------- JS mirror of the wall shape
const fract = (v) => v - Math.floor(v);
function hash12(px, py) {
  let x = fract(px * 0.1031), y = fract(py * 0.1031), z = fract(px * 0.1031);
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
  x += d; y += d; z += d;
  return fract((x + y) * z);
}
const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

export class CliffShape {
  constructor(world, falls) {
    this.world = world;
    this.falls = falls;
    const img = G.uNoiseTex.value.image;
    this.nd = img.data; this.ns = img.width;
    this._o = [0, 0, 0, 0];
    this._row = [0, 0, 0, 0];
  }
  // bilinear sample of the noise texture (level 0, repeat), like textureLod(..., 0.0)
  noise(u, v, out = this._o) {
    const S = this.ns, d = this.nd;
    const fx = u * S - 0.5, fy = v * S - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const x0 = ((ix % S) + S) % S, x1 = (x0 + 1) % S, y0 = ((iy % S) + S) % S, y1 = (y0 + 1) % S;
    for (let c = 0; c < 4; c++) {
      const a = d[(y0 * S + x0) * 4 + c], b = d[(y0 * S + x1) * 4 + c], e = d[(y1 * S + x0) * 4 + c], f = d[(y1 * S + x1) * 4 + c];
      out[c] = ((a * (1 - tx) + b * tx) * (1 - ty) + (e * (1 - tx) + f * tx) * ty) / 255;
    }
    return out;
  }
  slot(x, wall, dep) {
    let s = 0;
    for (const f of this.falls) {
      if (f.wall !== wall) continue;
      const hw = f.w * 0.5 * (1 + Math.min(Math.max(dep / 180, 0), 1) * 1.8) + 2;
      s = Math.max(s, 1 - smooth(hw, hw + 5, Math.abs(x - f.x)));
    }
    return s;
  }
  bedCoord(x, y) {
    const a = this.noise(x * 0.0021, 0.61);
    const yw = y + (a[0] - 0.5) * 9 + (a[2] - 0.5) * 2 + x * 0.004;
    const t = this.noise(0.13, yw * 0.0047 + 0.5);
    return yw / 3.2 + (t[1] - 0.5) * 1.5;
  }
  unitHard(k) { return hash12(Math.floor(k / 4), 3); }
  bedOut(k) { return smooth(0.3, 0.9, this.unitHard(k)) * 3.4 + hash12(k, 7) * 2.2; }
  groove(k) { return 0.5 + 1.1 * (1 - this.unitHard(k)) * hash12(k, 11); }
  strata(bb) {
    const k = Math.floor(bb), f = bb - k;
    const P = this.bedOut(k);
    const Qt = Math.min(P, this.bedOut(k + 1)) - this.groove(k);
    const Qb = Math.min(P, this.bedOut(k - 1)) - this.groove(k - 1);
    const top = smooth(0.88, 1, f), bot = 1 - smooth(0, 0.1, f);
    const m1 = P + (Qt - P) * top;
    return m1 + (Qb - m1) * bot;
  }
  disp(x, y, dep, wall) {
    const bb = this.bedCoord(x, y);
    const strata = this.strata(bb);
    const g = Math.floor(bb / 2);
    const b = this.noise(x * 0.0051 + 0.13, y * 0.0031 + 0.71);
    const xs = x + (b[1] - 0.5) * 6;
    const cell = Math.floor(xs / 11);
    let jd = 99, jw = 0.6, jdepth = 0;
    for (let i = -1; i <= 1; i++) {
      const c = cell + i;
      if (hash12(c, g + 7) < 0.6) {
        const d = Math.abs(xs - (c + 0.15 + 0.7 * hash12(c, g)) * 11);
        if (d < jd) { jd = d; const hw = hash12(c, g + 13); jw = 0.5 + 2.1 * hw * hw; jdepth = 0.9 + 1.7 * hw; }
      }
    }
    const joint = jdepth * (1 - smooth(0, jw, jd));
    const mr = Math.floor(bb / 6);
    const mc = Math.floor(xs / 27 + hash12(mr, 43));
    const mega = Math.max((hash12(mc, mr + 41) - 0.35) * 5, -1.5);
    const c4 = this.noise(x * 0.005 + 0.37 + wall * 0.29, y * 0.0028 + 0.19);
    const butt = 6 * smooth(0.38, 0.75, c4[0]) * smooth(10, 80, dep);
    const fine = (this.noise(x * 0.017 + 0.5, y * 0.023 + 0.3)[0] - 0.5) * 0.9; // noise() reuses its output array
    const rough = (this.noise(x * 0.047 + 0.21, y * 0.061 + 0.4)[1] - 0.5) * 1.6;
    const topF = smooth(0, 30, dep);
    let D = 0.3 + 2.9 * smooth(0, 60, dep) + (strata + mega - joint + rough - 1.5) * (0.15 + 0.85 * topF) + butt + fine * (0.3 + 0.6 * topF) / 0.9;
    D *= 1 - 0.9 * this.slot(x, wall, dep);
    return 0.5 * (D - 0.5 + Math.sqrt((D + 0.5) * (D + 0.5) + 0.36));
  }
  // world z of the wall surface at (x, y)
  faceZ(x, y, wall, withDisp = true) {
    const row = this.world.cliffRow(x, wall, this._row);
    const dep = Math.max(row[1] - y, 0);
    const side = wall === 0 ? 1 : -1;
    return row[0] - side * (MARGIN + dep * INV_SLOPE + (withDisp ? this.disp(x, y, dep, wall) : 0));
  }
  // flat ledge tops in the visible upper wall, for blocks to rest on
  findLedges(rnd, count, maxDepth = 70) {
    const out = [];
    const W = this.world;
    for (let tries = 0; tries < count * 30 && out.length < count; tries++) {
      const wall = rnd() < 0.5 ? 0 : 1;
      const x = -1000 + rnd() * 2000;
      const row = W.cliffRow(x, wall, this._row);
      const rim = row[1];
      const y = rim - 4 - rnd() * (maxDepth - 4);
      if (this.slot(x, wall, rim - y) > 0.05) continue;
      const side = wall === 0 ? 1 : -1;
      // a ledge: the wall steps out by > 0.9 m within 1.2 m going down, and stays out below
      const zA = this.faceZ(x, y + 0.3, wall), zB = this.faceZ(x, y - 0.9, wall);
      const step = (zA - zB) * side;
      if (step < 0.9) continue;
      const zB2 = this.faceZ(x, y - 2.0, wall);
      if (((zA - zB2) * side) < 0.9) continue;
      // walk down to the ledge top
      let yy = y + 0.3, zz = zA;
      for (let k = 1; k <= 8; k++) {
        const y2 = y + 0.3 - 0.15 * k, z2 = this.faceZ(x, y2, wall);
        yy = y2; zz = z2;
        if ((zA - z2) * side > step * 0.6) break;
      }
      out.push({ x, y: yy, z: zz + side * Math.min(step * 0.5, 1.0), wall, step });
    }
    return out;
  }
}
