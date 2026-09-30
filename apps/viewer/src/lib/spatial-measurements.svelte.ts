import type { SpatialEndpoint, SpatialRelationship } from '@cosmolabe/core';
import { getCurrentRenderer } from './loader';

export const measurements = $state({
  items: [] as SpatialRelationship[],
  pendingPickSlot: null as 'source' | 'target' | 'vertex' | null,
  picked: {} as Partial<Record<'source' | 'target' | 'vertex', SpatialEndpoint>>,
});

export function syncMeasurements(): void {
  getCurrentRenderer()?.setSpatialRelationships(measurements.items);
}

export function addMeasurement(item: SpatialRelationship): void {
  measurements.items.push(item);
  syncMeasurements();
}

export function removeMeasurement(id: string): void {
  const index = measurements.items.findIndex(item => item.id === id);
  if (index >= 0) measurements.items.splice(index, 1);
  syncMeasurements();
}

export function captureSurfaceEndpoint(bodyName: string, positionKm: readonly [number, number, number]): boolean {
  if (!measurements.pendingPickSlot) return false;
  measurements.picked[measurements.pendingPickSlot] = { kind: 'body-fixed', bodyName, positionKm: [...positionKm] };
  measurements.pendingPickSlot = null;
  return true;
}
