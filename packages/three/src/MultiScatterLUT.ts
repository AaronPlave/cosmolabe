import * as THREE from 'three';
import type { AtmosphereModel } from './AtmosphereModel.js';
import { ATMOSPHERE_PROFILES_GLSL, makeAtmosphereProfileUniforms } from './AtmosphereProfiles.js';

/**
 * Multi-scattering LUT (Hillaire 2020 "A Scalable and Production Ready Sky and
 * Atmosphere Rendering Technique"). A small 2D RGB texture indexed by
 * (cosSunZenith, altitudeNorm) that holds the direction-averaged ambient
 * scattering at each (sample altitude, sun-relative-to-local-up) pair.
 *
 * Used by AtmosphereMesh + AerialPerspective shaders to compute the
 * multi-scattering contribution that single-scatter ray-marches can't reach
 * — the physical reason a real noon sky looks bright everywhere instead of
 * just at the horizon.
 *
 * Computation: at each LUT pixel, place a sample at altitude h with sun at
 * angle θ from local up; cast 32 directions uniformly on the sphere; for
 * each direction integrate the single-scatter contribution from the sun
 * (incl. transmittance to the sun); average and divide by (1 - transfer)
 * to close the geometric series for all subsequent bounces.
 *
 * Built once per normalized atmosphere via a fullscreen render-to-texture
 * pass — no per-frame cost.
 */

const LUT_W = 32;
const LUT_H = 32;
const LUT_DIRS = 32;       // direction samples per LUT pixel
const LUT_STEPS = 20;      // ray-march steps per direction

/** Build the multi-scattering LUT for a given atmosphere. Returns the texture. */
export function buildMultiScatterLUT(
  renderer: THREE.WebGLRenderer,
  model: AtmosphereModel,
  planetRadius: number,
  shellRadius: number,
  transmittanceLUT: THREE.Texture,
): THREE.Texture {
  const rt = new THREE.WebGLRenderTarget(LUT_W, LUT_H, {
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });

  const R = shellRadius;
  const planetR = planetRadius / R;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...makeAtmosphereProfileUniforms(model, R, planetR, 1, transmittanceLUT),
      uAtmGroundAlbedo: { value: new THREE.Vector3(...model.groundAlbedo) },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vUv;

      ${ATMOSPHERE_PROFILES_GLSL}
      uniform vec3 uAtmGroundAlbedo;

      const int N_DIRS  = ${LUT_DIRS};
      const int N_STEPS = ${LUT_STEPS};
      const float PI = 3.14159265358979;
      const float ISOTROPIC_PHASE = 1.0 / (4.0 * 3.14159265358979);

      // Ray-sphere intersection: returns t at exit (assumes inside sphere).
      // Returns -1 if ray misses sphere or exit is behind origin.
      float raySphereExit(vec3 ro, vec3 rd, float radius) {
        float b = dot(ro, rd);
        float c = dot(ro, ro) - radius * radius;
        float disc = b * b - c;
        if (disc < 0.0) return -1.0;
        return -b + sqrt(disc);
      }

      // Generate a uniform-on-sphere direction from an integer index in [0..N_DIRS).
      // Uses a sunflower (Fibonacci) spiral — even coverage with no clustering.
      vec3 sphereDir(int i) {
        float t = (float(i) + 0.5) / float(N_DIRS);
        float phi = t * 2.0 * PI * 1.61803398875;  // golden angle * count for spread
        float cosTheta = 1.0 - 2.0 * t;
        float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
        return vec3(sinTheta * cos(phi), cosTheta, sinTheta * sin(phi));
      }

      void main() {
        // LUT u: cos sun zenith mapped from [-1, 1]
        // LUT v: altitude norm in [0, 1] across the shell
        float mu_s = vUv.x * 2.0 - 1.0;
        float h    = vUv.y * (1.0 - uAtmPlanetR);

        // Sample point at altitude h on the local "up" axis; sun at angle θ.
        vec3 p = vec3(0.0, uAtmPlanetR + h, 0.0);
        vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - mu_s * mu_s)), mu_s, 0.0);

        vec3 totalLuminance       = vec3(0.0);
        vec3 totalMultiScatTransfer = vec3(0.0);

        // Loop over uniformly-distributed view directions; for each, integrate
        // single-scatter contribution from the sun along the view ray.
        for (int d = 0; d < N_DIRS; d++) {
          vec3 dir = sphereDir(d);

          // Distance along this direction inside the atmosphere shell.
          float tShell = raySphereExit(p, dir, uAtmShellR);
          if (tShell <= 0.0) continue;

          // If the ray hits the planet first, integrate only to the planet hit.
          float tPlanet = -1.0;
          {
            float b = dot(p, dir);
            float c = dot(p, p) - uAtmPlanetR * uAtmPlanetR;
            float disc = b * b - c;
            if (disc > 0.0) {
              float t = -b - sqrt(disc);
              if (t > 0.0) tPlanet = t;
            }
          }
          float tMax = (tPlanet > 0.0) ? tPlanet : tShell;

          float stepLen = tMax / float(N_STEPS);
          vec3 viewT = vec3(1.0);
          vec3 dirLuminance        = vec3(0.0);
          vec3 dirMultiScatTransfer = vec3(0.0);

          for (int j = 0; j < N_STEPS; j++) {
            vec3 sP = p + dir * (stepLen * (float(j) + 0.5));
            float r = length(sP);
            if (r < uAtmPlanetR) break;            // safety
            vec3 density = atmDensities(r - uAtmPlanetR);
            vec3 extinction = atmExtinction(density);
            vec3 weight = atmSegmentWeight(extinction, stepLen);
            vec3 segOD = extinction * stepLen;
            vec3 segT  = exp(-segOD);
            // Transmittance from sample to sun (sample's own local up frame).
            vec3 T_sun = atmSunTransmittance(sP, sunDir);
            // Isotropic-phase scattering (good MS approximation for both Ray + Mie).
            vec3 scattering = atmScatteringSum(density);
            // Direct contribution to luminance toward the eye (this LUT pixel).
            dirLuminance        += viewT * T_sun * scattering * weight * ISOTROPIC_PHASE;
            // Transfer factor — how much would feed into the next bounce.
            dirMultiScatTransfer += viewT * scattering * weight * ISOTROPIC_PHASE;
            viewT *= segT;
          }

          if (tPlanet > 0.0) {
            vec3 groundPos = p + dir * tPlanet;
            vec3 groundUp = normalize(groundPos);
            float sunlight = max(0.0, dot(groundUp, sunDir));
            dirLuminance += viewT * atmSunTransmittance(groundPos, sunDir) *
              uAtmGroundAlbedo * sunlight / PI;
          }

          totalLuminance       += dirLuminance;
          totalMultiScatTransfer += dirMultiScatTransfer;
        }

        // Average over directions.
        // ψ is direction-averaged radiance; the transfer is a sphere integral.
        totalLuminance       /= float(N_DIRS);
        totalMultiScatTransfer *= (4.0 * PI) / float(N_DIRS);

        // Closed-form geometric sum for all subsequent bounces.
        // ψ = L₂ / (1 − F_ms)  — Hillaire 2020 §6.3
        vec3 psi = totalLuminance / max(vec3(1e-4), vec3(1.0) - totalMultiScatTransfer);

        gl_FragColor = vec4(psi, 1.0);
      }
    `,
  });

  const quad = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(quad, material);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const scene = new THREE.Scene();
  scene.add(mesh);

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = true;
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;

  quad.dispose();
  material.dispose();

  return rt.texture;
}
