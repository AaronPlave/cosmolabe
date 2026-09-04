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
 * The exact Unix millisecond value of the J2000 epoch.
 *
 * J2000 is 2000-01-01T12:00:00 **TDB**, and that instant was
 * 2000-01-01T11:58:55.816 UTC — TT-TAI is 32.184 s and TAI-UTC was 32 s in
 * 2000, so TT-UTC was 64.184 s. Use this, not noon, whenever converting an
 * ephemeris time to or from a JavaScript `Date`.
 *
 * This is the one J2000 constant in the codebase. `packages/cesium-adapter` and
 * `packages/cesium` each used to carry their own copy of the same literal; they
 * now import this.
 */
export const J2000_UNIX_MS = Date.UTC(2000, 0, 1, 11, 58, 55, 816);

/** TAI−UTC at the J2000 epoch, in seconds. The table below is stated as an
 *  absolute TAI−UTC, so conversions subtract this to express ET relative to
 *  J2000 rather than to 1972. */
const DELTA_AT_AT_J2000 = 32;

/**
 * TAI−UTC (ΔAT) in seconds, from the first modern leap second onward.
 *
 * Each entry is `[first Unix ms at which the value applies, seconds]`. This is
 * the IERS table, and it matches the `DELTET/DELTA_AT` block of NAIF's
 * `naif0012.tls` — the tests assert exactly that, epoch by epoch, against
 * `str2et`.
 *
 * Maintenance is close to nil in practice: no leap second has been inserted
 * since 2017-01-01, and in 2022 the CGPM resolved to abandon them by 2035. A
 * new insertion would need one line here; until then the table is complete.
 * Where a SPICE instance is available its `str2et` remains authoritative and is
 * always tried first — this exists so the SPICE-free path is exact rather than
 * seconds off.
 *
 * Pre-1972 UTC ran on "rubber seconds" (a rate offset, not integer steps). We
 * clamp to the 1972 value below that, which is wrong by under a second for
 * epochs no mission catalog here uses.
 */
const DELTA_AT_TABLE: ReadonlyArray<readonly [number, number]> = [
  [Date.UTC(1972, 0, 1), 10], [Date.UTC(1972, 6, 1), 11],
  [Date.UTC(1973, 0, 1), 12], [Date.UTC(1974, 0, 1), 13],
  [Date.UTC(1975, 0, 1), 14], [Date.UTC(1976, 0, 1), 15],
  [Date.UTC(1977, 0, 1), 16], [Date.UTC(1978, 0, 1), 17],
  [Date.UTC(1979, 0, 1), 18], [Date.UTC(1980, 0, 1), 19],
  [Date.UTC(1981, 6, 1), 20], [Date.UTC(1982, 6, 1), 21],
  [Date.UTC(1983, 6, 1), 22], [Date.UTC(1985, 6, 1), 23],
  [Date.UTC(1988, 0, 1), 24], [Date.UTC(1990, 0, 1), 25],
  [Date.UTC(1991, 0, 1), 26], [Date.UTC(1992, 6, 1), 27],
  [Date.UTC(1993, 6, 1), 28], [Date.UTC(1994, 6, 1), 29],
  [Date.UTC(1996, 0, 1), 30], [Date.UTC(1997, 6, 1), 31],
  [Date.UTC(1999, 0, 1), 32], [Date.UTC(2006, 0, 1), 33],
  [Date.UTC(2009, 0, 1), 34], [Date.UTC(2012, 6, 1), 35],
  [Date.UTC(2015, 6, 1), 36], [Date.UTC(2017, 0, 1), 37],
];

/**
 * TAI−UTC in seconds at a given Unix millisecond value.
 *
 * Exported for tests and for callers that need to reason about the offset
 * directly; most code wants `etFromCalendarString` instead.
 */
export function deltaAtSeconds(unixMs: number): number {
  // Walk backwards: the modern end of the table is what almost every lookup
  // wants, and the table is short enough that a scan beats a binary search.
  for (let i = DELTA_AT_TABLE.length - 1; i >= 0; i--) {
    if (unixMs >= DELTA_AT_TABLE[i][0]) return DELTA_AT_TABLE[i][1];
  }
  return DELTA_AT_TABLE[0][1];
}

/**
 * A `Date` (UTC wall clock) for an ephemeris time.
 *
 * Leap-second exact via `DELTA_AT_TABLE`: an ET is TT-like and runs without
 * steps, so recovering the UTC reading means subtracting the leap seconds
 * accrued between J2000 and that instant. satellite.js reads the `Date` with
 * UTC getters, so this is the conversion SGP4 wants.
 */
export function etToDate(et: number): Date {
  // ΔAT is indexed by UTC, but we are going the other way, so resolve it from
  // the uncorrected instant first and re-resolve once. One pass suffices
  // everywhere except within a few seconds of an insertion boundary, where the
  // second pass settles it.
  const approxMs = J2000_UNIX_MS + et * 1000;
  let ms = approxMs - (deltaAtSeconds(approxMs) - DELTA_AT_AT_J2000) * 1000;
  ms = approxMs - (deltaAtSeconds(ms) - DELTA_AT_AT_J2000) * 1000;
  return new Date(ms);
}

/** Ephemeris time for a `Date`. The exact inverse of `etToDate`. */
export function etFromDate(date: Date): number {
  const ms = date.getTime();
  return (ms - J2000_UNIX_MS) / 1000 + (deltaAtSeconds(ms) - DELTA_AT_AT_J2000);
}

/**
 * Seconds past J2000 for a UTC calendar string, without SPICE.
 *
 * Exact, not approximate: `TT = UTC + ΔAT + 32.184`, so relative to the J2000
 * epoch an ET is the elapsed UTC plus the leap seconds inserted since 2000.
 * Agrees with `str2et` to the millisecond over the whole table range — the
 * tests assert that against `naif0012.tls` rather than asserting self-
 * consistency.
 *
 * Where a SPICE instance exists, prefer its `str2et`: it accepts calendar forms
 * this does not (day-of-year, `JD`, era suffixes) and is authoritative. This is
 * for the SPICE-free path, which is a shipping configuration rather than a
 * theoretical one.
 *
 * Returns `NaN` when the string cannot be parsed, so callers can tell failure
 * from a legitimate epoch of 0. Do not coerce that `NaN` to 0 — that silently
 * moves a body to J2000.
 */
export function etFromCalendarString(time: string): number {
  const utcMs = utcMsFromCalendarString(time);
  if (Number.isNaN(utcMs)) return NaN;
  return (utcMs - J2000_UNIX_MS) / 1000 + (deltaAtSeconds(utcMs) - DELTA_AT_AT_J2000);
}
