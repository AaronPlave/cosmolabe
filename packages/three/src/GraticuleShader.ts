import * as THREE from 'three';
import type { SurfaceCoordinates } from '@cosmolabe/core';

// Shared presentation thresholds for surface lines and fixed-site labels.
export const GRID_AUTO_STEPS = [30, 10, 5, 1, 0.2, 0.1, 0.02, 0.01, 0.005, 0.001] as const;
export const GRID_PRESENTATION = {
  horizon: [0.12, 0.45], congestion: [12, 36], detailCongestion: [16, 40],
} as const;
export function gridSmoothstep(edges: readonly [number, number], value: number): number {
  const t = THREE.MathUtils.clamp((value - edges[0]) / (edges[1] - edges[0]), 0, 1);
  return t * t * (3 - 2 * t);
}
export function makeGraticuleUniforms(coordinates: SurfaceCoordinates) {
  const shape = coordinates.datum.referenceShape;
  const [a,, c] = shape.kind === 'sphere' ? [shape.radiusKm, shape.radiusKm, shape.radiusKm] : shape.radiiKm;
  return {
    uGridViewToBody: { value: new THREE.Matrix4() },
    uGridShape: { value: new THREE.Vector3(a, c, coordinates.latitudeType === 'geodetic' && a !== c ? 1 : 0) },
    uGridStep: { value: new THREE.Vector2(30, 30) },
    uGridPreviousStep: { value: new THREE.Vector2(30, 30) },
    uGridDetailStep: { value: new THREE.Vector2(30, 30) },
    uGridPreviousDetailStep: { value: new THREE.Vector2(30, 30) },
    uGridHierarchy: { value: 1 },
    uGridPreviousHierarchy: { value: 1 },
    uGridBlend: { value: 1 },
    uGridVisible: { value: 0 },
    uGridMinor: { value: 0 },
    uGridPixelRatio: { value: 1 },
  };
}
export type GraticuleUniforms = ReturnType<typeof makeGraticuleUniforms>;
type Shader = { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> };
/** Rendered-mesh registration: no shell, no additional terrain residency. */
export function injectGraticule(shader: Shader, uniforms: GraticuleUniforms): void {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = `uniform mat4 uGridViewToBody;\nvarying vec3 vGridBody;\n` + shader.vertexShader;
  // modelViewMatrix is uploaded by Three.js for every object, including objects
  // sharing a material. Both transforms are composed on the CPU before upload.
  shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', 'vGridBody = (uGridViewToBody * modelViewMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>');
  shader.fragmentShader = `
varying vec3 vGridBody;
uniform mat4 uGridViewToBody;
uniform vec3 uGridShape;
uniform vec2 uGridStep, uGridPreviousStep, uGridDetailStep, uGridPreviousDetailStep;
uniform float uGridHierarchy, uGridPreviousHierarchy;
uniform float uGridBlend, uGridVisible, uGridMinor, uGridPixelRatio;
float gridLine(float angle, float stepSize, float derivative, vec2 congestion, float widthPx) {
  float distanceDeg = abs(mod(angle + stepSize * 0.5, stepSize) - stepSize * 0.5);
  float widthDeg = max(derivative, 0.0000001);
  // Fade subpixel lattices and heavily foreshortened fragments.
  return (1.0 - smoothstep(widthDeg * max(0.0, widthPx * 0.5 - 0.4), widthDeg * (widthPx * 0.5 + 0.4), distanceDeg))
    * smoothstep(congestion.x, congestion.y, stepSize / widthDeg);
}
float axisLine(vec2 angles, vec2 deriv, vec2 steps, vec2 congestion, float widthPx) {
  return max(gridLine(angles.x, steps.x, deriv.x, congestion, widthPx),
    gridLine(angles.y, steps.y, deriv.y, congestion, widthPx) * smoothstep(2.0, 8.0, 90.0 - abs(angles.x)));
}
vec4 gridColor(vec2 angles, vec2 deriv, vec2 stepSize, vec2 detailStep, float hierarchy) {
  vec2 majorCongestion = vec2(${GRID_PRESENTATION.congestion.join(', ')});
  vec2 detailCongestion = vec2(${GRID_PRESENTATION.detailCongestion.join(', ')});
  float major = axisLine(angles, deriv, stepSize, majorCongestion, 1.2);
  float opacity = major * mix(0.22, 0.17, hierarchy);
  // Fifth-step lines give every major cell the same quiet subdivision. They
  // carry no coordinate labels; the major lines remain the readable ruler.
  float minor = axisLine(angles, deriv, detailStep, detailCongestion, 0.6);
  opacity = max(opacity, minor * uGridMinor * mix(0.065, 0.055, hierarchy));
  float equator = 1.0 - smoothstep(deriv.x * 0.25, deriv.x * 0.85, abs(angles.x));
  float prime = (1.0 - smoothstep(deriv.y * 0.25, deriv.y * 0.85, abs(angles.y)))
    * smoothstep(2.0, 8.0, 90.0 - abs(angles.x));
  vec3 color = mix(vec3(0.36, 0.46, 0.58), vec3(0.72, 0.52, 0.29), equator);
  color = mix(color, vec3(0.68, 0.38, 0.35), prime);
  return vec4(color, max(opacity, max(equator, prime) * 0.35));
}

` + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
if (uGridVisible > 0.0) {
  vec3 p = vGridBody;
  float rxy = length(p.xy);
  float lat = atan(p.z, max(rxy, 0.0000001));
  if (uGridShape.z > 0.5) {
    float e2 = 1.0 - pow(uGridShape.y / uGridShape.x, 2.0);
    lat = atan(p.z, max(rxy * (1.0 - e2), 0.0000001));
    for (int i = 0; i < 8; i++) {
      float n = uGridShape.x / sqrt(1.0 - e2 * sin(lat) * sin(lat));
      lat = atan(p.z + e2 * n * sin(lat), max(rxy, 0.0000001));
    }
  }
  float lon = atan(p.y, p.x);
  vec2 angles = vec2(lat, lon) * 57.29577951308232;
  // Differentiate the longitude unit vector, not atan across its +/-180 seam.
  vec2 unitLon = vec2(cos(lon), sin(lon));
  vec2 deriv = vec2(fwidth(angles.x), (length(dFdx(unitLon)) + length(dFdy(unitLon))) * 57.29577951308232);
  deriv = max(deriv * uGridPixelRatio, vec2(0.0000001));
  vec4 grid = mix(gridColor(angles, deriv, uGridPreviousStep, uGridPreviousDetailStep, uGridPreviousHierarchy), gridColor(angles, deriv, uGridStep, uGridDetailStep, uGridHierarchy), uGridBlend);
  vec3 bodyNormal = normalize(p / vec3(uGridShape.x * uGridShape.x, uGridShape.x * uGridShape.x, uGridShape.y * uGridShape.y));
  vec3 eye = (uGridViewToBody * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float horizon = smoothstep(${GRID_PRESENTATION.horizon[0]}, ${GRID_PRESENTATION.horizon[1]}, dot(bodyNormal, normalize(eye - p)));
  outgoingLight = mix(outgoingLight, grid.rgb, grid.a * horizon * uGridVisible);
}
#include <opaque_fragment>`);
}
/** A camera-to-body transform shared by all objects using this surface material. */
export function applyGraticuleMaterial(material: THREE.Material, uniforms: GraticuleUniforms, bodyFromWorld: THREE.Matrix4): void {
  if (material.userData.graticule) return;
  material.userData.graticule = true;
  const localUniforms = { ...uniforms, uGridViewToBody: { value: new THREE.Matrix4() } };
  const compile = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => { compile(shader, renderer); injectGraticule(shader, localUniforms); };
  material.customProgramCacheKey = () => key + '_graticule_v7';
  const render = material.onBeforeRender.bind(material);
  material.onBeforeRender = (renderer, scene, camera, geometry, object, group) => {
    render(renderer, scene, camera, geometry, object, group);
    localUniforms.uGridViewToBody.value.multiplyMatrices(bodyFromWorld, camera.matrixWorld);
  };
  material.needsUpdate = true;
}

/** Preserve material identity for tile eviction and fade-plugin registration. */
export function applyGraticuleToScene(scene: THREE.Object3D, uniforms: GraticuleUniforms, transform: THREE.Matrix4): void {
  scene.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      applyGraticuleMaterial(material, uniforms, transform);
    }
  });
}
