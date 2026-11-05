import { geodeticToBodyFixed, wrapLon, type BodyFixedPosition } from './coordinates.js';
import { geographicDatum } from './import.js';
import { geographicProjection } from './projection.js';
import type { GeographicCoordinates, GeographicFeature, GeographicGeometry, GeographicLayer, GeoPosition, JsonValue } from './model.js';

/**
 * Renderer-independent browsing primitives for loaded geographic layers:
 * display names, typed field inventories, an in-memory search index, filters,
 * extents and coordinate formatting in a layer's declared convention. Every
 * structure is bounded by the import limits, so no GIS backend is needed.
 */

/** Property keys tried, in order, for a feature's display name. */
/** Properties a feature's name is read from, first present wins. */
export const GEOGRAPHIC_NAME_KEYS: readonly string[] = ['name', 'Name', 'NAME', 'title', 'Title', 'label', 'Label', 'clean_name', 'nomenclature'];
const NAME_KEYS = GEOGRAPHIC_NAME_KEYS;
/** At most this many fields are inventoried per layer. */
export const GEOGRAPHIC_MAX_FIELDS = 64;
/** A string field with at most this many distinct values is offered as categories. */
export const GEOGRAPHIC_MAX_CATEGORIES = 24;
/** Searchable text retained per feature, in UTF-16 code units. */
export const GEOGRAPHIC_SEARCH_TEXT_LIMIT = 2048;

export function geographicFeatureName(feature: GeographicFeature): string {
  const properties = feature.properties ?? {};
  for (const key of NAME_KEYS) {
    const value = properties[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return feature.sourceId !== undefined ? String(feature.sourceId) : `Feature ${feature.sourceIndex + 1}`;
}

const ACRONYMS = new Set(['id', 'url', 'uri', 'iau', 'usgs', 'pds', 'roi', 'utc', 'et']);
/** `site_id`, `siteId` and `site-id` all read "Site ID". */
export function geographicPropertyLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_\-.]+/).filter(Boolean);
  if (!words.length) return key;
  return words.map((word, index) => {
    const lower = word.toLowerCase();
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    return index === 0 ? lower[0].toUpperCase() + lower.slice(1) : lower;
  }).join(' ');
}

export type GeographicFieldType = 'string' | 'number' | 'boolean' | 'mixed';
export interface GeographicFieldSummary {
  key: string;
  label: string;
  type: GeographicFieldType;
  /** Features with a non-null scalar value for this key. */
  count: number;
  /** Distinct string values, when few enough to choose from. Sorted. */
  categories?: string[];
  min?: number;
  max?: number;
}

/** Top-level scalar properties only; nested objects stay visible in details but are not filterable. */
export function geographicFeatureFields(layer: GeographicLayer, maxFields = GEOGRAPHIC_MAX_FIELDS): GeographicFieldSummary[] {
  const fields = new Map<string, { types: Set<string>; count: number; strings: Set<string> | null; min: number; max: number }>();
  for (const feature of layer.features) {
    for (const [key, value] of Object.entries(feature.properties ?? {})) {
      if (value === null || typeof value === 'object') continue;
      let field = fields.get(key);
      if (!field) {
        if (fields.size >= maxFields) continue;
        field = { types: new Set(), count: 0, strings: new Set(), min: Infinity, max: -Infinity };
        fields.set(key, field);
      }
      field.types.add(typeof value);
      field.count++;
      if (typeof value === 'string' && field.strings) {
        field.strings.add(value);
        if (field.strings.size > GEOGRAPHIC_MAX_CATEGORIES) field.strings = null;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        field.min = Math.min(field.min, value); field.max = Math.max(field.max, value);
      }
    }
  }
  return [...fields].map(([key, f]) => {
    const type: GeographicFieldType = f.types.size === 1 ? [...f.types][0] as GeographicFieldType : 'mixed';
    return {
      key, label: geographicPropertyLabel(key), type, count: f.count,
      ...(type === 'string' && f.strings ? { categories: [...f.strings].sort((a, b) => a.localeCompare(b)) } : {}),
      ...(type === 'number' ? { min: f.min, max: f.max } : {}),
    };
  });
}

/** One field condition. Values compare against the feature's top-level property. */
export type GeographicFieldFilter =
  | { key: string; kind: 'category'; values: readonly string[] }
  | { key: string; kind: 'text'; contains: string }
  | { key: string; kind: 'range'; min?: number; max?: number }
  | { key: string; kind: 'boolean'; value: boolean };

export interface GeographicFeatureQuery {
  /** Whitespace-separated terms; every term must occur in the name or a property value. */
  text?: string;
  field?: GeographicFieldFilter | null;
}

export interface GeographicSearchEntry {
  feature: GeographicFeature;
  name: string;
  /** Lowercased name, ID and scalar property values, capped per feature. */
  text: string;
}

function scalarText(value: JsonValue, out: string[], budget: { left: number }): void {
  if (budget.left <= 0 || value === null) return;
  if (typeof value === 'object') {
    for (const item of Array.isArray(value) ? value : Object.values(value)) scalarText(item, out, budget);
    return;
  }
  const text = String(value);
  budget.left -= text.length + 1;
  out.push(text);
}

const searchIndexes = new WeakMap<GeographicLayer, GeographicSearchEntry[]>();
/** Built once per immutable layer object; a reloaded layer is a new object and a new index. */
export function geographicSearchIndex(layer: GeographicLayer): readonly GeographicSearchEntry[] {
  let index = searchIndexes.get(layer);
  if (!index) {
    index = layer.features.map(feature => {
      const name = geographicFeatureName(feature);
      const parts = [name, feature.id];
      scalarText(feature.properties, parts, { left: GEOGRAPHIC_SEARCH_TEXT_LIMIT });
      return { feature, name, text: parts.join('\n').toLowerCase().slice(0, GEOGRAPHIC_SEARCH_TEXT_LIMIT) };
    });
    searchIndexes.set(layer, index);
  }
  return index;
}

export function geographicFieldMatches(feature: GeographicFeature, filter: GeographicFieldFilter): boolean {
  const value = feature.properties?.[filter.key];
  switch (filter.kind) {
    case 'category': return typeof value === 'string' && filter.values.includes(value);
    case 'text': return value !== undefined && value !== null && typeof value !== 'object'
      && String(value).toLowerCase().includes(filter.contains.trim().toLowerCase());
    case 'boolean': return value === filter.value;
    case 'range': return typeof value === 'number' && Number.isFinite(value)
      && (filter.min === undefined || value >= filter.min) && (filter.max === undefined || value <= filter.max);
  }
}

/** True when the query has no effect. */
export function geographicQueryEmpty(query: GeographicFeatureQuery): boolean {
  return !query.text?.trim() && !query.field;
}

export function geographicQueryMatches(entry: GeographicSearchEntry, query: GeographicFeatureQuery): boolean {
  const terms = query.text?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  if (!terms.every(term => entry.text.includes(term))) return false;
  return !query.field || geographicFieldMatches(entry.feature, query.field);
}

export function geographicGeometryPositions(g: GeographicGeometry<BodyFixedPosition>): BodyFixedPosition[] {
  switch (g.type) {
    case 'Point': return [g.coordinates];
    case 'MultiPoint': case 'LineString': return g.coordinates;
    case 'MultiLineString': case 'Polygon': return g.coordinates.flat();
    case 'MultiPolygon': return g.coordinates.flat(2);
  }
}

/** Connected vertex runs: each line, each ring; single points have none. */
function geometryRuns(g: GeographicGeometry<BodyFixedPosition>): BodyFixedPosition[][] {
  switch (g.type) {
    case 'Point': return [[g.coordinates]];
    case 'MultiPoint': return g.coordinates.map(p => [p]);
    case 'LineString': return [g.coordinates];
    case 'MultiLineString': case 'Polygon': return g.coordinates;
    case 'MultiPolygon': return g.coordinates.flat();
  }
}

/**
 * The longitude/latitude box a feature occupies, using the same edge convention
 * as import and drawing (the short longitude interval at each edge). `east` is
 * less than `west` when the box crosses the ±180° seam. A polygon ring that
 * winds around a pole has no such box; it reports the pole and the ring's
 * latitude nearest the equator instead.
 */
export type GeographicExtent =
  | { kind: 'box'; west: number; south: number; east: number; north: number }
  | { kind: 'polar'; pole: 'north' | 'south'; boundaryLatDeg: number };

export function geographicFeatureExtent(feature: GeographicFeature): GeographicExtent {
  const g = feature.geometry;
  const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map(p => p[0]) : [];
  const polar = rings.map(ring => geographicProjection(ring)).find(p => p !== 'longitude-latitude');
  const positions = geographicGeometryPositions(g);
  const lats = positions.map(p => p.latDeg);
  if (polar) {
    const north = polar === 'north-polar';
    return { kind: 'polar', pole: north ? 'north' : 'south', boundaryLatDeg: north ? Math.min(...lats) : Math.max(...lats) };
  }
  // Covered longitude intervals on [0, 360], measured from -180; an edge
  // crossing the seam contributes a piece at each end.
  const pieces: [number, number][] = [];
  const cover = (lonDeg: number, length: number) => {
    const start = wrapLon(lonDeg) + 180, end = start + length;
    if (end > 360) pieces.push([start, 360], [0, end - 360]);
    else pieces.push([start, end]);
  };
  for (const run of geometryRuns(g)) {
    if (run.length === 1) cover(run[0].lonDeg, 0);
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1].lonDeg, delta = wrapLon(run[i].lonDeg - a);
      cover(delta >= 0 ? a : a + delta, Math.abs(delta));
    }
  }
  pieces.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of pieces) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  // The extent is the complement of the largest uncovered gap.
  let gap = merged[0][0] + 360 - merged.at(-1)![1], west = merged[0][0], east = merged.at(-1)![1];
  for (let i = 1; i < merged.length; i++) {
    const between = merged[i][0] - merged[i - 1][1];
    if (between > gap) { gap = between; west = merged[i][0]; east = merged[i - 1][1]; }
  }
  if (gap <= 0) { west = 0; east = 360; }
  return { kind: 'box', west: west - 180, south: Math.min(...lats), east: east - 180, north: Math.max(...lats) };
}

/** The point a feature is labelled, framed and located at: a Point's own position, otherwise its extent's centre. */
export function geographicFeatureAnchor(feature: GeographicFeature): BodyFixedPosition {
  if (feature.geometry.type === 'Point') return feature.geometry.coordinates;
  const extent = geographicFeatureExtent(feature);
  if (extent.kind === 'polar') return { latDeg: extent.pole === 'north' ? 90 : -90, lonDeg: 0 };
  const east = extent.east < extent.west ? extent.east + 360 : extent.east;
  return { latDeg: (extent.south + extent.north) / 2, lonDeg: wrapLon((extent.west + east) / 2) };
}

/**
 * Inverse of `normalizeGeographicPosition`: a geodetic, east-positive position
 * expressed in a layer's declared latitude, longitude and height convention, so
 * copied coordinates mean what the layer's own data means.
 */
export function geographicPositionInConvention(position: BodyFixedPosition, c: GeographicCoordinates): GeoPosition {
  let lat = position.latDeg;
  let heightKm = position.heightKm;
  if (c.latitude === 'planetocentric' && c.referenceShape.kind === 'ellipsoid') {
    const p = geodeticToBodyFixed({ ...position, heightKm: position.heightKm ?? 0 }, geographicDatum(c));
    const latRad = Math.atan2(p.zKm, Math.hypot(p.xKm, p.yKm));
    lat = latRad * 180 / Math.PI;
    if (heightKm !== undefined) {
      const [a,, b] = c.referenceShape.radiiKm;
      heightKm = Math.hypot(p.xKm, p.yKm, p.zKm) - a * b / Math.hypot(b * Math.cos(latRad), a * Math.sin(latRad));
    }
  }
  const east = wrapLon(position.lonDeg);
  const directed = c.longitudeDirection === 'east' ? east : -east;
  const lon = c.longitudeDomain === '0..360' ? ((directed % 360) + 360) % 360 : wrapLon(directed);
  if (heightKm === undefined || !c.height) return [lon, lat];
  return [lon, lat, heightKm / (c.height.unit === 'm' ? 0.001 : 1)];
}

/** `18.4500°N, 77.4500°E` in the declared convention, with the height when it has one. */
export function formatGeographicPosition(position: BodyFixedPosition, c: GeographicCoordinates, digits = 4): string {
  const [lon, lat, z] = geographicPositionInConvention(position, c);
  const latText = `${Math.abs(lat).toFixed(digits)}°${lat < 0 ? 'S' : 'N'}`;
  const lonText = c.longitudeDomain === '0..360'
    ? `${lon.toFixed(digits)}°${c.longitudeDirection === 'east' ? 'E' : 'W'}`
    : `${Math.abs(lon).toFixed(digits)}°${(lon < 0) === (c.longitudeDirection === 'east') ? 'W' : 'E'}`;
  return z === undefined ? `${latText}, ${lonText}` : `${latText}, ${lonText}, ${z} ${c.height!.unit}`;
}

/** One line naming the convention copied coordinates are in. */
export function describeGeographicCoordinates(c: GeographicCoordinates): string {
  const shape = c.referenceShape.kind === 'sphere'
    ? `sphere r=${c.referenceShape.radiusKm} km`
    : `ellipsoid ${c.referenceShape.radiiKm[0]} × ${c.referenceShape.radiiKm[2]} km`;
  const latitude = c.latitude === 'planetocentric' ? 'Planetocentric' : 'Planetographic';
  const height = c.height ? ` · heights in ${c.height.unit} above the ${c.height.datum === 'ellipsoid' ? 'ellipsoid' : 'reference sphere'}` : '';
  return `${latitude} latitude · ${c.longitudeDirection} longitude ${c.longitudeDomain.replace('..', '–')}° · ${shape}${height}`;
}

/** Vertex count across every part and ring, for the details summary. */
export function geographicVertexCount(feature: GeographicFeature): number {
  return geographicGeometryPositions(feature.geometry).length;
}
