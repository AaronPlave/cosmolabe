import * as THREE from 'three';
import { ECLIPSE_VISIBILITY_GLSL, makeShadowUniforms, type ShadowUniforms } from './EclipseShadow.js';
import { RING_VISIBILITY_GLSL, makeRingShadowUniforms, type RingShadowUniforms } from './RingShadow.js';
import type { AtmosphereModel } from './AtmosphereModel.js';
import { ATMOSPHERE_PROFILES_GLSL, makeAtmosphereProfileUniforms, type AtmosphereProfileUniforms } from './AtmosphereProfiles.js';

// ---- Aerial perspective GLSL injection ----
// Injected into body / terrain material shaders via onBeforeCompile.
// For each fragment, integrates Rayleigh+Mie inscatter + transmittance along
// the camera→fragment ray. Distant terrain on a hazy planet picks up sky color
// and desaturates with distance — same single-scatter math as AtmosphereMesh,
// but stops at the fragment instead of marching the full atmosphere shell.
//
// Mirrors EclipseShadow.ts: shared uniforms struct, factory, and one-shot
// injection helper. One uniforms instance per atmosphere body, shared across
// the body's placeholder sphere material and all terrain tile materials.

export const AERIAL_PERSPECTIVE_FRAG_PARS = /* glsl */`
varying vec3 vAPWorldPos;
uniform mat4 uAPWorldToPlanet;
uniform mat4 uAPPlanetToWorld;
uniform float uAPModelUnitScale;
uniform vec3  uAPCameraWorldPos;
uniform vec3  uAPSunWorldPos;
uniform vec3  uAPPlanetWorldPos;
uniform float uAPPlanetRadius;       // scene units
uniform float uAPShellRadius;        // scene units
uniform float uAPMieK;               // Schlick phase parameter
uniform vec3  uAPLightColor;
uniform float uAPStrength;           // 0..1; 0 disables aerial perspective
uniform sampler2D uAPMultiScatterLUT; // shared with the parent AtmosphereMesh
${ECLIPSE_VISIBILITY_GLSL}
${RING_VISIBILITY_GLSL}
${ATMOSPHERE_PROFILES_GLSL}

// View-ray samples for the camera→fragment integral. Lower than typical
// because the LUT covers the all-bounce ambient and the path is generally
// short (camera-to-terrain), and AP runs on every body+terrain fragment.
#define AP_SAMPLES 8

struct AerialPerspectiveResult { vec3 inscatter; vec3 transmittance; };
AerialPerspectiveResult computeAerialPerspective(vec3 fragWorldPos) {
  if (uAPStrength <= 0.0) return AerialPerspectiveResult(vec3(0.0), vec3(1.0));

  // Move into a frame centered on the planet for radial altitude math.
  // Match the atmosphere shell frame, including the body’s oblateness.
  vec3 camP = (uAPWorldToPlanet * vec4(uAPCameraWorldPos, 1.0)).xyz * uAPModelUnitScale;
  vec3 fragP = (uAPWorldToPlanet * vec4(fragWorldPos, 1.0)).xyz * uAPModelUnitScale;
  vec3 ray   = fragP - camP;
  float pathLen = length(ray);
  if (pathLen < 1e-6) return AerialPerspectiveResult(vec3(0.0), vec3(1.0));
  vec3 dir = ray / pathLen;
#ifdef AP_PROJECT_GLOBE
  // Intersect the pixel's view ray with the true globe, avoiding triangle
  // chords without moving the ray onto a different pixel near the horizon.
  float groundB = dot(camP, dir);
  float groundC = dot(camP, camP) - uAPPlanetRadius * uAPPlanetRadius;
  float groundDisc = groundB * groundB - groundC;
  if (groundDisc >= 0.0) {
    float groundT = -groundB - sqrt(groundDisc);
    if (groundT > 0.0) pathLen = groundT;
  }
#endif


  float b = dot(camP, dir);
  float c = dot(camP, camP) - uAPShellRadius * uAPShellRadius;
  float disc = b * b - c;
  if (disc <= 0.0) return AerialPerspectiveResult(vec3(0.0), vec3(1.0));
  float tStart = max(0.0, -b - sqrt(disc));
  float tEnd = min(pathLen, -b + sqrt(disc));
  if (tEnd <= tStart) return AerialPerspectiveResult(vec3(0.0), vec3(1.0));
  float atmPathLen = tEnd - tStart;

  // Sun direction in the same planet-centered frame.
  vec3 sunDir = normalize((uAPWorldToPlanet * vec4(uAPSunWorldPos, 1.0)).xyz);


  vec3 inscatter = vec3(0.0);
  vec3 opticalDepth = vec3(0.0);

  // Phase functions (same as AtmosphereMesh; sun direction is constant along
  // the view ray so they're computed once outside the loop).
  float cosTheta   = dot(-dir, sunDir);
  float k = uAPMieK;
  float phMie      = (1.0 - k * k) / ((1.0 - k * cosTheta) * (1.0 - k * cosTheta));
  float phRayleigh = 0.75 * (1.0 + cosTheta * cosTheta);


  for (int i = 0; i < AP_SAMPLES; i++) {
    // Cluster samples at both endpoints to resolve dense near-surface layers.
    float a = 0.5 - 0.5 * cos(3.14159265358979 * float(i) / float(AP_SAMPLES));
    float b = 0.5 - 0.5 * cos(3.14159265358979 * float(i + 1) / float(AP_SAMPLES));
    float stepLen = atmPathLen * (b - a);
    vec3 sP = camP + dir * (tStart + atmPathLen * (a + b) * 0.5);
    float r = length(sP);
    float altitude = max(0.0, r - uAPPlanetRadius);
    vec3 density = atmDensities(altitude);

    // Skip samples outside the atmosphere shell — they contribute nothing.
    if (r > uAPShellRadius) continue;

    vec3 extinction = atmExtinction(density);
    vec3 weight = atmSegmentWeight(extinction, stepLen);

    // Local sun zenith at this sample (drives both terminator fade + LUT lookup).
    float cosLit = (r > 1e-6) ? dot(sP / r, sunDir) : 1.0;
    vec3 T_view = exp(-opticalDepth);
    vec3 T_sun = atmSunTransmittance(sP, sunDir);

    // Single-scatter contribution from sun.
    vec3 ssContrib = T_view * T_sun * weight * atmScattering(density, phRayleigh, phMie);
    // Multi-scatter contribution from the LUT — phase already baked into ψ.
    float altNormForLUT = altitude / max(1e-6, uAPShellRadius - uAPPlanetRadius);
    vec2 lutUV = vec2(cosLit * 0.5 + 0.5, altNormForLUT);
    vec3 psi = texture2D(uAPMultiScatterLUT, lutUV).rgb;
    vec3 msContrib = T_view * psi * atmScatteringSum(density) * weight;

    // Visibility belongs to each atmospheric sample, not the surface fragment.
    // Keep extinction in the umbra; the ambient LUT uses local visibility as
    // an approximation until spatial multiple scattering is available.
    vec3 sampleWorld = (uAPPlanetToWorld * vec4(sP / uAPModelUnitScale, 1.0)).xyz;
    float visibility = computeEclipseVisibility(sampleWorld) * computeRingVisibility(sampleWorld);
    inscatter += (ssContrib + msContrib) * visibility;
    opticalDepth += extinction * stepLen;
  }

  vec3 color = uAPLightColor * inscatter;

  // Physically correct view transmittance — no floor.
  vec3 viewT = exp(-opticalDepth);


  // Suppress negligible foreground haze while retaining orbital paths.
  float distGate = smoothstep(0.0, 0.5 / uAtmMieInvH, atmPathLen);
  float effStrength = uAPStrength * distGate;

  // Keep short foreground paths clear while retaining orbital paths through the atmosphere.
  color *= effStrength;
  return AerialPerspectiveResult(color, mix(vec3(1.0), viewT, effStrength));
}
`;

export type AerialPerspectiveUniforms = AtmosphereProfileUniforms & ShadowUniforms & RingShadowUniforms & {
  uAPCameraWorldPos:    { value: THREE.Vector3 };
  uAPSunWorldPos:       { value: THREE.Vector3 };
  uAPPlanetWorldPos:    { value: THREE.Vector3 };
  uAPPlanetRadius:      { value: number };
  uAPShellRadius:       { value: number };
  uAPMieK:              { value: number };
  uAPLightColor:        { value: THREE.Vector3 };
  uAPStrength:          { value: number };
  uAPMultiScatterLUT:   { value: THREE.Texture | null };
  uAPWorldToPlanet:      { value: THREE.Matrix4 };
  uAPPlanetToWorld:      { value: THREE.Matrix4 };
  uAPModelUnitScale:    { value: number };
};

export function makeAerialPerspectiveUniforms(
  model: AtmosphereModel,
  planetRadiusKm: number,
  sceneScale: number,
  transmittanceLUT: THREE.Texture | null,
): AerialPerspectiveUniforms {
  return {
    ...makeShadowUniforms(),
    ...makeRingShadowUniforms(),
    ...makeAtmosphereProfileUniforms(
      model, 1 / sceneScale, planetRadiusKm * sceneScale,
      (planetRadiusKm + model.heightKm) * sceneScale, transmittanceLUT,
    ),
    uAPCameraWorldPos:  { value: new THREE.Vector3() },
    uAPSunWorldPos:     { value: new THREE.Vector3() },
    uAPPlanetWorldPos:  { value: new THREE.Vector3() },
    uAPPlanetRadius:    { value: 0 },
    uAPShellRadius:     { value: 0 },
    uAPMieK:            { value: 0 },
    uAPLightColor:      { value: new THREE.Vector3(1, 1, 1) },
    uAPStrength:        { value: 0 },
    uAPMultiScatterLUT: { value: null },
    uAPWorldToPlanet:    { value: new THREE.Matrix4() },
    uAPPlanetToWorld:    { value: new THREE.Matrix4() },
    uAPModelUnitScale:  { value: sceneScale },
  };
}

/**
 * Patch a shader (via onBeforeCompile) so the body/terrain fragment is composited
 * with aerial-perspective inscatter and transmittance from `uniforms`. Mirrors
 * the eclipse-shadow injection pattern: same uniforms object passed by reference,
 * patched in after the standard light pipeline has produced `outgoingLight`.
 */
export function injectAerialPerspectiveIntoShader(
  shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> },
  uniforms: Record<string, { value: unknown }>,
  projectGlobe = false,
): void {
  Object.assign(shader.uniforms, uniforms);
  // Vertex: declare varying + set world position after project_vertex (always present).
  shader.vertexShader = 'varying vec3 vAPWorldPos;\n' +
    shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\nvAPWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    );
  // Fragment: prepend AP function, composite outgoingLight before opaque output.
  // Same `<opaque_fragment>` hook as EclipseShadow — when both are injected,
  // EclipseShadow first scales outgoingLight by shadow factor; AP then folds in
  // inscatter and view-transmittance. Order is determined by which onBeforeCompile
  // runs second (composed via the prevOBC pattern).
  shader.fragmentShader = (projectGlobe ? '#define AP_PROJECT_GLOBE\n' : '') + AERIAL_PERSPECTIVE_FRAG_PARS +
    shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      'AerialPerspectiveResult _ap = computeAerialPerspective(vAPWorldPos);\n' +
      'outgoingLight = outgoingLight * _ap.transmittance + _ap.inscatter;\n' +
      '#include <opaque_fragment>',
    );
}
