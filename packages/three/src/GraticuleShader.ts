import * as THREE from 'three';
import { bodyFixedToSurfacePosition, type SurfaceCoordinates } from '@cosmolabe/core';

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
    uGridOpacity: { value: 1 },
    uGridPixelRatio: { value: 1 },
  };
}
export type GraticuleUniforms = ReturnType<typeof makeGraticuleUniforms>;
type Shader = { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> };
/** Rendered-mesh registration: no shell, no additional terrain residency. */
export function injectGraticule(shader: Shader, uniforms: GraticuleUniforms): void {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = `uniform mat4 uGridViewToBody;\nvarying vec3 vGridOffset;\n` + shader.vertexShader;
  // modelViewMatrix is uploaded by Three.js for every object, including objects
  // sharing a material. Keep the body origin out of the interpolated varying.
  shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', 'vGridOffset = mat3(uGridViewToBody) * (modelViewMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>');
  shader.fragmentShader = `
varying vec3 vGridOffset;
uniform mat4 uGridViewToBody;
uniform vec3 uGridShape, uGridOrigin;
uniform vec4 uGridReference;
uniform vec2 uGridOriginAngles, uGridPhase, uGridPreviousPhase, uGridDetailPhase, uGridPreviousDetailPhase;
uniform vec2 uGridStep, uGridPreviousStep, uGridDetailStep, uGridPreviousDetailStep;
uniform float uGridHierarchy, uGridPreviousHierarchy;
uniform float uGridBlend, uGridVisible, uGridMinor, uGridPixelRatio, uGridOpacity;
float gridLine(float angle, float stepSize, float derivative, vec2 congestion, float widthPx) {
  float distanceDeg = abs(mod(angle + stepSize * 0.5, stepSize) - stepSize * 0.5);
  float widthDeg = max(derivative, 0.0000001);
  // Fade subpixel lattices and heavily foreshortened fragments.
  return (1.0 - smoothstep(widthDeg * max(0.0, widthPx * 0.5 - 0.4), widthDeg * (widthPx * 0.5 + 0.4), distanceDeg))
    * smoothstep(congestion.x, congestion.y, stepSize / widthDeg);
}
// Longitude convergence is governed by its pixel footprint, like latitude.
// A latitude-only fade erases readable close-up meridians near either pole.
float axisLine(vec2 angles, vec2 deriv, vec2 steps, vec2 congestion, float widthPx) {
  return max(gridLine(angles.x, steps.x, deriv.x, congestion, widthPx),
    gridLine(angles.y, steps.y, deriv.y, congestion, widthPx));
}
vec4 gridColor(vec2 angles, vec2 deriv, vec2 stepSize, vec2 detailStep, vec2 phase, vec2 detailPhase, float hierarchy) {
  vec2 majorCongestion = vec2(${GRID_PRESENTATION.congestion.join(', ')});
  vec2 detailCongestion = vec2(${GRID_PRESENTATION.detailCongestion.join(', ')});
  float major = axisLine(angles + phase, deriv, stepSize, majorCongestion, 1.2);
  float opacity = major * mix(0.22, 0.17, hierarchy);
  // Fifth-step lines give every major cell the same quiet subdivision. They
  // carry no coordinate labels; the major lines remain the readable ruler.
  float minor = axisLine(angles + detailPhase, deriv, detailStep, detailCongestion, 0.6);
  opacity = max(opacity, minor * uGridMinor * mix(0.065, 0.055, hierarchy));
  angles += uGridOriginAngles;
  float equator = 1.0 - smoothstep(deriv.x * 0.25, deriv.x * 0.85, abs(angles.x));
  float prime = (1.0 - smoothstep(deriv.y * 0.25, deriv.y * 0.85, abs(angles.y)))
    * smoothstep(majorCongestion.x, majorCongestion.y, stepSize.y / deriv.y);
  vec3 color = mix(vec3(0.36, 0.46, 0.58), vec3(0.72, 0.52, 0.29), equator);
  color = mix(color, vec3(0.68, 0.38, 0.35), prime);
  return vec4(color, max(opacity, max(equator, prime) * 0.35));
}

` + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
if (uGridVisible > 0.0) {
  // Interpolate camera-relative offsets, never planet-sized coordinates.
  // Compute angular differences before adding the CPU-reduced lattice phase.
  vec3 p = uGridOrigin + vGridOffset;
  float r0 = length(uGridOrigin.xy);
  vec2 east = r0 > 0.0 ? uGridOrigin.xy / r0 : vec2(1.0, 0.0);
  float along = dot(vGridOffset.xy, east);
  float across = dot(vGridOffset.xy, vec2(-east.y, east.x));
  float r = length(vec2(r0 + along, across));
  float dr = (2.0 * r0 * along + dot(vGridOffset.xy, vGridOffset.xy)) / max(r + r0, 0.0000001);
  float sin0 = uGridReference.x, cos0 = uGridReference.y;
  float north = vGridOffset.z * cos0 - dr * sin0;
  float radial = uGridReference.z + dr * cos0 + vGridOffset.z * sin0;
  float deltaLat = atan(north, radial);
  if (uGridShape.z > 0.5) {
    float e2 = 1.0 - pow(uGridShape.y / uGridShape.x, 2.0);
    float root0 = sqrt(1.0 - e2 * sin0 * sin0);
    for (int i = 0; i < 8; i++) {
      // Stable differences of N*sin(latitude) around the CPU reference.
      float halfSin = sin(deltaLat * 0.5);
      float ds = -2.0 * sin0 * halfSin * halfSin + cos0 * sin(deltaLat);
      float sine = sin0 + ds;
      float root = sqrt(1.0 - e2 * sine * sine);
      float n = uGridShape.x / root;
      float dn = uGridReference.w * e2 * ds * (2.0 * sin0 + ds) / (root * (root0 + root));
      float correction = e2 * (dn * sin0 + n * ds);
      deltaLat = atan(north + correction * cos0, radial + correction * sin0);
    }
  }
  float deltaLon = atan(across, r0 + along);
  vec2 angles = vec2(deltaLat, deltaLon) * 57.29577951308232;
  vec2 unitLon = vec2(cos(deltaLon), sin(deltaLon));
  vec2 deriv = vec2(fwidth(angles.x), (length(dFdx(unitLon)) + length(dFdy(unitLon))) * 57.29577951308232);
  deriv = max(deriv * uGridPixelRatio, vec2(0.0000001));
  vec4 grid = mix(gridColor(angles, deriv, uGridPreviousStep, uGridPreviousDetailStep, uGridPreviousPhase, uGridPreviousDetailPhase, uGridPreviousHierarchy), gridColor(angles, deriv, uGridStep, uGridDetailStep, uGridPhase, uGridDetailPhase, uGridHierarchy), uGridBlend);
  vec3 bodyNormal = normalize(p / vec3(uGridShape.x * uGridShape.x, uGridShape.x * uGridShape.x, uGridShape.y * uGridShape.y));
  float horizon = smoothstep(${GRID_PRESENTATION.horizon[0]}, ${GRID_PRESENTATION.horizon[1]}, dot(bodyNormal, normalize(-vGridOffset)));
  outgoingLight = mix(outgoingLight, grid.rgb, grid.a * horizon * uGridVisible * uGridOpacity);
}
#include <opaque_fragment>`);
}
const graticuleMaterials = new WeakSet<THREE.Material>();

/** A camera-to-body transform shared by all objects using this surface material. */
export function applyGraticuleMaterial(material: THREE.Material, uniforms: GraticuleUniforms, bodyFromWorld: THREE.Matrix4): void {
  if (graticuleMaterials.has(material)) return;
  graticuleMaterials.add(material);
  material.userData.graticule = true;
  const localUniforms = { ...uniforms, uGridViewToBody: { value: new THREE.Matrix4() },
    uGridOrigin: { value: new THREE.Vector3() }, uGridReference: { value: new THREE.Vector4() },
    uGridOriginAngles: { value: new THREE.Vector2() },
    uGridPhase: { value: new THREE.Vector2() }, uGridPreviousPhase: { value: new THREE.Vector2() },
    uGridDetailPhase: { value: new THREE.Vector2() }, uGridPreviousDetailPhase: { value: new THREE.Vector2() },
  };
  const compile = material.onBeforeCompile.bind(material);
  const previousKey = material.customProgramCacheKey.bind(material);
  const defaultKey = material.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey;
  const key = previousKey();
  material.onBeforeCompile = (shader, renderer) => { compile(shader, renderer); injectGraticule(shader, localUniforms); };
  material.customProgramCacheKey = () => (defaultKey ? key : previousKey()) + '_graticule_v10';
  const shape = uniforms.uGridShape.value;
  const coordinates: SurfaceCoordinates = {
    frame: '', latitudeType: shape.z > 0.5 ? 'geodetic' : 'planetocentric', positiveLongitude: 'east', longitudeDomain: 'signed',
    datum: { referenceShape: { kind: 'ellipsoid', radiiKm: [shape.x, shape.x, shape.y] }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' },
  };
  const previousOrigin = new THREE.Vector3(NaN, NaN, NaN);
  const setPhase = (phase: THREE.Vector2, step: THREE.Vector2, lat: number, lon: number) => phase.set(lat % step.x, lon % step.y);
  const render = material.onBeforeRender.bind(material);
  material.onBeforeRender = (renderer, scene, camera, geometry, object, group) => {
    render(renderer, scene, camera, geometry, object, group);
    localUniforms.uGridViewToBody.value.multiplyMatrices(bodyFromWorld, camera.matrixWorld);
    const origin = localUniforms.uGridOrigin.value.setFromMatrixPosition(localUniforms.uGridViewToBody.value);
    let { x: latDeg, y: lonDeg } = localUniforms.uGridOriginAngles.value;
    if (!origin.equals(previousOrigin)) {
      previousOrigin.copy(origin);
      const position = bodyFixedToSurfacePosition({ xKm: origin.x, yKm: origin.y, zKm: origin.z }, coordinates);
      latDeg = position.latDeg; lonDeg = position.lonDeg;
      const lat = latDeg * Math.PI / 180, sin = Math.sin(lat), cos = Math.cos(lat);
      const e2 = shape.z > 0.5 ? 1 - (shape.y / shape.x) ** 2 : 0;
      const n = shape.x / Math.sqrt(1 - e2 * sin * sin);
      localUniforms.uGridReference.value.set(sin, cos, Math.hypot(origin.x, origin.y) * cos + origin.z * sin + e2 * n * sin * sin, n);
      localUniforms.uGridOriginAngles.value.set(latDeg, lonDeg);
    }
    setPhase(localUniforms.uGridPhase.value, uniforms.uGridStep.value, latDeg, lonDeg);
    setPhase(localUniforms.uGridPreviousPhase.value, uniforms.uGridPreviousStep.value, latDeg, lonDeg);
    setPhase(localUniforms.uGridDetailPhase.value, uniforms.uGridDetailStep.value, latDeg, lonDeg);
    setPhase(localUniforms.uGridPreviousDetailPhase.value, uniforms.uGridPreviousDetailStep.value, latDeg, lonDeg);
  };
  material.needsUpdate = true;
}

/** Preserve material identity for tile eviction and fade-plugin registration. */
export function applyGraticuleToScene(scene: THREE.Object3D, uniforms: GraticuleUniforms, transform: THREE.Matrix4): void {
  scene.traverse(child => {
    // Loader meshes may originate from another Three module instance. The
    // documented capability flag is stable across that boundary.
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      applyGraticuleMaterial(material, uniforms, transform);
    }
  });
}
