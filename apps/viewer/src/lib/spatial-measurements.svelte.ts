import {
  surfacePointEndpoint, type SurfacePoint, endpointLabel, frameAvailability, formatSpatialDistance, formatSpatialSpeed, referenceRelationship, referenceVectorLabel, relationshipVectors,
  resolveSpatialRelationship, type ReferenceRequest, type ReferenceVector, type SpatialEndpoint, type SpatialRelationship,
} from '@cosmolabe/core';
import { ViewStateError } from '@cosmolabe/control';
import { flushSync, mount, unmount } from 'svelte';
import { Ruler, Crosshair, TriangleRight, Gauge, Axis3d } from 'lucide-svelte';
import { openTool } from './shell.svelte';
import type { UniverseRenderer } from '@cosmolabe/three';
import { cancelAppearancePick } from './surface-appearance-pick.svelte';
import { getCurrentRenderer, getUniverse } from './loader';
import { excludeFromProbe, setProbeActive, vs } from './viewer-state.svelte';
import { definitionEndpoints, validateMeasurementLinkState, validateMeasurementReferences, type MeasurementDefinition, type MeasurementLinkState } from './measurement-link-state';
export type { MeasurementDefinition } from './measurement-link-state';

export type Slot = 'source' | 'target' | 'vertex';
type Kind = SpatialRelationship['kind'];
type Draft = Record<Slot, SpatialEndpoint | null>;
type Operand = 'first' | 'second';
type Operands = Record<Operand, ReferenceVector | null>;
interface DraftSnapshot { kind: Kind; draft: Draft; color: string; showDistance: boolean; fullLength: boolean; frame: string; operands: Operands; }
/** What the panel and list call each kind; both angle kinds read as an angle. */
export const kindLabels: Record<Kind, string> = { distance: 'Distance', angle: 'Angle', direction: 'Direction', velocity: 'Velocity', axes: 'Axes', 'vector-angle': 'Angle' };
const emptyDraft = (): Draft => ({ source: null, target: null, vertex: null });
export const measurementColors = [{ name: 'Blue', color: '#82aabd' }, { name: 'Sand', color: '#c6a66b' }, { name: 'Sage', color: '#9ab58d' }, { name: 'Mauve', color: '#b493ad' }];
const colors = ['#82aabd', '#c6a66b', '#9ab58d', '#b493ad'];
let suspendedDraft: DraftSnapshot | null = null;
/** The axes frame last filled in for the user, which follows the origin until they choose another. */
let autoFrame: string | null = null;

export const measurements = $state({
  items: [] as MeasurementDefinition[],
  draftKind: 'distance' as Kind,
  pendingPickSlot: null as Slot | null,
  pickMode: 'surface' as 'object' | 'surface',
  pickFeedback: '',
  draft: emptyDraft(),
  draftColor: colors[0],
  draftShowDistance: false,
  draftFullLength: false,
  /** Axes frame; filled with the origin body's body-fixed frame until chosen. */
  draftFrame: '',
  draftOperands: { first: null, second: null } as Operands,
  editingId: null as string | null,
  nextColor: 0,
  nextPoint: 1,
  selectedId: null as string | null,
  hoveredId: null as string | null,
});

export function cloneEndpoint(endpoint: SpatialEndpoint): SpatialEndpoint {
  if (endpoint.kind === 'surface-point') return surfacePointEndpoint(endpoint.point, endpoint.label);
  return endpoint.kind === 'entity' ? { ...endpoint } : { ...endpoint, positionKm: [...endpoint.positionKm] };
}
export function cloneVector(vector: ReferenceVector): ReferenceVector {
  return JSON.parse(JSON.stringify(vector)) as ReferenceVector;
}
function cloneOperands(operands: Pick<MeasurementDefinition, Operand>): Operands {
  return { first: operands.first ? cloneVector(operands.first) : null, second: operands.second ? cloneVector(operands.second) : null };
}
function cloneDraft(draft: Draft): Draft {
  return Object.fromEntries((['source', 'target', 'vertex'] as const).map(slot => [slot, draft[slot]] as const).map(([slot, endpoint]) => [slot, endpoint && cloneEndpoint(endpoint)])) as Draft;
}
function snapshot(): DraftSnapshot {
  return { kind: measurements.draftKind, draft: cloneDraft(measurements.draft), color: measurements.draftColor,
    showDistance: measurements.draftShowDistance, fullLength: measurements.draftFullLength,
    frame: measurements.draftFrame, operands: cloneOperands(measurements.draftOperands) };
}
function restore(value: DraftSnapshot): void {
  measurements.draftKind = value.kind; measurements.draft = cloneDraft(value.draft); measurements.draftColor = value.color;
  measurements.draftShowDistance = value.showDistance; measurements.draftFullLength = value.fullLength;
  measurements.draftFrame = value.frame; measurements.draftOperands = cloneOperands(value.operands);
  autoFrame = null;
}
/** Incomplete definitions remain editable, but never produce stale geometry. */
function relationship(item: MeasurementDefinition): SpatialRelationship | null {
  const { source, target, vertex } = item;
  const style = { id: item.id, ...(item.color ? { color: item.color } : {}), ...(item.visible === undefined ? {} : { visible: item.visible }) };
  switch (item.kind) {
    case 'velocity': return source ? { ...style, kind: 'velocity', object: source, ...(target ? { relativeTo: target } : {}) } : null;
    case 'axes': return source && item.frame ? { ...style, kind: 'axes', frame: item.frame, origin: source } : null;
    case 'vector-angle': return item.first && item.second ? { ...style, kind: 'vector-angle', first: item.first, second: item.second } : null;
    case 'angle': return source && target && vertex ? { ...style, kind: 'angle', source, target, vertex } : null;
    case 'direction': return source && target ? { ...style, kind: 'direction', source, target, showDistance: item.showDistance, fullLength: item.fullLength } : null;
    case 'distance': return source && target ? { ...style, kind: 'distance', source, target } : null;
  }
}
function definition(item: SpatialRelationship): MeasurementDefinition {
  const style = { id: item.id, ...(item.color ? { color: item.color } : {}), ...(item.visible === undefined ? {} : { visible: item.visible }) };
  const empty = { source: null, target: null, vertex: null };
  switch (item.kind) {
    case 'velocity': return { ...style, ...empty, kind: 'velocity', source: cloneEndpoint(item.object), target: item.relativeTo ? cloneEndpoint(item.relativeTo) : null };
    case 'axes': return { id: item.id, ...(item.visible === undefined ? {} : { visible: item.visible }), ...empty, kind: 'axes', source: cloneEndpoint(item.origin), frame: item.frame };
    case 'vector-angle': return { ...style, ...empty, kind: 'vector-angle', ...cloneOperands(item) };
    case 'angle': return { ...style, kind: 'angle', source: cloneEndpoint(item.source), target: cloneEndpoint(item.target), vertex: cloneEndpoint(item.vertex) };
    case 'direction': return { ...style, ...empty, kind: 'direction', source: cloneEndpoint(item.source), target: cloneEndpoint(item.target),
      ...(item.showDistance === undefined ? {} : { showDistance: item.showDistance }), ...(item.fullLength === undefined ? {} : { fullLength: item.fullLength }) };
    case 'distance': return { ...style, ...empty, kind: 'distance', source: cloneEndpoint(item.source), target: cloneEndpoint(item.target) };
  }
}
/** Axes default to the origin body's own body-fixed frame, the frame its global axes show. */
function defaultDraftFrame(): void {
  const origin = measurements.draft.source;
  if (measurements.draftKind !== 'axes' || !origin || origin.kind === 'coordinate') return;
  if (measurements.draftFrame && measurements.draftFrame !== autoFrame) return;
  const bodyName = origin.kind === 'surface-point' ? origin.point.bodyName : origin.bodyName;
  const frame = getUniverse()?.getBody(bodyName)?.rotation ? getUniverse()!.frames.bodyFixedFrameFor(bodyName) : 'ECLIPJ2000';
  if (measurements.draftFrame !== frame) measurements.draftFrame = frame;
  autoFrame = frame;
}
export function applyMeasurementFields(): void {
  const item = measurements.items.find(item => item.id === measurements.editingId);
  if (!item) return;
  item.kind = measurements.draftKind;
  if (item.kind !== 'axes') item.color = measurements.draftColor;
  item.showDistance = measurements.draftShowDistance; item.fullLength = measurements.draftFullLength;
  for (const slot of ['source', 'target', 'vertex'] as const) {
    const endpoint = measurements.draft[slot];
    if (JSON.stringify(item[slot]) !== JSON.stringify(endpoint)) item[slot] = endpoint && cloneEndpoint(endpoint);
  }
  if (measurements.draftFrame) item.frame = measurements.draftFrame; else delete item.frame;
  for (const operand of ['first', 'second'] as const) {
    const vector = measurements.draftOperands[operand];
    if (JSON.stringify(item[operand] ?? null) !== JSON.stringify(vector)) item[operand] = vector && cloneVector(vector);
  }
}
export function renderedMeasurements(): SpatialRelationship[] {
  applyMeasurementFields();
  return measurements.items.flatMap(item => {
    const valid = relationship(item);
    return valid ? [{ ...valid, selected: item.id === measurements.selectedId, hovered: item.id === measurements.hoveredId, editing: item.id === measurements.editingId }] : [];
  });
}
export function syncMeasurements(): void {
  defaultDraftFrame();
  const renderer = getCurrentRenderer();
  const rendered = renderedMeasurements();
  renderer?.setSpatialRelationships(rendered);
  const selected = measurements.items.find(item => item.id === measurements.editingId);
  renderer?.setSpatialDraftEndpoints(selected && relationship(selected) ? []
    : Object.values(measurements.draft).filter((endpoint): endpoint is SpatialEndpoint => endpoint !== null));
}
export function selectMeasurement(id: string | null): void {
  if (id === null) { newMeasurement(); return; }
  applyMeasurementFields();
  const item = measurements.items.find(item => item.id === id);
  if (!item) return;
  if (!measurements.editingId) suspendedDraft = snapshot();
  measurements.editingId = id; measurements.selectedId = id;
  restore({ kind: item.kind, draft: cloneDraft(item), color: item.color ?? colors[0], showDistance: item.showDistance === true, fullLength: item.fullLength === true,
    frame: item.frame ?? '', operands: cloneOperands(item) });
  cancelMeasurementPick(); syncMeasurements();
}
export function toggleMeasurementSelection(id: string): void {
  selectMeasurement(measurements.selectedId === id ? null : id);
}
/** New resumes the creation draft; existing field changes are already applied. */
export function newMeasurement(): void {
  applyMeasurementFields();
  measurements.editingId = null; measurements.selectedId = null;
  cancelMeasurementPick();
  if (suspendedDraft) { restore(suspendedDraft); suspendedDraft = null; }
  syncMeasurements();
}
/** Type changes retain latent angle endpoints and direction options. */
export function changeMeasurementKind(kind: Kind): void {
  measurements.draftKind = kind; cancelMeasurementPick(); syncMeasurements();
}
export function captureSharedMeasurements(): MeasurementLinkState | undefined {
  applyMeasurementFields();
  if (!measurements.items.length) return undefined;
  return validateMeasurementLinkState({ version: 1, items: measurements.items,
    ...(measurements.selectedId ? { selected: measurements.selectedId } : {}) });
}
export function restoreSharedMeasurements(input: MeasurementLinkState | undefined): void {
  const state = input ? validateMeasurementLinkState(input) : undefined;
  const universe = getUniverse();
  if (state) {
    if (!universe) throw new ViewStateError('Measurement context: the catalog has no scene.');
    validateMeasurementReferences(state, universe, getCurrentRenderer()?.timeController.et ?? 0);
  }
  resetMeasurementsForScene();
  if (!state) return;
  measurements.items = state.items;
  measurements.nextColor = state.items.filter(item => item.kind !== 'axes').length;
  if (state.selected) selectMeasurement(state.selected);
  syncMeasurements();
}
export function openMeasurementEditor(id: string): void {
  selectMeasurement(id); openTool('measure');
  requestAnimationFrame(() => document.querySelector('[data-measurement-editor]')?.scrollIntoView({ block: 'nearest' }));
}
export function hoverMeasurement(id: string | null): void {
  if (measurements.hoveredId === id) return;
  measurements.hoveredId = id; syncMeasurements();
}
export function addMeasurement(item: SpatialRelationship): void {
  measurements.items.push(definition(item));
  if (item.kind !== 'axes') measurements.nextColor++;
  resetMeasurementDraft(true);
  selectMeasurement(item.id);
}
/**
 * Show reference geometry by meaning (`{ kind: 'velocity', object: 'ISS' }`),
 * as a saved, selected item. An unfinished creation draft is kept for New.
 */
export function showReference(request: ReferenceRequest): string {
  applyMeasurementFields();
  const resolvedRequest = request.kind === 'bodyAxes' ? { kind: 'frameAxes' as const, frame: getUniverse()?.frames.bodyFixedFrameFor(request.object) ?? `IAU_${request.object.toUpperCase()}`, origin: request.object } : request;
  const item = definition(referenceRelationship(resolvedRequest, crypto.randomUUID()));
  const colored = item.kind !== 'axes';
  if (colored) item.color = colors[measurements.nextColor % colors.length];
  measurements.items.push(item); if (colored) measurements.nextColor++;
  selectMeasurement(item.id); openTool('measure');
  // The kept draft moves on to the next color too, unless one was chosen for it.
  if (colored && suspendedDraft && suspendedDraft.color === item.color) suspendedDraft.color = colors[measurements.nextColor % colors.length];
  return item.id;
}
/** Directions saved items offer as angle operands: directions, velocities and each frame axis. */
export function availableOperands(): Array<{ key: string; label: string; vector: ReferenceVector }> {
  return measurements.items.flatMap(item => {
    const valid = relationship(item);
    return valid ? relationshipVectors(valid).map((vector, i) => ({ key: `${item.id}:${i}`, label: referenceVectorLabel(vector), vector })) : [];
  });
}
export function removeMeasurement(id: string): void {
  if (measurements.editingId === id) newMeasurement();
  const index = measurements.items.findIndex(item => item.id === id);
  if (index >= 0) measurements.items.splice(index, 1);
  if (measurements.hoveredId === id) measurements.hoveredId = null;
  syncMeasurements();
}
export function duplicateMeasurement(id: string): void {
  applyMeasurementFields();
  const item = measurements.items.find(item => item.id === id);
  if (!item) return;
  const copy = { ...item, ...cloneDraft(item), ...cloneOperands(item), id: crypto.randomUUID() };
  measurements.items.push(copy); if (copy.kind !== 'axes') measurements.nextColor++;
  selectMeasurement(copy.id);
}
function currentEt(): number {
  return getCurrentRenderer()?.timeController.et ?? getUniverse()?.time ?? 0;
}
/** Whether the axes frame being edited resolves now; `unknown` names no frame at all. */
export function draftFrameAvailability(et = currentEt()): 'available' | 'unknown' | 'unavailable' {
  const universe = getUniverse();
  return universe ? frameAvailability(universe, measurements.draftFrame, et) : 'unavailable';
}
export function draftFrameMessage(et = currentEt()): string {
  const availability = draftFrameAvailability(et);
  if (availability === 'unknown') return `No frame named “${measurements.draftFrame.trim()}”. Use IAU_<body>, an inertial frame such as J2000, or a frame from a furnished kernel.`;
  if (availability === 'unavailable') return 'Orientation unavailable at this time. Choose another frame or change the time.';
  return '';
}
/** Every required field is set, and an axes frame resolves at the current time. */
export function draftReady(et = currentEt()): boolean {
  const { source, target, vertex } = measurements.draft;
  switch (measurements.draftKind) {
    case 'velocity': return !!source;
    case 'axes': return !!source && draftFrameAvailability(et) === 'available';
    case 'vector-angle': return !!measurements.draftOperands.first && !!measurements.draftOperands.second;
    case 'angle': return !!source && !!target && !!vertex;
    default: return !!source && !!target;
  }
}
export function createMeasurement(): boolean {
  if (measurements.editingId || !draftReady()) return false;
  const draft: MeasurementDefinition = { id: crypto.randomUUID(), kind: measurements.draftKind, ...cloneDraft(measurements.draft), color: measurements.draftColor,
    showDistance: measurements.draftShowDistance, fullLength: measurements.draftFullLength, frame: measurements.draftFrame, ...cloneOperands(measurements.draftOperands) };
  const valid = relationship(draft);
  if (!valid) return false;
  addMeasurement(valid); return true;
}
export function resetMeasurementDraft(preserveKind = false): void {
  suspendedDraft = null;
  measurements.editingId = null; measurements.selectedId = null;
  if (!preserveKind) measurements.draftKind = 'distance';
  cancelMeasurementPick();
  measurements.draft = emptyDraft(); measurements.draftColor = colors[measurements.nextColor % colors.length];
  measurements.draftShowDistance = false; measurements.draftFullLength = false;
  measurements.draftFrame = ''; measurements.draftOperands = { first: null, second: null };
  autoFrame = null;
}
export function startMeasurementPick(slot: Slot, mode: 'object' | 'surface'): void {
  cancelAppearancePick();
  // One pointer mode at a time: an endpoint pick and the Point Probe would
  // both claim the next click.
  if (vs.probeActive) setProbeActive(false);
  measurements.pendingPickSlot = slot;
  measurements.pickMode = mode;
  measurements.hoveredId = null;
  syncMeasurements();
  measurements.pickFeedback = '';
  getCurrentRenderer()?.clearSpatialPickPreview();
}
export function cancelMeasurementPick(): boolean {
  const active = measurements.pendingPickSlot !== null;
  measurements.pendingPickSlot = null;
  measurements.pickFeedback = '';
  getCurrentRenderer()?.clearSpatialPickPreview();
  return active;
}
excludeFromProbe(cancelMeasurementPick);

/** Measurements are scene-owned: entity references never leak into a replacement catalog. */
export function resetMeasurementsForScene(): void {
  cancelAppearancePick();
  measurements.nextColor = 0;
  measurements.nextPoint = 1;
  measurements.selectedId = null;
  measurements.hoveredId = null;
  measurements.items = [];
  resetMeasurementDraft();
  syncMeasurements();
}
export function captureSurfaceEndpoint(point: SurfacePoint): boolean {
  const { bodyName, bodyFixedPositionKm: positionKm } = point;
  const slot = measurements.pendingPickSlot;
  if (!slot || measurements.pickMode !== 'surface') return false;
  const endpoints = [...measurements.items.flatMap(definitionEndpoints), ...definitionEndpoints({ ...measurements.draft, ...measurements.draftOperands }),
    ...(suspendedDraft ? definitionEndpoints({ ...suspendedDraft.draft, ...suspendedDraft.operands }) : [])];
  // Check candidate display names, rather than extracting counters from arbitrary
  // labels. This also handles legacy shared labels, copies and manually named points.
  let name: string;
  do { name = `${bodyName} point ${measurements.nextPoint++}`; }
  while (endpoints.some(e => e?.label === name || e?.label?.startsWith(`${name} (`)));
  measurements.draft[slot] = surfacePointEndpoint(point, `${name} (${positionKm.map(v => v.toFixed(2)).join(', ')} km)`);
  cancelMeasurementPick(); syncMeasurements();
  return true;
}
/** One renderer input path handles mouse, touch and labels before ordinary selection. */
export function configureMeasurementInput(renderer: UniverseRenderer): void {
  renderer.setSpatialInteraction({
    beforePick(x, y) {
      const slot = measurements.pendingPickSlot;
      if (!slot) return false;
      if (measurements.pickMode === 'object') {
        const name = renderer.pickBody(x, y);
        if (name) { measurements.draft[slot] = { kind: 'entity', bodyName: name }; cancelMeasurementPick(); syncMeasurements(); }
        else measurements.pickFeedback = 'No object here. Pick a body, marker, or label.';
      } else {
        const hit = renderer.pickScene(x, y, 'probe');
        if (hit?.kind === 'surface') captureSurfaceEndpoint(hit.point);
        else measurements.pickFeedback = 'No surface here. Pick a visible body surface.';
      }
      return true; // A miss also consumes the gesture and leaves the pick active.
    },
    preview(x, y) {
      if (!measurements.pendingPickSlot) { renderer.clearSpatialPickPreview(); return; }
      if (measurements.pickMode === 'object') {
        const name = renderer.pickBody(x, y);
        renderer.setHoveredBody(name);
        renderer.setSpatialPickPreview(null);
      } else {
        renderer.setHoveredBody(null);
        const hit = renderer.pickScene(x, y, 'probe');
        renderer.setSpatialSurfacePreview(hit?.kind === 'surface' ? hit.point : null);
      }
    },
    clearPreview: () => renderer.clearSpatialPickPreview(),
    onSelect: selectMeasurement,
    onOpenEditor: openMeasurementEditor,
    onClearSelection: () => selectMeasurement(null),
    previewIntervalMs: () => 16,
    surfacePicking: () => measurements.pendingPickSlot !== null && measurements.pickMode === 'surface',
    labelIcon(kind) {
      const host = document.createElement('span');
      const component = flushSync(() => mount({ distance: Ruler, direction: Crosshair, angle: TriangleRight, velocity: Gauge, axes: Axis3d, 'vector-angle': TriangleRight }[kind], { target: host, props: { size: 12, 'aria-hidden': 'true' } }));
      const svg = host.querySelector('svg')!.cloneNode(true) as SVGSVGElement;
      void unmount(component); return svg;
    },
    onHover: hoverMeasurement,
    picking: () => measurements.pendingPickSlot !== null,
  });
}
export function measurementDescription(item: MeasurementDefinition): string {
  const valid = relationship(item);
  if (!valid) return 'Incomplete endpoints';
  switch (valid.kind) {
    case 'angle': return `At ${endpointLabel(valid.vertex)} · between ${endpointLabel(valid.source)} and ${endpointLabel(valid.target)}`;
    case 'direction': return `Direction to ${endpointLabel(valid.target)} · from ${endpointLabel(valid.source)}`;
    case 'distance': return `${endpointLabel(valid.source)} ↔ ${endpointLabel(valid.target)}`;
    case 'velocity': return `Velocity of ${endpointLabel(valid.object)} · relative to ${valid.relativeTo ? endpointLabel(valid.relativeTo) : 'its central body'}`;
    case 'axes': return `${valid.frame} axes · at ${endpointLabel(valid.origin)}`;
    case 'vector-angle': return `Between ${referenceVectorLabel(valid.first)} and ${referenceVectorLabel(valid.second)}`;
  }
}
export function measurementValue(item: MeasurementDefinition, et: number): string {
  const valid = relationship(item);
  if (!valid) return 'Incomplete endpoints';
  const universe = getUniverse();
  if (!universe) return 'Unavailable';
  const resolved = resolveSpatialRelationship(universe, valid, et);
  if (!resolved) return 'Unavailable at current time';
  switch (resolved.kind) {
    case 'angle': case 'vector-angle': return resolved.angleDeg === undefined ? 'Undefined angle' : `${resolved.angleDeg.toFixed(2)}°`;
    case 'direction': return resolved.distanceKm === 0 ? 'Undefined direction' : `Direction to ${endpointLabel(resolved.relationship.target)}${resolved.relationship.showDistance ? ` · ${formatSpatialDistance(resolved.distanceKm)}` : ''}`;
    case 'distance': return `Distance · ${formatSpatialDistance(resolved.distanceKm)}`;
    case 'velocity': return `${formatSpatialSpeed(resolved.speedKmS)} · relative to ${resolved.center ? endpointLabel(resolved.center) : 'scene origin'}`;
    case 'axes': return `${resolved.relationship.frame} · at ${endpointLabel(resolved.relationship.origin)}`;
  }
}

export function pickInstruction(): string {
  const slot = measurements.pendingPickSlot, object = measurements.pickMode === 'object';
  if (measurements.draftKind === 'angle') {
    if (slot === 'vertex') return object ? "Choose the angle’s center" : "Pick a surface point for the angle’s center";
    return `${object ? 'Pick' : 'Pick a surface point for'} ${slot === 'source' ? 'the first' : 'the second'} ${object ? 'object' : 'ray'}`;
  }
  if (measurements.draftKind === 'velocity') return `${object ? 'Pick' : 'Pick a surface point as'} the ${slot === 'source' ? 'moving object' : 'reference'}`;
  if (measurements.draftKind === 'axes') return object ? 'Pick the axes origin' : 'Pick a surface point for the axes origin';
  return object ? `Pick ${slot === 'source' ? 'first' : 'second'} object` : 'Pick a surface point';
}

/** Start the ordinary distance editor with an independent snapshot in the source slot. */
export function measureFromHere(point: SurfacePoint): void {
  applyMeasurementFields();
  resetMeasurementDraft();
  measurements.draft.source = surfacePointEndpoint(point);
  openTool('measure');
  startMeasurementPick('target', 'surface');
}
