import * as THREE from 'three';

// ---- Eclipse shadow GLSL injection ----
// Injected into body material shaders via onBeforeCompile.
// Ray-sphere approach: cast a ray from each fragment toward the sun and test
// intersection against each occluder sphere. Computes smooth umbra/penumbra
// using the sun's angular radius at the occluder distance.

/**
 * Number of occluder slots the shader carries. The shader is generated from
 * this constant and `selectShadowOccluders` fills at most this many, so the
 * two cannot drift apart.
 */
export const MAX_SHADOW_OCCLUDERS = 4;

export const SHADOW_FRAG_PARS = /* glsl */`
varying vec3 vShadowWorldPos;
uniform vec3  uSunWorldPos;
uniform float uSunRadius;
uniform vec3  uShadowOccluderPos[${MAX_SHADOW_OCCLUDERS}];
uniform float uShadowOccluderRadius[${MAX_SHADOW_OCCLUDERS}];
uniform float uShadowOccluderCount;

float computeEclipseShadow() {
  vec3 toSun = uSunWorldPos - vShadowWorldPos;
  float distToSun = length(toSun);
  if (distToSun < 1e-20) return 1.0;
  vec3 rayDir = toSun / distToSun;
  float shadowFactor = 1.0;
  for (int i = 0; i < ${MAX_SHADOW_OCCLUDERS}; i++) {
    if (float(i) >= uShadowOccluderCount) break;
    vec3 toOcc = uShadowOccluderPos[i] - vShadowWorldPos;
    float t = dot(toOcc, rayDir);
    // Behind the fragment, or at/past the sun's own surface. The second guard
    // matters: an occluder sitting on the sun (a barycenter, a mis-sized
    // placeholder) would otherwise report a penumbra as wide as the sun and
    // black out the whole receiver.
    if (t < 1e-10 || t > distToSun - uSunRadius) continue;
    float closestDist = length(toOcc - rayDir * t);
    float penumbra = uSunRadius * (t / distToSun);
    float innerR = max(0.0, uShadowOccluderRadius[i] - penumbra);
    float outerR = uShadowOccluderRadius[i] + penumbra;
    if (outerR <= 0.0 || closestDist > outerR) continue;
    shadowFactor *= smoothstep(innerR, outerR, closestDist);
  }
  return shadowFactor;
}
`;

export type ShadowUniforms = {
  uSunWorldPos:          { value: THREE.Vector3 };
  uSunRadius:            { value: number };
  uShadowOccluderPos:    { value: THREE.Vector3[] };
  uShadowOccluderRadius: { value: Float32Array };
  uShadowOccluderCount:  { value: number };
};

export function makeShadowUniforms(): ShadowUniforms {
  return {
    uSunWorldPos:          { value: new THREE.Vector3() },
    uSunRadius:            { value: 0 },
    uShadowOccluderPos:    { value: Array.from({ length: MAX_SHADOW_OCCLUDERS }, () => new THREE.Vector3()) },
    uShadowOccluderRadius: { value: new Float32Array(MAX_SHADOW_OCCLUDERS) },
    uShadowOccluderCount:  { value: 0.0 },
  };
}

/** One occluder as the shader consumes it: scene-space center + scene-space radius. */
export type ShadowOccluder = { pos: THREE.Vector3; radius: number };

const _toSun = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _toOcc = new THREE.Vector3();
const _perp = new THREE.Vector3();

/**
 * Pick the occluders that actually shadow a receiver this frame.
 *
 * Ranking by raw angular size (the occluder that *looks* biggest from the
 * receiver) is wrong: in a moon system that ordering is essentially fixed by
 * orbital radius, so the same handful of moons hold every slot whether or not
 * they are anywhere near the sun line, and the moons that transit most often —
 * the close-in fast ones — never get a slot at all. The result is a receiver
 * that almost never shows a shadow.
 *
 * Instead each candidate is run through the same cone test the fragment shader
 * uses, at the receiver's center, and kept only when its penumbra can reach the
 * receiver's sphere at all. Survivors are ranked by how centered the receiver
 * sits in that penumbra, so the deepest shadow always gets a slot.
 *
 * All positions/radii are in scene units and in the same (origin-relative)
 * frame the shader sees.
 */
export function selectShadowOccluders(
  candidates: readonly ShadowOccluder[],
  receiverPos: THREE.Vector3,
  receiverRadius: number,
  sunPos: THREE.Vector3,
  sunRadius: number,
  max: number = MAX_SHADOW_OCCLUDERS,
): ShadowOccluder[] {
  _toSun.subVectors(sunPos, receiverPos);
  const distToSun = _toSun.length();
  if (distToSun < 1e-20) return [];
  _rayDir.copy(_toSun).divideScalar(distToSun);

  const scored: { occ: ShadowOccluder; miss: number }[] = [];
  for (const c of candidates) {
    _toOcc.subVectors(c.pos, receiverPos);
    const t = _toOcc.dot(_rayDir);
    // Entirely behind the receiver (it can only shadow what is further from
    // the sun), or at/past the sun's own surface. The test is against the
    // receiver's own extent rather than its center, so a planet at the center
    // of the ring annulus it shadows still qualifies — the per-fragment test
    // in the shader is what decides which part is actually in shadow.
    if (t < -receiverRadius || t > distToSun - sunRadius) continue;
    const closestDist = _perp.copy(_toOcc).addScaledVector(_rayDir, -t).length();
    const outerR = c.radius + sunRadius * (Math.max(t, 0) / distToSun);
    if (outerR <= 0) continue;
    // The penumbra is a disk of radius `outerR` centered on the sun-receiver
    // line; it touches the receiver's sphere when the miss distance is within
    // that radius plus the receiver's own radius.
    const reach = outerR + receiverRadius;
    if (closestDist > reach) continue;
    scored.push({ occ: { pos: c.pos, radius: c.radius }, miss: closestDist / reach });
  }

  scored.sort((a, b) => a.miss - b.miss);
  return scored.slice(0, max).map(s => s.occ);
}

export function injectShadowIntoShader(
  shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> },
  shadowUniforms: Record<string, { value: unknown }>,
): void {
  Object.assign(shader.uniforms, shadowUniforms);
  // Vertex: declare varying + set world position after project_vertex (always present)
  shader.vertexShader = 'varying vec3 vShadowWorldPos;\n' +
    shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\nvShadowWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    );
  // Fragment: prepend shadow function, attenuate outgoingLight before opaque output
  shader.fragmentShader = SHADOW_FRAG_PARS +
    shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      'outgoingLight *= computeEclipseShadow();\n#include <opaque_fragment>',
    );
}
