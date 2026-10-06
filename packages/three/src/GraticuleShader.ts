import * as THREE from 'three';
import type { SurfaceCoordinates } from '@cosmolabe/core';

export function makeGraticuleUniforms(coordinates: SurfaceCoordinates) {
  const shape = coordinates.datum.referenceShape;
  const [a,, c] = shape.kind === 'sphere' ? [shape.radiusKm, shape.radiusKm, shape.radiusKm] : shape.radiiKm;
  return {
    uGridModelToBody: { value: new THREE.Matrix4() },
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
  shader.vertexShader = `uniform mat4 uGridModelToBody;\nvarying vec3 vGridBody;\n` + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', 'vGridBody = (uGridModelToBody * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>');
  shader.fragmentShader = `
varying vec3 vGridBody;
uniform vec3 uGridShape;
uniform vec2 uGridStep, uGridPreviousStep;
uniform float uGridBlend, uGridVisible, uGridMinor, uGridPixelRatio;
float gridLine(float angle, float stepSize, float derivative) {
  float distanceDeg = abs(mod(angle + stepSize * 0.5, stepSize) - stepSize * 0.5);
  float widthDeg = max(derivative, 0.0000001);
  // Fade subpixel lattices and heavily foreshortened fragments.
  return (1.0 - smoothstep(widthDeg * 0.35, widthDeg * 1.35, distanceDeg))
    * smoothstep(3.0, 12.0, stepSize / widthDeg);
}
vec4 gridColor(vec2 angles, vec2 deriv, vec2 stepSize) {
  float latLine = gridLine(angles.x, stepSize.x, deriv.x);
  float lonLine = gridLine(angles.y, stepSize.y, deriv.y);
  // Longitude has no meaning at the pole; independently suppress congested meridians.
  lonLine *= smoothstep(0.5, 2.0, 90.0 - abs(angles.x));
  float major = max(latLine, lonLine);
  float minor = max(gridLine(angles.x, stepSize.x * 0.5, deriv.x), gridLine(angles.y, stepSize.y * 0.5, deriv.y)
    * smoothstep(0.5, 2.0, 90.0 - abs(angles.x)));
  float equator = 1.0 - smoothstep(deriv.x * 0.35, deriv.x * 1.35, abs(angles.x));
  float prime = (1.0 - smoothstep(deriv.y * 0.35, deriv.y * 1.35, abs(angles.y))) * lonLine;
  vec3 color = mix(vec3(0.40, 0.59, 0.82), vec3(0.92, 0.60, 0.23), equator);
  color = mix(color, vec3(0.92, 0.32, 0.30), prime);
  return vec4(color, max(max(major * 0.48, minor * uGridMinor * 0.18), max(equator, prime) * 0.65));
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
  outgoingLight = mix(outgoingLight, grid.rgb, grid.a * uGridVisible);
}
#include <opaque_fragment>`);
}
/** One transform per material draw, computed on CPU to retain regional precision. */
export function applyGraticuleMaterial(material: THREE.Material, uniforms: GraticuleUniforms, bodyFromWorld: THREE.Matrix4): void {
  if (material.userData.graticule) return;
  material.userData.graticule = true;
  const localUniforms = { ...uniforms, uGridModelToBody: { value: new THREE.Matrix4() } };
  const compile = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => { compile(shader, renderer); injectGraticule(shader, localUniforms); };
  material.customProgramCacheKey = () => key + '_graticule_v1';
  const render = material.onBeforeRender.bind(material);
  material.onBeforeRender = (renderer, scene, camera, geometry, object, group) => {
    render(renderer, scene, camera, geometry, object, group);
    localUniforms.uGridModelToBody.value.multiplyMatrices(bodyFromWorld, object.matrixWorld);
  };
  material.needsUpdate = true;
}

/** Attach per-mesh materials so transform uniforms are not aliased between tiles. */
export function applyGraticuleToScene(scene: THREE.Object3D, uniforms: GraticuleUniforms, transform: THREE.Matrix4): void {
  scene.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = (Array.isArray(child.material) ? child.material : [child.material]).map((original: THREE.Material) => {
      if (original.userData.graticule) return original;
      // Preserve imagery/shadow hooks when cloning a shared upstream material.
      const material = original.clone();
      material.onBeforeCompile = original.onBeforeCompile.bind(original);
      const key = original.customProgramCacheKey();
      material.customProgramCacheKey = () => key;
      applyGraticuleMaterial(material, uniforms, transform);
      original.dispose();
      return material;
    });
    child.material = Array.isArray(child.material) ? materials : materials[0];
  });
}
