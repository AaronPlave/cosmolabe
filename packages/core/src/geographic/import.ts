import { bodyFixedFrameName } from '../frames/FrameRegistry.js';
import { bodyFixedToGeodetic, geodeticToBodyFixed, wrapLon, type BodyFixedPosition, type TerrainDatum } from './coordinates.js';
import { geographicProjection, projectGeographicRings } from './projection.js';
import {
  GEOGRAPHIC_LIMITS, type GeographicCoordinates, type GeographicLayerDefinition,
  type GeographicSource, type GeographicLayer, type GeographicGeometry, type GeographicLimits,
  type GeoPosition, type JsonValue, type GeographicDiagnostic,
} from './model.js';

export const geographicObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
function fail(message: string): never { throw new Error(message); }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export function geographicLimits(requested: Partial<GeographicLimits> = {}): GeographicLimits {
  return Object.fromEntries(Object.entries(GEOGRAPHIC_LIMITS).map(([key, ceiling]) => {
    const value = requested[key as keyof GeographicLimits] ?? ceiling;
    if (!Number.isSafeInteger(value) || value < 1) fail(`Invalid geographic limit ${key}`);
    return [key, Math.min(ceiling, value)];
  })) as unknown as GeographicLimits;
}

/** A bounded lexical pass prevents deeply nested JSON from reaching parsing or traversal. */
export function checkGeographicText(text: string, limits = geographicLimits()): void {
  if (text.length > limits.maxBytes || new TextEncoder().encode(text).byteLength > limits.maxBytes) {
    fail(`GeoJSON exceeds ${limits.maxBytes} bytes`);
  }
  let depth = 0, quoted = false, escaped = false;
  for (const c of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '[' || c === '{') {
      if (++depth > limits.maxDepth) fail(`GeoJSON exceeds nesting depth ${limits.maxDepth}`);
    } else if (c === ']' || c === '}') depth--;
  }
}

export function validateGeographicCoordinates(value: unknown): GeographicCoordinates {
  if (!geographicObject(value)) fail('Explicit geographic coordinate conventions are required; planetary GeoJSON is not implicitly WGS84');
  const v = value as Record<string, unknown>;
  if (!['planetocentric', 'planetographic'].includes(String(v.latitude))
    || !['east', 'west'].includes(String(v.longitudeDirection))
    || !['-180..180', '0..360'].includes(String(v.longitudeDomain))) {
    fail('Unsupported latitude/longitude convention (degrees, east/west, and longitude domain must be explicit)');
  }
  const shape = v.referenceShape;
  if (!geographicObject(shape)) fail('A physical horizontal referenceShape in km is required');
  if (shape.kind === 'sphere') {
    if (!finite(shape.radiusKm) || shape.radiusKm <= 0) fail('Reference sphere radiusKm must be positive and finite');
  } else if (shape.kind === 'ellipsoid') {
    const r = shape.radiiKm;
    if (!Array.isArray(r) || r.length !== 3 || !r.every(x => finite(x) && x > 0) || r[0] !== r[1] || r[2] > r[0]) {
      fail('Only spherical or oblate reference shapes are supported; triaxial/prolate coordinates need an explicit converter');
    }
  } else fail('Unsupported horizontal reference shape');
  if (v.height !== undefined) {
    const h = v.height;
    if (!geographicObject(h) || !['m', 'km'].includes(String(h.unit))
      || h.datum !== (shape.kind === 'sphere' ? 'reference-sphere' : 'ellipsoid')
      || h.convention !== (v.latitude === 'planetocentric' ? 'radial' : 'geodetic-normal')) {
      fail('Unsupported height datum/convention: use radial centric or normal graphic heights above the declared reference shape');
    }
  }
  return value as unknown as GeographicCoordinates;
}

export function validateGeographicDefinition(value: unknown, defaults?: unknown): GeographicLayerDefinition & { coordinates: GeographicCoordinates } {
  if (!geographicObject(value) || !nonempty(value.id) || !nonempty(value.name)
    || !nonempty(value.body) || !nonempty(value.source)) fail('Geographic layer requires nonempty id, name, body, source');
  const v = value as Record<string, unknown>;
  if (v.display !== undefined) {
    const d = v.display;
    if (!geographicObject(d) || (d.visible !== undefined && typeof d.visible !== 'boolean')
      || (d.color !== undefined && typeof d.color !== 'string')
      || (d.opacity !== undefined && (!finite(d.opacity) || d.opacity < 0 || d.opacity > 1))) fail('Invalid geographic display defaults');
  }
  if (v.provenance !== undefined && !geographicObject(v.provenance)) fail('Geographic provenance must be an object');
  return { ...value as unknown as GeographicLayerDefinition, coordinates: validateGeographicCoordinates(v.coordinates ?? defaults) };
}

export function geographicDatum(c: GeographicCoordinates): TerrainDatum {
  return {
    referenceShape: c.referenceShape,
    verticalDatum: c.referenceShape.kind === 'sphere' ? 'reference-sphere' : 'ellipsoid',
    heightConvention: c.referenceShape.kind === 'sphere' ? 'radial' : 'geodetic-normal',
  };
}

/** Convert original coordinates once. Missing Z stays missing, including after centric→graphic conversion. */
export function normalizeGeographicPosition(p: GeoPosition, c: GeographicCoordinates): BodyFixedPosition {
  const lonDeg = wrapLon(p[0] * (c.longitudeDirection === 'east' ? 1 : -1));
  const heightKm = p.length === 3 ? p[2] * (c.height!.unit === 'm' ? 0.001 : 1) : undefined;
  if (c.latitude === 'planetographic' || c.referenceShape.kind === 'sphere') {
    return heightKm === undefined ? { latDeg: p[1], lonDeg } : { latDeg: p[1], lonDeg, heightKm };
  }
  const [a,, b] = c.referenceShape.radiiKm;
  const lat = p[1] * Math.PI / 180, lon = lonDeg * Math.PI / 180;
  const r = a * b / Math.hypot(b * Math.cos(lat), a * Math.sin(lat)) + (heightKm ?? 0);
  const result = bodyFixedToGeodetic({ xKm: r * Math.cos(lat) * Math.cos(lon), yKm: r * Math.cos(lat) * Math.sin(lon), zKm: r * Math.sin(lat) }, geographicDatum(c));
  if (heightKm === undefined) delete result.heightKm;
  return result;
}

/** Absolute heights only. A 2D vertex needs an actual physical-surface query, never invented terrain height. */
export function geographicAbsolutePosition(position: BodyFixedPosition, datum: TerrainDatum) {
  return position.heightKm === undefined ? null : geodeticToBodyFixed(position, datum);
}

type XY = readonly [number, number];
const orient = (a: XY, b: XY, c: XY) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function intersects(a: XY, b: XY, c: XY, d: XY): boolean {
  const on = (p: XY, q: XY, r: XY) => orient(p, q, r) === 0
    && r[0] >= Math.min(p[0], q[0]) && r[0] <= Math.max(p[0], q[0])
    && r[1] >= Math.min(p[1], q[1]) && r[1] <= Math.max(p[1], q[1]);
  return (Math.sign(orient(a, b, c)) * Math.sign(orient(a, b, d)) < 0
    && Math.sign(orient(c, d, a)) * Math.sign(orient(c, d, b)) < 0)
    || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}
function inside(p: XY, ring: XY[]): boolean {
  let result = false;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

class BudgetError extends Error {}

/** Parse bounded JSON text, retaining original numeric values/foreign members and per-feature diagnostics. */
export function parseGeographicGeoJson(
  text: string, definition: GeographicLayerDefinition, source: GeographicSource,
  defaults?: GeographicCoordinates, requested?: Partial<GeographicLimits>,
): GeographicLayer {
  const limits = geographicLimits(requested);
  checkGeographicText(text, limits);
  const spec = validateGeographicDefinition(definition, defaults);
  const data: unknown = JSON.parse(text);
  if (!geographicObject(data) || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) fail('Expected a GeoJSON FeatureCollection');
  if ('crs' in data) fail('GeoJSON crs is unsupported; declare planetary coordinates explicitly');
  if (data.features.length > limits.maxFeatures) fail(`GeoJSON exceeds ${limits.maxFeatures} features`);
  let vertices = 0, topologyChecks = 0;
  const diagnostics: GeographicDiagnostic[] = [];
  const warning = (code: string, message: string, featureIndex?: number) => diagnostics.push({ severity: 'warning', code, message, featureIndex });
  const tick = () => { if (++topologyChecks > limits.maxTopologyChecks) throw new BudgetError(`GeoJSON exceeds ${limits.maxTopologyChecks} topology checks`); };
  const c = spec.coordinates;
  function position(raw: unknown): BodyFixedPosition {
    if (++vertices > limits.maxVertices) throw new BudgetError(`GeoJSON exceeds ${limits.maxVertices} vertices`);
    if (!Array.isArray(raw) || (raw.length !== 2 && raw.length !== 3) || !raw.every(finite)) fail('Position must contain two or three finite numbers [longitude, latitude, Z?]');
    const p = raw as GeoPosition;
    if (Math.abs(p[1]) > 90 || (c.longitudeDomain === '0..360' ? p[0] < 0 || p[0] > 360 : Math.abs(p[0]) > 180)) fail('Position outside declared latitude/longitude domain');
    if (p.length === 3 && !c.height) fail('Z requires explicit height units, datum and convention');
    if (p.length === 3) {
      const h = p[2] * (c.height!.unit === 'm' ? 0.001 : 1);
      const minimumRadius = c.referenceShape.kind === 'sphere' ? c.referenceShape.radiusKm : c.referenceShape.radiiKm[2];
      if (h <= -minimumRadius) fail('Height reaches or passes the body center');
    }
    const result = normalizeGeographicPosition(p, c);
    if (!Object.values(result).every(Number.isFinite)) fail('Position conversion is not finite');
    const cart = geographicAbsolutePosition(result, geographicDatum(c));
    if (cart && Math.hypot(cart.xKm, cart.yKm, cart.zKm) === 0) fail('Height reaches the body center');
    return result;
  }
  function list<T>(raw: unknown, min: number, map: (v: unknown) => T): T[] {
    if (!Array.isArray(raw) || raw.length < min) fail(`Coordinate array requires at least ${min} entries`);
    return (raw as unknown[]).map(map);
  }
  const line = (raw: unknown) => list(raw, 2, position);
  function polygon(raw: unknown): BodyFixedPosition[][] {
    const original = list(raw, 1, v => list(v, 4, position));
    const sourceCoordinates = (raw as GeoPosition[][]).map(r => [...r]);
    // A planar GeoJSON cap closes along both sides of the map cut via the
    // pole. In body-fixed coordinates A,pole,pole,A is a zero-area spike.
    // Normalize only that exact closure; the Feature.original stays intact
    // for planar backends and provenance. Ordinary repeated vertices fail.
    for (let r = 0; r < original.length; r++) {
      const ring = original[r];
      for (let i = 0; i + 3 < ring.length; i++) {
        const [a,b,c,d] = ring.slice(i,i+4);
        if (Math.abs(a.lonDeg) === 180 && a.lonDeg === d.lonDeg && a.latDeg === d.latDeg
          && Math.abs(b.latDeg) === 90 && b.latDeg === c.latDeg && b.lonDeg === a.lonDeg && c.lonDeg === a.lonDeg
          && [b,c,d].every(p => p.heightKm === a.heightKm)) {
          ring.splice(i,3); sourceCoordinates[r].splice(i,3); break;
        }
      }
    }
    // Validate in the original coordinate plane, before centric/graphic conversion.
    const sourceRings = sourceCoordinates.map(ring => ring.map(p => ({ lonDeg: p[0], latDeg: p[1] })));
    const projection = geographicProjection(sourceRings[0]);
    const projected = projectGeographicRings(sourceRings, projection);
    const rings = original.map((ring, ringIndex) => {
      const first = ring[0], last = ring.at(-1)!;
      if (first.latDeg !== last.latDeg || first.lonDeg !== last.lonDeg || first.heightKm !== last.heightKm) fail('Polygon ring must be closed, including Z');
      const xy = projected[ringIndex];
      for (let i = 1; i < ring.length; i++) {
        if (Math.abs(wrapLon(ring[i].lonDeg - ring[i - 1].lonDeg)) === 180) fail('Polygon edge spans 180 degrees; split ambiguous edges');
      }
      let area = 0;
      for (let i = 0; i < xy.length - 1; i++) {
        if (xy[i][0] === xy[i + 1][0] && xy[i][1] === xy[i + 1][1]) fail('Polygon has a repeated adjacent vertex');
        area += orient(xy[0], xy[i], xy[i + 1]);
        for (let j = i + 2; j < xy.length - 1; j++) {
          tick();
          if (i === 0 && j === xy.length - 2) continue;
          if (intersects(xy[i], xy[i + 1], xy[j], xy[j + 1])) fail('Polygon ring self-intersects');
        }
      }
      if (Math.abs(area) < 1e-14) fail('Polygon ring has zero area');
      return xy;
    });
    for (let i = 1; i < rings.length; i++) {
      const hole = rings[i];
      if (!inside(hole[0], rings[0])) fail('Polygon hole lies outside its exterior');
      for (let j = 0; j < i; j++) {
        const other = rings[j];
        for (let a = 0; a < hole.length - 1; a++) for (let b = 0; b < other.length - 1; b++) {
          tick();
          if (intersects(hole[a], hole[a + 1], other[b], other[b + 1])) fail('Polygon rings intersect or touch');
        }
        if (j > 0 && (inside(hole[0], other) || inside(other[0], hole))) fail('Polygon holes overlap or nest');
      }
    }
    return original;
  }
  function geometry(raw: unknown): GeographicGeometry<BodyFixedPosition> {
    if (!geographicObject(raw) || 'crs' in raw) fail('Feature requires supported geometry without crs');
    const g = raw as Record<string, unknown>;
    switch (g.type) {
      case 'Point': return { type: g.type, coordinates: position(g.coordinates) };
      case 'MultiPoint': return { type: g.type, coordinates: list(g.coordinates, 1, position) };
      case 'LineString': return { type: g.type, coordinates: line(g.coordinates) };
      case 'MultiLineString': return { type: g.type, coordinates: list(g.coordinates, 1, line) };
      case 'Polygon': return { type: g.type, coordinates: polygon(g.coordinates) };
      case 'MultiPolygon': return { type: g.type, coordinates: list(g.coordinates, 1, polygon) };
      default: return fail(`Unsupported GeoJSON geometry ${String(g.type)}`);
    }
  }
  // JSON's number model is IEEE-754. Warn on unsafe integers before consumers mistake them for exact IDs/counts.
  function unsafeNumber(v: unknown): boolean {
    if (typeof v === 'number') return !Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v));
    return v !== null && typeof v === 'object' && Object.values(v).some(unsafeNumber);
  }
  function nonfiniteNumber(v: unknown): boolean {
    if (typeof v === 'number') return !Number.isFinite(v);
    return v !== null && typeof v === 'object' && Object.values(v).some(nonfiniteNumber);
  }
  const features: GeographicLayer['features'] = [], ids = new Set<string>();
  for (let index = 0; index < data.features.length; index++) {
    try {
      const f: unknown = data.features[index];
      if (!geographicObject(f) || f.type !== 'Feature' || 'crs' in f) fail('Expected a GeoJSON Feature without crs');
      const feature = f as Record<string, unknown>;
      if (feature.properties !== null && !geographicObject(feature.properties)) fail('Feature properties must be an object or null');
      if (nonfiniteNumber(feature)) fail('Feature contains a nonfinite JSON number');
      const sid = feature.id;
      if (sid !== undefined && typeof sid !== 'string' && !(finite(sid) && (!Number.isInteger(sid) || Number.isSafeInteger(sid)))) fail('Feature id must be a string or finite number (integer IDs must be safe)');
      const id = sid === undefined ? `index:${index}` : `${typeof sid}:${sid}`;
      if (ids.has(id)) fail(`Duplicate feature id ${String(sid)}`);
      const normalized = geometry(feature.geometry);
      ids.add(id);
      if (sid === undefined) warning('generated-id', 'No feature id: reference uses source order and changes if the file is reordered', index);
      if (unsafeNumber(feature)) warning('numeric-precision', 'Unsafe/nonfinite JSON number: use strings for exact large integers; JavaScript number precision applies', index);
      features.push({ id, ...(sid === undefined ? {} : { sourceId: sid as string | number }), sourceIndex: index,
        properties: feature.properties as { [key: string]: JsonValue } | null,
        original: feature as { [key: string]: JsonValue }, geometry: normalized });
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      diagnostics.push({ severity: 'error', code: 'skipped-feature', featureIndex: index, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    id: spec.id, name: spec.name, body: spec.body, frame: bodyFixedFrameName(spec.body),
    ownership: source.kind === 'catalog' ? 'catalog' : source.kind === 'user' ? 'user' : 'transient', definition: spec, source,
    coordinates: c, datum: geographicDatum(c), features, skippedFeatures: data.features.length - features.length, diagnostics,
  };
}
