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
