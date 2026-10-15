import { describe, expect, it } from 'vitest';
import { FakeViewer } from './__tests__/fake-host.js';
import { applyViewState, decodeViewState, encodeViewState, validateViewState, viewStateAtEpoch, type ViewStateV1 } from './view-state.js';

const state = (): ViewStateV1 => ({
  version: 1, catalog: { catalog: 'earth-moon' }, time: { kind: 'fixed', source: 'ET', et: 123456 },
  view: { kind: 'pose', version: 1, frame: 'ECLIPJ2000', origin: 'Titan',
    camera: { position: [10000, 5000, 2000], target: [0, 0, 0], up: [0, 1, 0], fov: 42 } },
  navigation: { selected: 'Cassini', tracked: null, lookAt: null, mode: 'free-orbit' },
  playback: { playing: false, rate: -30 }, display: { trajectories: false, labels: true },
});

describe('portable ViewState v1', () => {
  it('round-trips a view and strips additive fields outside the allowlist', () => {
    const input = { ...state(), panel: { x: 300 }, script: 'screenshot', display: { labels: true, plugin: 'eval' } };
    expect(decodeViewState(encodeViewState(input))).toEqual({ ...state(), display: { labels: true } });
  });

  it.each([
    [{ version: 2 }, /version/],
    [{ time: { kind: 'fixed', et: 12 } }, /time/],
    [{ time: { kind: 'fixed', source: 'ET', et: Infinity } }, /epoch/],
    [{ time: {} }, /time/],
    [{ catalog: { catalog: 'https://evil.example/file' } }, /catalog/],
    [{ catalog: { catalog: 'earth', entry: 'source/id' } }, /catalog/],
    [{ navigation: { selected: null, tracked: null, lookAt: null, mode: 'instrument' } }, /mode/],
    [{ playback: { playing: true, rate: NaN } }, /playback/],
    [{ display: { labels: 'on' } }, /display/],
  ])('rejects malformed state before applying: %j', (override, message) => {
    const host = new FakeViewer();
    expect(() => applyViewState(host, { ...state(), ...override } as ViewStateV1)).toThrow(message);
    expect(host.calls).toEqual([]);
  });

  it('rejects unknown coordinate semantics, bad vectors, and degenerate poses', () => {
    const s = state();
    if (s.view.kind !== 'pose') throw new Error('fixture');
    const view = s.view;
    expect(() => validateViewState({ ...s, view: { ...view, frame: 'J2000' } })).toThrow(/frame/);
    expect(() => validateViewState({ ...s, view: { ...view, camera: { ...view.camera, up: [0, 0, 0] } } })).toThrow(/Degenerate/);
    expect(() => validateViewState({ ...s, view: { ...view, camera: { ...view.camera, position: [NaN, 0, 1] } } })).toThrow(/pose/);
  });

  it('bounds payload size and rejects JSON errors', () => {
    expect(() => decodeViewState('x'.repeat(8193))).toThrow(/large/);
    expect(() => decodeViewState('{')).toThrow(/JSON/);
  });

  it('reports missing entities and viewpoints before any writes', () => {
    const host = new FakeViewer();
    expect(() => applyViewState(host, { ...state(), navigation: { ...state().navigation, selected: 'missing' } })).toThrow(/entity "missing"/);
    expect(() => applyViewState(host, { ...state(), view: { kind: 'named', name: 'Missing', fov: 60 } })).toThrow(/viewpoint "Missing"/);
    expect(host.calls).toEqual([]);
  });

  it('restores an untracked pose relative to its retained origin, playback and layers', () => {
    const s = state();
    if (s.view.kind !== 'pose') throw new Error('fixture');
    const host = new FakeViewer();
    let origin: string | null = null;
    host.setCameraReference = (name) => { origin = name; return true; };
    host.tracked = 'Saturn';
    host.lookAt = 'Enceladus';
    host.playing = true;
    applyViewState(host, decodeViewState(encodeViewState(state())));
    expect(origin).toBe('Titan');
    expect(host.time).toBe(123456);
    expect(host.camera).toEqual(s.view.camera);
    expect(host.tracked).toBeNull();
    expect(host.lookAt).toBeNull();
    expect(host.selected).toBe('Cassini');
    expect(host.rate).toBe(-30);
    expect(host.playing).toBe(false);
    expect(host.layers.trajectories).toBe(false);
  });

  it('makes time semantics override a named viewpoint epoch, including preserve', () => {
    const host = new FakeViewer();
    host.time = 987;
    host.viewpoint = () => { host.time = 777; return true; };
    const s = { ...state(), view: { kind: 'named' as const, name: 'Ring Plane View', fov: 45 } };
    applyViewState(host, { ...s, time: { kind: 'preserve' } });
    expect(host.time).toBe(987);
    applyViewState(host, s);
    expect(host.time).toBe(123456);
    applyViewState(host, { ...s, time: { kind: 'system', source: 'UTC' } }, { systemTime: '2026-10-01T00:00:00Z' });
    expect(host.timeText).toBe('2026-10-01T00:00:00Z');
  });

  it('reports control refusals and composes an event epoch without a result payload', () => {
    const host = new FakeViewer();
    host.setCameraReference = () => true;
    host.setFrame = () => false;
    expect(() => applyViewState(host, state())).toThrow(/frame unavailable/);
    expect(viewStateAtEpoch(state(), 0, 'Titan')).toMatchObject({ time: { kind: 'fixed', source: 'ET', et: 0 }, navigation: { selected: 'Titan' }, playback: { playing: false } });
  });
});
