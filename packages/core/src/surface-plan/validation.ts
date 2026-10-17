import { checkGeographicText, geographicDatum, geographicObject, parseGeographicGeoJson, validateGeographicCoordinates } from '../geographic/import.js';
import { bodyFixedFrameName } from '../frames/FrameRegistry.js';
import type { GeographicLayer } from '../geographic/model.js';
import { planFail, type DesiredSurfacePlan, type LockedSurfacePlan, type SurfaceSourceDescriptor, type SurfacePlanDiagnostic } from './model.js';
import { intersectGeometry, subtractGeometry, surfaceAreaM2, surfaceFeatureGeometry, unionGeometry } from './geometry.js';
export { planFail } from './model.js';

function object(v: unknown, path: string): asserts v is Record<string, unknown> {
  if (!geographicObject(v)) planFail('schema', path, 'Expected an object');
}
function keys(v: Record<string, unknown>, allowed: string[], path: string) {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) planFail('schema', `${path}.${k}`, 'Unknown field');
}
function string(v: unknown, path: string): asserts v is string {
  if (typeof v !== 'string' || !v.trim()) planFail('schema', path, 'Expected a nonempty string');
}
function positive(v: unknown, path: string): asserts v is number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) planFail('units', path, 'Expected a positive finite number');
}
function integer(v: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts v is number {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) planFail('schema', path, `Expected an integer in [${min}, ${max}]`);
}
function array(v: unknown, path: string, max: number, min = 1): asserts v is unknown[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) planFail('limits', path, `Expected ${min}..${max} entries`);
}
function coordinates(v: unknown, path: string) {
  try { validateGeographicCoordinates(v); }
  catch (e) { planFail('unsupported-coordinates', path, String(e)); }
}

/** Canonical JSON: sorted object keys, authored array order, no lossy/non-JSON values. */
export function serializeSurfacePlan(value: unknown): string {
  function canonical(v: unknown, depth: number): string {
    if (depth > 32) planFail('limits', '$', 'JSON nesting exceeds 32');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(x => canonical(x, depth + 1)).join(',')}]`;
    if (geographicObject(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
      return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k], depth + 1)}`).join(',')}}`;
    }
    return planFail('schema', '$', 'Only finite JSON data can be serialized');
  }
  const text = canonical(value, 0);
  try { checkGeographicText(text); } catch (e) { planFail('limits', '$', String(e)); }
  return text;
}
export async function surfacePlanIdentity(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializeSurfacePlan(value)));
  return `sha256:${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
}
export function parseSurfacePlan(text: string): DesiredSurfacePlan {
  try { checkGeographicText(text); } catch (e) { planFail('limits', '$', String(e)); }
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { return planFail('json', '$', String(e)); }
  return validateDesiredSurfacePlan(v);
}
export function validateDesiredSurfacePlan(v: unknown): DesiredSurfacePlan {
  serializeSurfacePlan(v);
  object(v, '$');
  keys(v, ['version', 'kind', 'body', 'frame', 'coordinates', 'layers', 'regions', 'budget'], '$');
  if (v.version !== 1 || v.kind !== 'desired-surface-plan') planFail('version-kind', '$', 'Expected version 1 desired-surface-plan');
  string(v.body, '$.body'); string(v.frame, '$.frame');
  if (v.frame !== bodyFixedFrameName(v.body)) planFail('unsupported-frame', '$.frame', 'Use the shared IAU body-fixed frame');
  coordinates(v.coordinates, '$.coordinates');
  array(v.layers, '$.layers', 16);
  const layers = new Set<string>();
  for (const [i, layer] of v.layers.entries()) {
    const p = `$.layers[${i}]`; object(layer, p);
    keys(layer, ['id', 'name', 'body', 'source', 'coordinates', 'display', 'provenance', 'geojson'], p);
    string(layer.id, `${p}.id`); string(layer.name, `${p}.name`); string(layer.source, `${p}.source`);
    if (layer.body !== v.body) planFail('body-mismatch', p, 'Layer body must match the plan');
    if (layers.has(layer.id)) planFail('duplicate-id', p, 'Duplicate layer ID'); layers.add(layer.id);
    if (layer.coordinates !== undefined && serializeSurfacePlan(layer.coordinates) !== serializeSurfacePlan(v.coordinates)) {
      planFail('unsupported-transform', p, 'All ROI layers must use the plan coordinate conventions');
    }
  }
  array(v.regions, '$.regions', 32);
  const ids = new Set<string>();
  for (const [i, r] of v.regions.entries()) {
    const p = `$.regions[${i}]`; object(r, p);
    keys(r, ['id', 'feature', 'imagery', 'elevation', 'priority', 'fallback'], p);
    string(r.id, `${p}.id`);
    if (ids.has(r.id)) planFail('duplicate-id', p, 'Duplicate region ID'); ids.add(r.id);
    object(r.feature, `${p}.feature`); keys(r.feature, ['layerId', 'featureId'], `${p}.feature`);
    string(r.feature.layerId, `${p}.feature.layerId`); string(r.feature.featureId, `${p}.feature.featureId`);
    if (!layers.has(r.feature.layerId)) planFail('unresolved-reference', p, 'Unknown layer ID');
    if (!/^(string:.+|number:.+)$/.test(r.feature.featureId)) planFail('unstable-id', p, 'Use an explicit typed GeoJSON feature ID (string: or number:)');
    if (r.imagery === undefined && r.elevation === undefined) planFail('schema', p, 'Request imagery and/or elevation');
    for (const channel of ['imagery', 'elevation']) {
      const f = r[channel]; if (f === undefined) continue;
      object(f, `${p}.${channel}`); keys(f, ['gsdM', 'accuracyM'], `${p}.${channel}`);
      positive(f.gsdM, `${p}.${channel}.gsdM`);
      if (f.accuracyM !== undefined) positive(f.accuracyM, `${p}.${channel}.accuracyM`);
    }
    if (r.priority !== undefined) integer(r.priority, `${p}.priority`, 0, 1_000_000);
    if (r.fallback !== undefined && !['require-target', 'allow-coarser', 'leave-unavailable'].includes(String(r.fallback))) planFail('schema', `${p}.fallback`, 'Unsupported fallback preference');
  }
  if (v.budget !== undefined) {
    object(v.budget, '$.budget'); keys(v.budget, ['publishedBytes'], '$.budget');
    integer(v.budget.publishedBytes, '$.budget.publishedBytes', 1);
  }
  return v as unknown as DesiredSurfacePlan;
}

/** Resolves only supplied text. Embedded data wins; external content becomes part of the snapshot identity. */
export function resolveSurfacePlan(plan: DesiredSurfacePlan, references: ReadonlyMap<string, string> = new Map()): {
  desired: DesiredSurfacePlan; layers: GeographicLayer[]; diagnostics: SurfacePlanDiagnostic[];
} {
  validateDesiredSurfacePlan(plan);
  const desired = JSON.parse(serializeSurfacePlan(plan)) as DesiredSurfacePlan;
  const diagnostics: SurfacePlanDiagnostic[] = [];
  let vertices = 0;
  const layers = desired.layers.map((l, i) => {
    const path = `$.layers[${i}]`;
    const text = l.geojson === undefined ? references.get(l.source) : serializeSurfacePlan(l.geojson);
    if (text === undefined) planFail('unresolved-reference', path, `No local GeoJSON supplied for ${l.source}`);
    let parsed: GeographicLayer;
    try {
      parsed = parseGeographicGeoJson(text, l, { kind: 'local-file', identity: l.source }, plan.coordinates,
        { maxVertices: 4096, maxFeatures: 64 });
    } catch (e) { return planFail('invalid-geometry', path, String(e)); }
    const errors = parsed.diagnostics.filter(d => d.severity === 'error');
    if (errors.length) planFail('invalid-geometry', path, errors.map(d => d.message).join('; '));
    for (const d of parsed.diagnostics) diagnostics.push({ ...d, path });
    for (const f of parsed.features) {
      if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') planFail('unsupported-shape', path, 'Surface ROIs must be Polygon or MultiPolygon; buffer points/lines explicitly');
      const count = (v: unknown): number => Array.isArray(v) ? (typeof v[0] === 'number' ? 1 : v.reduce((s: number, x) => s + count(x), 0)) : 0;
      vertices += count(f.geometry.coordinates);
    }
    if (vertices > 4096) planFail('limits', path, 'Plan exceeds 4096 vertices');
    l.geojson = JSON.parse(text);
    return parsed;
  });
  for (const r of plan.regions) {
    const layer = layers.find(l => l.id === r.feature.layerId)!;
    if (!layer.features.some(f => f.id === r.feature.featureId)) planFail('unresolved-reference', `$.regions.${r.id}`, `Feature ${r.feature.featureId} not found`);
  }
  return { desired, layers, diagnostics };
}

export function validateSurfaceSources(v: unknown): SurfaceSourceDescriptor[] {
  serializeSurfacePlan(v); array(v, '$.sources', 32, 0);
  const ids = new Set<string>();
  for (const [i, s] of v.entries()) {
    const p = `$.sources[${i}]`; object(s, p);
    keys(s, ['id', 'productId', 'channel', 'body', 'frame', 'coordinates', 'footprint', 'nodata', 'nativeGsdM', 'accuracyM', 'projection', 'datum', 'asset', 'license'], p);
    for (const k of ['id', 'productId', 'body', 'frame', 'projection']) string(s[k], `${p}.${k}`);
    if (ids.has(s.id as string)) planFail('duplicate-id', p, 'Duplicate source ID'); ids.add(s.id as string);
    if (!['imagery', 'elevation'].includes(String(s.channel))) planFail('schema', `${p}.channel`, 'Expected imagery or elevation');
    coordinates(s.coordinates, `${p}.coordinates`);
    for (const k of ['nativeGsdM', 'accuracyM']) if (s[k] !== null) positive(s[k], `${p}.${k}`);
    if (s.nodata !== 'none' && s.nodata !== 'unknown') {
      object(s.nodata, `${p}.nodata`); keys(s.nodata, ['maskUrl'], `${p}.nodata`); string(s.nodata.maskUrl, `${p}.nodata.maskUrl`);
    }
    object(s.datum, `${p}.datum`); keys(s.datum, ['referenceShape', 'verticalDatum', 'heightConvention'], `${p}.datum`);
    coordinates({ ...(s.coordinates as object), referenceShape: s.datum.referenceShape, height: undefined }, `${p}.datum.referenceShape`);
    if (!['ellipsoid', 'reference-sphere', 'areoid', 'unknown'].includes(String(s.datum.verticalDatum))
      || !['radial', 'geodetic-normal'].includes(String(s.datum.heightConvention))) planFail('unsupported-datum', p, 'Unsupported source datum');
    object(s.asset, `${p}.asset`); keys(s.asset, ['url', 'retrieval', 'version', 'checksum', 'bytes'], `${p}.asset`);
    if (s.asset.url === undefined && s.asset.retrieval === undefined) planFail('schema', `${p}.asset`, 'Supply a stable URL or documented retrieval');
    for (const k of ['url', 'retrieval', 'version']) if (s.asset[k] !== undefined) string(s.asset[k], `${p}.asset.${k}`);
    if (s.asset.bytes !== undefined) integer(s.asset.bytes, `${p}.asset.bytes`);
    if (s.asset.checksum !== undefined) {
      object(s.asset.checksum, `${p}.asset.checksum`); keys(s.asset.checksum, ['algorithm', 'value'], `${p}.asset.checksum`);
      if (s.asset.checksum.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/.test(String(s.asset.checksum.value))) planFail('schema', p, 'Expected a lowercase SHA-256 checksum');
    }
    object(s.license, `${p}.license`); keys(s.license, ['name', 'attribution', 'url'], `${p}.license`);
    string(s.license.name, `${p}.license.name`); string(s.license.attribution, `${p}.license.attribution`);
    if (s.license.url !== undefined) string(s.license.url, `${p}.license.url`);
    if (s.footprint !== undefined) parseSurfaceSourceFootprint(s as unknown as SurfaceSourceDescriptor);
  }
  return v as unknown as SurfaceSourceDescriptor[];
}

export function parseSurfaceSourceFootprint(s: SurfaceSourceDescriptor): GeographicLayer | null {
  if (s.footprint === undefined) return null;
  const path = `sources.${s.id}.footprint`;
  let layer: GeographicLayer;
  try {
    layer = parseGeographicGeoJson(serializeSurfacePlan(s.footprint),
      { id: s.id, name: s.id, body: s.body, source: s.id, coordinates: s.coordinates },
      { kind: 'local-file', identity: s.id }, undefined, { maxVertices: 4096, maxFeatures: 64 });
  } catch (e) { return planFail('invalid-source-footprint', path, String(e)); }
  if (layer.skippedFeatures || !layer.features.length) planFail('invalid-source-footprint', path, layer.diagnostics.map(d => d.message).join('; ') || 'Empty footprint');
  if (layer.features.some(f => f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) planFail('unsupported-shape', path, 'Source footprints must be Polygon or MultiPolygon');
  return layer;
}

export async function createLockedSurfacePlan(input: Omit<LockedSurfacePlan, 'identity' | 'desiredIdentity'>): Promise<LockedSurfacePlan> {
  const desiredIdentity = await surfacePlanIdentity(input.desired);
  const payload = { ...input, desiredIdentity };
  const lock = { ...payload, identity: await surfacePlanIdentity(payload) };
  return validateLockedSurfacePlan(lock);
}
export async function validateLockedSurfacePlan(v: unknown): Promise<LockedSurfacePlan> {
  serializeSurfacePlan(v); object(v, '$');
  keys(v, ['version', 'kind', 'identity', 'desiredIdentity', 'desired', 'sources', 'selections', 'processing', 'output'], '$');
  if (v.version !== 1 || v.kind !== 'locked-surface-plan') planFail('version-kind', '$', 'Expected version 1 locked-surface-plan');
  const desired = validateDesiredSurfacePlan(v.desired);
  if (desired.layers.some(l => l.geojson === undefined)) planFail('unresolved-reference', '$.desired.layers', 'Locked plans must embed all referenced GeoJSON');
  const resolved = resolveSurfacePlan(desired);
  const roiGeometries = new Map(desired.regions.map(r => {
    const layer = resolved.layers.find(l => l.id === r.feature.layerId)!;
    const feature = layer.features.find(f => f.id === r.feature.featureId)!;
    return [r.id, surfaceFeatureGeometry(feature, desired.coordinates)];
  }));
  const sources = validateSurfaceSources(v.sources);
  for (const s of sources) {
    if (!s.asset.version && !s.asset.checksum) planFail('unpinned-source', `$.sources.${s.id}`, 'Lock requires a source version or checksum');
    if (!s.footprint || s.nativeGsdM === null || s.datum.verticalDatum === 'unknown') planFail('unresolved-source', `$.sources.${s.id}`, 'Lock requires footprint, native GSD, and known datum');
  }
  array(v.selections, '$.selections', 64);
  const selected = new Set<string>(), usedSources = new Set<string>();
  for (const [i, s] of v.selections.entries()) {
    const p = `$.selections[${i}]`; object(s, p);
    keys(s, ['regionId', 'channel', 'sourceIds', 'outputGsdM', 'resampling', 'transformations'], p);
    const region = desired.regions.find(r => r.id === s.regionId);
    if (!region || (s.channel !== 'imagery' && s.channel !== 'elevation') || !region[s.channel]) planFail('unresolved-reference', p, 'Selection must reference a requested region/channel');
    const key = `${s.regionId}/${s.channel}`;
    if (selected.has(key)) planFail('duplicate-id', p, 'Duplicate region/channel selection'); selected.add(key);
    positive(s.outputGsdM, `${p}.outputGsdM`);
    if (!['nearest', 'bilinear', 'cubic'].includes(String(s.resampling))) planFail('schema', p, 'Unsupported resampling');
    array(s.transformations, `${p}.transformations`, 32); s.transformations.forEach(t => string(t, `${p}.transformations`));
    if (s.transformations.length !== 1 || s.transformations[0] !== 'identity') planFail('unsupported-transform', `${p}.transformations`, 'v1 supports exactly ["identity"]; arbitrary or descriptive transforms are not executable');
    const target = region[s.channel]!;
    const allowCoarser = region.fallback === 'allow-coarser';
    if (!allowCoarser && s.outputGsdM > target.gsdM) planFail('unmet-fidelity', `${p}.outputGsdM`, 'Output GSD exceeds the requested target without allow-coarser fallback');
    const roi = roiGeometries.get(region.id)!;
    const area = surfaceAreaM2(roi, desired.coordinates);
    if (area <= 1e-8) planFail('impossible-area', p, 'ROI is below numerical area precision');
    const tolerance = Math.max(Number.EPSILON, area * 1e-8);
    array(s.sourceIds, `${p}.sourceIds`, 32);
    const localIds = new Set<unknown>();
    const coverage = [], adequateCoverage = [];
    for (const id of s.sourceIds) {
      const source = sources.find(x => x.id === id);
      if (!source || source.channel !== s.channel || source.body !== desired.body) planFail('unresolved-reference', p, 'Source must match channel and body');
      if (localIds.has(id)) planFail('duplicate-id', p, 'Duplicate source selection'); localIds.add(id); usedSources.add(source.id);
      if (source.frame !== desired.frame || serializeSurfacePlan(source.coordinates) !== serializeSurfacePlan(desired.coordinates)
        || serializeSurfacePlan(source.datum) !== serializeSurfacePlan(geographicDatum(desired.coordinates))) {
        planFail('unsupported-transform', p, `Identity cannot transform source ${source.id}: frame, coordinates and datum must match the desired plan`);
      }
      if (source.nodata !== 'none') planFail('unresolved-coverage', p, `Source ${source.id} has unknown/masked nodata; v1 locks require resolved, unmasked coverage`);
      const footprint = parseSurfaceSourceFootprint(source)!;
      const geometry = unionGeometry(footprint.features.map(f => surfaceFeatureGeometry(f, source.coordinates)));
      const overlap = intersectGeometry(roi, geometry);
      if (!overlap.length || surfaceAreaM2(overlap, desired.coordinates) <= 0) planFail('disjoint-source', p, `Source ${source.id} does not intersect the selected ROI with positive area`);
      coverage.push(overlap);
      if ((allowCoarser || source.nativeGsdM! <= target.gsdM)
        && (target.accuracyM === undefined || (source.accuracyM !== null && source.accuracyM <= target.accuracyM))) adequateCoverage.push(overlap);
    }
    if (surfaceAreaM2(subtractGeometry(roi, unionGeometry(coverage)), desired.coordinates) > tolerance) planFail('insufficient-coverage', p, 'Selected footprints do not cover the ROI; partial/leave-unavailable builds need future explicit masking support');
    if (surfaceAreaM2(subtractGeometry(roi, unionGeometry(adequateCoverage)), desired.coordinates) > tolerance) planFail('unmet-fidelity', p, 'Selected native resolution/accuracy cannot meet the requested physical fidelity throughout the ROI');
  }
  for (const r of desired.regions) for (const c of ['imagery', 'elevation'] as const) {
    if (r[c] && !selected.has(`${r.id}/${c}`)) planFail('unresolved-reference', '$.selections', `Missing explicit selection for ${r.id}/${c}`);
  }
  if (usedSources.size !== sources.length) planFail('unused-source', '$.sources', 'Every locked source must be selected');
  object(v.processing, '$.processing'); keys(v.processing, ['generator', 'fusion', 'parameters'], '$.processing');
  object(v.processing.generator, '$.processing.generator'); keys(v.processing.generator, ['name', 'version'], '$.processing.generator');
  string(v.processing.generator.name, '$.processing.generator.name'); string(v.processing.generator.version, '$.processing.generator.version');
  string(v.processing.fusion, '$.processing.fusion'); object(v.processing.parameters, '$.processing.parameters');
  object(v.output, '$.output'); keys(v.output, ['representation', 'formatVersion', 'tileSize', 'gutter', 'imageryEncoding', 'elevationEncoding'], '$.output');
  if (v.output.representation !== 'tiled-raster-pyramid') planFail('schema', '$.output', 'Unsupported output representation');
  for (const k of ['formatVersion', 'imageryEncoding', 'elevationEncoding']) string(v.output[k], `$.output.${k}`);
  integer(v.output.tileSize, '$.output.tileSize', 16, 8192); integer(v.output.gutter, '$.output.gutter', 0, 64);
  const { identity, ...payload } = v;
  if (v.desiredIdentity !== await surfacePlanIdentity(desired) || identity !== await surfacePlanIdentity(payload)) planFail('identity-mismatch', '$', 'Content changed: create a new lock identity');
  return v as unknown as LockedSurfacePlan;
}
