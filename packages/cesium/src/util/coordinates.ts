/**
 * Convert Cosmolabe positions to Cesium-compatible coordinates.
 *
 * For equatorial-frame bodies (TLE/TEME), positions are stored directly
 * in Cesium's INERTIAL reference frame — no coordinate conversion needed,
 * just km→meters scaling. Cesium handles ICRF→Fixed transformation.
 *
 * For ecliptic-frame bodies (SPICE), rotates from ecliptic to equatorial ICRF.
 */

import { positionForCesium } from '@cosmolabe/cesium-adapter';

/** km → meters */
export const KM_TO_M = 1000;

/**
 * Convert ecliptic J2000 position (km) to equatorial ICRF (meters).
 * Used for SPICE-frame bodies only.
 */
export function eclipticToIcrfMeters(
  position: [number, number, number],
): [number, number, number] {
  return positionForCesium(position);
}
