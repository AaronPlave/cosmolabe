/**
 * ISO-8601 → SPICE calendar normalisation for the tier's one epoch authority.
 *
 * `str2et_c` does not speak ISO-8601. It accepts a *subset* of ISO forms with
 * no designator at all — `'2004-07-01T02:00:00'` parses, `'…Z'` and
 * `'…+02:00'` are both rejected outright with SPICE(UNPARSEDTIME) — and it
 * reads such a bare string as UTC by default rather than because the string
 * said so. What it does take an explicit time-system token on is the *calendar*
 * form, the one with a space where ISO puts the `T`:
 * `'2004-07-01 02:00:00 UTC'`.
 *
 * The tier used to bridge that gap by stripping one trailing `Z` and handing
 * the rest to `str2et_c` (issue #8). That worked for exactly the strings the
 * catalogs happened to carry, and misread everything else: an offset epoch
 * (`'…T02:00:00+02:00'`) threw an unparseable-time error two frames below the
 * caller, `'…Z '` with a stray space threw as well, and a UTC reading was
 * never stated anywhere — it was CSPICE's default, inherited silently.
 *
 * So: recognise the ISO-8601 forms properly, resolve any offset the string
 * carries, and emit the calendar form with `UTC` spelled out. Anything that is
 * not ISO-8601 passes through untouched, because `str2et_c` speaks a much
 * larger language than ISO — `'2004 JUL 01 02:00:00'`, `'2004-183 // 02:00'`,
 * `'JD 2453187.5'`, and any form carrying its own system token
 * (`'1996-12-18 12:00:00.331 TDB'`, which `OemAdapter.oemEpochToEt` builds
 * deliberately) — and this module owns no opinion about those.
 *
 * This module imports nothing, so any layer can depend on it.
 */

/**
 * An ISO-8601 calendar date-time.
 *
 * Deliberately narrow. The date half must be the extended calendar form
 * (`YYYY-MM-DD`): ordinal (`2004-183`) and week (`2004-W27-4`) dates are ISO
 * too, but CSPICE reads a bare `2004-183` as its own day-of-year form and the
 * week form not at all, so both are left to the engine rather than
 * half-translated here. The `T` may be a space, which is ISO-8601-2's extended
 * form and what most hand-written catalog epochs use. Seconds may carry any
 * number of fractional digits, and may read `60` on a leap-second insertion —
 * both pass through as text, so neither loses a digit to a float round-trip.
 */
const ISO_DATE_TIME =
  /^(\d{4,})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}(?:[.,]\d+)?))?)?(Z|[+-]\d{2}:?\d{2}|[+-]\d{2})?$/i;

/** Zero-padded integer, for re-emitting fields an offset shift moved. */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * The SPICE time string for an ISO-8601 instant, explicit about UTC.
 *
 * `'2004-07-01T02:00:00Z'` → `'2004-07-01 02:00:00 UTC'`. A numeric offset is
 * resolved to UTC first (`'2004-07-01T04:00:00+02:00'` → the same string),
 * which is exact: ISO offsets are whole minutes, so the seconds field and its
 * fraction are carried across verbatim and only the date, hour and minute
 * shift. A string with no designator is read as UTC, matching both the
 * catalog contract (`docs/catalog-format.md`) and CSPICE's own default — the
 * difference is that the result now says so.
 *
 * Input that is not an ISO-8601 calendar date-time is returned unchanged, for
 * `str2et` to parse or reject in its own terms.
 */
export function spiceUtcFromIso(time: string): string {
  const match = ISO_DATE_TIME.exec(time.trim());
  if (!match) return time;

  const [, year, month, day, hour, minute, second, designator] = match as unknown as [
    string, string, string, string, string | undefined, string | undefined,
    string | undefined, string | undefined,
  ];

  // CSPICE's calendar form cannot read a leading-zero year: it resolves
  // `'0999-07-01 …'` field by field and gives up on the day token, where the
  // ISO form parses it fine. That is the one case the calendar form loses to
  // the ISO form, so keep the ISO form there — still UTC, by CSPICE's default
  // rather than by the token, and still with any offset resolved below.
  const calendarSafeYear = !year.startsWith('0');

  let y = Number(year);
  let mo = Number(month);
  let d = Number(day);
  let h = hour === undefined ? 0 : Number(hour);
  let mi = minute === undefined ? 0 : Number(minute);
  // ISO allows a comma as the decimal mark; CSPICE does not.
  const s = (second ?? '00').replace(',', '.');

  if (designator !== undefined && designator.toUpperCase() !== 'Z') {
    const sign = designator.startsWith('-') ? -1 : 1;
    const digits = designator.slice(1).replace(':', '');
    const offsetMinutes =
      sign * (Number(digits.slice(0, 2)) * 60 + (digits.length > 2 ? Number(digits.slice(2)) : 0));
    // Date.UTC does the calendar arithmetic (month lengths, leap years) and is
    // exact here: the shift is whole minutes, so no part of the seconds field
    // reaches it and nothing rounds. Years below 100 would be remapped to the
    // 1900s by Date.UTC's two-digit-year rule, so set the year explicitly.
    const shifted = new Date(0);
    shifted.setUTCFullYear(y, mo - 1, d);
    shifted.setUTCHours(h, mi - offsetMinutes, 0, 0);
    y = shifted.getUTCFullYear();
    mo = shifted.getUTCMonth() + 1;
    d = shifted.getUTCDate();
    h = shifted.getUTCHours();
    mi = shifted.getUTCMinutes();
  }

  const date = `${pad(y, year.length)}-${pad(mo)}-${pad(d)}`;
  const clock = `${pad(h)}:${pad(mi)}:${s}`;
  return calendarSafeYear ? `${date} ${clock} UTC` : `${date}T${clock}`;
}
