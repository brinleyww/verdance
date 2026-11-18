// The light gameplay loop: find and restore five silent relays; the sphere wakes when all are back.
import * as THREE from 'three';
import { AREAS, chasmCentre, chasmHalfWidth, SPHERE } from './worldgen.js';

const SAVE_KEY = 'verdance-save-v1';
const HOLD_TIME = 2.2;

function loadSave() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch { return {}; }
}
function writeSave(s) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

export class Game {
  constructor({ world, structures, player, audio, env, camera }) {
    this.world = world; this.st = structures; this.player = player; this.audio = audio; this.env = env; this.camera = camera;
    this.relays = structures.relays;
    this.save = loadSave();
    this.restored = new Set(this.save.restored || []);
    for (const r of this.relays) if (this.restored.has(r.id)) this.activate(r, true);
    this.finale = this.restored.size === this.relays.length ? 1 : 0;
    this.sphereLevel = this.finale;
    this.st.sphereUniforms.uActive.value = this.sphereLevel;
    this.hold = 0;
    this.useDown = false;
    this.radioDown = false;
    this.areaShown = new Map();
    this.currentArea = null;
    this.toastTimer = 0;
    this.finaleTimer = -1;
    this.el = {
      prompt: document.getElementById('prompt'),
      ring: document.getElementById('ring-fg'),
      ringWrap: document.getElementById('ring'),
      toast: document.getElementById('toast'),
      area: document.getElementById('area'),
      dot: document.getElementById('dot'),
      map: document.getElementById('map'),
      mapCanvas: document.getElementById('map-canvas'),
      radio: document.getElementById('radio-ind'),
    };
    this._f = new THREE.Vector3();
    this.mapOpen = false;
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyE') this.useDown = true;
      if (e.code === 'KeyR') this.radioDown = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyE') this.useDown = false;
      if (e.code === 'KeyR') this.radioDown = false;
    });
  }

  activate(r, silent = false) {
    r.active = true;
    r.light.on = true;
    r.lamp.material.color.setRGB(0.1, 1.6, 0.35);
    if (!silent) {
      this.restored.add(r.id);
      this.save.restored = [...this.restored];
      writeSave(this.save);
      this.audio?.relayActivate({ x: r.x, y: r.y + 2, z: r.z });
      const n = this.restored.size, tot = this.relays.length;
      this.toast(n < tot ? `${r.name} restored · ${n} of ${tot}` : 'All relays restored');
      if (n === tot) this.finaleTimer = 4;
    }
  }

  toast(text, secs = 4.5) {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.add('show');
    this.toastTimer = secs;
  }

  showArea(name) {
    const a = this.el.area;
    a.textContent = name;
    a.classList.remove('show');
    void a.offsetWidth;
    a.classList.add('show');
  }

  nearestSilent(p) {
    let best = null, bd = 1e9;
    for (const r of this.relays) {
      if (r.active) continue;
      const d = Math.hypot(r.x - p.x, r.z - p.z);
      if (d < bd) { bd = d; best = r; }
    }
    return best ? { r: best, d: bd } : null;
  }

  update(dt) {
    const p = this.player.pos;
    const cam = this.camera;
    const fwd = this._f.set(0, 0, -1).applyQuaternion(cam.quaternion);

    // interaction
    let target = null;
    for (const r of this.relays) {
      if (r.active) continue;
      const dx = r.cabinet.x - cam.position.x, dy = r.cabinet.y - cam.position.y, dz = r.cabinet.z - cam.position.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 2.6 && (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d > 0.55) target = r;
    }
    const using = this.useDown && target && this.player.enabled;
    if (target) {
      this.el.prompt.textContent = this.isTouch ? 'Hold USE to restore the relay' : 'Hold  E  to restore the relay';
      this.el.prompt.classList.add('show');
      this.el.dot.classList.add('show');
    } else {
      this.el.prompt.classList.remove('show');
      this.el.dot.classList.remove('show');
    }
    if (using) {
      this.hold += dt;
      this.audio?.relayProgress(Math.min(1, this.hold / HOLD_TIME));
      if (this.hold >= HOLD_TIME) { this.hold = 0; this.audio?.relayProgress(-1); this.activate(target); }
    } else if (this.hold > 0) { this.hold = 0; this.audio?.relayProgress(-1); }
    const frac = this.hold / HOLD_TIME;
    this.el.ringWrap.classList.toggle('show', frac > 0);
    this.el.ring.style.strokeDashoffset = String(113 * (1 - frac));

    // finale
    if (this.finaleTimer > 0) {
      this.finaleTimer -= dt;
      if (this.finaleTimer <= 0) {
        this.finale = 1;
        this.audio?.finale();
        this.toast('Something stirs over the chasm', 6);
        if (!this.env.locked) this.env.setWeather('clear');
      }
    }
    if (this.finale) this.sphereLevel = Math.min(1, this.sphereLevel + dt / 9);
    this.st.sphereUniforms.uActive.value = this.sphereLevel;

    // radio
    const ns = this.nearestSilent(p);
    this.radio = { active: this.radioDown && this.player.enabled, signal: 0, dist: 1e9 };
    if (ns) {
      const dx = ns.r.x - p.x, dz = ns.r.z - p.z;
      const l = Math.hypot(dx, dz) || 1;
      const fl = Math.hypot(fwd.x, fwd.z) || 1;
      const dot = (dx * fwd.x + dz * fwd.z) / (l * fl);
      this.radio.signal = Math.pow(Math.max(0, dot), 6);
      this.radio.dist = ns.d;
    }
    this.el.radio.classList.toggle('show', this.radio.active);
    this.el.radio.style.setProperty('--sig', this.radio.signal.toFixed(3));

    // area titles
    let area = null;
    for (const a of AREAS) if (Math.hypot(a.x - p.x, a.z - p.z) < a.r) { area = a.name; break; }
    if (area !== this.currentArea) {
      this.currentArea = area;
      const last = this.areaShown.get(area) || -1e9;
      const now = performance.now() / 1000;
      if (area && now - last > 90) { this.showArea(area); this.areaShown.set(area, now); }
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.toast.classList.remove('show');
    }
    if (this.mapOpen) this.drawMap();
  }

  sphereHum() {
    if (!this.sphereLevel) return 0;
    const c = this.st.sphereCentre;
    const d = this.player.pos.distanceTo(c);
    return this.sphereLevel * Math.max(0, 1 - d / 700);
  }

  resetProgress() {
    this.save = {}; writeSave(this.save);
    location.reload();
  }

  // ------------------------------------------------------------ field map
  toggleMap(force) {
    this.mapOpen = force ?? !this.mapOpen;
    this.el.map.classList.toggle('show', this.mapOpen);
    if (this.mapOpen) { if (!this.mapBase) this.buildMap(); this.drawMap(); }
  }

  buildMap() {
    const S = 640, R = 960;
    this.mapS = S; this.mapR = R;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(S, S);
    const w = this.world;
    const toW = (i) => (i / S * 2 - 1) * R;
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const x = toW(i), z = toW(j) + 40;
        const h = w.heightAt(x, z);
        const hx = w.heightAt(x + 3, z) - w.heightAt(x - 3, z);
        const hz = w.heightAt(x, z + 3) - w.heightAt(x, z - 3);
        const shade = Math.max(0, Math.min(1, 0.72 + (-hx * 0.6 - hz * 0.6) * 0.06));
        const f = w.forestAt(x, z);
        let r = 232, g = 222, b = 196;
        r = r * (1 - f * 0.18); g = g * (1 - f * 0.08); b = b * (1 - f * 0.2);
        const contour = Math.abs(((h / 10) % 1 + 1) % 1 - 0.5) > 0.47 ? 0.86 : 1;
        r *= shade * contour; g *= shade * contour; b *= shade * contour;
        if (w.pathAt(x, z) > 0.55) { r = 150; g = 104; b = 70; }
        if (w.wetAt(x, z) > 0.8) { r = 92; g = 132; b = 158; }
        if (Math.abs(z - chasmCentre(x)) < chasmHalfWidth(x) - 6) { const d = Math.min(1, -h / 200); r = 70 - d * 30; g = 66 - d * 30; b = 62 - d * 30; }
        const k = (j * S + i) * 4;
        img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.mapBase = c;
  }

  drawMap() {
    const cv = this.el.mapCanvas;
    const S = this.mapS, R = this.mapR;
    if (cv.width !== S) { cv.width = cv.height = S; }
    const ctx = cv.getContext('2d');
    ctx.drawImage(this.mapBase, 0, 0);
    const toM = (x, z) => [((x / R) + 1) / 2 * S, (((z - 40) / R) + 1) / 2 * S];
    ctx.font = '600 13px "Cormorant Garamond", Georgia, serif';
    ctx.textAlign = 'center';
    for (const r of this.relays) {
      const [mx, my] = toM(r.x, r.z);
      ctx.beginPath();
      ctx.arc(mx, my, 7, 0, Math.PI * 2);
      ctx.strokeStyle = r.active ? '#2f6b3a' : '#8a2b1f';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (r.active) { ctx.beginPath(); ctx.moveTo(mx - 3.5, my); ctx.lineTo(mx - 1, my + 3); ctx.lineTo(mx + 4, my - 3); ctx.stroke(); }
      else { ctx.beginPath(); ctx.moveTo(mx, my - 3); ctx.lineTo(mx, my + 3); ctx.moveTo(mx - 3, my); ctx.lineTo(mx + 3, my); ctx.stroke(); }
      ctx.fillStyle = '#3b2f22';
      ctx.fillText(r.name, mx, my - 12);
    }
    const [sx, sy] = toM(SPHERE.x, SPHERE.z);
    ctx.fillStyle = '#e8dfc8';
    ctx.fillText('the sphere', sx, sy + 4);
    const p = this.player.pos;
    const [px, py] = toM(p.x, p.z);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-this.player.yaw);
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 3); ctx.lineTo(-6, 7); ctx.closePath();
    ctx.fillStyle = '#c4361c'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#f5eedc'; ctx.stroke();
    ctx.restore();
  }
}
