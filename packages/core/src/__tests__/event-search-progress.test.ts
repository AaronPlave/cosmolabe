import { describe, expect, it } from 'vitest';
import {
  EventKindRegistry, EventSearch, builtinEventKinds,
  type EventKind, type GeometryFinderProvider,
} from '../geometry/events/index.js';

const query = {
  id: 'progress', kind: 'occultation',
  bodies: { observer: 'EARTH', front: 'MOON', back: 'SUN' },
  window: { start: 0, end: 100 },
};

function reportingProvider(fractions = [0, 0.5, 1, 1]) {
  const calls: number[][] = [];
  const run = (...args: any[]) => {
    const seen: number[] = [];
    calls.push(seen);
    const report = args.at(-1);
    if (typeof report === 'function') {
      for (const fraction of fractions) {
        report(fraction);
        seen.push(fraction);
      }
    }
    return [];
  };
  const provider: GeometryFinderProvider = {
    gfdist: run, gfsep: run, gfoclt: run, gfposc: run,
  };
  return { provider, calls };
}

describe('whole-search progress', () => {
  it('maps all occultation states into thirds and completes once after run', async () => {
    const { provider, calls } = reportingProvider();
    const seen: number[] = [];
    const search = new EventSearch({ registry: builtinEventKinds(), provider,
      onProgress: (fraction) => {
        if (fraction === 1) expect(calls).toHaveLength(3);
        seen.push(fraction);
      },
    });
    expect((await search.run(query)).ok).toBe(true);
    expect(seen).toEqual([0, 1 / 6, 1 / 3, 1 / 3, 1 / 3, 0.5, 2 / 3, 2 / 3, 2 / 3, 5 / 6, 1]);
    expect(seen.filter((f) => f === 1)).toHaveLength(1);
  });

  it.each(['partial', 'full', 'annular'])('keeps %s a single 0–1 call', async (state) => {
    const { provider, calls } = reportingProvider();
    const seen: number[] = [];
    await new EventSearch({ registry: builtinEventKinds(), provider, onProgress: (f) => seen.push(f) })
      .run({ ...query, params: { state } });
    expect(calls).toHaveLength(1);
    expect(seen).toEqual([0, 0.5, 1]);
  });

  it('defaults an undeclared plan to one call, bounds fractions and suppresses diagnostics', async () => {
    const { provider, calls } = reportingProvider([-1, 0.5, 0.25, NaN, 2]);
    const seen: number[] = [];
    const kind: EventKind = {
      kind: 'custom', label: 'Custom', roles: [], defaultStep: 1,
      run: async (q, ctx) => {
        await ctx.provider.gfsep('a', 'POINT', '', 'b', 'POINT', '', 'NONE', 'o', '<', 0, 0, 1, [q.window]);
        expect(seen).not.toContain(1);
        // A refinement call of unknown cost must not restart progress.
        await ctx.provider.gfposc('a', 'J2000', 'NONE', 'o', 'RECTANGULAR', 'X', '<', 0, 0, 1, [q.window]);
        return [];
      },
      explainEmpty: async (q, ctx) => {
        expect(seen.at(-1)).toBe(1);
        await ctx.provider.gfdist('a', 'NONE', 'o', 'ABSMIN', 0, 0, 1, [q.window]);
        return 'Empty';
      },
    };
    const result = await new EventSearch({ registry: new EventKindRegistry().register(kind), provider,
      onProgress: (f) => seen.push(f),
    }).run({ ...query, kind: 'custom' });
    expect(result).toMatchObject({ ok: true, hint: 'Empty' });
    expect(calls).toHaveLength(3);
    expect(seen).toEqual([0, 0.5, 0.5, 1]);
  });

  it('does not invent progress for a provider without reporting', async () => {
    const { provider } = reportingProvider([]);
    const seen: number[] = [];
    await new EventSearch({ registry: builtinEventKinds(), provider, onProgress: (f) => seen.push(f) }).run(query);
    expect(seen).toEqual([]);
  });

  it('does not report completion when a geometry call fails', async () => {
    const { provider } = reportingProvider();
    provider.gfoclt = (...args) => {
      const report = args.at(-1) as ((fraction: number) => void) | undefined;
      report?.(0.5);
      throw new Error('failed');
    };
    const seen: number[] = [];
    const result = await new EventSearch({ registry: builtinEventKinds(), provider, onProgress: (f) => seen.push(f) }).run(query);
    expect(result.ok).toBe(false);
    expect(seen).toEqual([1 / 6]);
  });
});
