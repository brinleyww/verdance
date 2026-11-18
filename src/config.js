// Quality tiers. Every expensive system reads its budget from here.
const BASE = {
  terrainLevels: 8, lodBand: 5, dynRes: true, fxaa: false, bloom: true,
};

export const PRESETS = {
  low: {
    label: 'Low', renderScale: 0.7, maxPixelRatio: 1, msaa: 0, fxaa: true, bloom: false,
    shadows: 1, shadowRes: [1024], cascadeSplits: [38], cascadeEvery: [1],
    terrainM: 32, terrainBase: 1.5, terrainDetail: 1,
    grassDensity: 55, grassR0: 9, grassR1: 18, grassRadius: 30, grassSegs: 2, flowerDensity: 2.5,
    treeLod0: 26, treeLod1: 165, lodBand: 4, treeCap0: 260, treeCap1: 1400, leafScale: 0.7, impostorRes: 128, impostorFraction: 0.45,
    shrubDist: 28, shrubCap: 1500, shrubShadows: false, fernDist: 20, fernCap: 1500,
    rockLod0: 28, rockDetail: 2, rockCap0: 700, rockCap1: 5000, logDist: 70,
    cloudPano: [768, 256], cloudPhases: 16, cloudSteps: 20, cloudLightSteps: 3, cloudNoiseRes: 64, rainCount: 3000,
  },
  medium: {
    label: 'Medium', renderScale: 0.85, maxPixelRatio: 1, msaa: 0, fxaa: true, bloom: true,
    shadows: 2, shadowRes: [1536, 1024], cascadeSplits: [16, 95], cascadeEvery: [1, 3],
    terrainM: 48, terrainBase: 1, terrainDetail: 1,
    grassDensity: 95, grassR0: 14, grassR1: 30, grassRadius: 50, grassSegs: 3, flowerDensity: 4,
    treeLod0: 40, treeLod1: 300, treeCap0: 450, treeCap1: 2800, leafScale: 0.85, impostorRes: 256, impostorFraction: 0.7,
    shrubDist: 45, shrubCap: 3000, shrubShadows: false, fernDist: 32, fernCap: 3000,
    rockLod0: 45, rockDetail: 3, rockCap0: 1400, rockCap1: 7000, logDist: 110,
    cloudPano: [1280, 400], cloudPhases: 16, cloudSteps: 32, cloudLightSteps: 4, cloudNoiseRes: 96, rainCount: 6000,
  },
  high: {
    label: 'High', renderScale: 1, maxPixelRatio: 1.25, msaa: 4, fxaa: false, bloom: true,
    shadows: 3, shadowRes: [2048, 2048, 2048], cascadeSplits: [14, 56, 210], cascadeEvery: [1, 2, 4],
    terrainM: 64, terrainBase: 1, terrainDetail: 2,
    grassDensity: 150, grassR0: 22, grassR1: 45, grassRadius: 75, grassSegs: 4, flowerDensity: 6,
    treeLod0: 55, treeLod1: 480, treeCap0: 800, treeCap1: 5000, leafScale: 1, impostorRes: 512, impostorFraction: 1,
    shrubDist: 70, shrubCap: 6000, shrubShadows: true, fernDist: 50, fernCap: 6000,
    rockLod0: 70, rockDetail: 3, rockCap0: 2600, rockCap1: 9000, logDist: 160,
    cloudPano: [2048, 640], cloudPhases: 16, cloudSteps: 44, cloudLightSteps: 4, cloudNoiseRes: 128, rainCount: 12000,
  },
  ultra: {
    label: 'Ultra', renderScale: 1, maxPixelRatio: 2, msaa: 4, fxaa: false, bloom: true,
    shadows: 3, shadowRes: [4096, 4096, 2048], cascadeSplits: [16, 66, 260], cascadeEvery: [1, 2, 3],
    terrainM: 64, terrainBase: 0.5, terrainDetail: 2,
    grassDensity: 210, grassR0: 28, grassR1: 56, grassRadius: 95, grassSegs: 5, flowerDensity: 8,
    treeLod0: 80, treeLod1: 650, treeCap0: 1200, treeCap1: 7000, leafScale: 1.1, impostorRes: 512, impostorFraction: 1,
    shrubDist: 95, shrubCap: 9000, shrubShadows: true, fernDist: 70, fernCap: 9000,
    rockLod0: 100, rockDetail: 4, rockCap0: 3500, rockCap1: 9000, logDist: 220,
    cloudPano: [2560, 800], cloudPhases: 12, cloudSteps: 60, cloudLightSteps: 5, cloudNoiseRes: 128, rainCount: 16000,
  },
};

export function getPreset(name) {
  return Object.assign({ name }, BASE, PRESETS[name] || PRESETS.medium);
}

export function detectTier(gl) {
  let gpu = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '';
  } catch { /* hidden */ }
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const mem = navigator.deviceMemory || 8;
  let tier = 'medium';
  if (/RTX\s?(20|30|40|50)\d0|RX\s?(6[7-9]|7[6-9]|9[0-9])\d0|Radeon Pro W|Apple M\d (Pro|Max|Ultra)|Arc\(TM\) A7/i.test(gpu)) tier = 'high';
  else if (/GTX|RTX|Radeon RX|Apple M\d|Arc/i.test(gpu)) tier = 'medium';
  else if (/Intel|UHD|HD Graphics|Iris|Mali|Adreno|PowerVR|SwiftShader|llvmpipe|Basic Render|Vega \d|Radeon\(TM\) Graphics/i.test(gpu)) tier = 'low';
  if (mobile || mem <= 4) tier = 'low';
  return { tier, gpu, mobile };
}
