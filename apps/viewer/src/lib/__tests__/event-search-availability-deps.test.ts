/**
 * The availability check's reactive inputs.
 *
 * The Event Finder derives `currentSearchUnavailable()`, and that check makes
 * synchronous SPICE calls (coverage, and light time at the window edges). A
 * Svelte derivation depends on whatever state it reads, so the check must never
 * read the live playhead: if it did, playback would re-run SPICE on the main
 * thread every tick. Reads are counted directly, which is the dependency a
 * derivation would record.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { analysisContext } from '../analysis.svelte';
import { currentSearchUnavailable, resetForScene, setKind } from '../event-finder.svelte';
import { vs } from '../viewer-state.svelte';

/** Counts reads of `vs.et` while `run` executes, leaving the value alone. */
function playheadReads(run: () => void): number {
  const own = Object.getOwnPropertyDescriptor(vs, 'et');
  let value = vs.et;
  let reads = 0;
  Object.defineProperty(vs, 'et', {
    configurable: true,
    enumerable: true,
    get: () => { reads++; return value; },
    set: (v: number) => { value = v; },
  });
  try {
    run();
  } finally {
    if (own) Object.defineProperty(vs, 'et', own);
    vs.et = value;
  }
  return reads;
}

afterEach(() => resetForScene());

describe('event search availability inputs', () => {
  it('can observe a playhead read, so a zero below means something', () => {
    // analysisContext() carries the current time: exactly what the check
    // must not go through.
    expect(playheadReads(() => analysisContext())).toBeGreaterThan(0);
  });

  it('never reads the playhead, for any kind', () => {
    for (const kind of ['closest-approach', 'distance-range', 'occultation']) {
      setKind(kind);
      expect(playheadReads(() => currentSearchUnavailable()), kind).toBe(0);
    }
  });
});
