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
import {
  GF_BOUNDARY_MARGIN,
  LIGHT_TIME_PAD,
  NO_KERNELS_MESSAGE,
  eventSearchUnavailable,
  lightTimeDirection,
  type BodyEphemeris,
} from '../event-finder.svelte';
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

describe('event search availability under light-time correction', () => {
  // An occultation-shaped query: the observer's states are needed at the
  // window's own epochs, the targets' at light-time-corrected ones.
  const BODIES = { observer: 'Earth', front: 'Saturn', back: 'Sun' };
  const W = { start: 10_000, end: 20_000 };
  const LT = 4_500;
  const lt = () => LT;
  const m = GF_BOUNDARY_MARGIN;
  /** Saturn's coverage is under test; Earth and the Sun are covered throughout. */
  const saturnFrom = (start: number, end = 1e9) => (name: string): BodyEphemeris =>
    name === 'Saturn' ? [{ start, end }] : [{ start: -1e9, end: 1e9 }];

  it('reads the direction from the correction', () => {
    expect(['NONE', 'LT', 'LT+S', 'CN', 'cn+s', 'XLT', 'XLT+S', 'XCN+S'].map(lightTimeDirection))
      .toEqual(['none', 'reception', 'reception', 'reception', 'reception', 'transmission', 'transmission', 'transmission']);
  });

  it('refuses a target whose SPK opens just before the window, which only NONE can use', () => {
    // The case the GF margin alone would pass: coverage opens 3 s early, but an
    // LT search needs Saturn's states ~75 minutes before the window.
    const ephemeris = saturnFrom(W.start - m);
    expect(eventSearchUnavailable(3, BODIES, W, ephemeris, 'NONE', lt)).toBeNull();
    const fault = eventSearchUnavailable(3, BODIES, W, ephemeris, 'LT', lt);
    expect(fault?.code).toBe('unavailable');
    expect(fault?.message).toMatch(/^The loaded SPKs do not cover Saturn at the epochs this light-time-corrected search \(LT\) needs: SPICE evaluates its states about 1\.3 hr before the search window/);
  });

  it('allows a target covered from the light-time-shifted start', () => {
    const opens = W.start - LT * (1 + LIGHT_TIME_PAD) - m;
    expect(eventSearchUnavailable(3, BODIES, W, saturnFrom(opens), 'LT+S', lt)).toBeNull();
    expect(eventSearchUnavailable(3, BODIES, W, saturnFrom(opens + 1), 'LT+S', lt)?.code).toBe('unavailable');
  });

  it('does not demand reception coverage past the window end, which LT never reads', () => {
    // Needed through end − lt, not end: coverage closing mid-window is fine.
    const closes = W.end - LT * (1 - LIGHT_TIME_PAD) + m;
    expect(eventSearchUnavailable(3, BODIES, W, saturnFrom(-1e9, closes), 'LT', lt)).toBeNull();
    expect(eventSearchUnavailable(3, BODIES, W, saturnFrom(-1e9, closes - 1), 'LT', lt)?.code).toBe('unavailable');
  });

  it('mirrors for transmission corrections', () => {
    const closes = W.end + LT * (1 + LIGHT_TIME_PAD) + m;
    const ephemeris = (end: number) => (name: string): BodyEphemeris =>
      name === 'Saturn' ? [{ start: -1e9, end }] : [{ start: -1e9, end: 1e9 }];
    expect(eventSearchUnavailable(3, BODIES, W, ephemeris(closes), 'XLT', lt)).toBeNull();
    expect(eventSearchUnavailable(3, BODIES, W, ephemeris(W.end + m), 'XLT', lt)?.message)
      .toMatch(/about 1\.3 hr after the search window\. End the window sooner\./);
  });

  it('keeps the observer to the window itself under any correction', () => {
    const observerFrom = (start: number) => (name: string): BodyEphemeris =>
      name === 'Earth' ? [{ start, end: 1e9 }] : [{ start: -1e9, end: 1e9 }];
    expect(eventSearchUnavailable(3, BODIES, W, observerFrom(W.start - m), 'LT+S', lt)).toBeNull();
    expect(eventSearchUnavailable(3, BODIES, W, observerFrom(W.start + 1), 'LT+S', lt)?.message)
      .toMatch(/do not cover Earth for the whole search window/);
  });

  it('checks only what the correction makes necessary when the light time is unknown', () => {
    const unknown = () => undefined;
    // Coverage opening after the window starts cannot serve an LT search.
    expect(eventSearchUnavailable(3, BODIES, W, saturnFrom(W.start + 1), 'LT', unknown)?.message)
      .toMatch(/before the search window opens, by the light time/);
    // Opening just before it might, or might not: not refused, and not promised.
    expect(eventSearchUnavailable(3, BODIES, W, saturnFrom(W.start - m), 'LT', unknown)).toBeNull();
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
