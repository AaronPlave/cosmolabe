import { endpointLabel, formatSpatialDistance, resolveSpatialRelationship, type SpatialEndpoint, type SpatialRelationship } from '@cosmolabe/core';
import type { UniverseRenderer } from '@cosmolabe/three';
import { getCurrentRenderer, getUniverse } from './loader';

export type Slot = 'source' | 'target' | 'vertex';
type Kind = SpatialRelationship['kind'];
type Draft = Record<Slot, SpatialEndpoint | null>;
interface DraftSnapshot { kind: Kind; draft: Draft; color: string; showDistance: boolean; fullLength: boolean; }
const emptyDraft = (): Draft => ({ source: null, target: null, vertex: null });
const colors = ['#82aabd', '#c6a66b', '#9ab58d', '#b493ad'];
let suspendedDraft: DraftSnapshot | null = null;

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
export function syncMeasurements(): void {
  getCurrentRenderer()?.setSpatialRelationships(measurements.items.map(item => ({ ...item,
    selected: item.id === measurements.selectedId, hovered: item.id === measurements.hoveredId,
  })));
}
export function selectMeasurement(id: string | null): void {
  measurements.selectedId = id;
  syncMeasurements();
}
export function toggleMeasurementSelection(id: string): void {
  selectMeasurement(measurements.selectedId === id ? null : id);
}
export function hoverMeasurement(id: string | null): void {
  if (measurements.hoveredId === id) return;
  measurements.hoveredId = id;
  syncMeasurements();
}
export function addMeasurement(item: SpatialRelationship): void {
  measurements.items.push(item);
  measurements.nextColor++;
  measurements.selectedId = item.id;
  resetMeasurementDraft(true);
  syncMeasurements();
}
export function removeMeasurement(id: string): void {
  const index = measurements.items.findIndex(item => item.id === id);
  if (index >= 0) measurements.items.splice(index, 1);
  if (measurements.editingId === id) cancelMeasurementEdit();
  if (measurements.selectedId === id) measurements.selectedId = null;
  if (measurements.hoveredId === id) measurements.hoveredId = null;
  syncMeasurements();
}
export function editMeasurement(id: string, duplicate = false): void {
  const item = measurements.items.find(item => item.id === id);
  if (!item) return;
  // Switching edits discards only the edit buffer, never the unrelated creation draft.
  if (!suspendedDraft) suspendedDraft = { kind: measurements.draftKind, draft: cloneDraft(measurements.draft),
    color: measurements.draftColor, showDistance: measurements.draftShowDistance, fullLength: measurements.draftFullLength };
  measurements.editingId = duplicate ? crypto.randomUUID() : id;
  measurements.duplicating = duplicate;
  measurements.draftKind = item.kind;
  measurements.draft = { source: cloneEndpoint(item.source), target: cloneEndpoint(item.target), vertex: item.kind === 'angle' ? cloneEndpoint(item.vertex) : null };
  measurements.draftColor = item.color ?? colors[0];
  measurements.draftShowDistance = item.kind === 'direction' && item.showDistance === true;
  measurements.draftFullLength = item.kind === 'direction' && item.fullLength === true;
  cancelMeasurementPick();
}
export function cancelMeasurementEdit(): boolean {
  if (!measurements.editingId) return false;
  measurements.editingId = null;
  measurements.duplicating = false;
  cancelMeasurementPick();
  if (suspendedDraft) {
    measurements.draftKind = suspendedDraft.kind;
    measurements.draft = suspendedDraft.draft;
    measurements.draftColor = suspendedDraft.color;
    measurements.draftShowDistance = suspendedDraft.showDistance;
    measurements.draftFullLength = suspendedDraft.fullLength;
    suspendedDraft = null;
  }
  return true;
}
export function saveMeasurement(): boolean {
  const { source, target, vertex } = measurements.draft;
  const kind = measurements.draftKind;
  if (!source || !target || (kind === 'angle' && !vertex)) return false;
  const existing = measurements.items.find(item => item.id === measurements.editingId);
  const base = { id: measurements.editingId ?? crypto.randomUUID(), source: cloneEndpoint(source), target: cloneEndpoint(target),
    color: measurements.draftColor, visible: existing?.visible };
  const item: SpatialRelationship = kind === 'angle' ? { ...base, kind, vertex: cloneEndpoint(vertex!) }
    : kind === 'direction' ? { ...base, kind, showDistance: measurements.draftShowDistance, fullLength: measurements.draftFullLength }
    : { ...base, kind };
  if (measurements.editingId) {
    if (existing) measurements.items.splice(measurements.items.indexOf(existing), 1, item);
    else measurements.items.push(item);
    cancelMeasurementEdit();
    selectMeasurement(item.id);
  } else addMeasurement(item);
  return true;
}
export function resetMeasurementDraft(preserveKind = false): void {
  suspendedDraft = null;
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
  measurements.pickFeedback = '';
}
export function cancelMeasurementPick(): boolean {
  const active = measurements.pendingPickSlot !== null;
  measurements.pendingPickSlot = null;
  measurements.pickFeedback = '';
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
  cancelMeasurementPick();
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
        if (name) { measurements.draft[slot] = { kind: 'entity', bodyName: name }; cancelMeasurementPick(); }
        else measurements.pickFeedback = 'No object here. Pick a body, marker, or label.';
      } else {
        const canvas = renderer.renderer.domElement;
        const result = renderer.pickSurface(x / canvas.clientWidth * 2 - 1, 1 - y / canvas.clientHeight * 2);
        if (result) captureSurfaceEndpoint(result.bodyName, result.bodyFixedHitKm);
        else measurements.pickFeedback = 'No surface here. Pick a visible body surface.';
      }
      return true; // A miss also consumes the gesture and leaves the pick active.
    },
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
