/**
 * Coordinate transforms between SpiceCraft's J2000 Ecliptic frame (km)
 * and Cesium's coordinate systems (ICRF equatorial, meters).
 *
 * SpiceCraft positions are in ECLIPJ2000: X toward vernal equinox, Z toward
 * ecliptic north pole, in km.
 *
 * Cesium uses ICRF (≈J2000 equatorial): X toward vernal equinox, Z toward
 * celestial north pole, in meters.
 *
 * The transform is a rotation around X by the obliquity of the ecliptic
 * (23.4392911 degrees at J2000) plus a km-to-meters scale.
 */

/** Mean obliquity of the ecliptic at J2000 in radians. */
const OBLIQUITY_RAD = 23.4392911 * Math.PI / 180;
const COS_OBL = Math.cos(OBLIQUITY_RAD);
const SIN_OBL = Math.sin(OBLIQUITY_RAD);

/** Convert km to meters. */
const KM_TO_M = 1000;

/**
 * Transform a position from SpiceCraft's J2000 Ecliptic frame (km)
 * to J2000 Equatorial/ICRF frame (meters).
 *
 * Rotation: X unchanged, Y/Z rotated by obliquity.
 *   x_eq = x_ecl
 *   y_eq = y_ecl * cos(ε) - z_ecl * sin(ε)
 *   z_eq = y_ecl * sin(ε) + z_ecl * cos(ε)
 */
export function eclipticToEquatorial(
  position: [number, number, number],
): [number, number, number] {
  const [x, y, z] = position;
  return [
    x * KM_TO_M,
    (y * COS_OBL - z * SIN_OBL) * KM_TO_M,
    (y * SIN_OBL + z * COS_OBL) * KM_TO_M,
  ];
}

/**
 * Transform a position from J2000 Equatorial/ICRF (meters)
 * back to SpiceCraft's J2000 Ecliptic frame (km).
 */
export function equatorialToEcliptic(
  position: [number, number, number],
): [number, number, number] {
  const [x, y, z] = position;
  const M_TO_KM = 0.001;
  return [
    x * M_TO_KM,
    (y * COS_OBL + z * SIN_OBL) * M_TO_KM,
    (-y * SIN_OBL + z * COS_OBL) * M_TO_KM,
  ];
}

/**
 * Transform a SpiceCraft quaternion (w,x,y,z) from ecliptic frame
 * to equatorial frame. The rotation is applied as:
 *   q_eq = q_ecl2eq * q_ecl
 * where q_ecl2eq is the rotation around X by obliquity.
 */
export function quaternionEclipticToEquatorial(
  q: [number, number, number, number],
): [number, number, number, number] {
  const [w, x, y, z] = q;
  // q_ecl2eq = (cos(ε/2), sin(ε/2), 0, 0)
  const halfObl = OBLIQUITY_RAD / 2;
  const cw = Math.cos(halfObl);
  const cx = Math.sin(halfObl);
  // Quaternion multiplication: q_ecl2eq * q
  return [
    cw * w - cx * x,
    cw * x + cx * w,
    cw * y - cx * z,
    cw * z + cx * y,
  ];
}

/**
 * Convert a SpiceCraft absolute position (ecliptic km) to a Cesium-compatible
 * ICRF Cartesian3 array [x, y, z] in meters.
 *
 * This is the most common transform: take the output of
 * `universe.absolutePositionOf(bodyName, et)` and convert it to
 * coordinates that Cesium's ICRF reference frame understands.
 */
export function positionForCesium(
  eclipticKm: [number, number, number],
): [number, number, number] {
  return eclipticToEquatorial(eclipticKm);
}

/**
 * Convert geodetic coordinates (latitude, longitude, height) to
 * body-fixed Cartesian coordinates in meters, assuming a spherical body.
 *
 * @param latDeg Latitude in degrees (positive north)
 * @param lonDeg Longitude in degrees (positive east)
 * @param heightKm Height above surface in km
 * @param bodyRadiusKm Body mean radius in km
 * @returns [x, y, z] in meters, body-fixed frame (Z toward north pole)
 */
export function geodeticToCartesian(
  latDeg: number,
  lonDeg: number,
  heightKm: number,
  bodyRadiusKm: number,
): [number, number, number] {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const r = (bodyRadiusKm + heightKm) * KM_TO_M;
  const cosLat = Math.cos(lat);
  return [
    r * cosLat * Math.cos(lon),
    r * cosLat * Math.sin(lon),
    r * Math.sin(lat),
  ];
}
