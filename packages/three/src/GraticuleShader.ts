import * as THREE from 'three';
import type { SurfaceCoordinates } from '@cosmolabe/core';

export function makeGraticuleUniforms(coordinates: SurfaceCoordinates) {
  const shape = coordinates.datum.referenceShape;
  const [a,, c] = shape.kind === 'sphere' ? [shape.radiusKm, shape.radiusKm, shape.radiusKm] : shape.radiiKm;
  return {
    uGridViewToBody: { value: new THREE.Matrix4() },
    uGridShape: { value: new THREE.Vector3(a, c, coordinates.latitudeType === 'geodetic' && a !== c ? 1 : 0) },
    uGridStep: { value: new THREE.Vector2(30, 30) },
    uGridPreviousStep: { value: new THREE.Vector2(30, 30) },
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
uniform vec2 uGridStep, uGridPreviousStep;
uniform float uGridBlend, uGridVisible, uGridMinor, uGridPixelRatio;
float gridLine(float angle, float stepSize, float derivative) {
  float distanceDeg = abs(mod(angle + stepSize * 0.5, stepSize) - stepSize * 0.5);
  float widthDeg = max(derivative, 0.0000001);
  // Fade subpixel lattices and heavily foreshortened fragments.
  return (1.0 - smoothstep(widthDeg * 0.25, widthDeg * 0.85, distanceDeg))
    * smoothstep(6.0, 18.0, stepSize / widthDeg);
}
vec4 gridColor(vec2 angles, vec2 deriv, vec2 stepSize) {
  float latLine = gridLine(angles.x, stepSize.x, deriv.x);
  float lonLine = gridLine(angles.y, stepSize.y, deriv.y);
  // Longitude has no meaning at the pole; independently suppress congested meridians.
  lonLine *= smoothstep(2.0, 8.0, 90.0 - abs(angles.x));
  float major = max(latLine, lonLine);
  float minor = max(gridLine(angles.x, stepSize.x * 0.5, deriv.x), gridLine(angles.y, stepSize.y * 0.5, deriv.y)
    * smoothstep(2.0, 8.0, 90.0 - abs(angles.x)));
  float equator = 1.0 - smoothstep(deriv.x * 0.25, deriv.x * 0.85, abs(angles.x));
  float prime = (1.0 - smoothstep(deriv.y * 0.25, deriv.y * 0.85, abs(angles.y))) * lonLine;
  vec3 color = mix(vec3(0.36, 0.46, 0.58), vec3(0.72, 0.52, 0.29), equator);
  color = mix(color, vec3(0.68, 0.38, 0.35), prime);
  return vec4(color, max(max(major * 0.22, minor * uGridMinor * 0.07), max(equator, prime) * 0.35));
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
  vec4 grid = mix(gridColor(angles, deriv, uGridPreviousStep), gridColor(angles, deriv, uGridStep), uGridBlend);
  // Modulate the overlay by the surface lighting instead of illuminating night.
  float luminance = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
  // Normalize by albedo so dark daytime imagery still has a useful grid.
  float illumination = luminance / max(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.001);
  float lighting = mix(0.08, 1.0, smoothstep(0.02, 0.5, illumination));
  vec3 bodyNormal = normalize(p / vec3(uGridShape.x * uGridShape.x, uGridShape.x * uGridShape.x, uGridShape.y * uGridShape.y));
  vec3 eye = (uGridViewToBody * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float horizon = smoothstep(0.08, 0.35, dot(bodyNormal, normalize(eye - p)));
  outgoingLight = mix(outgoingLight, grid.rgb * lighting, grid.a * lighting * horizon * uGridVisible);
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
  material.customProgramCacheKey = () => key + '_graticule_v2';
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
