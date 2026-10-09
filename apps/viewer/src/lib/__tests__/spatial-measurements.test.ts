import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpatialEndpoint } from '@cosmolabe/core';
import type { UniverseRenderer, SpatialInteraction } from '@cosmolabe/three';
vi.mock('../loader', () => ({ getCurrentRenderer: () => null, getUniverse: () => null }));
import {
  addMeasurement, cancelMeasurementEdit, captureSurfaceEndpoint, configureMeasurementInput,
  editMeasurement, measurements, removeMeasurement, resetMeasurementsForScene, saveMeasurement,
  startMeasurementPick, toggleMeasurementSelection,
} from '../spatial-measurements.svelte';

beforeEach(resetMeasurementsForScene);
const original = () => ({ id: 'saved', kind: 'distance' as const,
  source: { kind: 'body-fixed' as const, bodyName: 'Earth', positionKm: [1, 2, 3] as [number, number, number] },
  target: { kind: 'entity' as const, bodyName: 'Moon' }, color: '#82aabd' });

describe('measurement edits', () => {
  it('keeps saved data unchanged until Save, preserves identity through kind changes, and restores an unrelated draft', () => {
    addMeasurement(original());
    measurements.draft.source = { kind: 'entity', bodyName: 'Sun' };
    measurements.draftColor = '#abcdef';
    editMeasurement('saved');
    const editingSource = measurements.draft.source as SpatialEndpoint;
    if (editingSource.kind !== 'body-fixed') throw new Error('Expected body-fixed edit');
    editingSource.positionKm[0] = 99;
    expect(measurements.items[0].source).toEqual(original().source);
    measurements.draftKind = 'direction'; measurements.draftFullLength = true;
    expect(saveMeasurement()).toBe(true);
    expect(measurements.items[0]).toMatchObject({ id: 'saved', kind: 'direction', fullLength: true, showDistance: false });
    expect(measurements.draft.source).toEqual({ kind: 'entity', bodyName: 'Sun' });
    expect(measurements.draftColor).toBe('#abcdef');
  });
  it('cancel discards edits, and duplication owns its coordinates and a new identity', () => {
    addMeasurement(original());
    editMeasurement('saved'); measurements.draft.target = { kind: 'entity', bodyName: 'Mars' };
    cancelMeasurementEdit();
    expect(measurements.items[0].target).toEqual(original().target);
    editMeasurement('saved', true);
    expect(measurements.editingId).not.toBe('saved');
    expect(measurements.items).toHaveLength(1);
    const draft = measurements.draft.source;
    if (draft?.kind !== 'body-fixed') throw new Error('Expected body-fixed copy');
    draft.positionKm[0] = 9;
    saveMeasurement();
    expect(measurements.items).toHaveLength(2);
    expect(measurements.items[1].id).not.toBe('saved');
    expect(measurements.items[0].source).toEqual(original().source);
    draft.positionKm[0] = 15;
    expect(measurements.items[1].source).toMatchObject({ positionKm: [9, 2, 3] });
  });
  it('selection preserves an edit and creation draft, and removal/reset clear interaction state', () => {
    addMeasurement(original());
    measurements.draft.target = { kind: 'entity', bodyName: 'Mars' };
    toggleMeasurementSelection('saved');
    expect(measurements.draft.target).toMatchObject({ bodyName: 'Mars' });
    editMeasurement('saved'); toggleMeasurementSelection('saved');
    expect(measurements.editingId).toBe('saved');
    measurements.hoveredId = 'saved'; removeMeasurement('saved');
    expect(measurements.selectedId).toBeNull(); expect(measurements.hoveredId).toBeNull();
    expect(measurements.editingId).toBeNull();
    resetMeasurementsForScene(); expect(measurements.draft.target).toBeNull();
  });
});

describe('measurement picking', () => {
  function input() {
    let hooks!: SpatialInteraction;
    const pickBody = vi.fn(() => 'Moon');
    const pickSurface = vi.fn(() => null as null | { bodyName: string; bodyFixedHitKm: [number, number, number] });
    const setPickMarker = vi.fn();
    const renderer = { setSpatialInteraction: (value: SpatialInteraction) => { hooks = value; },
      renderer: { domElement: { clientWidth: 800, clientHeight: 600 } }, pickBody, pickSurface, setPickMarker };
    configureMeasurementInput(renderer as unknown as UniverseRenderer);
    return { hooks, pickBody, pickSurface, setPickMarker };
  }
  it('object picks use labels/body-center picking and never fabricate a surface hit', () => {
    const { hooks, pickBody, pickSurface, setPickMarker } = input();
    startMeasurementPick('target', 'object'); expect(hooks.beforePick(100, 200)).toBe(true);
    expect(pickBody).toHaveBeenCalledWith(100, 200); expect(pickSurface).not.toHaveBeenCalled();
    expect(measurements.draft.target).toEqual({ kind: 'entity', bodyName: 'Moon' });
    expect(measurements.pendingPickSlot).toBeNull(); expect(setPickMarker).not.toHaveBeenCalled();
  });
  it('surface misses consume selection and stay active; actual hits preserve exact coordinates without standalone markers', () => {
    const { hooks, pickBody, pickSurface, setPickMarker } = input();
    startMeasurementPick('source', 'surface'); expect(hooks.beforePick(400, 300)).toBe(true);
    expect(measurements.pendingPickSlot).toBe('source'); expect(measurements.pickFeedback).toContain('No surface');
    pickSurface.mockReturnValue({ bodyName: 'Earth', bodyFixedHitKm: [1, 2, 3] });
    expect(hooks.beforePick(400, 300)).toBe(true);
    expect(pickSurface).toHaveBeenLastCalledWith(0, 0);
    expect(measurements.draft.source).toMatchObject({ kind: 'body-fixed', positionKm: [1, 2, 3] });
    expect(pickBody).not.toHaveBeenCalled(); expect(setPickMarker).not.toHaveBeenCalled();
    expect(hooks.beforePick(400, 300)).toBe(false);
  });
  it('never turns an object pick into a surface endpoint', () => {
    startMeasurementPick('source', 'object');
    expect(captureSurfaceEndpoint('Earth', [1, 2, 3])).toBe(false);
    expect(measurements.draft.source).toBeNull();
  });
});
