/**
 * Earth-eclipse shadow computation for satellites.
 *
 * Uses the angular-overlap method: from the satellite's viewpoint, compute
 * the angular radii of Earth and Sun and their separation angle. This gives
 * a smooth penumbra fraction from the Sun's finite angular diameter.
 *
 * The default Earth radius includes ~70 km of atmosphere, which models the
 * limb-refraction effect: dimming begins a few seconds before geometric
 * shadow entry, matching what ISS astronauts actually see (the solar panels
 * redden before orbital night).
 */

const SUN_RADIUS_KM = 696_000;
const EARTH_MEAN_RADIUS_KM = 6_371;
const ATMOSPHERE_KM = 70;

/**
 * Compute shadow fraction for a satellite.
 * All positions in km, Earth-centered inertial (origin at Earth center).
 *
 * @returns 0 = full sunlight, 1 = full umbra, 0–1 = penumbra
 */
export function shadowFraction(
  satX: number,
  satY: number,
  satZ: number,
  sunX: number,
  sunY: number,
  sunZ: number,
  earthRadius = EARTH_MEAN_RADIUS_KM + ATMOSPHERE_KM,
): number {
  const dSat = Math.sqrt(satX * satX + satY * satY + satZ * satZ);
  const toSunX = sunX - satX;
  const toSunY = sunY - satY;
  const toSunZ = sunZ - satZ;
  const dSun = Math.sqrt(toSunX * toSunX + toSunY * toSunY + toSunZ * toSunZ);

  if (dSat === 0 || dSun === 0) return 0;

  // Angular radii as seen from the satellite
  const earthAR = Math.asin(Math.min(1, earthRadius / dSat));
  const sunAR = Math.asin(Math.min(1, SUN_RADIUS_KM / dSun));

  // Angular separation: Earth center is at –sat from the satellite
  const dot =
    (-satX * toSunX - satY * toSunY - satZ * toSunZ) / (dSat * dSun);
  const sep = Math.acos(Math.max(-1, Math.min(1, dot)));

  if (sep >= earthAR + sunAR) return 0; // full sun
  if (sep <= earthAR - sunAR) return 1; // full umbra

  // Penumbra — linear fraction of Sun disc hidden
  return (earthAR + sunAR - sep) / (2 * sunAR);
}

/**
 * Compute model highlight color for a given shadow fraction.
 *
 * Simulates two real optical effects:
 *  - **Penumbra**: atmospheric refraction at Earth's limb filters blue/green
 *    first, producing a warm sunset reddening on the spacecraft.
 *  - **Umbra**: faint blue-ish Earthshine from the sunlit hemisphere's
 *    Rayleigh-scattered light reflecting off the hull.
 *
 * Returns [r, g, b] in 0–1, designed for Cesium's HIGHLIGHT colorBlendMode
 * (multiplicative tint — white = no change, dark = dimmed).
 */
export function eclipseColor(shadow: number): [number, number, number] {
  if (shadow <= 0) return [1, 1, 1];
  if (shadow >= 1) return [0.03, 0.03, 0.06];

  // Early penumbra (0 → 0.5): white → warm sunset
  // Blue fades fastest (Rayleigh scattering), red lingers
  if (shadow < 0.5) {
    const t = shadow * 2;
    return [1 - t * 0.15, 1 - t * 0.5, 1 - t * 0.7];
  }

  // Late penumbra (0.5 → 1): sunset → near-black with Earthshine
  const t = (shadow - 0.5) * 2;
  return [0.85 - t * 0.82, 0.5 - t * 0.47, 0.3 - t * 0.24];
}
