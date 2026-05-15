import * as THREE from 'three';

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
uniform vec3  uAPCameraWorldPos;
uniform vec3  uAPSunWorldPos;
uniform vec3  uAPPlanetWorldPos;
uniform float uAPPlanetRadius;       // scene units
uniform float uAPShellRadius;        // scene units
uniform vec3  uAPRayleighCoeff;      // 1 / scene unit
uniform vec3  uAPMieCoeff;           // 1 / scene unit (per-channel wavelength-dependent)
uniform vec3  uAPExtinctionCoeff;    // 1 / scene unit
uniform float uAPMieK;               // Schlick phase parameter
uniform float uAPInvScaleH;          // 1 / scene unit
uniform vec3  uAPLightColor;
uniform float uAPStrength;           // 0..1; 0 disables aerial perspective
uniform sampler2D uAPMultiScatterLUT; // shared with the parent AtmosphereMesh

// View-ray samples for the camera→fragment integral. Lower than typical
// because the LUT covers the all-bounce ambient and the path is generally
// short (camera-to-terrain), and AP runs on every body+terrain fragment.
#define AP_SAMPLES 4

// Returns vec4(inscatter, transmittance). The fragment is composited as:
//   outgoingLight = outgoingLight * transmittance + inscatter
vec4 computeAerialPerspective(vec3 fragWorldPos) {
  if (uAPStrength <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);

  // Move into a frame centered on the planet for radial altitude math.
  vec3 camP  = uAPCameraWorldPos - uAPPlanetWorldPos;
  vec3 fragP = fragWorldPos       - uAPPlanetWorldPos;
  vec3 ray   = fragP - camP;
  float pathLen = length(ray);
  if (pathLen < 1e-6) return vec4(0.0, 0.0, 0.0, 1.0);
  vec3 dir = ray / pathLen;

  // Sun direction in the same planet-centered frame.
  vec3 sunDir = normalize(uAPSunWorldPos - uAPPlanetWorldPos);

  float stepLen = pathLen / float(AP_SAMPLES);
  vec3 inscatter = vec3(0.0);
  float opt = 0.0;

  // Phase functions (same as AtmosphereMesh; sun direction is constant along
  // the view ray so they're computed once outside the loop).
  float cosTheta   = dot(-dir, sunDir);
  float k = uAPMieK;
  float phMie      = (1.0 - k * k) / ((1.0 - k * cosTheta) * (1.0 - k * cosTheta));
  float phRayleigh = 0.75 * (1.0 + cosTheta * cosTheta);
  vec3  scatteringPhase    = phRayleigh * uAPRayleighCoeff + phMie * uAPMieCoeff;
  // Raw scattering sum — phase already baked into LUT (see AtmosphereMesh).
  vec3 scatteringSumCoeff = uAPRayleighCoeff + uAPMieCoeff;

  // Normalized planet radius for LUT altitude lookup.
  float planetRNorm = uAPPlanetRadius / uAPShellRadius;

  for (int i = 0; i < AP_SAMPLES; i++) {
    vec3 sP = camP + dir * (stepLen * (float(i) + 0.5));
    float r = length(sP);
    float altitude = max(0.0, r - uAPPlanetRadius);
    float density  = exp(-altitude * uAPInvScaleH);

    // Skip samples outside the atmosphere shell — they contribute nothing.
    if (r > uAPShellRadius) continue;

    float segOD = density * stepLen;
    opt += segOD;

    // Sun-side optical depth: distance from sample to atmosphere exit toward sun.
    float sRq = dot(sP, sunDir);
    float sQq = dot(sP, sP) - uAPShellRadius * uAPShellRadius;
    float sD2 = sRq * sRq - sQq;
    float sunDist = (sD2 > 0.0) ? max(0.0, -sRq + sqrt(sD2)) : 0.0;

    // Local sun zenith at this sample (drives both terminator fade + LUT lookup).
    float cosLit = (r > 1e-6) ? dot(sP / r, sunDir) : 1.0;
    float hemi   = smoothstep(-0.35, 0.15, cosLit);

    vec3 T_view = exp(-uAPExtinctionCoeff * opt);
    vec3 T_sun  = exp(-uAPExtinctionCoeff * density * sunDist * 0.5);

    // Single-scatter contribution from sun.
    vec3 ssContrib = T_view * T_sun * hemi * density * stepLen * scatteringPhase;
    // Multi-scatter contribution from the LUT — phase already baked into ψ.
    float altNormForLUT = altitude / max(1e-6, uAPShellRadius - uAPPlanetRadius);
    vec2 lutUV = vec2(cosLit * 0.5 + 0.5, altNormForLUT);
    vec3 psi = texture2D(uAPMultiScatterLUT, lutUV).rgb;
    vec3 msContrib = T_view * psi * scatteringSumCoeff * density * stepLen * hemi;

    inscatter += ssContrib + msContrib;
  }

  vec3 color = uAPLightColor * inscatter;

  // Physically correct view transmittance — no floor.
  vec3 viewT = exp(-uAPExtinctionCoeff * opt);
  float trans = clamp(dot(viewT, vec3(0.3333)), 0.0, 1.0);

  // Distance ramp: real aerial perspective doesn't visibly fog the foreground.
  // Without this, every surface fragment within a few meters of the camera
  // picks up a (small but visible) inscatter tint that reads as "ground is
  // fogged out" at low altitudes. Ramping AP up over ~half a mie scale height
  // means objects within a few km look clean, and the haze fades in for the
  // mid/far field — which is how aerial perspective actually behaves IRL.
  // Uses 1/invScaleH = scaleHeight in scene units for a body-agnostic scale.
  float distGate = smoothstep(0.0, 0.5 / uAPInvScaleH, pathLen);
  float effStrength = uAPStrength * distGate;

  // effStrength gates orbital views (uAPStrength=0) AND the foreground (distGate=0).
  color *= effStrength;
  trans  = mix(1.0, trans, effStrength);
  return vec4(color, trans);
}
`;

export type AerialPerspectiveUniforms = {
  uAPCameraWorldPos:    { value: THREE.Vector3 };
  uAPSunWorldPos:       { value: THREE.Vector3 };
  uAPPlanetWorldPos:    { value: THREE.Vector3 };
  uAPPlanetRadius:      { value: number };
  uAPShellRadius:       { value: number };
  uAPRayleighCoeff:     { value: THREE.Vector3 };
  uAPMieCoeff:          { value: THREE.Vector3 };
  uAPExtinctionCoeff:   { value: THREE.Vector3 };
  uAPMieK:              { value: number };
  uAPInvScaleH:         { value: number };
  uAPLightColor:        { value: THREE.Vector3 };
  uAPStrength:          { value: number };
  uAPMultiScatterLUT:   { value: THREE.Texture | null };
};

export function makeAerialPerspectiveUniforms(): AerialPerspectiveUniforms {
  return {
    uAPCameraWorldPos:  { value: new THREE.Vector3() },
    uAPSunWorldPos:     { value: new THREE.Vector3() },
    uAPPlanetWorldPos:  { value: new THREE.Vector3() },
    uAPPlanetRadius:    { value: 0 },
    uAPShellRadius:     { value: 0 },
    uAPRayleighCoeff:   { value: new THREE.Vector3() },
    uAPMieCoeff:        { value: new THREE.Vector3() },
    uAPExtinctionCoeff: { value: new THREE.Vector3() },
    uAPMieK:            { value: 0 },
    uAPInvScaleH:       { value: 0 },
    uAPLightColor:      { value: new THREE.Vector3(1, 1, 1) },
    uAPStrength:        { value: 0 },
    uAPMultiScatterLUT: { value: null },
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
  shader.fragmentShader = AERIAL_PERSPECTIVE_FRAG_PARS +
    shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      'vec4 _ap = computeAerialPerspective(vAPWorldPos);\n' +
      'outgoingLight = outgoingLight * _ap.a + _ap.rgb;\n' +
      '#include <opaque_fragment>',
    );
}
