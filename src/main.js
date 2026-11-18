import * as THREE from 'three';
import { installChunks, G } from './shaderlib.js';
import { getPreset, detectTier, PRESETS } from './config.js';
import * as TX from './textures.js';
import { World } from './world.js';
import { SPAWN } from './worldgen.js';
import { Sky } from './sky.js';
import { Terrain } from './terrain.js';
import { Grass } from './grass.js';
import { Trees } from './trees.js';
import { Props } from './props.js';
import { Structures } from './structures.js';
import { Water } from './water.js';
import { Environment, Rain, WEATHERS, WEATHER_NEWS } from './weather.js';
import { SunShadows } from './shadows.js';
import { Player, setupTouch } from './player.js';
import { Game } from './game.js';
import { Post } from './post.js';
import { Soundscape } from './audio.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'verdance-settings-v1';
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* unavailable */ }
}

function fail(msg) {
  $('loading').classList.add('hidden');
  $('error').classList.remove('hidden');
  $('error-msg').textContent = msg;
}

async function boot() {
  const canvas = $('c');
  const setProgress = (p, text) => { $('bar-fill').style.width = `${Math.round(p * 100)}%`; if (text) $('load-status').textContent = text; };
  const gl2 = canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance', stencil: false });
  if (!gl2) return fail('This browser or device does not support WebGL 2, which Verdance needs. Try a recent Chrome, Edge, Firefox or Safari.');
  installChunks();
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl2, antialias: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;

  const detected = detectTier(gl2);
  const settings = Object.assign({ quality: detected.tier, dynRes: true, fov: 72, sens: 1, invert: false, vol: 0.8, weather: 'auto', hour: 14.6, fps: false }, loadSettings());
  const q = getPreset(settings.quality);
  window.__verdance = { q, detected };

  // ---------- world generation (worker) ----------
  setProgress(0.02, 'Shaping the land');
  const data = await new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worldgen.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      if (e.data.type === 'progress') setProgress(0.02 + e.data.p * 0.4);
      else { resolve(e.data.world); w.terminate(); }
    };
    w.onerror = (e) => reject(e);
    w.postMessage({ seed: 1337 });
  });

  // ---------- textures ----------
  setProgress(0.44, 'Growing leaves'); await nextFrame();
  const tex = { bark: {} };
  { const la = TX.makeLeafAtlas(q.name === 'low' ? 256 : 512); tex.leaves = la.map; tex.leafNormals = la.normal; }
  setProgress(0.5, 'Weathering bark'); await nextFrame();
  for (const k of ['oak', 'beech', 'birch', 'small']) tex.bark[k] = TX.makeBark(k, k.length * 7);
  setProgress(0.55, 'Scattering stones'); await nextFrame();
  tex.ground = TX.makeGroundArray(q.name === 'low' ? 256 : 512);
  tex.flowers = TX.makeFlowerAtlas();
  tex.concrete = TX.makeConcrete(q.name === 'low' ? 256 : 512);
  tex.fence = TX.makeFenceTex();
  G.uNoiseTex.value = TX.makeNoiseTex();
  G.uWeatherMap.value = TX.makeWeatherMap();
  for (const t of [tex.leaves, tex.ground, ...Object.values(tex.bark)]) t.anisotropy = Math.min(t.anisotropy, renderer.capabilities.getMaxAnisotropy());

  setProgress(0.6, 'Raising the sky'); await nextFrame();
  const world = new World(data);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.2, 24000);
  camera.layers.enableAll();
  const sky = new Sky(renderer, q);
  scene.add(sky.dome);
  const hemi = new THREE.HemisphereLight(0xa0b8d8, 0x404830, 1);
  scene.add(hemi);
  const shadows = new SunShadows(scene, q);
  const audio = new Soundscape();
  audio.setMasterVolume(settings.vol);
  const env = new Environment(sky, shadows.main, hemi, audio);
  env.hour = settings.hour;
  if (settings.weather !== 'auto') { env.locked = settings.weather; env.setWeather(settings.weather, true); }
  env.update(0);

  setProgress(0.66, 'Laying the ground'); await nextFrame();
  const terrain = new Terrain(world, q, tex);
  scene.add(terrain.group);
  const grass = new Grass(world, q, tex);
  scene.add(grass.group);
  setProgress(0.72, 'Planting trees'); await nextFrame();
  const trees = new Trees(renderer, world, q, tex);
  scene.add(trees.group);
  setProgress(0.82, 'Undergrowth'); await nextFrame();
  const props = new Props(world, q, tex);
  scene.add(props.group);
  const player = new Player(camera, world, audio);
  player.spawn(SPAWN.x, SPAWN.z, SPAWN.yaw);
  camera.updateMatrixWorld();
  sky.updateClouds(camera.position, true);
  const envTex = sky.updateEnv(true);
  setProgress(0.86, 'Raising the towers'); await nextFrame();
  const structures = new Structures(world, q, tex, envTex);
  scene.add(structures.group);
  const water = new Water(world, sky.uniforms);
  scene.add(water.group);
  const rain = new Rain(q.rainCount);
  scene.add(rain.mesh);

  const game = new Game({ world, structures, player, audio, env, camera });
  Object.assign(window.__verdance, { player, env, game, camera, renderer, world, trees, grass, sky, structures, terrain, props, scene, settings, audio });
  const post = new Post(renderer, scene, camera, q, shadows, G);
  window.__verdance.post = post;

  // ---------- sizing + adaptive resolution ----------
  let scale = q.renderScale;
  const basePR = () => Math.min(devicePixelRatio || 1, q.maxPixelRatio);
  function resize() {
    const w = innerWidth, h = innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const pr = basePR() * scale;
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    post.setSize(w, h, pr);
    const pa = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (h * pr);
    if (structures.wireMat.__u) structures.wireMat.__u.uPixelAngle.value = pa;
  }
  // grab the wire uniforms once compiled (keeps cables >= 1 px at any resolution)
  const oldOBC = structures.wireMat.onBeforeCompile;
  structures.wireMat.onBeforeCompile = (s, r) => { oldOBC(s, r); structures.wireMat.__u = s.uniforms; };
  window.addEventListener('resize', resize);
  resize();

  // ---------- warm up: fill instance buffers, compile every shader before the first frame ----------
  setProgress(0.9, 'Compiling shaders'); await nextFrame();
  G.uCamPos.value.copy(camera.position);
  terrain.update(camera.position);
  grass.update(camera);
  trees.update(camera);
  props.update(camera);
  shadows.update(camera, G.uSunDir.value);
  try { await renderer.compileAsync(scene, camera); } catch { renderer.compile(scene, camera); }
  setProgress(0.97, 'Almost there'); await nextFrame();
  post.render(0.016);
  await nextFrame();
  setProgress(1, 'Ready');

  // ---------- UI ----------
  const isTouch = matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
  game.isTouch = isTouch;
  const qualSel = [$('title-quality'), $('set-quality')];
  for (const sel of qualSel) {
    for (const [k, v] of Object.entries(PRESETS)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = v.label + (k === detected.tier ? ' (recommended)' : '');
      sel.appendChild(o);
    }
    sel.value = settings.quality;
    sel.addEventListener('change', () => { settings.quality = sel.value; saveSettings(settings); location.reload(); });
  }
  {
    let g = detected.gpu || '';
    const m = g.match(/^ANGLE \((.*)\)$/);
    if (m) { const parts = m[1].split(', '); g = parts[1] || parts[0]; }
    $('gpu-note').textContent = g.replace(/\(0x[0-9a-f]+\)/i, '').replace(/Direct3D.*$|OpenGL.*$|Metal.*$/i, '').trim().slice(0, 48);
  }
  // weather pickers (title screen + menu) stay in sync; Auto lets the weather wander on its own
  const wsels = [$('set-weather'), $('title-weather')].filter(Boolean);
  const wopts = '<option value="auto">Auto (changes)</option>' + Object.entries(WEATHERS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  for (const wsel of wsels) {
    wsel.innerHTML = wopts;
    wsel.value = settings.weather;
    wsel.addEventListener('change', () => {
      settings.weather = wsel.value; saveSettings(settings);
      for (const o of wsels) o.value = wsel.value;
      if (wsel.value === 'auto') env.locked = null;
      else { env.locked = wsel.value; env.setWeather(wsel.value); }
    });
  }
  const bindRange = (id, key, apply) => {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!settings[key]; else el.value = settings[key];
    el.addEventListener('input', () => { settings[key] = el.type === 'checkbox' ? el.checked : parseFloat(el.value); apply(settings[key]); saveSettings(settings); });
    apply(settings[key]);
  };
  bindRange('set-fov', 'fov', (v) => { camera.fov = v; camera.updateProjectionMatrix(); });
  bindRange('set-sens', 'sens', (v) => { player.sens = 0.0022 * v; });
  bindRange('set-invert', 'invert', (v) => { player.invertY = v; });
  bindRange('set-vol', 'vol', (v) => audio.setMasterVolume(v));
  bindRange('set-hour', 'hour', (v) => { env.hour = v; });
  bindRange('set-fps', 'fps', (v) => { $('fps').style.display = v ? 'block' : 'none'; });
  bindRange('set-dynres', 'dynRes', (v) => { if (!v && scale !== q.renderScale) { scale = q.renderScale; resize(); } });

  let playing = false, paused = false, hudOff = false;
  // a quiet line when the weather turns on its own
  env.onChange = (name) => { if (playing && !env.locked && WEATHER_NEWS[name]) game.toast(WEATHER_NEWS[name], 5); };
  $('loading').classList.add('hidden');
  $('title').classList.remove('hidden');
  if (isTouch) $('title').querySelector('.keys').style.display = 'none';

  const lock = () => { if (!isTouch && canvas.requestPointerLock) { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } };
  async function enter() {
    $('title').classList.add('hidden');
    $('pause').classList.add('hidden');
    playing = true; paused = false;
    player.enabled = true;
    try { await audio.start(); audio.resume(); } catch { /* audio blocked */ }
    if (isTouch) $('touch').classList.remove('hidden');
    lock();
  }
  function pause() {
    if (!playing || paused) return;
    paused = true;
    player.enabled = false;
    $('pause').classList.remove('hidden');
    audio.suspend();
    if (document.pointerLockElement) document.exitPointerLock();
  }
  $('enter').addEventListener('click', enter);
  $('resume').addEventListener('click', enter);
  $('open-map').addEventListener('click', () => { game.toggleMap(true); });
  $('reset').addEventListener('click', () => { if (confirm('Reset all relay progress?')) game.resetProgress(); });
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && playing && !paused && !isTouch && !game.mapOpen) pause();
  });
  canvas.addEventListener('click', () => { if (playing && !paused && !document.pointerLockElement && !isTouch) lock(); });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM' && playing) {
      if (game.mapOpen) { game.toggleMap(false); if (!paused) lock(); }
      else { game.toggleMap(true); }
    }
    if (e.code === 'KeyH' && playing) { hudOff = !hudOff; $('hud').classList.toggle('off', hudOff); }
    if (e.code === 'Escape' && game.mapOpen) { game.toggleMap(false); }
  });
  $('map').addEventListener('click', () => { game.toggleMap(false); if (playing && !paused) lock(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  if (isTouch) setupTouch(player, $('touch'), {
    use: (d) => { game.useDown = d; }, radio: (d) => { game.radioDown = d; },
    menu: () => pause(), map: () => game.toggleMap(),
  });

  // ---------- GPU timing for adaptive resolution ----------
  const tq = gl2.getExtension('EXT_disjoint_timer_query_webgl2');
  const queries = [];
  let gpuMs = 0, gpuSamples = 0, lastAdjust = 0, cool = 0;
  function beginGpu(frame) {
    if (!tq || frame % 3) return null;
    const qy = gl2.createQuery();
    gl2.beginQuery(tq.TIME_ELAPSED_EXT, qy);
    return qy;
  }
  function endGpu(qy) {
    if (!qy) return;
    gl2.endQuery(tq.TIME_ELAPSED_EXT);
    queries.push(qy);
  }
  function pollGpu() {
    while (queries.length) {
      const qy = queries[0];
      if (!gl2.getQueryParameter(qy, gl2.QUERY_RESULT_AVAILABLE)) break;
      queries.shift();
      if (!gl2.getParameter(tq.GPU_DISJOINT_EXT)) {
        const ms = gl2.getQueryParameter(qy, gl2.QUERY_RESULT) / 1e6;
        gpuMs = gpuSamples ? gpuMs * 0.85 + ms * 0.15 : ms; gpuSamples++;
      }
      gl2.deleteQuery(qy);
    }
  }

  // ---------- main loop ----------
  const clock = new THREE.Clock();
  let exposure = 1, time = 0, frame = 0, fpsAcc = 0, fpsN = 0, fpsShown = 0, frameEma = 16.7, envTimer = 0, canopySm = 0;
  const aState = {
    camPos: camera.position, camRight: new THREE.Vector3(), camForward: new THREE.Vector3(), speed: 0, forest: 0, wind: 0, rain: 0, fog: 0, storm: 0,
    daylight: 1, creekDist: Infinity, creekDir: { x: 0, z: 1 }, waterfallDist: Infinity, waterfallDir: { x: 0, z: 1 }, chasmDist: 1e9,
    radioActive: false, radioSignal: 0, radioDist: 1e9, sphereHum: 0, paused: false,
  };

  window.__verdance.stats = () => ({ gpuMs: +gpuMs.toFixed(2), scale, frameMs: +frameEma.toFixed(2), tris: renderer.info.render.triangles, calls: renderer.info.render.calls });
  function tick() {
    requestAnimationFrame(tick);
    const dtRaw = clock.getDelta();
    const dt = Math.min(0.05, dtRaw);
    time += dt; frame++;
    G.uTime.value = time;
    frameEma = frameEma * 0.95 + dtRaw * 1000 * 0.05;

    if (playing && !paused) player.update(dt);
    camera.updateMatrixWorld();
    G.uCamPos.value.copy(camera.position);
    env.update(dt);
    terrain.update(camera.position);
    grass.update(camera);
    trees.update(camera);
    props.update(camera);
    shadows.update(camera, G.uSunDir.value);
    water.update(camera, time, env.s.rain);
    rain.update(env.s.rain, sky.uniforms.uSkyBright.value);
    structures.update(time, dt);
    if (playing) game.update(dt);

    envTimer -= dt;
    if (envTimer <= 0) {
      envTimer = 3;
      const t = sky.updateEnv();
      if (t) for (const m of structures.materials) { m.envMap = t; }
      if (t) structures.sphereMat.envMap = t;
    }

    // audio
    if (audio.started) {
      const p = player.pos;
      aState.camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      aState.camForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      aState.speed = player.speed;
      aState.forest = world.forestAt(p.x, p.z);
      const s = env.s;
      aState.wind = s.wind; aState.rain = s.rain; aState.fog = Math.min(1, s.fog * 200); aState.storm = s.storm;
      aState.daylight = env.daylight;
      if (frame % 6 === 0) {
        const cn = world.creekNearest(p.x, p.z);
        const onRim = cn.p.z < -500;
        aState.creekDist = onRim ? Infinity : Math.max(0, cn.d - cn.p.width);
        const cl = Math.max(cn.d, 0.001);
        aState.creekDir.x = (cn.p.x - p.x) / cl; aState.creekDir.z = (cn.p.z - p.z) / cl;
        let best = 1e9, bx = 0, bz = 1;
        for (const f of water.fallTops) {
          const d = Math.hypot(f.x - p.x, f.z - p.z);
          if (d < best) { best = d; bx = (f.x - p.x) / d; bz = (f.z - p.z) / d; }
        }
        aState.waterfallDist = best; aState.waterfallDir.x = bx; aState.waterfallDir.z = bz;
        aState.chasmDist = Math.max(0, world.chasmEdgeDist(p.x, p.z));
      }
      aState.radioActive = !!game.radio?.active;
      aState.radioSignal = game.radio?.signal || 0;
      aState.radioDist = game.radio?.dist || 1e9;
      aState.sphereHum = game.sphereHum();
      aState.paused = paused || !playing;
      audio.update(dt, aState);
    }

    renderer.info.reset();
    // eye adaptation without GPU readback: canopy density + weather drive exposure
    {
      const p = camera.position;
      const canopy = world.forestAt(p.x, p.z);
      const target = (1 + canopy * 1.25) * (1 + env.s.overcast * 0.25) * (1 + (1 - env.daylight) * 1.4);
      exposure += (target - exposure) * Math.min(1, dt * 0.8);
      post.grade.uniforms.uExposure.value = exposure;
      canopySm += (Math.min(1, canopy * 1.4) - canopySm) * Math.min(1, dt * 0.6);
      post.setShafts(env.shaft.amount, env.shaft.scatter, canopySm);
    }
    const qy = beginGpu(frame);
    sky.updateClouds(camera.position);
    post.render(dt);
    endGpu(qy);
    if (tq) pollGpu();

    // adaptive resolution: hold ~60 fps by trading pixels, never detail
    if (settings.dynRes && playing && time - lastAdjust > 1.5) {
      lastAdjust = time;
      const cost = tq && gpuSamples > 5 ? gpuMs : frameEma;
      const minScale = Math.max(0.5, q.renderScale * 0.6);
      if (cost > 18.5 && scale > minScale + 0.01) { scale = Math.max(minScale, scale - 0.1); cool = time + 8; resize(); }
      else if (cost < (tq ? 11.5 : 17.2) && scale < q.renderScale - 0.01 && time > cool) { scale = Math.min(q.renderScale, scale + 0.05); resize(); }
    }

    if (settings.fps) {
      fpsAcc += dtRaw; fpsN++;
      if (fpsAcc > 0.5) {
        fpsShown = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
        const info = renderer.info.render;
        $('fps').textContent = `${fpsShown.toFixed(0)} fps · ${(tq && gpuSamples ? gpuMs.toFixed(1) + ' ms gpu · ' : '')}${Math.round(scale * 100)}% res · ${(info.triangles / 1e6).toFixed(1)}M tris · ${q.label}\n${env.state.name}`;
      }
    }
  }
  requestAnimationFrame(tick);
}

boot().catch((e) => {
  console.error(e);
  fail('Something went wrong while building the world: ' + (e && e.message ? e.message : e));
});
