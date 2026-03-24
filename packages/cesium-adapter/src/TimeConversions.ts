/**
 * Conversions between SPICE ephemeris time (ET, seconds past J2000 TDB)
 * and representations suitable for CesiumJS.
 *
 * J2000 epoch: 2000-01-01T12:00:00.000 TDB
 * Cesium JulianDate: seconds since J2000 in TAI (internally) or UTC.
 *
 * TDB-TAI offset is approximately 32.184 seconds (ignoring small periodic
 * terms < 1.7ms). For mission visualization this is more than adequate.
 */

/** TDB - TAI offset in seconds (constant part only). */
const TDB_TAI_OFFSET = 32.184;

/** J2000 epoch as a JavaScript Date (2000-01-01T11:58:55.816 UTC). */
const J2000_UNIX_MS = Date.UTC(2000, 0, 1, 11, 58, 55, 816);

/**
 * Convert SPICE ET (seconds past J2000 TDB) to a JavaScript Date.
 * Approximate: ignores leap seconds added after J2000 and small TDB-TT periodic terms.
 */
export function etToDate(et: number): Date {
  return new Date(J2000_UNIX_MS + et * 1000);
}

/**
 * Convert a JavaScript Date to approximate SPICE ET (seconds past J2000 TDB).
 */
export function dateToEt(date: Date): number {
  return (date.getTime() - J2000_UNIX_MS) / 1000;
}

/**
 * Convert SPICE ET to an ISO 8601 UTC string suitable for CZML.
 * CZML expects ISO strings like "2024-01-15T12:00:00Z".
 */
export function etToIso(et: number): string {
  return etToDate(et).toISOString();
}

/**
 * Convert SPICE ET to Cesium JulianDate-compatible components.
 * Returns { dayNumber, secondsOfDay } in the TAI time standard,
 * which can be used with `new Cesium.JulianDate(dayNumber, secondsOfDay, Cesium.TimeStandard.TAI)`.
 */
export function etToJulianComponents(et: number): { dayNumber: number; secondsOfDay: number } {
  // J2000 epoch in Julian Day Number: 2451545.0 (TDB)
  // ET is seconds past this epoch in TDB; convert to TAI by subtracting offset
  const taiSeconds = et - TDB_TAI_OFFSET;
  const totalDays = taiSeconds / 86400;
  const dayNumber = Math.floor(2451545.0 + totalDays);
  const secondsOfDay = (2451545.0 + totalDays - dayNumber) * 86400;
  return { dayNumber, secondsOfDay };
}

/**
 * Convert Cesium JulianDate TAI components back to SPICE ET.
 */
export function julianComponentsToEt(dayNumber: number, secondsOfDay: number): number {
  const taiSeconds = (dayNumber - 2451545.0) * 86400 + secondsOfDay;
  return taiSeconds + TDB_TAI_OFFSET;
}

/**
 * Format a CZML time interval string from two ET values.
 * CZML uses "start/end" ISO format.
 */
export function etIntervalToIso(startEt: number, endEt: number): string {
  return `${etToIso(startEt)}/${etToIso(endEt)}`;
}
