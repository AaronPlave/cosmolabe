/**
 * The order a scene's kernels are furnished in.
 *
 * With a scene getting its own SPICE instance (#70), order is what is left to
 * get right, and it carries two meanings at once. It is kernel precedence --
 * two SPKs covering the same body, later wins -- and it is the thing the
 * workers have to reproduce exactly, since they hold their own CSPICE
 * instances and a differently-ordered pool answers a different question (#68).
 *
 * `kernel-set.integration.test.ts` takes the scene behaviour itself to real
 * SPICE. This is the list arithmetic underneath.
 */
import { describe, it, expect } from 'vitest';
import {
  furnishOrder,
  isWorkerKernel,
  kernelName,
  workerKernels,
  type FurnishedKernel,
  type KernelSourceRef,
} from './kernel-set';

const url = (path: string): KernelSourceRef => ({ url: `https://example.test/${path}` });
/** A dropped file, of which only the name is ever read here. */
const file = (name: string): KernelSourceRef => ({ file: { name } as File });

const plan = (user: KernelSourceRef[], catalog: KernelSourceRef[]): string[] =>
  furnishOrder(user, catalog, kernelName).map(kernelName);

const entry = (name: string): FurnishedKernel => ({ source: url(name), name, coverage: null });

describe('kernelName', () => {
  it('is the basename a URL is furnished under, without .gz', () => {
    expect(kernelName(url('a/b/de440s.bsp.gz'))).toBe('de440s.bsp');
  });

  it('ignores a query string, which is not part of the kernel', () => {
    // A signed or cache-busted URL is the same kernel as the bare one, and the
    // adapter furnishes it under the same name. A name carrying the token would
    // be neither stable across a re-signing nor what the workers call it.
    expect(kernelName(url('de440s.bsp?X-Amz-Signature=abc'))).toBe('de440s.bsp');
    expect(kernelName(url('de440s.bsp.gz?v=2#part'))).toBe('de440s.bsp');
  });

  it('is a dropped file’s own name, verbatim', () => {
    expect(kernelName(file('my-spacecraft.bsp'))).toBe('my-spacecraft.bsp');
  });
});

describe('the order a scene is furnished in', () => {
  it('is the user’s kernels, then the catalog’s', () => {
    // The catalog goes last so it can override what the user dropped in, which
    // is the right way round for a scene the user asked to load.
    expect(plan([file('mine.bsp')], [url('cassini.tls'), url('cassini.bsp')]))
      .toEqual(['mine.bsp', 'cassini.tls', 'cassini.bsp']);
  });

  it('keeps a catalog’s declared order', () => {
    expect(plan([], [url('a.bsp'), url('b.bsp'), url('c.bsp')])).toEqual(['a.bsp', 'b.bsp', 'c.bsp']);
  });

  it('is just the catalog’s when nothing was dropped in', () => {
    expect(plan([], [url('cassini.tls')])).toEqual(['cassini.tls']);
  });

  it('furnishes a name once, keeping the last of it', () => {
    // Not an optimisation. Every kernel is staged at `/kernels/<name>`, so two
    // kernels under one name are not two files: the second overwrites the bytes
    // of one CSPICE already has open, and the instance stops being describable.
    // Keeping the last is what "later wins" means when only one can be there.
    expect(plan([], [url('a/de440s.bsp'), url('naif0012.tls'), url('b/de440s.bsp')]))
      .toEqual(['naif0012.tls', 'de440s.bsp']);
  });

  it('lets the catalog displace a dropped kernel of the same name', () => {
    expect(plan([file('de440s.bsp'), file('mine.bsp')], [url('de440s.bsp')]))
      .toEqual(['mine.bsp', 'de440s.bsp']);
  });

  it('keeps the catalog’s copy, not the user’s, when the names collide', () => {
    const kept = furnishOrder([file('de440s.bsp')], [url('de440s.bsp')], kernelName);
    expect(kept).toEqual([url('de440s.bsp')]);
  });

  it('is empty for a scene with no kernels at all', () => {
    expect(plan([], [])).toEqual([]);
  });
});

describe('what the workers are given', () => {
  it('is the main thread’s list, in the main thread’s order', () => {
    const furnished = [
      entry('naif0012.tls'), entry('cassini.bc'), entry('de440s.bsp'),
      entry('cassini.tf'), entry('pck00011.tpc'), entry('cassini-late.bsp'),
    ];

    expect(workerKernels(furnished).map((k) => k.name)).toEqual([
      'naif0012.tls', 'de440s.bsp', 'pck00011.tpc', 'cassini-late.bsp',
    ]);
    // The claim in general: a subsequence of the one list, so the two cannot
    // disagree about the order precedence is read from.
    expect(workerKernels(furnished)).toEqual(furnished.filter((k) => isWorkerKernel(k.name)));
  });

  it('leaves out the kernel types no worker reads', () => {
    // Attitude, frame and instrument kernels: nothing in the worker reads them
    // and they are the expensive ones.
    expect(isWorkerKernel('x.bsp')).toBe(true);
    expect(isWorkerKernel('x.tls')).toBe(true);
    expect(isWorkerKernel('x.tpc')).toBe(true);
    expect(isWorkerKernel('x.bc')).toBe(false);
    expect(isWorkerKernel('x.tf')).toBe(false);
    expect(isWorkerKernel('x.ti')).toBe(false);
  });

  it('reads a .gz name as the kernel type under it', () => {
    expect(isWorkerKernel('de440s.bsp.gz')).toBe(true);
  });
});
