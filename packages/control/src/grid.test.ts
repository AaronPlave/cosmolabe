import { describe, expect, it } from 'vitest';
import { gridBodyState, normalizeGridSettings } from './grid.js';
import { snapshotScript } from './snapshot.js';
import { FakeViewer } from './__tests__/fake-host.js';
import { execute } from './execute.js';
import { parse } from './parse.js';

describe('persistent graticule state', () => {
  it('defaults to the tracked body, keeps explicit targets pinned, and honors the master switch', () => {
    const defaults = normalizeGridSettings();
    expect(gridBodyState(defaults, true, 'Moon', 'Moon').visible).toBe(true);
    expect(gridBodyState(defaults, true, 'Earth', 'Moon').visible).toBe(false);
    const pinned = normalizeGridSettings({ scope: 'bodies', bodies: ['Moon'] });
    expect(gridBodyState(pinned, true, 'Moon', 'Earth').visible).toBe(true);
    expect(gridBodyState(pinned, true, 'Earth', 'Earth').visible).toBe(false);
    const all = normalizeGridSettings({ scope: 'all', perBody: { Moon: { visible: false }, Earth: { labels: false } } });
    expect(gridBodyState(all, true, 'Moon', null).visible).toBe(false);
    expect(gridBodyState(all, true, 'Earth', null)).toEqual({ visible: true, labels: false });
    expect(gridBodyState(all, false, 'Earth', null).visible).toBe(false);
  });
  it('bounds manual settings and serializes all grid state through script verbs', () => {
    expect(normalizeGridSettings({ spacingDeg: 0 }).spacingDeg).toBe(0.001);
    const grid = normalizeGridSettings({ scope: 'bodies', bodies: ['Earth', 'Moon'], density: 'manual', spacingDeg: 0.1,
      labels: false, minorLines: true, coordinateFrame: true, perBody: { Moon: { visible: true, labels: true } } });
    const script = snapshotScript({ time: 0, rate: 1, playing: false, selected: null, tracked: null, lookAt: null,
      frame: { mode: 'free-orbit' }, camera: { position: [1, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: 60 }, layers: { grid: false }, grid });
    expect(script).toContain('setGridScope bodies Earth,Moon');
    expect(script).toContain('setGridDensity manual 0.1');
    expect(script).toContain('setGridCoordinateFrame on');
    expect(script).toContain('showBodyGridLabels Moon on');
    expect(() => parse(script)).not.toThrow();
    expect(script.trim().endsWith('setLayer grid off\ndeselect')).toBe(true);
  });
});

it('replays complete grid state and the master switch into a fresh host', async () => {
  const source = new FakeViewer();
  source.grid = normalizeGridSettings({ scope: 'bodies', bodies: ['Titan', 'Saturn'], density: 'manual', spacingDeg: 0.1,
    labels: false, coordinateFrame: true, perBody: { Titan: { visible: true, labels: true } } });
  source.layers.grid = false;
  const target = new FakeViewer();
  await execute(parse(source.snapshot()), target);
  expect(target.grid).toEqual(source.grid);
  expect(target.layers.grid).toBe(false);
});
