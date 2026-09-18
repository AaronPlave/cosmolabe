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
      await spice.furnish({ type: 'buffer', data: fixture(from), filename: kernelName(source) });
      registry.register(source, owner);
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
 * Two kernels furnished under one name.
 *
 * CSPICE counts furnishes: `unload_c` undoes the most recent load of a file and
 * leaves any earlier one in place. Beneath that, the wasm build stages every
 * kernel at `/kernels/<name>`, so two different byte streams sharing a basename
 * were only ever one path -- the second furnish overwrote the first's bytes.
 * Either way a name is not an identity, and a release that unloads once and
 * forgets twice leaves SPICE holding a kernel the registry has stopped
 * accounting for. The rebuild is what avoids having to reason about it.
 *
 * `de440s-inner-cassini.bsp` and `cassini-soi.bsp` are what make it observable:
 * the planetary file answers the Moon, the Cassini file answers the spacecraft,
 * and here one of them is furnished under the other's name.
 */
describe('when a catalog furnishes a name something else already holds', () => {
  it('leaves nothing of the catalog behind, user first', async () => {
    // The case the PR's own policy creates: the user dropped a kernel, and a
    // catalog later furnished its own under the same name.
    await furnish(['planets.bsp=de440s-inner-cassini.bsp', 'naif0012.tls'], 'user');
    await loadScene(['planets.bsp=cassini-soi.bsp', 'pck00011.tpc']);
    expect(() => cassiniQuery()).not.toThrow();

    await loadScene(SCENE_B);

    // The catalog's kernel is gone, even though its name is one the user's
    // kernel also holds and no unload of that name could have been trusted.
    expect(() => cassiniQuery()).toThrow();
    // And the user's own kernel is back, with its own bytes -- the rebuild
    // re-furnished what the entry was furnished from.
    expect(registry.entries.map((e) => e.name)).toEqual(['planets.bsp', 'naif0012.tls', ...SCENE_B]);
    expect(spice.totalLoaded()).toBe(2 + SCENE_B.length);
    expect(() => moonQuery()).not.toThrow();
  }, 180_000);

  it('leaves nothing of the catalog behind, catalog first', async () => {
    await loadScene(['naif0012.tls', 'pck00011.tpc', 'planets.bsp=cassini-soi.bsp']);
    await furnish(['planets.bsp=de440s-inner-cassini.bsp'], 'user');

    await loadScene(SCENE_B);

    // The overwrite hides the stale bytes here -- the user's furnish wrote the
    // same staged path -- so the count is what shows the load itself is gone,
    // rather than still sitting under the registry's one entry for that name.
    expect(() => cassiniQuery()).toThrow();
    expect(registry.entries.map((e) => e.name)).toEqual(['planets.bsp', ...SCENE_B]);
    expect(spice.totalLoaded()).toBe(1 + SCENE_B.length);
    expect(() => moonQuery()).not.toThrow();
  }, 180_000);

  it('leaves nothing behind when two of one catalog’s URLs share a basename', async () => {
    // Two different URLs, same basename: the furnish path deduplicates by URL,
    // so both were fetched and both were furnished.
    await furnish(['cas_iss_v10.ti'], 'user');
    await loadScene(['naif0012.tls', 'pck00011.tpc', 'shared.bsp=de440s-inner-cassini.bsp', 'shared.bsp=cassini-soi.bsp']);
    expect(() => cassiniQuery()).not.toThrow();

    await loadScene(SCENE_B);

    expect(() => cassiniQuery()).toThrow();
    expect(registry.entries.map((e) => e.name)).toEqual(['cas_iss_v10.ti', ...SCENE_B]);
    expect(spice.totalLoaded()).toBe(1 + SCENE_B.length);
  }, 180_000);
});
});
