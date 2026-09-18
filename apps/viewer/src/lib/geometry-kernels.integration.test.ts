/**
 * Narrowing against real kernels, and the claim that makes it safe.
 *
 * `geometry-kernels.test.ts` pins the filter's logic over synthetic coverage.
 * What that cannot show is the thing the whole change rests on: that a search
 * run against the narrowed set returns *the same answer* as one run against the
 * catalog's whole set. If that is ever false, the viewer silently answers
 * geometry questions differently depending on how much memory it felt like
 * using, which is worse than the 300 MB the narrowing saves.
 *
 * So this furnishes two real SPICE instances -- one with everything, one with
 * only what the filter kept -- and holds their answers against each other
 * interval for interval.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { createHeritageSpice, type HeritageSpice } from '@cosmolabe/frames';
import { kernelsForWindow, type KernelWindow } from './geometry-kernels';

const fixture = (name: string): ArrayBuffer => {
  const buf = readFileSync(fileURLToPath(new URL(`../../../../kernels/fixtures/${name}`, import.meta.url)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

/**
 * The fixture set, in furnish order.
 *
 * Two SPKs with deliberately different spans, which is what makes narrowing
 * observable: de440s-inner-cassini covers all of 2004, while cassini-soi covers
 * only 2004-06-21 to 2004-08-23.
 */
const KERNELS = ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp', 'cassini-soi.bsp'];

const furnish = async (names: string[]): Promise<HeritageSpice> => {
  const spice = await createHeritageSpice();
  for (const name of names) {
    await spice.furnish({ type: 'buffer', data: fixture(name), filename: name });
  }
  return spice;
};

describe('narrowing the kernel set against real kernels', () => {
  let full: HeritageSpice;
  let coverage: (name: string) => KernelWindow[] | null;

  beforeAll(async () => {
    full = await furnish(KERNELS);
    // As the viewer does it: the main thread has everything furnished, so it is
    // the one that can say what each file covers.
    const cache = new Map<string, KernelWindow[] | null>();
    coverage = (name) => {
      if (!cache.has(name)) {
        cache.set(name, /\.bsp$/i.test(name) ? full.spkFileCoverage(name) : null);
      }
      return cache.get(name)!;
    };
  }, 120_000);

  const narrow = (window: KernelWindow): string[] =>
    kernelsForWindow(KERNELS, (n) => n, coverage, window);

  it('reads each file\'s real coverage', () => {
    // Establishes that spkFileCoverage answers at all, and that the two SPKs
    // genuinely differ -- without which every narrowing test below would pass
    // vacuously.
    const planets = full.spkFileCoverage('de440s-inner-cassini.bsp');
    const cassini = full.spkFileCoverage('cassini-soi.bsp');
    expect(planets).toHaveLength(1);
    expect(cassini).toHaveLength(1);
    expect(cassini[0]!.start).toBeGreaterThan(planets[0]!.start);
    expect(cassini[0]!.end).toBeLessThan(planets[0]!.end);
    // Text kernels have no coverage to report and are never dropped on it.
    expect(coverage('naif0012.tls')).toBeNull();
  });

  it('keeps both SPKs for a window they both cover', () => {
    const soi = { start: full.str2et('2004-07-01T00:00:00'), end: full.str2et('2004-07-08T00:00:00') };
    expect(narrow(soi)).toEqual(KERNELS);
  });

  it('drops the spacecraft SPK for a window outside its coverage', () => {
    const february = { start: full.str2et('2004-02-01T00:00:00'), end: full.str2et('2004-02-08T00:00:00') };
    expect(narrow(february)).toEqual(['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp']);
  });

  it('answers a search identically from the narrowed set', async () => {
    // The claim the change rests on. A Moon-Earth distance search in February
    // cannot touch cassini-soi.bsp, the filter drops it, and the answer must be
    // the same doubles -- not merely close. Anything less and the viewer's
    // answers would depend on its memory budget.
    const window = { start: full.str2et('2004-02-01T00:00:00'), end: full.str2et('2004-02-28T00:00:00') };
    const kept = narrow(window);
    // Guards the comparison: if nothing were dropped this would prove nothing.
    expect(kept).not.toContain('cassini-soi.bsp');

    const narrowed = await furnish(kept);
    const search = (spice: HeritageSpice) =>
      spice.gfdist('MOON', 'NONE', 'EARTH', '<', 4e5, 0, 3600, [window]);

    const fromFull = search(full);
    const fromNarrowed = search(narrowed);
    expect(fromNarrowed).toEqual(fromFull);
    // And that the search found something, so two empty answers cannot agree
    // trivially.
    expect(fromFull.length).toBeGreaterThan(0);
  }, 120_000);

  it('still fails where the data genuinely is absent', async () => {
    // The other side of the guarantee. Narrowing must not be what makes a
    // search fail -- so a Cassini search in February must fail the same way on
    // both sets, because the data is missing from the catalog, not from the
    // filter's choice.
    const february = { start: full.str2et('2004-02-01T00:00:00'), end: full.str2et('2004-02-08T00:00:00') };
    const narrowed = await furnish(narrow(february));
    const search = (spice: HeritageSpice) =>
      spice.gfdist('-82', 'NONE', 'SATURN', '<', 1.5e6, 0, 3600, [february]);

    expect(() => search(full)).toThrow();
    expect(() => search(narrowed)).toThrow();
  }, 120_000);
});
