// Built structures, all procedural: lattice relay towers, transmission line, chasm megastructure, bridge.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patch } from './shaderlib.js';
import { mulberry32 } from './noise.js';
import { SPHERE, chasmCentre, chasmHalfWidth } from './worldgen.js';

const Y = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3(1, 1, 1);

class Builder {
  constructor() { this.parts = []; }
  add(geo, matrix, color = [1, 1, 1]) {
    geo = geo.index ? geo : geo;
    if (matrix) geo.applyMatrix4(matrix);
    const n = geo.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set(color, i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    this.parts.push(geo);
    return this;
  }
  beam(a, b, w, h, color, roll = 0) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return this;
    const g = new THREE.BoxGeometry(w, len, h);
    g.translate(0, len / 2, 0);
    if (roll) g.rotateY(roll);
    _q.setFromUnitVectors(Y, d.normalize());
    _m.compose(a, _q, _s);
    return this.add(g, _m, color);
  }
  // L-angle profile steel member
  angle(a, b, w, t, color, roll = 0) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return this;
    const g1 = new THREE.BoxGeometry(w, len, t); g1.translate(0, len / 2, w / 2 - t / 2);
    const g2 = new THREE.BoxGeometry(t, len, w); g2.translate(w / 2 - t / 2, len / 2, 0);
    const g = mergeGeometries([g1, g2]);
    g.rotateY(roll);
    _q.setFromUnitVectors(Y, d.normalize());
    _m.compose(a, _q, _s);
    return this.add(g, _m, color);
  }
  cyl(a, b, r, seg, color, r2 = r) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    const g = new THREE.CylinderGeometry(r2, r, len, seg, 1, false);
    g.translate(0, len / 2, 0);
    _q.setFromUnitVectors(Y, d.normalize());
    _m.compose(a, _q, _s);
    return this.add(g, _m, color);
  }
  box(cx, cy, cz, w, h, d, color, ry = 0, uvScale = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (uvScale) {
      const uv = g.attributes.uv;
      const spans = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
      for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
        const i = f * 4 + k;
        uv.setXY(i, uv.getX(i) * spans[f][0] / uvScale, uv.getY(i) * spans[f][1] / uvScale);
      }
    }
    _q.setFromAxisAngle(Y, ry);
    _m.compose(new THREE.Vector3(cx, cy, cz), _q, _s);
    return this.add(g, _m, color);
  }
  build() {
    if (!this.parts.length) return new THREE.BufferGeometry();
    const parts = this.parts.map((g) => (g.index ? g.toNonIndexed() : g));
    const g = mergeGeometries(parts);
    g.computeBoundingSphere();
    return g;
  }
}

function steelMat(envMap, color = 0x9aa0a4, rough = 0.5) {
  const m = new THREE.MeshStandardMaterial({ color, metalness: 0.82, roughness: rough, vertexColors: true, envMap, envMapIntensity: 0.9 });
  patch(m, {
    key: 'steel' + color,
    fragmentColor: `
      {
        float streak = texture(uNoiseTex, vec2(vWPos.x * 0.05 + vWPos.z * 0.05, vWPos.y * 0.008)).g;
        float grime = smoothstep(4.0, 0.0, vWPos.y - terrainHeight(vWPos.xz)) * 0.35;
        diffuseColor.rgb *= mix(0.8, 1.08, streak) * (1.0 - grime);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.2, 0.12), smoothstep(0.62, 0.85, streak) * 0.25);
        diffuseColor.rgb *= 1.0 - uWetness * 0.25;
      }
    `,
  });
  return m;
}

function concreteMat(tex, envMap) {
  const m = new THREE.MeshStandardMaterial({ map: tex.concrete, roughness: 0.92, metalness: 0, vertexColors: true, envMap, envMapIntensity: 0.4 });
  patch(m, {
    key: 'concrete',
    fragmentColor: `
      {
        float n = texture(uNoiseTex, vWPos.xz * 0.01 + vWPos.y * 0.004).r;
        float rust = smoothstep(0.55, 0.9, texture(uNoiseTex, vec2(vWPos.x * 0.03 + vWPos.z * 0.03, vWPos.y * 0.0025)).g);
        diffuseColor.rgb *= mix(0.82, 1.08, n);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.24, 0.16), rust * 0.35);
        float moss = smoothstep(6.0, 0.0, vWPos.y - terrainHeight(vWPos.xz)) * 0.5;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.18, 0.08), moss * n);
        diffuseColor.rgb *= 1.0 - uWetness * 0.3;
      }
    `,
  });
  return m;
}

function makeWireMaterial() {
  // keeps thin cables at least ~1 px wide at any distance (no shimmering gaps)
  const m = new THREE.MeshStandardMaterial({ color: 0x2b2d2f, metalness: 0.7, roughness: 0.55 });
  patch(m, {
    key: 'wire',
    vertexPars: 'attribute vec3 aCenter; uniform float uPixelAngle;',
    vertexMain: `
      float dd = length(aCenter - cameraPosition);
      vec3 dir = position - aCenter;
      float r = length(dir);
      float rr = max(r, dd * uPixelAngle * 0.75);
      vec3 pos = aCenter + dir / max(r, 1e-5) * rr;
      vec3 nrm = normal;
      float ao = 1.0;
    `,
    uniforms: { uPixelAngle: { value: 0.0012 } },
  });
  return m;
}

function wireGeometry(curves, radius) {
  const parts = [];
  for (const pts of curves) {
    const curve = new THREE.CatmullRomCurve3(pts);
    const segs = Math.max(8, pts.length * 2);
    const g = new THREE.TubeGeometry(curve, segs, radius, 5, false);
    const center = new Float32Array(g.attributes.position.count * 3);
    const radial = 6;
    for (let i = 0; i <= segs; i++) {
      const p = curve.getPointAt(i / segs);
      for (let j = 0; j < radial; j++) center.set([p.x, p.y, p.z], (i * radial + j) * 3);
    }
    g.setAttribute('aCenter', new THREE.BufferAttribute(center, 3));
    g.deleteAttribute('uv');
    parts.push(g);
  }
  return mergeGeometries(parts);
}

function catenary(a, b, sag, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = new THREE.Vector3().lerpVectors(a, b, t);
    p.y -= sag * 4 * t * (1 - t);
    pts.push(p);
  }
  return pts;
}

// ------------------------------------------------------------------ lattice tower
function latticeTower(B, o, rot, opts) {
  const { height, baseW, topW, taperTo, panels, color } = opts;
  const rnd = mulberry32(opts.seed || 1);
  const R = new THREE.Matrix4().makeRotationY(rot).setPosition(o);
  const P = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(R);
  const halfAt = (y) => (y < taperTo ? baseW / 2 + (topW / 2 - baseW / 2) * (y / taperTo) : topW / 2);
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  const ys = panels;
  // legs
  for (const [cx, cz] of corners) {
    for (let k = 0; k < ys.length - 1; k++) {
      const y0 = ys[k], y1 = ys[k + 1];
      const h0 = halfAt(y0), h1 = halfAt(y1);
      B.angle(P(cx * h0, y0, cz * h0), P(cx * h1, y1, cz * h1), 0.22 * (1 - y0 / height * 0.5), 0.022, color, Math.atan2(-cx, -cz) - Math.PI / 4 + rot);
    }
  }
  // girts + bracing
  for (let k = 0; k < ys.length; k++) {
    const y = ys[k], h = halfAt(y);
    for (let c = 0; c < 4; c++) {
      const [ax, az] = corners[c], [bx, bz] = corners[(c + 1) % 4];
      B.angle(P(ax * h, y, az * h), P(bx * h, y, bz * h), 0.1, 0.012, color);
      if (k < ys.length - 1) {
        const y1 = ys[k + 1], h1 = halfAt(y1);
        B.angle(P(ax * h, y, az * h), P(bx * h1, y1, bz * h1), 0.085, 0.01, color);
        B.angle(P(bx * h, y, bz * h), P(ax * h1, y1, az * h1), 0.085, 0.01, color);
      }
    }
    // plan bracing every few panels
    if (k % 3 === 1) {
      B.angle(P(h, y, h), P(-h, y, -h), 0.07, 0.01, color);
      B.angle(P(-h, y, h), P(h, y, -h), 0.07, 0.01, color);
    }
  }
  return { P, halfAt };
}

function relayTower(B, Bc, o, rot, seed) {
  const steel = [0.95, 0.95, 0.95];
  const H = 34;
  const panels = [0, 3.6, 6.9, 9.9, 12.6, 15.1, 17.4, 19.5, 21.5, 23.4, 25.2, 27.0, 28.8, 30.6, 32.3, 34];
  const { P, halfAt } = latticeTower(B, o, rot, { height: H, baseW: 6.2, topW: 1.5, taperTo: 27, panels, color: steel, seed });
  // platform + railing
  const top = H;
  const h = 1.4;
  for (const [x0, z0, x1, z1] of [[-h, -h, h, -h], [h, -h, h, h], [h, h, -h, h], [-h, h, -h, -h]]) {
    B.beam(P(x0, top + 1.05, z0), P(x1, top + 1.05, z1), 0.05, 0.05, steel);
    B.beam(P(x0, top + 0.55, z0), P(x1, top + 0.55, z1), 0.04, 0.04, steel);
    B.beam(P(x0, top, z0), P(x0, top + 1.05, z0), 0.05, 0.05, steel);
  }
  const plat = new THREE.BoxGeometry(2.8, 0.08, 2.8);
  B.add(plat, new THREE.Matrix4().makeRotationY(rot).setPosition(P(0, top, 0)), [0.7, 0.7, 0.7]);
  // antenna masts + dishes
  for (const [x, z, len] of [[0.9, 0.9, 7], [-0.9, -0.9, 5.5], [0.9, -0.9, 4]]) B.cyl(P(x, top, z), P(x, top + len, z), 0.05, 6, steel, 0.035);
  B.cyl(P(0, top, 0), P(0, top + 9.5, 0), 0.03, 5, steel, 0.012);
  const dish = (y, ang) => {
    const dir = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang)).applyAxisAngle(Y, rot);
    const c = P(0, y, 0).addScaledVector(dir, halfAt(y) + 0.55);
    const g = new THREE.CylinderGeometry(0.85, 0.85, 0.55, 20, 1);
    g.rotateX(Math.PI / 2);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, Y).setPosition(c);
    B.add(g, m, [0.82, 0.83, 0.84]);
    const face = new THREE.CircleGeometry(0.84, 20);
    const fm = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir.clone().negate(), Y).setPosition(c.clone().addScaledVector(dir, 0.28));
    Bc.add(face, fm, [1.25, 1.25, 1.22]);
    B.beam(c.clone().addScaledVector(dir, -0.3), P(0, y, 0).addScaledVector(dir, halfAt(y)), 0.08, 0.08, steel);
  };
  dish(29.5, 0.6); dish(26.2, 2.4);
  // ladder up one face
  const lh = halfAt(0);
  for (let s = 0; s < 2; s++) {
    const off = s ? 0.22 : -0.22;
    for (let k = 0; k < panels.length - 1; k++) {
      const y0 = panels[k], y1 = panels[k + 1];
      B.beam(P(halfAt(y0) + 0.35, y0, off), P(halfAt(y1) + 0.35, y1, off), 0.03, 0.05, steel);
    }
  }
  for (let y = 0.4; y < top; y += 0.45) B.beam(P(halfAt(y) + 0.35, y, -0.22), P(halfAt(y) + 0.35, y, 0.22), 0.022, 0.022, steel);
  // cable tray from the cabinet to the tower
  // footings
  for (const [cx, cz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) Bc.box(P(cx * lh, 0, cz * lh).x, o.y + 0.15, P(cx * lh, 0, cz * lh).z, 1.3, 0.9, 1.3, [1, 1, 1], rot, 2);
  return { top: P(0, top + 9.6, 0), P };
}

function transmissionPylon(B, o, rot) {
  const c = [0.78, 0.8, 0.82];
  const H = 44;
  const panels = [0, 4.5, 8.6, 12.4, 15.9, 19.1, 22.0, 24.7, 27.2, 29.5, 31.8, 34, 36.2, 38.4, 40.4, 42.2, 44];
  const { P, halfAt } = latticeTower(B, o, rot, { height: H, baseW: 8, topW: 1.8, taperTo: 30, panels, color: c, seed: 3 });
  const arms = [];
  for (const [y, len] of [[29.5, 8.5], [36.2, 6.2]]) {
    for (const s of [-1, 1]) {
      const h = halfAt(y);
      const tip = P(s * len, y, 0);
      B.angle(P(s * h, y, h), tip, 0.1, 0.012, c);
      B.angle(P(s * h, y, -h), tip, 0.1, 0.012, c);
      B.angle(P(s * h, y + 2.2, h * 0.9), tip, 0.08, 0.01, c);
      B.angle(P(s * h, y + 2.2, -h * 0.9), tip, 0.08, 0.01, c);
      // insulator string
      const ins = P(s * (len - 0.3), y - 0.1, 0);
      const end = P(s * (len - 0.3), y - 3.0, 0);
      B.cyl(end, ins, 0.12, 8, [0.45, 0.5, 0.45], 0.12);
      arms.push(end);
    }
  }
  const peak = P(0, H + 2.5, 0);
  B.beam(P(0, H, 0), peak, 0.12, 0.12, c);
  return { arms, peak };
}

// ------------------------------------------------------------------ main class
export class Structures {
  constructor(world, q, tex, envMap) {
    this.group = new THREE.Group();
    this.relays = [];
    this.lights = [];
    const B = new Builder();      // galvanised steel
    const Bc = new Builder();     // concrete + painted parts
    const Bd = new Builder();     // darker steel (pylons, megastructure)
    const Bp = new Builder();     // painted cabinets
    const wires = [];
    const rnd = mulberry32(5);

    // relay towers
    for (const r of world.relays) {
      const rot = rnd() * Math.PI * 2;
      const o = new THREE.Vector3(r.x, r.y - 0.05, r.z);
      const t = relayTower(B, Bc, o, rot, r.id + 1);
      // slab + cabinet
      const fwd = new THREE.Vector3(Math.sin(rot), 0, Math.cos(rot));
      const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
      const cab = o.clone().addScaledVector(fwd, 6.2);
      cab.y = world.heightAt(cab.x, cab.z);
      Bc.box(cab.x, cab.y + 0.08, cab.z, 2.6, 0.35, 1.9, [1, 1, 1], rot, 2);
      Bp.box(cab.x, cab.y + 1.12, cab.z, 1.3, 1.8, 0.75, [0.56, 0.58, 0.55], rot);
      Bp.box(cab.x, cab.y + 2.06, cab.z, 1.42, 0.08, 0.86, [0.7, 0.72, 0.7], rot);
      const front = cab.clone().addScaledVector(fwd, 0.39);
      Bp.box(front.x, cab.y + 1.12, front.z, 0.012, 1.6, 0.01, [0.3, 0.3, 0.3], rot + Math.PI / 2);
      const handle = front.clone().addScaledVector(side, 0.45);
      Bp.box(handle.x, cab.y + 1.1, handle.z, 0.04, 0.22, 0.05, [0.25, 0.25, 0.25], rot);
      for (let k = 0; k < 4; k++) {
        const vent = front.clone().addScaledVector(side, -0.3);
        Bp.box(vent.x, cab.y + 0.45 + k * 0.06, vent.z, 0.4, 0.02, 0.02, [0.35, 0.35, 0.35], rot);
      }
      // cable tray to the tower
      const trayStart = cab.clone().addScaledVector(fwd, -0.38); trayStart.y += 1.9;
      const trayEnd = o.clone().addScaledVector(fwd, 2.2); trayEnd.y += 2.4;
      B.beam(trayStart, trayEnd, 0.3, 0.06, [0.85, 0.85, 0.85]);
      B.beam(trayStart.clone().setY(cab.y), trayStart, 0.06, 0.06, [0.85, 0.85, 0.85]);
      // fence around the tower with a gate gap facing the cabinet
      const F = 9.5;
      const fenceCorners = [[-F, -F], [F, -F], [F, F], [-F, F]].map(([x, z]) => o.clone().addScaledVector(side, x).addScaledVector(fwd, z));
      const fenceSegs = [];
      for (let s = 0; s < 4; s++) {
        const a = fenceCorners[s], b = fenceCorners[(s + 1) % 4];
        const len = a.distanceTo(b);
        const n = Math.ceil(len / 2.5);
        for (let k = 0; k <= n; k++) {
          const p = a.clone().lerp(b, k / n);
          const along = p.clone().sub(o);
          const isGate = s === 2 && Math.abs(along.dot(side)) < 1.6;
          if (isGate && k > 0 && k < n) continue;
          p.y = world.heightAt(p.x, p.z);
          B.cyl(p.clone().setY(p.y - 0.3), p.clone().setY(p.y + 2.2), 0.035, 6, [0.8, 0.82, 0.83]);
        }
        fenceSegs.push([a, b, s === 2]);
      }
      this.buildFence(fenceSegs, world, o, side, tex);
      for (const [a, b, gate] of fenceSegs) {
        const len = a.distanceTo(b);
        for (let d = 0; d <= len; d += 0.9) {
          const p = a.clone().lerp(b, d / len);
          if (gate && Math.abs(p.clone().sub(o).dot(side)) < 1.6) continue;
          world.addCollider(p.x, p.z, 0.25);
        }
      }
      for (const [cx, cz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
        const lp = o.clone().addScaledVector(side, cx * 3.1).addScaledVector(fwd, cz * 3.1);
        world.addCollider(lp.x, lp.z, 0.6);
      }
      world.addCollider(cab.x, cab.z, 0.85);
      const light = this.addBeacon(t.top, 0.32);
      const lamp = this.addLamp(front.clone().addScaledVector(side, -0.42).setY(cab.y + 1.75), rot);
      this.relays.push({ ...r, rot, cabinet: front.clone().setY(cab.y + 1.1), standAt: front.clone().addScaledVector(fwd, 1.7).setY(cab.y), light, lamp, active: false, top: t.top });
    }

    // transmission line
    const pyl = world.power.map((p, i) => {
      const next = world.power[Math.min(i + 1, world.power.length - 1)], prev = world.power[Math.max(i - 1, 0)];
      const rot = Math.atan2(next.x - prev.x, next.z - prev.z) + Math.PI / 2;
      const o = new THREE.Vector3(p.x, p.y - 0.2, p.z);
      for (const [cx, cz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
        const lp = new THREE.Vector3(cx * 4, 0, cz * 4).applyAxisAngle(Y, rot).add(o);
        Bc.box(lp.x, world.heightAt(lp.x, lp.z) + 0.2, lp.z, 1.4, 1.0, 1.4, [1, 1, 1], rot, 2);
        world.addCollider(lp.x, lp.z, 0.7);
      }
      return transmissionPylon(Bd, o, rot);
    });
    for (let i = 0; i < pyl.length - 1; i++) {
      const a = pyl[i], b = pyl[i + 1];
      for (let k = 0; k < a.arms.length; k++) {
        const span = a.arms[k].distanceTo(b.arms[k]);
        wires.push(catenary(a.arms[k], b.arms[k], span * 0.035, 28));
      }
      wires.push(catenary(a.peak, b.peak, a.peak.distanceTo(b.peak) * 0.03, 28));
    }

    // chasm megastructure
    this.buildMegastructure(world, Bc, Bd, wires);

    // distant towers beyond the chasm
    const far = [[-620, -1650, 330], [180, -2050, 420], [880, -1480, 260], [-1350, -2350, 380], [1450, -2700, 450]];
    for (const [x, z, h] of far) {
      const y = world.heightAt(x, z) - 5;
      const w = 16 + h * 0.025;
      Bc.box(x, y + h / 2, z, w, h, w, [0.9, 0.9, 0.92], 0.3, 6);
      Bc.box(x, y + h + 6, z, w * 1.3, 12, w * 1.3, [0.75, 0.75, 0.78], 0.3, 6);
      Bc.box(x, y + h * 0.62, z, w * 1.12, 4, w * 1.12, [0.7, 0.7, 0.72], 0.3, 6);
      this.addBeacon(new THREE.Vector3(x, y + h + 13, z), 2.2, true);
    }

    this.buildBridge(world, tex);

    const steel = steelMat(envMap);
    const dark = steelMat(envMap, 0x7c8186, 0.58);
    const conc = concreteMat(tex, envMap);
    const paint = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.1, vertexColors: true, envMap, envMapIntensity: 0.6 });
    patch(paint, { key: 'paint', fragmentColor: `
      {
        float g = texture(uNoiseTex, vec2(vWPos.x + vWPos.z, vWPos.y * 3.0) * 0.35).g;
        float low = smoothstep(0.9, 0.0, vWPos.y - terrainHeight(vWPos.xz));
        diffuseColor.rgb *= mix(0.85, 1.05, g) * (1.0 - low * 0.35);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.22, 0.15), smoothstep(0.7, 0.9, g) * 0.3);
      }
    ` });
    const add = (geo, mat) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = q.shadows > 0; m.receiveShadow = true;
      this.group.add(m);
      return m;
    };
    add(B.build(), steel);
    add(Bd.build(), dark);
    add(Bc.build(), conc);
    add(Bp.build(), paint);
    const wm = makeWireMaterial();
    this.wireMat = wm;
    const wmesh = new THREE.Mesh(wireGeometry(wires, 0.035), wm);
    wmesh.castShadow = false; wmesh.receiveShadow = true;
    this.group.add(wmesh);
    this.materials = [steel, dark, conc, paint, wm];
  }

  buildFence(segs, world, o, side, tex) {
    const pos = [], uv = [];
    for (const [a, b, gate] of segs) {
      const len = a.distanceTo(b);
      const n = Math.ceil(len / 1.25);
      for (let k = 0; k < n; k++) {
        const p0 = a.clone().lerp(b, k / n), p1 = a.clone().lerp(b, (k + 1) / n);
        if (gate && (Math.abs(p0.clone().sub(o).dot(side)) < 1.6 || Math.abs(p1.clone().sub(o).dot(side)) < 1.6)) continue;
        const y0 = world.heightAt(p0.x, p0.z), y1 = world.heightAt(p1.x, p1.z);
        const u0 = k * 1.25 / 0.9, u1 = (k + 1) * 1.25 / 0.9;
        pos.push(p0.x, y0 + 0.05, p0.z, p1.x, y1 + 0.05, p1.z, p0.x, y0 + 2.1, p0.z, p1.x, y1 + 0.05, p1.z, p1.x, y1 + 2.1, p1.z, p0.x, y0 + 2.1, p0.z);
        uv.push(u0, 0, u1, 0, u0, 2.2, u1, 0, u1, 2.2, u0, 2.2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    if (!this.fenceMat) {
      this.fenceMat = new THREE.MeshLambertMaterial({ map: tex.fence, alphaTest: 0.5, side: THREE.DoubleSide, transparent: false });
      patch(this.fenceMat, { key: 'fence', fragmentNormal: 'vec3 normal = normalize(vNormal) * faceDirection;' });
    }
    const m = new THREE.Mesh(g, this.fenceMat);
    m.receiveShadow = true;
    this.group.add(m);
  }

  addBeacon(pos, size, always = false) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(size, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.08, 0.01, 0.01) }));
    m.position.copy(pos);
    this.group.add(m);
    const L = { mesh: m, on: always, phase: Math.random() * 6, always };
    this.lights.push(L);
    return L;
  }
  addLamp(pos, rot) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.03), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 0.08, 0.05) }));
    m.position.copy(pos); m.rotation.y = rot;
    this.group.add(m);
    return m;
  }

  buildMegastructure(world, Bc, Bd, wires) {
    const [S, N] = world.pylons;
    const PH = 72;
    const tops = [];
    for (const p of [S, N]) {
      const y0 = p.y - 2;
      // stepped brutalist shaft with ribs and window slits
      const levels = [[0, 22, 18], [22, 46, 15], [46, 66, 12.5], [66, 72, 16]];
      for (const [a, b, w] of levels) Bc.box(p.x, y0 + (a + b) / 2, p.z, w, b - a, w, [0.92, 0.92, 0.93], 0, 4);
      for (const s of [-1, 1]) for (const t of [-1, 1]) {
        Bc.box(p.x + s * 8.4, y0 + 11, p.z + t * 8.4, 2.4, 22, 2.4, [0.86, 0.86, 0.88], 0, 4);
        Bc.box(p.x + s * 7.0, y0 + 34, p.z + t * 7.0, 1.6, 24, 1.6, [0.86, 0.86, 0.88], 0, 4);
      }
      for (let y = 8; y < 64; y += 9) {
        for (const s of [-1, 1]) {
          const w = y < 22 ? 18 : y < 46 ? 15 : 12.5;
          Bc.box(p.x + s * (w / 2 + 0.02), y0 + y, p.z, 0.08, 1.6, 0.5, [0.18, 0.2, 0.22], 0);
          Bc.box(p.x, y0 + y + 3, p.z + s * (w / 2 + 0.02), 0.5, 1.6, 0.08, [0.18, 0.2, 0.22], 0);
        }
      }
      // cable saddles
      Bd.box(p.x - 5, y0 + PH + 1.6, p.z, 2.2, 3.2, 6, [0.6, 0.62, 0.64], 0);
      Bd.box(p.x + 5, y0 + PH + 1.6, p.z, 2.2, 3.2, 6, [0.6, 0.62, 0.64], 0);
      tops.push(y0 + PH + 3);
      world.addCollider(p.x, p.z, 10.5);
      this.addBeacon(new THREE.Vector3(p.x, y0 + PH + 4.5, p.z), 0.6, true);
    }
    // main cables and the sphere
    const sc = new THREE.Vector3(SPHERE.x, S.y + 6, SPHERE.z);
    this.sphereCentre = sc;
    const midDrop = 22;
    for (const dx of [-5, 5]) {
      const a = new THREE.Vector3(S.x + dx, tops[0], S.z), b = new THREE.Vector3(N.x + dx, tops[1], N.z);
      const pts = catenary(a, b, midDrop, 40);
      wires.push(pts);
      // hangers to the sphere crown ring
      for (let i = 14; i <= 26; i += 2) {
        const p = pts[i];
        const ang = Math.atan2(p.z - sc.z, dx);
        const tgt = new THREE.Vector3(sc.x + Math.sign(dx) * 9, sc.y + SPHERE.radius * 0.93, p.z);
        if (Math.abs(p.z - sc.z) < 20) wires.push([p.clone(), tgt]);
      }
      // backstays down to anchors behind each pylon
      for (const [p, dir, top] of [[S, 1, tops[0]], [N, -1, tops[1]]]) {
        const anc = new THREE.Vector3(p.x + dx * 2, 0, p.z + dir * 60);
        anc.y = world.heightAt(anc.x, anc.z);
        wires.push(catenary(new THREE.Vector3(p.x + dx, top, p.z), anc, 3, 10));
        Bc.box(anc.x, anc.y + 1, anc.z, 4, 3, 4, [0.9, 0.9, 0.9], 0, 4);
      }
    }
    // the sphere itself
    const geo = new THREE.SphereGeometry(SPHERE.radius, 96, 64);
    const mat = new THREE.MeshStandardMaterial({ color: 0x7a7f84, metalness: 0.78, roughness: 0.42, envMapIntensity: 1.0 });
    this.sphereUniforms = { uActive: { value: 0 }, uSphereC: { value: sc } };
    patch(mat, {
      key: 'sphere',
      uniforms: this.sphereUniforms,
      fragmentPars: 'uniform float uActive; uniform vec3 uSphereC; vec3 gEmit = vec3(0.0);',
      fragmentColor: `
        {
          vec3 d = normalize(vWPos - uSphereC);
          float lat = asin(d.y), lon = atan(d.z, d.x);
          float gl = abs(fract(lat / 0.0872665) - 0.5);
          float gn = abs(fract(lon / 0.0872665 * cos(lat) * 1.0) - 0.5);
          float seam = smoothstep(0.46, 0.5, max(gl, gn));
          float panel = texture(uNoiseTex, vec2(floor(lat / 0.0872665), floor(lon / 0.0872665 * cos(lat))) * 0.137).a;
          float streak = texture(uNoiseTex, vec2(lon * 2.0, lat * 0.3)).g;
          diffuseColor.rgb *= mix(0.62, 1.2, panel) * (1.0 - seam * 0.7) * mix(0.75, 1.1, streak);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.34, 0.22, 0.14), smoothstep(0.65, 0.9, streak) * smoothstep(0.2, -0.6, d.y) * 0.45);
          float ring = smoothstep(0.035, 0.0, abs(d.y)) ;
          float bands = smoothstep(0.012, 0.0, abs(abs(d.y) - 0.35)) * 0.6;
          float pulse = 0.75 + 0.25 * sin(uTime * 1.3 - lon * 3.0);
          gEmit = vec3(0.55, 0.85, 1.0) * (ring * 6.0 + bands * 2.0) * uActive * pulse;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05), ring);
        }
      `,
      fragmentEnd: 'gl_FragColor.rgb += gEmit;',
    });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.copy(sc);
    sphere.castShadow = true; sphere.receiveShadow = true;
    this.sphere = sphere;
    this.sphereMat = mat;
    this.group.add(sphere);
    // equator ring structure
    const ring = new THREE.Mesh(new THREE.TorusGeometry(SPHERE.radius + 0.9, 0.7, 10, 96), mat);
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(sc);
    ring.castShadow = true;
    this.group.add(ring);
    // crown frame the hangers attach to
    for (const s of [-1, 1]) Bd.beam(new THREE.Vector3(sc.x + s * 9, sc.y + SPHERE.radius * 0.93, sc.z - 14), new THREE.Vector3(sc.x + s * 9, sc.y + SPHERE.radius * 0.93, sc.z + 14), 0.9, 0.9, [0.55, 0.57, 0.6]);
    Bd.beam(new THREE.Vector3(sc.x - 9, sc.y + SPHERE.radius * 0.93, sc.z), new THREE.Vector3(sc.x + 9, sc.y + SPHERE.radius * 0.93, sc.z), 0.9, 0.9, [0.55, 0.57, 0.6]);
    this.addBeacon(new THREE.Vector3(sc.x, sc.y + SPHERE.radius + 1.5, sc.z), 0.5, true);
  }

  buildBridge(world, tex) {
    // find where the ridge trail crosses the creek
    let best = null;
    for (const trail of world.trails) {
      for (let i = 1; i < trail.length - 1; i++) {
        const [x, z] = trail[i];
        const n = world.creekNearest(x, z);
        if (n.d < 2.5 && (!best || n.d < best.d)) best = { x, z, d: n.d, i, trail, c: n.p };
      }
    }
    if (!best) return;
    const a = best.trail[best.i - 1], b = best.trail[best.i + 1];
    const dir = new THREE.Vector2(b[0] - a[0], b[1] - a[1]).normalize();
    const len = best.c.width * 2 + 6;
    const cx = best.c.x, cz = best.c.z;
    const e1 = { x: cx - dir.x * len / 2, z: cz - dir.y * len / 2 }, e2 = { x: cx + dir.x * len / 2, z: cz + dir.y * len / 2 };
    const y1 = world.heightAt(e1.x, e1.z), y2 = world.heightAt(e2.x, e2.z);
    const deckY = Math.max(y1, y2, best.c.water + 0.7) + 0.05;
    const rot = Math.atan2(dir.x, dir.y);
    const B = new Builder();
    const wood = [0.85, 0.78, 0.7];
    const n = Math.round(len / 0.32);
    const side = new THREE.Vector3(dir.y, 0, -dir.x);
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n - 0.5;
      const px = cx + dir.x * t * len, pz = cz + dir.y * t * len;
      const ground = world.heightAt(px, pz);
      const y = Math.max(deckY - 0.05 - Math.max(0, Math.abs(t) * len - len / 2 + 2.5) * 0.25, ground + 0.03);
      B.box(px, y, pz, 1.6, 0.06, 0.28, wood.map((c) => c * (0.85 + ((k * 37) % 7) / 30)), rot, 1);
    }
    for (const s of [-1, 1]) {
      const o = side.clone().multiplyScalar(s * 0.62);
      B.cyl(new THREE.Vector3(e1.x + o.x, y1 - 0.25, e1.z + o.z), new THREE.Vector3(e2.x + o.x, y2 - 0.25, e2.z + o.z), 0.13, 7, [0.7, 0.62, 0.55]);
      const o2 = side.clone().multiplyScalar(s * 0.82);
      for (let k = 0; k <= 4; k++) {
        const t = k / 4 - 0.5;
        const px = cx + dir.x * t * (len - 3), pz = cz + dir.y * t * (len - 3);
        B.beam(new THREE.Vector3(px + o2.x, deckY - 0.1, pz + o2.z), new THREE.Vector3(px + o2.x, deckY + 1.0, pz + o2.z), 0.09, 0.09, wood);
      }
      B.beam(new THREE.Vector3(cx - dir.x * (len - 3) / 2 + o2.x, deckY + 1.0, cz - dir.y * (len - 3) / 2 + o2.z), new THREE.Vector3(cx + dir.x * (len - 3) / 2 + o2.x, deckY + 1.0, cz + dir.y * (len - 3) / 2 + o2.z), 0.08, 0.1, wood);
    }
    const mat = new THREE.MeshLambertMaterial({ map: tex.bark.beech, vertexColors: true });
    patch(mat, { key: 'wood', wet: true, fragmentColor: 'diffuseColor.rgb *= vec3(0.75, 0.6, 0.45) * (1.0 - uWetness * 0.35); gWet = uWetness;' });
    const m = new THREE.Mesh(B.build(), mat);
    m.castShadow = true; m.receiveShadow = true;
    this.group.add(m);
    world.decks = world.decks || [];
    world.decks.push({ cx, cz, dx: dir.x, dz: dir.y, half: len / 2 - 0.2, w: 0.75, y: deckY + 0.03, y1, y2 });
  }

  update(t, dt) {
    for (const L of this.lights) {
      const on = L.always || L.on;
      const blink = on ? (Math.sin(t * 2.2 + L.phase) > 0.2 ? 1 : 0.08) : 0;
      const c = L.mesh.material.color;
      c.setRGB(0.08 + blink * 9, 0.01 + blink * 0.5, 0.01 + blink * 0.3);
    }
  }
}
