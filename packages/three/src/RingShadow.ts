import * as THREE from 'three';

// ---- Ring-on-body shadow GLSL injection ----
// Cast a ray from the fragment toward the sun, intersect the ring plane,
// and if the intersection lies within the ring annulus, sample the ring
// texture's alpha at that radial position and use it to darken the body.
//
// Reuses uSunWorldPos / vShadowWorldPos declared by SHADOW_FRAG_PARS, so
// eclipse-shadow inject must be applied first.

export const RING_VISIBILITY_GLSL = /* glsl */`
#ifndef COSMOLABE_RING_VISIBILITY
#define COSMOLABE_RING_VISIBILITY
uniform sampler2D uRingMap;
uniform vec3      uRingCenterWorld;
uniform vec3      uRingNormalWorld;
uniform float     uRingInnerRadius;
uniform float     uRingOuterRadius;

float computeRingVisibility(vec3 worldPos) {
  if (uRingOuterRadius <= uRingInnerRadius) return 1.0;
  vec3 toSun = uSunWorldPos - worldPos;
  float distToSun = length(toSun);
  vec3 L = toSun / max(distToSun, 1e-20);

  float denom = dot(L, uRingNormalWorld);
  // Keep the intersection finite even for rays rejected below. Derivatives
  // and the filtered texture lookup must run before any divergent returns.
  float safeDenom = denom < 0.0 ? min(denom, -1e-6) : max(denom, 1e-6);
  float t = dot(uRingCenterWorld - worldPos, uRingNormalWorld) / safeDenom;

  vec3 hit = worldPos + L * t;
  float r = length(hit - uRingCenterWorld);
  // Each edge transitions over one pixel's radial footprint. Only the
  // annulus cutoff is softened; texture-defined gaps and bands stay intact.
  float halfPixel = max(0.5 * fwidth(r), 1e-20);
  float coverage = smoothstep(uRingInnerRadius - halfPixel, uRingInnerRadius + halfPixel, r)
    * (1.0 - smoothstep(uRingOuterRadius - halfPixel, uRingOuterRadius + halfPixel, r));

  float u = clamp((r - uRingInnerRadius) / (uRingOuterRadius - uRingInnerRadius), 0.0, 1.0);
  float a = texture2D(uRingMap, vec2(u, 0.5)).a;

  // Ray nearly parallel to the ring plane, or no intersection toward the sun.
  if (distToSun < 1e-20 || abs(denom) < 1e-6 || t <= 0.0 || t > distToSun) return 1.0;
  return 1.0 - a * coverage;
}
#endif
`;

export const RING_SHADOW_FRAG_PARS = /* glsl */`
${RING_VISIBILITY_GLSL}
float computeRingShadow() { return computeRingVisibility(vShadowWorldPos); }
`;

export type RingShadowUniforms = {
  uRingMap:         { value: THREE.Texture | null };
  uRingCenterWorld: { value: THREE.Vector3 };
  uRingNormalWorld: { value: THREE.Vector3 };
  uRingInnerRadius: { value: number };
  uRingOuterRadius: { value: number };
};

export function makeRingShadowUniforms(): RingShadowUniforms {
  return {
    uRingMap:         { value: null },
    uRingCenterWorld: { value: new THREE.Vector3() },
    uRingNormalWorld: { value: new THREE.Vector3(0, 1, 0) },
    uRingInnerRadius: { value: 0 },
    uRingOuterRadius: { value: 0 },
  };
}

export function injectRingShadowIntoShader(
  shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> },
  ringShadowUniforms: Record<string, { value: unknown }>,
): void {
  Object.assign(shader.uniforms, ringShadowUniforms);
  // Insert ring-shadow declarations + function ahead of computeEclipseShadow
  // so the new function sees uSunWorldPos / vShadowWorldPos from SHADOW_FRAG_PARS.
  shader.fragmentShader = shader.fragmentShader
    .replace(
      'float computeEclipseShadow()',
      RING_SHADOW_FRAG_PARS + '\nfloat computeEclipseShadow()',
    )
    .replace(
      'outgoingLight *= computeEclipseShadow();',
      'outgoingLight *= computeEclipseShadow() * computeRingShadow();',
    );
}
