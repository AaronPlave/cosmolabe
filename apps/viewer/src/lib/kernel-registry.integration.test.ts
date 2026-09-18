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

  /** `furnishKernelUrl`: furnish, then register under the name SPICE knows. */
  const furnish = async (names: string[], owner: KernelOwner = 'catalog') => {
    for (const name of names) {
      const source = { url: `https://example.test/kernels/${name}` };
      await spice.furnish({ type: 'buffer', data: fixture(name), filename: kernelName(source) });
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
          await spice.furnish({ type: 'buffer', data: fixture(entry.name), filename: entry.name });
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
});
