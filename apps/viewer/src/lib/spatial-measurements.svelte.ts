import {
  formatSpatialDistance,
  resolveSpatialRelationship,
  type SpatialEndpoint,
  type SpatialRelationship,
} from '@cosmolabe/core';
import { getCurrentRenderer, getUniverse } from './loader';

type Slot = 'source' | 'target' | 'vertex';

export const measurements = $state({
  items: [] as SpatialRelationship[],
  pendingPickSlot: null as Slot | null,
  draft: { source: null, target: null, vertex: null } as Record<Slot, SpatialEndpoint | null>,
  sceneKey: '',
});

export function syncMeasurements(): void {
  getCurrentRenderer()?.setSpatialRelationships(measurements.items);
}

export function addMeasurement(item: SpatialRelationship): void {
  measurements.items.push(item);
  resetMeasurementDraft();
  syncMeasurements();
}

export function removeMeasurement(id: string): void {
  const index = measurements.items.findIndex(item => item.id === id);
  if (index >= 0) measurements.items.splice(index, 1);
  syncMeasurements();
}

export function resetMeasurementDraft(): void {
  measurements.pendingPickSlot = null;
  measurements.draft = { source: null, target: null, vertex: null };
}

export function cancelMeasurementPick(): boolean {
  if (!measurements.pendingPickSlot) return false;
  measurements.pendingPickSlot = null;
  return true;
}

/** Measurements are scene-owned: entity references must never leak into a replacement catalog. */
export function resetMeasurementsForScene(bodyNames: readonly string[]): void {
  const key = bodyNames.join('\0');
  if (key === measurements.sceneKey) return;
  measurements.sceneKey = key;
  measurements.items = [];
  resetMeasurementDraft();
  syncMeasurements();
}

export function captureSurfaceEndpoint(bodyName: string, positionKm: readonly [number, number, number]): boolean {
  const slot = measurements.pendingPickSlot;
  if (!slot) return false;
  measurements.draft[slot] = { kind: 'body-fixed', bodyName, positionKm: [...positionKm] };
  measurements.pendingPickSlot = null;
  return true;
}

export function measurementValue(item: SpatialRelationship, et: number): string {
  const universe = getUniverse();
  if (!universe) return 'Unavailable';
  const resolved = resolveSpatialRelationship(universe, item, et);
  if (!resolved) return 'Unavailable at current time';
  if (item.kind === 'angle') return resolved.angleDeg === undefined ? 'Undefined angle' : `${resolved.angleDeg.toFixed(2)}°`;
  if (item.kind === 'direction' && resolved.distanceKm === 0) return 'Undefined direction';
  if (item.kind === 'direction' && item.showDistance === false) return 'Direction';
  return `${item.kind === 'distance' ? '3D chord · ' : ''}${formatSpatialDistance(resolved.distanceKm ?? 0)}`;
}
