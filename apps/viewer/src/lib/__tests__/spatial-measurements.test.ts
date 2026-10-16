import { probePoint } from './surface-point-fixture';
import { surfacePointEndpoint } from '@cosmolabe/core';
import { vs, clearProbePin, setProbeActive } from '../viewer-state.svelte';
import { openTool } from '../shell.svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Body, FixedPointTrajectory, FixedRotation, Universe, type SpatialEndpoint } from '@cosmolabe/core';
import type { UniverseRenderer, SpatialInteraction, SceneHit } from '@cosmolabe/three';
const scene = vi.hoisted(() => ({ universe: null as Universe | null }));
vi.mock('../loader', () => ({ getCurrentRenderer: () => null, getUniverse: () => scene.universe }));
vi.mock('../shell.svelte', () => ({ openTool: vi.fn() }));
import {
  measureFromHere, addMeasurement, captureSurfaceEndpoint, configureMeasurementInput,
  duplicateMeasurement, measurements, removeMeasurement, resetMeasurementsForScene, createMeasurement, syncMeasurements,
  startMeasurementPick, renderedMeasurements, newMeasurement, selectMeasurement, measurementValue, changeMeasurementKind,
  captureSharedMeasurements, restoreSharedMeasurements, showReference, availableOperands, measurementDescription, draftReady, draftFrameMessage,
} from '../spatial-measurements.svelte';

beforeEach(() => { vi.clearAllMocks(); scene.universe = null; resetMeasurementsForScene(); });
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
  it('retains endpoints and options when switching type away and back', () => {
    addMeasurement(original());
    measurements.draft.vertex = { kind: 'entity', bodyName: 'Sun' };
    changeMeasurementKind('angle');
    changeMeasurementKind('direction'); measurements.draftFullLength = true;
    changeMeasurementKind('distance'); changeMeasurementKind('angle');
    expect(measurements.items[0]).toMatchObject({ id: 'saved', kind: 'angle', vertex: { bodyName: 'Sun' }, fullLength: true });
    newMeasurement(); selectMeasurement('saved');
    expect(measurements.draft.vertex).toEqual({ kind: 'entity', bodyName: 'Sun' });
  });
});

describe('measurement URL restoration', () => {
  beforeEach(() => {
    scene.universe = new Universe();
    for (const name of ['Earth', 'Moon']) scene.universe.addBody(new Body({ name, trajectory: new FixedPointTrajectory([0, 0, 0]), rotation: new FixedRotation([1, 0, 0, 0]) }));
  });
  it('captures live edits without draft/pick/hover, restores after teardown and re-shares stable identities', () => {
    addMeasurement(original()); measurements.draftColor = '#abcdef';
    measurements.items[0].visible = false;
    measurements.hoveredId = 'saved'; startMeasurementPick('target', 'surface');
    const captured = captureSharedMeasurements()!;
    expect(captured.items[0]).toMatchObject({ color: '#abcdef', visible: false });
    resetMeasurementsForScene(); restoreSharedMeasurements(captured);
    expect(captureSharedMeasurements()).toEqual(captured);
    expect(measurements.selectedId).toBe('saved');
    expect(measurements.pendingPickSlot).toBeNull(); expect(measurements.hoveredId).toBeNull();
    expect(measurementValue(measurements.items[0], 0)).not.toContain('Unavailable');
    restoreSharedMeasurements(undefined); expect(measurements.items).toEqual([]);
  });
  it('does not replace any measurements on invalid/unavailable definitions or catalog replacement', () => {
    addMeasurement(original());
    const previous = captureSharedMeasurements()!;
    const invalid = { ...previous, items: [...previous.items, { ...previous.items[0], id: 'missing', target: { kind: 'entity' as const, bodyName: 'Absent' } }] };
    expect(() => restoreSharedMeasurements(invalid)).toThrow(/Absent.*unavailable/);
    expect(captureSharedMeasurements()).toEqual(previous);
    expect(() => restoreSharedMeasurements({ ...previous, selected: 'invalid' })).toThrow(/selected/);
    expect(captureSharedMeasurements()).toEqual(previous);
    resetMeasurementsForScene(); scene.universe = new Universe();
    expect(() => restoreSharedMeasurements(previous)).toThrow(/Earth.*unavailable/);
    expect(measurements.items).toEqual([]);
  });
  it('allocates distinct surface names after restore, including copied and existing labels, then re-shares', () => {
    addMeasurement({ ...original(), source: { ...original().source, label: 'Earth point 1 (1.00, 2.00, 3.00 km)' },
      target: { kind: 'body-fixed', bodyName: 'Earth', positionKm: [4, 5, 6], label: 'Earth point 2' } });
    duplicateMeasurement('saved'); newMeasurement();
    const shared = captureSharedMeasurements()!;
    resetMeasurementsForScene(); restoreSharedMeasurements(shared);
    expect(measurements.nextPoint).toBe(1);
    startMeasurementPick('source', 'surface'); captureSurfaceEndpoint(probePoint('Earth', [7, 8, 9]));
    expect(measurements.draft.source?.label).toBe('Earth point 3 (7.00, 8.00, 9.00 km)');
    startMeasurementPick('target', 'surface'); captureSurfaceEndpoint(probePoint('Earth', [10, 11, 12]));
    expect(measurements.draft.target?.label).toBe('Earth point 4 (10.00, 11.00, 12.00 km)');
    createMeasurement();
    const reshared = captureSharedMeasurements()!;
    restoreSharedMeasurements(reshared);
    expect(captureSharedMeasurements()).toEqual(reshared);
    newMeasurement(); startMeasurementPick('source', 'surface'); captureSurfaceEndpoint(probePoint('Earth', [13, 14, 15]));
    expect(measurements.draft.source?.label).toBe('Earth point 5 (13.00, 14.00, 15.00 km)');
  });
});

describe('measurement picking', () => {
  function input() {
    let hooks!: SpatialInteraction;
    const pickBody = vi.fn(() => 'Moon');
    const pickSurface = vi.fn();
    const pickScene = vi.fn(() => null as SceneHit | null);
    const setPickMarker = vi.fn();
    const setSpatialPickPreview = vi.fn(), clearSpatialPickPreview = vi.fn(), setHoveredBody = vi.fn();
    const renderer = { setSpatialInteraction: (value: SpatialInteraction) => { hooks = value; },
      renderer: { domElement: { clientWidth: 800, clientHeight: 600 } }, pickBody, pickScene, pickSurface, setPickMarker, setSpatialPickPreview, clearSpatialPickPreview, setHoveredBody };
    configureMeasurementInput(renderer as unknown as UniverseRenderer);
    return { hooks, pickBody, pickScene, pickSurface, setPickMarker, setSpatialPickPreview, clearSpatialPickPreview, setHoveredBody };
  }
  it('object picks use labels/body-center picking and never fabricate a surface hit', () => {
    const { hooks, pickBody, pickScene, pickSurface, setPickMarker } = input();
    startMeasurementPick('target', 'object'); expect(hooks.beforePick(100, 200)).toBe(true);
    expect(pickBody).toHaveBeenCalledWith(100, 200); expect(pickScene).not.toHaveBeenCalled(); expect(pickSurface).not.toHaveBeenCalled();
    expect(measurements.draft.target).toEqual({ kind: 'entity', bodyName: 'Moon' });
    expect(measurements.pendingPickSlot).toBeNull(); expect(setPickMarker).not.toHaveBeenCalled();
  });
  it('surface misses consume selection and stay active; actual hits preserve exact coordinates without standalone markers', () => {
    const { hooks, pickBody, pickScene, pickSurface, setPickMarker } = input();
    startMeasurementPick('source', 'surface'); expect(hooks.beforePick(400, 300)).toBe(true);
    expect(measurements.pendingPickSlot).toBe('source'); expect(measurements.pickFeedback).toContain('No surface');
    pickScene.mockReturnValue({ kind: 'surface', point: probePoint(), cameraRangeKm: 1 } as unknown as SceneHit);
    expect(hooks.beforePick(400, 300)).toBe(true);
    expect(pickScene).toHaveBeenLastCalledWith(400, 300, 'probe');
    expect(pickSurface).not.toHaveBeenCalled();
    expect(measurements.draft.source).toMatchObject(surfacePointEndpoint(probePoint()));
    expect(pickBody).not.toHaveBeenCalled(); expect(setPickMarker).not.toHaveBeenCalled();
    expect(hooks.beforePick(400, 300)).toBe(false);
  });
  it('never turns an object pick into a surface endpoint', () => {
    startMeasurementPick('source', 'object');
    expect(captureSurfaceEndpoint(probePoint('Earth', [1, 2, 3]))).toBe(false);
    expect(measurements.draft.source).toBeNull();
  });
});

it('shares the surface cursor while object previews retain their separate channel', () => {
  let hooks!: SpatialInteraction;
  const setSpatialPickPreview = vi.fn(), setSpatialSurfacePreview = vi.fn(), setHoveredBody = vi.fn(), clearSpatialPickPreview = vi.fn();
  const point = probePoint();
  const pickScene = vi.fn(() => ({ kind: 'surface', point, cameraRangeKm: 1 } as unknown as SceneHit | null));
  const renderer = { setSpatialInteraction: (value: SpatialInteraction) => { hooks = value; }, pickBody: () => 'Moon', pickScene,
    setSpatialPickPreview, setSpatialSurfacePreview, setHoveredBody, clearSpatialPickPreview };
  configureMeasurementInput(renderer as unknown as UniverseRenderer);
  startMeasurementPick('target', 'object'); hooks.preview?.(400, 300);
  expect(setHoveredBody).toHaveBeenLastCalledWith('Moon');
  expect(setSpatialPickPreview).toHaveBeenLastCalledWith(null);
  expect(hooks.surfacePicking?.()).toBe(false);
  expect(pickScene).not.toHaveBeenCalled();
  startMeasurementPick('target', 'surface'); hooks.preview?.(400, 300);
  expect(hooks.surfacePicking?.()).toBe(true);
  expect(pickScene).toHaveBeenLastCalledWith(400, 300, 'probe');
  expect(setSpatialSurfacePreview).toHaveBeenLastCalledWith(point);
  pickScene.mockReturnValue(null); hooks.preview?.(400, 300);
  expect(setSpatialSurfacePreview).toHaveBeenLastCalledWith(null);
  hooks.clearPreview?.(); expect(clearSpatialPickPreview).toHaveBeenCalled();
});

describe('reference geometry items', () => {
  beforeEach(() => {
    scene.universe = new Universe();
    scene.universe.addBody(new Body({ name: 'Sun', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    scene.universe.addBody(new Body({ name: 'Earth', parentName: 'Sun', trajectory: { stateAt: (et: number) => ({ position: [1000, 30 * et, 0], velocity: [0, 30, 0] }) }, rotation: new FixedRotation([1, 0, 0, 0]) }));
    scene.universe.addBody(new Body({ name: 'Moon', parentName: 'Earth', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
  });
  it('shows a reference by meaning as a selected item, keeping the unfinished draft for New', () => {
    measurements.draft.source = { kind: 'entity', bodyName: 'Moon' };
    const id = showReference({ kind: 'velocity', object: 'Earth' });
    expect(measurements.items).toEqual([expect.objectContaining({ id, kind: 'velocity', source: { kind: 'entity', bodyName: 'Earth' }, target: null })]);
    expect(measurements.selectedId).toBe(id);
    expect(measurementValue(measurements.items[0], 0)).toBe('30.000 km/s · relative to Sun');
    expect(measurementDescription(measurements.items[0])).toBe('Velocity of Earth · relative to its central body');
    newMeasurement();
    expect(measurements.draft.source).toEqual({ kind: 'entity', bodyName: 'Moon' });
    expect(measurements.draftColor).not.toBe(measurements.items[0].color);
  });
  it('defaults axes to the origin body’s own frame, following the origin until a frame is chosen', () => {
    changeMeasurementKind('axes');
    measurements.draft.source = { kind: 'entity', bodyName: 'Earth' }; syncMeasurements();
    expect(measurements.draftFrame).toBe('IAU_EARTH');
    measurements.draft.source = { kind: 'entity', bodyName: 'Moon' }; syncMeasurements();
    expect(measurements.draftFrame).toBe('ECLIPJ2000'); // No attitude: the scene frame.
    measurements.draftFrame = 'J2000';
    measurements.draft.source = { kind: 'entity', bodyName: 'Earth' }; syncMeasurements();
    expect(measurements.draftFrame).toBe('J2000');
    expect(createMeasurement()).toBe(true);
    expect(measurements.items[0]).toMatchObject({ kind: 'axes', frame: 'J2000' });
    expect(measurementValue(measurements.items[0], 0)).toBe('J2000 · at Earth');
  });
  it('refuses to add axes in a frame that does not resolve, and says why', () => {
    changeMeasurementKind('axes');
    measurements.draft.source = { kind: 'entity', bodyName: 'Earth' };
    measurements.draftFrame = 'NOT_A_FRAME'; syncMeasurements();
    expect(draftReady()).toBe(false);
    expect(draftFrameMessage()).toMatch(/No frame named “NOT_A_FRAME”/);
    expect(createMeasurement()).toBe(false);
    expect(measurements.items).toEqual([]);
    scene.universe!.addBody(new Body({ name: 'Gap', trajectory: new FixedPointTrajectory([0, 0, 0]),
      rotation: { sourceFrame: 'ECLIPJ2000', rotationAt: () => { throw new Error('No coverage'); } } }));
    measurements.draftFrame = 'IAU_GAP';
    expect(draftFrameMessage()).toMatch(/Orientation unavailable at this time/);
    expect(createMeasurement()).toBe(false);
    measurements.draftFrame = 'IAU_EARTH';
    expect(draftFrameMessage()).toBe('');
    expect(createMeasurement()).toBe(true);
    expect(measurements.items[0]).toMatchObject({ kind: 'axes', frame: 'IAU_EARTH' });
  });
  it('offers saved directions as angle operands and keeps an operand whose source item is deleted', () => {
    showReference({ kind: 'velocity', object: 'Earth' });
    const axes = showReference({ kind: 'bodyAxes', object: 'Earth' });
    newMeasurement();
    expect(availableOperands().map(o => o.label)).toEqual(['Velocity of Earth', 'IAU_EARTH +X at Earth', 'IAU_EARTH +Y at Earth', 'IAU_EARTH +Z at Earth']);
    changeMeasurementKind('vector-angle');
    measurements.draftOperands.first = availableOperands()[0].vector;
    measurements.draftOperands.second = availableOperands()[2].vector;
    expect(createMeasurement()).toBe(true);
    const angle = measurements.items[2];
    // Ecliptic +Y velocity against the equatorial body frame's +Y: the obliquity.
    expect(measurementValue(angle, 0)).toBe('23.44°');
    expect(availableOperands()).toHaveLength(4); // An angle is not itself an operand.
    removeMeasurement(axes);
    expect(measurementValue(angle, 0)).toBe('23.44°');
    const shared = captureSharedMeasurements()!;
    resetMeasurementsForScene(); restoreSharedMeasurements(shared);
    expect(captureSharedMeasurements()).toEqual(shared);
    expect(renderedMeasurements().map(r => r.kind)).toEqual(['velocity', 'vector-angle']);
  });
  it('retains frame and operands across type switches of a saved item, and duplicates them independently', () => {
    showReference({ kind: 'frameAxes', frame: 'J2000', origin: 'Earth' });
    const id = measurements.selectedId!;
    changeMeasurementKind('velocity'); syncMeasurements();
    expect(measurements.items[0]).toMatchObject({ kind: 'velocity', frame: 'J2000' });
    changeMeasurementKind('axes'); syncMeasurements();
    expect(measurements.items[0]).toMatchObject({ kind: 'axes', frame: 'J2000', source: { bodyName: 'Earth' } });
    duplicateMeasurement(id);
    measurements.draftFrame = 'ECLIPJ2000'; syncMeasurements();
    expect(measurements.items.map(item => item.frame)).toEqual(['J2000', 'ECLIPJ2000']);
  });
});

it('axes leave the color rotation to items that use it, including duplication', () => {
   scene.universe = new Universe();
   scene.universe.addBody(new Body({ name: 'Europa', trajectory: new FixedPointTrajectory([0, 0, 0]), rotation: new FixedRotation([1, 0, 0, 0]) }));
   const before = measurements.nextColor;
   const id = showReference({ kind: 'bodyAxes', object: 'Europa' });
   duplicateMeasurement(id);
   expect(measurements.items.map(item => item.color)).toEqual([undefined, undefined]);
   expect(measurements.nextColor).toBe(before);
 });

it('Measure from here starts a distance draft in source, picks target, and survives probe clearing/re-seating', () => {
  addMeasurement(original());
  measurements.draftColor = '#abcdef';
  const pin = probePoint(); vs.probePin = pin; setProbeActive(true);
  measureFromHere(vs.probePin!);
  expect(measurements.items[0].color).toBe('#abcdef');
  expect(openTool).toHaveBeenCalledWith('measure');
  expect(measurements.editingId).toBeNull();
  expect(measurements.draftKind).toBe('distance');
  expect(measurements.draft).toEqual({ source: surfacePointEndpoint(pin), target: null, vertex: null });
  expect(measurements.pendingPickSlot).toBe('target');
  expect(vs.probeActive).toBe(false);
  const expected = surfacePointEndpoint(probePoint());
  pin.hit.datum!.referenceShape = { kind: 'sphere', radiusKm: 1 };
  pin.terrainSample!.sourceId = 'changed';
  vs.probePin = probePoint('Earth', [9, 9, 9]);
  clearProbePin(); setProbeActive(false);
  expect(measurements.draft.source).toEqual(expected);
  measurements.draft.target = { kind: 'entity', bodyName: 'Moon' };
  createMeasurement(); clearProbePin();
  expect(measurements.items[1].source).toEqual(expected);
});

it('defaults axes at a SurfacePoint to its owning body frame and retains a chosen frame', () => {
  scene.universe = new Universe();
  scene.universe.addBody(new Body({ name: 'Earth', trajectory: new FixedPointTrajectory([0, 0, 0]), rotation: new FixedRotation([1, 0, 0, 0]) }));
  changeMeasurementKind('axes');
  measurements.draft.source = surfacePointEndpoint(probePoint()); syncMeasurements();
  expect(measurements.draftFrame).toBe('IAU_EARTH');
  expect(draftReady()).toBe(true);
  measurements.draftFrame = 'J2000'; syncMeasurements();
  expect(measurements.draftFrame).toBe('J2000');
  expect(createMeasurement()).toBe(true);
  const shared = captureSharedMeasurements()!;
  restoreSharedMeasurements(shared);
  expect(captureSharedMeasurements()).toEqual(shared);
  expect(measurementValue(measurements.items[0], 0)).toContain('J2000');
});

it.each(['terrain', 'surface-overlay', 'ellipsoid'] as const)('seeds a %s pin and completes through the existing surface or object picker', source => {
  let hooks!: SpatialInteraction;
  const pin = probePoint('Earth', [1, 2, 3], source);
  const target = probePoint('Earth', [4, 5, 6], source);
  const pickScene = vi.fn(() => ({ kind: 'surface' as const, point: target, cameraRangeKm: 1 }));
  const pickBody = vi.fn(() => 'Moon');
  const renderer = { setSpatialInteraction: (value: SpatialInteraction) => { hooks = value; }, pickScene, pickBody,
    clearSpatialPickPreview: vi.fn(), setSpatialSurfacePreview: vi.fn() };
  configureMeasurementInput(renderer as unknown as UniverseRenderer);
  for (const mode of ['surface', 'object'] as const) {
    vs.probePin = pin; setProbeActive(true); measureFromHere(vs.probePin!);
    expect(hooks.surfacePicking?.()).toBe(true);
    if (mode === 'object') startMeasurementPick('target', 'object');
    expect(hooks.beforePick(100, 200)).toBe(true);
    expect(measurements.pendingPickSlot).toBeNull();
    expect(createMeasurement()).toBe(true);
    clearProbePin(); setProbeActive(false);
    const item = measurements.items.at(-1)!;
    expect(item.source).toEqual(surfacePointEndpoint(pin));
    expect(item.target).toEqual(mode === 'surface' ? expect.objectContaining({ ...surfacePointEndpoint(target), label: expect.any(String) }) : { kind: 'entity', bodyName: 'Moon' });
    expect(hooks.beforePick(100, 200)).toBe(false);
  }
  expect(pickScene).toHaveBeenCalledWith(100, 200, 'probe');
  expect(pickBody).toHaveBeenCalledWith(100, 200);
});

it('switching into Point Probe cancels the target pick without removing the seeded endpoint', () => {
  measureFromHere(probePoint());
  setProbeActive(true);
  expect(measurements.pendingPickSlot).toBeNull();
  expect(measurements.draft.source).toEqual(surfacePointEndpoint(probePoint()));
  clearProbePin(); setProbeActive(false);
});
