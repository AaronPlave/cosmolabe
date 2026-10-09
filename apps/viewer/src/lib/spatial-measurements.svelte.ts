import { endpointLabel, formatSpatialDistance, resolveSpatialRelationship, type SpatialEndpoint, type SpatialRelationship } from '@cosmolabe/core';
import type { UniverseRenderer } from '@cosmolabe/three';
import { getCurrentRenderer, getUniverse } from './loader';

export type Slot = 'source' | 'target' | 'vertex';
type Kind = SpatialRelationship['kind'];
type Draft = Record<Slot, SpatialEndpoint | null>;
interface DraftSnapshot { kind: Kind; draft: Draft; color: string; showDistance: boolean; fullLength: boolean; }
const emptyDraft = (): Draft => ({ source: null, target: null, vertex: null });
export const measurementColors = [{ name: 'Blue', color: '#82aabd' }, { name: 'Sand', color: '#c6a66b' }, { name: 'Sage', color: '#9ab58d' }, { name: 'Mauve', color: '#b493ad' }];
const colors = ['#82aabd', '#c6a66b', '#9ab58d', '#b493ad'];
let suspendedDraft: DraftSnapshot | null = null;
const editBuffers = new Map<string, DraftSnapshot & { duplicating: boolean }>();

export const measurements = $state({
  items: [] as SpatialRelationship[],
  draftKind: 'distance' as Kind,
  pendingPickSlot: null as Slot | null,
  pickMode: 'surface' as 'object' | 'surface',
  pickFeedback: '',
  draft: emptyDraft(),
  draftColor: colors[0],
  draftShowDistance: false,
  draftFullLength: false,
  editingId: null as string | null,
  duplicating: false,
  nextColor: 0,
  nextPoint: 1,
  selectedId: null as string | null,
  hoveredId: null as string | null,
});

export function cloneEndpoint(endpoint: SpatialEndpoint): SpatialEndpoint {
  return endpoint.kind === 'entity' ? { ...endpoint } : { ...endpoint, positionKm: [...endpoint.positionKm] };
}
function cloneDraft(draft: Draft): Draft {
  return Object.fromEntries(Object.entries(draft).map(([slot, endpoint]) => [slot, endpoint && cloneEndpoint(endpoint)])) as Draft;
}
function snapshot(): DraftSnapshot {
  return { kind: measurements.draftKind, draft: cloneDraft(measurements.draft), color: measurements.draftColor,
    showDistance: measurements.draftShowDistance, fullLength: measurements.draftFullLength };
}
function restore(value: DraftSnapshot): void {
  measurements.draftKind = value.kind; measurements.draft = cloneDraft(value.draft); measurements.draftColor = value.color;
  measurements.draftShowDistance = value.showDistance; measurements.draftFullLength = value.fullLength;
}
function rememberEdit(): void {
  if (measurements.editingId) editBuffers.set(measurements.editingId, { ...snapshot(), duplicating: measurements.duplicating });
}
export function draftMeasurement(id: string): SpatialRelationship | null {
  const { source, target, vertex } = measurements.draft;
  const kind = measurements.draftKind;
  if (!source || !target || (kind === 'angle' && !vertex)) return null;
  const base = { id, source: cloneEndpoint(source), target: cloneEndpoint(target), color: measurements.draftColor,
    visible: measurements.items.find(item => item.id === id)?.visible };
  return kind === 'angle' ? { ...base, kind, vertex: cloneEndpoint(vertex!) }
    : kind === 'direction' ? { ...base, kind, showDistance: measurements.draftShowDistance, fullLength: measurements.draftFullLength }
    : { ...base, kind };
}
/** The valid edit replaces its saved definition, never adds an overlapping copy. */
export function renderedMeasurements(): SpatialRelationship[] {
  const id = measurements.editingId;
  const preview = id ? draftMeasurement(id) : null;
  const items = measurements.items.flatMap(item => item.id === id ? preview ? [preview] : [] : [item]);
  if (preview && !items.some(item => item.id === id)) items.push(preview);
  return items.map(item => ({ ...item, selected: item.id === measurements.selectedId, hovered: item.id === measurements.hoveredId,
    editing: item.id === id }));
}
export function syncMeasurements(): void {
  const renderer = getCurrentRenderer();
  renderer?.setSpatialRelationships(renderedMeasurements());
  // A partial definition still has handles at its valid endpoints, not stale saved geometry.
  renderer?.setSpatialDraftEndpoints(measurements.editingId && draftMeasurement(measurements.editingId) ? []
    : Object.values(measurements.draft).filter((endpoint): endpoint is SpatialEndpoint => endpoint !== null));
}
export function selectMeasurement(id: string | null): void {
  if (id === null) { newMeasurement(); return; }
  if (measurements.editingId === id) { measurements.selectedId = id; syncMeasurements(); return; }
  editMeasurement(id);
}
export function toggleMeasurementSelection(id: string): void {
  selectMeasurement(measurements.selectedId === id ? null : id);
}
/** New resumes the unfinished creation draft; switching preserves each edit buffer. */
export function newMeasurement(): void {
  rememberEdit();
  measurements.editingId = null; measurements.duplicating = false; measurements.selectedId = null;
  cancelMeasurementPick();
  if (suspendedDraft) { restore(suspendedDraft); suspendedDraft = null; }
  syncMeasurements();
}
export function hoverMeasurement(id: string | null): void {
  if (measurements.hoveredId === id) return;
  measurements.hoveredId = id;
  syncMeasurements();
}
export function addMeasurement(item: SpatialRelationship): void {
  measurements.items.push(item);
  measurements.nextColor++;
  resetMeasurementDraft(true);
  selectMeasurement(item.id);
}
export function removeMeasurement(id: string): void {
  const index = measurements.items.findIndex(item => item.id === id);
  if (index >= 0) measurements.items.splice(index, 1);
  editBuffers.delete(id);
  if (measurements.editingId === id) cancelMeasurementEdit();
  if (measurements.selectedId === id) measurements.selectedId = null;
  if (measurements.hoveredId === id) measurements.hoveredId = null;
  syncMeasurements();
}
export function editMeasurement(id: string, duplicate = false): void {
  const item = measurements.items.find(item => item.id === id);
  const buffered = editBuffers.get(id);
  if (!item && !buffered) return;
  if (!duplicate && measurements.editingId === id) return;
  rememberEdit();
  if (!suspendedDraft) suspendedDraft = snapshot();
  measurements.editingId = duplicate ? crypto.randomUUID() : id;
  measurements.duplicating = duplicate || buffered?.duplicating === true;
  if (buffered && !duplicate) restore(buffered);
  else if (item) {
    measurements.draftKind = item.kind;
    measurements.draft = { source: cloneEndpoint(item.source), target: cloneEndpoint(item.target), vertex: item.kind === 'angle' ? cloneEndpoint(item.vertex) : null };
    measurements.draftColor = item.color ?? colors[0];
    measurements.draftShowDistance = item.kind === 'direction' && item.showDistance === true;
    measurements.draftFullLength = item.kind === 'direction' && item.fullLength === true;
  }
  measurements.selectedId = measurements.editingId;
  cancelMeasurementPick(); syncMeasurements();
}
export function cancelMeasurementEdit(): boolean {
  if (!measurements.editingId) return false;
  editBuffers.delete(measurements.editingId);
  measurements.editingId = null; measurements.duplicating = false; measurements.selectedId = null;
  cancelMeasurementPick();
  if (suspendedDraft) { restore(suspendedDraft); suspendedDraft = null; }
  syncMeasurements();
  return true;
}
export function saveMeasurement(): boolean {
  const id = measurements.editingId ?? crypto.randomUUID();
  const item = draftMeasurement(id);
  if (!item) return false;
  const index = measurements.items.findIndex(saved => saved.id === id);
  if (index >= 0) measurements.items.splice(index, 1, item);
  else { measurements.items.push(item); measurements.nextColor++; }
  editBuffers.delete(id);
  if (!measurements.editingId) {
    resetMeasurementDraft(true, true);
    editMeasurement(id);
  } else {
    measurements.duplicating = false;
    measurements.selectedId = id;
    syncMeasurements();
  }
  return true;
}
export function resetMeasurementDraft(preserveKind = false, preserveEdits = false): void {
  suspendedDraft = null;
  if (!preserveEdits) editBuffers.clear();
  measurements.editingId = null;
  measurements.duplicating = false;
  if (!preserveKind) measurements.draftKind = 'distance';
  cancelMeasurementPick();
  measurements.draft = emptyDraft();
  measurements.draftColor = colors[measurements.nextColor % colors.length];
  measurements.draftShowDistance = false;
  measurements.draftFullLength = false;
}
export function startMeasurementPick(slot: Slot, mode: 'object' | 'surface'): void {
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
/** Measurements are scene-owned: entity references never leak into a replacement catalog. */
export function resetMeasurementsForScene(): void {
  measurements.nextColor = 0;
  measurements.nextPoint = 1;
  measurements.selectedId = null;
  measurements.hoveredId = null;
  measurements.items = [];
  resetMeasurementDraft();
  syncMeasurements();
}
export function captureSurfaceEndpoint(bodyName: string, positionKm: readonly [number, number, number]): boolean {
  const slot = measurements.pendingPickSlot;
  if (!slot || measurements.pickMode !== 'surface') return false;
  measurements.draft[slot] = { kind: 'body-fixed', bodyName, positionKm: [...positionKm], label: `${bodyName} point ${measurements.nextPoint++} (${positionKm.map(v => v.toFixed(2)).join(', ')} km)` };
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
        const canvas = renderer.renderer.domElement;
        const result = renderer.pickSurface(x / canvas.clientWidth * 2 - 1, 1 - y / canvas.clientHeight * 2);
        if (result) captureSurfaceEndpoint(result.bodyName, result.bodyFixedHitKm);
        else measurements.pickFeedback = 'No surface here. Pick a visible body surface.';
      }
      return true; // A miss also consumes the gesture and leaves the pick active.
    },
    preview(x, y) {
      if (!measurements.pendingPickSlot) { renderer.clearSpatialPickPreview(); return; }
      if (measurements.pickMode === 'object') {
        const name = renderer.pickBody(x, y);
        renderer.setHoveredBody(name);
        renderer.setSpatialPickPreview(name ? { kind: 'entity', bodyName: name } : null);
      } else {
        renderer.setHoveredBody(null);
        const canvas = renderer.renderer.domElement;
        const result = renderer.pickSurface(x / canvas.clientWidth * 2 - 1, 1 - y / canvas.clientHeight * 2);
        renderer.setSpatialPickPreview(result ? { kind: 'body-fixed', bodyName: result.bodyName, positionKm: [...result.bodyFixedHitKm] } : null);
      }
    },
    clearPreview: () => renderer.clearSpatialPickPreview(),
    onSelect: toggleMeasurementSelection,
    onHover: hoverMeasurement,
    picking: () => measurements.pendingPickSlot !== null,
  });
}
export function measurementDescription(item: SpatialRelationship): string {
  if (item.kind === 'angle') return `At ${endpointLabel(item.vertex)} · between ${endpointLabel(item.source)} and ${endpointLabel(item.target)}`;
  return `${endpointLabel(item.source)} ${item.kind === 'distance' ? '↔' : '→'} ${endpointLabel(item.target)}`;
}
export function measurementValue(item: SpatialRelationship, et: number): string {
  if (item.id === measurements.editingId) {
    const preview = draftMeasurement(item.id);
    if (!preview) return 'Incomplete endpoints';
    item = preview;
  }
  const universe = getUniverse();
  if (!universe) return 'Unavailable';
  const resolved = resolveSpatialRelationship(universe, item, et);
  if (!resolved) return 'Unavailable at current time';
  if (item.kind === 'angle') return resolved.angleDeg === undefined ? 'Undefined angle' : `${resolved.angleDeg.toFixed(2)}°`;
  if (item.kind === 'direction') {
    if (resolved.distanceKm === 0) return 'Undefined direction';
    return `Direction to ${endpointLabel(item.target)}${item.showDistance ? ` · ${formatSpatialDistance(resolved.distanceKm ?? 0)}` : ''}`;
  }
  return `Distance · ${formatSpatialDistance(resolved.distanceKm ?? 0)}`;
}

export function pickInstruction(): string {
  if (measurements.draftKind === 'angle') {
    if (measurements.pendingPickSlot === 'vertex') return measurements.pickMode === 'object' ? "Choose the angle’s center" : "Pick a surface point for the angle’s center";
    return `${measurements.pickMode === 'object' ? 'Pick' : 'Pick a surface point for'} ${measurements.pendingPickSlot === 'source' ? 'the first' : 'the second'} ${measurements.pickMode === 'object' ? 'object' : 'ray'}`;
  }
  return measurements.pickMode === 'object' ? `Pick ${measurements.pendingPickSlot === 'source' ? 'first' : 'second'} object` : 'Pick a surface point';
}
