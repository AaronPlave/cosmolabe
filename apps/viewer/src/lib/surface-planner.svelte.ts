/**
 * Surface data planner (#250): an opt-in authoring workspace for #248 desired
 * plans, over the same 3D scene, geographic layers, drawing tools and selection
 * as the rest of the viewer.
 *
 * The planner owns only its draft and the inputs the user gave it. Regions are
 * existing geographic features (catalog, imported or drawn with #200), copied
 * into the plan without touching their source. Discovery (#249) and the
 * estimator (#248) are the core functions the CLI uses, run on local fixture
 * metadata only: nothing here downloads a raster, contacts an archive, holds a
 * credential or runs a build.
 *
 * On the globe it shows, separately and only for the region in focus: the
 * desired ROIs (1), the selected candidates' archive footprints (2a) and the
 * confirmed valid / unknown / gap coverage of the selected products (2b), and
 * the ROI a loaded #251 build-feedback file says a build was requested for (3);
 * that is a requested build ROI, not observed achieved coverage. Live tile
 * residency (4) is not planner data and is never drawn as if it were.
 */
import {
  GEOGRAPHIC_STYLE_VERSION, addSurfacePlanRegion, createLockedSurfacePlan, createSurfacePlanDraft, discoveryEstimatorSources,
  estimateSurfacePlan, parseGeographicGeoJson, recommendSurfaceSources, refreshSurfaceRegion, removeSurfacePlanRegion,
  renameSurfacePlanRegion, resolveSurfacePlan, serializeSurfacePlan, setSurfacePlanBudget, surfaceCoverageLayer, surfacePlanChanges, surfaceRegionChannels,
  surfaceRegionDrift, surfaceRegionRefusal, surfaceRegionSource, updateSurfacePlanRegion, validateDesiredSurfacePlan,
  validateLockedSurfacePlan, validateSurfaceSources, SurfacePlanError, parseSurfacePlannerFeedback, surfaceRegionBuildStatus,
  surfaceSelectedFidelity, surfacePlanCoordinatesFor, type SurfaceBuildConventions, type SurfaceFidelityAssessment, type SurfacePlannerFeedback,
  type DesiredSurfacePlan, type GeographicFeature, type GeographicLayer, type GeographicLayerLoad, type GeographicLayerStyle,
  type LockedSurfacePlan, type SurfaceChannel, type SurfaceDiscoveryPolicy, type SurfaceDiscoveryRecord, type SurfaceDiscoveryReport,
  type SurfacePlanDiagnostic, type SurfacePlanEstimate, type SurfacePlanLayer, type SurfaceRegionInput, type SurfaceRegionPatch,
  type SurfaceSourceCombination, type SurfaceSourceDescriptor,
} from '@cosmolabe/core';
import { untrack } from 'svelte';
import { getRenderer, onViewerEvent } from './viewer-state.svelte';
import { getUniverse } from './loader';
import { findFeature, geo, goToFeature, isPlannerDisplayLayer, selectFeature } from './geographic-layers.svelte';
import { setLayerStyle } from './geographic-styles.svelte';
import { bodyReferenceShape, createLayer, editLayers, edits, inferredCoordinates, matchesDrawFrame, setDrawTool } from './geographic-editing.svelte';

/** Scene-store owner for the planner's display layers. */
export const PLANNER_OWNER = 'cosmolabe:surface-planner';
/** Scene-store owner for the read-only example ROIs the planner can load. */
export const PLANNER_EXAMPLE_OWNER = 'cosmolabe:surface-planner-example';
/** Every display layer the planner installs starts with `planner:`. */
export const isPlannerLayer = isPlannerDisplayLayer;

const LAYER = {
  desired: 'planner:desired',
  footprints: 'planner:source-footprints',
  verified: 'planner:verified-coverage',
  unknown: 'planner:unknown-coverage',
  gap: 'planner:coverage-gaps',
  built: 'planner:built-product',
} as const;

/** Legend: what each display layer is, and is not. Colours are shared with the panel. */
export const PLANNER_LEGEND = [
  { id: LAYER.desired, color: '#f2c14e', label: 'Your area', detail: 'The area you asked for (labelled with its name); says nothing about data.' },
  { id: LAYER.footprints, color: '#9aa7b8', label: 'Product footprint', detail: 'Where the chosen product says it lies (labelled with its product ID); not proof of valid pixels.' },
  { id: LAYER.verified, color: '#4cc38a', label: 'Confirmed valid', detail: 'Independently evidenced valid pixels of the selected sources.' },
  { id: LAYER.unknown, color: '#d9a03f', label: 'Validity unknown', detail: 'Inside a footprint, but pixel validity is not evidenced.' },
  { id: LAYER.gap, color: '#e5575c', label: 'Gap', detail: 'Not covered by the selected sources (not an archive-wide absence).' },
  { id: LAYER.built, color: '#6aa8ff', label: 'Requested build ROI', detail: 'The ROI a loaded build was requested for; not observed achieved valid coverage.' },
] as const;

const STYLES: Record<string, GeographicLayerStyle> = {
  // The area is the boldest, labelled shape; a footprint is a faint thin outline, labelled by product.
  [LAYER.desired]: { version: GEOGRAPHIC_STYLE_VERSION, polygon: { fillOpacity: 0.18, outlineWidthPx: 3.5 }, labels: { field: null, halo: true } },
  [LAYER.footprints]: { version: GEOGRAPHIC_STYLE_VERSION, polygon: { fillOpacity: 0, outlineWidthPx: 1, outlineOpacity: 0.7 }, labels: { field: null, maxLabels: 3, halo: true } },
  [LAYER.verified]: { version: GEOGRAPHIC_STYLE_VERSION, polygon: { fillOpacity: 0.28, outlineWidthPx: 1 } },
  [LAYER.unknown]: { version: GEOGRAPHIC_STYLE_VERSION, polygon: { fillOpacity: 0.22, hatch: true, outlineWidthPx: 1 } },
  [LAYER.gap]: { version: GEOGRAPHIC_STYLE_VERSION, polygon: { fillOpacity: 0.25, hatch: true, outlineWidthPx: 1 } },
  [LAYER.built]: { version: GEOGRAPHIC_STYLE_VERSION, polygon: { fillOpacity: 0, outlineWidthPx: 3 } },
};

export type PlannerSourceInput =
  | { kind: 'none' }
  | { kind: 'inventory'; label: string; records: SurfaceDiscoveryRecord[] }
  /** Bare descriptors (e.g. a lock's sources): estimator evidence only, no discovery ranking. */
  | { kind: 'descriptors'; label: string; sources: SurfaceSourceDescriptor[] };

class SurfacePlannerState {
  /** Bumped on any change the panel shows. */
  revision = $state(0);
  body = $state<string | null>(null);
  plan = $state.raw<DesiredSurfacePlan | null>(null);
  /** The plan as last imported or exported: what "uncommitted" is measured against. */
  base = $state.raw<DesiredSurfacePlan | null>(null);
  /** A lock imported as-is, re-exported unchanged while neither the plan nor its sources change. */
  importedLock = $state.raw<LockedSurfacePlan | null>(null);
  /** Source selections as last locked (exported or imported): what an unlocked source choice is measured against. */
  lockedSelections = $state<string | null>(null);
  /** #251 build feedback: what is already built or published. */
  feedback = $state.raw<{ label: string; data: SurfacePlannerFeedback } | null>(null);
  sources = $state.raw<PlannerSourceInput>({ kind: 'none' });
  policy = $state<SurfaceDiscoveryPolicy>('consistent');
  report = $state.raw<SurfaceDiscoveryReport | null>(null);
  estimate = $state.raw<SurfacePlanEstimate | null>(null);
  /** Per region, fidelity under only the sources selected for it; null when nothing is selected per region. */
  selectedFidelity = $state.raw<Record<string, SurfaceFidelityAssessment> | null>(null);
  /** Diagnostics from the last discovery/estimate run, or why it could not run. */
  problems = $state.raw<SurfacePlanDiagnostic[]>([]);
  /** Why core refuses to lock the current selection, from the last run; null when it locks (or nothing is selectable). */
  lockProblem = $state<string | null>(null);
  /** Region in focus: its candidates and coverage are the only ones drawn. */
  focused = $state<string | null>(null);
  focusChannel = $state<SurfaceChannel>('imagery');
  /** Chosen alternative index per region (default 0, the top recommendation). */
  choice = $state.raw<Record<string, number>>({});
  showCoverage = $state(true);
  /** A region will be made from the next shape drawn. */
  awaitingDraw = $state(false);
  message = $state('');
  busy = $state(false);
}

export const planner = new SurfacePlannerState();

let runToken = 0;
/** The layer a region is being drawn into, and the features it had before: a new one there becomes the region. */
let drawing: { layerId: string; before: Set<string> } | null = null;
/** Conventions of every lock opened this session, by identity: older build feedback does not state its own. */
const lockConventions = new Map<string, SurfaceBuildConventions>();
let runTimer: ReturnType<typeof setTimeout> | undefined;

const describe = (e: unknown): string => e instanceof SurfacePlanError ? e.diagnostics.map(d => d.message).join('; ')
  : e instanceof Error ? e.message : String(e);

// ── Body ──

/** Bodies the planner can georegister against: a sphere or oblate reference shape. */
export function plannerBodies(): string[] {
  const universe = getUniverse();
  if (!universe) return [];
  return universe.getAllBodies().map(b => b.name).filter(name => bodyReferenceShape(name) !== null).sort((a, b) => a.localeCompare(b));
}

export interface PlannerBodyStatus {
  body: string;
  /** Why no plan can be georegistered on this body, if so. */
  blocked: string | null;
  referenceShape: string | null;
  frame: string | null;
  imageryLayers: number;
  /** Physical terrain loaded in the scene, as opposed to the reference shape only. */
  measuredTerrain: boolean;
}

export function plannerBodyStatus(body: string): PlannerBodyStatus {
  const shape = bodyReferenceShape(body);
  const coordinates = inferredCoordinates(body);
  const mesh = getRenderer()?.getBodyMesh(body);
  const radii = getUniverse()?.getBody(body)?.radii;
  return {
    body,
    blocked: shape ? null : radii?.length === 3
      ? `${body}'s reference shape is triaxial or prolate; surface plans v1 need a sphere or oblate ellipsoid, and no coordinates are invented.`
      : `${body} has no evidenced reference shape in this scene, so regions cannot be georegistered.`,
    referenceShape: !shape ? null : shape.kind === 'sphere' ? `Sphere, r = ${shape.radiusKm} km` : `Oblate ellipsoid, ${shape.radiiKm[0]} × ${shape.radiiKm[2]} km`,
    frame: coordinates?.frame ?? null,
    imageryLayers: mesh?.imageryLayers.length ?? 0,
    measuredTerrain: !!mesh?.hasTerrain,
  };
}

/** Start a new, empty plan for a body. */
export function startPlan(body: string): boolean {
  const status = plannerBodyStatus(body);
  if (status.blocked) { planner.message = status.blocked; return false; }
  try {
    planner.plan = createSurfacePlanDraft(body, inferredCoordinates(body)!);
  } catch (e) { planner.message = describe(e); return false; }
  planner.body = body;
  planner.base = null;
  planner.importedLock = null;
  planner.lockedSelections = null;
  planner.focused = null;
  planner.choice = {};
  planner.message = '';
  changed();
  return true;
}

export function closePlan(): void {
  planner.plan = null; planner.base = null; planner.importedLock = null; planner.lockedSelections = null; planner.report = null;
  planner.estimate = null; planner.selectedFidelity = null; planner.problems = []; planner.focused = null; planner.choice = {};
  cancelDrawRegion(); planner.message = '';
  installOverlay();
  planner.revision++;
}

// ── Regions ──

/** The selected geographic feature, when it is not one of the planner's own display layers. */
export function selectedSourceFeature(): { layer: GeographicLayer; feature: GeographicFeature } | null {
  if (!geo.selected || isPlannerLayer(geo.selected.layerId)) return null;
  return findFeature(geo.selected);
}

/** The area already made from this shape, if any: using it again would duplicate it. */
export function regionFromShape(layer: GeographicLayer, feature: GeographicFeature): string | null {
  const plan = planner.plan;
  return plan?.regions.find(r => { const s = surfaceRegionSource(plan, r); return s?.layerId === layer.id && s.featureId === feature.id; })?.id ?? null;
}

export function regionRefusal(layer: GeographicLayer, feature: GeographicFeature): string | null {
  if (!planner.plan) return 'Start a plan first.';
  const existing = regionFromShape(layer, feature);
  return existing ? `This shape is already in the plan as “${existing}”.` : surfaceRegionRefusal(planner.plan, layer, feature);
}

export function addRegion(layer: GeographicLayer, feature: GeographicFeature, input: SurfaceRegionInput = {}): string | null {
  if (!planner.plan) return null;
  try {
    const { plan, regionId } = addSurfacePlanRegion(planner.plan, layer, feature, input);
    planner.plan = plan;
    planner.focused = regionId;
    planner.message = '';
    changed();
    return regionId;
  } catch (e) { planner.message = describe(e); return null; }
}

export function addSelectedRegion(input: SurfaceRegionInput = {}): string | null {
  const found = selectedSourceFeature();
  if (!found) { planner.message = 'Select a polygon on the globe or in Surface layers first.'; return null; }
  const existing = regionFromShape(found.layer, found.feature);
  if (existing) { planner.message = `This shape is already in the plan as “${existing}”.`; return null; }
  return addRegion(found.layer, found.feature, input);
}

const featureIds = (layerId: string) => new Set(getUniverse()?.geographicLayers.get(layerId)?.features.map(f => f.id) ?? []);

/**
 * An editable layer in the plan's own conventions to draw regions into, made
 * when there is none; null for an empty plan, which adopts the drawn layer's.
 */
function planDrawLayer(plan: DesiredSurfacePlan): string | null {
  if (!plan.regions.length && !plan.layers.length) return null;
  const matches = (c: GeographicLayer['coordinates']) => {
    try { return serializeSurfacePlan(surfacePlanCoordinatesFor(plan.body, c)) === serializeSurfacePlan(plan.coordinates); } catch { return false; }
  };
  const existing = editLayers().find(l => l.body === plan.body && matches(l.coordinates) && matchesDrawFrame(l));
  return existing?.id ?? createLayer({ body: plan.body, name: `Planner regions · ${plan.body}`, coordinates: { ...plan.coordinates, frame: plan.frame } });
}

/** Draw a new polygon on the plan's body with the ordinary drawing tool (#200); the finished shape becomes a region. */
export function drawRegion(): void {
  if (!planner.plan) return;
  // Set up first: the tool clears the selection and may create a layer, and those events must not end the draw.
  const known = new Set(editLayers().map(l => l.id));
  const layerId = planDrawLayer(planner.plan);
  setDrawTool('polygon', planner.plan.body, layerId);
  // A layer made for this drawing goes again if nothing is drawn into it.
  if (layerId && !known.has(layerId)) edits.createdForDraft = layerId;
  if (!edits.tool || !edits.target) { planner.message = edits.message || `Cannot draw on ${planner.plan.body}.`; return; }
  drawing = { layerId: edits.target, before: featureIds(edits.target) };
  planner.awaitingDraw = true;
  planner.message = 'Draw a polygon on the globe; double-click or Enter finishes it.';
}

/** Stop a planner-owned drawing in progress (closing the plan or panel): the shared draw tool must not keep the scene's clicks. */
export function cancelDrawRegion(): void {
  if (!drawing) return;
  drawing = null;
  planner.awaitingDraw = false;
  if (edits.tool) setDrawTool(null);
}

/** The draw tool was left: a new feature in the draw layer (finished) becomes a region; none means cancelled. */
function onDrawEnded(): void {
  if (!drawing || edits.tool) return;
  const { layerId, before } = drawing;
  const layer = getUniverse()?.geographicLayers.get(layerId);
  const feature = layer?.features.find(f => !before.has(f.id));
  drawing = null;
  planner.awaitingDraw = false;
  planner.message = '';
  if (layer && feature) addRegion(layer, feature);
}

export function updateRegion(regionId: string, patch: SurfaceRegionPatch): boolean {
  if (!planner.plan) return false;
  try { planner.plan = updateSurfacePlanRegion(planner.plan, regionId, patch); planner.message = ''; changed(); return true; }
  catch (e) { planner.message = describe(e); return false; }
}

/** Give an area a meaningful name (its ID becomes the name's slug). */
export function renameRegion(regionId: string, name: string): boolean {
  if (!planner.plan) return false;
  try {
    const { plan, regionId: id } = renameSurfacePlanRegion(planner.plan, regionId, name);
    if (id === regionId) return true;
    planner.plan = plan;
    if (planner.focused === regionId) planner.focused = id;
    const { [regionId]: choice, ...rest } = planner.choice;
    planner.choice = choice === undefined ? rest : { ...rest, [id]: choice };
    planner.message = '';
    changed();
    return true;
  } catch (e) { planner.message = describe(e); return false; }
}

export function removeRegion(regionId: string): void {
  if (!planner.plan) return;
  planner.plan = removeSurfacePlanRegion(planner.plan, regionId);
  if (planner.focused === regionId) planner.focused = planner.plan.regions[0]?.id ?? null;
  const { [regionId]: _gone, ...rest } = planner.choice;
  planner.choice = rest;
  changed();
}

export function setBudget(bytes: number | null): void {
  if (!planner.plan) return;
  try { planner.plan = setSurfacePlanBudget(planner.plan, bytes); changed(); }
  catch (e) { planner.message = describe(e); }
}

/** The live feature a region was copied from, if it is still in the scene. */
export function regionSourceFeature(regionId: string): { layer: GeographicLayer; feature: GeographicFeature } | null {
  const plan = planner.plan, region = plan?.regions.find(r => r.id === regionId);
  const ref = region && surfaceRegionSource(plan!, region);
  if (!ref) return null;
  const layer = getUniverse()?.geographicLayers.get(ref.layerId);
  const feature = layer?.features.find(f => f.id === ref.featureId);
  return layer && feature ? { layer, feature } : null;
}

/** The region's source shape was edited after it was added. */
export function regionDrifted(regionId: string): boolean {
  void edits.revision;
  const plan = planner.plan, region = plan?.regions.find(r => r.id === regionId), source = regionSourceFeature(regionId);
  return !!(plan && region && source && surfaceRegionDrift(plan, region, source.feature));
}

export function refreshRegion(regionId: string): void {
  const source = regionSourceFeature(regionId);
  if (!planner.plan || !source) return;
  planner.plan = refreshSurfaceRegion(planner.plan, regionId, source.feature);
  changed();
}

export function focusRegion(regionId: string | null, options: { fly?: boolean } = {}): void {
  planner.focused = regionId;
  const region = planner.plan?.regions.find(r => r.id === regionId);
  if (region && !region[planner.focusChannel]) planner.focusChannel = surfaceRegionChannels(region)[0];
  installOverlay();
  planner.revision++;
  if (regionId && options.fly) goToFeature({ layerId: LAYER.desired, featureId: `string:${regionId}`, bodyName: planner.plan!.body });
}

/** Show one area's comparison for a channel on the globe, fly to the area, and say what is drawn. */
export function showOnGlobe(regionId: string, channel: SurfaceChannel): void {
  planner.showCoverage = true;
  planner.focusChannel = channel;
  focusRegion(regionId, { fly: true });
  const ids = chosenAlternative(regionId)?.channels[channel]?.sourceIds ?? [];
  const records = planner.sources.kind === 'inventory' ? planner.sources.records : [];
  const names = ids.map(id => records.find(r => r.descriptor.id === id)?.descriptor.productId ?? id);
  planner.message = `On the globe: “${regionId}” is the bold yellow, labelled area. ${names.length ? `The thin grey outline is where ${names.join(', ')} lies (its ${channel === 'imagery' ? 'imagery' : 'terrain'} footprint), not proof of valid pixels; hatching marks where validity is unknown (amber) or nothing covers the area (red).` : 'No product footprint is drawn: none was found for it.'}`;
}

export function setFocusChannel(channel: SurfaceChannel): void {
  planner.focusChannel = channel;
  installOverlay();
  planner.revision++;
}

export function chooseAlternative(regionId: string, index: number): void {
  planner.choice = { ...planner.choice, [regionId]: index };
  sourcesChanged();
}

export function regionAlternatives(regionId: string): SurfaceSourceCombination[] {
  return planner.report?.combinations.find(c => c.regionId === regionId)?.alternatives ?? [];
}

export function chosenAlternative(regionId: string): SurfaceSourceCombination | null {
  const alternatives = regionAlternatives(regionId);
  return alternatives[Math.min(planner.choice[regionId] ?? 0, alternatives.length - 1)] ?? null;
}

/** The sources selected for one region's channel: from the held lock, else the chosen alternative. Null when there is no per-region selection. */
export function selectedSourceIds(regionId: string, channel: SurfaceChannel): string[] | null {
  if (planner.importedLock) return planner.importedLock.selections.find(s => s.regionId === regionId && s.channel === channel)?.sourceIds ?? null;
  if (planner.sources.kind !== 'inventory') return null;
  return chosenAlternative(regionId)?.channels[channel]?.sourceIds ?? null;
}

const selectionKey = () => JSON.stringify(planner.plan?.regions.flatMap(r => surfaceRegionChannels(r).map(c => [r.id, c, selectedSourceIds(r.id, c)])) ?? []);

/** The source selection differs from what was last locked (or, never locked, the user picked an alternative). */
export function selectionChanged(): boolean {
  void planner.revision;
  if (!planner.plan) return false;
  return planner.lockedSelections !== null ? planner.lockedSelections !== selectionKey() : Object.keys(planner.choice).length > 0;
}

/** What the chosen sources are shown to support for one region and channel, in plain terms. */
export interface ChannelFinding {
  requestedM: number;
  /** Finest native sampling among the chosen sources, per their metadata; null when unknown or none. */
  nativeM: number | null;
  sourceIds: string[];
  /** The chosen products by name, with what their metadata says. */
  products: { productId: string; kind: SurfaceDiscoveryRecord['kind'] | null; nativeM: number | null }[];
  /** Whether the chosen sources' registration to each other and the plan is evidenced; null without a ranked choice. */
  registration: 'evidenced' | 'unverified' | null;
  /** Fractions of the region: valid pixels evidenced, footprint only, proven gap, and evidenced at the requested sampling. */
  verified: number; unknown: number; gap: number; targetVerified: number;
  verdict: 'proven' | 'partial' | 'coarser' | 'unknown' | 'none' | 'not-searched';
  summary: string;
}

const pctText = (f: number) => `${Math.round(f * 100)}%`;
const mText = (m: number) => `${m.toLocaleString('en-US', { maximumSignificantDigits: 3 })} m`;

export function channelFinding(regionId: string, channel: SurfaceChannel): ChannelFinding | null {
  void planner.revision;
  const region = planner.plan?.regions.find(r => r.id === regionId);
  if (!region?.[channel]) return null;
  const requestedM = region[channel]!.gsdM;
  const empty = { requestedM, nativeM: null, sourceIds: [] as string[], products: [] as ChannelFinding['products'], registration: null,
    verified: 0, unknown: 0, gap: 0, targetVerified: 0 };
  if (planner.importedLock) {
    return { ...empty, sourceIds: selectedSourceIds(regionId, channel) ?? [], verdict: 'unknown',
      summary: 'Sources are fixed by the opened build handoff; their coverage is not re-assessed here.' };
  }
  if (planner.sources.kind !== 'inventory') {
    return { ...empty, verdict: 'not-searched', summary: 'Not searched yet. What is available is unknown, not absent.' };
  }
  const ch = chosenAlternative(regionId)?.channels[channel];
  if (!ch?.sourceIds.length) {
    const incomparable = planner.problems.some(p => p.code === 'discovery-transform-unavailable');
    return { ...empty, verdict: 'none', summary: incomparable
      ? 'No comparable product found. Some searched products use other coordinates or a different reference shape and are not compared without a transform. Unknown — needs source verification.'
      : 'No product in the searched metadata covers this area. Unknown — needs source verification.' };
  }
  const records = planner.sources.records;
  const products = ch.sourceIds.map(id => {
    const r = records.find(x => x.descriptor.id === id);
    return { productId: r?.descriptor.productId ?? id, kind: r?.kind ?? null, nativeM: r?.descriptor.nativeGsdM ?? null };
  });
  const native = products.map(p => p.nativeM);
  const known = native.filter((n): n is number => n !== null);
  const nativeM = known.length ? Math.min(...known) : null;
  const c = ch.coverage;
  const alt = chosenAlternative(regionId)!;
  const base = { requestedM, nativeM, sourceIds: ch.sourceIds, products, registration: alt.compatibility === 'evidenced' ? 'evidenced' as const : 'unverified' as const,
    verified: c.verifiedFraction, unknown: c.unknownFraction, gap: c.gapFraction, targetVerified: c.targetVerifiedFraction };
  if (c.targetVerifiedFraction >= 0.999999 && alt.compatibility === 'evidenced') {
    return { ...base, verdict: 'proven', summary: `Proven by product metadata: valid pixels at ${mText(requestedM)} or finer over the whole area.` };
  }
  if (c.verifiedFraction > 0) {
    return { ...base, verdict: 'partial', summary: `Valid pixels are proven over ${pctText(c.verifiedFraction)} of the area${c.targetVerifiedFraction < c.verifiedFraction ? `, at the requested detail over ${pctText(c.targetVerifiedFraction)}` : ''}; the rest is unknown or a gap.` };
  }
  if (nativeM !== null && nativeM > requestedM) {
    return { ...base, verdict: 'coarser', summary: `The best candidate is ${mText(nativeM)} per ${channel === 'imagery' ? 'pixel' : 'sample'} at source, coarser than the ${mText(requestedM)} requested.` };
  }
  const unit = channel === 'imagery' ? 'pixel' : 'sample';
  const nominal = nativeM === null ? 'No resolution is stated, and the' : `The stated ${mText(nativeM)} per ${unit} is fine enough on paper, but that doesn't show usable coverage: the`;
  return { ...base, verdict: 'unknown', summary: `${nominal} footprint covers ${pctText(c.unknownFraction)} of the area${c.gapFraction > 0 ? ` (${pctText(c.gapFraction)} is not covered)` : ''} without evidence of valid pixels there${base.registration === 'unverified' ? '; registration is unverified' : ''}. Needs source verification.` };
}

/** Whether the viewer can search product metadata for a body without a hand-built inventory. */
export function canFindSources(body: string): boolean {
  return body === 'Mars';
}

/**
 * Search the archive product metadata bundled with the viewer (curated ODE
 * captures around Jezero and Gale; #249). Offline and bounded: no raster is
 * read and no archive is contacted. Areas elsewhere come back as not found,
 * i.e. unknown, which is the honest answer without a live archive query.
 */
export async function findSources(): Promise<void> {
  const body = planner.plan?.body;
  if (!body || !canFindSources(body)) return;
  const [{ default: jezero }, { default: gale }] = await Promise.all([
    import('../../../../docs/examples/surface-plans/mars-jezero.inventory.json?raw'),
    import('../../../../docs/examples/surface-plans/mars-gale.inventory.json?raw'),
  ]);
  const plan = planner.plan!;
  const records = ([...JSON.parse(jezero), ...JSON.parse(gale)] as SurfaceDiscoveryRecord[]).map(r => inLongitudeDomain(r, plan));
  validateSurfaceSources(records.map(r => r.descriptor));
  planner.sources = { kind: 'inventory', label: `Checked ${records.length} locally indexed Mars products near Jezero and Gale. This is not a live archive search; other datasets may exist.`, records };
  planner.choice = {};
  planner.message = '';
  sourcesChanged();
}

/**
 * A record whose conventions differ from the plan's only in longitude domain,
 * re-expressed in the plan's domain. Exact (a whole-turn shift per ring), and
 * noted in the record's caveats. Anything else, or a footprint that would
 * straddle the plan's seam, is returned unchanged for discovery to refuse.
 */
export function inLongitudeDomain(record: SurfaceDiscoveryRecord, plan: DesiredSurfacePlan): SurfaceDiscoveryRecord {
  const d = record.descriptor, to = plan.coordinates.longitudeDomain, from = d.coordinates.longitudeDomain;
  if (from === to || !d.footprint || d.body !== plan.body || d.frame !== plan.frame
    || serializeSurfacePlan({ ...d.coordinates, longitudeDomain: to }) !== serializeSurfacePlan(plan.coordinates)) return record;
  const [lo, hi] = to === '0..360' ? [0, 360] : [-180, 180];
  const needs = (x: number) => x < lo || x > hi;
  let ok = true;
  const ring = (r: number[][]) => {
    const shift = r.some(([x]) => needs(x)) ? (to === '0..360' ? 360 : -360) : 0;
    const out = r.map(([x, ...rest]) => [x + shift, ...rest]);
    if (out.some(([x]) => needs(x))) ok = false;
    return out;
  };
  const footprint = structuredClone(d.footprint);
  for (const f of footprint.features) {
    const g = f.geometry as { type: string; coordinates: number[][][] | number[][][][] };
    g.coordinates = g.type === 'Polygon' ? (g.coordinates as number[][][]).map(ring) : (g.coordinates as number[][][][]).map(p => p.map(ring));
  }
  if (!ok) return record;
  return { ...record, descriptor: { ...d, coordinates: { ...d.coordinates, longitudeDomain: to }, footprint },
    evidence: { ...record.evidence, caveats: [...(record.evidence.caveats ?? []), `Footprint longitudes re-expressed from ${from} to ${to} by the viewer (exact).`] } };
}

/** Scene products over a region: display context only, never source evidence for a rebuild. */
export function sceneProducts(regionId: string): { name: string; resolutionM: number | null }[] {
  void planner.revision;
  const plan = planner.plan, region = plan?.regions.find(r => r.id === regionId);
  const mesh = plan ? getRenderer()?.getBodyMesh(plan.body) : null;
  if (!plan || !region || !mesh) return [];
  const layer = plan.layers.find(l => l.id === region.feature.layerId);
  const feature = layer?.geojson?.features.find(x => `${typeof x.id}:${x.id}` === region.feature.featureId);
  const lons: number[] = [], lats: number[] = [];
  const walk = (v: unknown): void => { if (Array.isArray(v) && typeof v[0] === 'number') { lons.push(((v[0] % 360) + 360) % 360); lats.push(v[1] as number); } else if (Array.isArray(v)) v.forEach(walk); };
  walk((feature?.geometry as { coordinates?: unknown } | undefined)?.coordinates);
  const overlaps = (b: [number, number, number, number] | null) => {
    if (!b || !lons.length) return true;
    const w = ((b[0] % 360) + 360) % 360, e = ((b[2] % 360) + 360) % 360;
    const inLon = (x: number) => w <= e ? x >= w && x <= e : x >= w || x <= e;
    return Math.max(...lats) >= b[1] && Math.min(...lats) <= b[3] && (lons.some(inLon) || inLon(w) && Math.min(...lons) <= w && Math.max(...lons) >= w);
  };
  return [
    ...mesh.imageryLayers.filter(l => overlaps(l.bounds)).map(l => ({ name: l.name, resolutionM: l.resolutionMeters })),
    ...(mesh.hasTerrain ? [{ name: 'Measured 3D terrain', resolutionM: null }] : []),
  ];
}

/** Whether a build handoff (a lock) can be saved now, and if not, why, in plain terms. */
export function handoffReadiness(): { ready: boolean; reason: string } {
  void planner.revision;
  const plan = planner.plan;
  if (!plan?.regions.length) return { ready: false, reason: 'Add an area first.' };
  if (planner.importedLock) return { ready: true, reason: '' };
  if (planner.sources.kind !== 'inventory') return { ready: false, reason: 'Find available imagery and terrain first.' };
  const missing = plan.regions.flatMap(r => surfaceRegionChannels(r).filter(c => !selectedSourceIds(r.id, c)?.length)
    .map(c => `${r.id} ${c === 'imagery' ? 'imagery' : 'terrain'}`));
  if (missing.length) return { ready: false, reason: `No source was found for ${missing.join(', ')}.` };
  if (planner.lockProblem) return { ready: false, reason: `The chosen sources can't be pinned yet: ${planner.lockProblem}.` };
  return { ready: true, reason: '' };
}

/** Whether a region's channel is already built or published, per the loaded build feedback. */
export function regionBuildStatus(regionId: string, channel: SurfaceChannel) {
  void planner.revision;
  const feedback = planner.feedback?.data ?? null;
  return planner.plan ? surfaceRegionBuildStatus(planner.plan, feedback, regionId, channel, selectedSourceIds(regionId, channel),
    (feedback && lockConventions.get(feedback.lockIdentity)) ?? null) : null;
}

// ── Change tracking ──

export function planChanges() {
  void planner.revision;
  return planner.plan ? surfacePlanChanges(planner.base, planner.plan) : null;
}

/** Sources or their selection changed: a held lock no longer describes what is shown. */
function sourcesChanged(): void {
  planner.importedLock = null;
  changed();
}

function changed(): void {
  planner.importedLock = planner.importedLock && planner.plan
    && serializeSurfacePlan(planner.importedLock.desired) === serializeSurfacePlan(planner.plan) ? planner.importedLock : null;
  planner.revision++;
  installOverlay();
  scheduleRun();
}

// ── Discovery and estimate ──

function scheduleRun(): void {
  clearTimeout(runTimer);
  runTimer = setTimeout(() => void run(), 120);
}

/** Descriptors for source IDs, from the inventory (discovery-adjusted) or the held lock. */
function descriptorsFor(ids: string[], report: SurfaceDiscoveryReport | null): SurfaceSourceDescriptor[] {
  const input = planner.sources;
  if (planner.importedLock) return planner.importedLock.sources.filter(s => ids.includes(s.id));
  if (input.kind !== 'inventory' || !report) return [];
  return discoveryEstimatorSources({ ...report, recommendedSourceIds: ids }, input.records);
}

const regionSelection = (regionId: string) => {
  const region = planner.plan?.regions.find(r => r.id === regionId);
  return [...new Set(region ? surfaceRegionChannels(region).flatMap(c => selectedSourceIds(regionId, c) ?? []) : [])];
};

/**
 * Sources for the plan-wide size/download estimate: everything selected for any
 * region, or bare descriptors as they are. Its fidelity pools these across
 * regions, so per-region fidelity is assessed separately (`selectedFidelity`).
 */
function estimatorSources(report: SurfaceDiscoveryReport | null): SurfaceSourceDescriptor[] {
  if (!planner.importedLock && planner.sources.kind === 'descriptors') return planner.sources.sources;
  return descriptorsFor([...new Set(planner.plan!.regions.flatMap(r => regionSelection(r.id)))], report);
}

/** Per-region selection exists: an inventory to choose from, or a held lock. */
export const hasRegionSelection = () => !!planner.importedLock || planner.sources.kind === 'inventory';

export async function run(): Promise<void> {
  const plan = planner.plan, token = ++runToken;
  if (!plan || !plan.regions.length) { planner.report = null; planner.estimate = null; planner.problems = []; planner.revision++; return; }
  planner.busy = true;
  const problems: SurfacePlanDiagnostic[] = [];
  let report: SurfaceDiscoveryReport | null = null;
  if (planner.sources.kind === 'inventory') {
    try { report = recommendSurfaceSources(plan, planner.sources.records, { policy: planner.policy }); problems.push(...report.diagnostics); }
    catch (e) { problems.push({ severity: 'error', code: 'discovery-failed', path: '$', message: describe(e) }); }
  }
  planner.report = report;
  let estimate: SurfacePlanEstimate | null = null, selectedFidelity: Record<string, SurfaceFidelityAssessment> | null = null;
  try {
    estimate = await estimateSurfacePlan(plan, { sources: estimatorSources(report) });
    if (hasRegionSelection()) selectedFidelity = await surfaceSelectedFidelity(plan, id => descriptorsFor(regionSelection(id), report));
  } catch (e) { problems.push({ severity: 'error', code: 'estimate-failed', path: '$', message: describe(e) }); }
  let lockProblem: string | null = null;
  if (hasRegionSelection()) try { await lockText(); } catch (e) { lockProblem = describe(e); }
  if (token !== runToken) return;
  planner.lockProblem = lockProblem;
  planner.estimate = estimate;
  planner.selectedFidelity = selectedFidelity;
  planner.problems = problems;
  planner.busy = false;
  installOverlay();
  planner.revision++;
}

export function setPolicy(policy: SurfaceDiscoveryPolicy): void {
  planner.policy = policy;
  planner.choice = {};
  sourcesChanged();
}

// ── Display layers ──

function displayLoad(layer: SurfacePlanLayer, color: string): GeographicLayerLoad | null {
  if (!layer.geojson?.features.length) return null;
  const definition = { id: layer.id, name: layer.name, body: layer.body, source: layer.source, coordinates: layer.coordinates, display: { color, opacity: 1 } };
  try {
    const parsed = parseGeographicGeoJson(JSON.stringify(layer.geojson), definition, { kind: 'local-file', identity: `surface-planner/${layer.id}` }, layer.coordinates);
    return { id: parsed.id, source: parsed.source, status: 'ready', layer: parsed, diagnostics: parsed.diagnostics };
  } catch { return null; }
}

const color = (id: string) => PLANNER_LEGEND.find(l => l.id === id)!.color;

/** Install (or clear) the planner's display layers in the scene. */
export function installOverlay(): void {
  const universe = getUniverse(), plan = planner.plan;
  if (!universe) return;
  const loads: GeographicLayerLoad[] = [];
  if (plan?.regions.length) {
    let resolved: ReturnType<typeof resolveSurfacePlan> | null = null;
    try { resolved = resolveSurfacePlan(plan); } catch { /* shown as a problem by run() */ }
    if (resolved) {
      const desired: SurfacePlanLayer = { id: LAYER.desired, name: 'Planner · desired regions', body: plan.body, source: 'desired', coordinates: plan.coordinates,
        geojson: { type: 'FeatureCollection', features: plan.regions.map(r => {
          const layer = resolved!.desired.layers.find(l => l.id === r.feature.layerId)!;
          const f = layer.geojson!.features.find(x => `${typeof x.id}:${x.id}` === r.feature.featureId)!;
          return { type: 'Feature', id: r.id, properties: { name: r.id, region: r.id }, geometry: f.geometry };
        }) } };
      const load = displayLoad(desired, color(LAYER.desired));
      if (load) loads.push(load);
    }
    const alternative = planner.focused ? chosenAlternative(planner.focused) : null;
    const channel = alternative?.channels[planner.focusChannel];
    if (planner.showCoverage && alternative && channel && planner.sources.kind === 'inventory') {
      const records = planner.sources.records.filter(r => channel.sourceIds.includes(r.descriptor.id));
      const footprints = records.flatMap(r => (r.descriptor.footprint?.features ?? []).map((f, i) => ({
        type: 'Feature' as const, id: `${r.descriptor.id}#${i}`, properties: { name: r.descriptor.productId, source: r.descriptor.id }, geometry: f.geometry })));
      const coordinates = records[0]?.descriptor.coordinates;
      if (coordinates) {
        const load = displayLoad({ id: LAYER.footprints, name: 'Planner · candidate footprints', body: plan.body, source: 'footprints', coordinates,
          geojson: { type: 'FeatureCollection', features: footprints } }, color(LAYER.footprints));
        if (load) loads.push(load);
      }
      const coverage = channel.coverage;
      for (const [id, geometry] of [[LAYER.verified, coverage.verifiedGeometry], [LAYER.unknown, coverage.unknownGeometry], [LAYER.gap, coverage.gapGeometry]] as const) {
        const load = displayLoad(surfaceCoverageLayer(id, `Planner · ${PLANNER_LEGEND.find(l => l.id === id)!.label}`, plan,
          [{ featureId: planner.focused!, geometry, properties: { name: planner.focused! } }]), color(id));
        if (load) loads.push(load);
      }
    }
    const built = planner.focused && planner.feedback ? regionBuildStatus(planner.focused, planner.focusChannel) : null;
    const geometry = planner.feedback?.data.requested.find(r => r.regionId === planner.focused)?.geometry;
    // Drawn only when the built ROI is this region's own shape, so it is in the plan's conventions.
    if (planner.showCoverage && geometry && built && built.status !== 'needs-build' && built.status !== 'unknown') {
      const load = displayLoad({ id: LAYER.built, name: 'Planner · requested build ROI', body: plan.body, source: 'build-feedback', coordinates: plan.coordinates,
        geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', id: planner.focused!, properties: { name: `${planner.focused} (${built.status})` }, geometry: geometry as never }] } },
      color(LAYER.built));
      if (load) loads.push(load);
    }
  }
  universe.geographicLayers.replaceCatalog(PLANNER_OWNER, loads);
  // Session-only styles (labels need the style store); areas out of focus are dimmed.
  const dim = Object.fromEntries((plan?.regions ?? []).filter(r => r.id !== planner.focused).map(r => [`string:${r.id}`, { opacity: 0.4 }]));
  for (const [id, style] of Object.entries(STYLES)) {
    const shown = loads.some(l => l.id === id);
    setLayerStyle(id, shown ? (id === LAYER.desired ? { ...style, features: dim } : style) : null, { persist: false });
  }
  universe.events.emit('geographic:changed', {});
  const vectors = getRenderer()?.geographicVectors;
  if (vectors) {
    // The desired regions draw over the coverage they are compared with.
    const others = vectors.layerOrder.filter(id => !isPlannerLayer(id));
    vectors.setLayerOrder([...others, LAYER.desired, LAYER.built, LAYER.footprints, LAYER.gap, LAYER.unknown, LAYER.verified]);
  }
  if (geo.selected && isPlannerLayer(geo.selected.layerId) && !loads.some(l => l.id === geo.selected!.layerId)) selectFeature(null);
}

/** Picking a desired region on the globe focuses it. */
function onPick(): void {
  const ref = geo.selected;
  if (ref?.layerId === LAYER.desired) {
    const id = ref.featureId.replace(/^string:/, '');
    if (planner.focused !== id && planner.plan?.regions.some(r => r.id === id)) focusRegion(id);
  }
}

// ── Import and export ──

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/** Canonical (sorted-key) pretty JSON, as the CLI accepts it. */
const pretty = (value: unknown) => JSON.stringify(JSON.parse(serializeSurfacePlan(value)), null, 2) + '\n';
const fileBase = (plan: DesiredSurfacePlan) => `${plan.body.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-surface`;

/** The desired plan's exact v1 JSON, with every referenced GeoJSON embedded. Throws if invalid. */
export function desiredPlanText(): string {
  const plan = planner.plan;
  if (!plan) throw new Error('No plan');
  return pretty(resolveSurfacePlan(validateDesiredSurfacePlan(plan)).desired);
}

export function exportDesired(): void {
  try {
    const text = desiredPlanText();
    download(`${fileBase(planner.plan!)}.plan.json`, text);
    planner.base = JSON.parse(text) as DesiredSurfacePlan;
    planner.message = `Saved the plan as ${fileBase(planner.plan!)}.plan.json. Reopen it here from "Open a saved plan" or the ⋯ menu.`;
    planner.revision++;
  } catch (e) { planner.message = describe(e); }
}

/**
 * The chosen source per region and channel, locked and validated by core. A
 * plan whose selections are not buildable under their metadata is refused with
 * core's diagnostics; nothing is relaxed to make a lock pass.
 */
export async function lockText(): Promise<string> {
  const plan = planner.plan, input = planner.sources;
  if (!plan) throw new Error('No plan');
  // Held only while neither the plan nor its sources changed since import.
  if (planner.importedLock) return pretty(planner.importedLock);
  if (input.kind !== 'inventory') throw new Error('Load a source inventory to choose sources before locking.');
  const desired = resolveSurfacePlan(plan).desired;
  const selections: LockedSurfacePlan['selections'] = [];
  for (const region of plan.regions) for (const channel of surfaceRegionChannels(region)) {
    const sourceIds = selectedSourceIds(region.id, channel);
    if (!sourceIds?.length) throw new Error(`${region.id}: no ${channel} source is chosen, so the plan cannot be locked.`);
    selections.push({ regionId: region.id, channel, sourceIds, outputGsdM: region[channel]!.gsdM,
      resampling: channel === 'imagery' ? 'bilinear' : 'cubic', transformations: ['identity'] });
  }
  const ids = new Set(selections.flatMap(s => s.sourceIds));
  const lock = await createLockedSurfacePlan({ version: 1, kind: 'locked-surface-plan', desired,
    sources: input.records.filter(r => ids.has(r.descriptor.id)).map(r => r.descriptor).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    selections,
    processing: { generator: { name: 'cosmolabe-surface-build', version: '1' }, fusion: 'residual-bias-none',
      parameters: { caveats: ['Source selection authored in the surface planner. Planner handoff: an executor-compatible preparation step must add terrain, imagery and gate parameters, pinned source bytes and runtime bindings before build:surface (#251) can run it.'] } },
    output: { representation: 'tiled-raster-pyramid', formatVersion: 'cosmolabe-cube-1', tileSize: 256, gutter: 1, imageryEncoding: 'png', elevationEncoding: 'float32' } });
  await validateLockedSurfacePlan(lock);
  return pretty(lock);
}

/**
 * What `npm run build:surface` needs that a lock lacks, as far as the planner
 * can tell without the executor. The planner writes a core-valid handoff only;
 * an executor-compatible preparation step adds the rest. Pinned source bytes
 * and runtime bindings are checked only by the executor itself.
 */
export function lockPreparationGaps(lock: LockedSurfacePlan): string[] {
  const d = lock.desired, p = lock.processing.parameters as Record<string, unknown> | undefined;
  return [
    ...(d.body === 'Mars' && d.frame === 'IAU_MARS' ? [] : ['the v1 executor builds bounded Mars (IAU_MARS) plans only']),
    ...(d.coordinates.referenceShape.kind === 'sphere' && d.coordinates.latitude === 'planetocentric' && d.coordinates.longitudeDirection === 'east'
      ? [] : ['a spherical, planetocentric, east-positive source map']),
    ...(['terrain', 'imagery', 'gates'] as const).filter(k => p?.[k] === undefined).map(k => `processing.parameters.${k}`),
  ];
}

export async function exportLock(): Promise<void> {
  try {
    const text = await lockText();
    download(`${fileBase(planner.plan!)}.lock.json`, text);
    const lock = JSON.parse(text) as LockedSurfacePlan;
    planner.base = lock.desired;
    planner.lockedSelections = selectionKey();
    const gaps = lockPreparationGaps(lock);
    planner.message = gaps.length
      ? `Exported the locked plan as a planner handoff. Not yet executable by build:surface; preparation must add: ${gaps.join('; ')}, plus pinned source bytes and runtime bindings.`
      : 'Exported the locked plan. It carries executor parameters; build:surface still verifies pinned source bytes and runtime bindings.';
    planner.revision++;
  } catch (e) { planner.message = `Not lockable: ${describe(e)}`; }
}

/** Import a desired plan, a locked plan, a discovery inventory, or source descriptors. */
export async function importPlannerText(text: string, fileName: string): Promise<boolean> {
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) { planner.message = `${fileName}: not JSON (${describe(e)})`; return false; }
  try {
    if (Array.isArray(data)) {
      if (data.every(x => x && typeof x === 'object' && 'descriptor' in x)) {
        validateSurfaceSources((data as SurfaceDiscoveryRecord[]).map(r => r.descriptor));
        planner.sources = { kind: 'inventory', label: fileName, records: data as SurfaceDiscoveryRecord[] };
      } else planner.sources = { kind: 'descriptors', label: fileName, sources: validateSurfaceSources(data) };
      planner.choice = {};
      planner.message = '';
      sourcesChanged();
      return true;
    }
    const kind = (data as { kind?: unknown })?.kind;
    if (kind === 'surface-planner-feedback') {
      planner.feedback = { label: fileName, data: parseSurfacePlannerFeedback(data) };
      planner.message = '';
      installOverlay();
      planner.revision++;
      return true;
    }
    if (kind === 'desired-surface-plan' || kind === 'locked-surface-plan') {
      const lock = kind === 'locked-surface-plan' ? await validateLockedSurfacePlan(data) : null;
      if (lock) lockConventions.set(lock.identity, { body: lock.desired.body, frame: lock.desired.frame, coordinates: lock.desired.coordinates });
      const plan = lock ? lock.desired : resolveSurfacePlan(validateDesiredSurfacePlan(data)).desired;
      const status = plannerBodyStatus(plan.body);
      if (!getUniverse()?.getBody(plan.body)) planner.message = `${plan.body} is not in this scene; the plan is kept but nothing is drawn.`;
      else if (status.blocked) planner.message = status.blocked;
      else planner.message = '';
      planner.body = plan.body;
      planner.plan = plan;
      planner.base = plan;
      planner.importedLock = lock;
      if (lock) planner.sources = { kind: 'descriptors', label: `${fileName} (locked sources)`, sources: lock.sources };
      planner.focused = plan.regions[0]?.id ?? null;
      planner.choice = {};
      planner.lockedSelections = lock ? selectionKey() : null;
      changed();
      return true;
    }
    planner.message = `${fileName}: expected a desired or locked surface plan, a discovery inventory, source descriptors, or build feedback.`;
  } catch (e) { planner.message = `${fileName}: ${describe(e)}`; }
  return false;
}

export function clearSources(): void {
  planner.sources = { kind: 'none' };
  planner.choice = {};
  sourcesChanged();
}

export function clearFeedback(): void {
  planner.feedback = null;
  installOverlay();
  planner.revision++;
}

// ── Example ──

/**
 * The deterministic synthetic Jezero fixture (#248/#249): its ROIs as a
 * read-only layer, its offline discovery inventory, and three regions at the
 * three presets. No mission geometry or real coverage is implied.
 */
export async function loadJezeroExample(): Promise<void> {
  const universe = getUniverse();
  if (!universe?.getBody('Mars')) { planner.message = 'The Jezero example needs Mars in the scene.'; return; }
  const [{ default: geojson }, { default: inventory }] = await Promise.all([
    import('../../../../docs/examples/surface-plans/jezero.geojson?raw'),
    import('../../../../docs/examples/surface-plans/mars-jezero.inventory.json?raw'),
  ]);
  const coordinates = { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '0..360',
    referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] } } as const;
  const layer = parseGeographicGeoJson(geojson, { id: 'example:jezero-synthetic', name: 'Synthetic Jezero ROIs (example)', body: 'Mars',
    source: 'docs/examples/surface-plans/jezero.geojson', coordinates: structuredClone(coordinates) },
  { kind: 'local-file', identity: 'docs/examples/surface-plans/jezero.geojson' });
  universe.geographicLayers.replaceCatalog(PLANNER_EXAMPLE_OWNER, [{ id: layer.id, source: layer.source, status: 'ready', layer, diagnostics: layer.diagnostics }]);
  universe.events.emit('geographic:changed', {});
  planner.plan = createSurfacePlanDraft('Mars', structuredClone(coordinates));
  planner.body = 'Mars'; planner.base = null; planner.importedLock = null; planner.lockedSelections = null; planner.choice = {};
  const presets = ['orbit-context', 'descent', 'local-operations'] as const;
  layer.features.forEach((feature, i) => { planner.plan = addSurfacePlanRegion(planner.plan!, layer, feature, { preset: presets[i] ?? 'descent' }).plan; });
  planner.plan = setSurfacePlanBudget(planner.plan, 100_000_000);
  const records = JSON.parse(inventory) as SurfaceDiscoveryRecord[];
  planner.sources = { kind: 'inventory', label: `Checked ${records.length} locally indexed products from the Jezero example inventory. This is not a live archive search; other datasets may exist.`, records };
  planner.focused = planner.plan.regions[0]?.id ?? null;
  planner.message = 'Loaded the synthetic Jezero example. Its regions and inventory are fixtures, not mission or coverage claims.';
  changed();
  focusRegion(planner.focused, { fly: true });
}

// ── Scene lifecycle ──

onViewerEvent('load', () => { installOverlay(); if (planner.plan) scheduleRun(); });
onViewerEvent('geographic', onPick);
// Finishing a shape adds it before the tool turns off, so by then it is in the layer.
$effect.root(() => {
  $effect(() => { if (!edits.tool) untrack(onDrawEnded); });
});
