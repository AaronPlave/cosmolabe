import * as THREE from 'three';
import { MAX_SHADOW_OCCLUDERS } from './EclipseShadow.js';
import { ATMOSPHERE_PROFILES_GLSL } from './AtmosphereProfiles.js';

const WIDTH = 192;
const HEIGHT = 108;

/** Camera-up and sun-azimuth coordinates shared by the LUT writer and shell reader. */
export const SKY_VIEW_BASIS_GLSL = /* glsl */ `
void skyBasis(vec3 eye, vec3 sun, out vec3 up, out vec3 towardSun, out vec3 side) {
  up = normalize(eye);
  towardSun = sun - up * dot(sun, up);
  if (dot(towardSun, towardSun) < 1e-8) {
    towardSun = cross(up, abs(up.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0));
  }
  towardSun = normalize(towardSun);
  side = normalize(cross(up, towardSun));
}
`;

/** Rebuilds a view radiance/transmittance table while the camera is in the shell. */
export class SkyViewLUT {
  readonly target = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, {
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });

  private readonly quad = new THREE.PlaneGeometry(2, 2);
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  private readonly material: THREE.ShaderMaterial;

  constructor(uniforms: Record<string, THREE.IUniform>) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...uniforms,
        uSkyEye: { value: new THREE.Vector3() },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform vec3 uSkyEye;
        uniform vec3 lightDir;
        uniform vec3 lightColor;
        uniform float planetR;
        uniform float planetCapBias;
        uniform float mieK;
        uniform sampler2D uMultiScatterLUT;
        uniform mat4 uAtmModelToWorld;
        uniform vec3 uSunWorldPos;
        uniform float uSunRadius;
        uniform vec3 uShadowOccluderPos[${MAX_SHADOW_OCCLUDERS}];
        uniform float uShadowOccluderRadius[${MAX_SHADOW_OCCLUDERS}];
        uniform float uShadowOccluderCount;
        ${ATMOSPHERE_PROFILES_GLSL}
        ${SKY_VIEW_BASIS_GLSL}

        float eclipseVisibility(vec3 samplePos) {
          vec3 worldPos = (uAtmModelToWorld * vec4(samplePos, 1.0)).xyz;
          vec3 toSun = uSunWorldPos - worldPos;
          float distToSun = length(toSun);
          if (distToSun < 1e-20) return 1.0;
          vec3 rayDir = toSun / distToSun;
          float visibility = 1.0;
          for (int i = 0; i < ${MAX_SHADOW_OCCLUDERS}; i++) {
            if (float(i) >= uShadowOccluderCount) break;
            vec3 toOcc = uShadowOccluderPos[i] - worldPos;
            float t = dot(toOcc, rayDir);
            if (t < 1e-10 || t > distToSun) continue;
            float distance = length(toOcc - rayDir * t);
            float innerR = max(0.0, uShadowOccluderRadius[i] - uSunRadius * t / distToSun);
            float outerR = uShadowOccluderRadius[i] + uSunRadius * t / distToSun;
            visibility *= smoothstep(innerR, outerR, distance);
          }
          return visibility;
        }

        void main() {
          vec3 up, towardSun, side;
          skyBasis(uSkyEye, lightDir, up, towardSun, side);
          float theta = vUv.y * 3.14159265358979;
          float azimuth = (vUv.x * 2.0 - 1.0) * 3.14159265358979;
          vec3 viewDir = up * cos(theta) +
            sin(theta) * (towardSun * cos(azimuth) + side * sin(azimuth));

          float b = dot(uSkyEye, viewDir);
          float c = dot(uSkyEye, uSkyEye) - 1.0;
          float disc = b * b - c;
          if (disc < 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
          float enter = max(0.0, -b - sqrt(disc));
          float end = -b + sqrt(disc);
          float capR = max(0.0, planetR - planetCapBias);
          float planetDisc = b * b - (dot(uSkyEye, uSkyEye) - capR * capR);
          if (planetDisc > 0.0) {
            float hit = -b - sqrt(planetDisc);
            if (hit > enter) end = min(end, hit);
          }
          float stepLen = max(0.0, end - enter) / 16.0;
          float cosTheta = dot(-viewDir, lightDir);
          float phRayleigh = 0.75 * (1.0 + cosTheta * cosTheta);
          float phMie = (1.0 - mieK * mieK) /
            ((1.0 - mieK * cosTheta) * (1.0 - mieK * cosTheta));
          vec3 radiance = vec3(0.0);
          vec3 depth = vec3(0.0);
          for (int i = 0; i < 16; i++) {
            vec3 point = uSkyEye + viewDir * (enter + (float(i) + 0.5) * stepLen);
            float altitude = max(0.0, length(point) - planetR);
            vec3 density = atmDensities(altitude);
            vec3 extinction = atmExtinction(density);
            vec3 weight = atmSegmentWeight(extinction, stepLen);
            vec3 sunT = atmSunTransmittance(point, lightDir);
            float visibility = eclipseVisibility(point);
            float cosSunZenith = dot(normalize(point), lightDir);
            vec3 multi = texture2D(uMultiScatterLUT, vec2(
              cosSunZenith * 0.5 + 0.5, altitude / max(1e-6, 1.0 - planetR))).rgb;
            vec3 source = sunT * atmScattering(density, phRayleigh, phMie) +
              multi * atmScatteringSum(density);
            radiance += exp(-depth) * source * weight * visibility;
            depth += extinction * stepLen;
          }
          vec3 transmission = exp(-depth);
          float alpha = dot(transmission, vec3(0.3333333));
          float glare = pow(max(0.0, cosTheta), 256.0);
          radiance = lightColor * (radiance + glare * 0.15 * (1.0 - alpha));
          gl_FragColor = vec4(radiance, alpha);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(this.quad, this.material));
  }

  update(renderer: THREE.WebGLRenderer, eye: THREE.Vector3): void {
    this.material.uniforms.uSkyEye.value.copy(eye);
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    try {
      renderer.setRenderTarget(this.target);
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
    }
  }

  dispose(): void {
    this.target.dispose();
    this.quad.dispose();
    this.material.dispose();
  }
}
