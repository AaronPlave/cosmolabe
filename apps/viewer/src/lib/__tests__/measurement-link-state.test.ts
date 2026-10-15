import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Body, FixedPointTrajectory, FixedRotation, Universe } from '@cosmolabe/core';
import { validateMeasurementLinkState, validateMeasurementReferences, type MeasurementLinkState } from '../measurement-link-state';
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
    expect(() => viewLink(state, 'https://viewer.example/?source=' + 'a'.repeat(7500))).toThrow(/too large.*measurements/);
    state.measurements.items = Array.from({ length: 20 }, (_, i) => ({ ...shared().items[0], id: String(i), source: { kind: 'entity', bodyName: '界'.repeat(120) } }));
    delete state.measurements.selected;
    // Short raw Unicode payload still expands past the final encoded limit.
    expect(JSON.stringify(state).length).toBeLessThan(8192);
    expect(() => viewLink(state, 'https://viewer.example/')).toThrow(/ordinary URL.*measurements/);
    state.measurements.items = Array.from({ length: 32 }, (_, i) => ({ ...state.measurements.items[0], id: String(i), target: { kind: 'entity', bodyName: 'b'.repeat(128) } }));
    expect(JSON.stringify(state).length).toBeGreaterThan(8192);
    expect(() => viewLink(state, 'https://viewer.example/')).toThrow(/too large.*measurements/);
  });
});
