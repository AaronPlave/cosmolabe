/**
 * Navigation to a body-fixed geographic location (#190): a latitude/longitude
 * (or a picked surface point) resolved against the body's declared physical
 * reference shape, and the camera placements that look at it.
 *
 * The target is the place on the body, not the camera. Placements come out
 * as semantic viewpoints (#114) in the body's `BodyFixed` frame, so they
 * re-resolve as the body turns and can be serialized like any other view.
 *
 * Nothing here reads a renderer's display radius: a body with no declared
 * radii or terrain datum has no geographic reference, and says so.
 */
import type { SurfaceDatum, SurfacePointAnchor } from '../geometry/surface-point.js';
import type { ViewpointDefinition } from '../viewpoint.js';
import type { Vec3 } from '../spice-injection.js';
import { geodeticToBodyFixed, isSupportedGeodeticDatum, wrapLon, type TerrainDatum } from './coordinates.js';

export type LatitudeConvention = 'planetocentric' | 'planetographic';
export type LongitudeDirection = 'east' | 'west';

/** Coordinates as the person entered them, in the convention they chose. */
export interface GeographicCoordinateInput {
  bodyName: string;
  /** Degrees, positive north, in `latitude`'s convention. */
  latDeg: number;
  /** Degrees, positive in `longitudeDirection`. Any of -360..360; wraps. */
  lonDeg: number;
  latitude: LatitudeConvention;
  longitudeDirection: LongitudeDirection;
}

/**
 * The physical surface coordinates are resolved against: the body's terrain
 * datum when it streams terrain, otherwise its declared radii. A triaxial
 * shape supports planetocentric coordinates only.
 */
export interface NavigationReference {
  bodyName: string;
  datum: SurfaceDatum;
  shape: 'sphere' | 'oblate' | 'triaxial';
}

export type NavigationReferenceResult =
  | { ok: true; reference: NavigationReference }
  | { ok: false; reason: string };

/** What the body exposes about its shape; plain data, so no renderer is needed. */
export interface NavigationBodyShape {
  name: string;
  /** Declared [a, b, c] radii in km (body-fixed X, Y, Z). */
  radii?: readonly [number, number, number] | readonly number[];
  /** Catalog geometry type ('Globe', 'Ellipsoid', 'Mesh', …). */
  geometryType?: string;
  /** The datum of the body's streamed terrain product, when it has one. */
  terrainDatum?: TerrainDatum | null;
  /** True for an irregular shape model (DSK) — no universal lat/lon surface. */
  irregular?: boolean;
}

/**
 * The reference a body's coordinates resolve against, or why there is none.
 * Capability-gated on purpose: an irregular body or one without declared
 * radii gets a reason, never an invented sphere.
 */
export function navigationReference(body: NavigationBodyShape): NavigationReferenceResult {
  if (body.irregular) {
    return { ok: false, reason: `${body.name} is an irregular shape model; latitude/longitude navigation needs a reference sphere or ellipsoid` };
  }
  if (body.geometryType !== undefined && body.geometryType !== 'Globe' && body.geometryType !== 'Ellipsoid') {
    return { ok: false, reason: `${body.name} has no globe to place coordinates on` };
  }
  const terrain = body.terrainDatum;
  if (terrain && isSupportedGeodeticDatum(terrain)) {
    const shape = terrain.referenceShape.kind === 'sphere' ? 'sphere' : 'oblate';
    return { ok: true, reference: { bodyName: body.name, shape, datum: { ...terrain, origin: 'terrain' } } };
  }
  const r = body.radii;
  if (!r || r.length !== 3 || !r.every((v) => Number.isFinite(v) && v > 0)) {
    return { ok: false, reason: `${body.name} declares no physical radii, so its coordinates have no reference surface` };
  }
  const [a, b, c] = r;
  if (a === b && b === c) {
    return {
      ok: true,
      reference: {
        bodyName: body.name, shape: 'sphere',
        datum: { referenceShape: { kind: 'sphere', radiusKm: a }, verticalDatum: 'reference-sphere', heightConvention: 'radial', origin: 'body-shape' },
      },
    };
  }
  return {
    ok: true,
    reference: {
      bodyName: body.name, shape: a === b ? 'oblate' : 'triaxial',
      datum: { referenceShape: { kind: 'ellipsoid', radiiKm: [a, b, c] }, verticalDatum: 'ellipsoid', heightConvention: a === b ? 'geodetic-normal' : 'radial', origin: 'body-shape' },
    },
  };
}

/** Where a navigation target sits on its body, and the local frame there. */
export interface SurfaceNavigationTarget {
  bodyName: string;
  /** Body-fixed, Z-up km. */
  positionKm: Vec3;
  /** Outward unit normal of the reference (or picked) surface there. */
  up: Vec3;
  /** Unit local east and north, tangent to `up`. Defined at the poles too. */
  east: Vec3;
  north: Vec3;
  /** East-positive longitude, (-180, 180]. */
  lonEastDeg: number;
  /** Planetographic (geodetic) latitude, the normal's elevation. */
  latGraphicDeg: number;
  /** Planetocentric latitude, the position's elevation. */
  latCentricDeg: number;
  /** Where the height of `positionKm` comes from. */
  height: {
    from: 'reference-surface' | 'terrain-sample' | 'surface-point';
    /** Above the datum, km; null where the datum defines none (DSK). */
    km: number | null;
    sourceId?: string;
    tileId?: string;
  };
  /**
   * The target's point on the datum, for a coordinate target: its geographic
   * anchor, which terrain heights are measured from.
   */
  referencePositionKm?: Vec3;
  /**
   * On a terrain body whose product had no decoded coverage here yet: the
   * target is provisionally on the datum, and `refineWithTerrain` moves it
   * onto the terrain once a sample arrives.
   */
  awaitingTerrain?: boolean;
  datum: SurfaceDatum | null;
  /** How the target was named. */
  origin:
    | { kind: 'coordinates'; input: GeographicCoordinateInput }
    /** The pick's own coordinates, in its own latitude convention. */
    | { kind: 'surface-point'; source: SurfacePointAnchor['source']; latDeg: number; lonDeg: number; latitudeKind: SurfacePointAnchor['latitudeKind'] };
  /** Mean radius of the reference, km — the scale placements are sized by. */
  scaleKm: number;
  /** Caveats to show next to the target (pole, fallback surface). */
  notes: string[];
}

export class GeographicNavigationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeographicNavigationError';
  }
}

const DEG = Math.PI / 180;
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scale(a, 1 / len(a));

function radiiOf(datum: SurfaceDatum): Vec3 {
  const s = datum.referenceShape;
  return s.kind === 'sphere' ? [s.radiusKm, s.radiusKm, s.radiusKm] : [s.radiiKm[0], s.radiiKm[1], s.radiiKm[2]];
}

/** Outward normal of the ellipsoid through `p` (scaled to it). */
function ellipsoidNormal(p: Vec3, radii: Vec3): Vec3 {
  return unit([p[0] / radii[0] ** 2, p[1] / radii[1] ** 2, p[2] / radii[2] ** 2]);
}

/**
 * East and north at a point with outward normal `up`. At a pole east is
 * undefined from the normal alone; the longitude then names the meridian,
 * which is what an entered polar coordinate means for the view heading.
 */
function tangentFrame(up: Vec3, lonEastDeg: number): { east: Vec3; north: Vec3 } {
  let east = cross([0, 0, 1], up);
  if (len(east) < 1e-9) {
    const lon = lonEastDeg * DEG;
    east = [-Math.sin(lon), Math.cos(lon), 0];
  }
  east = unit(east);
  return { east, north: unit(cross(up, east)) };
}

function latitudes(position: Vec3, up: Vec3) {
  return {
    latCentricDeg: Math.atan2(position[2], Math.hypot(position[0], position[1])) / DEG,
    latGraphicDeg: Math.asin(Math.max(-1, Math.min(1, up[2]))) / DEG,
  };
}

const canonicalLon = (lon: number) => {
  const w = wrapLon(lon);
  return w === -180 ? 180 : w;
};

/** Range checks shared by the dialog and the script/port boundary. */
export function validateGeographicInput(input: GeographicCoordinateInput): string | null {
  if (!Number.isFinite(input.latDeg)) return 'Latitude must be a number';
  if (!Number.isFinite(input.lonDeg)) return 'Longitude must be a number';
  if (input.latDeg < -90 || input.latDeg > 90) return 'Latitude must be between 90° S and 90° N';
  if (input.lonDeg < -360 || input.lonDeg > 360) return 'Longitude must be between -360° and 360°';
  if (input.latitude !== 'planetocentric' && input.latitude !== 'planetographic') return 'Unknown latitude convention';
  if (input.longitudeDirection !== 'east' && input.longitudeDirection !== 'west') return 'Unknown longitude direction';
  return null;
}

/**
 * Resolve entered coordinates on the reference surface. Throws
 * `GeographicNavigationError` for malformed input or a convention the shape
 * cannot honour (planetographic on a triaxial body), rather than guessing.
 */
export function resolveGeographicTarget(input: GeographicCoordinateInput, reference: NavigationReference): SurfaceNavigationTarget {
  const problem = validateGeographicInput(input);
  if (problem) throw new GeographicNavigationError(problem);
  if (input.bodyName !== reference.bodyName) {
    throw new GeographicNavigationError(`The reference surface is ${reference.bodyName}'s, not ${input.bodyName}'s`);
  }
  if (reference.shape === 'triaxial' && input.latitude === 'planetographic') {
    throw new GeographicNavigationError(`${input.bodyName} is triaxial; use planetocentric latitude`);
  }
  const lonEastDeg = canonicalLon(input.longitudeDirection === 'east' ? input.lonDeg : -input.lonDeg);
  const radii = radiiOf(reference.datum);
  const lat = input.latDeg * DEG, lon = lonEastDeg * DEG;
  let position: Vec3;
  if (input.latitude === 'planetographic' && reference.shape === 'oblate') {
    const datum: TerrainDatum = { referenceShape: reference.datum.referenceShape, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' };
    const p = geodeticToBodyFixed({ latDeg: input.latDeg, lonDeg: lonEastDeg, heightKm: 0 }, datum);
    position = [p.xKm, p.yKm, p.zKm];
  } else {
    // Planetocentric (and either convention on a sphere): along the radial direction.
    const d: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    const r = 1 / Math.sqrt((d[0] / radii[0]) ** 2 + (d[1] / radii[1]) ** 2 + (d[2] / radii[2]) ** 2);
    position = scale(d, r);
  }
  const up = reference.shape === 'sphere' ? unit(position) : ellipsoidNormal(position, radii);
  const notes: string[] = [];
  if (Math.abs(input.latDeg) === 90) notes.push('At the pole longitude only sets the view heading');
  return {
    bodyName: input.bodyName,
    positionKm: position,
    referencePositionKm: [...position],
    up,
    ...tangentFrame(up, lonEastDeg),
    lonEastDeg,
    ...latitudes(position, up),
    height: { from: 'reference-surface', km: 0 },
    datum: reference.datum,
    origin: { kind: 'coordinates', input: { ...input } },
    scaleKm: (radii[0] + radii[1] + radii[2]) / 3,
    notes,
  };
}

/**
 * Raise a coordinate target onto a terrain sample at its location. Heights
 * are along the datum normal (geodetic) or radius (sphere) — the same
 * direction for every datum `navigationReference` accepts from terrain.
 */
export function withTerrainElevation(target: SurfaceNavigationTarget, elevationKm: number, sourceId: string, tileId?: string): SurfaceNavigationTarget {
  if (!Number.isFinite(elevationKm)) return target;
  if (target.datum?.origin !== 'terrain') return target;
  // From the datum point, so a re-sample replaces the height, never adds to it.
  const base = target.referencePositionKm ?? target.positionKm;
  const along = target.datum.heightConvention === 'radial' ? unit(base) : target.up;
  const positionKm = add(base, scale(along, elevationKm));
  return {
    ...target, positionKm, referencePositionKm: base, ...latitudes(positionKm, target.up),
    height: { from: 'terrain-sample', km: elevationKm, sourceId, ...(tileId ? { tileId } : {}) },
    awaitingTerrain: false,
    notes: target.notes.filter((n) => n !== TERRAIN_PENDING_NOTE),
  };
}

const TERRAIN_PENDING_NOTE = 'Terrain is not loaded here yet: the target is on the reference surface until it is';

/** A terrain body whose product has no decoded coverage at the target yet. */
export function withoutTerrainCoverage(target: SurfaceNavigationTarget): SurfaceNavigationTarget {
  return { ...target, awaitingTerrain: true, notes: [...target.notes, TERRAIN_PENDING_NOTE] };
}

/** What `refineWithTerrain` needs from a terrain sample. */
export interface TerrainSampleRef {
  elevationKm: number;
  sourceId: string;
  /** The decoded tile that answered; a finer one replaces a coarse parent. */
  tileId?: string;
}

/**
 * Elevation change below which a re-sample leaves a target where it is, km:
 * half a metre, under a person's eye height and the 2 m camera clearance,
 * so streaming tiles of the same terrain do not jitter the pivot.
 */
export const TERRAIN_REFINE_MIN_KM = 0.0005;

/**
 * Keep a coordinate target on the terrain as it streams in. The target's
 * anchor is geographic — its point on the datum — and each sample places it
 * that far along the datum's height direction: the first sample after a
 * cold cache, and every later one from a finer tile that moves the ground by
 * at least `minChangeKm`. Returns the refined target and the body-fixed
 * shift (km) to apply to what the old one placed (the pivot and, so the view
 * keeps its framing, the camera); null when there is nothing to move.
 *
 * Only a coordinate target on a terrain datum refines. A picked point is the
 * surface that was hit, and stays as picked.
 */
export function refineWithTerrain(
  target: SurfaceNavigationTarget, sample: TerrainSampleRef, opts: { minChangeKm?: number } = {},
): { target: SurfaceNavigationTarget; shiftKm: Vec3 } | null {
  if (target.origin.kind !== 'coordinates' || target.datum?.origin !== 'terrain') return null;
  if (!Number.isFinite(sample.elevationKm)) return null;
  if (!target.awaitingTerrain) {
    const current = target.height.from === 'terrain-sample' ? target.height.km : null;
    if (current !== null && Math.abs(sample.elevationKm - current) < (opts.minChangeKm ?? TERRAIN_REFINE_MIN_KM)) return null;
  }
  const refined = withTerrainElevation(target, sample.elevationKm, sample.sourceId, sample.tileId);
  return { target: refined, shiftKm: sub(refined.positionKm, target.positionKm) };
}

/**
 * A picked surface point as a navigation target, at exactly the position
 * that was picked (#127/#148): its own source and datum, its rendered normal
 * when it has one that faces outward, the datum's otherwise.
 */
export function surfacePointTarget(
  point: SurfacePointAnchor & { surfaceNormal?: readonly [number, number, number] },
): SurfaceNavigationTarget {
  const p: Vec3 = [point.bodyFixedPositionKm[0], point.bodyFixedPositionKm[1], point.bodyFixedPositionKm[2]];
  if (!p.every(Number.isFinite) || len(p) === 0) throw new GeographicNavigationError('The surface point has no position');
  const radial = unit(p);
  const datum = point.hit.datum;
  let up = radial;
  if (datum && datum.referenceShape.kind === 'ellipsoid') up = ellipsoidNormal(p, radiiOf(datum));
  const n = point.surfaceNormal;
  // A face normal tilted past ~60° from vertical is a crater wall or a skirt;
  // looking along it would put the camera sideways to the place.
  if (n && n.every(Number.isFinite) && len([...n] as Vec3) > 0 && dot(unit([...n] as Vec3), radial) > 0.5) {
    up = unit([...n] as Vec3);
  }
  const lonEastDeg = canonicalLon(point.lonDeg);
  const sample = point.terrainSample?.describesHit ? point.terrainSample : undefined;
  const r = datum ? radiiOf(datum) : [len(p), len(p), len(p)];
  return {
    bodyName: point.bodyName,
    positionKm: p,
    up,
    ...tangentFrame(up, lonEastDeg),
    lonEastDeg,
    ...latitudes(p, up),
    height: { from: 'surface-point', km: sample ? sample.elevationKm : point.hit.heightKm, ...(sample ? { sourceId: sample.sourceId } : {}) },
    datum,
    origin: { kind: 'surface-point', source: point.source, latDeg: point.latDeg, lonDeg: point.lonDeg, latitudeKind: point.latitudeKind },
    scaleKm: (r[0] + r[1] + r[2]) / 3,
    notes: [],
  };
}

// ── Placements ──────────────────────────────────────────────────────────────

export type SurfaceViewPreset = 'overhead' | 'oblique' | 'surface';
export const SURFACE_VIEW_PRESETS: readonly SurfaceViewPreset[] = ['overhead', 'oblique', 'surface'];

export interface SurfaceViewOptions {
  /**
   * Overhead: altitude above the target. Oblique: slant range to it.
   * Surface: eye height above it. Km; defaults scale with the body.
   */
  rangeKm?: number;
  /**
   * Ground radius (km from the body centre) along the direction of a
   * body-fixed point, when terrain is known there. The eye is lifted to stay
   * `clearanceKm` above it, so a surface view does not start inside a hill.
   */
  groundRadiusAt?: (positionKm: Vec3) => number | null;
  clearanceKm?: number;
  /** Viewpoint name; defaults to the coordinates. */
  name?: string;
}

/** A placement, body-fixed, as `ViewpointDefinition` carries it. */
export interface SurfaceViewPlacement {
  preset: SurfaceViewPreset;
  eyeKm: Vec3;
  targetKm: Vec3;
  upKm: Vec3;
  /** Distance from eye to target, km. */
  rangeKm: number;
  /** Km the eye was raised to clear known terrain; 0 when it was not. */
  liftedKm: number;
  viewpoint: ViewpointDefinition;
}

const OBLIQUE_TILT_DEG = 50;
const SURFACE_LOOK_DOWN_DEG = 8;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Default range for a preset, sized by the body. */
export function defaultSurfaceRangeKm(preset: SurfaceViewPreset, scaleKm: number): number {
  switch (preset) {
    case 'overhead': return clamp(0.3 * scaleKm, 1, 20000);
    case 'oblique': return clamp(0.08 * scaleKm, 0.5, 5000);
    // Eye height: a person's, 2 m, on anything big enough to stand on;
    // proportionally less on a body only a few km across.
    case 'surface': return clamp(1e-4 * scaleKm, 1e-4, 0.002);
  }
}

/**
 * The range "Frame here" and "Fly to here" put the camera at from a point
 * (#190): a point has no extent to fit, so this is a local view of the
 * ground around it, a hundredth of the body's radius (64 km on Earth, 34 km
 * on Mars, 17 km on the Moon and Europa), between 0.5 km and 500 km. Fixed
 * for a body rather than taken from the camera's distance, so framing the
 * same point twice lands in the same place; "Zoom to here" is the
 * incremental verb.
 */
export function pointFrameRangeKm(scaleKm: number): number {
  return clamp(0.01 * scaleKm, 0.5, 500);
}

/** Short "18.4400° N, 77.4500° E" label for a target. */
export function describeNavigationTarget(target: SurfaceNavigationTarget, decimals: number | { lat: number; lon: number } = 4): string {
  const { origin } = target;
  const input = origin.kind === 'coordinates' ? origin.input : null;
  const latDecimals = typeof decimals === 'number' ? decimals : decimals.lat;
  const lonDecimals = typeof decimals === 'number' ? decimals : decimals.lon;
  const lat = input ? input.latDeg : origin.kind === 'surface-point' ? origin.latDeg : target.latGraphicDeg;
  const lonEast = origin.kind === 'surface-point' ? origin.lonDeg : target.lonEastDeg;
  const lonText = input
    ? `${Math.abs(input.lonDeg).toFixed(lonDecimals)}° ${input.longitudeDirection === 'east' ? (input.lonDeg >= 0 ? 'E' : 'W') : (input.lonDeg >= 0 ? 'W' : 'E')}`
    : `${Math.abs(lonEast).toFixed(lonDecimals)}° ${lonEast >= 0 ? 'E' : 'W'}`;
  return `${Math.abs(lat).toFixed(latDecimals)}° ${lat >= 0 ? 'N' : 'S'}, ${lonText}`;
}

/**
 * Where the camera goes for `preset`, as a semantic viewpoint centred on the
 * target's body in its `BodyFixed` frame:
 *
 * - `overhead`: straight down the surface normal, north up.
 * - `oblique`: 50° off vertical, from the south, looking north at the target.
 * - `surface`: just above the ground, south of the target, looking north and
 *   slightly down at it, horizon level.
 */
export function surfaceViewPlacement(
  target: SurfaceNavigationTarget, preset: SurfaceViewPreset, opts: SurfaceViewOptions = {},
): SurfaceViewPlacement {
  const range = opts.rangeKm ?? defaultSurfaceRangeKm(preset, target.scaleKm);
  if (!(Number.isFinite(range) && range > 0)) throw new GeographicNavigationError('Range must be a positive distance');
  const { up, north } = target;
  const p = target.positionKm;
  let eye: Vec3;
  let viewUp: Vec3;
  if (preset === 'overhead') {
    eye = add(p, scale(up, range));
    viewUp = north;
  } else if (preset === 'oblique') {
    const t = OBLIQUE_TILT_DEG * DEG;
    eye = add(p, add(scale(up, range * Math.cos(t)), scale(north, -range * Math.sin(t))));
    viewUp = up;
  } else {
    const back = range / Math.tan(SURFACE_LOOK_DOWN_DEG * DEG);
    eye = add(p, add(scale(up, range), scale(north, -back)));
    viewUp = up;
  }
  // Known terrain under the eye: never start below it.
  let lifted = 0;
  const ground = opts.groundRadiusAt?.(eye);
  if (ground != null && Number.isFinite(ground)) {
    const clearance = opts.clearanceKm ?? Math.min(range * 0.5, 0.05);
    const need = ground + clearance - len(eye);
    if (need > 0) {
      eye = add(eye, scale(unit(eye), need));
      lifted = need;
    }
  }
  const name = opts.name ?? `${target.bodyName} ${describeNavigationTarget(target)}`;
  return {
    preset,
    eyeKm: eye,
    targetKm: [...p],
    upKm: viewUp,
    rangeKm: len(sub(eye, p)),
    liftedKm: lifted,
    viewpoint: { name, center: target.bodyName, frame: 'BodyFixed', eye: [...eye], target: [...p], up: [...viewUp] },
  };
}

// ── Text entry ──────────────────────────────────────────────────────────────

export type AngleParse = { ok: true; deg: number } | { ok: false; error: string };

/**
 * Parse a latitude: "18.44", "-18.44", "18.44 N", "18.44°S". A hemisphere
 * letter takes an unsigned value.
 */
export function parseLatitudeText(text: string): AngleParse {
  return parseAngle(text, 'N', 'S', 'Latitude', 90);
}

/**
 * Parse a longitude into `direction`'s sign convention: "77.45" is taken in
 * that convention; "77.45 E" / "77.45 W" name an absolute direction and are
 * converted to it.
 */
export function parseLongitudeText(text: string, direction: LongitudeDirection): AngleParse {
  const parsed = parseAngle(text, 'E', 'W', 'Longitude', 360);
  if (!parsed.ok) return parsed;
  const letter = hemisphereLetter(text, 'E', 'W');
  if (!letter) return parsed;
  // `parseAngle` already signed it east-positive.
  return { ok: true, deg: direction === 'east' ? parsed.deg : -parsed.deg };
}

function hemisphereLetter(text: string, pos: string, neg: string): string | null {
  const m = /([A-Za-z])\s*$/.exec(text.trim());
  if (!m) return null;
  const l = m[1].toUpperCase();
  return l === pos || l === neg ? l : null;
}

function parseAngle(text: string, pos: string, neg: string, what: string, limit: number): AngleParse {
  const t = text.trim();
  if (!t) return { ok: false, error: `${what} is required` };
  const m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*°?\s*([A-Za-z])?$/.exec(t);
  if (!m) return { ok: false, error: `${what}: enter decimal degrees, e.g. 18.4 or 18.4 ${pos}` };
  let deg = Number(m[1]);
  const letter = m[2]?.toUpperCase();
  if (letter) {
    if (letter !== pos && letter !== neg) return { ok: false, error: `${what}: use ${pos} or ${neg}` };
    if (/^[+-]/.test(m[1])) return { ok: false, error: `${what}: give a sign or ${pos}/${neg}, not both` };
    if (letter === neg) deg = -deg;
  }
  if (Math.abs(deg) > limit) return { ok: false, error: `${what} must be within ±${limit}°` };
  return { ok: true, deg };
}

/** Which number of a pasted pair is which. Never guessed from the values. */
export type CoordinateOrder = 'lat-lon' | 'lon-lat';

export type CoordinatePairParse =
  | { ok: true; latDeg: number; lonDeg: number; order: CoordinateOrder; byLetters: boolean }
  | { ok: false; error: string };

const PAIR_TOKEN = /([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*°?\s*([NSEWnsew](?![A-Za-z]))?/g;

/**
 * Parse a pasted latitude/longitude pair: "18.4447, 77.4508",
 * "18.4447° N, 77.4508° E", "18.4447N 77.4508E", "(-18.4; 282.55)".
 *
 * N/S and E/W letters name each number's axis, so a lettered pair reads the
 * same in either order. An unlettered pair is read in `order` — latitude
 * first by default, as maps and papers write it; GeoJSON and GIS tools write
 * longitude first, and that has to be chosen, because two numbers that both
 * fit ±90° say nothing about which is which. Longitude is returned in
 * `direction`'s sign convention (an E/W letter is absolute), latitude
 * north-positive, both range-checked as `parseLatitudeText`/
 * `parseLongitudeText` do.
 */
export function parseCoordinatePair(text: string, opts: { order?: CoordinateOrder; direction?: LongitudeDirection } = {}): CoordinatePairParse {
  const order = opts.order ?? 'lat-lon';
  const direction = opts.direction ?? 'east';
  const t = text.trim().replace(/^[([{]\s*|\s*[)\]}]$/g, '');
  if (!t) return { ok: false, error: 'Enter a latitude and longitude' };
  const tokens: { text: string; letter?: string }[] = [];
  let rest = t;
  for (const m of t.matchAll(PAIR_TOKEN)) {
    tokens.push({ text: m[0].trim(), letter: m[2]?.toUpperCase() });
    rest = rest.replace(m[0], ' ');
  }
  if (/[^\s,;]/.test(rest)) {
    return { ok: false, error: /['′"″]/.test(t)
      ? 'Degrees-minutes-seconds are not read yet: enter decimal degrees, e.g. 18.4447, 77.4508'
      : 'Enter two decimal-degree numbers, e.g. 18.4447, 77.4508' };
  }
  if (tokens.length !== 2) return { ok: false, error: `Expected a latitude and a longitude, found ${tokens.length} number${tokens.length === 1 ? '' : 's'}` };
  const axis = (letter?: string) => letter === 'N' || letter === 'S' ? 'lat' : letter === 'E' || letter === 'W' ? 'lon' : null;
  const [a, b] = tokens;
  const axA = axis(a.letter), axB = axis(b.letter);
  let lat: string, lon: string, byLetters = false;
  if (axA && axB) {
    if (axA === axB) return { ok: false, error: `Both numbers are marked as ${axA === 'lat' ? 'latitude (N/S)' : 'longitude (E/W)'}` };
    [lat, lon] = axA === 'lat' ? [a.text, b.text] : [b.text, a.text];
    byLetters = true;
  } else if (axA || axB) {
    // One letter places that number; the other is the remaining axis.
    const known = axA ? a : b, other = axA ? b : a;
    [lat, lon] = axis(known.letter) === 'lat' ? [known.text, other.text] : [other.text, known.text];
    byLetters = true;
  } else {
    [lat, lon] = order === 'lat-lon' ? [a.text, b.text] : [b.text, a.text];
  }
  const latP = parseLatitudeText(lat);
  if (!latP.ok) {
    const hint = !byLetters && order === 'lat-lon' && Math.abs(Number(a.text)) > 90 && Math.abs(Number(b.text)) <= 90
      ? ' — is this longitude first? Choose Lon, Lat' : '';
    return { ok: false, error: latP.error + hint };
  }
  const lonP = parseLongitudeText(lon, direction);
  if (!lonP.ok) return lonP;
  return { ok: true, latDeg: latP.deg, lonDeg: lonP.deg, order, byLetters };
}
