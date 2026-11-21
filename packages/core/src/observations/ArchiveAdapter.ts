/**
 * Archive ingest: an `ArchiveObservation` (from `@cosmolabe/interop`'s OPUS or
 * ODE adapter) becomes an `Observation` in ET — the time/frame step that
 * mirrors `trajectories/OemAdapter.ts` for OEM.
 *
 * The same two disciplines, for the same reasons:
 *
 *  - Times go through an injected `str2et`, in the time system the archive
 *    declared, and an unconvertible system is refused rather than guessed.
 *    A UTC-as-TDB read is a ~65 s error — at Cassini's SOI speed, a footprint
 *    hundreds of km from where the camera looked.
 *  - The archive's target is the frame of record for its footprint polygon,
 *    so a disagreement with the body the caller pins it to is reported, loudly,
 *    rather than silently drawing ODE's lunar footprint on whatever was asked.
 */
import type { ArchiveObservation } from '@cosmolabe/interop';
import { ObservationError, type Observation, type ObservationCoverage } from './Observation.js';

/** Time systems str2et converts exactly, and the token it reads for each. */
const SUPPORTED_TIME_SYSTEMS: Record<string, string> = {
  UTC: 'UTC',
  TDB: 'TDB',
  TT: 'TDT',
  TDT: 'TDT',
};

/** An archive time string → ET, honouring its declared time system. */
export function archiveTimeToEt(time: string, timeSystem: string, str2et: (s: string) => number): number {
  const token = SUPPORTED_TIME_SYSTEMS[timeSystem.trim().toUpperCase()];
  if (!token) {
    throw new ObservationError(
      `archive time system ${JSON.stringify(timeSystem)} is not one this ingest converts exactly ` +
        `(${Object.keys(SUPPORTED_TIME_SYSTEMS).join(', ')}); refusing rather than guessing.`,
    );
  }
  // str2et refuses a system token after an ISO "T" string, but takes one after
  // the calendar form — the same quirk `oemEpochToEt` documents.
  return str2et(`${time.trim().replace(/Z$/i, '').replace('T', ' ')} ${token}`);
}

export interface ArchiveAdapterOptions {
  /** The body the caller will pin footprints to. A mismatch with the
   *  archive's own target is reported through `warn`; the archive's wins. */
  target?: string;
  /** Sensor body to compute coverage from when the archive gives none. */
  sensor?: string;
  /** Where mismatches go. Default `console.warn`. */
  warn?: (message: string) => void;
}

const sameBody = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

/** One archive record → one Observation (a single group, its exposure window). */
export function archiveToObservation(
  rec: ArchiveObservation,
  str2et: (s: string) => number,
  options: ArchiveAdapterOptions = {},
): Observation {
  const where = `${rec.archive} ${rec.id}`;
  const warn = options.warn ?? ((m: string) => console.warn(`[Cosmolabe] ${m}`));

  let target = rec.target ?? options.target;
  if (!target) throw new ObservationError(`${where}: no target from the archive and none given`);
  if (rec.target && options.target && !sameBody(rec.target, options.target)) {
    warn(
      `${where}: the archive's target is ${rec.target}, but it was asked for on ${options.target}. ` +
        `Its geometry is ${rec.target}'s, so it stays on ${rec.target}.`,
    );
    target = rec.target;
  }

  const toEt = (s: string, field: string) => {
    try {
      return archiveTimeToEt(s, rec.timeSystem, str2et);
    } catch (err) {
      throw new ObservationError(`${where}: ${field} ${JSON.stringify(s)}: ${(err as Error).message}`);
    }
  };
  const startEt = toEt(rec.startTime, 'startTime');
  const endEt = rec.stopTime ? toEt(rec.stopTime, 'stopTime') : startEt;
  if (endEt < startEt) throw new ObservationError(`${where}: stops before it starts`);

  let coverage: ObservationCoverage;
  if (rec.footprint?.length) {
    // Every ring is kept: an interior ring is an exclusion inside the outline,
    // and filling it would claim coverage the product does not have.
    const holes = rec.footprint.map((poly) => poly.slice(1));
    coverage = {
      kind: 'footprint',
      polygonLonLat: rec.footprint.map((poly) => poly[0]!),
      ...(holes.some((h) => h.length > 0) ? { holesLonLat: holes } : {}),
    };
  } else if (rec.disk) {
    coverage = {
      kind: 'disk',
      subObsLatLon: [rec.disk.subObsLatDeg, rec.disk.subObsLonDeg],
      distanceKm: rec.disk.distanceKm,
      ...(rec.disk.boresightRaDecDeg ? { boresightRaDec: rec.disk.boresightRaDecDeg } : {}),
    };
  } else if (options.sensor) {
    coverage = { kind: 'sensor', sensor: options.sensor };
  } else {
    throw new ObservationError(`${where}: the archive gave no footprint or disk geometry, and no sensor was named to compute one`);
  }

  return {
    name: rec.id,
    target,
    groups: [{ startEt, endEt, obsRate: 0 }],
    coverage,
    ...(coverage.kind === 'sensor' ? { sensor: coverage.sensor } : {}),
    archive: rec.archive,
    ...(rec.instrument ? { instrument: rec.instrument } : {}),
    ...(rec.campaign ? { campaign: rec.campaign } : {}),
    ...(rec.illumination ? { illumination: { ...rec.illumination } } : {}),
    ...(rec.resolutionKm !== undefined ? { resolutionKm: rec.resolutionKm } : {}),
  };
}

/**
 * Group observations by their opaque `campaign` key, in time order, as
 * `[start, end]` spans. Fully general — the key is never decoded — and it
 * degrades to one span per observation when there is no key.
 */
export function campaignSpans(
  observations: readonly Observation[],
): { campaign: string; startEt: number; endEt: number; observations: Observation[] }[] {
  const byKey = new Map<string, { campaign: string; startEt: number; endEt: number; observations: Observation[] }>();
  for (const o of observations) {
    const key = o.campaign ?? o.name;
    const start = Math.min(...o.groups.map((g) => g.startEt));
    const end = Math.max(...o.groups.map((g) => g.endEt));
    const span = byKey.get(key);
    if (span) {
      span.startEt = Math.min(span.startEt, start);
      span.endEt = Math.max(span.endEt, end);
      span.observations.push(o);
    } else {
      byKey.set(key, { campaign: key, startEt: start, endEt: end, observations: [o] });
    }
  }
  return [...byKey.values()].sort((a, b) => a.startEt - b.startEt);
}
