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
import { NO_KERNELS_MESSAGE, eventSearchUnavailable } from '../event-finder.svelte';
import { faultMessage } from '../event-query';

const everyName = () => true;

describe('event search availability', () => {
  it('is unavailable, with the reason, in a scene with no kernels', () => {
    const fault = eventSearchUnavailable(0, { observer: 'Earth', target: 'Moon' }, everyName);
    expect(fault).toEqual({ code: 'unavailable', message: NO_KERNELS_MESSAGE });
    // The panel shows the policy itself, not a SPICE error.
    expect(faultMessage(fault!)).toBe(NO_KERNELS_MESSAGE);
    expect(faultMessage(fault!)).not.toMatch(/SPICE could not complete/);
  });

  it('is unavailable before any body is chosen, since it is the catalog that decides', () => {
    expect(eventSearchUnavailable(0, {}, everyName)?.code).toBe('unavailable');
  });

  it('is available when kernels are furnished and SPICE names every chosen body', () => {
    expect(eventSearchUnavailable(3, { observer: 'Europa Clipper', target: 'Europa' }, everyName)).toBeNull();
    expect(eventSearchUnavailable(3, {}, everyName)).toBeNull();
  });

  it('names the bodies SPICE cannot see in a scene that does have kernels', () => {
    const fault = eventSearchUnavailable(
      3,
      { observer: 'Rover', target: 'Mars' },
      (name) => name === 'Mars',
    );
    expect(fault?.code).toBe('unavailable');
    expect(fault?.message).toMatch(/^SPICE has no ephemeris for Rover: it moves/);
  });

  it('names a body once even when it fills two roles', () => {
    const fault = eventSearchUnavailable(3, { observer: 'Probe', target: 'Probe' }, () => false);
    expect(fault?.message).toMatch(/for Probe:/);
  });
});

describe('which demo catalogs get event search', () => {
  // Catalogs whose whole `require` graph declares no SPICE kernels. The finder
  // tells these it cannot search; every other demo searches through GF.
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
