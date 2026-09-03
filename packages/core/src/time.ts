/**
 * Calendar-string parsing for catalog times.
 *
 * Times in a catalog are UTC by contract: `docs/catalog-format.md` documents
 * them that way, and SPICE's `str2et` reads a bare calendar string as UTC
 * unconditionally. `Date.parse` does not agree. Since ES2016 it reads a
 * date-time form carrying no offset — `'2004-07-01T02:48:00'` — as LOCAL time,
 * while still reading a date-only form — `'2004-07-01'` — as UTC.
 *
 * So every epoch path that fell back to `Date.parse` when SPICE was
 * unavailable produced a time that depended on the machine's timezone, and
 * disagreed with the SPICE path by the local UTC offset. Silently: a catalog
 * renders, the bodies are simply somewhere else. The regression scene's
 * committed golden encoded its author's summer offset (UTC-7) and could only
 * be reproduced on a machine in that zone, in that half of the year.
 *
 * This module imports nothing, so any layer can depend on it.
 */

/** An explicit UTC designator or numeric offset at the end of the string. */
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Milliseconds since the Unix epoch for a UTC calendar string, independent of
 * the machine's timezone.
 *
 * A string carrying its own designator (`'…Z'`, `'…+02:00'`) is unambiguous and
 * parsed as written. A naive one is read as UTC — matching `str2et` and the
 * catalog contract — rather than as local time. Returns `NaN` for anything
 * unparseable, like `Date.parse`.
 *
 * Only forms with a time component need the correction; a date-only string is
 * already UTC per the spec, and appending a designator to it would be wrong for
 * implementations that accept `'2004-07-01 02:48:00'`-style input.
 */
export function utcMsFromCalendarString(time: string): number {
  const t = time.trim();
  if (HAS_OFFSET.test(t)) return Date.parse(t);
  return Date.parse(t.includes(':') ? `${t}Z` : t);
}

/**
 * The Unix millisecond value of the J2000 epoch as this library's non-SPICE
 * paths reckon it: 2000-01-01T12:00:00 treated as UTC.
 *
 * NOTE this is an approximation, and the reason `str2et` is always preferred.
 * The real J2000 epoch is 2000-01-01T12:00:00 **TDB**, which was
 * 2000-01-01T11:58:55.816 UTC — the offset being TAI-UTC leap seconds plus the
 * TT and TDB terms, about 64.184 s then and larger now. Reckoning ET as elapsed
 * UTC milliseconds therefore carries a residual error of roughly a minute,
 * which at orbital speeds is hundreds of kilometres. `packages/cesium-adapter`
 * and `packages/cesium` already use the exact 11:58:55.816 value; core and the
 * viewer use this one. Unifying them shifts numbers everywhere and wants its
 * own change — this constant exists to name the discrepancy rather than leave
 * it copied out by hand in six files.
 */
export const J2000_UNIX_MS_APPROX = Date.UTC(2000, 0, 1, 12, 0, 0);

/**
 * The exact Unix millisecond value of the J2000 epoch.
 *
 * J2000 is 2000-01-01T12:00:00 **TDB**, and that instant was
 * 2000-01-01T11:58:55.816 UTC — TT-TAI is 32.184 s and TAI-UTC was 32 s in
 * 2000, so TT-UTC was 64.184 s. Use this, not noon, whenever converting an
 * ephemeris time to or from a JavaScript `Date`. `packages/cesium-adapter` and
 * `packages/cesium` already did; core and the viewer used noon UTC and were
 * wrong by that 64.184 s everywhere they showed or consumed a wall-clock time.
 *
 * A residual remains: this ignores the leap seconds accrued *since* 2000 (five
 * of them, so about 5 s today), because doing better needs a leap-second table
 * this package does not carry. Where SPICE is available its `et2utc`/`str2et`
 * are exact and should be preferred; this is for the paths that have no SPICE
 * instance to reach.
 */
export const J2000_UNIX_MS = Date.UTC(2000, 0, 1, 11, 58, 55, 816);

/** A `Date` for an ephemeris time, for libraries that speak UTC calendar time.
 *
 *  Accurate to the leap seconds since 2000 (see `J2000_UNIX_MS`). satellite.js
 *  reads the `Date` with UTC getters, so this is the conversion SGP4 wants. */
export function etToDate(et: number): Date {
  return new Date(J2000_UNIX_MS + et * 1000);
}

/** Ephemeris time for a `Date`. The inverse of `etToDate`, same caveat. */
export function etFromDate(date: Date): number {
  return (date.getTime() - J2000_UNIX_MS) / 1000;
}

/**
 * Seconds past J2000 for a UTC calendar string, without SPICE.
 *
 * The fallback for when no leapseconds kernel is loaded and `str2et` is
 * therefore unavailable. Timezone-independent (see
 * `utcMsFromCalendarString`) but only approximately ET (see
 * `J2000_UNIX_MS_APPROX`). Returns `NaN` when the string cannot be parsed, so
 * callers can tell failure from a legitimate epoch of 0.
 */
export function approxEtFromCalendarString(time: string): number {
  return (utcMsFromCalendarString(time) - J2000_UNIX_MS_APPROX) / 1000;
}
