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
import { KernelRegistry, kernelName, type KernelOwner } from './kernel-registry';

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

  /** `releaseCatalogKernels`, minus the progress reporting. */
  const release = () => {
    for (const name of registry.releaseCatalogKernels()) spice.unload(name);
  };

  /** A scene load: out with the last catalog's, in with this one's. */
  const loadScene = async (names: string[]) => {
    release();
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

    release();
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
});
