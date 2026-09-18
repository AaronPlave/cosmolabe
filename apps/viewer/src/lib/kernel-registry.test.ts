/**
 * Kernel lifetime across scene loads, and the invariant it must not break.
 *
 * Two claims are worth a test rather than an inspection.
 *
 * The first is #70's: a scene replaced is a scene's kernels released. Before
 * this, loading Cassini and then Clipper left both catalogs furnished, and a
 * body both cover answered from whichever furnished last -- not from the scene
 * on screen.
 *
 * The second is #68's, which #70 must not cost: whatever the main thread is
 * furnished with, the workers are furnished with the same kernels in the same
 * order. Furnish order is precedence, so a worker whose list drifted answers a
 * different question from the main thread for the same search. Here that holds
 * because the worker list is a filter over the one ordered list -- so the thing
 * to pin is that it really is one list, through drops, scene loads, and the
 * releases between them.
 */
import { describe, it, expect } from 'vitest';
import {
  KernelRegistry,
  isWorkerKernel,
  kernelName,
  releaseCatalogKernels,
  type FurnishedKernel,
  type KernelSourceRef,
} from './kernel-registry';

const CATALOG = 'https://example.test/catalogs';

const url = (name: string): KernelSourceRef => ({ url: `${CATALOG}/${name}` });
/** A dropped file, of which only the name is ever read here. */
const file = (name: string): KernelSourceRef => ({ file: { name } as File });

const names = (registry: KernelRegistry): string[] =>
  registry.entries.map((e) => e.name);

const workerNames = (registry: KernelRegistry): string[] =>
  registry.workerSources().map(kernelName);

/**
 * The main thread's list restricted to what a worker takes.
 *
 * Deliberately recomputed from `entries` rather than trusted from
 * `workerSources`: the claim is that the worker's list IS this subsequence, and
 * a test that asked the same method twice would not be testing it.
 */
const expectedWorkerNames = (registry: KernelRegistry): string[] =>
  names(registry).filter(isWorkerKernel);

/** A catalog's set, as a scene load furnishes it: LSK, PCK, then its SPKs. */
const loadCatalog = (registry: KernelRegistry, prefix: string, extras: string[] = []) => {
  registry.releaseCatalogKernels();
  for (const name of [`${prefix}.tls`, `${prefix}.tpc`, `${prefix}.bsp`, ...extras]) {
    registry.register(url(name), 'catalog');
  }
};

describe('kernelName', () => {
  it('is the basename a URL is furnished under, without .gz', () => {
    expect(kernelName({ url: 'https://example.test/a/b/de440s.bsp.gz' })).toBe('de440s.bsp');
  });

  it('ignores a query string, which is not part of the kernel', () => {
    // A signed or cache-busted URL is the same kernel as the bare one, and the
    // adapter furnishes it under the same name -- so registering it under a
    // name carrying the token would mean unloading something that is not there.
    expect(kernelName({ url: 'https://example.test/de440s.bsp?token=abc123' })).toBe('de440s.bsp');
    expect(kernelName({ url: 'https://example.test/de440s.bsp.gz?v=2#frag' })).toBe('de440s.bsp');
  });

  it('is a dropped file’s own name, verbatim', () => {
    // What `furnish` was handed, so what `unload` and the coverage query take.
    expect(kernelName(file('my-spacecraft.bsp'))).toBe('my-spacecraft.bsp');
  });
});

describe('releasing a scene’s kernels', () => {
  it('drops the previous catalog’s and keeps the new one’s', () => {
    const registry = new KernelRegistry();
    loadCatalog(registry, 'cassini');
    loadCatalog(registry, 'clipper');

    expect(names(registry)).toEqual(['clipper.tls', 'clipper.tpc', 'clipper.bsp']);
  });

  it('reports what to unload, in reverse furnish order', () => {
    // Reverse because that is the order CSPICE would undo them in, and the
    // order in which precedence unwinds cleanly.
    const registry = new KernelRegistry();
    loadCatalog(registry, 'cassini');

    expect(registry.releaseCatalogKernels()).toEqual([
      'cassini.bsp', 'cassini.tpc', 'cassini.tls',
    ]);
    expect(names(registry)).toEqual([]);
  });

  it('releases a kernel once however many catalogs asked for it', () => {
    const registry = new KernelRegistry();
    registry.register(url('naif0012.tls'), 'catalog');
    registry.register(url('naif0012.tls'), 'catalog');

    expect(registry.releaseCatalogKernels()).toEqual(['naif0012.tls']);
  });

  it('never unloads a name a surviving kernel still holds', () => {
    // The user dropped a file under the same name the catalog furnishes; SPICE
    // knows one file by that name, so unloading "the catalog's" would take the
    // user's with it.
    const registry = new KernelRegistry();
    registry.register(file('de440s.bsp'), 'user');
    registry.register(url('de440s.bsp'), 'catalog');

    expect(registry.releaseCatalogKernels()).toEqual([]);
    expect(names(registry)).toEqual(['de440s.bsp']);
  });

  it('is a no-op with nothing of a catalog’s furnished', () => {
    const registry = new KernelRegistry();
    registry.register(file('dropped.bsp'), 'user');

    expect(registry.releaseCatalogKernels()).toEqual([]);
    expect(names(registry)).toEqual(['dropped.bsp']);
  });
});

describe('kernels the user dropped in', () => {
  it('survive a scene load', () => {
    const registry = new KernelRegistry();
    registry.register(file('my-spacecraft.bsp'), 'user');
    loadCatalog(registry, 'cassini');
    loadCatalog(registry, 'clipper');

    expect(names(registry)).toEqual([
      'my-spacecraft.bsp', 'clipper.tls', 'clipper.tpc', 'clipper.bsp',
    ]);
  });

  it('stay ahead of the catalog’s, as they were furnished', () => {
    // Precedence: a file the user dropped onto Scene A is furnished before
    // Scene B's, so B's own SPK wins where the two overlap. The list has to
    // keep saying that after A's kernels are gone.
    const registry = new KernelRegistry();
    loadCatalog(registry, 'cassini');
    registry.register(file('patch.bsp'), 'user');
    loadCatalog(registry, 'clipper');

    expect(names(registry)).toEqual([
      'patch.bsp', 'clipper.tls', 'clipper.tpc', 'clipper.bsp',
    ]);
  });
});

describe('the worker’s list against the main thread’s', () => {
  it('is the main thread’s order, minus the types no worker reads', () => {
    const registry = new KernelRegistry();
    loadCatalog(registry, 'cassini', ['cassini.bc', 'cassini.tf', 'cassini-late.bsp']);

    expect(workerNames(registry)).toEqual([
      'cassini.tls', 'cassini.tpc', 'cassini.bsp', 'cassini-late.bsp',
    ]);
    expect(workerNames(registry)).toEqual(expectedWorkerNames(registry));
  });

  it('agrees at every step of a session’s drops and scene loads', () => {
    // The sequence that used to drift: a drop, a scene, a drop onto it, a
    // second scene. Checked after each step, not only at the end, because a
    // list that is right again by the end was still wrong for the searches
    // that ran in between.
    const registry = new KernelRegistry();
    const steps: (() => void)[] = [
      () => registry.register(file('dropped.bsp'), 'user'),
      () => loadCatalog(registry, 'cassini', ['cassini.bc']),
      () => registry.register(file('late.tpc'), 'user'),
      () => loadCatalog(registry, 'clipper', ['clipper.tf', 'clipper-gm.tpc']),
    ];

    for (const step of steps) {
      step();
      expect(workerNames(registry)).toEqual(expectedWorkerNames(registry));
    }

    expect(names(registry)).toEqual([
      'dropped.bsp', 'late.tpc',
      'clipper.tls', 'clipper.tpc', 'clipper.bsp', 'clipper.tf', 'clipper-gm.tpc',
    ]);
    expect(workerNames(registry)).toEqual([
      'dropped.bsp', 'late.tpc',
      'clipper.tls', 'clipper.tpc', 'clipper.bsp', 'clipper-gm.tpc',
    ]);
  });

  it('keeps a .gz kernel under the name it is furnished with', () => {
    // The worker fetches the same URL and furnishes the decompressed bytes, so
    // both sides know it as `de440s.bsp` and the lists still match by name.
    const registry = new KernelRegistry();
    registry.register(url('de440s.bsp.gz'), 'catalog');

    expect(workerNames(registry)).toEqual(['de440s.bsp']);
  });
});

describe('the already-furnished check', () => {
  it('sees a URL that is furnished, and stops seeing it once released', () => {
    const registry = new KernelRegistry();
    registry.register(url('de440s.bsp'), 'catalog');
    expect(registry.has(`${CATALOG}/de440s.bsp`)).toBe(true);

    registry.releaseCatalogKernels();
    // The point of releasing: the next scene re-fetches and re-furnishes rather
    // than skipping a kernel it no longer has.
    expect(registry.has(`${CATALOG}/de440s.bsp`)).toBe(false);
  });

  it('does not answer for a dropped file, which has no URL', () => {
    const registry = new KernelRegistry();
    registry.register(file('de440s.bsp'), 'user');
    expect(registry.has('de440s.bsp')).toBe(false);
  });
});

/**
 * The failure path, which is the one a healthy CSPICE will not produce.
 *
 * It matters more than its likelihood suggests: an unload that fails leaves a
 * kernel furnished on the main thread, and if the registry has already forgotten
 * it, the scene's workers are built from a list the main thread does not match.
 * That is the invariant this module exists to hold, failing silently.
 */
describe('an unload that fails', () => {
  /** A host whose unload refuses for the named kernels. */
  const hostRefusing = (refuse: string[]) => {
    const unloaded: string[] = [];
    const rebuilds: (readonly FurnishedKernel[])[] = [];
    return {
      unloaded,
      rebuilds,
      /** What the rebuilt instance manages to re-furnish. Everything, by default. */
      restore: (keep: readonly FurnishedKernel[]): readonly FurnishedKernel[] => keep,
      unload(name: string) {
        if (refuse.includes(name)) throw new Error(`unload_c refused ${name}`);
        unloaded.push(name);
      },
      async rebuild(keep: readonly FurnishedKernel[]) {
        rebuilds.push(keep);
        return this.restore(keep);
      },
    };
  };

  it('rebuilds the instance from the entries that survive, in order', async () => {
    const registry = new KernelRegistry();
    registry.register(file('dropped.bsp'), 'user');
    loadCatalog(registry, 'cassini');

    const host = hostRefusing(['cassini.bsp']);
    const result = await releaseCatalogKernels(registry, host);

    expect(result.failed).toEqual(['cassini.bsp']);
    expect(result.rebuilt).toBe(true);
    expect(host.rebuilds).toHaveLength(1);
    expect(host.rebuilds[0].map((e) => e.name)).toEqual(['dropped.bsp']);
    expect(names(registry)).toEqual(['dropped.bsp']);
  });

  it('does not rebuild when every unload succeeds', async () => {
    const registry = new KernelRegistry();
    loadCatalog(registry, 'cassini');

    const host = hostRefusing([]);
    const result = await releaseCatalogKernels(registry, host);

    expect(result.rebuilt).toBe(false);
    expect(host.rebuilds).toEqual([]);
    expect(host.unloaded).toEqual(['cassini.bsp', 'cassini.tpc', 'cassini.tls']);
  });

  it('forgets a survivor the rebuilt instance could not take back', async () => {
    // A dropped file the user has since moved cannot be re-read. The new
    // instance genuinely does not have it, so neither may the registry --
    // otherwise the workers are promised a kernel the main thread lacks.
    const registry = new KernelRegistry();
    registry.register(file('moved.bsp'), 'user');
    registry.register(file('still-there.bsp'), 'user');
    loadCatalog(registry, 'cassini');

    const host = hostRefusing(['cassini.tls']);
    host.restore = (keep) => keep.filter((e) => e.name !== 'moved.bsp');
    await releaseCatalogKernels(registry, host);

    expect(names(registry)).toEqual(['still-there.bsp']);
  });

  it('empties the registry if the rebuild itself fails', async () => {
    // Nothing downstream may go on believing in kernels no one can account
    // for; the throw fails the scene load that asked for the release.
    const registry = new KernelRegistry();
    registry.register(file('dropped.bsp'), 'user');
    loadCatalog(registry, 'cassini');

    const host = hostRefusing(['cassini.bsp']);
    host.rebuild = async () => { throw new Error('wasm instantiation failed'); };

    await expect(releaseCatalogKernels(registry, host)).rejects.toThrow('wasm instantiation failed');
    expect(names(registry)).toEqual([]);
  });

  it('is a no-op when the previous scene furnished nothing', async () => {
    const registry = new KernelRegistry();
    registry.register(file('dropped.bsp'), 'user');

    const host = hostRefusing([]);
    const result = await releaseCatalogKernels(registry, host);

    expect(result).toEqual({ released: [], failed: [], rebuilt: false });
    expect(names(registry)).toEqual(['dropped.bsp']);
  });
});
