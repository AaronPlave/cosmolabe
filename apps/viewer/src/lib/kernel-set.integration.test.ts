/**
 * Scene replacement against real SPICE.
 *
 * `kernel-set.test.ts` pins the list arithmetic. What it cannot show is the
 * thing the arithmetic is for: that a scene's geometry is answered by that
 * scene's kernels and by nothing a previous scene happened to load.
 *
 * That was #70, and it was silent -- load Cassini, load a catalog that knows
 * nothing about Cassini, and a Cassini query kept answering, because the
 * kernels were never released. The answer here is not to release them: the
 * scene gets a new SPICE instance, furnished with exactly its own kernels. So
 * the tests are about what the instance can answer, not about unloading.
 *
 * `buildSceneSpice` below mirrors the loader's function of the same name --
 * same order, same steps -- because the loader itself cannot be imported here
 * (Vite `?url` imports, a WebGL renderer). What it stands in for is small and
 * the parts that matter, `furnishOrder` and the fresh instance, are the real
 * ones.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { createHeritageSpice, type HeritageSpice } from '@cosmolabe/frames';
import { kernelsForWindow } from './geometry-kernels';
import {
  furnishOrder,
  kernelName,
  workerKernels,
  type FurnishedKernel,
  type KernelSourceRef,
} from './kernel-set';

const fixture = (name: string): ArrayBuffer => {
  const buf = readFileSync(fileURLToPath(new URL(`../../../../kernels/fixtures/${name}`, import.meta.url)));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

/** A Cassini-at-SOI scene: only `cassini-soi.bsp` can answer for the spacecraft. */
const CASSINI = ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp', 'cassini-soi.bsp'];
/** A scene with the planets but no spacecraft — what replaces it. */
const PLANETS = ['naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp'];

describe('a scene gets a SPICE instance holding exactly its kernels', () => {
  let spice: HeritageSpice;
  let furnished: FurnishedKernel[];
  let userKernelSources: KernelSourceRef[];
  /** Which fixture's bytes a source stands for, when its name is not the fixture's. */
  let bytesFor: WeakMap<object, string>;

  /**
   * A kernel to furnish, as the loader plans one.
   *
   * `'<name>'` is the fixture of that name; `'<name>=<fixture>'` furnishes that
   * fixture's bytes under a different name, which is how a scene here declares
   * a kernel that collides with another by name.
   */
  const planned = (spec: string): KernelSourceRef => {
    const [name, from = name] = spec.split('=');
    const source = { url: `https://example.test/kernels/${from}/${name}` };
    bytesFor.set(source, from);
    return source;
  };

  const bytesOf = (source: KernelSourceRef): ArrayBuffer =>
    fixture(bytesFor.get(source as object) ?? kernelName(source));

  /**
   * The loader's `buildSceneSpice`: drop the instance, build a new one, furnish
   * the user's kernels and then the scene's into it, in that order.
   */
  const loadScene = async (specs: string[]): Promise<void> => {
    spice = await createHeritageSpice();
    furnished = [];

    const plan = furnishOrder(userKernelSources, specs.map(planned), kernelName);
    for (const source of plan) {
      const name = kernelName(source);
      await spice.furnish({ type: 'buffer', data: bytesOf(source), filename: name });
      furnished.push({
        source,
        name,
        coverage: /\.bsp$/i.test(name) ? spice.spkFileCoverage(name) : null,
      });
    }
  };

  /** A kernel the user dropped in with no catalog: kept for every later scene. */
  const dropUserKernel = async (spec: string): Promise<void> => {
    const source = planned(spec);
    const name = kernelName(source);
    await spice.furnish({ type: 'buffer', data: bytesOf(source), filename: name });
    furnished.push({
      source,
      name,
      coverage: /\.bsp$/i.test(name) ? spice.spkFileCoverage(name) : null,
    });
    userKernelSources.push(source);
  };

  const et = () => spice.str2et('2004-07-01T12:00:00');
  /** Cassini relative to Saturn during SOI — answerable only from cassini-soi.bsp. */
  const cassiniQuery = () => spice.spkpos('-82', et(), 'J2000', 'NONE', 'SATURN');
  /** The Moon relative to Earth, which either scene's planetary SPK can serve. */
  const moonQuery = () => spice.spkpos('MOON', et(), 'J2000', 'NONE', 'EARTH');

  beforeEach(async () => {
    spice = await createHeritageSpice();
    furnished = [];
    userKernelSources = [];
    bytesFor = new WeakMap();
  }, 120_000);

  it('stops answering what only the replaced scene could answer', async () => {
    await loadScene(CASSINI);
    // Guards the assertion below: a query that never worked would "fail" for
    // the wrong reason.
    expect(() => cassiniQuery()).not.toThrow();

    await loadScene(PLANETS);

    expect(() => cassiniQuery()).toThrow(/insufficient/i);
  }, 180_000);

  it('answers the new scene’s own queries', async () => {
    await loadScene(CASSINI);
    await loadScene(PLANETS);

    expect(() => moonQuery()).not.toThrow();
    expect(spice.totalLoaded()).toBe(PLANETS.length);
  }, 180_000);

  it('does not accumulate kernels over repeated switches', async () => {
    // #70 itself: before this, every scene's kernels stayed furnished, so the
    // count only ever went up and the last catalog to furnish a body won.
    await loadScene(CASSINI);
    const first = spice.totalLoaded();

    for (let i = 0; i < 3; i++) {
      await loadScene(PLANETS);
      await loadScene(CASSINI);
    }

    expect(spice.totalLoaded()).toBe(first);
    expect(furnished.map((k) => k.name)).toEqual(CASSINI);
  }, 180_000);

  it('gives the workers the main thread’s kernels in the main thread’s order', async () => {
    // Furnish order is precedence, and the workers run their own CSPICE. A
    // list that drifted would answer a different question from the same search.
    await dropUserKernel('mine.bsp=cassini-soi.bsp');
    await loadScene(['naif0012.tls', 'cas_iss_v10.ti', 'de440s-inner-cassini.bsp']);

    expect(furnished.map((k) => k.name)).toEqual([
      'mine.bsp', 'naif0012.tls', 'cas_iss_v10.ti', 'de440s-inner-cassini.bsp',
    ]);
    // The worker's list is that list, minus the types no worker reads.
    expect(workerKernels(furnished).map((k) => k.name)).toEqual([
      'mine.bsp', 'naif0012.tls', 'de440s-inner-cassini.bsp',
    ]);
  }, 180_000);

  it('narrows a search by each kernel’s own measured coverage', async () => {
    // What the geometry worker is given for a window. `de440s-inner-cassini`
    // covers all of 2004; `cassini-soi` only 2004-06-21 to 2004-08-23.
    await loadScene(CASSINI);
    const february = {
      start: spice.str2et('2004-02-01T00:00:00'),
      end: spice.str2et('2004-02-08T00:00:00'),
    };

    const kept = kernelsForWindow(workerKernels(furnished), (k) => k.coverage, february);
    expect(kept.map((k) => k.name)).toEqual([
      'naif0012.tls', 'pck00011.tpc', 'de440s-inner-cassini.bsp',
    ]);
  }, 180_000);

  describe('kernels the user dropped in', () => {
    it('survive a scene load, re-furnished into the new instance', async () => {
      await dropUserKernel('mine.bsp=cassini-soi.bsp');
      expect(() => cassiniQuery()).toThrow(); // no LSK yet, so nothing can be asked

      await loadScene(PLANETS);

      // The scene that replaced it never declared a Cassini kernel; the user's
      // is answering, out of an instance built after they dropped it.
      expect(() => cassiniQuery()).not.toThrow();
      expect(() => moonQuery()).not.toThrow();
      expect(furnished.map((k) => k.name)).toEqual(['mine.bsp', ...PLANETS]);
    }, 180_000);

    it('are overridden by a scene kernel of the same name', async () => {
      // One name, one furnished kernel -- every kernel is staged at
      // `/kernels/<name>`, so the plan keeps the last of a repeated name. The
      // scene's own kernel is last, and wins.
      await dropUserKernel('de440s-inner-cassini.bsp=cassini-soi.bsp');
      await loadScene(PLANETS);

      expect(spice.totalLoaded()).toBe(PLANETS.length);
      expect(furnished.map((k) => k.name)).toEqual(PLANETS);
      // The planetary kernel the scene declared is what is furnished under that
      // name, not the Cassini bytes the user gave it.
      expect(() => moonQuery()).not.toThrow();
      expect(() => cassiniQuery()).toThrow(/insufficient/i);
    }, 180_000);
  });

  it('furnishes a signed URL under the same name the workers will use', async () => {
    // The query string is not part of the kernel: host and workers both call it
    // `naif0012.tls`, and a name carrying the token would be neither stable
    // across a re-signing nor what the other side looks for.
    const signed = { url: 'https://example.test/kernels/naif0012.tls?X-Amz-Signature=abc' };
    bytesFor.set(signed, 'naif0012.tls');
    spice = await createHeritageSpice();
    furnished = [];
    for (const source of furnishOrder([], [signed], kernelName)) {
      const name = kernelName(source);
      await spice.furnish({ type: 'buffer', data: bytesOf(source), filename: name });
      furnished.push({ source, name, coverage: null });
    }

    expect(furnished.map((k) => k.name)).toEqual(['naif0012.tls']);
    // And SPICE knows it by that name: a time conversion needs the LSK it is.
    expect(() => spice.str2et('2004-07-01T12:00:00')).not.toThrow();
  }, 180_000);

  describe('a kernel dropped onto a scene already up', () => {
    /**
     * The cache worker, as a second SPICE instance furnished from the same
     * list. It is a real instance because the claim is about what the two can
     * answer, not about messages: the worker runs its own CSPICE, and a kernel
     * the main thread has and it does not is a search that answers differently
     * depending on which path ran it (#68).
     */
    let workerSpice: HeritageSpice;
    let workerFurnished: string[];

    /** `startSceneWorkers`: the worker is built from the scene's kernel list. */
    const startWorker = async (): Promise<void> => {
      workerSpice = await createHeritageSpice();
      workerFurnished = [];
      for (const kernel of workerKernels(furnished)) {
        await workerSpice.furnish({ type: 'buffer', data: bytesOf(kernel.source), filename: kernel.name });
        workerFurnished.push(kernel.name);
      }
    };

    /**
     * `furnishUserKernels` + `syncWorkersWithDroppedKernels`: furnish into the
     * live instance, then append the same kernels to the worker that is up.
     */
    const dropOntoScene = async (spec: string): Promise<void> => {
      await dropUserKernel(spec);
      const added = furnished.slice(-1);
      for (const kernel of workerKernels(added)) {
        await workerSpice.furnish({ type: 'buffer', data: bytesOf(kernel.source), filename: kernel.name });
        workerFurnished.push(kernel.name);
      }
    };

    it('reaches the worker too, in the main thread’s order', async () => {
      await loadScene(PLANETS);
      await startWorker();
      expect(workerFurnished).toEqual(PLANETS);

      await dropOntoScene('mine.bsp=cassini-soi.bsp');

      // The invariant: same kernels, same order, on both sides.
      expect(furnished.map((k) => k.name)).toEqual([...PLANETS, 'mine.bsp']);
      expect(workerFurnished).toEqual(workerKernels(furnished).map((k) => k.name));
      // And it is not bookkeeping only -- the worker can answer from it.
      expect(() =>
        workerSpice.spkpos('-82', workerSpice.str2et('2004-07-01T12:00:00'), 'J2000', 'NONE', 'SATURN'),
      ).not.toThrow();
    }, 180_000);

    it('does not send the worker a kernel type it does not read', async () => {
      // Attitude, frame and instrument kernels are deliberately not furnished
      // into the workers, so the worker list stays a filter over the host's.
      await loadScene(PLANETS);
      await startWorker();

      await dropOntoScene('cas_iss_v10.ti');

      expect(furnished.map((k) => k.name)).toEqual([...PLANETS, 'cas_iss_v10.ti']);
      expect(workerFurnished).toEqual(PLANETS);
      expect(workerFurnished).toEqual(workerKernels(furnished).map((k) => k.name));
    }, 180_000);

    it('is furnished into the next scene’s instance and its worker', async () => {
      await loadScene(PLANETS);
      await startWorker();
      await dropOntoScene('mine.bsp=cassini-soi.bsp');

      await loadScene(CASSINI);
      await startWorker();

      // Ahead of the new scene's own kernels, and on both sides.
      expect(furnished.map((k) => k.name)).toEqual(['mine.bsp', ...CASSINI]);
      expect(workerFurnished).toEqual(workerKernels(furnished).map((k) => k.name));
    }, 180_000);
  });
});
