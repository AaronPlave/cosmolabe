/** Relative radiance units: the photosphere center is the reference white.
 * Irradiance is its disk integral, not another independently tuned light source.
 */
export const SOLAR_CENTER_RADIANCE = [3.2, 3.08, 2.88] as const;
export const SOLAR_RADIUS_KM = 695000;
export const SOLAR_REFERENCE_DISTANCE_KM = 149597870;
// Integral of (0.4 + 0.6 mu) over projected disk area is 0.8.
export const SOLAR_MEAN_LIMB = 0.8;
export function solarIrradiance(distanceKm: number, radiusKm = SOLAR_RADIUS_KM): [number, number, number] {
  const projectedSolidAngle = Math.PI * (radiusKm / Math.max(radiusKm, distanceKm)) ** 2;
  return SOLAR_CENTER_RADIANCE.map(c => c * SOLAR_MEAN_LIMB * projectedSolidAngle) as [number, number, number];
}

/** Body lighting is normalized rather than inverse-square dimmed. Adapt the
 * solar/atmospheric display to the observer's incident irradiance as well,
 * instead of leaving outer-system haze dark beside normally lit textures.
 * Apply this one exposure to both direct and scattered light; HDR stays linear.
 */
export function solarDisplayExposure(distanceKm: number, radiusKm = SOLAR_RADIUS_KM): number {
  return 1 / solarIrradiance(Math.max(radiusKm, distanceKm), radiusKm)[0];
}

/**
 * Scene presentation exposure for Sun, scattering shells and aerial perspective.
 *
 * "legacy-observer-adapted" preserves existing catalog appearance by
 * normalizing to the camera's inverse-square solar irradiance. It is NOT a
 * reproducible fixed-exposure capture and can brighten outer-system views.
 * "fixed-reference" holds one multiplier for every observer and epoch.
 *
 * The physical source and LUT radiances are never multiplied by this value.
 * Stars, unlit materials and generic bloom do not yet participate in this
 * response: see issue #212's HDR compositor migration.
 */
export type SolarExposurePolicy =
  | { mode: 'legacy-observer-adapted' }
  | { mode: 'fixed-reference'; exposure?: number };

export const DEFAULT_SOLAR_EXPOSURE_POLICY: SolarExposurePolicy =
  { mode: 'legacy-observer-adapted' };

/** Fixed 1 AU reference: the same RGB signal always maps to the same display RGB. */
export const FIXED_REFERENCE_SOLAR_EXPOSURE = solarDisplayExposure(SOLAR_REFERENCE_DISTANCE_KM);

export function resolveSolarDisplayExposure(
  policy: SolarExposurePolicy,
  observerDistanceKm: number,
  solarRadiusKm = SOLAR_RADIUS_KM,
): number {
  if (policy.mode === 'legacy-observer-adapted') {
    return solarDisplayExposure(observerDistanceKm, solarRadiusKm);
  }
  if (policy.mode !== 'fixed-reference') {
    throw new Error('Unknown solar exposure policy');
  }
  const exposure = policy.exposure ?? FIXED_REFERENCE_SOLAR_EXPOSURE;
  if (!Number.isFinite(exposure) || exposure <= 0) {
    throw new Error('Fixed solar exposure must be finite and greater than zero');
  }
  return exposure;
}

/** Data attached to a reference screenshot/export; no camera-adaptation state. */
export function solarExposureMetadata(policy: SolarExposurePolicy): {
  mode: SolarExposurePolicy['mode'];
  exposure: number | null;
  response: 'reinhard-0.94';
  radianceUnits: 'relative-solar-center';
  referenceDistanceKm: number;
} {
  return {
    mode: policy.mode,
    exposure: policy.mode === 'fixed-reference'
      ? resolveSolarDisplayExposure(policy, SOLAR_REFERENCE_DISTANCE_KM)
      : null, // Legacy exposure changes with the observing camera and time.
    response: 'reinhard-0.94',
    radianceUnits: 'relative-solar-center',
    referenceDistanceKm: SOLAR_REFERENCE_DISTANCE_KM,
  };
}

/** CPU counterpart of SOLAR_DISPLAY_GLSL for fixed-exposure numeric regressions. */
export function solarRadianceToDisplay(radiance: readonly number[], exposure: number): number[] {
  return radiance.map(value => {
    const x = Math.max(0, value) * exposure;
    return 0.94 * x / (1 + x);
  });
}

export function makeSolarDisplayUniforms() {
  return { uSolarExposure: { value: solarDisplayExposure(SOLAR_REFERENCE_DISTANCE_KM) } };
}

/** Shared Reinhard display shoulder in normalized-light units. */
export const SOLAR_DISPLAY_GLSL = /* glsl */ `
uniform float uSolarExposure;
vec3 radianceToDisplay(vec3 radiance) {
  vec3 exposed = max(vec3(0.0), radiance) * uSolarExposure;
  return 0.94 * exposed / (vec3(1.0) + exposed);
}
`;
