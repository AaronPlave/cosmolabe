import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpatialEndpoint } from '@cosmolabe/core';
import type { UniverseRenderer, SpatialInteraction } from '@cosmolabe/three';
vi.mock('../loader', () => ({ getCurrentRenderer: () => null, getUniverse: () => null }));
import {
  addMeasurement, captureSurfaceEndpoint, configureMeasurementInput,
  duplicateMeasurement, measurements, removeMeasurement, resetMeasurementsForScene, createMeasurement, syncMeasurements,
  startMeasurementPick, renderedMeasurements, newMeasurement, selectMeasurement, measurementValue,
} from '../spatial-measurements.svelte';

beforeEach(resetMeasurementsForScene);
const original = () => ({ id: 'saved', kind: 'distance' as const,
  source: { kind: 'body-fixed' as const, bodyName: 'Earth', positionKm: [1, 2, 3] as [number, number, number] },
  target: { kind: 'entity' as const, bodyName: 'Moon' }, color: '#82aabd' });

describe('immediate measurement editing', () => {
  it('applies fields and kind changes to the existing identity and resumes the new draft', () => {
    addMeasurement(original()); newMeasurement();
    measurements.draft.source = { kind: 'entity', bodyName: 'Sun' };
    measurements.draftColor = '#abcdef';
    selectMeasurement('saved');
    const source = measurements.draft.source as SpatialEndpoint;
    if (source.kind !== 'body-fixed') throw new Error('Expected surface endpoint');
    source.positionKm[0] = 99;
    measurements.draftKind = 'direction'; measurements.draftFullLength = true;
    syncMeasurements();
    expect(measurements.items[0]).toMatchObject({ id: 'saved', kind: 'direction', fullLength: true, source: {positionKm:[99,2,3]} });
    newMeasurement();
    expect(measurements.draft.source).toEqual({ kind: 'entity', bodyName: 'Sun' });
    expect(measurements.draftColor).toBe('#abcdef');
    expect(measurements.items[0].kind).toBe('direction');
  });
  it('duplicates immediately with independent coordinates and no pending save', () => {
    addMeasurement(original()); duplicateMeasurement('saved');
    expect(measurements.items).toHaveLength(2);
    expect(measurements.editingId).not.toBe('saved');
    const source = measurements.draft.source;
    if (source?.kind !== 'body-fixed') throw new Error('Expected surface copy');
    source.positionKm[0] = 9; syncMeasurements(); newMeasurement();
    expect(measurements.items[0].source).toEqual(original().source);
    expect(measurements.items[1].source).toMatchObject({positionKm:[9,2,3]});
  });
  it('selection switching and clearing keep applied edits, including incomplete endpoints', () => {
    addMeasurement(original());
    measurements.items.push({ ...original(), id: 'other', vertex:null });
    measurements.draftColor = '#abcdef'; measurements.draft.target = null;
    selectMeasurement('other'); measurements.draftColor = '#123456';
    newMeasurement();
    expect(measurements.items.map(item => item.color)).toEqual(['#abcdef', '#123456']);
    expect(measurements.items[0].target).toBeNull();
    expect(renderedMeasurements()).toMatchObject([{id:'other'}]);
    expect(measurementValue(measurements.items[0],0)).toBe('Incomplete endpoints');
    selectMeasurement('saved'); expect(measurements.draft.target).toBeNull();
    measurements.draft.target = {kind:'entity',bodyName:'Moon'}; syncMeasurements();
    expect(renderedMeasurements()).toHaveLength(2);
  });
  it('creates only complete new definitions, then selects them for immediate editing', () => {
    expect(createMeasurement()).toBe(false);
    measurements.draft.source={kind:'entity',bodyName:'Earth'};
    measurements.draft.target={kind:'entity',bodyName:'Moon'};
    expect(createMeasurement()).toBe(true);
    expect(measurements.items).toHaveLength(1);
    expect(measurements.selectedId).toBe(measurements.items[0].id);
    expect(createMeasurement()).toBe(false);
    removeMeasurement(measurements.items[0].id);
    expect(measurements.items).toEqual([]);expect(measurements.selectedId).toBeNull();
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
  expect(setHoveredBody).toHaveBeenLastCalledWith('Moon');
  expect(setSpatialPickPreview).toHaveBeenLastCalledWith(null);
  expect(hooks.previewIntervalMs?.()).toBe(16);
  startMeasurementPick('target', 'surface'); hooks.preview?.(400, 300);
  expect(hooks.previewIntervalMs?.()).toBe(75);
  expect(setSpatialPickPreview).toHaveBeenLastCalledWith({ kind: 'body-fixed', bodyName: 'Earth', positionKm: [1, 2, 3] });
  pickSurface.mockReturnValue(null); hooks.preview?.(400, 300);
  expect(setSpatialPickPreview).toHaveBeenLastCalledWith(null);
  hooks.clearPreview?.(); expect(clearSpatialPickPreview).toHaveBeenCalled();
});
