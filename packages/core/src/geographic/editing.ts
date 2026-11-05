import { bodyFixedFrameName } from '../frames/FrameRegistry.js';
import { wrapLon, type BodyFixedPosition } from './coordinates.js';
import { geodesicDirect } from './geodesy.js';
import { geographicDatum, normalizeGeographicPosition, parseGeographicGeoJson, validateGeographicCoordinates, geographicObject } from './import.js';
import { geographicPositionInConvention } from './browse.js';
import {
  GEOGRAPHIC_LIMITS, type GeographicCoordinates, type GeographicDiagnostic, type GeographicGeometry, type GeographicLayer,
  type GeographicLayerDefinition, type GeographicSource, type GeoPosition, type JsonValue,
} from './model.js';

/**
 * User-authored geographic layers and working copies (#200).
 *
 * An edit layer stores every coordinate **in its declared convention**
 * (`coordinates`), exactly as it exports, so save → export → reimport returns
 * the same numbers; nothing is reinterpreted as WGS84. It becomes a
 * `GeographicLayer` for drawing, picking and browsing through the ordinary
 * import parser, and every edit is validated by that same parser: an edit
 * that would leave a feature invalid (self-intersection, bad hole, degenerate
 * or ambiguous ring, out-of-domain position) is refused with the parser's
 * reason, so a layer never holds a feature its own export would reject, and
 * no edit touches another feature.
 *
 * A read-only layer (catalog or imported file) is never modified: a working
 * copy takes its features' original GeoJSON — holes, Multi geometry, IDs,
 * properties and foreign members included — into a new layer with its own ID.
 */

export const GEOGRAPHIC_EDIT_FORMAT = 'cosmolabe-geographic-edits';
export const GEOGRAPHIC_EDIT_VERSION = 1;
/** The GeoJSON extension member carrying body and coordinate conventions. */
export const GEOGRAPHIC_GEOJSON_EXTENSION = 'cosmolabe:geographic';
/** The feature member carrying a circle or ellipse's semantic parameters. */
export const GEOGRAPHIC_SHAPE_MEMBER = 'cosmolabe:shape';
/** Say this wherever an export is offered. */
export const GEOGRAPHIC_EXPORT_NOTE =
  'Planetary GeoJSON: coordinates are in this layer’s declared body and convention, carried in the “cosmolabe:geographic” member. '
  + 'Software that follows RFC 7946 strictly will read them as Earth WGS84 longitude/latitude; load them with the companion catalog, or declare the convention yourself.';
/** Undo depth per session. */
export const GEOGRAPHIC_EDIT_HISTORY = 100;
/** Vertices of a circle or ellipse ring, before closure. */
export const GEOGRAPHIC_SHAPE_SEGMENTS = 64;

/** A circle (semiMajor = semiMinor) or ellipse, kept as parameters rather than frozen into its ring. */
export interface GeographicShapeParameters {
  kind: 'circle' | 'ellipse';
  /** In the layer's declared convention, `[longitude, latitude]`. */
  center: [number, number];
  semiMajorKm: number;
  semiMinorKm: number;
  /** Direction of the major axis, degrees clockwise from north. */
  bearingDeg: number;
}

export interface GeographicEditFeature {
  /** The GeoJSON `id`: kept from the source in a working copy, `user-N` for new features. */
  id: string | number;
  /** In the layer's declared convention, as exported. */
  geometry: GeographicGeometry<GeoPosition>;
  properties: { [key: string]: JsonValue };
  shape?: GeographicShapeParameters;
  /** Foreign members of a source feature, preserved through edits. */
  members?: { [key: string]: JsonValue };
}

export interface GeographicEditLayer {
  id: string;
  name: string;
  body: string;
  coordinates: GeographicCoordinates;
  display?: GeographicLayerDefinition['display'];
  /** The read-only layer this is a working copy of. */
  basedOn?: { layerId: string; source: GeographicSource };
  features: GeographicEditFeature[];
  /** Next number for `user-N` IDs; never reused. */
  nextId: number;
}

/** Where a vertex is: the nested coordinate path (line, ring, polygon/ring), then its index. */
export interface GeographicVertexPath { part: number[]; index: number }

export type GeographicEditOperation =
  /** A geometry, or a circle/ellipse whose ring is generated from its parameters. */
  | { type: 'add'; geometry?: GeographicGeometry<GeoPosition>; properties?: { [key: string]: JsonValue }; shape?: GeographicShapeParameters }
  | { type: 'replace-geometry'; featureId: string | number; geometry: GeographicGeometry<GeoPosition> }
  | { type: 'set-shape'; featureId: string | number; shape: GeographicShapeParameters }
  | { type: 'move-vertex'; featureId: string | number; vertex: GeographicVertexPath; position: GeoPosition }
  | { type: 'insert-vertex'; featureId: string | number; vertex: GeographicVertexPath; position: GeoPosition }
  | { type: 'delete-vertex'; featureId: string | number; vertex: GeographicVertexPath }
  /** Move a whole feature so `from` lands on `to`, by rotating it about the body's centre (shape preserved). */
  | { type: 'translate'; featureId: string | number; from: GeoPosition; to: GeoPosition }
  | { type: 'set-properties'; featureId: string | number; properties: { [key: string]: JsonValue } }
  | { type: 'duplicate'; featureId: string | number; offset?: { from: GeoPosition; to: GeoPosition } }
  | { type: 'delete'; featureId: string | number };

export type GeographicEditResult =
  | { ok: true; layer: GeographicEditLayer; featureId?: string | number; diagnostics: GeographicDiagnostic[] }
  | { ok: false; diagnostics: GeographicDiagnostic[] };

/** The stable feature reference ID the parser gives a GeoJSON `id`. */
export const geographicEditFeatureRefId = (id: string | number) => `${typeof id}:${id}`;

const error = (code: string, message: string): GeographicDiagnostic => ({ severity: 'error', code, message });

export function createGeographicEditLayer(options: {
  id: string; name: string; body: string; coordinates: GeographicCoordinates; display?: GeographicEditLayer['display'];
}): GeographicEditLayer {
  return { id: options.id, name: options.name, body: options.body, coordinates: validateGeographicCoordinates(options.coordinates),
    ...(options.display ? { display: options.display } : {}), features: [], nextId: 1 };
}

/**
 * A working copy of a read-only layer under a new ID. The source layer and its
 * features are not modified; each copied feature keeps its source ID (a
 * feature without one gets `source-<index>`), properties, foreign members and
 * exact source coordinates, holes and Multi parts included.
 */
export function createGeographicWorkingCopy(layer: GeographicLayer, options: { id?: string; name?: string } = {}): GeographicEditLayer {
  const features = layer.features.map((feature): GeographicEditFeature => {
    const { type: _type, id: _id, geometry, properties, ...members } = structuredClone(feature.original) as { [key: string]: JsonValue };
    const copy: GeographicEditFeature = {
      id: feature.sourceId ?? `source-${feature.sourceIndex}`,
      geometry: geometry as unknown as GeographicGeometry<GeoPosition>,
      properties: (properties ?? {}) as { [key: string]: JsonValue },
    };
    const shape = members[GEOGRAPHIC_SHAPE_MEMBER];
    delete members[GEOGRAPHIC_SHAPE_MEMBER];
    const parsed = shape === undefined ? null : parseShape(shape);
    if (parsed) copy.shape = parsed;
    if (Object.keys(members).length) copy.members = members;
    return copy;
  });
  return {
    id: options.id ?? `${layer.id}:edits`, name: options.name ?? `${layer.name} (edits)`, body: layer.body,
    coordinates: structuredClone(layer.coordinates), ...(layer.definition.display ? { display: { ...layer.definition.display } } : {}),
    basedOn: { layerId: layer.id, source: { ...layer.source } }, features, nextId: 1,
  };
}

function featureJson(feature: GeographicEditFeature): { [key: string]: JsonValue } {
  return {
    ...feature.members, type: 'Feature', id: feature.id,
    properties: feature.properties, geometry: feature.geometry as unknown as JsonValue,
    ...(feature.shape ? { [GEOGRAPHIC_SHAPE_MEMBER]: feature.shape as unknown as JsonValue } : {}),
  };
}

/** The layer's conventions and identity, as the GeoJSON extension member carries them. */
function extensionMember(layer: GeographicEditLayer): JsonValue {
  return {
    version: GEOGRAPHIC_EDIT_VERSION, body: layer.body, frame: layer.coordinates.frame ?? bodyFixedFrameName(layer.body),
    coordinates: layer.coordinates as unknown as JsonValue,
    layer: { id: layer.id, name: layer.name },
    ...(layer.basedOn ? { basedOn: { layerId: layer.basedOn.layerId, source: layer.basedOn.source.identity } } : {}),
  };
}

/** A GeoJSON FeatureCollection with the planetary extension member. */
export function geographicEditFeatureCollection(layer: GeographicEditLayer, features = layer.features): { [key: string]: JsonValue } {
  return { type: 'FeatureCollection', [GEOGRAPHIC_GEOJSON_EXTENSION]: extensionMember(layer), features: features.map(featureJson) };
}

function definitionOf(layer: GeographicEditLayer): GeographicLayerDefinition & { coordinates: GeographicCoordinates } {
  return { id: layer.id, name: layer.name, body: layer.body, source: `${layer.id}.geojson`, coordinates: layer.coordinates,
    ...(layer.display ? { display: layer.display } : {}),
    provenance: { authored: 'cosmolabe', ...(layer.basedOn ? { workingCopyOf: layer.basedOn.layerId } : {}) } };
}

const userSource = (layer: GeographicEditLayer): GeographicSource => ({ kind: 'user', identity: `user:${layer.id}` });

/** The layer as drawing, picking and browsing see it: parsed by the ordinary importer, ownership `user`. */
export function geographicEditLayerToLayer(layer: GeographicEditLayer): GeographicLayer {
  return parseGeographicGeoJson(JSON.stringify(geographicEditFeatureCollection(layer)), definitionOf(layer), userSource(layer));
}

/** The importer's verdict on one feature: errors mean it would be skipped on import. */
export function validateGeographicEditFeature(layer: GeographicEditLayer, feature: GeographicEditFeature): GeographicDiagnostic[] {
  try {
    const parsed = parseGeographicGeoJson(JSON.stringify(geographicEditFeatureCollection(layer, [feature])), definitionOf(layer), userSource(layer),
      undefined, { maxFeatures: 1 });
    return parsed.diagnostics.map(({ featureIndex: _index, ...d }) => d);
  } catch (e) {
    return [error('edit-budget', e instanceof Error ? e.message : String(e))];
  }
}

// ── Circles and ellipses ──

function parseShape(raw: JsonValue): GeographicShapeParameters | null {
  if (!geographicObject(raw)) return null;
  const { kind, center, semiMajorKm, semiMinorKm, bearingDeg } = raw as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if ((kind !== 'circle' && kind !== 'ellipse') || !Array.isArray(center) || center.length !== 2 || !center.every(finite)
    || !finite(semiMajorKm) || !finite(semiMinorKm) || !finite(bearingDeg) || semiMinorKm <= 0 || semiMajorKm < semiMinorKm) return null;
  return { kind, center: [center[0], center[1]], semiMajorKm, semiMinorKm, bearingDeg };
}

/**
 * A closed ring for a circle or ellipse: points at `semiMajor·semiMinor / r(θ)`
 * along geodesics from the centre on the reference shape, in the declared
 * convention. The parameters, not this ring, are the feature's definition.
 */
export function geographicShapeRing(shape: GeographicShapeParameters, coordinates: GeographicCoordinates, segments = GEOGRAPHIC_SHAPE_SEGMENTS): GeoPosition[] {
  const datum = geographicDatum(coordinates);
  const center = normalizeGeographicPosition(shape.center, coordinates);
  const a = shape.semiMajorKm, b = shape.semiMinorKm;
  const ring: GeoPosition[] = [];
  for (let i = 0; i < segments; i++) {
    // Clockwise from north, as azimuths are; GeoJSON winding is not significant here.
    const azimuth = 360 * i / segments;
    const theta = (azimuth - shape.bearingDeg) * Math.PI / 180;
    const r = a * b / Math.hypot(b * Math.cos(theta), a * Math.sin(theta));
    const p = geodesicDirect(center, azimuth, r, datum);
    const [lon, lat] = geographicPositionInConvention(p, coordinates);
    ring.push([lon, lat]);
  }
  ring.push([...ring[0]] as GeoPosition);
  return ring;
}

// ── Vertex addressing ──

/** The vertex list a path names, or undefined when the path does not fit the geometry. Points have none. */
function vertexList(geometry: GeographicGeometry<GeoPosition>, part: number[]): GeoPosition[] | undefined {
  switch (geometry.type) {
    case 'Point': return undefined;
    case 'MultiPoint': case 'LineString': return part.length === 0 ? geometry.coordinates : undefined;
    case 'MultiLineString': case 'Polygon': return part.length === 1 ? geometry.coordinates[part[0]] : undefined;
    case 'MultiPolygon': return part.length === 2 ? geometry.coordinates[part[0]]?.[part[1]] : undefined;
  }
}
const isRing = (geometry: GeographicGeometry<GeoPosition>) => geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';
const minimum = (geometry: GeographicGeometry<GeoPosition>) =>
  geometry.type === 'MultiPoint' ? 1 : geometry.type === 'LineString' || geometry.type === 'MultiLineString' ? 2 : 4;

function editVertices(geometry: GeographicGeometry<GeoPosition>, vertex: GeographicVertexPath,
  edit: (open: GeoPosition[]) => GeoPosition[] | string): GeographicGeometry<GeoPosition> | string {
  const next = structuredClone(geometry);
  if (next.type === 'Point') return 'A point has one vertex; move it instead';
  const list = vertexList(next, vertex.part);
  if (!list) return 'No such part';
  const ring = isRing(next);
  // Rings are edited open, then closed again, so the first and last vertex stay one.
  const open = ring ? list.slice(0, -1) : [...list];
  const result = edit(open);
  if (typeof result === 'string') return result;
  if (result.length + (ring ? 1 : 0) < minimum(next)) return `Too few vertices: a ${ring ? 'ring' : next.type === 'MultiPoint' ? 'multipoint' : 'line'} needs at least ${minimum(next) - (ring ? 1 : 0)}`;
  list.length = 0;
  list.push(...result, ...(ring ? [[...result[0]] as GeoPosition] : []));
  return next;
}

// ── Moving whole features ──

type Vec = [number, number, number];
const unit = (p: BodyFixedPosition): Vec => {
  const lat = p.latDeg * Math.PI / 180, lon = p.lonDeg * Math.PI / 180;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
};
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The rotation taking `from`'s surface normal to `to`'s, applied to positions in the declared convention. */
function rotation(from: GeoPosition, to: GeoPosition, c: GeographicCoordinates): (p: GeoPosition) => GeoPosition {
  const a = unit(normalizeGeographicPosition([from[0], from[1]], c)), b = unit(normalizeGeographicPosition([to[0], to[1]], c));
  const axis = cross(a, b), sin = Math.hypot(...axis), cos = dot(a, b);
  const k: Vec = sin > 1e-15 ? [axis[0] / sin, axis[1] / sin, axis[2] / sin] : [0, 0, 1];
  return (p) => {
    const q = normalizeGeographicPosition(p, c);
    const v = unit(q);
    const kv = cross(k, v), kd = dot(k, v);
    // Rodrigues' rotation formula.
    const r: Vec = [0, 1, 2].map(i => v[i] * cos + kv[i] * sin + k[i] * kd * (1 - cos)) as Vec;
    const moved: BodyFixedPosition = { latDeg: Math.asin(Math.max(-1, Math.min(1, r[2]))) * 180 / Math.PI, lonDeg: wrapLon(Math.atan2(r[1], r[0]) * 180 / Math.PI) };
    if (q.heightKm !== undefined) moved.heightKm = q.heightKm;
    return geographicPositionInConvention(moved, c);
  };
}

function mapPositions(geometry: GeographicGeometry<GeoPosition>, f: (p: GeoPosition) => GeoPosition): GeographicGeometry<GeoPosition> {
  switch (geometry.type) {
    case 'Point': return { type: 'Point', coordinates: f(geometry.coordinates) };
    case 'MultiPoint': case 'LineString': return { type: geometry.type, coordinates: geometry.coordinates.map(f) };
    case 'MultiLineString': case 'Polygon': return { type: geometry.type, coordinates: geometry.coordinates.map(r => r.map(f)) };
    case 'MultiPolygon': return { type: 'MultiPolygon', coordinates: geometry.coordinates.map(p => p.map(r => r.map(f))) };
  }
}

// ── Applying operations ──

/** Apply one operation, returning a new layer; the input is not modified. Refused edits leave nothing changed. */
export function applyGeographicEdit(layer: GeographicEditLayer, op: GeographicEditOperation): GeographicEditResult {
  const index = 'featureId' in op ? layer.features.findIndex(f => f.id === op.featureId) : -1;
  if ('featureId' in op && index < 0) return { ok: false, diagnostics: [error('missing-feature', `No feature ${String(op.featureId)} in ${layer.name}`)] };
  const current = layer.features[index];
  const notes: GeographicDiagnostic[] = [];
  let next: GeographicEditFeature | null = null;
  let features = layer.features;
  let nextId = layer.nextId;
  const replace = (feature: GeographicEditFeature) => { next = feature; features = layer.features.map((f, i) => i === index ? feature : f); };
  const plain = (feature: GeographicEditFeature): GeographicEditFeature => {
    // A vertex edit makes a circle or ellipse an ordinary polygon; its parameters no longer describe it.
    if (!feature.shape) return feature;
    notes.push({ severity: 'warning', code: 'shape-converted', message: `Edited vertices: this ${feature.shape.kind} is now an ordinary polygon` });
    const { shape: _shape, ...rest } = feature;
    return rest;
  };
  const geometry = (g: GeographicGeometry<GeoPosition> | string): GeographicGeometry<GeoPosition> | null => {
    if (typeof g === 'string') { notes.push(error('invalid-edit', g)); return null; }
    return g;
  };
  switch (op.type) {
    case 'add': {
      const shape = op.shape;
      const g = shape ? { type: 'Polygon' as const, coordinates: [geographicShapeRing(shape, layer.coordinates)] } : op.geometry;
      if (!g) return { ok: false, diagnostics: [error('invalid-edit', 'A new feature needs a geometry or a shape')] };
      next = { id: `user-${nextId++}`, geometry: g, properties: { ...op.properties }, ...(shape ? { shape } : {}) };
      features = [...layer.features, next];
      break;
    }
    case 'duplicate': {
      const g = op.offset ? mapPositions(current.geometry, rotation(op.offset.from, op.offset.to, layer.coordinates)) : structuredClone(current.geometry);
      const shape = current.shape && op.offset ? { ...current.shape, center: rotation(op.offset.from, op.offset.to, layer.coordinates)(current.shape.center) as [number, number] } : current.shape;
      const name = typeof current.properties.name === 'string' ? `${current.properties.name} (copy)` : undefined;
      next = { ...structuredClone(current), id: `user-${nextId++}`, geometry: g, ...(shape ? { shape } : {}),
        properties: { ...structuredClone(current.properties), ...(name ? { name } : {}) } };
      features = [...layer.features.slice(0, index + 1), next, ...layer.features.slice(index + 1)];
      break;
    }
    case 'delete':
      features = layer.features.filter((_, i) => i !== index);
      return { ok: true, layer: { ...layer, features }, featureId: op.featureId, diagnostics: [] };
    case 'set-properties': {
      const size = JSON.stringify(op.properties).length;
      if (size > 64 * 1024) return { ok: false, diagnostics: [error('edit-budget', 'Properties exceed 64 KiB')] };
      replace({ ...current, properties: structuredClone(op.properties) });
      break;
    }
    case 'replace-geometry':
      replace({ ...plain(current), geometry: structuredClone(op.geometry) });
      break;
    case 'set-shape':
      replace({ ...current, shape: { ...op.shape }, geometry: { type: 'Polygon', coordinates: [geographicShapeRing(op.shape, layer.coordinates)] } });
      break;
    case 'translate': {
      const move = rotation(op.from, op.to, layer.coordinates);
      replace(current.shape
        ? { ...current, shape: { ...current.shape, center: move(current.shape.center) as [number, number] }, geometry: { type: 'Polygon', coordinates: [geographicShapeRing({ ...current.shape, center: move(current.shape.center) as [number, number] }, layer.coordinates)] } }
        : { ...current, geometry: mapPositions(current.geometry, move) });
      break;
    }
    case 'move-vertex': {
      if (current.geometry.type === 'Point') { replace({ ...current, geometry: { type: 'Point', coordinates: [...op.position] as GeoPosition } }); break; }
      const g = geometry(editVertices(current.geometry, op.vertex, open => {
        if (op.vertex.index < 0 || op.vertex.index >= open.length) return 'No such vertex';
        open[op.vertex.index] = [...op.position] as GeoPosition;
        return open;
      }));
      if (g) replace({ ...plain(current), geometry: g });
      break;
    }
    case 'insert-vertex': {
      const g = geometry(editVertices(current.geometry, op.vertex, open => {
        if (op.vertex.index < 0 || op.vertex.index > open.length) return 'No such position';
        open.splice(op.vertex.index, 0, [...op.position] as GeoPosition);
        return open;
      }));
      if (g) replace({ ...plain(current), geometry: g });
      break;
    }
    case 'delete-vertex': {
      const g = geometry(editVertices(current.geometry, op.vertex, open => {
        if (op.vertex.index < 0 || op.vertex.index >= open.length) return 'No such vertex';
        open.splice(op.vertex.index, 1);
        return open;
      }));
      if (g) replace({ ...plain(current), geometry: g });
      break;
    }
  }
  if (notes.some(d => d.severity === 'error')) return { ok: false, diagnostics: notes };
  if (features.length > GEOGRAPHIC_LIMITS.maxFeatures) return { ok: false, diagnostics: [error('edit-budget', `A layer holds at most ${GEOGRAPHIC_LIMITS.maxFeatures} features`)] };
  const result: GeographicEditLayer = { ...layer, features, nextId };
  if (next) {
    const diagnostics = validateGeographicEditFeature(result, next);
    const errors = diagnostics.filter(d => d.severity === 'error' || d.code === 'skipped-feature');
    if (errors.length) return { ok: false, diagnostics: errors.map(d => ({ ...d, severity: 'error' as const })) };
    notes.push(...diagnostics.filter(d => d.code !== 'generated-id'));
  }
  return { ok: true, layer: result, featureId: (next as GeographicEditFeature | null)?.id ?? ('featureId' in op ? op.featureId : undefined), diagnostics: notes };
}

/**
 * One layer's edits with bounded undo and redo. Each step keeps the previous
 * layer, which shares every unchanged feature with the next, so history costs
 * roughly the features actually edited.
 */
export class GeographicEditSession {
  private past: GeographicEditLayer[] = [];
  private future: GeographicEditLayer[] = [];
  private listeners = new Set<(layer: GeographicEditLayer) => void>();
  constructor(private current: GeographicEditLayer, private readonly historyLimit = GEOGRAPHIC_EDIT_HISTORY) {}
  get layer(): GeographicEditLayer { return this.current; }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  apply(op: GeographicEditOperation): GeographicEditResult {
    const result = applyGeographicEdit(this.current, op);
    if (!result.ok) return result;
    this.past.push(this.current);
    if (this.past.length > this.historyLimit) this.past.shift();
    this.future = [];
    this.set(result.layer);
    return result;
  }
  undo(): boolean {
    const previous = this.past.pop();
    if (!previous) return false;
    this.future.push(this.current);
    this.set(previous);
    return true;
  }
  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.current);
    this.set(next);
    return true;
  }
  /** Rename or restyle the layer itself; not an undoable feature edit. */
  update(change: Partial<Pick<GeographicEditLayer, 'name' | 'display'>>): void { this.set({ ...this.current, ...change }); }
  subscribe(listener: (layer: GeographicEditLayer) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private set(layer: GeographicEditLayer): void {
    this.current = layer;
    for (const listener of this.listeners) listener(layer);
  }
}

// ── Export and import ──

/** GeoJSON text for a layer. Every feature is valid, since edits are validated. */
export function exportGeographicEditLayer(layer: GeographicEditLayer): string {
  return JSON.stringify(geographicEditFeatureCollection(layer), null, 2);
}

/** A catalog that loads an exported layer through the ordinary `geographicLayers` path. */
export function geographicEditCompanionCatalog(layer: GeographicEditLayer, geojsonFile: string): { [key: string]: JsonValue } {
  return {
    name: layer.name,
    geographicCoordinates: layer.coordinates as unknown as JsonValue,
    geographicLayers: [{ id: layer.id, name: layer.name, body: layer.body, source: geojsonFile,
      ...(layer.display ? { display: layer.display as JsonValue } : {}),
      provenance: { authored: 'cosmolabe', ...(layer.basedOn ? { workingCopyOf: layer.basedOn.layerId } : {}) } }],
  };
}

/**
 * Read GeoJSON back into an edit layer. Conventions come from the
 * `cosmolabe:geographic` member, or from `fallback` for plain GeoJSON; without
 * either it is refused rather than read as WGS84. Features the importer
 * rejects are reported and left out; the rest keep their IDs, coordinates,
 * properties, shapes and foreign members exactly.
 */
export function importGeographicEditLayer(
  text: string, fallback?: { id: string; name: string; body: string; coordinates: GeographicCoordinates },
): { layer: GeographicEditLayer; diagnostics: GeographicDiagnostic[] } {
  const data: unknown = JSON.parse(text);
  if (!geographicObject(data) || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('Expected a GeoJSON FeatureCollection');
  const meta = data[GEOGRAPHIC_GEOJSON_EXTENSION];
  let identity: { id: string; name: string; body: string; coordinates: GeographicCoordinates };
  if (geographicObject(meta)) {
    const layerMeta = geographicObject(meta.layer) ? meta.layer : {};
    if (typeof meta.body !== 'string' || !meta.body) throw new Error(`${GEOGRAPHIC_GEOJSON_EXTENSION} needs a body`);
    const coordinates = validateGeographicCoordinates(meta.coordinates);
    if (meta.frame !== undefined) {
      if (typeof meta.frame !== 'string' || !meta.frame.trim() || (coordinates.frame && coordinates.frame !== meta.frame)) {
        throw new Error('Geographic frame declarations disagree or are invalid');
      }
      if (!coordinates.frame && meta.frame !== bodyFixedFrameName(meta.body)) coordinates.frame = meta.frame;
    }
    identity = {
      id: typeof layerMeta.id === 'string' && layerMeta.id ? layerMeta.id : fallback?.id ?? 'imported',
      name: typeof layerMeta.name === 'string' && layerMeta.name ? layerMeta.name : fallback?.name ?? 'Imported layer',
      body: meta.body, coordinates,
    };
  } else if (fallback) identity = { ...fallback, coordinates: validateGeographicCoordinates(fallback.coordinates) };
  else throw new Error('This GeoJSON does not say which body or coordinate convention it uses; RFC 7946 would mean Earth WGS84. Open it with a companion catalog, or choose the body and convention.');
  const layer = createGeographicEditLayer(identity);
  const parsed = parseGeographicGeoJson(text, definitionOf(layer), userSource(layer));
  const valid = new Set(parsed.features.map(f => f.sourceIndex));
  let nextId = 1;
  layer.features = (data.features as unknown[]).flatMap((raw, i): GeographicEditFeature[] => {
    if (!valid.has(i) || !geographicObject(raw)) return [];
    const { type: _type, id, geometry, properties, [GEOGRAPHIC_SHAPE_MEMBER]: shape, ...members } = raw as { [key: string]: JsonValue };
    const featureId = typeof id === 'string' || typeof id === 'number' ? id : `source-${i}`;
    const match = typeof featureId === 'string' ? /^user-(\d+)$/.exec(featureId) : null;
    if (match) nextId = Math.max(nextId, Number(match[1]) + 1);
    const parsedShape = shape === undefined ? null : parseShape(shape);
    return [{ id: featureId, geometry: geometry as unknown as GeographicGeometry<GeoPosition>, properties: (properties ?? {}) as { [key: string]: JsonValue },
      ...(parsedShape ? { shape: parsedShape } : {}), ...(Object.keys(members).length ? { members } : {}) }];
  });
  layer.nextId = nextId;
  return { layer, diagnostics: parsed.diagnostics };
}

// ── Local persistence ──

export interface GeographicEditDocument {
  format: typeof GEOGRAPHIC_EDIT_FORMAT;
  version: typeof GEOGRAPHIC_EDIT_VERSION;
  layers: GeographicEditLayer[];
}
/** At most this many authored layers are kept. */
export const GEOGRAPHIC_EDIT_MAX_LAYERS = 16;

export function serializeGeographicEditDocument(layers: readonly GeographicEditLayer[]): string {
  if (layers.length > GEOGRAPHIC_EDIT_MAX_LAYERS) throw new Error(`At most ${GEOGRAPHIC_EDIT_MAX_LAYERS} edited layers are kept`);
  const text = JSON.stringify({ format: GEOGRAPHIC_EDIT_FORMAT, version: GEOGRAPHIC_EDIT_VERSION, layers });
  if (text.length > GEOGRAPHIC_LIMITS.maxBytes * 2) throw new Error('Edited layers exceed the 4 MiB local budget; export and remove some');
  return text;
}

/**
 * Read a stored document. Each layer is re-validated through export and
 * import, so a damaged or hand-edited document cannot install invalid
 * features; layers that fail are reported and skipped.
 */
export function parseGeographicEditDocument(text: string): { layers: GeographicEditLayer[]; problems: string[] } {
  const problems: string[] = [];
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { layers: [], problems: ['Stored edits are not valid JSON'] }; }
  if (!geographicObject(data) || data.format !== GEOGRAPHIC_EDIT_FORMAT || !Array.isArray(data.layers)) return { layers: [], problems: ['Not a Cosmolabe geographic edits document'] };
  if (data.version !== GEOGRAPHIC_EDIT_VERSION) problems.push(`Unknown edits version ${String(data.version)}; reading it as version ${GEOGRAPHIC_EDIT_VERSION}`);
  const layers: GeographicEditLayer[] = [];
  for (const raw of (data.layers as unknown[]).slice(0, GEOGRAPHIC_EDIT_MAX_LAYERS)) {
    try {
      if (!geographicObject(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.body !== 'string' || !Array.isArray(raw.features)) throw new Error('malformed layer');
      const stored = raw as unknown as GeographicEditLayer;
      const { layer, diagnostics } = importGeographicEditLayer(JSON.stringify(geographicEditFeatureCollection(stored)), stored);
      const skipped = diagnostics.filter(d => d.code === 'skipped-feature').length;
      if (skipped) problems.push(`${stored.name}: ${skipped} invalid features left out`);
      layers.push({ ...layer, nextId: Math.max(layer.nextId, Number.isSafeInteger(stored.nextId) ? stored.nextId : 1),
        ...(stored.display ? { display: stored.display } : {}), ...(stored.basedOn ? { basedOn: stored.basedOn } : {}) });
    } catch (e) {
      problems.push(`${geographicObject(raw) && typeof raw.name === 'string' ? raw.name : 'A layer'}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if ((data.layers as unknown[]).length > GEOGRAPHIC_EDIT_MAX_LAYERS) problems.push(`Only the first ${GEOGRAPHIC_EDIT_MAX_LAYERS} layers were read`);
  return { layers, problems };
}
