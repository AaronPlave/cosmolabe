import * as THREE from 'three';

/**
 * Physical Sun illumination for streamed planetary surfaces (#204).
 *
 * Three contracts live here, all pure so they can be tested without a GPU:
 *
 * 1. **Imagery illumination provenance.** Whether a surface image is safe to
 *    relight with the simulated Sun.
 * 2. **Lighting modes.** One definition of `natural` / `shadow` / `flood`,
 *    shared by every scene that draws a surface.
 * 3. **Receiver-relative Sun geometry.** The Sun direction *at the surface
 *    being lit*, not at the scene origin, and the Sun's elevation/azimuth
 *    there, for diagnostics and screenshots.
 *
 * Out of scope here: terrain-cast shadows / horizon occlusion (#205),
 * observer-visible Sun disk occlusion (#242) and regolith photometry.
 * `directTerm` stays a separate quantity so #205 can attenuate it without
 * darkening the composited image.
 */

/**
 * What an image's pixel values mean, as far as relighting is concerned.
 *
 * - `reflectance`: approximately photometrically normalized albedo/reflectance.
 *   The simulated Sun may light it: `shade = albedo × sun × cos(incidence)`.
 * - `baked`: illumination (shading, shadows) is already in the pixels. It is
 *   displayed as-is; adding the Sun would double-darken it and misrepresent
 *   the source albedo.
 * - `unknown`: no provenance declared. This is the **legacy** path: the image
 *   is relit exactly as it was before the contract existed, and is labeled as
 *   not asserted to be physically relightable.
 */
export type ImageryIllumination = 'reflectance' | 'baked' | 'unknown';

/** Fallback while a catalog declares nothing. Keeps legacy catalogs stable. */
export const DEFAULT_IMAGERY_ILLUMINATION: ImageryIllumination = 'unknown';

export function isImageryIllumination(value: unknown): value is ImageryIllumination {
  return value === 'reflectance' || value === 'baked' || value === 'unknown';
}

/**
 * A summary of the provenance of everything a surface draws, for diagnostics
 * and UI: the shared value when every contributing source agrees, `mixed` when
 * they do not. It does **not** pick a lighting path: that is decided per pixel
 * from each layer's own provenance and coverage (`imageryAsIsWeight` and
 * `injectAsIsDisplayIntoShader`), so a reflectance base under a baked overlay
 * is relit outside the overlay's footprint and shown as-is inside it. Callers
 * pass only sources that actually contribute pixels (visible, opacity above
 * zero). Empty is `unknown`.
 */
export type SurfaceIlluminationSummary = ImageryIllumination | 'mixed';

export function combineImageryIllumination(values: Iterable<ImageryIllumination | undefined>): SurfaceIlluminationSummary {
  let seen = 0, baked = 0, reflectance = 0;
  for (const raw of values) {
    seen++;
    const v = isImageryIllumination(raw) ? raw : DEFAULT_IMAGERY_ILLUMINATION;
    if (v === 'baked') baked++;
    else if (v === 'reflectance') reflectance++;
  }
  if (seen === 0) return 'unknown';
  if (baked === seen) return 'baked';
  if (reflectance === seen) return 'reflectance';
  return baked === 0 && reflectance === 0 ? 'unknown' : 'mixed';
}

/**
 * The per-layer weight the compositor blends with that layer's alpha: 1 for a
 * source whose pixels already carry lighting (shown as-is), 0 for one the Sun
 * lights (`reflectance`, and legacy `unknown`).
 */
export function imageryAsIsWeight(illumination: ImageryIllumination | undefined): 0 | 1 {
  return illumination === 'baked' ? 1 : 0;
}

/**
 * How a surface material takes the Sun:
 * - `relit`: the simulated Sun lights it (`reflectance`, and legacy `unknown`).
 * - `as-is`: shown unlit by the Sun; its source pixels already carry lighting.
 */
export type SurfaceLightingPath = 'relit' | 'as-is';

export function surfaceLightingPath(illumination: SurfaceIlluminationSummary): SurfaceLightingPath {
  return illumination === 'baked' ? 'as-is' : 'relit';
}

/** True only when the Sun's direct term is a physical claim for this source. */
export function isPhysicallyRelit(illumination: SurfaceIlluminationSummary, mode: LightingMode): boolean {
  return illumination === 'reflectance' && LIGHTING_MODES[mode].physical;
}

export type LightingMode = 'natural' | 'shadow' | 'flood';

export interface LightingModeParams {
  /** Ambient colour. */
  ambientHex: number;
  /** Sun DirectionalLight intensity. */
  sunIntensity: number;
  /** Only `natural` is a physical claim. `shadow` and `flood` are visualization aids. */
  physical: boolean;
  /**
   * Brightness (fraction of the image) of an illumination-baked pixel whose
   * local horizon is past the terminator, i.e. the Sun is below it. Matches
   * the mode's ambient, so a night-side baked surface is as dark as a relit one.
   */
  bakedNightFloor: number;
}

export const LIGHTING_MODES: Readonly<Record<LightingMode, Readonly<LightingModeParams>>> = {
  // Airless space: the unlit hemisphere is essentially black (0x080808 ≈ 3%).
  natural: { ambientHex: 0x080808, sunIntensity: 2, physical: true, bakedNightFloor: 0x08 / 0xff },
  // Brighter ambient so dark-side detail is visible; softer Sun. Nonphysical.
  shadow: { ambientHex: 0x555555, sunIntensity: 1.5, physical: false, bakedNightFloor: 0x55 / 0xff },
  // Uniform: full ambient, no directional term. Nonphysical.
  flood: { ambientHex: 0xffffff, sunIntensity: 0, physical: false, bakedNightFloor: 1 },
};

/** Apply a mode to an ambient/Sun light pair. Either may be absent. */
export function applyLightingMode(
  mode: LightingMode,
  ambient: THREE.AmbientLight | null | undefined,
  sun: THREE.DirectionalLight | null | undefined,
): void {
  const p = LIGHTING_MODES[mode];
  if (ambient) {
    ambient.color.setHex(p.ambientHex);
    ambient.intensity = 1;
  }
  if (sun) sun.intensity = p.sunIntensity;
}

const _toSun = new THREE.Vector3();

/**
 * Unit vector from `receiver` toward `sun`, in the scene frame they share.
 * Null when the two coincide or either is not finite: callers must keep the
 * previous direction rather than aim at NaN.
 */
export function sunDirectionAt(
  receiver: THREE.Vector3,
  sun: THREE.Vector3,
  out = new THREE.Vector3(),
): THREE.Vector3 | null {
  _toSun.subVectors(sun, receiver);
  const len = _toSun.length();
  if (!Number.isFinite(len) || len <= 0) return null;
  return out.copy(_toSun).multiplyScalar(1 / len);
}

/**
 * Aim a DirectionalLight so its light travels from the Sun to `receiver`.
 * The shared Sun light used to be aimed at the scene origin, which is the Sun
 * direction at the *camera's origin body*; on any other body that is wrong by
 * the parallax between the two, up to tens of degrees between planets.
 * Returns false (light untouched) when the geometry is degenerate.
 */
export function aimSunLight(
  light: THREE.DirectionalLight,
  sunPos: THREE.Vector3,
  receiverPos: THREE.Vector3,
): boolean {
  if (sunDirectionAt(receiverPos, sunPos) === null) return false;
  light.position.copy(sunPos);
  light.target.position.copy(receiverPos);
  light.target.updateMatrixWorld();
  return true;
}

/**
 * The surface a scene-wide Sun light should be aimed at: the streamed-surface
 * body nearest the camera (by altitude) within `maxAltitudeRadii` body radii,
 * or null to keep the scene origin. Bodies without a streamed surface keep
 * their long-standing origin-aimed light.
 */
export function pickIlluminationReceiver<T extends { position: THREE.Vector3; radius: number }>(
  cameraPos: THREE.Vector3,
  candidates: Iterable<T>,
  maxAltitudeRadii = 20,
): T | null {
  let best: T | null = null, bestAlt = Infinity;
  for (const c of candidates) {
    if (!(c.radius > 0)) continue;
    const altitude = cameraPos.distanceTo(c.position) - c.radius;
    if (!Number.isFinite(altitude) || altitude > maxAltitudeRadii * c.radius) continue;
    if (altitude < bestAlt) { bestAlt = altitude; best = c; }
  }
  return best;
}

/** `cos(incidence)` of sunlight on a surface with unit normal `normal`, clamped at the terminator. */
export function incidenceCosine(normal: THREE.Vector3, sunDir: THREE.Vector3): number {
  return Math.max(0, normal.dot(sunDir));
}

/**
 * The unshadowed direct solar term a Lambertian surface receives, in units of
 * the Sun light's intensity: `intensity × cos(incidence)`, zero past the
 * terminator and in `flood`. This is what #205's visibility factor multiplies;
 * ambient and baked terms are separate and never included.
 */
export function directTerm(mode: LightingMode, normal: THREE.Vector3, sunDir: THREE.Vector3): number {
  return LIGHTING_MODES[mode].sunIntensity * incidenceCosine(normal, sunDir);
}

export interface SolarGeometry {
  /** Degrees above the local horizontal plane; negative below the horizon. */
  elevationDeg: number;
  /** Degrees clockwise from local north (0 = N, 90 = E). */
  azimuthDeg: number;
  /** `cos(incidence)` on a surface whose normal is the local radial. May be negative. */
  cosIncidence: number;
}

const DEG = Math.PI / 180;

/**
 * Sun elevation and azimuth at a body-fixed latitude/longitude, for fixed-pose
 * diagnostics and screenshot captions.
 *
 * `bodyToScene` rotates body-fixed axes (Z north, longitude from +X toward +Y)
 * into the scene frame, i.e. `BodyMesh.mesh.quaternion`; because it is read
 * per call, a rotating body and a moving Sun need no extra handling. The
 * point is on the sphere of `radius`; the local vertical is the radial, which
 * is the geocentric normal. Pass planetocentric latitude.
 */
export function solarGeometryAt(
  bodyPos: THREE.Vector3,
  bodyToScene: THREE.Quaternion,
  sunPos: THREE.Vector3,
  radius: number,
  latitudeDeg: number,
  longitudeDeg: number,
): SolarGeometry | null {
  const lat = latitudeDeg * DEG, lon = longitudeDeg * DEG;
  const cl = Math.cos(lat);
  const up = new THREE.Vector3(cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat));
  const east = new THREE.Vector3(-Math.sin(lon), Math.cos(lon), 0);
  const north = new THREE.Vector3().crossVectors(up, east);
  const point = up.clone().multiplyScalar(radius).applyQuaternion(bodyToScene).add(bodyPos);
  const dir = sunDirectionAt(point, sunPos);
  if (!dir) return null;
  // Into body-fixed axes: the inverse rotation.
  const inv = bodyToScene.clone().invert();
  const s = dir.applyQuaternion(inv);
  const e = s.dot(east), n = s.dot(north), u = s.dot(up);
  return {
    elevationDeg: Math.asin(Math.max(-1, Math.min(1, u))) / DEG,
    azimuthDeg: ((Math.atan2(e, n) / DEG) + 360) % 360,
    cosIncidence: u,
  };
}

/**
 * Uniforms of the baked-imagery display hook. `uSurfaceAsIs` is the weight of a
 * pixel no imagery layer covers (1 = shown as-is); every imagery compositor
 * blends its layers' weights over it by alpha into the per-fragment
 * `surfaceAsIs`. `centerView` is the body centre in view space and `nightFloor`
 * the mode's `bakedNightFloor` (1 disables the terminator gate).
 */
export interface SurfaceAsIsUniforms {
  surfaceAsIs: { value: number };
  centerView: { value: THREE.Vector3 };
  nightFloor: { value: number };
}

export function createSurfaceAsIsUniforms(mode: LightingMode = 'natural'): SurfaceAsIsUniforms {
  return { surfaceAsIs: { value: 0 }, centerView: { value: new THREE.Vector3() }, nightFloor: { value: LIGHTING_MODES[mode].bakedNightFloor } };
}

/** Half-width of the terminator gate in `sin(elevation)`: the Sun's angular radius. */
const TERMINATOR_HALF_WIDTH = 0.0047;

const AS_IS_DECLARATION = 'uniform float uSurfaceAsIs;\nfloat surfaceAsIs;\n';

/**
 * Declare the per-fragment `surfaceAsIs` and start it at the uncovered-pixel
 * weight. Idempotent, so any compositor and the display hook may each call it
 * in either order. A compositor then does
 * `surfaceAsIs = mix(surfaceAsIs, layerWeight, alpha)` beside its own
 * `diffuseColor` blend.
 */
export function declareSurfaceAsIs(shader: { fragmentShader: string }): void {
  if (shader.fragmentShader.includes('float surfaceAsIs;')) return;
  const main = /void main\(\s*\)\s*\{/;
  if (!main.test(shader.fragmentShader)) throw new Error('Baked-imagery display: fragment shader has no main().');
  shader.fragmentShader = AS_IS_DECLARATION + shader.fragmentShader.replace(main, 'void main() {\n  surfaceAsIs = uSurfaceAsIs;');
}

/**
 * Shader hook for `as-is` (illumination-baked) imagery. Run **before** the
 * eclipse and aerial-perspective injections so the Sun, ambient and image
 * based lighting cannot re-light pixels that already carry lighting, while
 * eclipse shadow and atmosphere still compose over the displayed colour. The
 * material's `diffuseColor` includes imagery overlays, so layer composition
 * survives.
 *
 * The decision is per fragment (`surfaceAsIs`, 0..1), so a baked overlay over a
 * relit base is displayed as-is inside its footprint only. The image carries
 * the acquisition Sun, not the simulated one, so slopes are never re-shaded;
 * but the Sun being below the local horizon of the reference sphere is not
 * something the image knows, so baked pixels past the terminator fall to the
 * lighting mode's `bakedNightFloor` over a Sun-radius-wide ramp. That is the
 * terminator only: terrain-cast shadow and horizon occlusion are #205.
 *
 * The uniforms are shared objects (1 = as-is, 0 = lit), so a change of
 * provenance is a uniform write, not a recompile, and relit and as-is tiles
 * share one program.
 */
export function injectAsIsDisplayIntoShader(
  shader: { fragmentShader: string; uniforms?: Record<string, unknown> },
  uniforms: SurfaceAsIsUniforms | { value: number },
): void {
  const hook = '#include <opaque_fragment>';
  if (!shader.fragmentShader.includes(hook)) {
    throw new Error('Baked-imagery display: Three.js opaque_fragment shader hook changed.');
  }
  const u: SurfaceAsIsUniforms = 'surfaceAsIs' in uniforms ? uniforms
    : { surfaceAsIs: uniforms, centerView: { value: new THREE.Vector3() }, nightFloor: { value: 1 } };
  if (shader.uniforms) {
    shader.uniforms.uSurfaceAsIs = u.surfaceAsIs;
    shader.uniforms.uSurfaceCenterView = u.centerView;
    shader.uniforms.uBakedNightFloor = u.nightFloor;
  }
  declareSurfaceAsIs(shader);
  const h = TERMINATOR_HALF_WIDTH.toFixed(4);
  shader.fragmentShader = 'uniform vec3 uSurfaceCenterView;\nuniform float uBakedNightFloor;\n' + shader.fragmentShader.replace(
    hook,
    `float surfaceBakedGate = 1.0;
#if NUM_DIR_LIGHTS > 0
if (uBakedNightFloor < 1.0) {
  float sunUp = dot(normalize(-vViewPosition - uSurfaceCenterView), directionalLights[0].direction);
  surfaceBakedGate = mix(uBakedNightFloor, 1.0, smoothstep(-${h}, ${h}, sunUp));
}
#endif
outgoingLight = mix(outgoingLight, diffuseColor.rgb * surfaceBakedGate, surfaceAsIs);
` + hook,
  );
}

/**
 * Per-layer hook for `ImageOverlayPlugin`'s geographic overlay compositor
 * (3d-tiles-renderer), whose loop blends each layer into `diffuseColor` with no
 * extension point. Adds an `asIs` member to its `LayerInfo` struct (uploaded
 * from the overlay object's own `asIs` property) and blends it by the layer's
 * alpha beside the colour. A no-op on a shader without that compositor;
 * throws when the compositor is present but no longer has the expected shape,
 * so a library upgrade cannot silently double-light baked overlays.
 */
export function injectOverlayAsIsIntoShader(shader: { fragmentShader: string }): void {
  const src = shader.fragmentShader;
  if (!src.includes('struct LayerInfo')) return;
  if (src.includes('layerInfo[ i ].asIs')) return;
  const member = /(struct LayerInfo\s*\{[^}]*?float opacity;)/;
  const blend = 'diffuseColor = tint + diffuseColor * ( 1.0 - tint.a );';
  if (!member.test(src) || !src.includes(blend)) {
    throw new Error('Baked-imagery display: ImageOverlayPlugin overlay shader changed.');
  }
  declareSurfaceAsIs(shader);
  shader.fragmentShader = shader.fragmentShader.replace(member, '$1\nfloat asIs;')
    .replace(blend, blend + '\nsurfaceAsIs = mix( surfaceAsIs, layerInfo[ i ].asIs, tint.a );');
}
