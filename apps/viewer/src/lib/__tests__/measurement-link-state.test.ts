import { probePoint } from './surface-point-fixture';
import { surfacePointEndpoint, resolveSpatialRelationship } from '@cosmolabe/core';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Body, FixedPointTrajectory, FixedRotation, Universe } from '@cosmolabe/core';
import { definitionEndpoints, validateMeasurementLinkState, validateMeasurementReferences, type MeasurementDefinition, type MeasurementLinkState } from '../measurement-link-state';
import { requestedView, viewLink } from '../view-state-url';

const shared = (): MeasurementLinkState => ({ version: 1, selected: 'angle', items: [
  { id: 'distance', kind: 'distance', source: { kind: 'body-fixed', bodyName: 'Earth', positionKm: [1.123456789, -2, 3] }, target: { kind: 'entity', bodyName: 'Moon' }, vertex: null, visible: false, color: '#abcdef' },
  { id: 'direction', kind: 'direction', source: { kind: 'entity', bodyName: 'Earth' }, target: { kind: 'coordinate', frame: 'J2000', positionKm: [1e8, 2e8, 3e8] }, vertex: null, showDistance: true, fullLength: true },
  { id: 'angle', kind: 'angle', source: { kind: 'entity', bodyName: 'Earth' }, target: { kind: 'entity', bodyName: 'Moon' }, vertex: { kind: 'coordinate', frame: 'ECLIPJ2000', positionKm: [0, 0, 0] } },
] });
const base = () => requestedView(new URL(readFileSync(new URL('../../../test-permalinks/earth-moon-v1.url', import.meta.url), 'utf8').trim(), 'https://viewer.example/').search)!;
const universe = () => {
  const u = new Universe();
  for (const name of ['Earth', 'Moon']) u.addBody(new Body({ name, trajectory: new FixedPointTrajectory([0, 0, 0]), rotation: new FixedRotation([1, 0, 0, 0]) }));
  return u;
};

describe('shared measurement definitions', () => {
  it('round trips every type, flags, exact surfaces and explicit coordinate frames with identity and selection', () => {
    const state = { ...base(), measurements: shared() };
    const restored = requestedView(new URL(viewLink(state, 'https://viewer.example/')).search)!;
    expect(restored).toEqual(state);
    expect(requestedView(new URL(viewLink(restored, 'https://viewer.example/')).search)).toEqual(state);
    validateMeasurementReferences(restored.measurements!, universe(), 0);
    expect(base().measurements).toBeUndefined();
  });
  it('omits renderer/transient state and clones coordinates while preserving incomplete saved definitions', () => {
    const raw = shared();
    Object.assign(raw, { hovered: 'distance', pendingPickSlot: 'source', draft: {} });
    Object.assign(raw.items[0], { hovered: true, editing: true, distanceKm: 42 });
    raw.items[2].vertex = null;
    const result = validateMeasurementLinkState(raw);
    expect(result).toEqual({ ...shared(), items: [shared().items[0], shared().items[1], { ...shared().items[2], vertex: null }] });
    const source = result.items[0].source;
    if (source?.kind !== 'body-fixed') throw new Error('Missing surface');
    source.positionKm[0] = 99;
    expect(raw.items[0].source).toMatchObject({ positionKm: [1.123456789, -2, 3] });
  });
  it('rejects malformed types, endpoints, flags, identities, coordinates and selection as a whole', () => {
    const reject = (mutate: (raw: any) => void, error: RegExp) => { const raw = shared(); mutate(raw); expect(() => validateMeasurementLinkState(raw)).toThrow(error); };
    reject(s => s.version = 2, /version/);
    reject(s => s.items[1].kind = 'bearing', /type/);
    reject(s => s.items[1].source.kind = 'screen', /endpoint type/);
    reject(s => delete s.items[0].source, /malformed/);
    reject(s => delete s.items[2].vertex, /malformed/);
    reject(s => s.items[0].source.bodyName = '', /surface reference/);
    reject(s => s.items[0].source.positionKm = [1, 2], /coordinates/);
    for (const v of [Infinity, NaN, 1e13, '1']) reject(s => s.items[0].source.positionKm[0] = v, /coordinates/);
    reject(s => s.items[1].target.frame = {}, /frame/);
    reject(s => s.items[0].color = 'red', /color/);
    reject(s => s.items[0].visible = 1, /flag/);
    reject(s => s.items[1].showDistance = 'yes', /flag/);
    reject(s => s.items[1].fullLength = null, /flag/);
    reject(s => s.items[1].id = s.items[0].id, /duplicate/);
    reject(s => s.selected = 'absent', /selected/);
    reject(s => s.items = Array(33).fill(s.items[0]), /at most 32/);
  });
  it('reports unavailable catalog bodies, frames and body-fixed attitudes without substitutions', () => {
    const s = shared(), u = universe();
    s.items[1].target = { kind: 'coordinate', frame: 'NOT_A_FRAME', positionKm: [1, 2, 3] };
    expect(() => validateMeasurementReferences(s, u, 0)).toThrow(/frame.*NOT_A_FRAME.*unavailable/);
    s.items[1].target = { kind: 'entity', bodyName: 'Not in catalog' };
    expect(() => validateMeasurementReferences(s, u, 0)).toThrow(/body.*Not in catalog.*unavailable/);
    u.addBody(new Body({ name: 'No attitude', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    s.items[0].source = { kind: 'body-fixed', bodyName: 'No attitude', positionKm: [1, 0, 0] };
    expect(() => validateMeasurementReferences(s, u, 0)).toThrow(/attitude/);
  });
  it('enforces payload and encoded final URL limits without dropping measurements', () => {
    const state = { ...base(), measurements: shared() };
    expect(() => viewLink(state, 'https://viewer.example/?source=' + 'a'.repeat(7500))).toThrow(/too large.*reference geometry items/);
    state.measurements.items = Array.from({ length: 20 }, (_, i) => ({ ...shared().items[0], id: String(i), source: { kind: 'entity', bodyName: '界'.repeat(120) } }));
    delete state.measurements.selected;
    // Short raw Unicode payload still expands past the final encoded limit.
    expect(JSON.stringify(state).length).toBeLessThan(8192);
    expect(() => viewLink(state, 'https://viewer.example/')).toThrow(/ordinary URL.*reference geometry items/);
    state.measurements.items = Array.from({ length: 32 }, (_, i) => ({ ...state.measurements.items[0], id: String(i), target: { kind: 'entity', bodyName: 'b'.repeat(128) } }));
    expect(JSON.stringify(state).length).toBeGreaterThan(8192);
    expect(() => viewLink(state, 'https://viewer.example/')).toThrow(/too large.*reference geometry items/);
  });
});

describe('shared reference geometry', () => {
  const references = (): MeasurementLinkState => ({ version: 1, items: [
    { id: 'velocity', kind: 'velocity', source: { kind: 'entity', bodyName: 'Moon' }, target: null, vertex: null },
    { id: 'axes', kind: 'axes', source: { kind: 'entity', bodyName: 'Earth' }, target: null, vertex: null, frame: 'IAU_EARTH' },
    { id: 'angle', kind: 'vector-angle', source: null, target: null, vertex: null,
      first: { kind: 'velocity', object: { kind: 'entity', bodyName: 'Moon' }, relativeTo: { kind: 'entity', bodyName: 'Earth' } },
      second: { kind: 'frame-axis', frame: 'IAU_EARTH', origin: { kind: 'entity', bodyName: 'Earth' }, axis: '-Z' } },
    { id: 'pending', kind: 'vector-angle', source: null, target: null, vertex: null, first: null,
      second: { kind: 'direction', source: { kind: 'entity', bodyName: 'Moon' }, target: { kind: 'coordinate', frame: 'J2000', positionKm: [1, 0, 0] } } },
  ] });
  it('round trips velocities, axes and angles between directions, including incomplete operands', () => {
    const state = { ...base(), measurements: references() };
    expect(requestedView(new URL(viewLink(state, 'https://viewer.example/')).search)).toEqual(state);
    validateMeasurementReferences(references(), universe(), 0);
  });
  it('rejects malformed frames, axes and operands', () => {
    const reject = (mutate: (raw: any) => void, error: RegExp) => { const raw = references(); mutate(raw); expect(() => validateMeasurementLinkState(raw)).toThrow(error); };
    reject(s => s.items[1].frame = '', /frame/);
    reject(s => s.items[2].first.kind = 'acceleration', /direction type/);
    reject(s => s.items[2].second.axis = 'Z', /axis/);
    reject(s => s.items[2].second.frame = 7, /frame/);
    reject(s => s.items[2].first.object = null, /incomplete/);
    reject(s => s.items[3].second.target.kind = 'screen', /endpoint type/);
  });
  it('checks frames and bodies inside operands against the catalog', () => {
    const u = universe();
    const frame = references(); frame.items[1].frame = 'NOT_A_FRAME';
    expect(() => validateMeasurementReferences(frame, u, 0)).toThrow(/NOT_A_FRAME.*unavailable/);
    const axis = references(); (axis.items[2].second as { frame: string }).frame = 'IAU_ABSENT';
    expect(() => validateMeasurementReferences(axis, u, 0)).toThrow(/IAU_ABSENT.*unavailable/);
    const body = references(); (body.items[2].first as { relativeTo: { bodyName: string } }).relativeTo.bodyName = 'Absent';
    expect(() => validateMeasurementReferences(body, u, 0)).toThrow(/Absent.*unavailable/);
  });
});

it.each(['terrain', 'surface-overlay', 'ellipsoid', 'mesh', 'dsk'] as const)('round trips %s semantics and keeps equivalent XYZ geometry', source => {
  const point = probePoint('Earth', [1.123456789, -2, 3], source);
  const state = { ...base(), measurements: shared() };
  state.measurements.items[0].source = surfacePointEndpoint(point);
  const restored = requestedView(new URL(viewLink(state, 'https://viewer.example/')).search)!;
  expect(restored).toEqual(state);
  const endpoint = restored.measurements!.items[0].source!;
  expect(endpoint).not.toHaveProperty('point.resolution');
  expect(endpoint).not.toHaveProperty('point.surfaceNormal');
  expect(endpoint).not.toHaveProperty('point.altitude');
  expect(endpoint).toMatchObject({ point: { source } });
  if (source === 'dsk') expect(endpoint).not.toHaveProperty('point.terrainSample');
  else expect(endpoint).toMatchObject({ point: { terrainSample: { sourceId: 'global-dem', tileId: '4/2/3', describesHit: source === 'terrain' } } });
  validateMeasurementReferences(restored.measurements!, universe(), 0);
  const u = universe();
  const rich = resolveSpatialRelationship(u, { id: 'x', kind: 'distance', source: endpoint, target: { kind: 'entity', bodyName: 'Moon' } }, 0)!;
  const legacy = resolveSpatialRelationship(u, { id: 'x', kind: 'distance', source: { kind: 'body-fixed', bodyName: 'Earth', positionKm: [...point.bodyFixedPositionKm] }, target: { kind: 'entity', bodyName: 'Moon' } }, 0)!;
  expect(rich.source).toEqual(legacy.source); expect(rich.distanceKm).toBe(legacy.distanceKm);
});
it('rejects invalid surface versions, datum and provenance instead of rewriting semantics', () => {
  const raw = shared(); raw.items[0].source = surfacePointEndpoint(probePoint());
  const source = raw.items[0].source as any;
  source.version = 2; expect(() => validateMeasurementLinkState(raw)).toThrow(/version/);
  source.version = 1; source.point.terrainSample.describesHit = true;
  expect(() => validateMeasurementLinkState(raw)).toThrow(/semantics/);
  source.point.terrainSample.describesHit = false; source.point.hit.datum.origin = 'renderer';
  expect(() => validateMeasurementLinkState(raw)).toThrow(/origin/);
});

describe('SurfacePoint references in shared geometry', () => {
  const point = () => surfacePointEndpoint(probePoint());
  const items = (): MeasurementDefinition[] => [
    { id: 'distance', kind: 'distance', source: point(), target: { kind: 'entity', bodyName: 'Moon' }, vertex: null },
    { id: 'velocity', kind: 'velocity', source: point(), target: null, vertex: null },
    { id: 'axes', kind: 'axes', source: point(), target: null, vertex: null, frame: 'IAU_EARTH' },
    { id: 'direction-operand', kind: 'vector-angle', source: null, target: null, vertex: null,
      first: { kind: 'direction', source: { kind: 'entity', bodyName: 'Moon' }, target: point() },
      second: { kind: 'direction', source: point(), target: { kind: 'entity', bodyName: 'Moon' } } },
    { id: 'velocity-operand', kind: 'vector-angle', source: null, target: null, vertex: null,
      first: { kind: 'velocity', object: point(), relativeTo: point() },
      second: { kind: 'frame-axis', frame: 'IAU_EARTH', origin: point(), axis: '+X' } },
  ];
  it.each([0, 1, 2, 3, 4])('round trips definition %i and checks all nested body references', i => {
    const measurements: MeasurementLinkState = { version: 1, items: [items()[i]] };
    const state = { ...base(), measurements };
    const restored = requestedView(new URL(viewLink(state, 'https://viewer.example/')).search)!;
    expect(restored).toEqual(state);
    const endpoints = definitionEndpoints(restored.measurements!.items[0]).filter(e => e.kind === 'surface-point');
    expect(endpoints.length).toBeGreaterThan(0);
    validateMeasurementReferences(restored.measurements!, universe(), 0);
    for (const e of endpoints) {
      const name = e.point.bodyName;
      e.point.bodyName = 'Absent';
      expect(() => validateMeasurementReferences(restored.measurements!, universe(), 0)).toThrow(/Absent.*unavailable/);
      e.point.bodyName = name;
    }
    endpoints[0].point.bodyName = 'No attitude';
    const u = universe(); u.addBody(new Body({ name: 'No attitude', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
    expect(() => validateMeasurementReferences(restored.measurements!, u, 0)).toThrow(/attitude/);
  });
  it('preserves an unavailable altitude datum instead of inventing a height for DSK points', () => {
    const p = probePoint('Earth', [1, 2, 3], 'dsk');
    p.hit = { heightKm: null, datum: null }; p.altitude = { km: null, from: 'unavailable', datum: null }; delete p.terrainSample;
    const state = { ...base(), measurements: { version: 1 as const, items: [{ ...items()[0], source: surfacePointEndpoint(p) }] } };
    const restored = requestedView(new URL(viewLink(state, 'https://viewer.example/')).search)!;
    expect(restored).toEqual(state);
    expect(restored.measurements!.items[0].source).toMatchObject({ point: { hit: { heightKm: null, datum: null } } });
    const invalid = surfacePointEndpoint(p); invalid.point.hit.heightKm = 0;
    state.measurements.items[0].source = invalid;
    expect(() => validateMeasurementLinkState(state.measurements)).toThrow(/inconsistent hit datum/);
  });
});
