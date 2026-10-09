import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpatialEndpoint } from '@cosmolabe/core';
import type { UniverseRenderer, SpatialInteraction } from '@cosmolabe/three';
vi.mock('../loader', () => ({ getCurrentRenderer: () => null, getUniverse: () => null }));
import {
  addMeasurement, cancelMeasurementEdit, captureSurfaceEndpoint, configureMeasurementInput,
  editMeasurement, measurements, removeMeasurement, resetMeasurementsForScene, saveMeasurement,
  startMeasurementPick, renderedMeasurements, newMeasurement, selectMeasurement, measurementValue,
} from '../spatial-measurements.svelte';

beforeEach(resetMeasurementsForScene);
const original = () => ({ id: 'saved', kind: 'distance' as const,
  source: { kind: 'body-fixed' as const, bodyName: 'Earth', positionKm: [1, 2, 3] as [number, number, number] },
  target: { kind: 'entity' as const, bodyName: 'Moon' }, color: '#82aabd' });

describe('measurement edits', () => {
  it('keeps saved data unchanged until Save, preserves identity through kind changes, and restores an unrelated draft', () => {
    addMeasurement(original()); newMeasurement();
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
    expect(measurements.editingId).toBe('saved');
    newMeasurement();
    expect(measurements.draft.source).toEqual({ kind: 'entity', bodyName: 'Sun' });
    expect(measurements.draftColor).toBe('#abcdef');
  });
  it('cancel discards edits, and duplication owns its coordinates and a new identity', () => {
    addMeasurement(original()); newMeasurement();
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
  it('selection populates the editor, switching preserves buffers, and New resumes the unfinished definition', () => {
    addMeasurement(original()); newMeasurement();
    measurements.draft.target = { kind: 'entity', bodyName: 'Mars' };
    selectMeasurement('saved');
    expect(measurements.editingId).toBe('saved');
    expect(measurements.draft.target).toMatchObject({ bodyName: 'Moon' });
    measurements.draftColor = '#abcdef';
    newMeasurement();
    expect(measurements.draft.target).toMatchObject({ bodyName: 'Mars' });
    selectMeasurement('saved');
    expect(measurements.draftColor).toBe('#abcdef');
    measurements.hoveredId = 'saved'; removeMeasurement('saved');
    expect(measurements.selectedId).toBeNull(); expect(measurements.hoveredId).toBeNull();
    expect(measurements.editingId).toBeNull();
    resetMeasurementsForScene(); expect(measurements.draft.target).toBeNull();
  });
  it('valid edits replace the saved geometry in place, incomplete edits suppress it, and Cancel restores the original', () => {
    addMeasurement(original());
    measurements.draftKind = 'direction';
    measurements.draftColor = '#abcdef';
    expect(renderedMeasurements()).toMatchObject([{ id: 'saved', kind: 'direction', color: '#abcdef', selected: true, editing: true }]);
    expect(measurements.items[0].kind).toBe('distance');
    measurements.draft.target = null;
    expect(renderedMeasurements()).toEqual([]);
    expect(measurementValue(measurements.items[0], 0)).toBe('Incomplete endpoints');
    cancelMeasurementEdit();
    expect(renderedMeasurements()).toMatchObject([{ id: 'saved', kind: 'distance', color: '#82aabd' }]);
  });
  it('switching measurements retains both edit buffers without committing or overlapping previews', () => {
    addMeasurement(original()); newMeasurement();
    measurements.items.push({ ...original(), id: 'other' });
    selectMeasurement('saved'); measurements.draftColor = '#abcdef';
    selectMeasurement('other'); measurements.draftColor = '#123456';
    expect(renderedMeasurements()).toHaveLength(2);
    expect(measurements.items.map(item => item.color)).toEqual(['#82aabd', '#82aabd']);
    selectMeasurement('saved'); expect(measurements.draftColor).toBe('#abcdef');
    selectMeasurement('other'); expect(measurements.draftColor).toBe('#123456');
  });

});

describe('measurement picking', () => {
  function input() {
    let hooks!: SpatialInteraction;
    const pickBody = vi.fn(() => 'Moon');
    const pickSurface = vi.fn(() => null as null | { bodyName: string; bodyFixedHitKm: [number, number, number] });
    const setPickMarker = vi.fn();
    const setSpatialPickPreview = vi.fn(), clearSpatialPickPreview = vi.fn(), setHoveredBody = vi.fn();
    const renderer = { setSpatialInteraction: (value: SpatialInteraction) => { hooks = value; },
      renderer: { domElement: { clientWidth: 800, clientHeight: 600 } }, pickBody, pickSurface, setPickMarker, setSpatialPickPreview, clearSpatialPickPreview, setHoveredBody };
    configureMeasurementInput(renderer as unknown as UniverseRenderer);
    return { hooks, pickBody, pickSurface, setPickMarker, setSpatialPickPreview, clearSpatialPickPreview, setHoveredBody };
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

it('previews object and exact surface hits through a separate temporary channel, and clears misses', () => {
  let hooks!: SpatialInteraction;
  const setSpatialPickPreview = vi.fn(), setHoveredBody = vi.fn(), clearSpatialPickPreview = vi.fn();
  const pickSurface = vi.fn(() => ({ bodyName: 'Earth', bodyFixedHitKm: [1, 2, 3] as [number, number, number] } as { bodyName: string; bodyFixedHitKm: [number, number, number] } | null));
  const renderer = { setSpatialInteraction: (value: SpatialInteraction) => { hooks = value; }, pickBody: () => 'Moon', pickSurface,
    renderer: { domElement: { clientWidth: 800, clientHeight: 600 } }, setSpatialPickPreview, setHoveredBody, clearSpatialPickPreview };
  configureMeasurementInput(renderer as unknown as UniverseRenderer);
  startMeasurementPick('target', 'object'); hooks.preview?.(400, 300);
  expect(setSpatialPickPreview).toHaveBeenLastCalledWith({ kind: 'entity', bodyName: 'Moon' });
  startMeasurementPick('target', 'surface'); hooks.preview?.(400, 300);
  expect(setSpatialPickPreview).toHaveBeenLastCalledWith({ kind: 'body-fixed', bodyName: 'Earth', positionKm: [1, 2, 3] });
  pickSurface.mockReturnValue(null); hooks.preview?.(400, 300);
  expect(setSpatialPickPreview).toHaveBeenLastCalledWith(null);
  hooks.clearPreview?.(); expect(clearSpatialPickPreview).toHaveBeenCalled();
});
