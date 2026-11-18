// Shared GLSL, global uniforms and the material patcher used by every lit surface.
import * as THREE from 'three';

export const G = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
  uSunColor: { value: new THREE.Color(1, 0.95, 0.88) },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
  uWind: { value: 0.4 },
  uCloudCover: { value: 0.45 },
  uCloudOffset: { value: new THREE.Vector2() },
  uCloudShadow: { value: 0.75 },
  uWeatherMap: { value: null },
  uNoiseTex: { value: null },
  uFogColor: { value: new THREE.Color(0.62, 0.72, 0.85) },
  uFogSunColor: { value: new THREE.Color(1.0, 0.9, 0.75) },
  uFogDensity: { value: 0.00022 },
  uFogFalloff: { value: 1 / 420 },
  uMistDensity: { value: 0.03 },
  uWetness: { value: 0 },
  uCascadeSplits: { value: [12, 48, 180, 600] },
  uHeightTex: { value: null },
  uNormalTex: { value: null },
  uMaskTex: { value: null },
  uWorld: { value: new THREE.Vector4(2048, 2048, 1024, 0) }, // size, res, maskRes, -
  uCamPos: { value: new THREE.Vector3() },
  uAmbientScale: { value: 1 },
};

// GLSL helpers available to every patched material.
export const COMMON_GLSL = /* glsl */`
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec2 uWindDir;
uniform float uWind;
uniform float uCloudCover;
uniform vec2 uCloudOffset;
uniform float uCloudShadow;
uniform sampler2D uWeatherMap;
uniform sampler2D uNoiseTex;
uniform vec3 uFogColor;
uniform vec3 uFogSunColor;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uMistDensity;
uniform float uWetness;
uniform sampler2D uHeightTex;
uniform sampler2D uNormalTex;
uniform sampler2D uMaskTex;
uniform vec4 uWorld;
uniform vec3 uCamPos; // main view camera (cameraPosition is the light's camera in shadow passes)

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// Exact bilinear height lookup that matches the CPU sampler.
float terrainHeight(vec2 xz) {
  float size = uWorld.x, res = uWorld.y;
  vec2 f = (xz + size * 0.5) / (size / res) - 0.5;
  f = clamp(f, vec2(0.0), vec2(res - 1.001));
  ivec2 i = ivec2(floor(f));
  vec2 t = f - vec2(i);
  float a = texelFetch(uHeightTex, i, 0).r;
  float b = texelFetch(uHeightTex, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uHeightTex, i + ivec2(0, 1), 0).r;
  float d = texelFetch(uHeightTex, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
vec4 groundMask(vec2 xz) {
  return texture(uMaskTex, (xz + uWorld.x * 0.5) / uWorld.x);
}
vec3 terrainNormal(vec2 xz) {
  vec3 n = texture(uNormalTex, (xz + uWorld.x * 0.5) / uWorld.x).xyz * 2.0 - 1.0;
  return normalize(n);
}

// Wind: a slow travelling gust field plus a faster flutter.
vec2 windBend(vec2 xz, float phase) {
  float t = uTime;
  vec2 g = texture(uNoiseTex, xz * 0.0035 - uWindDir * t * 0.028).rg;
  float gust = smoothstep(0.25, 0.85, g.r);
  float wave = sin(dot(xz, uWindDir) * 0.11 - t * 1.7 + phase) * 0.5 + 0.5;
  float s = uWind * (0.25 + 0.75 * gust) * (0.55 + 0.45 * wave);
  vec2 side = vec2(-uWindDir.y, uWindDir.x) * (g.g - 0.5) * 0.6;
  return (uWindDir + side) * s;
}

// Cloud shadows: projects the point to the cloud layer along the sun ray.
float cloudShadowAt(vec3 wpos) {
  float sy = max(uSunDir.y, 0.12);
  vec2 p = wpos.xz + uSunDir.xz / sy * (1600.0 - wpos.y);
  vec2 uv = (p + uCloudOffset) / 15000.0;
  float c = texture(uWeatherMap, uv).r * 0.7 + texture(uWeatherMap, uv * 3.1 + 0.37).g * 0.3;
  float cov = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.3, c);
  return 1.0 - cov * uCloudShadow;
}

float fogLayer(float oy, float dy, float dist, float dens, float falloff, float base) {
  float a = dens * exp(-falloff * (oy - base));
  float k = falloff * dy * dist;
  float f = abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0;
  return a * dist * f;
}
vec3 applyFog(vec3 col, vec3 wpos) {
  vec3 ro = cameraPosition;
  vec3 rd = wpos - ro;
  float dist = length(rd);
  rd /= max(dist, 1e-4);
  float haze = fogLayer(ro.y, rd.y, dist, uFogDensity, uFogFalloff, 0.0);
  float mist = fogLayer(ro.y, rd.y, dist, uMistDensity, 1.0 / 22.0, -60.0);
  float ext = 1.0 - exp(-(haze + mist));
  float sunAmt = pow(max(dot(rd, uSunDir), 0.0), 6.0);
  vec3 fc = mix(uFogColor, uFogSunColor, sunAmt * 0.6);
  return mix(col, fc, ext);
}
`;

// Directional (sun) lighting with cascade selection. Replaces the directional block of three's chunk.
const DIR_BLOCK = /* glsl */`
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	getDirectionalLightInfo( directionalLights[ 0 ], directLight );
	float sunShadow = 1.0;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	{
		float vz = vViewPosition.z;
		float found = 0.0;
		DirectionalLightShadow dls;
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
			if ( found < 0.5 && vz < uCascadeSplits[ i ] ) {
				dls = directionalLightShadows[ i ];
				float s = getShadow( directionalShadowMap[ i ], dls.shadowMapSize, dls.shadowIntensity, dls.shadowBias, dls.shadowRadius, vDirectionalShadowCoord[ i ] );
				float fadeOut = smoothstep( uCascadeSplits[ i ] * 0.9, uCascadeSplits[ i ], vz );
				sunShadow = ( UNROLLED_LOOP_INDEX == NUM_DIR_LIGHT_SHADOWS - 1 ) ? mix( s, 1.0, fadeOut ) : s;
				found = 1.0;
			}
		}
		#pragma unroll_loop_end
		if ( !receiveShadow ) sunShadow = 1.0;
	}
	#endif
	#ifdef VERD
	sunShadow *= cloudShadowAt( vWPos );
	#endif
	#ifdef EXTRA_SHADOW
	sunShadow *= gExtraShadow;
	#endif
	#ifdef FOLIAGE_TRANS
	gSunUnsh = directLight.color; gSunSh = sunShadow;
	#endif
	directLight.color *= sunShadow;
	RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif
`;

let installed = false;
export function installChunks() {
  if (installed) return;
  installed = true;
  const c = THREE.ShaderChunk;
  const src = c.lights_fragment_begin;
  const a = src.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  const b = src.indexOf('#if ( NUM_RECT_AREA_LIGHTS > 0 )');
  if (a < 0 || b < 0) throw new Error('three.js lights chunk changed');
  c.lights_fragment_begin = src.slice(0, a) + DIR_BLOCK + '\n' + src.slice(b);
  c.lights_pars_begin = c.lights_pars_begin + '\nuniform float uCascadeSplits[ 4 ];\n';
}

const FOLIAGE_GLSL = /* glsl */`
uniform float uTranslucency;
uniform float uWrap;
void RE_Direct_Foliage( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = dot( geometryNormal, directLight.direction );
	float wrap = saturate( ( dotNL + uWrap ) / ( 1.0 + uWrap ) );
	float VdL = saturate( dot( -geometryViewDir, directLight.direction ) );
	float trans = pow( VdL, 3.0 ) * 0.75 + 0.25 * saturate( -dotNL );
	vec3 transCol = material.diffuseColor * vec3( 1.3, 1.5, 0.5 );
	// light scattered through stacked leaves still reaches leaves in shadow, so transmission sees a softened shadow
	vec3 transLight = gSunUnsh * mix( gSunSh, cloudShadowAt( vWPos ), 0.35 );
	reflectedLight.directDiffuse += directLight.color * wrap * BRDF_Lambert( material.diffuseColor ) + transLight * uTranslucency * trans * BRDF_Lambert( transCol );
	#ifdef FOLIAGE_SPEC
	vec3 H = normalize( directLight.direction + geometryViewDir );
	float sp = pow( saturate( dot( geometryNormal, H ) ), 48.0 ) * saturate( dotNL ) * FOLIAGE_SPEC;
	reflectedLight.directSpecular += directLight.color * sp;
	#endif
}
#undef RE_Direct
#define RE_Direct RE_Direct_Foliage
`;

const WET_GLSL = /* glsl */`
void RE_Direct_Wet( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	reflectedLight.directDiffuse += directLight.color * dotNL * BRDF_Lambert( material.diffuseColor );
	vec3 H = normalize( directLight.direction + geometryViewDir );
	float gloss = mix( 12.0, 90.0, gWet );
	float sp = pow( saturate( dot( geometryNormal, H ) ), gloss ) * dotNL * ( 0.04 + gWet * 0.5 ) * ( gloss + 2.0 ) / 8.0;
	reflectedLight.directSpecular += directLight.color * sp * gSpec;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Wet
`;

/**
 * Patch a MeshLambertMaterial / MeshStandardMaterial / MeshDepthMaterial.
 * o.vertexPars, o.vertexMain (sets vec3 pos, vec3 nrm from `position`/`normal`), o.fragmentPars,
 * o.fragmentColor (runs after map_fragment, may edit diffuseColor), o.fragmentNormal (sets `normal`),
 * o.ao (GLSL float expression), o.fragmentEnd, o.foliage {translucency, wrap}, o.wet, o.uniforms, o.defines
 */
export function patch(material, o = {}) {
  const isDepth = material.isMeshDepthMaterial || material.isMeshDistanceMaterial;
  material.defines = Object.assign(material.defines || {}, { VERD: '' }, o.defines || {});
  const uniforms = Object.assign({}, o.uniforms || {});
  if (o.foliage) {
    material.defines.FOLIAGE_TRANS = '';
    uniforms.uTranslucency = { value: o.foliage.translucency ?? 0.6 };
    uniforms.uWrap = { value: o.foliage.wrap ?? 0.5 };
    material.userData.foliageUniforms = uniforms;
  }
  material.onBeforeCompile = (shader) => {
    for (const k in G) shader.uniforms[k] = G[k];
    Object.assign(shader.uniforms, uniforms);
    let vs = shader.vertexShader, fs = shader.fragmentShader;
    vs = vs.replace('#include <common>', '#include <common>\n' + COMMON_GLSL + '\nvarying vec3 vWPos;\nvarying float vAO;\n' + (o.vertexPars || ''));
    const main = o.vertexMain || 'vec3 pos = position; vec3 nrm = normal; float ao = 1.0;';
    if (isDepth) {
      vs = vs.replace('#include <begin_vertex>', `vec3 transformed; { ${main} transformed = pos; }`);
    } else {
      vs = vs.replace('#include <beginnormal_vertex>', `${main}\nvec3 objectNormal = nrm;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif\nvAO = ao;`);
      vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = pos;');
    }
    vs = vs.replace('#include <project_vertex>', `#include <project_vertex>
      {
        vec4 vw = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
        vw = instanceMatrix * vw;
        #endif
        vWPos = ( modelMatrix * vw ).xyz;
      }
      ${o.vertexEnd || ''}`);

    fs = fs.replace('#include <common>', '#include <common>\n' + COMMON_GLSL + '\nvarying vec3 vWPos;\nvarying float vAO;\nfloat gWet = 0.0; float gSpec = 1.0;\n' + (o.fragmentPars || ''));
    if (o.fragmentColor) fs = fs.replace('#include <map_fragment>', '#include <map_fragment>\n' + o.fragmentColor);
    if (o.fragmentAlpha) fs = fs.replace('#include <alphatest_fragment>', o.fragmentAlpha);
    if (!isDepth) {
      if (o.fragmentNormal) {
        fs = fs.replace('#include <normal_fragment_begin>', `float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;\n${o.fragmentNormal}\nvec3 nonPerturbedNormal = normal;`);
        fs = fs.replace('#include <normal_fragment_maps>', '');
      }
      if (o.foliage) {
        fs = fs.replace('#include <lights_lambert_pars_fragment>', '#include <lights_lambert_pars_fragment>\nvec3 gSunUnsh = vec3( 0.0 ); float gSunSh = 1.0;\n' + FOLIAGE_GLSL);
        // skylight coming through the leaf from the far side
        fs = fs.replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
          #if NUM_HEMI_LIGHTS > 0
          irradiance += getHemisphereLightIrradiance( hemisphereLights[ 0 ], -geometryNormal ) * uTranslucency * 0.5 * vec3( 1.1, 1.3, 0.5 );
          #endif`);
      }
      else if (o.wet) fs = fs.replace('#include <lights_lambert_pars_fragment>', '#include <lights_lambert_pars_fragment>\n' + WET_GLSL);
      fs = fs.replace('#include <aomap_fragment>', `#include <aomap_fragment>
        {
          float aoF = clamp( vAO, 0.0, 1.0 ) * (${o.ao || '1.0'});
          reflectedLight.indirectDiffuse *= aoF;
          reflectedLight.indirectSpecular *= aoF;
        }`);
      // MSAA can shade a sample whose centre lies outside a thin triangle; its extrapolated varyings can be huge,
      // and bloom turns one such sample into a glowing square, so cap the output
      fs = fs.replace('#include <fog_fragment>', `${o.fragmentEnd || ''}\ngl_FragColor.rgb = applyFog( min( gl_FragColor.rgb, vec3( 40.0 ) ), vWPos );`);
    }
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
    if (o.onShader) o.onShader(shader);
  };
  material.customProgramCacheKey = () => (o.key || material.uuid);
  return material;
}

// Alpha-to-coverage friendly alpha: keeps foliage dense in the distance (mip-coverage fix).
export const ALPHA_SHARPEN = /* glsl */`
float sharpenAlpha(float a, vec2 uv, float texSize, float cutoff) {
  vec2 d = max(abs(dFdx(uv * texSize)), abs(dFdy(uv * texSize)));
  float lod = max(0.0, log2(max(d.x, d.y)));
  a *= 1.0 + lod * 0.28;
  return clamp((a - cutoff) / max(fwidth(a), 1e-4) + 0.5, 0.0, 1.0);
}
float sharpenAlpha2(float a, vec2 uv, vec2 texSize, float cutoff) {
  vec2 d = max(abs(dFdx(uv * texSize)), abs(dFdy(uv * texSize)));
  float lod = max(0.0, log2(max(d.x, d.y)));
  a *= 1.0 + lod * 0.3;
  return clamp((a - cutoff) / max(fwidth(a), 1e-4) + 0.5, 0.0, 1.0);
}
`;
