/**
 * The orbit half of the live ISS (#371): a separately sourced, timestamped
 * two-line element set, checked against its real validity window.
 *
 * Nothing here reuses a catalog's historical TLE. A live scene gets its own
 * freshly fetched element set, and the position is reported only inside
 * `maxAgeMs` of that set's epoch; outside it the orbit is `expired`, not
 * extrapolated.
 */

export interface SourcedTle {
  line1: string;
  line2: string;
  name?: string;
  /** TLE epoch, ms since the Unix epoch UTC. */
  epochMs: number;
  /** When it was fetched, ms since the Unix epoch UTC. */
  retrievedAtMs: number;
  /** Human-readable origin, e.g. "CelesTrak GP". */
  source: string;
  sourceUrl: string;
}

/** The accuracy rule of thumb behind the default: SGP4 ISS error is a few km at a day, tens of km by several days. */
export const DEFAULT_ORBIT_MAX_AGE_MS = 3 * 86_400_000;

export const CELESTRAK_ISS_URL = 'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle';

function checksumOk(line: string): boolean {
  if (line.length < 69) return false;
  let sum = 0;
  for (let i = 0; i < 68; i++) {
    const c = line[i];
    if (c >= '0' && c <= '9') sum += Number(c);
    else if (c === '-') sum += 1;
  }
  return sum % 10 === Number(line[68]);
}

/** Epoch of a TLE line 1 (columns 19-32: yyddd.dddddddd), ms since the Unix epoch UTC. */
export function tleEpochMs(line1: string): number {
  const yy = Number(line1.slice(18, 20));
  const day = Number(line1.slice(20, 32));
  if (!Number.isFinite(yy) || !Number.isFinite(day) || day < 1 || day >= 367) return NaN;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return Date.UTC(year, 0, 1) + (day - 1) * 86_400_000;
}

/**
 * Parse a TLE text block (two lines, or name + two lines) for one object.
 * Rejects bad checksums, mismatched catalogue numbers and impossible epochs.
 */
export function parseTle(text: string, meta: { source: string; sourceUrl: string; retrievedAtMs: number }, noradId = '25544'): SourcedTle {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const i1 = lines.findIndex((l) => l.startsWith('1 ') && l.length >= 69);
  const line1 = lines[i1], line2 = lines[i1 + 1];
  if (i1 < 0 || !line2?.startsWith('2 ')) throw new Error('no TLE line pair found');
  if (!checksumOk(line1) || !checksumOk(line2)) throw new Error('TLE checksum mismatch');
  if (line1.slice(2, 7).trim() !== noradId || line2.slice(2, 7).trim() !== noradId) throw new Error(`TLE is not for NORAD ${noradId}`);
  const epochMs = tleEpochMs(line1);
  if (!Number.isFinite(epochMs)) throw new Error('TLE epoch is not valid');
  return { line1, line2, name: i1 > 0 ? lines[i1 - 1].trim() : undefined, epochMs, ...meta };
}

export type OrbitState = 'current' | 'expired' | 'missing';

export interface OrbitValidity {
  state: OrbitState;
  /** `source time - epoch`, ms; negative for an element set newer than the sample. */
  offsetMs?: number;
  epochMs?: number;
  source?: string;
}

/** Is `tle` usable at source time `atMs`? Symmetric: neither older nor newer than the window. */
export function orbitValidity(tle: SourcedTle | undefined, atMs: number, maxAgeMs = DEFAULT_ORBIT_MAX_AGE_MS): OrbitValidity {
  if (!tle) return { state: 'missing' };
  const offsetMs = atMs - tle.epochMs;
  return { state: Math.abs(offsetMs) <= maxAgeMs ? 'current' : 'expired', offsetMs, epochMs: tle.epochMs, source: tle.source };
}

export interface FetchLike {
  (url: string, init?: { signal?: AbortSignal }): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

/**
 * Fetch the current ISS element set from CelesTrak. The caller supplies
 * `fetch` (CORS-enabled in a browser) and the clock; CelesTrak asks clients
 * not to poll more than every couple of hours, so fetch once per session or
 * on expiry, not per frame.
 */
export async function fetchCelestrakIss(fetchImpl: FetchLike, now: () => number = Date.now, signal?: AbortSignal): Promise<SourcedTle> {
  const response = await fetchImpl(CELESTRAK_ISS_URL, { signal });
  if (!response.ok) throw new Error(`CelesTrak responded ${response.status}`);
  return parseTle(await response.text(), { source: 'CelesTrak GP (NORAD 25544)', sourceUrl: CELESTRAK_ISS_URL, retrievedAtMs: now() });
}
