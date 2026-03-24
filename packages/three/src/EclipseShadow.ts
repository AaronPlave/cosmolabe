import * as THREE from 'three';

// ---- Eclipse shadow GLSL injection ----
// Injected into body material shaders via onBeforeCompile.
// Ray-sphere approach: cast a ray from each fragment toward the sun and test
// intersection against each occluder sphere. Computes smooth umbra/penumbra
// using the sun's angular radius at the occluder distance.

export const SHADOW_FRAG_PARS = /* glsl */`
varying vec3 vShadowWorldPos;
uniform vec3  uSunWorldPos;
uniform float uSunRadius;
uniform vec3  uShadowOccluderPos[4];
uniform float uShadowOccluderRadius[4];
uniform float uShadowOccluderCount;

float computeEclipseShadow() {
  vec3 toSun = uSunWorldPos - vShadowWorldPos;
  float distToSun = length(toSun);
  if (distToSun < 1e-20) return 1.0;
  vec3 rayDir = toSun / distToSun;
  float shadowFactor = 1.0;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= uShadowOccluderCount) break;
    vec3 toOcc = uShadowOccluderPos[i] - vShadowWorldPos;
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
    uShadowOccluderPos:    { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
    uShadowOccluderRadius: { value: new Float32Array(4) },
    uShadowOccluderCount:  { value: 0.0 },
  };
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
