import * as THREE from 'three';
import type { AtmosphereModel } from './AtmosphereModel.js';
import { ATMOSPHERE_PROFILES_GLSL, makeAtmosphereProfileUniforms } from './AtmosphereProfiles.js';

const WIDTH = 256;
const HEIGHT = 64;
const STEPS = 96;

/** RGB direct transmittance from altitude and solar zenith to the atmosphere exit. */
export function buildTransmittanceLUT(
  renderer: THREE.WebGLRenderer,
  model: AtmosphereModel,
  planetRadiusKm: number,
): THREE.WebGLRenderTarget {
  const shellRadiusKm = planetRadiusKm + model.heightKm;
  const planetR = planetRadiusKm / shellRadiusKm;
  const rt = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, {
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
  const material = new THREE.ShaderMaterial({
    uniforms: makeAtmosphereProfileUniforms(model, shellRadiusKm, planetR, 1, null),
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      ${ATMOSPHERE_PROFILES_GLSL}

      void main() {
        float mu = vUv.x * 2.0 - 1.0;
        float radius = mix(uAtmPlanetR, uAtmShellR, vUv.y);
        vec3 point = vec3(0.0, radius, 0.0);
        vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
        if (atmSunBlocked(point, sunDir)) {
          gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
          return;
        }
        float b = dot(point, sunDir);
        float c = dot(point, point) - uAtmShellR * uAtmShellR;
        float lengthToExit = max(0.0, -b + sqrt(max(0.0, b * b - c)));
        float stepLen = lengthToExit / float(${STEPS});
        vec3 opticalDepth = vec3(0.0);
        for (int i = 0; i < ${STEPS}; i++) {
          vec3 samplePos = point + sunDir * ((float(i) + 0.5) * stepLen);
          float altitude = max(0.0, length(samplePos) - uAtmPlanetR);
          opticalDepth += atmExtinction(atmDensities(altitude)) * stepLen;
        }
        gl_FragColor = vec4(exp(-opticalDepth), 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.PlaneGeometry(2, 2);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(quad, material));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const previousTarget = renderer.getRenderTarget();
  const previousAutoClear = renderer.autoClear;
  renderer.autoClear = true;
  try {
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
    quad.dispose();
    material.dispose();
  }
  return rt;
}
