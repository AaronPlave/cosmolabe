import * as THREE from 'three';
import { buildMultiScatterLUT } from './MultiScatterLUT.js';
import { MAX_SHADOW_OCCLUDERS } from './EclipseShadow.js';
import { normalizeAtmosphere, type AtmosphereModel } from './AtmosphereModel.js';
import { ATMOSPHERE_PROFILES_GLSL, makeAtmosphereProfileUniforms } from './AtmosphereProfiles.js';
import { buildTransmittanceLUT } from './TransmittanceLUT.js';
import { SkyViewLUT, SKY_VIEW_BASIS_GLSL } from './SkyViewLUT.js';
import { SOLAR_DISPLAY_GLSL, solarIrradiance, SOLAR_REFERENCE_DISTANCE_KM } from './SolarRadiometry.js';

/**
 * Atmosphere scattering parameters for a body.
 * Rayleigh + Mie atmospheric scattering parameters — all coefficients in 1/km.
 */
export interface AtmosphereParams {
  /** Explicit shell height in km. Legacy inline catalogs derive this from scale height. */
  heightKm?: number;
  rayleighScaleHeightKm?: number;
  mieExtinctionCoeff?: [number, number, number];
  absorptionProfile?: AtmosphereModel['absorption']['profile'];
  groundAlbedo?: [number, number, number];
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
    mieScaleHeight: 1.2,
    rayleighScaleHeightKm: 8.0,
    heightKm: 100,
    absorptionProfile: { type: 'tent', peakKm: 25, halfWidthKm: 15 },
    groundAlbedo: [0.1, 0.1, 0.1],
    miePhaseAsymmetry: -0.7,
    rayleighCoeff: [0.0054, 0.0081, 0.0167],
    absorptionCoeff: [0.0027, 0.0017, 0.0002],
    planetCapBias: 0.001,
  },
  Mars: {
    // Dust dominates visible scattering; keep the existing loading until
    // ground and orbit comparisons can guide a separate calibration pass.
    mieCoeff: [0.018, 0.015, 0.012],
    mieScaleHeight: 11.0,
    rayleighScaleHeightKm: 11.0,
    heightKm: 85,
    groundAlbedo: [0.16, 0.12, 0.1],
    miePhaseAsymmetry: -0.5,
    rayleighCoeff: [0.00002, 0.00005, 0.00012],
    absorptionCoeff: [0.0002, 0.0010, 0.0030],
    planetCapBias: 0.005,
  },
  Titan: {
    mieCoeff: 0.0040,
    mieScaleHeight: 50.0,
    miePhaseAsymmetry: -0.4,
    // Molecular Rayleigh increases toward blue; tholin color is absorption.
    rayleighCoeff: [0.0004, 0.0010, 0.0035],
    // Heavy blue absorption from methane/tholins
    absorptionCoeff: [0.0005, 0.0015, 0.0050],
  },
  Venus: {
    mieCoeff: 0.0050,
    mieScaleHeight: 15.0,
    miePhaseAsymmetry: -0.6,
    // Remove the legacy red-scattering visual tint. Molecular scattering and
    // cloud absorption must also form a plausible direct-light spectral filter.
    rayleighCoeff: [0.0030, 0.0060, 0.0080],
    absorptionCoeff: [0.0010, 0.0030, 0.0040],
  },
  Jupiter: {
    mieCoeff: 0.0030,
    mieScaleHeight: 27.0,
    miePhaseAsymmetry: -0.6,
    rayleighCoeff: [0.0040, 0.0030, 0.0015],
    absorptionCoeff: [0.0010, 0.0008, 0.0003],
  },
  Saturn: {
    // Haze above the visible cloud-deck texture. The inherited full-column
    // loading washed out orbital bands; retain 1/4 after same-camera brackets.
    mieCoeff: 0.000625,
    mieScaleHeight: 60.0,
    miePhaseAsymmetry: -0.5,
    rayleighCoeff: [0.000875, 0.0007, 0.000375],
    absorptionCoeff: [0.0002, 0.00015, 0.00005],
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

// ---- GLSL Shaders ----
// The shell and terrain shaders share density profiles and direct-Sun transmittance.
// Inside-shell views integrate at vertices; orbital limb views integrate per pixel.

const atmosphereVertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

uniform float planetR;
uniform float planetCapBias;
uniform float mieK;

uniform mat4 invModelMat;
uniform vec3 lightDir;
uniform vec3 lightColor;
uniform sampler2D uMultiScatterLUT;

uniform vec3  uSunWorldPos;
uniform float uSunRadius;
uniform vec3  uShadowOccluderPos[${MAX_SHADOW_OCCLUDERS}];
uniform float uShadowOccluderRadius[${MAX_SHADOW_OCCLUDERS}];
uniform float uShadowOccluderCount;
uniform vec3  uPlanetWorldPos;
uniform float uShellSceneScale;
uniform mat4 uAtmModelToWorld;
${ATMOSPHERE_PROFILES_GLSL}
${SOLAR_DISPLAY_GLSL}

varying vec3  vColor;       // linear scattered radiance
varying float vAlpha;       // view-ray transmittance (atmosphere alpha for blend)
varying float vCosTheta;    // dot(-viewDir, sunDir) for per-pixel sun glare
varying float vDiscAtm;     // for discarding fragments outside the atmosphere shell
varying vec3  vObjPos;      // proxy-sphere position; needed by the per-fragment fallback path

#define NUM_SAMPLES 8

float computeAtmEclipseShadow(vec3 samplePos) {
  vec3 worldPos = (uAtmModelToWorld * vec4(samplePos, 1.0)).xyz;
  vec3 toSun = uSunWorldPos - worldPos;
  float distToSun = length(toSun);
  if (distToSun < 1e-20) return 1.0;
  vec3 rayDir = toSun / distToSun;
  float shadowFactor = 1.0;
  for (int i = 0; i < ${MAX_SHADOW_OCCLUDERS}; i++) {
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
  vec3  totalInscatter = vec3(0.0);
  vec3 totalOptDepth = vec3(0.0);

  for (int i = 0; i < NUM_SAMPLES; i++) {
    float t = tEnter + (float(i) + 0.5) * stepLen;
    vec3 samplePos = eyePos + t * viewDir;
    float r = length(samplePos);
    float altitude = max(0.0, r - planetR);
    vec3 density = atmDensities(altitude);
    vec3 extinction = atmExtinction(density);
    vec3 weight = atmSegmentWeight(extinction, stepLen);

    vec3  upLocal = (r > 1e-6) ? samplePos / r : vec3(0.0, 1.0, 0.0);
    float cosLit  = dot(upLocal, lightDir);
    float shadow = computeAtmEclipseShadow(samplePos);
    vec3 T_view = exp(-totalOptDepth);
    vec3 T_sun = atmSunTransmittance(samplePos, lightDir);

    vec3 ssContrib = T_view * T_sun * shadow * weight * atmScattering(density, phRayleigh, phMie);
    vec2 lutUV = vec2(cosLit * 0.5 + 0.5, altitude / max(1e-6, 1.0 - planetR));
    vec3 psi   = texture2D(uMultiScatterLUT, lutUV).rgb;
    vec3 msContrib = T_view * psi * atmScatteringSum(density) * weight * shadow;

    totalInscatter += ssContrib + msContrib;
    totalOptDepth += extinction * stepLen;
  }

  vec3 color = lightColor * totalInscatter;

  vec3 viewEx = exp(-totalOptDepth);
  float alpha = dot(viewEx, vec3(0.3333));

  vColor = color;
  vAlpha = alpha;
}
`;

// With a SkyView LUT, vertices only supply proxy positions. The view integral
// runs once per LUT texel rather than once per vertex on every shell draw.
const skyViewVertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vColor;
varying float vAlpha;
varying float vCosTheta;
varying float vDiscAtm;
varying vec3 vObjPos;
void main() {
  vObjPos = position;
  vColor = vec3(0.0);
  vAlpha = 1.0;
  vCosTheta = 0.0;
  vDiscAtm = 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const atmosphereFragmentShader = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>

uniform float planetR;
uniform float planetCapBias;
uniform float mieK;

uniform mat4 invModelMat;
uniform vec3 lightDir;
uniform vec3 lightColor;
uniform sampler2D uMultiScatterLUT;
uniform sampler2D uSkyViewLUT;
uniform bool uHasSkyViewLUT;

uniform vec3  uSunWorldPos;
uniform float uSunRadius;
uniform vec3  uShadowOccluderPos[${MAX_SHADOW_OCCLUDERS}];
uniform float uShadowOccluderRadius[${MAX_SHADOW_OCCLUDERS}];
uniform float uShadowOccluderCount;
uniform vec3  uPlanetWorldPos;
uniform float uShellSceneScale;
uniform mat4 uAtmModelToWorld;
${ATMOSPHERE_PROFILES_GLSL}
${SOLAR_DISPLAY_GLSL}
${SKY_VIEW_BASIS_GLSL}

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
  vec3 worldPos = (uAtmModelToWorld * vec4(samplePos, 1.0)).xyz;
  vec3 toSun = uSunWorldPos - worldPos;
  float distToSun = length(toSun);
  if (distToSun < 1e-20) return 1.0;
  vec3 rayDir = toSun / distToSun;
  float shadowFactor = 1.0;
  for (int i = 0; i < ${MAX_SHADOW_OCCLUDERS}; i++) {
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
    if (uHasSkyViewLUT) {
      vec3 eye = (invModelMat * vec4(cameraPosition, 1.0)).xyz;
      vec3 viewDir = normalize(normalize(vObjPos) * 1.15 - eye);
      vec3 up, towardSun, side;
      skyBasis(eye, lightDir, up, towardSun, side);
      float theta = acos(clamp(dot(viewDir, up), -1.0, 1.0));
      vec3 horizontal = viewDir - up * dot(viewDir, up);
      float azimuth = length(horizontal) < 1e-6 ? 0.0 :
        atan(dot(horizontal, side), dot(horizontal, towardSun));
      float capR = max(0.0, planetR - planetCapBias);
      gl_FragColor = texture2D(uSkyViewLUT, vec2(
        (azimuth + 3.14159265358979) / (2.0 * 3.14159265358979),
        skyVFromTheta(theta, skyHorizonTheta(eye, capR))));
      gl_FragColor.rgb = radianceToDisplay(gl_FragColor.rgb);
      #include <colorspace_fragment>
      return;
    }
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
    gl_FragColor.rgb = radianceToDisplay(gl_FragColor.rgb);
    #include <colorspace_fragment>
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
  vec3  totalInscatter = vec3(0.0);
  vec3 totalOptDepth = vec3(0.0);

  for (int i = 0; i < NUM_SAMPLES; i++) {
    float t = tEnter + (float(i) + 0.5) * stepLen;
    vec3 samplePos = eyePos + t * viewDir;
    float r = length(samplePos);
    float altitude = max(0.0, r - planetR);
    vec3 density = atmDensities(altitude);
    vec3 extinction = atmExtinction(density);
    vec3 weight = atmSegmentWeight(extinction, stepLen);

    vec3  upLocal = (r > 1e-6) ? samplePos / r : vec3(0.0, 1.0, 0.0);
    float cosLit  = dot(upLocal, lightDir);
    float shadow = computeAtmEclipseShadow(samplePos);
    vec3 T_view = exp(-totalOptDepth);
    vec3 T_sun = atmSunTransmittance(samplePos, lightDir);

    vec3 ssContrib = T_view * T_sun * shadow * weight * atmScattering(density, phRayleigh, phMie);
    vec2 lutUV = vec2(cosLit * 0.5 + 0.5, altitude / max(1e-6, 1.0 - planetR));
    vec3 psi   = texture2D(uMultiScatterLUT, lutUV).rgb;
    vec3 msContrib = T_view * psi * atmScatteringSum(density) * weight * shadow;

    totalInscatter += ssContrib + msContrib;
    totalOptDepth += extinction * stepLen;
  }

  vec3 color = lightColor * totalInscatter;

  vec3 viewEx = exp(-totalOptDepth);
  float alpha = dot(viewEx, vec3(0.3333));

  // Smooth outer atmosphere boundary so the proxy-sphere silhouette doesn't
  // pop in/out at sub-pixel level.
  float edgeFade = smoothstep(0.0, 0.001, discAtm);
  color *= edgeFade;
  alpha  = mix(1.0, alpha, edgeFade);

  gl_FragColor = vec4(color, alpha);
  gl_FragColor.rgb = radianceToDisplay(gl_FragColor.rgb);
  #include <colorspace_fragment>
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
  readonly model: AtmosphereModel;
  /** Most recent normalized camera altitude (0 surface, 1 at/above shell). */
  private _camAltitudeNorm = 1;
  /** Most recent local sun direction (object space). */
  private readonly _sunLocal = new THREE.Vector3();
  /** Most recent local camera direction (object space, normalized). */
  private readonly _camDirLocal = new THREE.Vector3();

  private readonly _invModelMatrix = new THREE.Matrix4();
  private readonly _lightLocal = new THREE.Vector3();
  private readonly _camLocal = new THREE.Vector3();
  private readonly _renderer: THREE.WebGLRenderer | undefined;
  private _skyView: SkyViewLUT | null = null;

  constructor(planetRadius: number, params: AtmosphereParams, renderer?: THREE.WebGLRenderer) {
    const model = normalizeAtmosphere(params);
    const shellRadius = planetRadius + model.heightKm;

    const geometry = new THREE.SphereGeometry(1.15, renderer ? 256 : 1024, renderer ? 128 : 512);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...makeAtmosphereProfileUniforms(model, shellRadius, planetRadius / shellRadius, 1, null),
        planetR:        { value: 0 },
        planetCapBias:  { value: 0 },
        mieK:           { value: 0 },
        invModelMat:    { value: new THREE.Matrix4() },
        lightDir:       { value: new THREE.Vector3(1, 0, 0) },
        lightColor:     { value: new THREE.Vector3(...solarIrradiance(SOLAR_REFERENCE_DISTANCE_KM)) },
        uMultiScatterLUT: { value: null as THREE.Texture | null },
        uSkyViewLUT: { value: null as THREE.Texture | null },
        uHasSkyViewLUT: { value: false },
        uCameraInsideShell:    { value: 0.0 },
        uSunWorldPos:          { value: new THREE.Vector3() },
        uSunRadius:            { value: 0 },
        uShadowOccluderPos:    { value: Array.from({ length: MAX_SHADOW_OCCLUDERS }, () => new THREE.Vector3()) },
        uShadowOccluderRadius: { value: new Float32Array(MAX_SHADOW_OCCLUDERS) },
        uShadowOccluderCount:  { value: 0.0 },
        uPlanetWorldPos:       { value: new THREE.Vector3() },
        uShellSceneScale:      { value: 1.0 },
        uAtmModelToWorld:      { value: new THREE.Matrix4() },
      },
      vertexShader: renderer ? skyViewVertexShader : atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      transparent: true,
      toneMapped: false,
      depthWrite: false,
      depthTest: true,
      // Custom blend: finalColor = src * 1 + dst * srcAlpha
      // Inscattered light additive, background dimmed by transmittance
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.SrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      // The shell renders sky and limb; body materials composite surface paths.
      side: THREE.BackSide,
    });

    super(geometry, material);
    this.planetRadius = planetRadius;
    this.shellRadius = shellRadius;
    this.params = params;
    this.model = model;
    this._renderer = renderer;
    this.frustumCulled = false;
    // Render BEFORE trajectory lines (renderOrder -1) so trajectories paint
    // on top of the limb glow. The custom blend equation here is
    // `final = atmColor + dst * srcAlpha`, which multiplies the destination
    // by srcAlpha — at the bright limb where srcAlpha is small (high
    // inscatter, low transmittance) it effectively erases anything painted
    // earlier. Previously this was set to 1000 to prevent faint orbit rings
    // from darkening the limb glow where they crossed it, but the cost was
    // wholesale erasure of front-of-limb trajectories. The thin-orbit-ring
    // darkening is a 1-px artifact; the trajectory disappearance was much
    // worse. If the ring darkening proves bad, switch trajectory
    // LineBasicMaterial.blending to AdditiveBlending in TrajectoryLine.ts
    // (always brightens, never darkens) — deferred until needed.
    this.renderOrder = -3;

    this.setAtmosphereUniforms(planetRadius, shellRadius);

    // Build the multi-scattering LUT if a renderer was provided. This is a
    // one-time render-to-texture cost per AtmosphereMesh instance — the
    // resulting 32×32 RGB texture encodes all-bounce scattering as a function
    // of (cos sun zenith, altitude) and is sampled per-fragment during
    // ray-march. Without it, the shader falls back to single-scatter only
    // (zenith goes black inside thick atmospheres).
    if (renderer) {
      this._transmittanceTarget = buildTransmittanceLUT(renderer, model, planetRadius);
      (this.material as THREE.ShaderMaterial).uniforms.uAtmTransmittanceLUT.value = this._transmittanceTarget.texture;
      (this.material as THREE.ShaderMaterial).uniforms.uAtmHasTransmittanceLUT.value = true;
      this._lutTexture = buildMultiScatterLUT(renderer, model, planetRadius, shellRadius, this._transmittanceTarget.texture);
      (this.material as THREE.ShaderMaterial).uniforms.uMultiScatterLUT.value = this._lutTexture;
      this._skyView = new SkyViewLUT((this.material as THREE.ShaderMaterial).uniforms);
      (this.material as THREE.ShaderMaterial).uniforms.uSkyViewLUT.value = this._skyView.target.texture;
      (this.material as THREE.ShaderMaterial).uniforms.uHasSkyViewLUT.value = true;
    }
  }

  /** Multi-scattering LUT texture (or null if no renderer was passed at construction). */
  private _lutTexture: THREE.Texture | null = null;
  private _transmittanceTarget: THREE.WebGLRenderTarget | null = null;
  /** Expose the LUT so AerialPerspective uniforms on the same body share it. */
  get multiScatterLUT(): THREE.Texture | null { return this._lutTexture; }
  get transmittanceLUT(): THREE.Texture | null { return this._transmittanceTarget?.texture ?? null; }

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

    u.uAtmModelToWorld.value.copy(this.matrixWorld);
    this._invModelMatrix.copy(this.matrixWorld).invert();
    u.invModelMat.value.copy(this._invModelMatrix);

    this._lightLocal.copy(sunWorldPos).applyMatrix4(this._invModelMatrix).normalize();
    u.lightDir.value.copy(this._lightLocal);
    if (planetWorldPos && shellSceneScale && sunRadius && sunRadius > 0) {
      const distanceKm = sunWorldPos.distanceTo(planetWorldPos) * this.shellRadius / shellSceneScale;
      const radiusKm = sunRadius * this.shellRadius / shellSceneScale;
      u.lightColor.value.set(...solarIrradiance(distanceKm, radiusKm));
    }

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
      const count = Math.min(occluders.length, MAX_SHADOW_OCCLUDERS);
      u.uShadowOccluderCount.value = count;
      for (let i = 0; i < count; i++) {
        u.uShadowOccluderPos.value[i].copy(occluders[i].pos);
        u.uShadowOccluderRadius.value[i] = occluders[i].radius;
      }
    } else {
      u.uShadowOccluderCount.value = 0;
    }
    if (camObjR < 1.0 && this._renderer && this._skyView) {
      this._skyView.update(this._renderer, this._camLocal);
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
    const model = this.model;
    const mean = (rgb: [number, number, number]) => (rgb[0] + rgb[1] + rgb[2]) / 3;
    const absorptionColumn = model.absorption.profile.type === 'tent'
      ? model.absorption.profile.halfWidthKm
      : model.absorption.profile.scaleHeightKm *
        (1 - Math.exp(-model.heightKm / model.absorption.profile.scaleHeightKm));
    const totalExt = mean(model.rayleigh.scattering) * model.rayleigh.scaleHeightKm *
      (1 - Math.exp(-model.heightKm / model.rayleigh.scaleHeightKm)) +
      mean(model.mie.extinction) * model.mie.scaleHeightKm *
      (1 - Math.exp(-model.heightKm / model.mie.scaleHeightKm)) +
      mean(model.absorption.extinction) * absorptionColumn;
    const opacity = 1 - Math.exp(-totalExt);
    // Fade toward 0 as camera rises from surface to shell.
    const altFade = 1 - this._camAltitudeNorm;
    return sunUp * opacity * altFade;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.material as THREE.Material).dispose();
    this._lutTexture?.dispose();
    this._transmittanceTarget?.dispose();
    this._skyView?.dispose();
  }

  private setAtmosphereUniforms(planetRadius: number, shellRadius: number): void {
    const u = (this.material as THREE.ShaderMaterial).uniforms;
    u.planetR.value = planetRadius / shellRadius;
    u.planetCapBias.value = this.model.planetCapBias;

    // Schlick approximation: k = 1.55g - 0.55g³
    const g = this.model.mie.g;
    u.mieK.value = 1.55 * g - 0.55 * g * g * g;
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
    const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
    const rgb = (v: unknown): v is [number, number, number] =>
      Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
    const profile = obj.absorptionProfile as Record<string, unknown> | undefined;
    const absorptionProfile = profile?.type === 'tent' && positive(profile.peakKm) && positive(profile.halfWidthKm)
      ? { type: 'tent' as const, peakKm: profile.peakKm, halfWidthKm: profile.halfWidthKm }
      : profile?.type === 'exponential' && positive(profile.scaleHeightKm)
        ? { type: 'exponential' as const, scaleHeightKm: profile.scaleHeightKm }
        : undefined;
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
        heightKm: positive(obj.heightKm) ? obj.heightKm : undefined,
        rayleighScaleHeightKm: positive(obj.rayleighScaleHeightKm) ? obj.rayleighScaleHeightKm : undefined,
        mieExtinctionCoeff: rgb(obj.mieExtinctionCoeff) ? obj.mieExtinctionCoeff : undefined,
        absorptionProfile,
        groundAlbedo: rgb(obj.groundAlbedo) ? obj.groundAlbedo : undefined,
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
