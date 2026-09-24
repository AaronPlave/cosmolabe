import { describe, it, expect } from 'vitest';
import {
  EventKindRegistry,
  EventSearch,
  EventSearchProgress,
  builtinEventKinds,
  type EtInterval,
  type EventKind,
  type GeometryFinderProvider,
} from '../geometry/events/index.js';

const WINDOW: EtInterval = { start: 0, end: 86_400 };

/**
 * A provider whose every GF call reports 0, ½, 1 into `progress` — standing in
 * for the worker, which relays CSPICE's per-call reporter from outside the
 * search. `range` reports nothing, like the real position lookup.
 */
function reportingProvider(
  progress: EventSearchProgress,
  windows: (fn: string, relate: string) => EtInterval[] = () => [],
): GeometryFinderProvider & { calls: string[] } {
  const calls: string[] = [];
  const gf = (fn: string) => async (...args: unknown[]) => {
    calls.push(fn);
    for (const f of [0, 0.5, 1]) progress.report(f);
    return windows(fn, String(fn === 'gfoclt' ? args[0] : args[3]));
  };
  return {
    calls,
    gfdist: gf('gfdist'),
    gfsep: gf('gfsep'),
    gfoclt: gf('gfoclt'),
    gfposc: gf('gfposc'),
    range: async () => 1_000,
  } as unknown as GeometryFinderProvider & { calls: string[] };
}

function tracked() {
  const seen: number[] = [];
  const progress = new EventSearchProgress((f) => seen.push(f));
  return { seen, progress };
}

function expectMonotonic(seen: number[]) {
  for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  expect(Math.max(...seen)).toBeLessThanOrEqual(1);
  expect(seen.filter((f) => f === 1)).toHaveLength(1);
}

const occultation = {
  id: 'q',
  kind: 'occultation',
  bodies: { observer: 'CASSINI', front: 'SATURN', back: 'SUN' },
  window: WINDOW,
};

describe('whole-search progress', () => {
  it('gives each of an all-states occultation search its own third', async () => {
    const { seen, progress } = tracked();
    const p = reportingProvider(progress);
    const result = await new EventSearch({ registry: builtinEventKinds(), provider: p })
      .run({ ...occultation, params: { state: 'all' } }, { progress });

    expect(result.ok).toBe(true);
    expect(p.calls).toEqual(['gfoclt', 'gfoclt', 'gfoclt']);
    expect(seen).toEqual([0, 1 / 6, 1 / 3, 1 / 2, 2 / 3, 5 / 6, 1]);
    expectMonotonic(seen);
  });

  it('leaves a single-call search spanning the whole bar', async () => {
    const { seen, progress } = tracked();
    const p = reportingProvider(progress);
    await new EventSearch({ registry: builtinEventKinds(), provider: p })
      .run({ ...occultation, params: { state: 'full' } }, { progress });

    expect(seen).toEqual([0, 0.5, 1]);
  });

  it('treats a kind that declares no count as one call', async () => {
    const twice: EventKind = {
      kind: 'test:twice',
      label: 'Twice',
      roles: [],
      defaultStep: 60,
      run: async (query, ctx) => {
        await ctx.provider.gfposc('A', 'J2000', 'NONE', 'B', 'LATITUDINAL', 'LATITUDE', '>', 0, 0, query.step, [query.window]);
        await ctx.provider.gfposc('A', 'J2000', 'NONE', 'B', 'LATITUDINAL', 'LATITUDE', '<', 0, 0, query.step, [query.window]);
        return [];
      },
    };
    const { seen, progress } = tracked();
    const p = reportingProvider(progress);
    await new EventSearch({ registry: new EventKindRegistry().register(twice), provider: p })
      .run({ id: 'q', kind: 'test:twice', bodies: {}, window: WINDOW }, { progress });

    // The first call fills the bar as it does today; the second cannot restart it.
    expect(seen).toEqual([0, 0.5, 1]);
  });

  it('holds at full through refinement calls and the empty-result explanation', async () => {
    // A `<` window with an extremum refined inside it, then a second search
    // with nothing found — whose explanation is another gfdist.
    const found = tracked();
    const hit = reportingProvider(found.progress, (_fn, relate) =>
      relate === '<' ? [{ start: 100, end: 700 }] : [{ start: 400, end: 400 }]);
    await new EventSearch({ registry: builtinEventKinds(), provider: hit }).run({
      id: 'q', kind: 'distance-range', bodies: { observer: 'EARTH', target: 'MARS' },
      window: WINDOW, params: { relation: '<', distanceKm: 1e6 },
    }, { progress: found.progress });
    expect(hit.calls).toEqual(['gfdist', 'gfdist']);
    expect(found.seen).toEqual([0, 0.5, 1]);

    const empty = tracked();
    const miss = reportingProvider(empty.progress, (_fn, relate) =>
      relate === 'ABSMIN' ? [{ start: 400, end: 400 }] : []);
    const result = await new EventSearch({ registry: builtinEventKinds(), provider: miss }).run({
      id: 'q', kind: 'distance-range', bodies: { observer: 'EARTH', target: 'MARS' },
      window: WINDOW, params: { relation: '<', distanceKm: 1e6 },
    }, { progress: empty.progress });
    expect(result.ok && result.hint).toBeTruthy();
    expect(miss.calls).toEqual(['gfdist', 'gfdist']);
    expect(empty.seen).toEqual([0, 0.5, 1]);
  });

  it('reports 1 at the end of a search whose calls reported nothing', async () => {
    const { seen, progress } = tracked();
    const silent = reportingProvider(new EventSearchProgress(() => {}));
    await new EventSearch({ registry: builtinEventKinds(), provider: silent })
      .run({ ...occultation, params: { state: 'all' } }, { progress });

    expect(seen).toEqual([1]);
  });

  it('reports nothing further once a search has faulted', async () => {
    const { seen, progress } = tracked();
    const failing = {
      ...reportingProvider(progress),
      gfoclt: async () => {
        progress.report(0.4);
        throw new Error('insufficient ephemeris data');
      },
    };
    const result = await new EventSearch({ registry: builtinEventKinds(), provider: failing })
      .run({ ...occultation, params: { state: 'all' } }, { progress });

    expect(result.ok).toBe(false);
    progress.report(1);
    expect(seen).toEqual([0.4 / 3]);
  });

  it('runs unchanged without a progress sink', async () => {
    const p = reportingProvider(new EventSearchProgress(() => {}));
    const result = await new EventSearch({ registry: builtinEventKinds(), provider: p })
      .run({ ...occultation, params: { state: 'all' } });
    expect(result.ok).toBe(true);
    expect(p.calls).toHaveLength(3);
  });
});

describe('EventSearchProgress', () => {
  it('clamps, ignores non-finite input, and never goes backwards', () => {
    const { seen, progress } = tracked();
    progress.plan(2);
    progress.beginCall();
    progress.report(-1);
    progress.report(Number.NaN);
    progress.report(0.8);
    progress.report(0.2);
    progress.beginCall();
    progress.report(2);
    progress.complete();
    expect(seen).toEqual([0, 0.4, 1]);
    expect(progress.fraction).toBe(1);
  });

  it('treats a nonsensical plan as one call', () => {
    for (const planned of [0, -3, Number.NaN, Infinity]) {
      const { seen, progress } = tracked();
      progress.plan(planned);
      progress.beginCall();
      progress.report(0.5);
      expect(seen).toEqual([0.5]);
    }
  });
});
