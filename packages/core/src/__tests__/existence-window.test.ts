// Existence windows: a catalog item's `startTime` / `endTime` bound when the
// body is in the scene (Cosmographia semantics), and a body is present only
// while every body it is placed relative to is present too.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Universe, type CatalogJson } from '../index.js';

const iso = (s: string) => (Date.parse(s) - Date.parse('2000-01-01T11:58:55.816Z')) / 1000;

function universe(items: unknown[]): Universe {
  const u = new Universe();
  u.loadCatalog({ name: 't', items } as unknown as CatalogJson);
  return u;
}

describe('existence windows', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads item startTime / endTime as the body\'s window, bounds inclusive', () => {
    const u = universe([
      { name: 'Sun', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
      {
        name: 'Probe',
        center: 'Sun',
        startTime: '2010-01-01T00:00:00Z',
        endTime: '2012-01-01T00:00:00Z',
        trajectory: { type: 'FixedPoint', position: [1e6, 0, 0] },
      },
    ]);
    const probe = u.getBody('Probe')!;
    const start = probe.existsFrom!;
    const end = probe.existsUntil!;
    // UTC→ET is the same map with or without SPICE here, to within the leap-second table.
    expect(Math.abs(start - iso('2010-01-01T00:00:00Z'))).toBeLessThan(40);
    expect(end - start).toBeCloseTo(730 * 86400, -2);

    expect(probe.existsAt(start - 1)).toBe(false);
    expect(probe.existsAt(start)).toBe(true);
    expect(probe.existsAt(end)).toBe(true);
    expect(probe.existsAt(end + 1)).toBe(false);
    expect(u.isPresentAt('Probe', start - 1)).toBe(false);
    expect(u.isPresentAt('Probe', start + 86400)).toBe(true);
  });

  it('leaves a body with no window always present', () => {
    const u = universe([{ name: 'Sun', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } }]);
    const sun = u.getBody('Sun')!;
    expect(sun.existsFrom).toBeUndefined();
    expect(sun.existsUntil).toBeUndefined();
    expect(u.isPresentAt('Sun', -1e12)).toBe(true);
    expect(u.isPresentAt('Sun', 1e12)).toBe(true);
    expect(u.isPresentAt('Nobody', 0)).toBe(false);
  });

  it('bounds only one side when only one is given', () => {
    const u = universe([
      { name: 'Lander', startTime: '2014-11-12T08:35:00Z', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
    ]);
    const lander = u.getBody('Lander')!;
    expect(lander.existsUntil).toBeUndefined();
    expect(u.isPresentAt('Lander', lander.existsFrom! - 60)).toBe(false);
    expect(u.isPresentAt('Lander', 1e12)).toBe(true);
  });

  it('hides a child while its parent is absent: an instrument does not outlive its spacecraft', () => {
    const u = universe([
      { name: 'Sun', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
      {
        name: 'Orbiter',
        center: 'Sun',
        endTime: '2016-09-30T10:39:28Z',
        trajectory: { type: 'FixedPoint', position: [1e6, 0, 0] },
        items: [{ name: 'Camera', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } }],
      },
    ]);
    const end = u.getBody('Orbiter')!.existsUntil!;
    expect(u.isPresentAt('Camera', end - 1)).toBe(true);
    expect(u.isPresentAt('Camera', end + 1)).toBe(false);
  });

  it('follows the active arc\'s centre, not the static parent', () => {
    const u = universe([
      { name: 'Sun', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
      {
        name: 'Mothership',
        center: 'Sun',
        startTime: '2014-01-01T00:00:00Z',
        trajectory: { type: 'FixedPoint', position: [1e6, 0, 0] },
      },
      {
        // Rides on the mothership in its first arc, flies free in its second.
        name: 'Daughter',
        center: 'Sun',
        arcs: [
          { center: 'Mothership', startTime: '2004-03-02T00:00:00Z', endTime: '2014-11-12T08:35:00Z', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
          { center: 'Sun', startTime: '2014-11-12T08:35:00Z', endTime: '2015-01-01T00:00:00Z', trajectory: { type: 'FixedPoint', position: [2e6, 0, 0] } },
        ],
      },
    ]);
    const motherFrom = u.getBody('Mothership')!.existsFrom!;
    // In the first arc, before the mothership exists: absent with it.
    expect(u.isPresentAt('Daughter', motherFrom - 86400)).toBe(false);
    expect(u.isPresentAt('Daughter', motherFrom + 86400)).toBe(true);
  });

  it('drops a bound it cannot read, with a warning, rather than reading it as J2000', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const u = universe([
      { name: 'Probe', endTime: 'not a date', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
    ]);
    expect(u.getBody('Probe')!.existsUntil).toBeUndefined();
    expect(u.isPresentAt('Probe', 1e9)).toBe(true);
    expect(warn.mock.calls.some((c) => /could not read endTime/.test(String(c[0])))).toBe(true);
  });
});
