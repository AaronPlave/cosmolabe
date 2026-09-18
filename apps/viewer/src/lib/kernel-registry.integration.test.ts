/**
 * Scene replacement against real SPICE.
 *
 * `kernel-registry.test.ts` pins the bookkeeping: which entries survive a scene
 * load and in what order. What it cannot show is the thing the bookkeeping is
 * for -- that the kernels really do leave the SPICE instance, so a scene's
 * geometry is answered by that scene's kernels and by nothing a previous scene
 * happened to furnish.
 *
 * That was the #70 bug and it was silent: load Cassini, load a catalog that
 * knows nothing about Cassini, and a Cassini query kept answering. The check
 * below is the one that would have caught it -- a query Scene A can serve and
 * Scene B cannot must *fail* once B is loaded.
 *
 * Driven through the same two steps the loader takes, in the same order:
 * release what the last catalog furnished, then furnish this one's.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { createHeritageSpice, type HeritageSpice } from '@cosmolabe/frames';
import { kernelsForWindow, type KernelWindow } from './geometry-kernels';
import {
  KernelRegistry,
  kernelName,
  releaseCatalogKernels,
  type FurnishedKernel,
  type KernelOwner,
} from './kernel-registry';

const fixture = (name: string): ArrayBuffer => {
  const buf = readFileSync(fileURLToPath(new URL(`../../../../kernels/fixtures/${name}`, import.meta.url)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

/** Everything a Cassini-at-SOI scene needs. */
const SCENE_A = ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp', 'cassini-soi.bsp'];
/** A scene with the planets but no spacecraft — what replaces it. */
const SCENE_B = ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp'];

describe('replacing a scene releases its kernels', () => {
  let spice: HeritageSpice;
  let registry: KernelRegistry;

  /**
   * Which fixture's bytes each registered source stands for.
   *
   * The loader's kernels carry their bytes in their source -- a URL to fetch or
   * a File to read. Here the source is a stand-in, so the rebuild needs this to
   * play the same part: re-furnish what the entry was furnished from, not
   * whatever fixture happens to share its name. Which is the whole point of the
   * same-basename cases below, where the two differ.
   */
  let bytesFor: WeakMap<object, string>;

  /**
   * `furnishKernelUrl`: furnish, then register under the name SPICE knows.
   *
   * A spec of `'<name>'` furnishes the fixture of that name. `'<name>=<fixture>'`
   * furnishes that fixture's bytes under a different name -- what a catalog
   * whose kernel happens to share a basename with another one is, from SPICE's
   * side.
   */
  const furnish = async (specs: string[], owner: KernelOwner = 'catalog') => {
    for (const spec of specs) {
      const [name, from = name] = spec.split('=');
      const source = { url: `https://example.test/kernels/${owner}/${name}` };
      bytesFor.set(source, from);
      const furnishedAs = kernelName(source);
      // `displaceKernelNamed`: a name is a slot, and the occupant comes out
      // before anything else goes in. Furnishing over it corrupts both.
      const held = registry.findByName(furnishedAs);
      if (held) {
        spice.unload(held.name);
        registry.forget(held);
      }
      await spice.furnish({ type: 'buffer', data: fixture(from), filename: furnishedAs });
      // As `measureCoverage` in the loader does it: while this kernel is the one
      // its name refers to, which for a shared basename is only now.
      registry.register(
        source,
        owner,
        /\.bsp$/i.test(furnishedAs) ? spice.spkFileCoverage(furnishedAs) : null,
      );
    }
  };

  /**
   * The loader's release, minus the progress reporting: unload what the last
   * catalog furnished, and if an unload refuses, start the instance over from
   * the entries that survive (`refurnishOnFreshSpice`).
   *
   * `refuse` forces that second path. CSPICE will not fail an unload on demand,
   * and the path it guards -- registry and instance disagreeing about what is
   * furnished -- is precisely the one that is invisible when it goes wrong.
   */
  const release = (refuse: string[] = []) =>
    releaseCatalogKernels(registry, {
      unload: (name) => {
        if (refuse.includes(name)) throw new Error(`unload_c refused ${name}`);
        spice.unload(name);
      },
      rebuild: async (keep) => {
        spice = await createHeritageSpice();
        const refurnished: FurnishedKernel[] = [];
        for (const entry of keep) {
          const from = bytesFor.get(entry.source as object) ?? entry.name;
          await spice.furnish({ type: 'buffer', data: fixture(from), filename: entry.name });
          // The entry keeps its measured coverage: same bytes, same coverage.
          refurnished.push(entry);
        }
        return refurnished;
      },
    });

  /** A scene load: out with the last catalog's, in with this one's. */
  const loadScene = async (names: string[], refuse: string[] = []) => {
    await release(refuse);
    await furnish(names);
  };

  /** Cassini relative to Saturn during SOI — answerable only from cassini-soi.bsp. */
  const cassiniQuery = () => spice.spkpos('-82', spice.str2et('2004-07-01T12:00:00'), 'J2000', 'NONE', 'SATURN');
  /** The Moon relative to Earth, which either scene's planetary SPK can serve. */
  const moonQuery = () => spice.spkpos('MOON', spice.str2et('2004-07-01T12:00:00'), 'J2000', 'NONE', 'EARTH');

  beforeEach(async () => {
    spice = await createHeritageSpice();
    registry = new KernelRegistry();
    bytesFor = new WeakMap();
  }, 120_000);

  it('stops answering what only the replaced scene could answer', async () => {
    await loadScene(SCENE_A);
    // Guards the assertion below: a query that never worked would "fail" for
    // the wrong reason.
    expect(() => cassiniQuery()).not.toThrow();

    await loadScene(SCENE_B);
    expect(() => cassiniQuery()).toThrow();
  }, 180_000);

  it('still answers what the new scene carries', async () => {
    // The release must take the previous scene's kernels and nothing else --
    // including the leapseconds and planetary kernels both scenes name, which
    // Scene B re-furnishes for itself.
    await loadScene(SCENE_A);
    await loadScene(SCENE_B);

    expect(() => moonQuery()).not.toThrow();
    expect(spice.totalLoaded()).toBe(SCENE_B.length);
  }, 180_000);

  it('reclaims the released kernels from the SPICE instance', async () => {
    await loadScene(SCENE_A);
    expect(spice.totalLoaded()).toBe(SCENE_A.length);

    await release();
    // Nothing of the scene is left loaded -- which is the memory claim, since
    // CSPICE holds a kernel's bytes for exactly as long as it is furnished.
    expect(spice.totalLoaded()).toBe(0);
  }, 180_000);

  it('keeps a kernel the user dropped in across the scene load', async () => {
    // The documented policy (see `handleFileList`): a kernel dropped with no
    // catalog is the user's, and a catalog switch they made for other reasons
    // does not take it away.
    await furnish(['naif0012.tls', 'cassini-soi.bsp'], 'user');
    await loadScene(SCENE_B);

    expect(() => cassiniQuery()).not.toThrow();
    expect(() => moonQuery()).not.toThrow();
  }, 180_000);

  it('starts the instance over when an unload refuses', async () => {
    // The failure the review of #70 caught: unload fails, the entry is already
    // gone from the registry, and the kernel stays furnished -- so the scene's
    // workers are built from a list the main thread no longer matches, and a
    // kernel belonging to no scene goes on answering main-thread geometry.
    await furnish(['cas_iss_v10.ti'], 'user');
    await loadScene(SCENE_A);
    expect(() => cassiniQuery()).not.toThrow();

    await loadScene(SCENE_B, ['cassini-soi.bsp']);

    // The kernel that refused to unload is gone with the instance that would
    // not let go of it, rather than left answering for a scene that is over.
    expect(() => cassiniQuery()).toThrow();
    // And the instance holds exactly what the registry still claims: the user's
    // drop, which the rebuild restored, then Scene B's own.
    expect(registry.entries.map((e) => e.name)).toEqual(['cas_iss_v10.ti', ...SCENE_B]);
    expect(spice.totalLoaded()).toBe(1 + SCENE_B.length);
    expect(() => moonQuery()).not.toThrow();
  }, 180_000);

/**
 * A name is a slot, and what happens if you treat it as anything else.
 *
 * The wasm build stages every kernel at `/kernels/<name>`, so two kernels
 * sharing a basename are one path. The loader keeps one furnished kernel per
 * name by unloading the occupant first (`displaceKernelNamed`); these pin both
 * halves of why -- what that costs, and what skipping it costs.
 */
describe('a kernel furnished under a name another one holds', () => {
  it('is a second load of one path, which one unload does not undo', async () => {
    // Not a policy, an observation, and the reason the loader displaces at
    // furnish time rather than coping at release time. Driven straight against
    // SPICE, because the registry is what stops the app reaching this state.
    const raw = await createHeritageSpice();
    await raw.furnish({ type: 'buffer', data: fixture('naif0012.tls'), filename: 'naif0012.tls' });
    await raw.furnish({ type: 'buffer', data: fixture('de440s-inner-cassini.bsp'), filename: 'shared.bsp' });
    await raw.furnish({ type: 'buffer', data: fixture('cassini-soi.bsp'), filename: 'shared.bsp' });

    // Two loads of one staged path. Which kernel answers from here is not
    // stable -- it depends on what SPICE has buffered, since the second furnish
    // overwrote the bytes of a file it already had open -- and that is the
    // point: past this furnish the instance is not describable. What is stable
    // is the count, and what it costs.
    expect(raw.totalLoaded()).toBe(3);

    raw.unload('shared.bsp');

    // One load remains, for a file that is no longer even on the staging path,
    // and it still answers. A release that unloaded this name once and forgot
    // both entries would leave exactly this: a kernel belonging to no scene,
    // serving geometry, that nothing can name to get rid of.
    expect(raw.totalLoaded()).toBe(2);
    expect(() => raw.spkpos('-82', raw.str2et('2004-07-01T12:00:00'), 'J2000', 'NONE', 'SATURN')).not.toThrow();
  }, 180_000);

  it('replaces it cleanly when the occupant is unloaded first', async () => {
    await furnish(['naif0012.tls', 'shared.bsp=de440s-inner-cassini.bsp']);
    expect(() => moonQuery()).not.toThrow();

    await furnish(['shared.bsp=cassini-soi.bsp']);

    // The slot holds exactly the newcomer: its data is reachable, and what it
    // displaced is gone honestly rather than half-readable.
    expect(() => cassiniQuery()).not.toThrow();
    expect(() => moonQuery()).toThrow(/insufficient/i);
    expect(spice.totalLoaded()).toBe(2);
    expect(registry.entries.map((e) => e.name)).toEqual(['naif0012.tls', 'shared.bsp']);
  }, 180_000);

  it('leaves one entry per name, whoever furnished first', async () => {
    // The three orderings the review asked about, now all one shape: the
    // registry never holds two entries for a name, so a release never has two
    // furnishes to undo with one unload.
    await furnish(['planets.bsp=de440s-inner-cassini.bsp'], 'user');
    await furnish(['naif0012.tls', 'planets.bsp=cassini-soi.bsp'], 'catalog');
    await furnish(['planets.bsp=de440s-inner-cassini.bsp'], 'user');

    expect(registry.entries.map((e) => e.name)).toEqual(['naif0012.tls', 'planets.bsp']);
    expect(registry.entries.map((e) => e.owner)).toEqual(['catalog', 'user']);
    expect(() => moonQuery()).not.toThrow();
  }, 180_000);

  it('releases a scene whose kernel displaced the user’s', async () => {
    // And the release is then an ordinary one: one furnish, one unload, no
    // rebuild -- the collision backstop in `releaseCatalog` never fires.
    await furnish(['planets.bsp=de440s-inner-cassini.bsp'], 'user');
    await furnish(['naif0012.tls', 'planets.bsp=cassini-soi.bsp'], 'catalog');

    const result = await release();

    expect(result.rebuilt).toBe(false);
    expect(result.collided).toEqual([]);
    expect(registry.entries).toEqual([]);
    expect(spice.totalLoaded()).toBe(0);
  }, 180_000);
});

/**
 * Narrowing when a name has been reused.
 *
 * The geometry worker is given only the kernels a search's window could reach,
 * decided by each file's coverage. Asking SPICE for that coverage at search
 * time asks about whatever is staged at `/kernels/<name>` now -- which, once a
 * name can be reused, is not necessarily the kernel whose entry is being
 * narrowed. So coverage is measured when the kernel is furnished, while its
 * name unambiguously means it, and carried on the entry.
 *
 * The fixtures differ in exactly the way that makes it observable:
 * `de440s-inner-cassini.bsp` covers all of 2004, `cassini-soi.bsp` only
 * 2004-06-21 to 2004-08-23.
 */
describe('narrowing after a name has been reused', () => {
  const window = (from: string, to: string): KernelWindow => ({
    start: spice.str2et(from),
    end: spice.str2et(to),
  });

  /** As the loader narrows: by each entry's own coverage, never by its name. */
  const narrowed = (w: KernelWindow) =>
    kernelsForWindow(registry.workerEntries(), (e) => e.coverage, w)
      .map((e) => bytesFor.get(e.source as object));

  it('narrows the surviving kernel by its own coverage, not the displaced one’s', async () => {
    // `shared.bsp` was the planetary kernel and is now the Cassini one. A
    // February search must drop it -- the name's old meaning covered February,
    // the kernel actually furnished under it does not.
    await furnish(['naif0012.tls', 'shared.bsp=de440s-inner-cassini.bsp']);
    await furnish(['shared.bsp=cassini-soi.bsp']);

    expect(narrowed(window('2004-02-01T00:00:00', '2004-02-08T00:00:00'))).toEqual(['naif0012.tls']);
    expect(narrowed(window('2004-07-01T00:00:00', '2004-07-08T00:00:00'))).toEqual([
      'naif0012.tls', 'cassini-soi.bsp',
    ]);
  }, 180_000);

  it('narrows by the kernel each entry stands for when two names swap contents', async () => {
    // Both names are reused, crosswise, so a by-name lookup at search time
    // would hand each entry the other's coverage.
    await furnish(['naif0012.tls', 'a.bsp=de440s-inner-cassini.bsp', 'b.bsp=cassini-soi.bsp']);
    await furnish(['a.bsp=cassini-soi.bsp', 'b.bsp=de440s-inner-cassini.bsp']);

    expect(narrowed(window('2004-02-01T00:00:00', '2004-02-08T00:00:00'))).toEqual([
      'naif0012.tls', 'de440s-inner-cassini.bsp',
    ]);
  }, 180_000);
});
});
