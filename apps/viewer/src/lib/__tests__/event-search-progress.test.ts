import { describe, expect, it } from 'vitest';
import { EventSearch, builtinEventKinds, type GeometryFinderProvider } from '@cosmolabe/core';
import { withCallProgress } from '../event-search-progress';

describe('worker progress bridge', () => {
  it('routes per-call progress through whole-search slicing and preserves GF arguments', async () => {
    let report: ((fraction: number) => void) | undefined;
    const calls: unknown[][] = [];
    const call = (...args: unknown[]) => {
      calls.push(args);
      report?.(0);
      report?.(0.5);
      report?.(1);
      return [];
    };
    const base: GeometryFinderProvider = { gfdist: call, gfsep: call, gfoclt: call, gfposc: call };
    const provider = withCallProgress(base, (callback) => { report = callback; });
    const seen: number[] = [];
    const window = { start: 0, end: 100 };
    const result = await new EventSearch({ registry: builtinEventKinds(), provider, onProgress: (f) => seen.push(f) })
      .run({ id: 'q', kind: 'occultation', bodies: { observer: 'EARTH', front: 'MOON', back: 'SUN' }, window });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([0, 1 / 6, 1 / 3, 1 / 3, 0.5, 2 / 3, 2 / 3, 5 / 6, 1]);
    expect(calls.map((args) => args[0])).toEqual(['PARTIAL', 'FULL', 'ANNULAR']);
    for (const args of calls) {
      expect(args).toHaveLength(11);
      expect(args.at(-1)).toEqual([window]);
    }

    // An empty-result diagnostic must neither replay the last call's callback
    // nor lose its confinement window when it carries no progress callback.
    await provider.gfdist('MOON', 'NONE', 'EARTH', 'ABSMIN', 0, 0, 10, [window]);
    expect(report).toBeUndefined();
    expect(calls.at(-1)).toEqual(['MOON', 'NONE', 'EARTH', 'ABSMIN', 0, 0, 10, [window]]);
    expect(seen.filter((f) => f === 1)).toHaveLength(1);
  });
});
