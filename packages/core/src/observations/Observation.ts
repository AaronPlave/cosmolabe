/**
 * The observation model (issue #28, Phase 2).
 *
 *   observation = { time windows, instrument, target, coverage, illumination }
 *
 * One shape for four things that are the same thing: a Cosmographia
 * `"Observations"` geometry, a sensor's ROADMAP `active: [{start, end}]`
 * window, an archived product from a planetary archive, and (later) an Aerie
 * simulation result. Nothing here is mission-specific, and nothing should
 * become so: a source that needs its own schema means this type is wrong.
 *
 * Cosmographia's schema is the native form (User's Guide v8 §4), and its
 * fields are kept under their own names. Two of them are easy to misread:
 *
 *  - `fillInObservations` is **filled vs outlined**. It is not accumulation.
 *  - Accumulation is `obsRate`, per group: seconds between drawn footprints,
 *    with `0` meaning a continuous swath sampled `alongTrackDivisions` times.
 *
 * What a source supplies differs only in `coverage`: a sensor whose footprint
 * is *computed* (Cosmographia, ROADMAP, Aerie), a footprint polygon that is
 * *given* (ODE), or disk geometry that is given (OPUS).
 */

import { etFromCalendarString } from '../time.js';
import type { DataProvenance } from '../plugins/PluginData.js';

/**
 * `[longitude east, latitude]`, planetocentric degrees, optionally with a
 * third element: the point's height in km above the observation's
 * `heightDatum`. A ring is all 2D (draped by the renderer) or all 3D (placed
 * exactly where its producer computed it).
 */
export type LonLat = readonly [lon: number, lat: number, heightKm?: number];

/** One observation window. Times are ET seconds past J2000 TDB. */
export interface ObservationGroup {
  readonly startEt: number;
  readonly endEt: number;
  /** Seconds between drawn footprints; `0` draws a continuous swath. */
  readonly obsRate: number;
}

/** How the observed area is known. */
export type ObservationCoverage =
  /** Computed: the named sensor body's FOV intersected with the target. */
  | { readonly kind: 'sensor'; readonly sensor: string }
  /** Given: footprint polygons, lon east / lat degrees. `polygonLonLat[i]` is
   *  polygon i's exterior ring and `holesLonLat?.[i]` its interior rings —
   *  areas inside the outline the product does not cover. When there are as
   *  many groups as polygons, polygon i is the one taken in group i (one
   *  exposure each, e.g. a simulated survey's images). */
  | {
      readonly kind: 'footprint';
      readonly polygonLonLat: readonly (readonly LonLat[])[];
      readonly holesLonLat?: readonly (readonly (readonly LonLat[])[])[];
    }
  /** Given: the archive's disk geometry for the target. */
  | {
      readonly kind: 'disk';
      /** Sub-observer `[latitude, longitude east]`, planetocentric degrees. */
      readonly subObsLatLon: readonly [number, number];
      readonly distanceKm: number;
      /** Boresight J2000 `[RA, Dec]`, degrees. */
      readonly boresightRaDec?: readonly [number, number];
    };

export interface ObservationIllumination {
  readonly phaseDeg?: number;
  readonly incidenceDeg?: number;
  readonly emissionDeg?: number;
}

export interface Observation {
  /** Display name: the catalog item, or the archive's product ID. */
  readonly name: string;
  /** The observed body. Footprints are pinned to its body-fixed frame. */
  readonly target: string;
  readonly groups: readonly ObservationGroup[];
  readonly coverage: ObservationCoverage;

  // ── Cosmographia display fields, verbatim ──
  /** Sensor body name (Cosmographia's `sensor`); set iff `coverage.kind === 'sensor'`. */
  readonly sensor?: string;
  /** Linear RGB, 0–1. */
  readonly footprintColor?: readonly [number, number, number];
  readonly footprintOpacity?: number;
  readonly showResWithColor?: boolean;
  /** Samples across a group when `obsRate` is 0. */
  readonly alongTrackDivisions?: number;
  /** FOV boundary points per side of the field of view. */
  readonly sideDivisions?: number;
  readonly shadowVolumeScaleFactor?: number;
  /** Filled footprints when true, outlines when false. */
  readonly fillInObservations?: boolean;

  // ── Given by an archive ──
  readonly instrument?: string;
  readonly illumination?: ObservationIllumination;
  /** Ground resolution, km per pixel. `showResWithColor` is its consumer. */
  readonly resolutionKm?: number;
  /** Opaque grouping key from the archive (OPUS `CASSINIobsname`, an ODE
   *  orbit number). Grouped by, never decoded, here. */
  readonly campaign?: string;
  /** Which archive, when it came from one. */
  readonly archive?: string;
  // ── Given by a host (a mission simulation) — cosmolabe extensions ──
  /** The vehicle carrying the instrument, when the host names it. */
  readonly observer?: string;
  /** Where the observation came from (e.g. a simulation dataset), for display. */
  readonly provenance?: DataProvenance;
  /**
   * The area the observation was asked to cover — what its coverage is
   * evaluated against, never something it acquired. Drawn apart from the
   * footprints (outlined), with an optional host-written `label`.
   */
  readonly requestedRegion?: { readonly name?: string; readonly label?: string; readonly polygonLonLat: readonly LonLat[] };
  /**
   * What a vertex's third element (`[lon, lat, heightKm]`) is measured from.
   * Required when any vertex has one: a producer that already knows where its
   * footprint lies on the terrain (a simulation's own terrain model) supplies
   * it, and the renderer then places it exactly — independent of which
   * terrain LOD happens to be streamed for the camera.
   */
  readonly heightDatum?: { readonly kind: 'sphere'; readonly radiusKm: number };

  /** sincpt/ilumin shape method for computed coverage (cosmolabe extension):
   *  `ELLIPSOID`, or `DSK/UNPRIORITIZED` for an irregular body. Usually left
   *  unset and resolved from the target (`resolveSurfaceMethod`). */
  readonly surfaceMethod?: string;
}

export class ObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObservationError';
  }
}

/** Reads a catalog time value to ET. `CatalogLoader.parseEpochValue`, or
 *  `spice.str2et`, both fit. */
export type ParseTime = (value: string | number) => number;

/**
 * The `ParseTime` a catalog's own epochs get: strings through `str2et` when an
 * engine is loaded (falling back to the SPICE-free calendar reader), numbers as
 * ET seconds or Julian Date by magnitude — `CatalogLoader.parseEpochValue`'s
 * rules, so an observation window reads the same as the item around it.
 */
export function catalogTimeParser(str2et?: (s: string) => number): ParseTime {
  return (v) => {
    if (typeof v === 'number') return Math.abs(v) >= 5e7 ? v : (v - 2451545.0) * 86400;
    if (str2et) {
      try {
        return str2et(v);
      } catch { /* fall through to the calendar reader */ }
    }
    return etFromCalendarString(v);
  };
}

/** Cosmographia's `"Observations"` geometry, as a catalog carries it. */
export interface CosmographiaObservationGeometry {
  type: 'Observations';
  sensor: string;
  groups: { startTime: string | number; endTime: string | number; obsRate?: number }[];
  footprintColor?: number[];
  footprintOpacity?: number;
  showResWithColor?: boolean;
  alongTrackDivisions?: number;
  sideDivisions?: number;
  shadowVolumeScaleFactor?: number;
  fillInObservations?: boolean;
}

const OPTIONAL_NUMBERS = ['footprintOpacity', 'alongTrackDivisions', 'sideDivisions', 'shadowVolumeScaleFactor'] as const;
const OPTIONAL_BOOLEANS = ['showResWithColor', 'fillInObservations'] as const;
/** Most samples one group is ever split into. A longer or denser group is
 *  thinned to this many, evenly spaced, rather than allocated in full. */
export const MAX_GROUP_SAMPLES = 10_000;

/** Bounds on the division counts: each is a loop of CSPICE calls per frame. */
const DIVISION_RANGE = {
  alongTrackDivisions: [1, MAX_GROUP_SAMPLES - 1],
  sideDivisions: [1, 256],
} as const;

function parseGroups(
  raw: unknown,
  parseTime: ParseTime,
  where: string,
  key = 'groups',
  fields: { start: string; end: string } = { start: 'startTime', end: 'endTime' },
): ObservationGroup[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ObservationError(`${where}: \`${key}\` must be a non-empty array of {${fields.start}, ${fields.end}}`);
  }
  return raw.map((g, i) => {
    const at = `${where}: ${key}[${i}]`;
    const o = g as Record<string, unknown>;
    const read = (field: string) => {
      const v = o?.[field];
      if (typeof v !== 'string' && typeof v !== 'number') throw new ObservationError(`${at}.${field} is missing`);
      const et = parseTime(v);
      if (!Number.isFinite(et)) throw new ObservationError(`${at}.${field} ${JSON.stringify(v)} is not a readable time`);
      return et;
    };
    const startEt = read(fields.start);
    const endEt = read(fields.end);
    if (endEt < startEt) throw new ObservationError(`${at} ends before it starts`);
    const obsRate = o.obsRate ?? 0;
    if (typeof obsRate !== 'number' || !Number.isFinite(obsRate) || obsRate < 0) {
      throw new ObservationError(`${at}.obsRate must be a number of seconds ≥ 0, got ${JSON.stringify(o.obsRate)}`);
    }
    return { startEt, endEt, obsRate };
  });
}

/**
 * A Cosmographia `"Observations"` geometry → Observation. The target is the
 * observation item's `center` — the item is a body on the target, which is how
 * its footprints pin to the surface.
 *
 * One cosmolabe extension, so a *given* footprint (ODE) or disk (OPUS) renders
 * through the same item and visualizer: a `coverage` object of kind
 * `footprint` or `disk` in place of `sensor`. A file using it does not open in
 * Cosmographia, which has no such thing; `observationToCosmographia` refuses
 * to write one.
 */
export function observationFromCosmographia(
  name: string,
  target: string,
  geometry: Record<string, unknown>,
  parseTime: ParseTime,
): Observation {
  const where = `observation "${name}"`;
  if (!target) throw new ObservationError(`${where}: no target (set the item's \`center\` to the observed body)`);
  const sensor = geometry.sensor;
  const given = geometry.coverage as { kind?: unknown } | undefined;
  let coverage: ObservationCoverage;
  if (typeof sensor === 'string' && sensor) {
    coverage = { kind: 'sensor', sensor };
  } else if (given && (given.kind === 'footprint' || given.kind === 'disk')) {
    coverage = parseGivenCoverage(given as Record<string, unknown>, where);
  } else {
    throw new ObservationError(`${where}: \`sensor\` must name a Sensor body (or \`coverage\` give a footprint or disk)`);
  }
  const out: Record<string, unknown> = {
    name,
    target,
    ...(coverage.kind === 'sensor' ? { sensor: coverage.sensor } : {}),
    coverage,
    groups: parseGroups(geometry.groups, parseTime, where),
  };
  for (const k of ['campaign', 'instrument', 'archive', 'surfaceMethod', 'observer'] as const) {
    if (typeof geometry[k] === 'string') out[k] = geometry[k];
  }
  if (geometry.provenance !== undefined) {
    const p = geometry.provenance as Record<string, unknown>;
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.kind !== 'string') {
      throw new ObservationError(`${where}: provenance needs an id and a kind`);
    }
    out.provenance = { ...p };
  }
  if (geometry.requestedRegion !== undefined) {
    const r = geometry.requestedRegion as Record<string, unknown>;
    const ring = r?.polygonLonLat;
    if (!Array.isArray(ring) || ring.length < 3 || !ring.every(isLonLat)) {
      throw new ObservationError(`${where}: requestedRegion.polygonLonLat must be a ring of [lon, lat] (at least 3 vertices)`);
    }
    out.requestedRegion = {
      polygonLonLat: readRing(ring as LonLat[], `${where}: requestedRegion`),
      ...(typeof r.name === 'string' ? { name: r.name } : {}),
      ...(typeof r.label === 'string' ? { label: r.label } : {}),
    };
  }
  if (geometry.heightDatum !== undefined) {
    const d = geometry.heightDatum as Record<string, unknown>;
    if (d?.kind !== 'sphere' || typeof d.radiusKm !== 'number' || !(d.radiusKm > 0)) {
      throw new ObservationError(`${where}: heightDatum must be { kind: 'sphere', radiusKm > 0 }`);
    }
    out.heightDatum = { kind: 'sphere', radiusKm: d.radiusKm };
  }
  if (hasHeights(out) && !out.heightDatum) {
    throw new ObservationError(`${where}: vertices with heights need a heightDatum saying what they are measured from`);
  }
  const color = geometry.footprintColor;
  if (color !== undefined) {
    if (!Array.isArray(color) || color.length < 3 || !color.slice(0, 3).every((c) => typeof c === 'number')) {
      throw new ObservationError(`${where}: footprintColor must be [r, g, b]`);
    }
    out.footprintColor = [color[0], color[1], color[2]];
  }
  for (const k of OPTIONAL_NUMBERS) {
    if (geometry[k] === undefined) continue;
    const v = geometry[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ObservationError(`${where}: ${k} must be a finite number`);
    const range = DIVISION_RANGE[k as keyof typeof DIVISION_RANGE];
    if (range && !(Number.isInteger(v) && v >= range[0] && v <= range[1])) {
      throw new ObservationError(`${where}: ${k} must be a whole number from ${range[0]} to ${range[1]}, got ${v}`);
    }
    out[k] = v;
  }
  for (const k of OPTIONAL_BOOLEANS) {
    if (geometry[k] === undefined) continue;
    if (typeof geometry[k] !== 'boolean') throw new ObservationError(`${where}: ${k} must be true or false`);
    out[k] = geometry[k];
  }
  return out as unknown as Observation;
}

/** A ring's vertices, heights kept; all 2D or all 3D. */
function readRing(r: readonly LonLat[], where: string): LonLat[] {
  const withHeight = r.filter((p) => typeof p[2] === 'number' && Number.isFinite(p[2])).length;
  if (withHeight !== 0 && withHeight !== r.length) throw new ObservationError(`${where}: a ring's vertices must all have a height or none`);
  return r.map((p) => (withHeight ? [p[0], p[1], p[2]!] as const : [p[0], p[1]] as const));
}

/** Whether any given vertex (footprints, holes, requested region) carries a height. */
function hasHeights(o: Record<string, unknown>): boolean {
  const c = o.coverage as ObservationCoverage;
  const rings: (readonly LonLat[])[] = [
    ...(c.kind === 'footprint' ? [...c.polygonLonLat, ...(c.holesLonLat ?? []).flat()] : []),
    ...((o.requestedRegion as Observation['requestedRegion'])?.polygonLonLat ? [(o.requestedRegion as NonNullable<Observation['requestedRegion']>).polygonLonLat] : []),
  ];
  return rings.some((r) => r[0]?.length === 3);
}

function isLonLat(v: unknown): v is LonLat {
  return Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number';
}

function parseGivenCoverage(c: Record<string, unknown>, where: string): ObservationCoverage {
  if (c.kind === 'footprint') {
    const polys = c.polygonLonLat;
    if (!Array.isArray(polys) || !polys.every((ring) => Array.isArray(ring) && ring.length >= 3 && ring.every(isLonLat))) {
      throw new ObservationError(`${where}: coverage.polygonLonLat must be rings of [lon, lat] (at least 3 vertices each)`);
    }
    const ring = (r: LonLat[]) => readRing(r, `${where}: coverage`);
    const holes = c.holesLonLat;
    if (holes !== undefined) {
      const ok = Array.isArray(holes) && holes.length === polys.length && holes.every(
        (hs) => Array.isArray(hs) && hs.every((h) => Array.isArray(h) && h.length >= 3 && h.every(isLonLat)),
      );
      if (!ok) throw new ObservationError(`${where}: coverage.holesLonLat must give one list of [lon, lat] rings per polygon`);
    }
    return {
      kind: 'footprint',
      polygonLonLat: polys.map(ring),
      ...(holes ? { holesLonLat: (holes as LonLat[][][]).map((hs) => hs.map(ring)) } : {}),
    };
  }
  if (!isLonLat(c.subObsLatLon) || typeof c.distanceKm !== 'number') {
    throw new ObservationError(`${where}: disk coverage needs subObsLatLon [lat, lon] and distanceKm`);
  }
  return {
    kind: 'disk',
    subObsLatLon: [c.subObsLatLon[0], c.subObsLatLon[1]],
    distanceKm: c.distanceKm,
    ...(isLonLat(c.boresightRaDec) ? { boresightRaDec: [c.boresightRaDec[0], c.boresightRaDec[1]] as const } : {}),
  };
}

/**
 * A Sensor's ROADMAP `active: [{ start, end }]` window list → Observation on
 * the sensor's own target: a continuous swath, so the footprint paints only
 * inside the windows. Undefined when the sensor declares no windows.
 */
export function observationFromSensorActive(
  sensorName: string,
  sensorGeometry: Record<string, unknown>,
  parseTime: ParseTime,
): Observation | undefined {
  if (sensorGeometry.active === undefined) return undefined;
  const where = `sensor "${sensorName}"`;
  const target = sensorGeometry.target;
  if (typeof target !== 'string' || !target) throw new ObservationError(`${where}: \`active\` windows need a \`target\``);
  return {
    name: sensorName,
    target,
    sensor: sensorName,
    coverage: { kind: 'sensor', sensor: sensorName },
    groups: parseGroups(sensorGeometry.active, parseTime, where, 'active', { start: 'start', end: 'end' }),
  };
}

/**
 * Observation → Cosmographia `"Observations"` geometry, so an adapter's output
 * opens unmodified in Cosmographia. Only sensor coverage has a Cosmographia
 * form: a given footprint or disk is refused rather than dropped.
 */
export function observationToCosmographia(
  obs: Observation,
  formatTime: (et: number) => string,
): CosmographiaObservationGeometry {
  if (obs.coverage.kind !== 'sensor') {
    throw new ObservationError(
      `observation "${obs.name}": ${obs.coverage.kind} coverage has no Cosmographia form (only a sensor does)`,
    );
  }
  const g: CosmographiaObservationGeometry = {
    type: 'Observations',
    sensor: obs.coverage.sensor,
    groups: obs.groups.map((grp) => ({
      startTime: formatTime(grp.startEt),
      endTime: formatTime(grp.endEt),
      obsRate: grp.obsRate,
    })),
  };
  if (obs.footprintColor) g.footprintColor = [...obs.footprintColor];
  for (const k of OPTIONAL_NUMBERS) if (obs[k] !== undefined) g[k] = obs[k];
  for (const k of OPTIONAL_BOOLEANS) if (obs[k] !== undefined) g[k] = obs[k];
  return g;
}

/**
 * The instants at which one group's footprints are drawn, as an O(1) index
 * rather than an array: `count` samples, `at(i)` the i-th, and `reached(et)`
 * how many the clock has passed. Nothing here allocates per sample, so a
 * year-long group at `obsRate: 1` costs the same as a single frame.
 *
 *  - `obsRate > 0`: every `obsRate` seconds from the start, and the end.
 *  - `obsRate` 0 (a continuous swath): `alongTrackDivisions` equal steps.
 *  - A zero-length group: one instant.
 *
 * Past `maxSamples` the group is thinned to that many evenly spaced instants
 * and `thinned` says so, so the caller can tell the viewer.
 */
export interface GroupSampling {
  readonly count: number;
  at(i: number): number;
  /** Samples with `at(i) <= et`: indices `[0, reached(et))`. */
  reached(et: number): number;
  readonly thinned: boolean;
}

export function groupSampling(
  group: ObservationGroup,
  alongTrackDivisions = 100,
  maxSamples = MAX_GROUP_SAMPLES,
): GroupSampling {
  const { startEt, endEt, obsRate } = group;
  if (![startEt, endEt, obsRate].every(Number.isFinite) || endEt < startEt || obsRate < 0) {
    throw new ObservationError(`group [${startEt}, ${endEt}] obsRate ${obsRate} is not a finite, ordered window`);
  }
  const max = Math.max(2, Math.floor(maxSamples));
  const span = endEt - startEt;
  if (span === 0) return { count: 1, at: () => startEt, reached: (et) => (et >= startEt ? 1 : 0), thinned: false };

  // Natural sample count, computed rather than enumerated.
  let natural: number;
  if (obsRate > 0) {
    const steps = Math.floor(span / obsRate);
    natural = steps + 1 + (steps * obsRate < span ? 1 : 0);
  } else {
    const n = Number.isFinite(alongTrackDivisions) ? Math.max(1, Math.floor(alongTrackDivisions)) : 1;
    natural = n + 1;
  }

  if (obsRate > 0 && natural <= max) {
    const last = natural - 1;
    return {
      count: natural,
      at: (i) => (i >= last ? endEt : startEt + i * obsRate),
      reached: (et) => (et < startEt ? 0 : et >= endEt ? natural : Math.min(last, Math.floor((et - startEt) / obsRate) + 1)),
      thinned: false,
    };
  }
  const count = Math.min(natural, max);
  const step = span / (count - 1);
  return {
    count,
    at: (i) => (i >= count - 1 ? endEt : startEt + i * step),
    reached: (et) => (et < startEt ? 0 : et >= endEt ? count : Math.min(count - 1, Math.floor((et - startEt) / step) + 1)),
    thinned: natural > max,
  };
}

/**
 * Every sample instant of a group, up to `until`. A convenience over
 * `groupSampling` for small groups and tests; bounded by `maxSamples`.
 */
export function observationSampleTimes(
  group: ObservationGroup,
  alongTrackDivisions = 100,
  until = Infinity,
  maxSamples = MAX_GROUP_SAMPLES,
): number[] {
  const s = groupSampling(group, alongTrackDivisions, maxSamples);
  const n = s.reached(until);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(s.at(i));
  return out;
}

/** Whether `et` falls inside any of an observation's groups. */
export function observationActiveAt(obs: Observation, et: number): boolean {
  return obs.groups.some((g) => et >= g.startEt && et <= g.endEt);
}
