/**
 * Catalog epochs reach the time authority verbatim.
 *
 * `CatalogLoader.parseEpoch` used to strip a trailing `Z` before calling the
 * injected `str2et`, mirroring a hack the frames tier has since retired in
 * favour of real ISO-8601 → SPICE normalisation (issue #8). Core is the wrong
 * layer for that translation: it swallowed the designator on the way past, and
 * it only ever handled the one form its author happened to hit — an offset
 * epoch still fell out of the SPICE path entirely.
 *
 * Two things pinned here: the string the loader hands the engine (verbatim),
 * and the epoch that comes back (independently stated, via `Date.UTC` through
 * `etFromCalendarString`, so a wrong parse cannot agree with a wrong
 * expectation).
 *
 * A Viewpoint's `time` is the observable: `parseViewpoint` runs it through the
 * same `parseEpoch` every catalog `startTime`, `endTime` and `epoch` uses, and
 * publishes the result as `vp.epoch`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SpiceInstance } from '../spice-injection.js';
import { createHeritageSpice } from '@cosmolabe/frames';
import { CatalogLoader, type CatalogJson } from '../catalog/CatalogLoader.js';
import { etFromCalendarString } from '../time.js';
import { furnishKernels, SPICE_TEST_KERNELS } from './_harness/kernels.js';

const haveLsk = existsSync(join(SPICE_TEST_KERNELS, 'naif0012.tls'));

/** A catalog whose only content is a viewpoint pinned to `time`. */
function viewpointCatalog(time: string): CatalogJson {
  return {
    name: 'epoch-designator',
    items: [{ name: 'vp', type: 'Viewpoint', center: 'Earth', time } as never],
  } as CatalogJson;
}

function viewpointEpoch(spice: SpiceInstance | undefined, time: string): number | undefined {
  const loaded = new CatalogLoader(spice ? { spice } : {}).load(viewpointCatalog(time));
  return loaded.viewpoints[0]?.epoch;
}

describe('catalog epochs reach str2et verbatim', () => {
  it('passes the designator through instead of stripping it', () => {
    const seen: string[] = [];
    const recorder = {
      furnish: () => Promise.resolve(),
      str2et: (s: string) => {
        seen.push(s);
        return 42;
      },
    } as unknown as SpiceInstance;

    expect(viewpointEpoch(recorder, '2004-07-01T02:48:00Z')).toBe(42);
    expect(seen).toEqual(['2004-07-01T02:48:00Z']);
  });

  it('still falls back to the SPICE-free path when the engine rejects a string', () => {
    const thrower = {
      furnish: () => Promise.resolve(),
      str2et: () => {
        throw new Error('nope');
      },
    } as unknown as SpiceInstance;

    expect(viewpointEpoch(thrower, '2004-07-01T02:48:00Z')).toBeCloseTo(
      etFromCalendarString('2004-07-01T02:48:00Z'),
      9,
    );
    expect(viewpointEpoch(thrower, 'not a time')).toBeUndefined();
  });
});

describe.skipIf(!haveLsk)('catalog epochs through the real engine', () => {
  let spice: SpiceInstance;

  beforeAll(async () => {
    spice = await createHeritageSpice();
    await furnishKernels(spice, ['naif0012.tls']);
  });

  it('reads a Z-suffixed catalog epoch as the UTC instant it names', () => {
    // Independent expectation: leap-second exact, derived from Date.UTC rather
    // than from the value under test. The 2 ms tolerance is the one thing
    // etFromCalendarString deliberately does not model, the TDB-TT periodic
    // term, which peaks near 1.7 ms — the same bound leap-seconds.test.ts
    // holds these two to across the whole ΔAT table. Nothing about a
    // designator could hide inside it: getting that wrong moves the epoch by
    // hours.
    for (const epoch of ['2004-07-01T02:48:00Z', '1977-09-05T12:56:00Z', '2031-03-06T00:00:00Z']) {
      expect(viewpointEpoch(spice, epoch)!, epoch).toBeCloseTo(etFromCalendarString(epoch), 2);
    }
  });

  it('reads the designator-free form identically', () => {
    expect(viewpointEpoch(spice, '2004-07-01T02:48:00')).toBe(
      viewpointEpoch(spice, '2004-07-01T02:48:00Z'),
    );
  });

  it('now resolves an offset epoch through SPICE rather than falling back', () => {
    expect(viewpointEpoch(spice, '2004-07-01T04:48:00+02:00')).toBe(
      viewpointEpoch(spice, '2004-07-01T02:48:00Z'),
    );
  });
});
