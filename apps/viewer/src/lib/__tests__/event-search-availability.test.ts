/**
 * The SPICE-free policy, pinned.
 *
 * Event search is a SPICE feature: every kind is a composition of Geometry
 * Finder calls, and there is no sampled fallback for catalogs whose bodies SPICE
 * cannot see. These tests hold the decision in place — the finder states it up
 * front rather than failing inside CSPICE — and name the shipped demo catalogs
 * it applies to, so a catalog gaining or losing kernels is a visible change.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadCatalogFromUrl } from '@cosmolabe/core';
import { GF_BOUNDARY_MARGIN, NO_KERNELS_MESSAGE, eventSearchUnavailable, type BodyEphemeris } from '../event-finder.svelte';
import { faultMessage } from '../event-query';

const WINDOW = { start: 0, end: 100 };
const covered = (): BodyEphemeris => [{ start: -1_000, end: 1_000 }];

describe('event search availability', () => {
  it('is unavailable, with the reason, in a scene with no kernels', () => {
    const fault = eventSearchUnavailable(0, { observer: 'Earth', target: 'Moon' }, WINDOW, covered);
    expect(fault).toEqual({ code: 'unavailable', message: NO_KERNELS_MESSAGE });
    // The panel shows the policy itself, not a SPICE error.
    expect(faultMessage(fault!)).toBe(NO_KERNELS_MESSAGE);
    expect(faultMessage(fault!)).not.toMatch(/SPICE could not complete/);
  });

  it('is unavailable before any body is chosen, since it is the catalog that decides', () => {
    expect(eventSearchUnavailable(0, {}, null, covered)?.code).toBe('unavailable');
  });

  it('is available when every chosen body has SPK coverage reaching the window', () => {
    expect(eventSearchUnavailable(3, { observer: 'Europa Clipper', target: 'Europa' }, WINDOW, covered)).toBeNull();
    expect(eventSearchUnavailable(3, {}, WINDOW, covered)).toBeNull();
    // Exactly the GF margin beyond each end is enough.
    expect(eventSearchUnavailable(3, { target: 'Europa' }, WINDOW, () => [{ start: -3, end: 103 }])).toBeNull();
    // As is the default window, built by insetting coverage edges by the margin.
    const edge = 141_868_864.183_929_4;
    const inset = { start: edge + GF_BOUNDARY_MARGIN, end: edge + 86_400 - GF_BOUNDARY_MARGIN };
    expect(eventSearchUnavailable(3, { target: 'Europa' }, inset, () => [{ start: edge, end: edge + 86_400 }])).toBeNull();
  });

  it('refuses coverage that only partly covers the window', () => {
    // GF evaluates states across the whole confinement window, so [0, 90) with
    // no ephemeris fails as surely as no coverage at all.
    const fault = eventSearchUnavailable(3, { target: 'Europa' }, WINDOW, () => [{ start: 90, end: 500 }]);
    expect(fault?.message).toMatch(/do not cover Europa for the whole search window/);
    expect(eventSearchUnavailable(3, { target: 'Europa' }, WINDOW, () => [{ start: -500, end: 10 }])?.code)
      .toBe('unavailable');
  });

  it('refuses a window that ends exactly on an SPK edge, with no GF margin', () => {
    expect(eventSearchUnavailable(3, { target: 'Europa' }, WINDOW, () => [{ start: 0, end: 100 }])?.code)
      .toBe('unavailable');
    expect(eventSearchUnavailable(3, { target: 'Europa' }, WINDOW, () => [{ start: -3, end: 102 }])?.code)
      .toBe('unavailable');
  });

  it('refuses a window spanning a gap between coverage intervals', () => {
    const gapped = (): BodyEphemeris => [{ start: -100, end: 40 }, { start: 60, end: 200 }];
    expect(eventSearchUnavailable(3, { target: 'Europa' }, WINDOW, gapped)?.code).toBe('unavailable');
  });

  it('refuses a body SPICE knows by name but no loaded SPK carries', () => {
    // The mixed-catalog case: kernels are loaded and SPICE resolves "Io", but
    // the scene's Io is an analytic trajectory and no SPK has its states.
    const fault = eventSearchUnavailable(
      3,
      { observer: 'Jupiter', target: 'Io' },
      WINDOW,
      (name) => (name === 'Io' ? [] : covered()),
    );
    expect(fault?.code).toBe('unavailable');
    expect(fault?.message).toMatch(/^No loaded SPK has ephemeris for Io, so its position in this scene does not come from SPICE/);
  });

  it('refuses a body SPICE cannot identify, without claiming more than that', () => {
    const fault = eventSearchUnavailable(3, { observer: 'Rover', target: 'Mars' }, WINDOW,
      (name) => (name === 'Rover' ? 'unnamed' : covered()));
    expect(fault?.message).toMatch(/^SPICE cannot identify Rover,/);
  });

  it('refuses a window the bodies have no coverage in', () => {
    const fault = eventSearchUnavailable(3, { observer: 'Cassini', target: 'Saturn' }, WINDOW,
      () => [{ start: 500, end: 900 }]);
    expect(fault?.message).toMatch(/do not cover Cassini and Saturn for the whole search window/);
  });

  it('refuses nothing on coverage it could not read', () => {
    expect(eventSearchUnavailable(3, { target: 'Io' }, WINDOW, () => 'unknown')).toBeNull();
  });

  it('names a body once even when it fills two roles', () => {
    const fault = eventSearchUnavailable(3, { observer: 'Probe', target: 'Probe' }, WINDOW, () => 'unnamed');
    expect(fault?.message).toMatch(/identify Probe,/);
  });
});

describe('which demo catalogs cannot search at all', () => {
  // Catalogs whose whole `require` graph declares no SPICE kernels: the finder
  // refuses every search there. This is the catalog-level half of the policy
  // only — a catalog with kernels can still carry bodies no SPK describes (Io
  // in io-volcanos), and those are refused per body; see the real-kernel test
  // in closest-approach-altitude.integration.test.ts.
  const SPICE_FREE = [
    'earth-moon.json',
    'ingenuity-jezero.json',
    'inner-planets-keplerian.json',
    'iss.json',
    'moonfall-shackleton.json',
  ];

  it('is exactly the catalogs that furnish no kernels', async () => {
    const dir = new URL('../../../test-catalogs/', import.meta.url);
    const fetchJson = async (url: string) => JSON.parse(readFileSync(new URL(url), 'utf8'));
    const free: string[] = [];
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json').sort()) {
      const graph = await loadCatalogFromUrl(new URL(name, dir).href, fetchJson);
      if (graph.kernels.length === 0) free.push(name);
    }
    expect(free).toEqual(SPICE_FREE);
  });
});
