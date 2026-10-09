import { endpointLabel, formatSpatialDistance, resolveSpatialRelationship, type SpatialEndpoint, type SpatialRelationship } from '@cosmolabe/core';
import { flushSync, mount, unmount } from 'svelte';
import { Ruler, MoveUpRight, TriangleRight } from 'lucide-svelte';
import { openTool } from './shell.svelte';
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
export interface MeasurementDefinition extends Draft { id: string; kind: Kind; color?: string; visible?: boolean; showDistance?: boolean; fullLength?: boolean; }

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
  editingId: null as string | null,
  nextColor: 0,
  nextPoint: 1,
  selectedId: null as string | null,
  hoveredId: null as string | null,
});

export function cloneEndpoint(endpoint: SpatialEndpoint): SpatialEndpoint {
  return endpoint.kind === 'entity' ? { ...endpoint } : { ...endpoint, positionKm: [...endpoint.positionKm] };
}
function cloneDraft(draft: Draft): Draft {
  return Object.fromEntries((['source', 'target', 'vertex'] as const).map(slot => [slot, draft[slot]] as const).map(([slot, endpoint]) => [slot, endpoint && cloneEndpoint(endpoint)])) as Draft;
}
function snapshot(): DraftSnapshot {
  return { kind: measurements.draftKind, draft: cloneDraft(measurements.draft), color: measurements.draftColor,
    showDistance: measurements.draftShowDistance, fullLength: measurements.draftFullLength };
}
function restore(value: DraftSnapshot): void {
  measurements.draftKind = value.kind; measurements.draft = cloneDraft(value.draft); measurements.draftColor = value.color;
  measurements.draftShowDistance = value.showDistance; measurements.draftFullLength = value.fullLength;
}
/** Incomplete definitions remain editable, but never produce stale geometry. */
function relationship(item: MeasurementDefinition): SpatialRelationship | null {
  const { source, target, vertex } = item;
  if (!source || !target || (item.kind === 'angle' && !vertex)) return null;
  return item.kind === 'angle' ? { ...item, source, target, kind: 'angle', vertex: vertex! }
    : item.kind === 'direction' ? { ...item, source, target, kind: 'direction' } : { ...item, source, target, kind: 'distance' };
}
export function applyMeasurementFields(): void {
  const item = measurements.items.find(item => item.id === measurements.editingId);
  if (!item) return;
  item.kind = measurements.draftKind; item.color = measurements.draftColor;
  item.showDistance = measurements.draftShowDistance; item.fullLength = measurements.draftFullLength;
  for (const slot of ['source', 'target', 'vertex'] as const) {
    const endpoint = slot === 'vertex' && item.kind !== 'angle' ? null : measurements.draft[slot];
    if (JSON.stringify(item[slot]) !== JSON.stringify(endpoint)) item[slot] = endpoint && cloneEndpoint(endpoint);
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
  restore({ kind: item.kind, draft: cloneDraft(item), color: item.color ?? colors[0], showDistance: item.showDistance === true, fullLength: item.fullLength === true });
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
export function openMeasurementEditor(id: string): void {
  selectMeasurement(id); openTool('measure');
  requestAnimationFrame(() => document.querySelector('[data-measurement-editor]')?.scrollIntoView({ block: 'nearest' }));
}
export function hoverMeasurement(id: string | null): void {
  if (measurements.hoveredId === id) return;
  measurements.hoveredId = id; syncMeasurements();
}
export function addMeasurement(item: SpatialRelationship): void {
  measurements.items.push({ ...item, source: cloneEndpoint(item.source), target: cloneEndpoint(item.target), vertex: item.kind === 'angle' ? cloneEndpoint(item.vertex) : null });
  measurements.nextColor++;
  resetMeasurementDraft(true);
  selectMeasurement(item.id);
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
  const copy = { ...item, ...cloneDraft(item), id: crypto.randomUUID() };
  measurements.items.push(copy); measurements.nextColor++;
  selectMeasurement(copy.id);
}
export function createMeasurement(): boolean {
  if (measurements.editingId) return false;
  const draft: MeasurementDefinition = { id: crypto.randomUUID(), kind: measurements.draftKind, ...cloneDraft(measurements.draft), color: measurements.draftColor, showDistance: measurements.draftShowDistance, fullLength: measurements.draftFullLength };
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
        renderer.setSpatialPickPreview(null);
      } else {
        renderer.setHoveredBody(null);
        const canvas = renderer.renderer.domElement;
        const result = renderer.pickSurface(x / canvas.clientWidth * 2 - 1, 1 - y / canvas.clientHeight * 2);
        renderer.setSpatialPickPreview(result ? { kind: 'body-fixed', bodyName: result.bodyName, positionKm: [...result.bodyFixedHitKm] } : null);
      }
    },
    clearPreview: () => renderer.clearSpatialPickPreview(),
    onSelect: selectMeasurement,
    onOpenEditor: openMeasurementEditor,
    previewIntervalMs: () => measurements.pickMode === 'surface' ? 75 : 16,
    labelIcon(kind) {
      const host = document.createElement('span');
      const component = flushSync(() => mount({ distance: Ruler, direction: MoveUpRight, angle: TriangleRight }[kind], { target: host, props: { size: 12, 'aria-hidden': 'true' } }));
      const svg = host.querySelector('svg')!.cloneNode(true) as SVGSVGElement;
      void unmount(component); return svg;
    },
    onHover: hoverMeasurement,
    picking: () => measurements.pendingPickSlot !== null,
  });
}
export function measurementDescription(item: MeasurementDefinition): string {
  if (!relationship(item)) return 'Incomplete endpoints';
  if (item.kind === 'angle') return `At ${endpointLabel(item.vertex!)} · between ${endpointLabel(item.source!)} and ${endpointLabel(item.target!)}`;
  return `${endpointLabel(item.source!)} ${item.kind === 'distance' ? '↔' : '→'} ${endpointLabel(item.target!)}`;
}
export function measurementValue(item: MeasurementDefinition, et: number): string {
  const valid = relationship(item);
  if (!valid) return 'Incomplete endpoints';
  const universe = getUniverse();
  if (!universe) return 'Unavailable';
  const resolved = resolveSpatialRelationship(universe, valid, et);
  if (!resolved) return 'Unavailable at current time';
  if (valid.kind === 'angle') return resolved.angleDeg === undefined ? 'Undefined angle' : `${resolved.angleDeg.toFixed(2)}°`;
  if (valid.kind === 'direction') return resolved.distanceKm === 0 ? 'Undefined direction' : `Direction to ${endpointLabel(valid.target)}${valid.showDistance ? ` · ${formatSpatialDistance(resolved.distanceKm ?? 0)}` : ''}`;
  return `Distance · ${formatSpatialDistance(resolved.distanceKm ?? 0)}`;
}

export function pickInstruction(): string {
  if (measurements.draftKind === 'angle') {
    if (measurements.pendingPickSlot === 'vertex') return measurements.pickMode === 'object' ? "Choose the angle’s center" : "Pick a surface point for the angle’s center";
    return `${measurements.pickMode === 'object' ? 'Pick' : 'Pick a surface point for'} ${measurements.pendingPickSlot === 'source' ? 'the first' : 'the second'} ${measurements.pickMode === 'object' ? 'object' : 'ray'}`;
  }
  return measurements.pickMode === 'object' ? `Pick ${measurements.pendingPickSlot === 'source' ? 'first' : 'second'} object` : 'Pick a surface point';
}
