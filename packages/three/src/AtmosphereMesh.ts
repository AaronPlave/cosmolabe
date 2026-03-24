import * as THREE from 'three';

/**
 * Atmosphere scattering parameters for a body.
 * Rayleigh + Mie atmospheric scattering parameters — all coefficients in 1/km.
 */
export interface AtmosphereParams {
  /** Mie scattering coefficient (1/km). Controls haze/dust density. */
  mieCoeff: number;
  /** Mie scale height in km. Controls how quickly haze falls off with altitude. */
  mieScaleHeight: number;
  /** Henyey-Greenstein asymmetry parameter g (-1 to 1). Negative = backscatter. */
  miePhaseAsymmetry: number;
  /** RGB Rayleigh scattering coefficients (1/km). Controls color — blue for Earth. */
  rayleighCoeff: [number, number, number];
  /** RGB absorption coefficients (1/km). Ozone absorbs red/green. */
  absorptionCoeff: [number, number, number];
}

/** Built-in atmosphere presets for solar system bodies */
const ATMOSPHERE_PRESETS: Record<string, AtmosphereParams> = {
  Earth: {
    mieCoeff: 0.0002,
    mieScaleHeight: 8.5,
    miePhaseAsymmetry: -0.7,
    rayleighCoeff: [0.0054, 0.0081, 0.0167],
    absorptionCoeff: [0.0027, 0.0017, 0.0002],
  },
  Mars: {
    mieCoeff: 0.0006,
    mieScaleHeight: 11.0,
    miePhaseAsymmetry: -0.5,
    rayleighCoeff: [0.0020, 0.0012, 0.0006],
    absorptionCoeff: [0.0010, 0.0008, 0.0002],
  },
  Titan: {
    mieCoeff: 0.0040,
    mieScaleHeight: 50.0,
    miePhaseAsymmetry: -0.4,
    // Titan's thick tholin haze: warm orange, almost no blue Rayleigh
    rayleighCoeff: [0.0035, 0.0015, 0.0004],
    // Heavy blue absorption from methane/tholins
    absorptionCoeff: [0.0005, 0.0015, 0.0050],
  },
  Venus: {
    mieCoeff: 0.0050,
    mieScaleHeight: 15.0,
    miePhaseAsymmetry: -0.6,
    rayleighCoeff: [0.0080, 0.0060, 0.0030],
    absorptionCoeff: [0.0040, 0.0030, 0.0010],
  },
  Jupiter: {
    mieCoeff: 0.0030,
    mieScaleHeight: 27.0,
    miePhaseAsymmetry: -0.6,
    rayleighCoeff: [0.0040, 0.0030, 0.0015],
    absorptionCoeff: [0.0010, 0.0008, 0.0003],
  },
  Saturn: {
    mieCoeff: 0.0025,
    mieScaleHeight: 60.0,
    miePhaseAsymmetry: -0.5,
    rayleighCoeff: [0.0035, 0.0028, 0.0015],
    absorptionCoeff: [0.0008, 0.0006, 0.0002],
  },
  Uranus: {
    mieCoeff: 0.0015,
    mieScaleHeight: 27.0,
    miePhaseAsymmetry: -0.6,
    // Methane absorption gives cyan/blue color
    rayleighCoeff: [0.0010, 0.0030, 0.0060],
    absorptionCoeff: [0.0030, 0.0010, 0.0002],
  },
  Neptune: {
    mieCoeff: 0.0015,
    mieScaleHeight: 20.0,
    miePhaseAsymmetry: -0.6,
    // Deep blue from methane absorption
    rayleighCoeff: [0.0008, 0.0025, 0.0070],
    absorptionCoeff: [0.0040, 0.0012, 0.0002],
  },
  Pluto: {
    mieCoeff: 0.0001,
    mieScaleHeight: 50.0,
    miePhaseAsymmetry: -0.7,
    rayleighCoeff: [0.0003, 0.0004, 0.0006],
    absorptionCoeff: [0.0001, 0.0001, 0.0001],
  },
  Triton: {
    mieCoeff: 0.0001,
    mieScaleHeight: 8.0,
    miePhaseAsymmetry: -0.7,
    rayleighCoeff: [0.0002, 0.0003, 0.0005],
    absorptionCoeff: [0.0001, 0.0001, 0.0001],
  },
};

// ln(0.0005) ≈ -7.60 — atmosphere extends to where density = 0.05% of surface.
// Wider than the typical 5% threshold for a more visible limb glow from orbital distance.
const LOG_EXTINCTION_THRESHOLD = Math.log(0.0005);

// ---- GLSL Shaders ----
// Single-scattering Rayleigh + Mie ray-march.
// Rendered on an OVERSIZED proxy sphere (radius 1.15). The shader analytically
// intersects the atmosphere sphere (radius 1.0), discarding fragments outside.
// This gives a perfectly smooth circular boundary — no polygon jaggedness.

const atmosphereVertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vObjPos;    // object-space position (interpolated per-fragment)

void main() {
  vObjPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const atmosphereFragmentShader = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>

uniform float planetR;            // planetRadius / shellRadius (normalized)
uniform float mieCoeff;
uniform float invScaleH;          // shellRadius / mieScaleHeight
uniform float mieK;               // Schlick phase parameter
uniform vec3 rayleighCoeff;       // scaled by shellRadius
uniform vec3 extinctionCoeff;     // scattering + absorption, scaled
uniform vec3 scatterCoeffSum;     // rayleigh + mie, scaled

uniform mat4 invModelMat;         // inverse model matrix (set per-frame)
uniform vec3 lightDir;            // toward sun in object space (normalized)
uniform vec3 lightColor;

// Eclipse shadow uniforms (world space)
uniform vec3  uSunWorldPos;
uniform float uSunRadius;
uniform vec3  uShadowOccluderPos[4];
uniform float uShadowOccluderRadius[4];
uniform float uShadowOccluderCount;
uniform vec3  uPlanetWorldPos;    // planet center in scene world space
uniform float uShellSceneScale;   // shellRadius * scaleFactor (object unit → world unit)

float computeAtmEclipseShadow(vec3 samplePos) {
  // samplePos is in normalized object space (shell radius = 1.0).
  // Reconstruct approximate world position (spherical, ignores body rotation/oblateness,
  // which is negligible at eclipse shadow scale).
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

varying vec3 vObjPos;

#define NUM_SAMPLES 32

// Per-fragment pseudo-random jitter — converts coherent banding into noise
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  #include <logdepthbuf_fragment>

  // eyePos computed per-fragment from uniforms only — perfectly constant,
  // no varying interpolation artifacts. cameraPosition is Three.js built-in
  // updated right before render (no frame-delay jitter).
  vec3 eyePos = (invModelMat * vec4(cameraPosition, 1.0)).xyz;
  // Re-project interpolated position onto the proxy sphere surface.
  // Linear interpolation across triangles produces points slightly inside
  // the sphere (on the chord, not the arc), creating direction discontinuities
  // at triangle edges. Normalizing removes these.
  vec3 surfacePos = normalize(vObjPos) * 1.15;
  vec3 viewDir = normalize(surfacePos - eyePos);

  // Analytical ray-sphere intersection with atmosphere shell (radius 1.0)
  // Ray: P(t) = eyePos + t * viewDir
  float bHalf = dot(eyePos, viewDir);
  float c = dot(eyePos, eyePos) - 1.0;
  float discAtm = bHalf * bHalf - c;

  // Ray misses atmosphere — fully transparent (blend-mode transparent)
  if (discAtm < 0.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float sqrtDiscAtm = sqrt(discAtm);
  float tEnter = -bHalf - sqrtDiscAtm;
  float tExit  = -bHalf + sqrtDiscAtm;
  tEnter = max(tEnter, 0.0);  // clamp for camera inside atmosphere

  // Planet intersection — cap ray at planet surface.
  float planetR2 = planetR * planetR;
  float cPlanet = dot(eyePos, eyePos) - planetR2;
  float discPlanet = bHalf * bHalf - cPlanet;

  float tEnd = tExit;
  if (discPlanet > 0.0) {
    float tPlanet = -bHalf - sqrt(discPlanet);
    float blend = smoothstep(0.0, 0.002, discPlanet);
    float tCapped = mix(tExit, tPlanet, blend);
    tEnd = (tCapped > tEnter) ? tCapped : tExit;
  }

  float pathLen = tEnd - tEnter;
  if (pathLen <= 0.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float stepLen = pathLen / float(NUM_SAMPLES);

  // March along the ray, accumulating scattering
  vec3 totalInscatter = vec3(0.0);
  float totalOptDepth = 0.0;

  for (int i = 0; i < NUM_SAMPLES; i++) {
    float t = tEnter + (float(i) + 0.5) * stepLen;
    vec3 samplePos = eyePos + t * viewDir;
    float altitude = max(0.0, length(samplePos) - planetR);
    float localDensity = exp(-altitude * invScaleH);

    // Accumulate optical depth along view ray
    float segOD = localDensity * stepLen;
    totalOptDepth += segOD;

    // Hemispheric shadow — smooth cosine fade for the night side terminator.
    float cosLit = dot(normalize(samplePos), lightDir);
    float hemiFade = smoothstep(-0.2, 0.2, cosLit);
    // Eclipse shadow — dims the atmosphere when an occluder blocks the sun.
    float shadow = min(hemiFade, computeAtmEclipseShadow(samplePos));

    // Sun-path optical depth from this sample to atmosphere exit
    float sRq = dot(samplePos, lightDir);
    float sQq = dot(samplePos, samplePos) - 1.0;
    float sD = sqrt(max(sRq * sRq - sQq, 0.0));
    float sunDist = max(0.0, -sRq + sD);
    float sunOD = localDensity * sunDist;

    vec3 T_view = exp(-extinctionCoeff * totalOptDepth);
    vec3 T_sun = exp(-extinctionCoeff * sunOD * 0.5);

    totalInscatter += T_view * T_sun * shadow * localDensity * stepLen;
  }

  // Phase functions
  float cosTheta = dot(-viewDir, lightDir);
  float phMie = (1.0 - mieK * mieK)
              / ((1.0 - mieK * cosTheta) * (1.0 - mieK * cosTheta));
  float phRayleigh = 0.75 * (1.0 + cosTheta * cosTheta);

  vec3 color = lightColor * totalInscatter
             * (phRayleigh * rayleighCoeff + phMie * mieCoeff);

  vec3 viewEx = exp(-extinctionCoeff * totalOptDepth);
  float alpha = dot(viewEx, vec3(0.333));
  // Floor alpha at 0.4 so the atmosphere never dims the body surface to black.
  // This prevents the dark ring on thick atmospheres (Titan) while preserving
  // the limb glow effect for thin atmospheres (Earth).
  alpha = max(alpha, 0.4);

  // Limb-targeted brightness boost
  float thickness = 1.0 - alpha;
  color *= 1.0 + 2.0 * thickness * thickness;

  // Where there's no inscattered color, don't dim the background.
  float colorIntensity = dot(color, vec3(1.0));
  alpha = mix(1.0, alpha, smoothstep(0.0, 0.01, colorIntensity));

  // Smooth outer atmosphere boundary
  float edgeFade = smoothstep(0.0, 0.001, discAtm);
  color *= edgeFade;
  alpha = mix(1.0, alpha, edgeFade);

  gl_FragColor = vec4(color, alpha);
}
`;

/**
 * Atmosphere shell mesh. Renders a front-face sphere slightly larger than
 * the body, ray-marching Rayleigh + Mie scattering inward from each fragment.
 *
 * Must be positioned at the body center and scaled with the body.
 * Call `update()` each frame with camera and sun positions.
 */
export class AtmosphereMesh extends THREE.Mesh {
  /** Planet radius in km */
  readonly planetRadius: number;
  /** Atmosphere shell radius in km */
  readonly shellRadius: number;

  private readonly _invModelMatrix = new THREE.Matrix4();
  private readonly _lightLocal = new THREE.Vector3();

  constructor(planetRadius: number, params: AtmosphereParams) {
    const shellRadius = planetRadius + -params.mieScaleHeight * LOG_EXTINCTION_THRESHOLD;

    const geometry = new THREE.SphereGeometry(1.15, 128, 64);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        planetR: { value: 0 },
        mieCoeff: { value: 0 },
        invScaleH: { value: 0 },
        mieK: { value: 0 },
        rayleighCoeff: { value: new THREE.Vector3() },
        scatterCoeffSum: { value: new THREE.Vector3() },
        extinctionCoeff: { value: new THREE.Vector3() },
        invModelMat: { value: new THREE.Matrix4() },
        lightDir: { value: new THREE.Vector3(1, 0, 0) },
        lightColor: { value: new THREE.Vector3(1, 1, 1) },
        uSunWorldPos:          { value: new THREE.Vector3() },
        uSunRadius:            { value: 0 },
        uShadowOccluderPos:    { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
        uShadowOccluderRadius: { value: new Float32Array(4) },
        uShadowOccluderCount:  { value: 0.0 },
        uPlanetWorldPos:       { value: new THREE.Vector3() },
        uShellSceneScale:      { value: 1.0 },
      },
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Custom blend: finalColor = src * 1 + dst * srcAlpha
      // Inscattered light additive, background dimmed by transmittance
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.SrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      side: THREE.BackSide,
    });

    super(geometry, material);
    this.planetRadius = planetRadius;
    this.shellRadius = shellRadius;
    this.frustumCulled = false;
    // Render after trajectory lines so the atmosphere blends over them
    // (prevents orbit arcs from appearing as dark lines through the glow)
    this.renderOrder = 1000;

    this.setAtmosphereUniforms(params, planetRadius, shellRadius);
  }

  /**
   * Update per-frame uniforms: camera position, light direction, and optional eclipse shadow.
   * Positions in scene world space.
   */
  update(
    _cameraWorldPos: THREE.Vector3,
    sunWorldPos: THREE.Vector3,
    occluders?: { pos: THREE.Vector3; radius: number }[],
    planetWorldPos?: THREE.Vector3,
    sunRadius?: number,
    shellSceneScale?: number,
  ): void {
    const u = (this.material as THREE.ShaderMaterial).uniforms;

    this._invModelMatrix.copy(this.matrixWorld).invert();
    u.invModelMat.value.copy(this._invModelMatrix);

    this._lightLocal.copy(sunWorldPos).applyMatrix4(this._invModelMatrix).normalize();
    u.lightDir.value.copy(this._lightLocal);

    if (occluders && planetWorldPos != null && shellSceneScale != null) {
      u.uSunWorldPos.value.copy(sunWorldPos);
      u.uSunRadius.value = sunRadius ?? 0;
      u.uPlanetWorldPos.value.copy(planetWorldPos);
      u.uShellSceneScale.value = shellSceneScale;
      const count = Math.min(occluders.length, 4);
      u.uShadowOccluderCount.value = count;
      for (let i = 0; i < count; i++) {
        u.uShadowOccluderPos.value[i].copy(occluders[i].pos);
        u.uShadowOccluderRadius.value[i] = occluders[i].radius;
      }
    } else {
      u.uShadowOccluderCount.value = 0;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    (this.material as THREE.Material).dispose();
  }

  private setAtmosphereUniforms(
    atm: AtmosphereParams,
    planetRadius: number,
    shellRadius: number,
  ): void {
    const u = (this.material as THREE.ShaderMaterial).uniforms;
    const R = shellRadius;

    // All coefficients scaled by shellRadius so shader math works in normalized space
    const tMie = atm.mieCoeff * R;
    const tRay: [number, number, number] = [
      atm.rayleighCoeff[0] * R,
      atm.rayleighCoeff[1] * R,
      atm.rayleighCoeff[2] * R,
    ];
    const tAbs: [number, number, number] = [
      atm.absorptionCoeff[0] * R,
      atm.absorptionCoeff[1] * R,
      atm.absorptionCoeff[2] * R,
    ];

    u.planetR.value = planetRadius / R;
    u.mieCoeff.value = tMie;
    u.invScaleH.value = R / atm.mieScaleHeight;

    // Schlick approximation: k = 1.55g - 0.55g³
    const g = atm.miePhaseAsymmetry;
    u.mieK.value = 1.55 * g - 0.55 * g * g * g;

    u.rayleighCoeff.value.set(tRay[0], tRay[1], tRay[2]);

    const scatterSum: [number, number, number] = [
      tRay[0] + tMie,
      tRay[1] + tMie,
      tRay[2] + tMie,
    ];
    u.scatterCoeffSum.value.set(scatterSum[0], scatterSum[1], scatterSum[2]);
    u.extinctionCoeff.value.set(
      scatterSum[0] + tAbs[0],
      scatterSum[1] + tAbs[1],
      scatterSum[2] + tAbs[2],
    );
  }
}

/**
 * Resolve atmosphere parameters from a catalog field value.
 * Supports:
 *   - Preset name string: "Earth", "Mars", "Titan", "Venus"
 *   - Cosmographia .atmscat file reference (maps to preset by body name,
 *     or parsed from binary if atmscatResolver is provided)
 *   - Inline object with AtmosphereParams fields
 *   - Boolean true: use preset for the body name
 *
 * Cosmographia .atmscat binary files are NOT directly compatible with our ray-march
 * shader — they contain coefficients scaled for precomputed lookup tables. Instead,
 * .atmscat references are resolved to built-in presets by body name. For custom
 * atmospheres, use inline parameters in the catalog.
 */
export function resolveAtmosphereParams(
  value: unknown,
  bodyName?: string,
): AtmosphereParams | null {
  if (!value) return null;

  // Boolean true: use preset if available, otherwise generic Earth-like atmosphere
  if (value === true) {
    if (bodyName && ATMOSPHERE_PRESETS[bodyName]) return ATMOSPHERE_PRESETS[bodyName];
    return ATMOSPHERE_PRESETS.Earth;
  }

  // String: preset name or .atmscat file reference
  if (typeof value === 'string') {
    // Try direct preset match
    if (ATMOSPHERE_PRESETS[value]) return ATMOSPHERE_PRESETS[value];

    // Try extracting body name from .atmscat path (e.g. "earth.atmscat" → "Earth")
    const baseName = value.replace(/\.atmscat$/i, '');
    const capitalized = baseName.charAt(0).toUpperCase() + baseName.slice(1).toLowerCase();
    if (ATMOSPHERE_PRESETS[capitalized]) return ATMOSPHERE_PRESETS[capitalized];

    // Try body name
    if (bodyName && ATMOSPHERE_PRESETS[bodyName]) return ATMOSPHERE_PRESETS[bodyName];

    console.warn(`[SpiceCraft] No atmosphere preset for "${value}" (body: ${bodyName ?? 'unknown'}). Use inline params: { mieCoeff, mieScaleHeight, rayleighCoeff, ... }`);
    return null;
  }

  // Object: inline parameters
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (
      typeof obj.mieCoeff === 'number' &&
      typeof obj.mieScaleHeight === 'number' &&
      Array.isArray(obj.rayleighCoeff)
    ) {
      return {
        mieCoeff: obj.mieCoeff,
        mieScaleHeight: obj.mieScaleHeight,
        miePhaseAsymmetry: (obj.miePhaseAsymmetry as number) ?? -0.7,
        rayleighCoeff: obj.rayleighCoeff as [number, number, number],
        absorptionCoeff: (obj.absorptionCoeff as [number, number, number]) ?? [0, 0, 0],
      };
    }
  }

  return null;
}


/** Get a built-in atmosphere preset by body name. */
export function getAtmospherePreset(name: string): AtmosphereParams | null {
  return ATMOSPHERE_PRESETS[name] ?? null;
}
