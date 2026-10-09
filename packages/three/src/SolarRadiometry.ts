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

/** A shared fixed exposure, power-law HDR display response for direct and
 * scattered solar radiance. This is a visualization convention, not photometry.
 * Leave zero exactly zero; encode to the output color space only afterwards.
 */
export const SOLAR_DISPLAY_GLSL = /* glsl */ `
vec3 radianceToDisplay(vec3 radiance) {
  return 0.94 * pow(max(vec3(0.0), radiance) / ${SOLAR_CENTER_RADIANCE[0]}, vec3(1.0 / 3.0));
}
`;
