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
import { loadCatalogFromUrl, type EtInterval } from '@cosmolabe/core';
import {
  GF_BOUNDARY_MARGIN,
  LIGHT_TIME_PAD,
  NO_KERNELS_MESSAGE,
  coverageWindow,
  eventSearchUnavailable,
  lightTimeDirection,
  type BodyEphemeris,
} from '../event-availability';
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

describe('the default window agrees with the availability check', () => {
  // An Earth-observed occultation whose front body's SPK opens partway into the
  // catalog span — the case where a margin-only default is refused on sight
  // under light-time correction.
  const BODIES = { observer: 'Earth', front: 'Saturn', back: 'Sun' };
  const SPAN = { start: 0, end: 200_000 };
  const COVERAGE: Record<string, EtInterval[]> = {
    Earth: [{ start: -1e9, end: 1e9 }],
    Saturn: [{ start: 10_000, end: 150_000 }],
    Sun: [{ start: -1e9, end: 1e9 }],
  };
  const IDS: Record<string, number> = { Earth: 399, Saturn: 699, Sun: 10 };
  const fakeSpice = {
    bodn2c: (name: string) => IDS[name] ?? null,
    spkcov: (id: number) => COVERAGE[Object.keys(IDS).find((n) => IDS[n] === id)!] ?? [],
  };
  const ephemeris = (name: string): BodyEphemeris => COVERAGE[name] ?? 'unnamed';
  // Slowly varying, as real light time is: well under a second per second.
  const lightTime = (_t: string, _o: string, et: number): number | undefined => 4_500 + 1e-4 * (et - 10_000);
  const def = (abcorr: string, lt = lightTime) => coverageWindow(fakeSpice, BODIES, SPAN, undefined, abcorr, lt);

  it('is a window the check accepts, for every correction', () => {
    for (const abcorr of ['NONE', 'LT', 'LT+S', 'CN', 'CN+S', 'XLT', 'XLT+S', 'XCN+S']) {
      const window = def(abcorr);
      expect(eventSearchUnavailable(3, BODIES, window, ephemeris, abcorr, lightTime), abcorr).toBeNull();
    }
  });

  it('opens a light time after a reception target\'s SPK, and only the margin after it otherwise', () => {
    expect(def('NONE').start).toBe(10_000 + GF_BOUNDARY_MARGIN);
    const corrected = def('LT+S').start;
    expect(corrected).toBeGreaterThan(10_000 + GF_BOUNDARY_MARGIN + 4_500);
    expect(corrected).toBeLessThan(10_000 + GF_BOUNDARY_MARGIN + 4_500 * (1 + 2 * LIGHT_TIME_PAD));
    // Reception reads earlier epochs only, so the end keeps the plain margin.
    expect(def('LT+S').end).toBe(150_000 - GF_BOUNDARY_MARGIN);
  });

  it('closes a light time before a transmission target\'s SPK ends', () => {
    const window = def('XLT');
    expect(window.start).toBe(10_000 + GF_BOUNDARY_MARGIN);
    expect(window.end).toBeLessThan(150_000 - GF_BOUNDARY_MARGIN - 4_500);
  });

  it('falls back to the plain margin when the light time cannot be measured', () => {
    const window = def('LT', () => undefined);
    expect(window).toEqual({ start: 10_000 + GF_BOUNDARY_MARGIN, end: 150_000 - GF_BOUNDARY_MARGIN });
    expect(eventSearchUnavailable(3, BODIES, window, ephemeris, 'LT', () => undefined)).toBeNull();
  });

  it('does not narrow a span already clear of every edge', () => {
    const inside = { start: 50_000, end: 60_000 };
    expect(coverageWindow(fakeSpice, BODIES, inside, undefined, 'LT+S', lightTime)).toEqual(inside);
  });

  it('agrees with the check across many spans and coverages', () => {
    for (let opens = 0; opens <= 100_000; opens += 12_345) {
      for (const span of [{ start: 0, end: 300_000 }, { start: opens + 1, end: opens + 50_000 }]) {
        COVERAGE.Saturn = [{ start: opens, end: opens + 120_000 }];
        for (const abcorr of ['NONE', 'LT+S', 'XCN']) {
          const window = coverageWindow(fakeSpice, BODIES, span, undefined, abcorr, lightTime);
          if (window === span && eventSearchUnavailable(3, BODIES, span, ephemeris, abcorr, lightTime)) {
            // No window fits inside the span: the span itself comes back, and
            // being refused is then the honest answer, not a disagreement.
            continue;
          }
          expect(eventSearchUnavailable(3, BODIES, window, ephemeris, abcorr, lightTime), `${opens} ${abcorr}`).toBeNull();
        }
      }
    }
    COVERAGE.Saturn = [{ start: 10_000, end: 150_000 }];
  });
});

describe('the default window does not depend on role order', () => {
  // The #130 review's reproduction: the observer's SPK opens later than the
  // target's, and light time can only be measured where both have states.
  // Visiting the target first used to measure at an epoch the observer had no
  // state for, fall back to the plain margin, and never revisit it.
  const coverage: Record<string, EtInterval[]> = {
    Target: [{ start: 0, end: 1_000 }],
    Observer: [{ start: 50, end: 1_000 }],
  };
  const ids: Record<string, number> = { Target: 1, Observer: 2 };
  const spice = {
    bodn2c: (name: string) => ids[name] ?? null,
    spkcov: (id: number) => coverage[Object.keys(ids).find((n) => ids[n] === id)!] ?? [],
  };
  const ephemeris = (name: string): BodyEphemeris => coverage[name] ?? 'unnamed';
  const inside = (name: string, et: number) => coverage[name].some((c) => et >= c.start && et <= c.end);
  const lightTime = (target: string, observer: string, et: number) =>
    (inside(target, et) && inside(observer, et) ? 100 : undefined);
  const SPAN = { start: 0, end: 1_000 };
  const targetFirst = { target: 'Target', observer: 'Observer' };
  const observerFirst = { observer: 'Observer', target: 'Target' };
  const window = (bodies: typeof targetFirst, abcorr: string) =>
    coverageWindow(spice, bodies, SPAN, undefined, abcorr, lightTime);

  it('settles a reception target the same in either insertion order', () => {
    const a = window(targetFirst, 'LT+S');
    const b = window(observerFirst, 'LT+S');
    expect(a).toEqual(b);
    // One light time past the target's own SPK start would be 103.1; the
    // observer's coverage (opening at 50) does not change that.
    expect(a.start).toBeCloseTo(GF_BOUNDARY_MARGIN + 100 * (1 + LIGHT_TIME_PAD), 3);
    for (const bodies of [targetFirst, observerFirst]) {
      expect(eventSearchUnavailable(3, bodies, a, ephemeris, 'LT+S', lightTime)).toBeNull();
    }
  });

  it('settles a transmission target the same in either insertion order', () => {
    coverage.Target = [{ start: 0, end: 1_000 }];
    coverage.Observer = [{ start: 0, end: 950 }];
    try {
      const a = window(targetFirst, 'XLT');
      const b = window(observerFirst, 'XLT');
      expect(a).toEqual(b);
      expect(a.end).toBeCloseTo(1_000 - GF_BOUNDARY_MARGIN - 100 * (1 + LIGHT_TIME_PAD), 3);
      for (const bodies of [targetFirst, observerFirst]) {
        expect(eventSearchUnavailable(3, bodies, a, ephemeris, 'XLT', lightTime)).toBeNull();
      }
    } finally {
      coverage.Target = [{ start: 0, end: 1_000 }];
      coverage.Observer = [{ start: 50, end: 1_000 }];
    }
  });

  it('gives one window for every order of three roles', () => {
    coverage.Back = [{ start: 20, end: 980 }];
    ids.Back = 3;
    try {
      const roles = [['observer', 'Observer'], ['front', 'Target'], ['back', 'Back']] as const;
      const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
      for (const abcorr of ['NONE', 'LT+S', 'XCN']) {
        const windows = orders.map((order) =>
          coverageWindow(spice, Object.fromEntries(order.map((i) => roles[i])), SPAN, undefined, abcorr, lightTime));
        for (const w of windows) expect(w, abcorr).toEqual(windows[0]);
        const bodies = Object.fromEntries(roles);
        expect(eventSearchUnavailable(3, bodies, windows[0], ephemeris, abcorr, lightTime), abcorr).toBeNull();
      }
    } finally {
      delete coverage.Back;
      delete ids.Back;
    }
  });
});

describe('which demo catalogs cannot search at all', () => {
  // Catalogs whose whole `require` graph declares no SPICE kernels: the finder
  // refuses every search there. This is the catalog-level half of the policy
  // only — a catalog with kernels can still carry bodies no SPK describes (Io
  // in io-volcanos), and those are refused per body; see the real-kernel test
  // in closest-approach-altitude.integration.test.ts.
  const SPICE_FREE = [
    'atmosphere-earth-twilight.json',
    'atmosphere-earth.json',
    'atmosphere-mars.json',
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
