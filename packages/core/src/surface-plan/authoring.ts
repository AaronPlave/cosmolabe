/**
 * Authoring helpers for the graphical surface data planner (#250).
 *
 * These are pure, renderer-free edits of a version 1 `DesiredSurfacePlan`
 * (#248). The planner never invents a second geometry model: a region always
 * refers to a planetary GeoJSON feature (#196) by its typed stable ID, and the
 * referenced feature is copied — never moved or modified — into an embedded
 * plan layer whose provenance records where it came from. Every helper returns
 * a new plan; inputs are never mutated.
 */
import type { MultiPolygon } from 'polygon-clipping';
import { bodyFixedFrameName } from '../frames/FrameRegistry.js';
import type { GeographicCoordinates, GeographicFeature, GeographicLayer, JsonValue } from '../geographic/model.js';
import type {
  DesiredSurfacePlan, SurfaceChannel, SurfaceFeatureCollection, SurfaceFidelity, SurfaceFidelityAssessment, SurfacePlanLayer,
  SurfacePlanRegion, SurfaceSourceDescriptor,
} from './model.js';
import { planFail } from './model.js';
import { estimateSurfacePlan } from './estimate.js';
import { serializeSurfacePlan } from './validation.js';

/** What a region asks for. Elevation is never implied by imagery, and vice versa. */
export type SurfaceOutputIntent = 'imagery' | 'imagery-elevation' | 'elevation';

export interface SurfaceFidelityPreset {
  id: 'orbit-context' | 'descent' | 'local-operations';
  label: string;
  description: string;
  imagery: SurfaceFidelity;
  elevation: SurfaceFidelity;
  priority: number;
  fallback: NonNullable<SurfacePlanRegion['fallback']>;
}

/**
 * Small, explicit starting points. Values are requested output sampling and
 * maximum source uncertainty, never claims about any product's achieved accuracy.
 * Every value stays editable after a preset is applied.
 */
export const SURFACE_FIDELITY_PRESETS: readonly SurfaceFidelityPreset[] = Object.freeze([
  { id: 'orbit-context', label: 'Orbit / context', description: 'Regional context seen from orbit or approach.',
    imagery: { gsdM: 50 }, elevation: { gsdM: 200 }, priority: 0, fallback: 'allow-coarser' },
  { id: 'descent', label: 'Descent', description: 'Entry, descent and landing corridor detail.',
    imagery: { gsdM: 1 }, elevation: { gsdM: 10 }, priority: 10, fallback: 'allow-coarser' },
  { id: 'local-operations', label: 'Local operations', description: 'Touchdown and surface-operations detail.',
    imagery: { gsdM: 0.25 }, elevation: { gsdM: 1, accuracyM: 0.5 }, priority: 100, fallback: 'require-target' },
] as const satisfies readonly SurfaceFidelityPreset[]);

export function surfaceFidelityPreset(id: string): SurfaceFidelityPreset | undefined {
  return SURFACE_FIDELITY_PRESETS.find(p => p.id === id);
}

/** The preset a region's values exactly match, if any; otherwise the values are custom. */
export function matchingSurfacePreset(region: SurfacePlanRegion): SurfaceFidelityPreset | undefined {
  return SURFACE_FIDELITY_PRESETS.find(p => (!region.imagery || same(region.imagery, p.imagery))
    && (!region.elevation || same(region.elevation, p.elevation))
    && (region.priority ?? 0) === p.priority && (region.fallback ?? 'require-target') === p.fallback);
}

export function surfaceRegionIntent(region: Pick<SurfacePlanRegion, 'imagery' | 'elevation'>): SurfaceOutputIntent {
  return region.imagery && region.elevation ? 'imagery-elevation' : region.elevation ? 'elevation' : 'imagery';
}

const same = (a: unknown, b: unknown) => serializeSurfacePlan(a) === serializeSurfacePlan(b);
const clone = <T>(v: T): T => JSON.parse(serializeSurfacePlan(v)) as T;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

/**
 * The plan conventions a layer's coordinates imply. A coordinate `frame` is kept
 * out of the plan only when it names the shared IAU body-fixed frame; any other
 * frame (for example `MOON_ME_DE421`) is not interchangeable and is refused.
 */
export function surfacePlanCoordinatesFor(body: string, coordinates: GeographicCoordinates): GeographicCoordinates {
  const expected = bodyFixedFrameName(body);
  if (coordinates.frame !== undefined && coordinates.frame !== expected) {
    planFail('unsupported-frame', '$.coordinates.frame', `${coordinates.frame} is not interchangeable with ${expected}; surface plans v1 support only the shared IAU body-fixed frame and no implicit frame transform`);
  }
  const { frame: _frame, ...rest } = coordinates;
  return clone(rest);
}

/** An empty plan for a body. It becomes a valid #248 document once it has a region. */
export function createSurfacePlanDraft(body: string, coordinates: GeographicCoordinates): DesiredSurfacePlan {
  return { version: 1, kind: 'desired-surface-plan', body, frame: bodyFixedFrameName(body),
    coordinates: surfacePlanCoordinatesFor(body, coordinates), layers: [], regions: [] };
}

/** Why a feature cannot become a region of `plan`, or null when it can. */
export function surfaceRegionRefusal(plan: DesiredSurfacePlan, layer: GeographicLayer, feature: GeographicFeature): string | null {
  if (layer.body !== plan.body) return `${layer.name} is on ${layer.body}; this plan is for ${plan.body}.`;
  let coordinates: GeographicCoordinates;
  try { coordinates = surfacePlanCoordinatesFor(plan.body, layer.coordinates); }
  catch (e) { return e instanceof Error ? e.message : String(e); }
  const empty = !plan.layers.length && !plan.regions.length;
  if (!empty && !same(coordinates, plan.coordinates)) {
    return `${layer.name} uses different coordinate conventions or reference shape from this plan; no implicit conversion is made. Copy the shape into a layer with the plan's conventions.`;
  }
  const type = feature.geometry.type;
  if (type !== 'Polygon' && type !== 'MultiPolygon') return 'Surface regions must be polygons; points and paths need an explicit buffer first.';
  if (plan.regions.length >= 32) return 'A plan has at most 32 regions.';
  return null;
}

/** Typed stable ID of a feature as the plan will reference it. */
function planFeatureId(layer: SurfacePlanLayer, feature: GeographicFeature, wanted: string): { id: string; jsonId: string | number } {
  if (feature.sourceId !== undefined) return { id: feature.id, jsonId: feature.sourceId };
  // Source-order features have no stable ID; give the copy an explicit one.
  const taken = new Set((layer.geojson?.features ?? []).map(f => `${typeof f.id}:${f.id}`));
  let jsonId = wanted || 'region';
  for (let n = 2; taken.has(`string:${jsonId}`); n++) jsonId = `${wanted}-${n}`;
  return { id: `string:${jsonId}`, jsonId };
}

export interface SurfaceRegionInput {
  name?: string;
  intent?: SurfaceOutputIntent;
  preset?: SurfaceFidelityPreset['id'];
}

/**
 * Add a region referencing `feature`. The feature's original GeoJSON (holes,
 * properties, foreign members and coordinates as authored) is copied into a plan
 * layer for its source layer; the source layer itself is untouched.
 */
export function addSurfacePlanRegion(plan: DesiredSurfacePlan, layer: GeographicLayer, feature: GeographicFeature,
  input: SurfaceRegionInput = {}): { plan: DesiredSurfacePlan; regionId: string } {
  const refusal = surfaceRegionRefusal(plan, layer, feature);
  if (refusal) planFail('unsupported-region', `$.layers.${layer.id}`, refusal);
  const next = clone(plan);
  if (!next.layers.length && !next.regions.length) next.coordinates = surfacePlanCoordinatesFor(plan.body, layer.coordinates);
  let planLayer = next.layers.find(l => (l.provenance?.sourceLayerId ?? l.id) === layer.id);
  if (!planLayer) {
    if (next.layers.length >= 16) planFail('limits', '$.layers', 'A plan references at most 16 layers');
    let id = slug(layer.id) || 'layer';
    for (let n = 2; next.layers.some(l => l.id === id); n++) id = `${slug(layer.id)}-${n}`;
    planLayer = { id, name: layer.name, body: layer.body, source: layer.source.identity || `${id}.geojson`,
      provenance: { sourceLayerId: layer.id, sourceIdentity: layer.source.identity, sourceKind: layer.source.kind,
        ownership: layer.ownership, readOnlySource: layer.ownership !== 'user', features: {} },
      geojson: { type: 'FeatureCollection', features: [] } };
    next.layers.push(planLayer);
  }
  const name = input.name?.trim() || featureLabel(feature);
  const mapping = (planLayer.provenance!.features ?? {}) as { [key: string]: JsonValue };
  let featureId = Object.keys(mapping).find(k => mapping[k] === feature.id);
  if (!featureId) {
    const { id, jsonId } = planFeatureId(planLayer, feature, slug(name));
    const original = clone(feature.original) as unknown as SurfaceFeatureCollection['features'][number];
    planLayer.geojson!.features.push({ ...original, id: jsonId });
    mapping[id] = feature.id;
    planLayer.provenance!.features = mapping;
    featureId = id;
  }
  let regionId = slug(name) || 'region';
  for (let n = 2; next.regions.some(r => r.id === regionId); n++) regionId = `${slug(name) || 'region'}-${n}`;
  const preset = surfaceFidelityPreset(input.preset ?? 'orbit-context')!;
  const intent = input.intent ?? 'imagery-elevation';
  next.regions.push({ id: regionId, feature: { layerId: planLayer.id, featureId },
    ...(intent !== 'elevation' ? { imagery: { ...preset.imagery } } : {}),
    ...(intent !== 'imagery' ? { elevation: { ...preset.elevation } } : {}),
    priority: preset.priority, fallback: preset.fallback });
  return { plan: next, regionId };
}

export function featureLabel(feature: GeographicFeature): string {
  const p = feature.properties ?? {};
  for (const key of ['name', 'Name', 'NAME', 'title', 'label']) if (typeof p[key] === 'string' && (p[key] as string).trim()) return (p[key] as string).trim();
  return feature.sourceId !== undefined ? String(feature.sourceId) : `Feature ${feature.sourceIndex + 1}`;
}

export interface SurfaceRegionPatch {
  intent?: SurfaceOutputIntent;
  preset?: SurfaceFidelityPreset['id'];
  imagery?: SurfaceFidelity;
  elevation?: SurfaceFidelity;
  priority?: number;
  fallback?: SurfacePlanRegion['fallback'];
}

/** Change a region's request. Switching intent removes or restores a channel, never both at once. */
export function updateSurfacePlanRegion(plan: DesiredSurfacePlan, regionId: string, patch: SurfaceRegionPatch): DesiredSurfacePlan {
  const next = clone(plan);
  const region = next.regions.find(r => r.id === regionId);
  if (!region) planFail('unresolved-reference', `$.regions.${regionId}`, 'Unknown region');
  if (patch.preset) {
    const p = surfaceFidelityPreset(patch.preset);
    if (!p) planFail('schema', `$.regions.${regionId}`, 'Unknown preset');
    if (region.imagery) region.imagery = { ...p.imagery };
    if (region.elevation) region.elevation = { ...p.elevation };
    region.priority = p.priority; region.fallback = p.fallback;
  }
  if (patch.intent) {
    const preset = matchingSurfacePreset(region) ?? surfaceFidelityPreset('orbit-context')!;
    const wantImagery = patch.intent !== 'elevation', wantElevation = patch.intent !== 'imagery';
    if (!wantImagery) delete region.imagery; else region.imagery ??= { ...preset.imagery };
    if (!wantElevation) delete region.elevation; else region.elevation ??= { ...preset.elevation };
  }
  for (const channel of ['imagery', 'elevation'] as const) {
    const f = patch[channel]; if (!f || !region[channel]) continue;
    if (!(f.gsdM > 0) || !Number.isFinite(f.gsdM)) planFail('units', `$.regions.${regionId}.${channel}.gsdM`, 'Expected a positive finite number of meters');
    if (f.accuracyM !== undefined && (!(f.accuracyM > 0) || !Number.isFinite(f.accuracyM))) planFail('units', `$.regions.${regionId}.${channel}.accuracyM`, 'Expected a positive finite number of meters');
    region[channel] = f.accuracyM === undefined ? { gsdM: f.gsdM } : { gsdM: f.gsdM, accuracyM: f.accuracyM };
  }
  if (patch.priority !== undefined) {
    if (!Number.isSafeInteger(patch.priority) || patch.priority < 0 || patch.priority > 1_000_000) planFail('schema', `$.regions.${regionId}.priority`, 'Expected an integer in [0, 1000000]');
    region.priority = patch.priority;
  }
  if (patch.fallback !== undefined) region.fallback = patch.fallback;
  return next;
}

/** Rename a region: its ID becomes the name's slug, as when it was added. Refuses an empty or taken name. */
export function renameSurfacePlanRegion(plan: DesiredSurfacePlan, regionId: string, name: string): { plan: DesiredSurfacePlan; regionId: string } {
  const id = slug(name);
  if (!plan.regions.some(r => r.id === regionId)) planFail('unresolved-reference', `$.regions.${regionId}`, 'Unknown region');
  if (!id) planFail('schema', `$.regions.${regionId}`, 'A name needs at least one letter or digit');
  if (id !== regionId && plan.regions.some(r => r.id === id)) planFail('duplicate-id', `$.regions.${regionId}`, `Another area is already named ${id}`);
  const next = clone(plan);
  next.regions.find(r => r.id === regionId)!.id = id;
  return { plan: next, regionId: id };
}

/** Remove a region and any embedded feature/layer copy no other region uses. */
export function removeSurfacePlanRegion(plan: DesiredSurfacePlan, regionId: string): DesiredSurfacePlan {
  const next = clone(plan);
  next.regions = next.regions.filter(r => r.id !== regionId);
  for (const layer of next.layers) {
    if (!layer.geojson || !layer.provenance?.sourceLayerId) continue;
    const used = new Set(next.regions.filter(r => r.feature.layerId === layer.id).map(r => r.feature.featureId));
    layer.geojson.features = layer.geojson.features.filter(f => used.has(`${typeof f.id}:${f.id}`));
    const mapping = layer.provenance.features as { [key: string]: JsonValue } | undefined;
    if (mapping) for (const key of Object.keys(mapping)) if (!used.has(key)) delete mapping[key];
  }
  next.layers = next.layers.filter(l => !l.provenance?.sourceLayerId || next.regions.some(r => r.feature.layerId === l.id));
  return next;
}

/** Published-byte budget, or none. */
export function setSurfacePlanBudget(plan: DesiredSurfacePlan, publishedBytes: number | null): DesiredSurfacePlan {
  const next = clone(plan);
  if (publishedBytes === null) delete next.budget;
  else {
    if (!Number.isSafeInteger(publishedBytes) || publishedBytes < 1) planFail('schema', '$.budget.publishedBytes', 'Expected a positive integer byte count');
    next.budget = { publishedBytes };
  }
  return next;
}

/** The source feature a plan feature was copied from, when the planner made the copy. */
export function surfaceRegionSource(plan: DesiredSurfacePlan, region: SurfacePlanRegion): { layerId: string; featureId: string } | null {
  const layer = plan.layers.find(l => l.id === region.feature.layerId);
  const sourceLayerId = layer?.provenance?.sourceLayerId;
  const mapping = layer?.provenance?.features as { [key: string]: JsonValue } | undefined;
  const featureId = mapping?.[region.feature.featureId];
  return typeof sourceLayerId === 'string' && typeof featureId === 'string' ? { layerId: sourceLayerId, featureId } : null;
}

/** Whether a region's embedded copy still matches its live source feature (geometry and properties). */
export function surfaceRegionDrift(plan: DesiredSurfacePlan, region: SurfacePlanRegion, source: GeographicFeature): boolean {
  const layer = plan.layers.find(l => l.id === region.feature.layerId);
  const copy = layer?.geojson?.features.find(f => `${typeof f.id}:${f.id}` === region.feature.featureId);
  if (!copy) return false;
  const o = source.original as { geometry?: unknown; properties?: unknown };
  return !same(copy.geometry, o.geometry ?? null) || !same(copy.properties ?? null, o.properties ?? null);
}

/** Replace a region's embedded copy with the current source feature, keeping its ID. */
export function refreshSurfaceRegion(plan: DesiredSurfacePlan, regionId: string, source: GeographicFeature): DesiredSurfacePlan {
  const next = clone(plan);
  const region = next.regions.find(r => r.id === regionId);
  const layer = next.layers.find(l => l.id === region?.feature.layerId);
  const index = layer?.geojson?.features.findIndex(f => `${typeof f.id}:${f.id}` === region!.feature.featureId) ?? -1;
  if (!region || !layer?.geojson || index < 0) planFail('unresolved-reference', `$.regions.${regionId}`, 'No embedded copy to refresh');
  const id = layer.geojson.features[index].id;
  layer.geojson.features[index] = { ...(clone(source.original) as unknown as SurfaceFeatureCollection['features'][number]), id };
  return next;
}

export interface SurfacePlanChanges {
  dirty: boolean;
  added: string[];
  modified: string[];
  removed: string[];
  /** Budget, body or conventions changed. */
  planLevel: boolean;
}

/** Uncommitted changes of `draft` against the last exported or imported plan. */
export function surfacePlanChanges(base: DesiredSurfacePlan | null, draft: DesiredSurfacePlan): SurfacePlanChanges {
  const before = new Map((base?.regions ?? []).map(r => [r.id, r]));
  const after = new Map(draft.regions.map(r => [r.id, r]));
  const geometry = (p: DesiredSurfacePlan | null, r: SurfacePlanRegion) => p?.layers.find(l => l.id === r.feature.layerId)
    ?.geojson?.features.find(f => `${typeof f.id}:${f.id}` === r.feature.featureId) ?? null;
  const added = [...after.keys()].filter(id => !before.has(id));
  const removed = [...before.keys()].filter(id => !after.has(id));
  const modified = [...after.keys()].filter(id => before.has(id)
    && (!same(before.get(id), after.get(id)) || !same(geometry(base, before.get(id)!), geometry(draft, after.get(id)!))));
  const level = (p: DesiredSurfacePlan | null) => p ? serializeSurfacePlan({ body: p.body, frame: p.frame, coordinates: p.coordinates, budget: p.budget ?? null }) : null;
  const planLevel = base !== null && level(base) !== level(draft);
  const dirty = base === null ? draft.regions.length > 0 : planLevel || added.length + removed.length + modified.length > 0
    || serializeSurfacePlan(base) !== serializeSurfacePlan(draft);
  return { dirty, added, modified, removed, planLevel };
}

/**
 * Coverage geometry from discovery (#249) as planetary GeoJSON for display.
 * Discovery clips in east-positive -180..180 longitude, so the collection
 * declares exactly that convention on the plan's reference shape.
 */
export function surfaceCoverageLayer(id: string, name: string, plan: DesiredSurfacePlan, parts: { featureId: string; geometry: MultiPolygon; properties?: { [key: string]: JsonValue } }[]): SurfacePlanLayer {
  const coordinates: GeographicCoordinates = { ...clone(plan.coordinates), longitudeDirection: 'east', longitudeDomain: '-180..180' };
  delete coordinates.height;
  return { id, name, body: plan.body, source: `${id}.geojson`, coordinates,
    geojson: { type: 'FeatureCollection', features: parts.filter(p => p.geometry.length).map(p => ({ type: 'Feature', id: p.featureId,
      properties: p.properties ?? null, geometry: { type: 'MultiPolygon', coordinates: p.geometry.map(poly => poly.map(ring => ring.map(([x, y]) => [x, y] as [number, number]))) } })) } };
}

/** Channels a region requests. */
export function surfaceRegionChannels(region: SurfacePlanRegion): SurfaceChannel[] {
  return (['imagery', 'elevation'] as const).filter(c => region[c] !== undefined);
}

/**
 * Fidelity of each region under only the sources selected for it. The global
 * estimator pools every source it is given, so a source chosen for region A
 * would otherwise satisfy region B; here each region is assessed alone.
 */
export async function surfaceSelectedFidelity(plan: DesiredSurfacePlan,
  sourcesFor: (regionId: string) => SurfaceSourceDescriptor[]): Promise<Record<string, SurfaceFidelityAssessment>> {
  const { budget: _budget, ...rest } = plan;
  const out: Record<string, SurfaceFidelityAssessment> = {};
  for (const region of plan.regions) {
    out[region.id] = (await estimateSurfacePlan({ ...rest, regions: [region] }, { sources: sourcesFor(region.id) })).fidelity;
  }
  return out;
}

/** The part of a #251 build's `planner-feedback.json` (contract v1) the planner reads. */
export interface SurfacePlannerFeedback {
  version: 1;
  kind: 'surface-planner-feedback';
  lockIdentity: string;
  /** Conventions of the requested geometries; absent in older feedback. */
  surface?: SurfaceBuildConventions;
  requested: {
    regionId: string;
    geometry: unknown;
    channels: {
      channel: SurfaceChannel; sourceIds: string[]; outputGsdM: number;
      /** Reported physical accuracy per source; null where upstream evidence is absent. */
      accuracyM: { sourceId: string; accuracyM: number | null }[];
      targetMetByNativeSource: boolean | null; diagnostic: unknown;
    }[];
  }[];
  products: {
    productId: string;
    sourceProofs: { sourceId: string }[];
    /** What was actually produced: output sample spacing per level, coarsest first. */
    emitted: { outputSpacingMByLevel: number[] };
    continuousNativeCoverageStatus: typeof COVERAGE_STATUSES[number];
    publication: { status: typeof PUBLICATION_STATUSES[number] };
  }[];
}

/** The body, frame and coordinate conventions a build's geometries are in. */
export type SurfaceBuildConventions = Pick<DesiredSurfacePlan, 'body' | 'frame' | 'coordinates'>;

const PUBLICATION_STATUSES = ['not-published', 'verified-local-http', 'verified-hosted-http'] as const;
const COVERAGE_STATUSES = ['proved-for-checked-requested-ROI-only', 'not-proved-by-tile-availability'] as const;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T => values.includes(v as T);

/** Validate the planner-feedback fields the planner relies on; unknown enum values are refused, never read as success. */
export function parseSurfacePlannerFeedback(data: unknown): SurfacePlannerFeedback {
  const fail = (path: string, message: string): never => planFail('schema', path, message);
  if (!isObject(data) || data.version !== 1 || data.kind !== 'surface-planner-feedback') fail('$', 'Expected surface-build planner feedback v1');
  const d = data as Record<string, unknown>;
  if (typeof d.lockIdentity !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(d.lockIdentity)) fail('$.lockIdentity', 'Expected a sha256 lock identity');
  if (d.surface !== undefined && (!isObject(d.surface) || typeof d.surface.body !== 'string' || typeof d.surface.frame !== 'string' || !isObject(d.surface.coordinates)
    || !isObject(d.surface.coordinates.referenceShape))) fail('$.surface', 'Expected body, frame and coordinates');
  if (!Array.isArray(d.requested)) fail('$.requested', 'Expected an array');
  (d.requested as unknown[]).forEach((r, i) => {
    if (!isObject(r) || typeof r.regionId !== 'string' || !isObject(r.geometry) || !Array.isArray(r.channels)) fail(`$.requested[${i}]`, 'Expected regionId, geometry and channels');
    (r as { channels: unknown[] }).channels.forEach((c, j) => {
      const path = `$.requested[${i}].channels[${j}]`;
      if (!isObject(c) || !oneOf(['imagery', 'elevation'], c.channel) || !Array.isArray(c.sourceIds) || !c.sourceIds.every(x => typeof x === 'string')
        || typeof c.outputGsdM !== 'number' || !(c.targetMetByNativeSource === null || typeof c.targetMetByNativeSource === 'boolean')) fail(path, 'Malformed channel');
      if (!Array.isArray((c as Record<string, unknown>).accuracyM) || !((c as Record<string, unknown>).accuracyM as unknown[]).every(a => isObject(a)
        && typeof a.sourceId === 'string' && (a.accuracyM === null || (typeof a.accuracyM === 'number' && a.accuracyM > 0)))) fail(`${path}.accuracyM`, 'Expected per-source accuracy or null');
    });
  });
  if (!Array.isArray(d.products)) fail('$.products', 'Expected an array');
  (d.products as unknown[]).forEach((p, i) => {
    const path = `$.products[${i}]`;
    if (!isObject(p) || typeof p.productId !== 'string' || !Array.isArray(p.sourceProofs) || !p.sourceProofs.every(x => isObject(x) && typeof x.sourceId === 'string')) fail(path, 'Malformed product');
    const q = p as Record<string, unknown>;
    const spacing = isObject(q.emitted) ? q.emitted.outputSpacingMByLevel : undefined;
    if (!Array.isArray(spacing) || !spacing.every(m => typeof m === 'number' && m > 0 && Number.isFinite(m))) fail(`${path}.emitted.outputSpacingMByLevel`, 'Expected positive output spacings');
    if (!oneOf(COVERAGE_STATUSES, q.continuousNativeCoverageStatus)) fail(`${path}.continuousNativeCoverageStatus`, `Unknown coverage status ${String(q.continuousNativeCoverageStatus)}`);
    if (!isObject(q.publication) || !oneOf(PUBLICATION_STATUSES, q.publication.status)) fail(`${path}.publication.status`, `Unknown publication status ${String((q.publication as { status?: unknown })?.status)}`);
  });
  return data as unknown as SurfacePlannerFeedback;
}

/**
 * `published`: published, with coverage proved for the requested ROI and every
 * requested target evidenced. `published-unproven`: published, but coverage or
 * accuracy is not proved for this request; unknown is not success.
 */
export type SurfaceBuildStatus = 'published' | 'published-unproven' | 'built' | 'coarser' | 'needs-build' | 'unknown';

/**
 * Whether a region's channel is already served by a build in `feedback`, or
 * would need a new one. Compatibility is per region, not by lock identity, so a
 * reusable product still matches from another lock: same body, frame and
 * coordinate conventions, region ID and embedded geometry, achieved output
 * spacing at least as fine as requested, reported accuracy within any
 * requested limit and, when given, the same selected sources. The build's
 * conventions come from the feedback itself or, for older feedback, from
 * `conventions` (its lock, when known); without either a product is at most
 * unproven. No feedback means unknown, never absent.
 */
export function surfaceRegionBuildStatus(plan: DesiredSurfacePlan, feedback: SurfacePlannerFeedback | null, regionId: string,
  channel: SurfaceChannel, selectedSourceIds: readonly string[] | null = null,
  conventions: SurfaceBuildConventions | null = null): { status: SurfaceBuildStatus; detail: string } {
  if (!feedback) return { status: 'unknown', detail: 'No build feedback loaded; whether a published product exists is unknown.' };
  const build = feedback.surface ?? conventions;
  if (build && (build.body !== plan.body || build.frame !== plan.frame || !same(build.coordinates, plan.coordinates))) {
    return { status: 'needs-build', detail: `The build is on ${build.body} (${build.frame}) in other coordinate conventions; its coordinates do not describe this plan.` };
  }
  const region = plan.regions.find(r => r.id === regionId);
  const target = region?.[channel];
  const requested = feedback.requested.find(r => r.regionId === regionId);
  const built = requested?.channels.find(c => c.channel === channel);
  if (!region || !target || !requested || !built) return { status: 'needs-build', detail: `The loaded build has no ${channel} for ${regionId}.` };
  const copy = plan.layers.find(l => l.id === region.feature.layerId)?.geojson?.features.find(f => `${typeof f.id}:${f.id}` === region.feature.featureId);
  if (!copy || !same(copy.geometry, requested.geometry)) return { status: 'needs-build', detail: 'The region\'s shape differs from the built one.' };
  if (built.outputGsdM > target.gsdM) return { status: 'needs-build', detail: `Built at ${built.outputGsdM} m, coarser than the requested ${target.gsdM} m.` };
  if (selectedSourceIds && !same([...selectedSourceIds].sort(), [...built.sourceIds].sort())) return { status: 'needs-build', detail: `Built from ${built.sourceIds.join(', ')}, not the selected sources.` };
  const accuracies = built.sourceIds.map(id => built.accuracyM.find(a => a.sourceId === id)?.accuracyM ?? null);
  if (target.accuracyM !== undefined && accuracies.some(a => a !== null && a > target.accuracyM!)) {
    return { status: 'needs-build', detail: `Reported source accuracy ${Math.max(...accuracies.filter((a): a is number => a !== null))} m exceeds the requested ${target.accuracyM} m limit.` };
  }
  const products = feedback.products.filter(p => p.sourceProofs.some(s => built.sourceIds.includes(s.sourceId)));
  if (!products.length) return { status: 'unknown', detail: 'The build feedback names no product for these sources.' };
  const achieved = Math.min(...products.flatMap(p => p.emitted.outputSpacingMByLevel));
  if (achieved > target.gsdM * (1 + 1e-9)) return { status: 'needs-build', detail: `Finest output produced is ${+achieved.toPrecision(3)} m, coarser than the requested ${target.gsdM} m.` };
  if (built.targetMetByNativeSource === false) return { status: 'coarser', detail: 'Built, but its native sources do not meet the target; coarser data was kept under the fallback policy.' };
  const unproven = [
    ...(build ? [] : ['this feedback does not state the build\'s body, frame and coordinate conventions, and its lock was not opened']),
    ...(products.every(p => p.continuousNativeCoverageStatus === 'proved-for-checked-requested-ROI-only') ? [] : ['continuous coverage of the ROI is not proved by tile availability']),
    ...(built.targetMetByNativeSource === null ? ['whether native sources meet the target is unknown'] : []),
    ...(target.accuracyM !== undefined && accuracies.some(a => a === null) ? [`source accuracy is unreported against the ${target.accuracyM} m limit`] : []),
  ];
  if (products.some(p => p.publication.status === 'not-published')) {
    return { status: 'built', detail: `Built but not published${unproven.length ? `; ${unproven.join('; ')}` : ''}.` };
  }
  const where = products.map(p => p.publication.status === 'verified-hosted-http' ? 'hosted' : 'local').join(', ');
  return unproven.length
    ? { status: 'published-unproven', detail: `Published (${where}), but ${unproven.join('; ')}.` }
    : { status: 'published', detail: `Published (${where}); coverage proved for the requested ROI.` };
}
