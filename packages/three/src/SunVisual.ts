import * as THREE from 'three';
import type { AtmosphereMesh } from './AtmosphereMesh.js';
import { ATMOSPHERE_PROFILES_GLSL, makeAtmosphereProfileUniforms } from './AtmosphereProfiles.js';
import { normalizeAtmosphere } from './AtmosphereModel.js';

/** Dedicated disk layer, drawn after atmosphere shells to apply extinction once. */
export const SOLAR_LAYER = 4;

/** A radiance source, independent of the scene's lighting and generic bloom. */
export class SunVisual {
  readonly material: THREE.ShaderMaterial;
  readonly uniforms;
  diameterPixels = 0;
  private atmosphere: AtmosphereMesh | null = null;
  private readonly inverse = new THREE.Matrix4();
  private readonly eye = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();

  constructor() {
    // Unused until an atmosphere is assigned, but keeps every shader uniform defined.
    const vacuum = normalizeAtmosphere({ rayleighCoeff: [0, 0, 0], mieCoeff: 0,
      absorptionCoeff: [0, 0, 0], mieScaleHeight: 1, miePhaseAsymmetry: 0 });
    this.uniforms = {
      ...makeAtmosphereProfileUniforms(vacuum, 1, 1, 2, null),
      sourcePass: { value: false },
      occluderCount: { value: 0 },
      worldToOccluder: { value: Array.from({ length: 8 }, () => new THREE.Matrix4()) },
      occluderRadius: { value: new Float32Array(8) },
      sourceScale: { value: 1 },
      resolvedWeight: { value: 1 },
      granulationWeight: { value: 0 },
      hasAtmosphere: { value: false },
      worldToAtmosphere: { value: new THREE.Matrix4() },
      solarCenter: { value: new THREE.Vector3() },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        uniform bool sourcePass;
        uniform float sourceScale;
        uniform vec3 solarCenter;
        varying vec3 vWorldPosition;
        varying vec3 vViewPosition;
        varying vec3 vViewNormal;
        varying vec3 vSurfaceNormal;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vec4 view = viewMatrix * world;
          vWorldPosition = world.xyz;
          vViewPosition = view.xyz;
          vViewNormal = normalize(normalMatrix * normal);
          vSurfaceNormal = normalize(position);
          gl_Position = projectionMatrix * view;
          // Only the offscreen optical source gets a pixel footprint. The body
          // remains at its physical radius for display, picking and occultation.
          if (sourcePass) {
            vec4 center = projectionMatrix * viewMatrix * vec4(solarCenter, 1.0);
            gl_Position.xy = center.xy / center.w * gl_Position.w +
              (gl_Position.xy - center.xy / center.w * gl_Position.w) * sourceScale;
          }
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform bool sourcePass;
        uniform float sourceScale;
        uniform float resolvedWeight;
        uniform float granulationWeight;
        uniform int occluderCount;
        uniform mat4 worldToOccluder[8];
        uniform float occluderRadius[8];
        uniform bool hasAtmosphere;
        uniform mat4 worldToAtmosphere;
        varying vec3 vWorldPosition;
        varying vec3 vViewPosition;
        varying vec3 vViewNormal;
        varying vec3 vSurfaceNormal;
        #include <logdepthbuf_pars_fragment>
        ${ATMOSPHERE_PROFILES_GLSL}
        float cellHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float cells(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(cellHash(i), cellHash(i + vec3(1,0,0)), f.x),
            mix(cellHash(i + vec3(0,1,0)), cellHash(i + vec3(1,1,0)), f.x), f.y),
            mix(mix(cellHash(i + vec3(0,0,1)), cellHash(i + vec3(1,0,1)), f.x),
            mix(cellHash(i + vec3(0,1,1)), cellHash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        void main() {
          #include <logdepthbuf_fragment>
          float mu = clamp(dot(normalize(vViewNormal), normalize(-vViewPosition)), 0.0, 1.0);
          // Broadband linear limb darkening: 40% of center radiance at the limb.
          vec3 radiance = vec3(3.2, 3.08, 2.88) * (0.4 + 0.6 * mu);
          if (hasAtmosphere) {
            vec3 eye = (worldToAtmosphere * vec4(cameraPosition, 1.0)).xyz;
            vec3 point = (worldToAtmosphere * vec4(vWorldPosition, 1.0)).xyz;
            radiance *= atmSunTransmittance(eye, normalize(point - eye));
          }
          if (sourcePass && sourceScale > 1.0) {
            // Rasterizing the optical footprint must not widen the occultation
            // geometry: test the original photosphere ray against nearby globes.
            for (int i = 0; i < 8; i++) {
              if (i >= occluderCount) break;
              vec3 eye = (worldToOccluder[i] * vec4(cameraPosition, 1.0)).xyz;
              vec3 end = (worldToOccluder[i] * vec4(vWorldPosition, 1.0)).xyz;
              float distance = length(end - eye);
              vec3 direction = (end - eye) / distance;
              float b = dot(eye, direction);
              float disc = b * b - dot(eye, eye) + occluderRadius[i] * occluderRadius[i];
              if (disc > 0.0 && -b + sqrt(disc) > 0.0 &&
                  max(0.0, -b - sqrt(disc)) < distance) radiance = vec3(0.0);
            }
          }
          if (sourcePass) {
            gl_FragColor = vec4(radiance / (sourceScale * sourceScale), 1.0);
          } else {
            // Visualization mapping preserves the linear limb profile instead of
            // compressing HDR photospheric structure into display saturation.
            vec3 display = radiance * (0.94 / 3.2);
            if (granulationWeight > 0.0) {
              vec3 p = normalize(vSurfaceNormal) * 420.0;
              float filterWeight = 1.0 - smoothstep(0.7, 1.5, length(fwidth(p)));
              display *= 1.0 + granulationWeight * filterWeight * (2.0 * cells(p) - 1.0);
            }
            gl_FragColor = vec4(display * resolvedWeight, 1.0);
            #include <colorspace_fragment>
          }
        }
      `,
      toneMapped: false,
    });
  }

  update(camera: THREE.PerspectiveCamera, center: THREE.Vector3, radius: number, height: number): void {
    const distance = camera.position.distanceTo(center);
    const angularRadius = Math.asin(Math.min(1, radius / Math.max(radius, distance)));
    this.diameterPixels = 2 * Math.tan(angularRadius) * height /
      (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    if (!Number.isFinite(this.diameterPixels)) this.diameterPixels = height * 2;
    this.uniforms.solarCenter.value.copy(center);
    this.uniforms.sourceScale.value = Math.max(1, 2 / Math.max(this.diameterPixels, 1e-8));
    this.uniforms.resolvedWeight.value = resolvedSolarWeight(this.diameterPixels);
    this.uniforms.granulationWeight.value = 0.03 * THREE.MathUtils.smoothstep(this.diameterPixels, 512, 1400);
  }

  selectAtmosphere(camera: THREE.Camera, center: THREE.Vector3, atmospheres: Iterable<AtmosphereMesh>): void {
    let nearest: AtmosphereMesh | null = null;
    let nearestDistance = Infinity;
    for (const atm of atmospheres) {
      if (!atm.visible) continue;
      this.inverse.copy(atm.matrixWorld).invert();
      this.eye.copy(camera.position).applyMatrix4(this.inverse);
      this.direction.copy(center).applyMatrix4(this.inverse).sub(this.eye);
      const distance = this.direction.length();
      if (distance === 0) continue;
      this.direction.divideScalar(distance);
      const b = this.eye.dot(this.direction);
      const disc = b * b - this.eye.lengthSq() + 1;
      if (disc <= 0) continue;
      const entry = Math.max(0, -b - Math.sqrt(disc));
      const exit = -b + Math.sqrt(disc);
      // Fraction of the camera→source segment is comparable across shell scales.
      if (exit > 0 && entry < distance && entry / distance < nearestDistance) {
        nearest = atm;
        nearestDistance = entry / distance;
      }
    }
    this.setAtmosphere(nearest);
  }

  setAtmosphere(atmosphere: AtmosphereMesh | null): void {
    this.uniforms.hasAtmosphere.value = atmosphere !== null;
    if (!atmosphere) {
      this.atmosphere = null;
      return;
    }
    if (this.atmosphere !== atmosphere ||
        this.uniforms.uAtmTransmittanceLUT.value !== atmosphere.transmittanceLUT) {
      const values = makeAtmosphereProfileUniforms(atmosphere.model, atmosphere.shellRadius,
        atmosphere.planetRadius / atmosphere.shellRadius, 1, atmosphere.transmittanceLUT);
      for (const key of Object.keys(values) as Array<keyof typeof values>) {
        Object.assign(this.uniforms[key], values[key]);
      }
    }
    this.atmosphere = atmosphere;
    this.uniforms.worldToAtmosphere.value.copy(atmosphere.matrixWorld).invert();
  }
}

/** Smoothly transfer display energy into the optical point spread at 4–16 pixels. */
export function resolvedSolarWeight(diameterPixels: number): number {
  return THREE.MathUtils.smoothstep(diameterPixels, 4, 16);
}
