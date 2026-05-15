import * as THREE from 'three';
import type { AtmosphereParams } from './AtmosphereMesh.js';

/**
 * Sky-view LUT (Hillaire 2020 §6.4). Renders the atmospheric ray-march once
 * per frame at low resolution (192×108) into a 2D texture parameterized by
 * view direction in spherical coordinates (azimuth φ, elevation θ). The
 * atmosphere shell shader then becomes a single texture lookup per fragment
 * instead of a per-pixel ray-march — the proxy sphere covers most of the
 * screen at low altitude, so this is the primary cost saving for surface views.
 *
 * The LUT depends on (camera-position-in-atmosphere-frame, sun-direction,
 * eclipse-occluders), so it's rebuilt every frame. Cost: 20k pixels × 8
 * samples = ~160k ray-march iterations per frame, tiny vs. the millions of
 * fragments the proxy sphere covers.
 *
 * Uses the same multi-scattering LUT as AtmosphereMesh, so the colors stay
 * consistent between this fast-path and the AP fragment shader (which still
 * ray-marches because its camera→fragment paths can't be precomputed).
 */

const LUT_W = 192;
const LUT_H = 108;
const LUT_SAMPLES = 8;

export class SkyViewLUT {
  private rt: THREE.WebGLRenderTarget;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private material: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private disposed = false;

  /** Multi-scattering LUT shared with AtmosphereMesh. */
  constructor(
    params: AtmosphereParams,
    planetRadius: number,
    shellRadius: number,
    multiScatterLUT: THREE.Texture | null,
  ) {
    this.rt = new THREE.WebGLRenderTarget(LUT_W, LUT_H, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.RepeatWrapping,         // azimuth wraps
      depthBuffer: false,
      stencilBuffer: false,
    });

    // Pre-scale all coefficients to normalized space so the shader math
    // matches AtmosphereMesh.setAtmosphereUniforms exactly.
    const R = shellRadius;
    const planetR = planetRadius / R;
    const mieRGB: [number, number, number] = typeof params.mieCoeff === 'number'
      ? [params.mieCoeff, params.mieCoeff, params.mieCoeff]
      : params.mieCoeff;
    const tMie: [number, number, number] = [
      mieRGB[0] * R,
      mieRGB[1] * R,
      mieRGB[2] * R,
    ];
    const tRay: [number, number, number] = [
      params.rayleighCoeff[0] * R,
      params.rayleighCoeff[1] * R,
      params.rayleighCoeff[2] * R,
    ];
    const tAbs: [number, number, number] = [
      params.absorptionCoeff[0] * R,
      params.absorptionCoeff[1] * R,
      params.absorptionCoeff[2] * R,
    ];
    const ext: [number, number, number] = [
      tRay[0] + tMie[0] + tAbs[0],
      tRay[1] + tMie[1] + tAbs[1],
      tRay[2] + tMie[2] + tAbs[2],
    ];
    const g = params.miePhaseAsymmetry;
    const mieK = 1.55 * g - 0.55 * g * g * g;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        planetR:        { value: planetR },
        planetCapBias:  { value: params.planetCapBias ?? 0 },
        invScaleH:      { value: R / params.mieScaleHeight },
        rayleighCoeff:  { value: new THREE.Vector3(tRay[0], tRay[1], tRay[2]) },
        mieCoeff:       { value: new THREE.Vector3(tMie[0], tMie[1], tMie[2]) },
        extinctionCoeff:{ value: new THREE.Vector3(ext[0], ext[1], ext[2]) },
        mieK:           { value: mieK },
        eyePos:         { value: new THREE.Vector3() },         // camera in atm object space
        lightDir:       { value: new THREE.Vector3() },         // sun dir in atm object space
        lightColor:     { value: new THREE.Vector3(1, 1, 1) },
        uMultiScatterLUT: { value: multiScatterLUT },
        // Eclipse shadow uniforms (passed through to keep parity with the
        // AtmosphereMesh shader; copied per-frame from atm material).
        uSunWorldPos:          { value: new THREE.Vector3() },
        uSunRadius:            { value: 0 },
        uShadowOccluderPos:    { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
        uShadowOccluderRadius: { value: new Float32Array(4) },
        uShadowOccluderCount:  { value: 0.0 },
        uPlanetWorldPos:       { value: new THREE.Vector3() },
        uShellSceneScale:      { value: 1.0 },
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

        uniform float planetR;
        uniform float planetCapBias;
        uniform float invScaleH;
        uniform vec3  rayleighCoeff;
        uniform vec3  mieCoeff;
        uniform vec3  extinctionCoeff;
        uniform float mieK;

        uniform vec3 eyePos;
        uniform vec3 lightDir;
        uniform vec3 lightColor;

        uniform sampler2D uMultiScatterLUT;

        uniform vec3  uSunWorldPos;
        uniform float uSunRadius;
        uniform vec3  uShadowOccluderPos[4];
        uniform float uShadowOccluderRadius[4];
        uniform float uShadowOccluderCount;
        uniform vec3  uPlanetWorldPos;
        uniform float uShellSceneScale;

        const float PI = 3.14159265358979;

        // Same shape as the AtmosphereMesh eclipse shadow.
        float computeAtmEclipseShadow(vec3 samplePos) {
          vec3 worldPos = uPlanetWorldPos + samplePos * uShellSceneScale;
          vec3 toSun = uSunWorldPos - worldPos;
          float distToSun = length(toSun);
          if (distToSun < 1e-20) return 1.0;
          vec3 rayDir = toSun / distToSun;
          float shadowFactor = 1.0;
          for (int i = 0; i < 4; i++) {
            if (float(i) >= uShadowOccluderCount) break;
            vec3 toOcc = uShadowOccluderPos[i] - worldPos;
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

        void main() {
          // UV → view direction. U is azimuth in [0, 2π), V is elevation in
          // [-π/2, π/2]. The camera's local up axis is +Y in atm object space
          // (matches Globe pre-rotation in BodyMesh).
          float az  = vUv.x * 2.0 * PI;
          float el  = (vUv.y - 0.5) * PI;
          vec3 viewDir = vec3(cos(el) * sin(az), sin(el), cos(el) * cos(az));

          // Atmosphere shell entry/exit (camera is inside the shell when used
          // for ground views; this still works from outside as an early-out).
          float bHalf = dot(eyePos, viewDir);
          float c = dot(eyePos, eyePos) - 1.0;
          float discAtm = bHalf * bHalf - c;
          if (discAtm < 0.0) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
          }
          float sqrtDiscAtm = sqrt(discAtm);
          float tEnter = max(-bHalf - sqrtDiscAtm, 0.0);
          float tExit  = -bHalf + sqrtDiscAtm;

          // Cap at planet hit so samples don't traverse the planet's interior.
          float effectivePlanetR = max(0.0, planetR - planetCapBias);
          float cPlanet = dot(eyePos, eyePos) - effectivePlanetR * effectivePlanetR;
          float discPlanet = bHalf * bHalf - cPlanet;
          float tEnd = tExit;
          if (discPlanet > 0.0) {
            float tPlanet = -bHalf - sqrt(discPlanet);
            if (tPlanet > tEnter) tEnd = tPlanet;
          }
          float pathLen = tEnd - tEnter;
          if (pathLen <= 0.0) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
          }

          float stepLen = pathLen / float(${LUT_SAMPLES});

          float cosTheta = dot(-viewDir, lightDir);
          float phMie = (1.0 - mieK * mieK)
                      / ((1.0 - mieK * cosTheta) * (1.0 - mieK * cosTheta));
          float phRayleigh = 0.75 * (1.0 + cosTheta * cosTheta);
          vec3  scatteringPhase    = phRayleigh * rayleighCoeff + phMie * mieCoeff;
          vec3  scatteringSumCoeff = rayleighCoeff + mieCoeff;

          vec3  totalInscatter = vec3(0.0);
          float totalOptDepth  = 0.0;

          for (int i = 0; i < ${LUT_SAMPLES}; i++) {
            float t = tEnter + (float(i) + 0.5) * stepLen;
            vec3 samplePos = eyePos + t * viewDir;
            float r = length(samplePos);
            float altitude = max(0.0, r - planetR);
            float density  = exp(-altitude * invScaleH);
            float segOD = density * stepLen;
            totalOptDepth += segOD;

            vec3 upLocal = (r > 1e-6) ? samplePos / r : vec3(0.0, 1.0, 0.0);
            float cosLit = dot(upLocal, lightDir);
            float hemiFade = smoothstep(-0.35, 0.15, cosLit);
            float shadow = min(hemiFade, computeAtmEclipseShadow(samplePos));

            float sRq = dot(samplePos, lightDir);
            float sQq = dot(samplePos, samplePos) - 1.0;
            float sD2 = sRq * sRq - sQq;
            float sunDist = (sD2 > 0.0) ? max(0.0, -sRq + sqrt(sD2)) : 0.0;
            vec3 T_view = exp(-extinctionCoeff * totalOptDepth);
            vec3 T_sun  = exp(-extinctionCoeff * density * sunDist * 0.5);

            vec3 ssContrib = T_view * T_sun * shadow * density * stepLen * scatteringPhase;
            vec2 lutUV = vec2(cosLit * 0.5 + 0.5, altitude / max(1e-6, 1.0 - planetR));
            vec3 psi   = texture2D(uMultiScatterLUT, lutUV).rgb;
            vec3 msContrib = T_view * psi * scatteringSumCoeff * density * stepLen * shadow;

            totalInscatter += ssContrib + msContrib;
          }

          vec3 color = lightColor * totalInscatter;
          vec3 viewEx = exp(-extinctionCoeff * totalOptDepth);
          float alpha = dot(viewEx, vec3(0.3333));

          // Reinhard tone mapping. The integrated single + multi-scatter values
          // can exceed 1.0 in linear radiance units (especially at the bright
          // limb from orbit), and the atmosphere material composites with
          // CustomBlending so we can't rely on the renderer's tone mapping
          // pass — values > 1 clip to white. Reinhard compresses HDR to [0,1]
          // smoothly without introducing magic-number coefficients.
          color = color / (1.0 + color);

          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.scene.add(this.quad);
  }

  /**
   * Re-render the LUT for the current camera/sun configuration. Inputs are in
   * AtmosphereMesh object space (camera position pre-transformed by invModelMat,
   * sun direction normalized in the same frame).
   */
  update(
    renderer: THREE.WebGLRenderer,
    cameraObjPos: THREE.Vector3,
    sunDirObj: THREE.Vector3,
    lightColor: THREE.Vector3,
    sunWorldPos: THREE.Vector3,
    sunRadius: number,
    planetWorldPos: THREE.Vector3,
    shellSceneScale: number,
    occluders?: { pos: THREE.Vector3; radius: number }[],
  ): void {
    if (this.disposed) return;
    const u = this.material.uniforms;
    u.eyePos.value.copy(cameraObjPos);
    u.lightDir.value.copy(sunDirObj);
    u.lightColor.value.copy(lightColor);
    u.uSunWorldPos.value.copy(sunWorldPos);
    u.uSunRadius.value = sunRadius;
    u.uPlanetWorldPos.value.copy(planetWorldPos);
    u.uShellSceneScale.value = shellSceneScale;
    if (occluders && occluders.length > 0) {
      const count = Math.min(occluders.length, 4);
      u.uShadowOccluderCount.value = count;
      for (let i = 0; i < count; i++) {
        u.uShadowOccluderPos.value[i].copy(occluders[i].pos);
        u.uShadowOccluderRadius.value[i] = occluders[i].radius;
      }
    } else {
      u.uShadowOccluderCount.value = 0;
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  get texture(): THREE.Texture { return this.rt.texture; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rt.dispose();
    this.quad.geometry.dispose();
    this.material.dispose();
  }
}
