import * as THREE from 'three';
import { buildMultiScatterLUT } from './MultiScatterLUT.js';

/**
 * Atmosphere scattering parameters for a body.
 * Rayleigh + Mie atmospheric scattering parameters — all coefficients in 1/km.
 */
export interface AtmosphereParams {
  /**
   * Mie scattering coefficient (1/km). Scalar for wavelength-independent haze
   * (Earth-style gray aerosols), or [R, G, B] for wavelength-dependent dust
   * (Mars iron-oxide dust scatters longer wavelengths more efficiently).
   * Same forward-peaked phase function applies in either case.
   */
  mieCoeff: number | [number, number, number];
  /** Mie scale height in km. Controls how quickly haze falls off with altitude. */
  mieScaleHeight: number;
  /** Henyey-Greenstein asymmetry parameter g (-1 to 1). Negative = backscatter. */
  miePhaseAsymmetry: number;
  /** RGB Rayleigh scattering coefficients (1/km). Controls color — blue for Earth. */
  rayleighCoeff: [number, number, number];
  /** RGB absorption coefficients (1/km). Ozone absorbs red/green. */
  absorptionCoeff: [number, number, number];
  /**
   * Optional fractional inset on the analytic planet cap, in normalized shell
   * units (0..1). The shader caps view rays at radius `planetR - planetCapBias`
   * so that real terrain elevation above the reference ellipsoid doesn't leave
   * an unintegrated dark band at the horizon. Default 0; ~0.001 for Earth,
   * ~0.005 for Mars accommodates typical relief.
   */
  planetCapBias?: number;
}

/** Built-in atmosphere presets for solar system bodies */
const ATMOSPHERE_PRESETS: Record<string, AtmosphereParams> = {
  Earth: {
    mieCoeff: 0.0002,
    mieScaleHeight: 8.5,
    miePhaseAsymmetry: -0.7,
    rayleighCoeff: [0.0054, 0.0081, 0.0167],
    absorptionCoeff: [0.0027, 0.0017, 0.0002],
    planetCapBias: 0.001,
  },
  Mars: {
    // Mars's daytime sky color comes from suspended iron-oxide dust, not from
    // molecular scattering of the thin CO₂ atmosphere. The Mie component here
    // models that dust: ~5× the original mieCoeff for visible-band optical
    // depth in line with MSL/Curiosity sol observations, mildly forward-peaked
    // phase (the dust is not as tightly forward as a delta lobe), with
    // absorption biased toward blue so the multiply-scattered light comes
    // out salmon/butterscotch. The Rayleigh component is the (tiny) CO₂
    // contribution — kept so the model degrades gracefully if dust is zero.
    //
    // Phase asymmetry sign convention: our Schlick approximation peaks at
    // cosTheta = sign(k), and cosTheta = -1 corresponds to "looking at the
    // sun", so forward-peaked scattering needs g < 0 (k < 0) — same sign
    // as Earth's preset. Magnitude controls how narrow the peak is; we want
    // a moderate peak so off-sun directions still pick up dust color.
    // Mie: forward-peaked dust scattering, isotropic across RGB (a single
    // scalar represents the gray "scattering opacity" component).
    // rayleighCoeff: used here to add wavelength-dependent dust scattering on
    // top of Mie — real Mars dust scatters longer wavelengths preferentially
    // (R:G:B ≈ 1.0 : 0.78 : 0.62), and our scalar Mie can't capture that.
    // Pumping these in R>G>B gives the salmon/butterscotch character.
    // Absorption is strongly blue-biased (iron oxide) so long horizon paths
    // get an additional red shift.
    // Per-channel Mie models wavelength-dependent dust scattering directly —
    // Mars iron-oxide dust scatters R:G:B in roughly 1.0:0.84:0.71 ratio
    // (measured from Mars Pathfinder / MER imaging). Column OD ~0.5 matches
    // typical clear-sol Curiosity observations. Phase is forward-peaked
    // (g = -0.5) for the bright sun halo. Rayleigh is the tiny CO₂ component.
    // Absorption is mildly blue-biased (iron oxide) for additional red shift
    // on long horizon paths.
    // Tuned for our 8-sample single-scatter + 1-bounce-LUT approximation.
    // Mars's real column OD ~0.5 saturates T_view at sample 1 and dims the
    // horizon (and the sun-path T_sun is over-attenuated by the same effect),
    // so we run a lighter dust loading and lighter absorption — column OD
    // lands around 0.2, which produces a recognizable salmon sky with our
    // integration scheme. The R:G:B = 1.0:0.85:0.7 ratio for Mie matches
    // measured dust scattering ratios.
    mieCoeff: [0.018, 0.015, 0.012],
    mieScaleHeight: 11.0,
    miePhaseAsymmetry: -0.5,
    rayleighCoeff: [0.00002, 0.00005, 0.00012],
    absorptionCoeff: [0.0002, 0.0010, 0.0030],
    planetCapBias: 0.005,
  },
  Titan: {
    mieCoeff: 0.0040,
    mieScaleHeight: 50.0,
    miePhaseAsymmetry: -0.4,
    // Titan's thick tholin haze: warm orange, almost no blue Rayleigh
    rayleighCoeff: [0.0035, 0.0015, 0.0004],
    // Heavy blue absorption from methane/tholins
    absorptionCoeff: [0.0005, 0.0015, 0.0050],
  },
  Venus: {
    mieCoeff: 0.0050,
    mieScaleHeight: 15.0,
    miePhaseAsymmetry: -0.6,
    rayleighCoeff: [0.0080, 0.0060, 0.0030],
    absorptionCoeff: [0.0040, 0.0030, 0.0010],
  },
  Jupiter: {
    mieCoeff: 0.0030,
    mieScaleHeight: 27.0,
    miePhaseAsymmetry: -0.6,
    rayleighCoeff: [0.0040, 0.0030, 0.0015],
    absorptionCoeff: [0.0010, 0.0008, 0.0003],
  },
  Saturn: {
    mieCoeff: 0.0025,
    mieScaleHeight: 60.0,
    miePhaseAsymmetry: -0.5,
    rayleighCoeff: [0.0035, 0.0028, 0.0015],
    absorptionCoeff: [0.0008, 0.0006, 0.0002],
  },
  Uranus: {
    mieCoeff: 0.0015,
    mieScaleHeight: 27.0,
    miePhaseAsymmetry: -0.6,
    // Methane absorption gives cyan/blue color
    rayleighCoeff: [0.0010, 0.0030, 0.0060],
    absorptionCoeff: [0.0030, 0.0010, 0.0002],
  },
  Neptune: {
    mieCoeff: 0.0015,
    mieScaleHeight: 20.0,
    miePhaseAsymmetry: -0.6,
    // Deep blue from methane absorption
    rayleighCoeff: [0.0008, 0.0025, 0.0070],
    absorptionCoeff: [0.0040, 0.0012, 0.0002],
  },
  Pluto: {
    mieCoeff: 0.0001,
    mieScaleHeight: 50.0,
    miePhaseAsymmetry: -0.7,
    rayleighCoeff: [0.0003, 0.0004, 0.0006],
    absorptionCoeff: [0.0001, 0.0001, 0.0001],
  },
  Triton: {
    mieCoeff: 0.0001,
    mieScaleHeight: 8.0,
    miePhaseAsymmetry: -0.7,
    rayleighCoeff: [0.0002, 0.0003, 0.0005],
    absorptionCoeff: [0.0001, 0.0001, 0.0001],
  },
};

// ln(0.0005) ≈ -7.60 — atmosphere extends to where density = 0.05% of surface.
// Wider than the typical 5% threshold for a more visible limb glow from orbital distance.
const LOG_EXTINCTION_THRESHOLD = Math.log(0.0005);

/** Normalize a scalar-or-vec3 mieCoeff to a [R, G, B] tuple. */
function mieVec3(m: number | [number, number, number]): [number, number, number] {
  return typeof m === 'number' ? [m, m, m] : m;
}

// ---- GLSL Shaders ----
// Per-VERTEX single-scatter ray-march (Cesium-style sky atmosphere). The
// proxy sphere is tessellated 128×64 → ~8K vertices; each vertex casts a ray
// from the camera through itself, integrates Rayleigh + Mie inscatter + the
// all-bounce multi-scatter ambient from the LUT (Hillaire 2020 §6.3), and
// outputs the result as varyings. The fragment shader does a Reinhard
// tone-map and outputs the interpolated values plus a per-pixel sun-glare
// add-on for the sharp solar disk highlight that vertex interpolation can't
// resolve.
//
// Cost vs. per-fragment ray-march: ~8K vertices × 8 samples = 64K iterations
// per frame vs. millions of per-pixel iterations — typically 100-200× cheaper.
// Tradeoff: the limb gradient is interpolated across triangle edges, so it
// looks slightly softer than the per-pixel version. Acceptable for our
// mission-vis fidelity bar; if too soft we can bump the tessellation.

const atmosphereVertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

uniform float planetR;
uniform float planetCapBias;
uniform vec3  mieCoeff;
uniform float invScaleH;
uniform float mieK;
uniform vec3  rayleighCoeff;
uniform vec3  extinctionCoeff;

uniform mat4 invModelMat;
uniform vec3 lightDir;
uniform vec3 lightColor;
uniform sampler2D uMultiScatterLUT;

uniform vec3  uSunWorldPos;
uniform float uSunRadius;
uniform vec3  uShadowOccluderPos[4];
uniform float uShadowOccluderRadius[4];
uniform float uShadowOccluderCount;
uniform vec3  uPlanetWorldPos;
uniform float uShellSceneScale;

varying vec3  vColor;       // tone-mapped scattered color (linear → display via Reinhard in frag)
varying float vAlpha;       // view-ray transmittance (atmosphere alpha for blend)
varying float vCosTheta;    // dot(-viewDir, sunDir) for per-pixel sun glare
varying float vDiscAtm;     // for discarding fragments outside the atmosphere shell
varying vec3  vObjPos;      // proxy-sphere position; needed by the per-fragment fallback path

#define NUM_SAMPLES 8

float computeAtmEclipseShadow(vec3 samplePos) {
  vec3 worldPos = uPlanetWorldPos + samplePos * uShellSceneScale;
  vec3 toSun = uSunWorldPos - worldPos;
  float distToSun = length(toSun);
  if (distToSun < 1e-20) return 1.0;
  vec3 rayDir = toSun / distToSun;
  float shadowFactor = 1.0;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uShadowOccluderCount) break;
    vec3 toOcc = uShadowOccluderPos[i] - worldPos;
    float t = dot(toOcc, rayDir);
    if (t < 1e-10 || t > distToSun) continue;
    float closestDist = length(toOcc - rayDir * t);
    float innerR = max(0.0, uShadowOccluderRadius[i] - uSunRadius * (t / distToSun));
    float outerR = uShadowOccluderRadius[i] + uSunRadius * (t / distToSun);
    if (closestDist > outerR) continue;
    shadowFactor *= smoothstep(innerR, outerR, closestDist);
  }
  return shadowFactor;
}

void main() {
  vObjPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>

  // Ray-march from the camera through this proxy-sphere vertex.
  vec3 eyePos = (invModelMat * vec4(cameraPosition, 1.0)).xyz;
  vec3 viewDir = normalize(position - eyePos);

  // Atmosphere shell intersection.
  float bHalf = dot(eyePos, viewDir);
  float c = dot(eyePos, eyePos) - 1.0;
  float discAtm = bHalf * bHalf - c;
  vDiscAtm = discAtm;
  vCosTheta = dot(-viewDir, lightDir);

  if (discAtm < 0.0) {
    vColor = vec3(0.0);
    vAlpha = 1.0;
    return;
  }
  float sqrtDiscAtm = sqrt(discAtm);
  float tEnter = max(-bHalf - sqrtDiscAtm, 0.0);
  float tExit  = -bHalf + sqrtDiscAtm;

  // Cap at planet hit so samples don't traverse the planet's interior.
  // Use a smoothstep blend across the silhouette so the path length varies
  // continuously between "ray misses planet" (full atm path → bright limb)
  // and "ray hits planet" (truncated path → dimmer). Without this, adjacent
  // proxy vertices straddling the silhouette have wildly different path
  // lengths and the linear interpolation produces visible blob artifacts.
  // The fudged blend region only affects fragments inside the body silhouette
  // which the body mesh occludes anyway.
  float effectivePlanetR = max(0.0, planetR - planetCapBias);
  float cPlanet = dot(eyePos, eyePos) - effectivePlanetR * effectivePlanetR;
  float discPlanet = bHalf * bHalf - cPlanet;
  float tEnd = tExit;
  if (discPlanet > 0.0) {
    float tPlanet = -bHalf - sqrt(discPlanet);
    if (tPlanet > tEnter) {
      // Wider blend (0.0..0.1) than before — the transition spreads further
      // around the silhouette so adjacent vertices have closer path lengths
      // and the linear-interpolated triangles look smoother. The transition
      // region is body-occluded by the body mesh at the fragment level, so
      // the fudged intermediate path lengths aren't directly visible.
      float blendT = smoothstep(0.0, 0.1, discPlanet);
      tEnd = mix(tExit, tPlanet, blendT);
    }
  }
  float pathLen = tEnd - tEnter;
  if (pathLen <= 0.0) {
    vColor = vec3(0.0);
    vAlpha = 1.0;
    return;
  }
  float stepLen = pathLen / float(NUM_SAMPLES);

  float phMie = (1.0 - mieK * mieK)
              / ((1.0 - mieK * vCosTheta) * (1.0 - mieK * vCosTheta));
  float phRayleigh = 0.75 * (1.0 + vCosTheta * vCosTheta);
  vec3  scatteringPhase    = phRayleigh * rayleighCoeff + phMie * mieCoeff;
  vec3  scatteringSumCoeff = rayleighCoeff + mieCoeff;

  vec3  totalInscatter = vec3(0.0);
  float totalOptDepth  = 0.0;

  for (int i = 0; i < NUM_SAMPLES; i++) {
    float t = tEnter + (float(i) + 0.5) * stepLen;
    vec3 samplePos = eyePos + t * viewDir;
    float r = length(samplePos);
    float altitude = max(0.0, r - planetR);
    float density  = exp(-altitude * invScaleH);
    totalOptDepth += density * stepLen;

    vec3  upLocal = (r > 1e-6) ? samplePos / r : vec3(0.0, 1.0, 0.0);
    float cosLit  = dot(upLocal, lightDir);
    float hemiFade = smoothstep(-0.35, 0.15, cosLit);
    float shadow   = min(hemiFade, computeAtmEclipseShadow(samplePos));

    float sRq = dot(samplePos, lightDir);
    float sQq = dot(samplePos, samplePos) - 1.0;
    float sD2 = sRq * sRq - sQq;
    float sunDist = (sD2 > 0.0) ? max(0.0, -sRq + sqrt(sD2)) : 0.0;
    vec3 T_view = exp(-extinctionCoeff * totalOptDepth);
    vec3 T_sun  = exp(-extinctionCoeff * density * sunDist * 0.5);

    vec3 ssContrib = T_view * T_sun * shadow * density * stepLen * scatteringPhase;
    vec2 lutUV = vec2(cosLit * 0.5 + 0.5, altitude / max(1e-6, 1.0 - planetR));
    vec3 psi   = texture2D(uMultiScatterLUT, lutUV).rgb;
    vec3 msContrib = T_view * psi * scatteringSumCoeff * density * stepLen * shadow;

    totalInscatter += ssContrib + msContrib;
  }

  vec3 color = lightColor * totalInscatter;
  // Reinhard tone mapping — keeps bright limb pixels from clipping to white
  // when CustomBlending bypasses the renderer's tone-mapping pass.
  color = color / (1.0 + color);

  vec3 viewEx = exp(-extinctionCoeff * totalOptDepth);
  float alpha = dot(viewEx, vec3(0.3333));

  vColor = color;
  vAlpha = alpha;
}
`;

const atmosphereFragmentShader = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>

uniform float planetR;
uniform float planetCapBias;
uniform vec3  mieCoeff;
uniform float invScaleH;
uniform float mieK;
uniform vec3  rayleighCoeff;
uniform vec3  extinctionCoeff;

uniform mat4 invModelMat;
uniform vec3 lightDir;
uniform vec3 lightColor;
uniform sampler2D uMultiScatterLUT;

uniform vec3  uSunWorldPos;
uniform float uSunRadius;
uniform vec3  uShadowOccluderPos[4];
uniform float uShadowOccluderRadius[4];
uniform float uShadowOccluderCount;
uniform vec3  uPlanetWorldPos;
uniform float uShellSceneScale;

/** 1.0 when camera is inside the atm shell (use cheap per-vertex), 0.0 when
 *  outside (do per-fragment ray-march so the silhouette is crisp). Per-vertex
 *  interpolation breaks at the silhouette because adjacent proxy vertices
 *  have qualitatively different path lengths (planet-hit vs planet-miss); from
 *  orbit the proxy covers <5% of screen so per-fragment is cheap there. */
uniform float uCameraInsideShell;

varying vec3  vColor;
varying float vAlpha;
varying float vCosTheta;
varying float vDiscAtm;
varying vec3  vObjPos;

#define NUM_SAMPLES 8

float computeAtmEclipseShadow(vec3 samplePos) {
  vec3 worldPos = uPlanetWorldPos + samplePos * uShellSceneScale;
  vec3 toSun = uSunWorldPos - worldPos;
  float distToSun = length(toSun);
  if (distToSun < 1e-20) return 1.0;
  vec3 rayDir = toSun / distToSun;
  float shadowFactor = 1.0;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uShadowOccluderCount) break;
    vec3 toOcc = uShadowOccluderPos[i] - worldPos;
    float t = dot(toOcc, rayDir);
    if (t < 1e-10 || t > distToSun) continue;
    float closestDist = length(toOcc - rayDir * t);
    float innerR = max(0.0, uShadowOccluderRadius[i] - uSunRadius * (t / distToSun));
    float outerR = uShadowOccluderRadius[i] + uSunRadius * (t / distToSun);
    if (closestDist > outerR) continue;
    shadowFactor *= smoothstep(innerR, outerR, closestDist);
  }
  return shadowFactor;
}

void main() {
  #include <logdepthbuf_fragment>

  // Cheap path: camera inside the shell. Use the per-vertex result.
  if (uCameraInsideShell > 0.5) {
    if (vDiscAtm < 0.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    vec3 color = vColor;
    float alpha = vAlpha;
    // Per-pixel sun-glare add-on so the solar disk highlight isn't smeared
    // by vertex interpolation.
    float sunCos = max(0.0, vCosTheta);
    float sunSpike = pow(sunCos, 256.0);
    color += lightColor * sunSpike * 0.15 * (1.0 - alpha);
    gl_FragColor = vec4(color, alpha);
    return;
  }

  // Per-fragment path: camera outside the shell. The silhouette is a sharp
  // angular feature; vertex interpolation breaks here, so ray-march per pixel.
  // The proxy sphere covers only the limb ring on screen, so this is cheap.
  vec3 eyePos = (invModelMat * vec4(cameraPosition, 1.0)).xyz;
  vec3 surfacePos = normalize(vObjPos) * 1.15;
  vec3 viewDir = normalize(surfacePos - eyePos);

  float bHalf = dot(eyePos, viewDir);
  float c = dot(eyePos, eyePos) - 1.0;
  float discAtm = bHalf * bHalf - c;
  if (discAtm < 0.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float sqrtDiscAtm = sqrt(discAtm);
  float tEnter = max(-bHalf - sqrtDiscAtm, 0.0);
  float tExit  = -bHalf + sqrtDiscAtm;

  float effectivePlanetR = max(0.0, planetR - planetCapBias);
  float cPlanet = dot(eyePos, eyePos) - effectivePlanetR * effectivePlanetR;
  float discPlanet = bHalf * bHalf - cPlanet;
  float tEnd = tExit;
  if (discPlanet > 0.0) {
    float tPlanet = -bHalf - sqrt(discPlanet);
    if (tPlanet > tEnter) tEnd = tPlanet;
  }
  float pathLen = tEnd - tEnter;
  if (pathLen <= 0.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float stepLen = pathLen / float(NUM_SAMPLES);

  float cosTheta = dot(-viewDir, lightDir);
  float phMie = (1.0 - mieK * mieK)
              / ((1.0 - mieK * cosTheta) * (1.0 - mieK * cosTheta));
  float phRayleigh = 0.75 * (1.0 + cosTheta * cosTheta);
  vec3  scatteringPhase    = phRayleigh * rayleighCoeff + phMie * mieCoeff;
  vec3  scatteringSumCoeff = rayleighCoeff + mieCoeff;

  vec3  totalInscatter = vec3(0.0);
  float totalOptDepth  = 0.0;

  for (int i = 0; i < NUM_SAMPLES; i++) {
    float t = tEnter + (float(i) + 0.5) * stepLen;
    vec3 samplePos = eyePos + t * viewDir;
    float r = length(samplePos);
    float altitude = max(0.0, r - planetR);
    float density  = exp(-altitude * invScaleH);
    totalOptDepth += density * stepLen;

    vec3  upLocal = (r > 1e-6) ? samplePos / r : vec3(0.0, 1.0, 0.0);
    float cosLit  = dot(upLocal, lightDir);
    float hemiFade = smoothstep(-0.35, 0.15, cosLit);
    float shadow   = min(hemiFade, computeAtmEclipseShadow(samplePos));

    float sRq = dot(samplePos, lightDir);
    float sQq = dot(samplePos, samplePos) - 1.0;
    float sD2 = sRq * sRq - sQq;
    float sunDist = (sD2 > 0.0) ? max(0.0, -sRq + sqrt(sD2)) : 0.0;
    vec3 T_view = exp(-extinctionCoeff * totalOptDepth);
    vec3 T_sun  = exp(-extinctionCoeff * density * sunDist * 0.5);

    vec3 ssContrib = T_view * T_sun * shadow * density * stepLen * scatteringPhase;
    vec2 lutUV = vec2(cosLit * 0.5 + 0.5, altitude / max(1e-6, 1.0 - planetR));
    vec3 psi   = texture2D(uMultiScatterLUT, lutUV).rgb;
    vec3 msContrib = T_view * psi * scatteringSumCoeff * density * stepLen * shadow;

    totalInscatter += ssContrib + msContrib;
  }

  vec3 color = lightColor * totalInscatter;
  color = color / (1.0 + color);

  vec3 viewEx = exp(-extinctionCoeff * totalOptDepth);
  float alpha = dot(viewEx, vec3(0.3333));

  // Smooth outer atmosphere boundary so the proxy-sphere silhouette doesn't
  // pop in/out at sub-pixel level.
  float edgeFade = smoothstep(0.0, 0.001, discAtm);
  color *= edgeFade;
  alpha  = mix(1.0, alpha, edgeFade);

  gl_FragColor = vec4(color, alpha);
}
`;

/**
 * Atmosphere shell mesh. Renders a front-face sphere slightly larger than
 * the body, ray-marching Rayleigh + Mie scattering inward from each fragment.
 *
 * Must be positioned at the body center and scaled with the body.
 * Call `update()` each frame with camera and sun positions.
 */
export class AtmosphereMesh extends THREE.Mesh {
  /** Planet radius in km */
  readonly planetRadius: number;
  /** Atmosphere shell radius in km */
  readonly shellRadius: number;
  /** Atmosphere parameters used for cheap CPU brightness estimation and AP uniform setup. */
  readonly params: AtmosphereParams;
  /** Most recent normalized camera altitude (0 surface, 1 at/above shell). */
  private _camAltitudeNorm = 1;
  /** Most recent local sun direction (object space). */
  private readonly _sunLocal = new THREE.Vector3();
  /** Most recent local camera direction (object space, normalized). */
  private readonly _camDirLocal = new THREE.Vector3();

  private readonly _invModelMatrix = new THREE.Matrix4();
  private readonly _lightLocal = new THREE.Vector3();
  private readonly _camLocal = new THREE.Vector3();

  constructor(planetRadius: number, params: AtmosphereParams, renderer?: THREE.WebGLRenderer) {
    const shellRadius = planetRadius + -params.mieScaleHeight * LOG_EXTINCTION_THRESHOLD;

    // High tessellation: per-vertex inscatter is interpolated across triangle
    // edges; the inscatter function is highly non-linear in view direction
    // (especially near the planet silhouette where path length jumps), so we
    // need many segments to keep interpolation triangles below the human-
    // visible angular threshold. 1024×512 gives ~0.35°/segment at the equator.
    // Total vertices ~525K — vertex-shader cost ~4M ray-march iterations per
    // frame, still well below the per-fragment cost over a screen-covering
    // proxy (which would be ~16M for a 2M-pixel proxy at 8 samples).
    const geometry = new THREE.SphereGeometry(1.15, 1024, 512);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        planetR:        { value: 0 },
        planetCapBias:  { value: 0 },
        mieCoeff:       { value: new THREE.Vector3() },
        invScaleH:      { value: 0 },
        mieK:           { value: 0 },
        rayleighCoeff:  { value: new THREE.Vector3() },
        scatterCoeffSum:{ value: new THREE.Vector3() },
        extinctionCoeff:{ value: new THREE.Vector3() },
        invModelMat:    { value: new THREE.Matrix4() },
        lightDir:       { value: new THREE.Vector3(1, 0, 0) },
        lightColor:     { value: new THREE.Vector3(1, 1, 1) },
        uMultiScatterLUT: { value: null as THREE.Texture | null },
        uCameraInsideShell:    { value: 0.0 },
        uSunWorldPos:          { value: new THREE.Vector3() },
        uSunRadius:            { value: 0 },
        uShadowOccluderPos:    { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
        uShadowOccluderRadius: { value: new Float32Array(4) },
        uShadowOccluderCount:  { value: 0.0 },
        uPlanetWorldPos:       { value: new THREE.Vector3() },
        uShellSceneScale:      { value: 1.0 },
      },
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Custom blend: finalColor = src * 1 + dst * srcAlpha
      // Inscattered light additive, background dimmed by transmittance
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.SrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      // BackSide only — visible at the limb (where the planet doesn't
      // depth-occlude) but invisible across the disc. Combined with the
      // altitude-fadeout on `uAPStrength` in UniverseRenderer, this leaves
      // the planet's disc untinted by atmospheric scattering at orbital
      // distance — the day/night terminator is a sharp Lambert cutoff with
      // no warm Rayleigh-extinction band like real orbital photos show.
      //
      // TODO(disc-terminator-tint): switch to DoubleSide and branch the
      // fragment shader on `gl_FrontFacing`. Front-face path ray-traces from
      // camera toward planet surface, integrates inscatter along the
      // in-atmosphere segment, discards on rays that miss the planet (leaves
      // that area to the back-face limb pass). Adds warm color on the disc
      // at orbital views without re-introducing the AP altitude fadeout —
      // multi-body-safe, no hardcoded altitude constants. See
      // ~/code/claude-plans/cosmolabe/atmosphere-disc-tint.md.
      side: THREE.BackSide,
    });

    super(geometry, material);
    this.planetRadius = planetRadius;
    this.shellRadius = shellRadius;
    this.params = params;
    this.frustumCulled = false;
    // Render after trajectory lines so the atmosphere blends over them
    // (prevents orbit arcs from appearing as dark lines through the glow)
    this.renderOrder = 1000;

    this.setAtmosphereUniforms(params, planetRadius, shellRadius);

    // Build the multi-scattering LUT if a renderer was provided. This is a
    // one-time render-to-texture cost per AtmosphereMesh instance — the
    // resulting 32×32 RGB texture encodes all-bounce scattering as a function
    // of (cos sun zenith, altitude) and is sampled per-fragment during
    // ray-march. Without it, the shader falls back to single-scatter only
    // (zenith goes black inside thick atmospheres).
    if (renderer) {
      this._lutTexture = buildMultiScatterLUT(renderer, params, planetRadius, shellRadius);
      (this.material as THREE.ShaderMaterial).uniforms.uMultiScatterLUT.value = this._lutTexture;
    }
  }

  /** Multi-scattering LUT texture (or null if no renderer was passed at construction). */
  private _lutTexture: THREE.Texture | null = null;
  /** Expose the LUT so AerialPerspective uniforms on the same body share it. */
  get multiScatterLUT(): THREE.Texture | null { return this._lutTexture; }

  /**
   * Update per-frame uniforms: camera position, light direction, and optional eclipse shadow.
   * Positions in scene world space.
   */
  update(
    cameraWorldPos: THREE.Vector3,
    sunWorldPos: THREE.Vector3,
    occluders?: { pos: THREE.Vector3; radius: number }[],
    planetWorldPos?: THREE.Vector3,
    sunRadius?: number,
    shellSceneScale?: number,
  ): void {
    const u = (this.material as THREE.ShaderMaterial).uniforms;

    this._invModelMatrix.copy(this.matrixWorld).invert();
    u.invModelMat.value.copy(this._invModelMatrix);

    this._lightLocal.copy(sunWorldPos).applyMatrix4(this._invModelMatrix).normalize();
    u.lightDir.value.copy(this._lightLocal);

    // Cache camera altitude + local-space directions for getDaytimeSkyBrightness()
    // (CPU-side StarField fade) and AP strength gating (UniverseRenderer).
    // Object space: shell = 1.0, planet = planetR. Normalized altitude is 0 at
    // surface, 1 at the shell, > 1 outside.
    this._camLocal.copy(cameraWorldPos).applyMatrix4(this._invModelMatrix);
    const camObjR = this._camLocal.length();
    const planetR = u.planetR.value as number;
    const altitudeNorm = (camObjR - planetR) / Math.max(1e-6, 1.0 - planetR);
    this._camAltitudeNorm = Math.max(0, Math.min(1, altitudeNorm));
    // Pick shader path: cheap per-vertex when camera is inside the atm shell
    // (where the proxy covers most of the screen), per-fragment when outside
    // (where only the limb is visible and the silhouette needs crisp detail).
    u.uCameraInsideShell.value = (camObjR < 1.0) ? 1.0 : 0.0;
    if (camObjR > 1e-6) this._camDirLocal.copy(this._camLocal).divideScalar(camObjR);
    else this._camDirLocal.set(0, 1, 0);
    this._sunLocal.copy(this._lightLocal);

    if (occluders && planetWorldPos != null && shellSceneScale != null) {
      u.uSunWorldPos.value.copy(sunWorldPos);
      u.uSunRadius.value = sunRadius ?? 0;
      u.uPlanetWorldPos.value.copy(planetWorldPos);
      u.uShellSceneScale.value = shellSceneScale;
      const count = Math.min(occluders.length, 4);
      u.uShadowOccluderCount.value = count;
      for (let i = 0; i < count; i++) {
        u.uShadowOccluderPos.value[i].copy(occluders[i].pos);
        u.uShadowOccluderRadius.value[i] = occluders[i].radius;
      }
    } else {
      u.uShadowOccluderCount.value = 0;
    }
  }

  /**
   * Cheap CPU proxy for daytime sky brightness at the camera, in 0..1.
   * Returns 0 when the camera is at/above the shell (no atmosphere overhead),
   * or when the sun is below the local horizon (night). Uses the cached state
   * from the most recent update() call — no SPICE access, no GPU readback.
   *
   * Used to fade the StarField when the camera is under a sunlit atmosphere.
   */
  getDaytimeSkyBrightness(): number {
    // Outside the shell — sky doesn't fade stars (orbital view).
    if (this._camAltitudeNorm >= 1) return 0;
    // Sun above horizon: max(0, dot(camera-up, sun-dir)) in local space.
    const sunUp = Math.max(0, this._camDirLocal.dot(this._sunLocal));
    if (sunUp <= 0) return 0;
    // Atmosphere transmittance through one full thickness — luminous coupling.
    // This also encodes per-body color: a thick atmosphere (Earth) blocks more
    // stars at noon than a thin one (Mars), per its preset extinction.
    const R = this.shellRadius;
    const ext = this.params.rayleighCoeff[0] + this.params.absorptionCoeff[0]
              + this.params.rayleighCoeff[1] + this.params.absorptionCoeff[1]
              + this.params.rayleighCoeff[2] + this.params.absorptionCoeff[2];
    const mieRGB = mieVec3(this.params.mieCoeff);
    const mieAvg = (mieRGB[0] + mieRGB[1] + mieRGB[2]) / 3;
    const totalExt = (ext / 3) * R + mieAvg * R;
    const opacity = 1 - Math.exp(-totalExt);
    // Fade toward 0 as camera rises from surface to shell.
    const altFade = 1 - this._camAltitudeNorm;
    return sunUp * opacity * altFade;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.material as THREE.Material).dispose();
    this._lutTexture?.dispose();
  }

  private setAtmosphereUniforms(
    atm: AtmosphereParams,
    planetRadius: number,
    shellRadius: number,
  ): void {
    const u = (this.material as THREE.ShaderMaterial).uniforms;
    const R = shellRadius;

    // All coefficients scaled by shellRadius so shader math works in normalized space.
    // mieCoeff is wavelength-dependent (vec3) — Mars-style iron-oxide dust scatters
    // longer wavelengths more efficiently. For wavelength-independent haze (Earth),
    // a scalar input expands to (m, m, m).
    const mieRGB = mieVec3(atm.mieCoeff);
    const tMie: [number, number, number] = [
      mieRGB[0] * R,
      mieRGB[1] * R,
      mieRGB[2] * R,
    ];
    const tRay: [number, number, number] = [
      atm.rayleighCoeff[0] * R,
      atm.rayleighCoeff[1] * R,
      atm.rayleighCoeff[2] * R,
    ];
    const tAbs: [number, number, number] = [
      atm.absorptionCoeff[0] * R,
      atm.absorptionCoeff[1] * R,
      atm.absorptionCoeff[2] * R,
    ];

    u.planetR.value = planetRadius / R;
    u.planetCapBias.value = atm.planetCapBias ?? 0;
    u.mieCoeff.value.set(tMie[0], tMie[1], tMie[2]);
    u.invScaleH.value = R / atm.mieScaleHeight;

    // Schlick approximation: k = 1.55g - 0.55g³
    const g = atm.miePhaseAsymmetry;
    u.mieK.value = 1.55 * g - 0.55 * g * g * g;

    u.rayleighCoeff.value.set(tRay[0], tRay[1], tRay[2]);

    const scatterSum: [number, number, number] = [
      tRay[0] + tMie[0],
      tRay[1] + tMie[1],
      tRay[2] + tMie[2],
    ];
    u.scatterCoeffSum.value.set(scatterSum[0], scatterSum[1], scatterSum[2]);
    u.extinctionCoeff.value.set(
      scatterSum[0] + tAbs[0],
      scatterSum[1] + tAbs[1],
      scatterSum[2] + tAbs[2],
    );
  }
}

/**
 * Resolve atmosphere parameters from a catalog field value.
 * Supports:
 *   - Preset name string: "Earth", "Mars", "Titan", "Venus"
 *   - Cosmographia .atmscat file reference (maps to preset by body name,
 *     or parsed from binary if atmscatResolver is provided)
 *   - Inline object with AtmosphereParams fields
 *   - Boolean true: use preset for the body name
 *
 * Cosmographia .atmscat binary files are NOT directly compatible with our ray-march
 * shader — they contain coefficients scaled for precomputed lookup tables. Instead,
 * .atmscat references are resolved to built-in presets by body name. For custom
 * atmospheres, use inline parameters in the catalog.
 */
export function resolveAtmosphereParams(
  value: unknown,
  bodyName?: string,
): AtmosphereParams | null {
  if (!value) return null;

  // Boolean true: use preset if available, otherwise generic Earth-like atmosphere
  if (value === true) {
    if (bodyName && ATMOSPHERE_PRESETS[bodyName]) return ATMOSPHERE_PRESETS[bodyName];
    return ATMOSPHERE_PRESETS.Earth;
  }

  // String: preset name or .atmscat file reference
  if (typeof value === 'string') {
    // Try direct preset match
    if (ATMOSPHERE_PRESETS[value]) return ATMOSPHERE_PRESETS[value];

    // Try extracting body name from .atmscat path (e.g. "earth.atmscat" → "Earth")
    const baseName = value.replace(/\.atmscat$/i, '');
    const capitalized = baseName.charAt(0).toUpperCase() + baseName.slice(1).toLowerCase();
    if (ATMOSPHERE_PRESETS[capitalized]) return ATMOSPHERE_PRESETS[capitalized];

    // Try body name
    if (bodyName && ATMOSPHERE_PRESETS[bodyName]) return ATMOSPHERE_PRESETS[bodyName];

    console.warn(`[Cosmolabe] No atmosphere preset for "${value}" (body: ${bodyName ?? 'unknown'}). Use inline params: { mieCoeff, mieScaleHeight, rayleighCoeff, ... }`);
    return null;
  }

  // Object: inline parameters
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    const mieValid = typeof obj.mieCoeff === 'number'
                  || (Array.isArray(obj.mieCoeff) && obj.mieCoeff.length === 3);
    if (
      mieValid &&
      typeof obj.mieScaleHeight === 'number' &&
      Array.isArray(obj.rayleighCoeff)
    ) {
      return {
        mieCoeff: obj.mieCoeff as number | [number, number, number],
        mieScaleHeight: obj.mieScaleHeight,
        miePhaseAsymmetry: (obj.miePhaseAsymmetry as number) ?? -0.7,
        rayleighCoeff: obj.rayleighCoeff as [number, number, number],
        absorptionCoeff: (obj.absorptionCoeff as [number, number, number]) ?? [0, 0, 0],
        planetCapBias: typeof obj.planetCapBias === 'number' ? obj.planetCapBias : undefined,
      };
    }
  }

  return null;
}


/** Get a built-in atmosphere preset by body name. */
export function getAtmospherePreset(name: string): AtmosphereParams | null {
  return ATMOSPHERE_PRESETS[name] ?? null;
}
