// Geometry-clipmap terrain: nested rings that follow the camera, snapped and geomorphed so nothing swims.
import * as THREE from 'three';
import { patch, G } from './shaderlib.js';
import { ROCK_GLSL, BED_GLSL, EDGE_GLSL } from './cliffs.js';

// Steep ground is rock: the surface is pushed out and back by limestone beds (ledges, overhung lips, recessed
// soft bands), big crags and gullies. Evaluated from world position, so clipmap levels always agree.
const CRAG_GLSL = /* glsl */`
float cragMask(float ny, vec2 xz) {
  float m = smoothstep(0.34, 0.6, 1.0 - ny);
  // the chasm has its own cliff mesh
  float zc = -650.0 + 36.0 * sin(xz.x / 290.0) + 18.0 * sin(xz.x / 113.0 + 1.3);
  float hw = 118.0 + 16.0 * sin(xz.x / 210.0 + 0.7);
  return m * smoothstep(hw + 25.0, hw + 60.0, abs(xz.y - zc));
}
// outward relief (m); beds and crags weighted separately so distant LODs keep only what they can carry.
// hd = horizontal direction the face looks toward.
// joints and gullies along one fixed horizontal axis; callers blend the x and z versions by facing, which keeps the
// pattern a function of position only (a coordinate built from the per-pixel normal would swirl)
float cragJoint(float along, float bb, float y) {
  float jb = floor(bb / 2.0);
  float hr = hash12(vec2(jb, 5.0));
  // only some bed pairs are jointed into blocks, at their own spacing
  float jc = floor(along / (6.0 + 9.0 * hash12(vec2(jb, 9.0))) + hr);
  float blk = (hash12(vec2(jc, jb + 31.0)) - 0.5) * 1.6 * step(0.45, hr);
  float gully = abs(textureLod(uNoiseTex, vec2(along * 0.0028 + 0.2, y * 0.0005 + 0.53), 0.0).b - 0.5);
  return blk - (1.0 - smoothstep(0.0, 0.16, gully)) * 3.0;
}
float cragD(vec3 p, vec2 hd, float wBeds, float wCrag, out float groove) {
  float bb = rockBedCoord(p);
  float st = rockStrata(bb, groove);
  float wz = smoothstep(0.35, 0.65, abs(hd.x));   // facing +-x: the face runs along z
  float jt = mix(cragJoint(p.x, bb, p.y), cragJoint(p.z + 517.0, bb, p.y), wz);
  vec4 a = textureLod(uNoiseTex, vec2(p.x * 0.0061 + p.z * 0.0043, p.y * 0.0071 + 0.31), 0.0);
  vec4 b = textureLod(uNoiseTex, vec2((p.x + p.z) * 0.017, p.y * 0.023 + 0.77), 0.0);
  // some beds stand out strongly, others barely show
  float bedAmp = 0.35 + 0.9 * textureLod(uNoiseTex, vec2((p.x - p.z) * 0.0037 + 0.61, bb * 0.11), 0.0).r;
  float crag = (a.r - 0.5) * 8.0 + (b.g - 0.5) * 2.6;
  return ((st - 2.0) * 0.45 * bedAmp + jt) * wBeds + crag * wCrag;
}
`;

function ringGeometry(M, hole) {
  const pos = [];
  const idx = [];
  const W = 2 * M + 1;
  for (let j = -M; j <= M; j++) for (let i = -M; i <= M; i++) pos.push(i, 0, j);
  const h = M / 2 - 1;
  for (let j = -M; j < M; j++) {
    for (let i = -M; i < M; i++) {
      if (hole && i >= -h && i + 1 <= h && j >= -h && j + 1 <= h) continue;
      const a = (j + M) * W + (i + M), b = a + 1, c = a + W, d = c + 1;
      // alternate diagonals for a more even surface
      if (((i + j) & 1) === 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, c, d, a, d, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

export class Terrain {
  constructor(world, q, tex) {
    this.levels = q.terrainLevels;
    this.M = q.terrainM;
    this.base = q.terrainBase;
    this.group = new THREE.Group();
    this.meshes = [];
    const fullGeo = ringGeometry(this.M, false);
    const ringGeo = ringGeometry(this.M, true);
    const farTex = new THREE.DataTexture(world.far, world.farRes, world.farRes, THREE.RedFormat, THREE.FloatType);
    farTex.needsUpdate = true;
    const shared = {
      uFarTex: { value: farTex },
      uGround: { value: tex.ground },
      uGrassRadius: { value: q.grassRadius },
      uDetail: { value: q.terrainDetail },
      uCliffTex: { value: world.cliffTex },
    };
    this.shared = shared;
    for (let L = 0; L < this.levels; L++) {
      const s = this.base * Math.pow(2, L);
      const lu = {
        uLevelOrigin: { value: new THREE.Vector2() },
        uLevelScale: { value: s },
        uLevelHalf: { value: this.M * s },
      };
      const mat = makeTerrainMaterial(Object.assign({}, shared, lu), q);
      const mesh = new THREE.Mesh(L === 0 ? fullGeo : ringGeo, mat);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.userData.lu = lu;
      mesh.userData.scale = s;
      mesh.renderOrder = -10 + L; // near rings first for early-z
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
  }

  update(cam) {
    for (const m of this.meshes) {
      const s2 = m.userData.scale * 2;
      const o = m.userData.lu.uLevelOrigin.value;
      o.set(Math.round(cam.x / s2) * s2, Math.round(cam.z / s2) * s2);
    }
  }
}

function makeTerrainMaterial(uniforms, q) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  patch(mat, {
    key: 'terrain',
    uniforms,
    wet: true,
    defines: Object.assign({ EXTRA_SHADOW: '' }, q.terrainDetail > 1 ? { TERRAIN_HQ: '' } : {}),
    vertexPars: /* glsl */`
      uniform sampler2D uFarTex;
      uniform vec2 uLevelOrigin;
      uniform float uLevelScale;
      uniform float uLevelHalf;
      varying vec3 vTN;
      varying float vNear;
      varying float vCrag;
      ${BED_GLSL}
      ${CRAG_GLSL}
      ${EDGE_GLSL}
      float farHeight(vec2 xz) {
        float size = 16384.0, res = 512.0;
        vec2 f = (xz + size * 0.5) / (size / res) - 0.5;
        f = clamp(f, vec2(0.0), vec2(res - 1.001));
        ivec2 i = ivec2(floor(f));
        vec2 t = f - vec2(i);
        float a = texelFetch(uFarTex, i, 0).r, b = texelFetch(uFarTex, i + ivec2(1, 0), 0).r;
        float c = texelFetch(uFarTex, i + ivec2(0, 1), 0).r, d = texelFetch(uFarTex, i + ivec2(1, 1), 0).r;
        return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
      }
      float nearW(vec2 xz) {
        vec2 a = abs(xz);
        return 1.0 - smoothstep(uWorld.x * 0.5 - 70.0, uWorld.x * 0.5 - 12.0, max(a.x, a.y));
      }
      float worldHeight(vec2 xz) {
        float w = nearW(xz);
        float hf = farHeight(xz);
        if (w <= 0.0) return hf;
        return mix(hf, terrainHeight(xz), w);
      }
    `,
    vertexMain: /* glsl */`
      vec2 g = position.xz;
      vec2 wxz = uLevelOrigin + g * uLevelScale;
      vec2 dc = abs(wxz - uLevelOrigin) / uLevelHalf;
      float morph = smoothstep(0.74, 0.94, max(dc.x, dc.y));
      wxz -= mod(g, 2.0) * uLevelScale * morph;
      float hh = worldHeight(wxz);
      // at the chasm rim the 1 m grid cannot follow the wiggly edge: plateau triangles would poke out past it as
      // teeth through the rock lip. Under the lip the mesh sits a little lower, and anything past the edge drops
      // behind the cliff face.
      {
        float zc = -650.0 + 36.0 * sin(wxz.x / 290.0) + 18.0 * sin(wxz.x / 113.0 + 1.3);
        if (abs(wxz.y - zc) < 220.0) {
          float ed = cliffEdgeDist(wxz);
          if (ed < 6.0) hh -= 0.45 * (1.0 - smoothstep(3.0, 6.0, ed)) + max(-ed, 0.0) * 6.0;
        }
      }
      vec3 pos = vec3(wxz.x, hh, wxz.y);
      float e = max(uLevelScale, 8.0);
      vec3 nrm;
      vNear = nearW(wxz);
      if (vNear > 0.999) nrm = terrainNormal(wxz);
      else {
        float hx = worldHeight(wxz + vec2(e, 0.0)) - worldHeight(wxz - vec2(e, 0.0));
        float hz = worldHeight(wxz + vec2(0.0, e)) - worldHeight(wxz - vec2(0.0, e));
        nrm = normalize(vec3(-hx, 2.0 * e, -hz));
      }
      vTN = nrm;
      // rock faces: push the surface out along the slope's horizontal direction
      vCrag = cragMask(nrm.y, wxz);
      if (vCrag > 0.001) {
        float dc = length(pos - uCamPos);
        // bed and block steps stay mostly in the shading: the mesh only carries them close up, where vertices are dense
        float wB = 0.35 * (1.0 - smoothstep(30.0, 70.0, dc)), wC = 1.0 - smoothstep(500.0, 1100.0, dc);
        float gv;
        vec2 hd = normalize(nrm.xz + vec2(1e-5, 0.0));
        pos.xz += hd * cragD(pos, hd, wB, wC, gv) * vCrag;
      }
      float ao = 1.0;
    `,
    fragmentPars: /* glsl */`
      precision highp sampler2DArray;
      uniform sampler2DArray uGround;
      uniform float uGrassRadius;
      varying vec3 vTN;
      varying float vNear;
      varying float vCrag;
      vec4 tri(float layer, vec3 p, vec3 n, float scale) {
        vec3 w = pow(abs(n), vec3(4.0));
        w /= (w.x + w.y + w.z);
        return texture(uGround, vec3(p.zy * scale, layer)) * w.x
             + texture(uGround, vec3(p.xz * scale, layer)) * w.y
             + texture(uGround, vec3(p.xy * scale, layer)) * w.z;
      }
      vec4 layer2(float layer, vec2 p, float scale) {
        vec4 a = texture(uGround, vec3(p * scale, layer));
        #ifdef TERRAIN_HQ
        vec2 r = vec2(p.x * 0.8 - p.y * 0.6, p.x * 0.6 + p.y * 0.8);
        vec4 b = texture(uGround, vec3(r * scale * 0.43 + 0.31, layer));
        a = mix(a, b, 0.4);
        #endif
        return a;
      }
      vec3 gN;
      float gTerrainAO = 1.0;
      float gExtraShadow = 1.0;
      float gCragAO = 1.0;
      ${ROCK_GLSL}
      ${CRAG_GLSL}
    `,
    fragmentColor: /* glsl */`
      {
        vec3 p = vWPos;
        vec3 n = vNear > 0.5 ? normalize(mix(normalize(vTN), terrainNormal(p.xz), vNear)) : normalize(vTN);
        float slope = 1.0 - n.y;
        vec4 m = groundMask(p.xz) * vNear;
        float dist = length(p - cameraPosition);
        vec4 nz = texture(uNoiseTex, p.xz * 0.0021);
        vec4 nz2 = texture(uNoiseTex, p.xz * 0.023);
        // meadow: dark under-grass soil near, sun-bleached grass tops far away
        vec3 grassNear = mix(vec3(0.085, 0.11, 0.035), vec3(0.12, 0.13, 0.05), nz2.r);
        vec3 grassFar = mix(vec3(0.15, 0.21, 0.055), vec3(0.23, 0.25, 0.09), smoothstep(0.35, 0.75, nz.g));
        grassFar = mix(grassFar, vec3(0.12, 0.18, 0.05), smoothstep(0.5, 0.8, nz.r));
        grassFar += vec3(0.05, 0.045, 0.0) * smoothstep(0.62, 0.8, texture(uNoiseTex, p.xz * 0.006 + 0.3).g);
        float farMix = smoothstep(uGrassRadius * 0.55, uGrassRadius * 1.05, dist);
        vec3 meadow = mix(grassNear, grassFar, farMix);
        vec4 lit = layer2(0.0, p.xz, 0.31);
        // leaf litter: dry leaves are fairly bright (albedo ~0.1-0.2), the texture alone is too dark
        vec3 forest = lit.rgb * vec3(1.45, 1.32, 1.12);
        forest = mix(forest, forest * vec3(0.7, 0.9, 0.55), smoothstep(0.55, 0.8, nz2.g) * 0.6);
        vec4 dirt = layer2(3.0, p.xz, 0.38);
        vec4 peb = layer2(2.0, p.xz, 0.55);

        float canopy = m.r, grass = m.g, path = m.b, wet = m.a;
        vec3 col = mix(forest, meadow, clamp(grass * 1.25 + (1.0 - canopy) * 0.35, 0.0, 1.0));
        float hgt = mix(lit.a, 0.5, grass);
        col = mix(col, dirt.rgb, path); hgt = mix(hgt, dirt.a, path);
        float bank = smoothstep(0.55, 0.95, wet);
        col = mix(col, peb.rgb * 0.8, bank); hgt = mix(hgt, peb.a, bank);
        col = mix(col, col * vec3(0.72, 0.68, 0.62), wet * (1.0 - bank) * 0.6);

        // far terrain outside the near map: forested slopes, alpine meadows
        float fh = p.y;
        float forestF = smoothstep(0.45, 0.62, nz.r * 0.8 + nz.g * 0.4) * (1.0 - smoothstep(380.0, 520.0, fh));
        vec3 canopyCol = mix(vec3(0.045, 0.07, 0.025), vec3(0.08, 0.11, 0.04), nz2.r);
        vec3 alp = mix(vec3(0.20, 0.25, 0.08), vec3(0.28, 0.27, 0.12), nz.b);
        col = mix(mix(alp, canopyCol, forestF), col, vNear);

        float rockAmt = smoothstep(0.32, 0.55, slope + (nz2.b - 0.5) * 0.2);
        rockAmt = max(rockAmt, smoothstep(-20.0, -60.0, p.y));
        rockAmt = max(rockAmt, smoothstep(470.0, 560.0, p.y) * 0.85);
        if (rockAmt > 0.002) {
          // the relief's own normal: slopes of the displacement up the face and across it, sampled over at
          // least a pixel footprint so beds stay crisp up close and soft far away
          float cm = clamp(vCrag, 0.0, 1.0) * rockAmt;
          float groove = 0.0, cragHere = 0.0;
          if (cm > 0.002) {
            vec2 hd = normalize(n.xz + vec2(1e-5, 0.0));
            vec3 tdir = vec3(-hd.y, 0.0, hd.x);
            float eps = max(0.25, length(fwidth(p)) * 1.5);
            float g0;
            cragHere = cragD(p, hd, 1.0, 1.0, groove);
            float dDy = (cragD(p + vec3(0.0, eps, 0.0), hd, 1.0, 1.0, g0) - cragD(p - vec3(0.0, eps, 0.0), hd, 1.0, 1.0, g0)) / (2.0 * eps);
            float dDt = (cragD(p + tdir * eps, hd, 1.0, 1.0, g0) - cragD(p - tdir * eps, hd, 1.0, 1.0, g0)) / (2.0 * eps);
            vec3 pn = n - (vec3(0.0, 1.0, 0.0) * clamp(dDy, -5.0, 5.0) + tdir * clamp(dDt, -5.0, 5.0)) * cm;
            float pl = length(pn);
            if (pl > 1e-4) n = pn / pl;
            // ledges and crags shadow the rock below them: step toward the sun and see whether the relief there
            // stands out further than the ray has left the face
            float ldh = dot(uSunDir.xz, hd);
            float occ = 0.0;
            for (int i = 1; i <= 3; i++) {
              float t = float(i * i) * 0.9;
              occ = max(occ, cragD(p + uSunDir * t, hd, 1.0, 1.0, g0) - cragHere - ldh * t);
            }
            gExtraShadow = 1.0 - smoothstep(0.0, 0.9, occ) * cm;
            // recesses, gullies and the undersides of ledges see less sky
            gCragAO = mix(1.0, (0.5 + 0.5 * smoothstep(-6.0, 3.0, cragHere)) * (1.0 - groove * 0.3) * (0.75 + 0.25 * max(n.y, 0.0)), cm);
          }
          float rh;
          vec3 rc = limestone(p, n, rh);
          // crevices and recessed bands hold shadow, bed tops catch moss and grass
          rc *= mix(1.0, 0.78 * (1.0 - groove * 0.25) * mix(0.5, 1.0, smoothstep(-6.0, 3.0, cragHere)), cm);
          // weathered grey patina over most of the face; fresh pale rock only in patches
          rc = mix(rc, rc * vec3(0.72, 0.74, 0.78), smoothstep(0.35, 0.65, texture(uNoiseTex, p.xz * 0.011 + p.y * 0.007).r) * cm * 0.7);
          float ledge = smoothstep(0.55, 0.85, n.y) * cm * smoothstep(0.35, 0.65, texture(uNoiseTex, p.xz * 0.05 + p.y * 0.02).g);
          rc = mix(rc, mix(vec3(0.07, 0.1, 0.03), vec3(0.13, 0.15, 0.05), nz2.r), ledge * 0.85);
          col = mix(col, rc, rockAmt); hgt = mix(hgt, rh, rockAmt);
        }
        col = mix(col, vec3(0.10, 0.14, 0.04), rockAmt * canopy * smoothstep(0.6, 0.9, n.y) * 0.6);

        col *= 0.88 + 0.12 * nz.a + 0.12 * nz.r;
        gWet = uWetness * (0.55 + 0.45 * (1.0 - grass)) + bank * 0.6;
        col *= 1.0 - gWet * 0.38;
        gTerrainAO = (1.0 - canopy * 0.3) * mix(1.0, 0.8, grass * (1.0 - farMix)) * gCragAO;
        gSpec = 1.0 - grass * 0.8;
        diffuseColor.rgb = col;
        gN = n;
        #ifdef TERRAIN_HQ
        float bumpS = 0.07 * (1.0 - smoothstep(10.0, 45.0, dist)) * (1.0 - grass * 0.8);
        float H = hgt * bumpS;
        vec3 dpx = dFdx(p), dpy = dFdy(p);
        float hx = dFdx(H), hy = dFdy(H);
        vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
        float det = dot(dpx, r1);
        vec3 grad = sign(det) * (hx * r1 + hy * r2);
        gN = normalize(abs(det) * n - grad);
        #endif
      }
    `,
    fragmentNormal: /* glsl */`
      vec3 normal = normalize((viewMatrix * vec4(gN, 0.0)).xyz);
    `,
    ao: 'gTerrainAO',
  });
  return mat;
}
