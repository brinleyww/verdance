// First-person walker: keyboard/mouse and touch, terrain following, collisions and cliff safety.
import * as THREE from 'three';
import { WORLD } from './worldgen.js';

const EYE = 1.68;

export class Player {
  constructor(camera, world, audio) {
    this.camera = camera;
    this.world = world;
    this.audio = audio;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.grounded = true;
    this.keys = new Set();
    this.sens = 0.0022;
    this.invertY = false;
    this.walk = 3.3; this.run = 6.6;
    this.bob = 0; this.bobAmt = 0; this.stepPhase = 0;
    this.enabled = false;
    this.touchMove = new THREE.Vector2();
    this.touchRun = false;
    this.speed = 0;
    this.surface = 'grass';
    this.inWater = false;
    this._o = { x: 0, z: 0 };
    this._fallStart = 0;
    window.addEventListener('keydown', (e) => { if (!e.repeat) this.keys.add(e.code); if (e.code === 'Space' && this.enabled) e.preventDefault(); });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement == null) return;
      this.look(e.movementX, e.movementY);
    });
  }

  look(dx, dy) {
    this.yaw -= dx * this.sens;
    this.pitch -= dy * this.sens * (this.invertY ? -1 : 1);
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
  }

  spawn(x, z, yaw) {
    this.pos.set(x, this.groundAt(x, z), z);
    this.yaw = yaw; this.pitch = -0.02;
    this.vel.set(0, 0, 0);
    this.applyCamera(0);
  }

  groundAt(x, z) {
    let h = this.world.heightAt(x, z);
    const decks = this.world.decks;
    if (decks) for (const d of decks) {
      const rx = x - d.cx, rz = z - d.cz;
      const a = rx * d.dx + rz * d.dz, b = -rx * d.dz + rz * d.dx;
      if (Math.abs(a) < d.half && Math.abs(b) < d.w) h = Math.max(h, d.y);
    }
    return h;
  }

  update(dt) {
    const k = this.keys;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) + this.touchMove.y;
    const s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) + this.touchMove.x;
    const running = k.has('ShiftLeft') || k.has('ShiftRight') || this.touchRun;
    let mx = 0, mz = 0;
    if (this.enabled) {
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      mx = -sy * f + cy * s; mz = -cy * f - sy * s;
      const l = Math.hypot(mx, mz);
      if (l > 1) { mx /= l; mz /= l; }
    }
    const wade = this.inWater ? 0.55 : 1;
    const target = (running ? this.run : this.walk) * wade;
    const acc = this.grounded ? 9 : 1.5;
    this.vel.x += (mx * target - this.vel.x) * Math.min(1, acc * dt);
    this.vel.z += (mz * target - this.vel.z) * Math.min(1, acc * dt);

    // proposed move
    const p = this.pos;
    let nx = p.x + this.vel.x * dt, nz = p.z + this.vel.z * dt;
    const g0 = this.groundAt(p.x, p.z);
    let g1 = this.groundAt(nx, nz);
    // steep uphill: slide back
    const run = Math.hypot(nx - p.x, nz - p.z);
    if (run > 1e-5 && this.grounded && (g1 - g0) / run > 1.05) { nx = p.x; nz = p.z; g1 = g0; this.vel.x *= 0.3; this.vel.z *= 0.3; }
    // cliff edge (chasm, big drops): treat as a wall
    if (g1 < p.y - 2.8 && this.grounded) {
      nx = p.x; nz = p.z; g1 = g0;
      this.vel.x = 0; this.vel.z = 0;
    }
    if (this.world.inChasm(nx, nz, -3)) { nx = p.x; nz = p.z; g1 = g0; }
    // playable boundary
    const r = Math.hypot(nx, nz - 40);
    const R = WORLD.playRadius;
    if (r > R) { const t = R / r; nx = nx * t; nz = 40 + (nz - 40) * t; }
    const o = this.world.collide(nx, nz, 0.35, p.y + 0.4, this._o);
    nx = o.x; nz = o.z;
    p.x = nx; p.z = nz;
    const ground = this.groundAt(p.x, p.z);

    // vertical
    if (this.grounded && this.enabled && (k.has('Space') || this.touchJump)) { this.vel.y = 5.6; this.grounded = false; this.touchJump = false; this._fallStart = p.y; }
    if (!this.grounded) {
      this.vel.y -= 20 * dt;
      p.y += this.vel.y * dt;
      if (p.y <= ground) {
        const fall = this._fallStart - ground;
        p.y = ground; this.grounded = true; this.vel.y = 0;
        this.audio?.land(Math.min(1, 0.3 + fall * 0.15));
      }
    } else {
      if (ground < p.y - 0.6) { this.grounded = false; this.vel.y = 0; this._fallStart = p.y; }
      else p.y += (ground - p.y) * Math.min(1, dt * 18);
    }

    const water = this.world.creekWaterAt(p.x, p.z);
    this.inWater = water > p.y + 0.05;
    this.speed = Math.hypot(this.vel.x, this.vel.z);

    // head bob + footsteps
    const moving = this.grounded && this.speed > 0.4;
    this.bobAmt += ((moving ? Math.min(1, this.speed / this.walk) : 0) - this.bobAmt) * Math.min(1, dt * 6);
    if (moving) {
      const prev = this.stepPhase;
      this.stepPhase += dt * this.speed * 0.95;
      if (Math.floor(prev) !== Math.floor(this.stepPhase)) {
        this.surface = this.inWater ? 'water' : this.onDeck() ? 'wood' : this.world.surfaceAt(p.x, p.z, p.y);
        this.audio?.footstep(this.surface, Math.min(1, this.speed / this.run + 0.25));
      }
    }
    this.applyCamera(dt);
  }

  onDeck() {
    const d = this.world.decks;
    if (!d) return false;
    return Math.abs(this.groundAt(this.pos.x, this.pos.z) - this.world.heightAt(this.pos.x, this.pos.z)) > 0.05;
  }

  applyCamera() {
    const ph = this.stepPhase * Math.PI;
    const by = Math.abs(Math.sin(ph)) * 0.045 * this.bobAmt - 0.02 * this.bobAmt;
    const bx = Math.sin(ph) * 0.02 * this.bobAmt;
    const c = this.camera;
    c.position.set(this.pos.x, this.pos.y + EYE + by - (this.inWater ? 0.12 : 0), this.pos.z);
    c.rotation.set(this.pitch, this.yaw, Math.sin(ph) * 0.0035 * this.bobAmt, 'YXZ');
    c.position.x += Math.cos(this.yaw) * bx; c.position.z -= Math.sin(this.yaw) * bx;
  }
}

// Touch controls: left thumb moves, right thumb looks, buttons for actions.
export function setupTouch(player, root, handlers) {
  const stick = root.querySelector('#stick');
  const knob = root.querySelector('#stick-knob');
  let moveId = null, lookId = null, ox = 0, oy = 0, lx = 0, ly = 0;
  const el = root;
  el.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      if (t.target.closest('.tbtn')) continue;
      if (t.clientX < window.innerWidth * 0.42 && moveId === null) {
        moveId = t.identifier; ox = t.clientX; oy = t.clientY;
        stick.style.left = ox - 60 + 'px'; stick.style.top = oy - 60 + 'px'; stick.classList.add('on');
      } else if (lookId === null) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; }
    }
    e.preventDefault();
  }, { passive: false });
  el.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) {
        let dx = t.clientX - ox, dy = t.clientY - oy;
        const l = Math.hypot(dx, dy), m = 55;
        if (l > m) { dx = dx / l * m; dy = dy / l * m; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        player.touchMove.set(dx / m, -dy / m);
      } else if (t.identifier === lookId) {
        player.look((t.clientX - lx) * 2.2, (t.clientY - ly) * 2.2);
        lx = t.clientX; ly = t.clientY;
      }
    }
    e.preventDefault();
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) { moveId = null; player.touchMove.set(0, 0); knob.style.transform = ''; stick.classList.remove('on'); }
      if (t.identifier === lookId) lookId = null;
    }
  };
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
  const bind = (id, down, up) => {
    const b = root.querySelector(id);
    if (!b) return;
    b.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); down(); }, { passive: false });
    b.addEventListener('touchend', (e) => { e.preventDefault(); up && up(); }, { passive: false });
  };
  bind('#t-use', () => handlers.use(true), () => handlers.use(false));
  bind('#t-radio', () => handlers.radio(true), () => handlers.radio(false));
  bind('#t-run', () => { player.touchRun = !player.touchRun; root.querySelector('#t-run').classList.toggle('on', player.touchRun); });
  bind('#t-jump', () => { player.touchJump = true; });
  bind('#t-menu', () => handlers.menu());
  bind('#t-map', () => handlers.map());
}
