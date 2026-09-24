import { describe, expect, it } from 'vitest';
import {
  assessEventCoverage,
  builtinEventKinds,
  eventGeometry,
  windowOutsideCoverage,
  type CoverageSource,
  type EventGeometryDependencies,
  type SpkSegmentInfo,
} from '../index.js';

const IDS: Record<string, number> = {
  SSB: 0,
  'EARTH BARYCENTER': 3,
  'MARS BARYCENTER': 4,
  EARTH: 399,
  MOON: 301,
  MARS: 499,
  SC: -99,
};
const NAMES = Object.fromEntries(Object.entries(IDS).map(([n, i]) => [i, n]));

function seg(body: string, center: string, start: number, end: number, frame = 1): SpkSegmentInfo {
  return { body: IDS[body]!, center: IDS[center]!, frame, start, end };
}

function source(segments: SpkSegmentInfo[], extra: Partial<CoverageSource> = {}): CoverageSource {
  return {
    bodn2c: (name) => IDS[name.toUpperCase()] ?? null,
    bodc2n: (code) => NAMES[code] ?? null,
    spkSegments: () => segments,
    ...extra,
  };
}

const geometric = (target: string, observer: string): EventGeometryDependencies => ({
  vectors: [{ target, observer, abcorr: 'NONE' }],
});

describe('assessEventCoverage', () => {
  it('offers the shared window of two complete chains, inset at each edge', () => {
    const result = assessEventCoverage(geometric('MARS', 'EARTH'), source([
      seg('EARTH BARYCENTER', 'SSB', 0, 1000),
      seg('EARTH', 'EARTH BARYCENTER', 0, 1000),
      seg('MARS BARYCENTER', 'SSB', 0, 1000),
      seg('MARS', 'MARS BARYCENTER', 200, 800),
    ]));
    expect(result.status).toBe('available');
    expect(result.exact).toBe(false); // no probe: derived, not checked
    expect(result.windows).toEqual([{ start: 203, end: 797 }]);
  });

  it('reports a missing center-chain segment instead of offering the body span', () => {
    // The reported case: Mars is covered, relative to its barycenter, but no
    // loaded kernel carries the barycenter.
    const result = assessEventCoverage(geometric('MARS', 'EARTH'), source([
      seg('EARTH BARYCENTER', 'SSB', 0, 1000),
      seg('EARTH', 'EARTH BARYCENTER', 0, 1000),
      seg('MARS', 'MARS BARYCENTER', 0, 1000),
    ]));
    expect(result.status).toBe('none');
    expect(result.windows).toEqual([]);
    expect(result.problems.join('\n')).toMatch(/MARS \(499\) is given relative to MARS BARYCENTER \(4\).*no loaded SPK carries MARS BARYCENTER/);
  });

  it('keeps disjoint coverage as separate windows', () => {
    const result = assessEventCoverage(geometric('SC', 'EARTH'), source([
      seg('EARTH', 'SSB', 0, 10_000),
      seg('SC', 'EARTH', 100, 200),
      seg('SC', 'EARTH', 500, 900),
    ]));
    expect(result.windows).toEqual([
      { start: 103, end: 197 },
      { start: 503, end: 897 },
    ]);
  });

  it('joins abutting segments without an interior edge', () => {
    const result = assessEventCoverage(geometric('SC', 'EARTH'), source([
      seg('EARTH', 'SSB', 0, 10_000),
      seg('SC', 'EARTH', 100, 200),
      seg('SC', 'EARTH', 200, 300),
    ]));
    expect(result.windows).toEqual([{ start: 103, end: 297 }]);
  });

  it('follows the segment SPICE would select, not any covering one', () => {
    // A later-loaded SC segment relative to MARS overrides the EARTH-relative
    // one in [400, 600]; MARS has no chain, so that stretch is not usable.
    const result = assessEventCoverage(geometric('SC', 'EARTH'), source([
      seg('EARTH', 'SSB', 0, 10_000),
      seg('SC', 'EARTH', 0, 1000),
      seg('SC', 'MARS', 400, 600),
    ]));
    expect(result.windows).toEqual([
      { start: 3, end: 397 },
      { start: 603, end: 997 },
    ]);
  });

  it('accepts a common center without the barycenter for geometric states', () => {
    const result = assessEventCoverage(geometric('MOON', 'SC'), source([
      seg('MOON', 'EARTH', 0, 1000),
      seg('SC', 'EARTH', 0, 1000),
    ]));
    expect(result.windows).toEqual([{ start: 3, end: 997 }]);
  });

  it('requires both chains to reach the barycenter under light-time correction, with a margin', () => {
    const segments = [seg('MOON', 'EARTH', 0, 1000), seg('SC', 'EARTH', 0, 1000)];
    const corrected = { vectors: [{ target: 'MOON', observer: 'SC', abcorr: 'LT' }] };
    expect(assessEventCoverage(corrected, source(segments)).status).toBe('none');

    const withSsb = [...segments, seg('EARTH', 'SSB', 0, 1000)];
    const result = assessEventCoverage(corrected, source(withSsb, {
      correctedLightTime: (_v, et) => {
        if (et - 10 < 0) throw new Error('SPICE(SPKINSUFFDATA)');
        return 10;
      },
      observerEpochFor: (_v, tau) => tau + 10,
    }));
    // Reception: the target is read 10 s earlier, so the start moves by 10 s
    // (plus the edge margin); the end is not constrained by the target.
    expect(result.windows[0]!.start).toBeCloseTo(10 + 3, 6);
    expect(result.windows[0]!.end).toBe(997);
  });

  it('solves light-time edges exactly where sampling would underestimate them', () => {
    // Light time with a narrow bump near the target's coverage start: 64
    // samples across the window step clean over it, so a sampled margin comes
    // out short. |dL/dt| stays below 1, as it must physically.
    const L = (t: number) => 5 + 2 * Math.exp(-(((t - 40) / 3) ** 2));
    const segments = [seg('SC', 'SSB', 0, 1000), seg('MOON', 'SSB', 35, 1000)];
    const vector = { target: 'MOON', observer: 'SC', abcorr: 'LT' };
    const covered = (tau: number) => tau >= 35 && tau <= 1000;
    const result = assessEventCoverage({ vectors: [vector] }, source(segments, {
      lightTime: (_t, _o, et) => L(et),
      correctedLightTime: (_v, et) => {
        if (!covered(et - L(et))) throw new Error('SPICE(SPKINSUFFDATA)');
        return L(et);
      },
      // Fixed point of t = τ + L(t); a contraction since |L'| < 1.
      observerEpochFor: (_v, tau) => {
        let t = tau;
        for (let i = 0; i < 100; i++) t = tau + L(t);
        return t;
      },
      probe: () => undefined,
    }), { edgeMargin: 0 });

    expect(result.exact).toBe(true);
    const [w] = result.windows;
    // Every epoch in the offered window reads the target inside its coverage,
    // densely checked across the bump.
    for (let t = w!.start; t <= w!.start + 60; t += 0.01) expect(covered(t - L(t))).toBe(true);
    // And the edge is tight, not an over-wide pad.
    expect(covered(w!.start - 0.05 - L(w!.start - 0.05))).toBe(false);
  });

  it('marks light-time edges an estimate when they cannot be solved', () => {
    const segments = [seg('SC', 'SSB', 0, 1000), seg('MOON', 'SSB', 0, 1000)];
    const result = assessEventCoverage(
      { vectors: [{ target: 'MOON', observer: 'SC', abcorr: 'LT' }] },
      source(segments, { lightTime: () => 5, probe: () => undefined }),
    );
    expect(result.status).toBe('available');
    expect(result.exact).toBe(false);
    expect(result.caveats.join(' ')).toMatch(/sampled light time/);
  });

  it('drops a window the search calculation refuses, and says why', () => {
    const result = assessEventCoverage(geometric('SC', 'EARTH'), source(
      [seg('EARTH', 'SSB', 0, 10_000), seg('SC', 'EARTH', 100, 200), seg('SC', 'EARTH', 500, 900)],
      {
        probe: (_deps, et) => {
          if (et > 400) throw new Error('SPICE(SPKINSUFFDATA)');
        },
      },
    ));
    expect(result.windows).toEqual([{ start: 103, end: 197 }]);
    expect(result.exact).toBe(true);
    expect(result.problems.join('\n')).toMatch(/SPKINSUFFDATA/);
  });

  it('says when the coverage of the two bodies does not overlap', () => {
    const result = assessEventCoverage(geometric('SC', 'MOON'), source([
      seg('SC', 'SSB', 0, 100),
      seg('MOON', 'SSB', 200, 300),
    ]));
    expect(result.status).toBe('none');
    expect(result.problems[0]).toMatch(/does not overlap/);
  });

  it('flags non-inertial segment frames as an estimate', () => {
    const result = assessEventCoverage(geometric('SC', 'EARTH'), source(
      [seg('EARTH', 'SSB', 0, 1000), seg('SC', 'EARTH', 0, 1000, 13000)],
      { probe: () => undefined },
    ));
    expect(result.status).toBe('available');
    expect(result.exact).toBe(false);
  });

  it('reports a body SPICE cannot name', () => {
    const result = assessEventCoverage(geometric('PLUTO', 'EARTH'), source([seg('EARTH', 'SSB', 0, 1)]));
    expect(result.status).toBe('none');
    expect(result.problems[0]).toMatch(/PLUTO/);
  });
});

describe('windowOutsideCoverage', () => {
  const usable = [{ start: 0, end: 100 }, { start: 200, end: 300 }];

  it('is empty for a window inside one usable interval', () => {
    expect(windowOutsideCoverage({ start: 10, end: 90 }, usable)).toEqual([]);
  });

  it('names the gap a window spans, and any overhang', () => {
    expect(windowOutsideCoverage({ start: 50, end: 350 }, usable)).toEqual([
      { start: 100, end: 200 },
      { start: 300, end: 350 },
    ]);
  });
});

describe('eventGeometry', () => {
  const registry = builtinEventKinds();

  it('declares the occultation calculation, frames and radii included', () => {
    const geometry = eventGeometry(
      { id: 'q', kind: 'occultation', bodies: { observer: 'EARTH', front: 'MOON', back: 'SUN' }, window: { start: 0, end: 1 } },
      registry.get('occultation')!,
    );
    expect(geometry).toEqual({
      vectors: [
        { target: 'MOON', observer: 'EARTH', abcorr: 'LT' },
        { target: 'SUN', observer: 'EARTH', abcorr: 'LT' },
      ],
      frames: ['IAU_MOON', 'IAU_SUN'],
      radii: ['MOON', 'SUN'],
    });
  });

  it('is undefined until the required bodies are chosen', () => {
    expect(eventGeometry(
      { id: 'q', kind: 'closest-approach', bodies: { observer: 'EARTH' }, window: { start: 0, end: 1 } },
      registry.get('closest-approach')!,
    )).toBeUndefined();
  });
});
