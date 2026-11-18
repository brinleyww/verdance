// Time of day + weather state machine. Drives sun, sky, clouds, fog, wind, rain and wetness.
import * as THREE from 'three';
import { G, COMMON_GLSL } from './shaderlib.js';
import { skyRadianceJS } from './sky.js';

export const WEATHERS = {
  clear: { label: 'Clear', cover: 0.36, overcast: 0.0, stratus: 0, fog: 0.00016, mist: 0.013, wind: 0.3, rain: 0, cd: 1.0, dark: 0.0, sun: 1.0, storm: 0, haze: 1.0 },
  fair: { label: 'Fair', cover: 0.52, overcast: 0.03, stratus: 0, fog: 0.0002, mist: 0.015, wind: 0.42, rain: 0, cd: 1.0, dark: 0.03, sun: 1.0, storm: 0, haze: 0.95 },
  cloudy: { label: 'Cloudy', cover: 0.7, overcast: 0.28, stratus: 0.12, fog: 0.0003, mist: 0.019, wind: 0.58, rain: 0, cd: 1.15, dark: 0.2, sun: 0.88, storm: 0, haze: 0.75 },
  overcast: { label: 'Overcast', cover: 0.9, overcast: 0.84, stratus: 0.85, fog: 0.0007, mist: 0.028, wind: 0.5, rain: 0, cd: 1.3, dark: 0.5, sun: 0.3, storm: 0, haze: 0.45 },
  fog: { label: 'Fog', cover: 0.85, overcast: 0.88, stratus: 0.6, fog: 0.0062, mist: 0.09, wind: 0.1, rain: 0, cd: 1.2, dark: 0.45, sun: 0.32, storm: 0, haze: 2.2 },
  rain: { label: 'Rain', cover: 0.96, overcast: 0.95, stratus: 1.0, fog: 0.0017, mist: 0.04, wind: 0.75, rain: 0.8, cd: 1.45, dark: 0.72, sun: 0.15, storm: 0, haze: 0.6 },
  storm: { label: 'Storm', cover: 1.0, overcast: 1.0, stratus: 1.0, fog: 0.0023, mist: 0.047, wind: 1.0, rain: 1.0, cd: 1.65, dark: 0.9, sun: 0.07, storm: 1, haze: 0.5 },
};
// Markov chain: every state can reach rain within two steps
const NEXT = {
  clear: ['fair', 'fair', 'cloudy'], fair: ['clear', 'cloudy', 'cloudy', 'overcast'], cloudy: ['fair', 'overcast', 'rain', 'rain'],
  overcast: ['rain', 'rain', 'cloudy', 'fog', 'storm'], fog: ['cloudy', 'overcast', 'fair'], rain: ['overcast', 'storm', 'cloudy', 'fair'], storm: ['rain', 'rain', 'overcast'],
};
const KEYS = ['cover', 'overcast', 'stratus', 'fog', 'mist', 'wind', 'rain', 'cd', 'dark', 'sun', 'storm', 'haze'];
// clouds build before the rain starts and the rain stops before they break up
const LEAD = new Set(['cover', 'overcast', 'stratus', 'cd', 'dark', 'sun', 'wind']);
const LAG = new Set(['rain', 'storm']);
export const WEATHER_NEWS = {
  clear: 'The sky is clearing', fair: 'Clouds drift in', cloudy: 'Clouds are gathering', overcast: 'The sky turns grey',
  fog: 'Fog is rolling in', rain: 'Rain is coming', storm: 'A storm is building',
};
const ss = THREE.MathUtils.smoothstep;
const K_EXT = [0.06, 0.12, 0.26]; // zenith optical depth per channel (Rayleigh + aerosol), drives sun colour

export class Environment {
  constructor(sky, sunLight, hemi, audio) {
    this.sky = sky; this.sun = sunLight; this.hemi = hemi; this.audio = audio;
    this.hour = 14.6;
    this.autoTime = false;
    this.locked = null;
    this.current = 'fair';
    this.target = 'fair';
    this.s = Object.assign({}, WEATHERS.fair);
    this.from = Object.assign({}, WEATHERS.fair);
    this.blend = 1;
    this.timer = 45 + Math.random() * 45;
    this.onChange = null;
    this.shaft = { scatter: 0, amount: 0 };
    this.wetness = 0;
    this.flash = 0;
    this.nextFlash = 8;
    this.windAngle = 0.65;
    this.daylight = 1;
    this._c = new THREE.Color(); this._d = new THREE.Vector3();
    this.sunDir = new THREE.Vector3();
    this.envDirty = true;
  }

  setWeather(name, instant = false) {
    const changed = name !== this.target;
    this.from = Object.assign({}, this.s);
    this.target = name;
    this.blend = instant ? 1 : 0;
    if (instant) { Object.assign(this.s, WEATHERS[name]); this.current = name; }
    // states last 1.5-4 minutes; storms are short
    this.timer = (name === 'storm' ? 60 : 85) + Math.random() * 140;
    this.envDirty = true;
    if (changed && !instant && this.onChange) this.onChange(name);
  }

  update(dt) {
    // weather progression
    if (!this.locked) {
      this.timer -= dt;
      if (this.timer <= 0) {
        const opts = NEXT[this.target];
        this.setWeather(opts[Math.floor(Math.random() * opts.length)]);
      }
    } else if (this.target !== this.locked) this.setWeather(this.locked);
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 32);
      const t = this.blend;
      const to = WEATHERS[this.target];
      for (const k of KEYS) {
        const up = to[k] > this.from[k];
        const tk = LAG.has(k) ? (up ? ss(t, 0.55, 1) : ss(t, 0, 0.45)) : LEAD.has(k) ? (up ? ss(t, 0, 0.7) : ss(t, 0.3, 1)) : ss(t, 0, 1);
        this.s[k] = this.from[k] + (to[k] - this.from[k]) * tk;
      }
      if (this.blend >= 1) this.current = this.target;
    }
    const s = this.s;
    if (this.autoTime) this.hour = (this.hour + dt / 60) % 24;

    // sun
    const h = this.hour;
    const dayT = (h - 6) / 12;
    const elev = Math.sin(Math.PI * dayT) * 1.0;
    const az = Math.PI * (0.25 + dayT * 1.1);
    const e = Math.asin(Math.max(-0.2, Math.min(1, elev * 0.86)));
    this.sunDir.set(Math.cos(e) * Math.cos(az), Math.sin(e), -Math.cos(e) * Math.sin(az) * 0.85 + 0.35).normalize();
    G.uSunDir.value.copy(this.sunDir);
    const up = Math.max(0, this.sunDir.y);
    const se = this.sunDir.y;
    // daylight fades through civil twilight instead of switching off at the horizon
    this.daylight = ss(se, -0.035, 0.16);
    // sun colour from air mass (Kasten-Young): white at noon, gold, then red at the horizon
    const ed = Math.max(-1.5, THREE.MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, se)))));
    const airmass = 1 / (Math.max(0, Math.sin(THREE.MathUtils.degToRad(ed))) + 0.50572 * Math.pow(ed + 6.07995, -1.6364));
    const tr = K_EXT.map((k) => Math.exp(-k * airmass) / Math.exp(-k * 1.08));
    const mx = Math.max(tr[0], tr[1], tr[2]);
    G.uSunColor.value.setRGB(tr[0] / mx, 0.97 * tr[1] / mx, 0.92 * tr[2] / mx);
    const sunLum = Math.min(1, 0.2126 * tr[0] + 0.7152 * tr[1] + 0.0722 * tr[2]);
    const sunFade = this.daylight * Math.pow(sunLum, 0.55);
    const sunI = 3.3 * s.sun * sunFade;
    this.sky.uniforms.uSunIntensity.value = 3.3 * sunFade;
    this.sky.uniforms.uOvercast.value = s.overcast;
    this.sky.uniforms.uSkyBright.value = (1.0 - s.overcast * 0.22 - s.storm * 0.25) * (0.03 + 0.97 * ss(se, -0.2, 0.16));
    this.sky.uniforms.uStratus.value = s.stratus;
    // clouds sit 1.5-3 km up: they still catch the (redder) sun a while after it leaves the ground
    {
      const ec = ed + 1.6;
      const amc = 1 / (Math.max(0, Math.sin(THREE.MathUtils.degToRad(ec))) + 0.50572 * Math.pow(Math.max(ec, -1.5) + 6.07995, -1.6364));
      const tc = K_EXT.map((k) => Math.exp(-k * amc) / Math.exp(-k * 1.08));
      const up2 = ss(se, -0.07, 0.05);
      this.sky.uniforms.uCloudSun.value.setRGB(tc[0], 0.97 * tc[1], 0.92 * tc[2]).multiplyScalar(3.3 * up2);
    }
    // sun shafts: hazier air in the morning, evening and after rain
    const lowSun = 1 - ss(se, 0.12, 0.5);
    this.shaft.scatter = 0.0028 * s.haze * (1 + 0.9 * lowSun) * (1 + this.wetness * 0.9);
    this.shaft.amount = sunI;
    this.sky.uniforms.uCloudDensity.value = s.cd;
    this.sky.uniforms.uCloudDark.value = s.dark;
    G.uCloudCover.value = s.cover;
    G.uCloudShadow.value = 0.8 * (1 - s.overcast * 0.85);
    G.uFogDensity.value = s.fog;
    G.uMistDensity.value = s.mist;
    // wind slowly veers
    this.windAngle += Math.sin(performance.now() * 0.00003) * dt * 0.002;
    G.uWindDir.value.set(Math.cos(this.windAngle), Math.sin(this.windAngle));
    G.uWind.value = s.wind;
    const cs = 6 + s.wind * 16;
    G.uCloudOffset.value.x -= G.uWindDir.value.x * cs * dt;
    G.uCloudOffset.value.y -= G.uWindDir.value.y * cs * dt;
    // wetness lags rain
    const wetT = s.rain > 0.1 ? 1 : 0;
    this.wetness += (wetT - this.wetness) * Math.min(1, dt / (wetT > this.wetness ? 35 : 110));
    G.uWetness.value = this.wetness;

    // lightning
    if (s.storm > 0.6) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.flash = 1;
        this.nextFlash = 7 + Math.random() * 20;
        this.audio?.thunder(250 + Math.random() * 3500);
      }
    }
    this.flash = Math.max(0, this.flash - dt * 3.2);
    const fl = this.flash > 0 ? this.flash * (0.6 + 0.4 * Math.sin(performance.now() * 0.05)) : 0;
    this.sky.uniforms.uFlash.value = fl;

    // light colours from the sky model
    const skyB = this.sky.uniforms.uSkyBright.value;
    const sd = this.sunDir;
    this.sun.color.copy(G.uSunColor.value);
    this.sun.intensity = sunI;
    const d = this._d;
    const zen = skyRadianceJS(d.set(0, 1, 0), sd, s.overcast, skyB, new THREE.Color());
    const side = skyRadianceJS(d.set(-sd.x, 0.35, -sd.z).normalize(), sd, s.overcast, skyB, new THREE.Color());
    const toward = skyRadianceJS(d.set(sd.x, 0.3, sd.z).normalize(), sd, s.overcast, skyB, new THREE.Color());
    const skyAvg = zen.clone().multiplyScalar(0.4).add(side.multiplyScalar(0.35)).add(toward.clone().multiplyScalar(0.25));
    // clouds brighten and grey the ambient
    const cloudAmb = new THREE.Color(0.55, 0.58, 0.62).multiplyScalar(skyB * (1 - s.dark * 0.55));
    skyAvg.lerp(cloudAmb, Math.min(1, s.cover * 0.55 + s.overcast * 0.4));
    this.hemi.color.copy(skyAvg);
    const bounce = new THREE.Color(0.16, 0.2, 0.07).multiplyScalar(sunI * Math.max(0.15, up) * 0.32 + 0.05).add(skyAvg.clone().multiplyScalar(0.25));
    this.hemi.groundColor.copy(bounce);
    this.hemi.intensity = Math.PI * 0.9 * (1 + fl * 2.5);
    // fog colours
    skyRadianceJS(d.set(-sd.x, 0.03, -sd.z).normalize(), sd, s.overcast, skyB, G.uFogColor.value);
    skyRadianceJS(d.set(sd.x, 0.03, sd.z).normalize(), sd, s.overcast, skyB, G.uFogSunColor.value);
    // thick fog takes the colour of the overcast horizon, so far hills fade into the sky instead of glowing
    // under a heavy rain deck the distance greys to the deck's own dark underside, not a lighter band
    const deckDark = 1 - 0.75 * Math.max(0, s.dark - 0.45);
    G.uFogColor.value.lerp(new THREE.Color(0.41, 0.43, 0.46).multiplyScalar(skyB * deckDark), Math.min(1, s.fog * 160 + s.overcast * 0.5));
    G.uFogSunColor.value.lerp(G.uFogColor.value, s.overcast * 0.7);
    this.sky.uniforms.uAmbTop.value.copy(zen).multiplyScalar(1.15).lerp(cloudAmb, s.overcast * 0.6);
    this.sky.uniforms.uAmbBottom.value.copy(bounce).multiplyScalar(0.8).add(new THREE.Color(0.05, 0.055, 0.06).multiplyScalar(skyB));
    // a thick deck is lit from inside by multiple scattering: its underside is only a little darker than its top
    this.sky.uniforms.uAmbBottom.value.lerp(this.sky.uniforms.uAmbTop.value.clone().multiplyScalar(0.72), s.overcast * 0.85);
  }

  get state() {
    return { ...this.s, wetness: this.wetness, daylight: this.daylight, name: this.target };
  }
}

const RAIN_VS = /* glsl */`
${COMMON_GLSL}
attribute vec4 aSeed;
uniform float uRain;
uniform float uBox;
varying float vA;
void main() {
  vec3 box = vec3(uBox, 26.0, uBox);
  float speed = 9.0 + aSeed.w * 3.0;
  vec3 vel = vec3(uWindDir.x * uWind * 4.0, -speed, uWindDir.y * uWind * 4.0);
  vec3 p = aSeed.xyz * box + vel * uTime;
  p = mod(p - cameraPosition + box * 0.5, box) + cameraPosition - box * 0.5;
  float on = step(aSeed.w, uRain);
  vec3 dir = normalize(vel);
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = normalize(cross(dir, toCam));
  float len = 0.55 + aSeed.w * 0.35;
  vec3 wp = p + dir * position.y * len + side * position.x * 0.009;
  vA = on * (0.12 + 0.14 * aSeed.w) * smoothstep(1.0, 4.0, length(p - cameraPosition));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const RAIN_FS = /* glsl */`
varying float vA;
uniform vec3 uRainCol;
void main() {
  if (vA < 0.01) discard;
  gl_FragColor = vec4(uRainCol, vA);
}
`;

export class Rain {
  constructor(count) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
    g.setIndex([0, 1, 2, 1, 3, 2]);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) seeds[i] = Math.random();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = count;
    this.uniforms = Object.assign({}, G, { uRain: { value: 0 }, uBox: { value: 34 }, uRainCol: { value: new THREE.Color(0.6, 0.63, 0.66) } });
    const m = new THREE.ShaderMaterial({ vertexShader: RAIN_VS, fragmentShader: RAIN_FS, uniforms: this.uniforms, transparent: true, depthWrite: false });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
  }
  update(rain, skyBright) {
    this.uniforms.uRain.value = rain;
    this.mesh.visible = rain > 0.01;
    this.uniforms.uRainCol.value.setRGB(0.55, 0.58, 0.62).multiplyScalar(0.5 + skyBright * 0.6);
  }
}
