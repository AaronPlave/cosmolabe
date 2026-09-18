/**
 * What is furnished, in furnish order, and whose it is.
 *
 * Two things depend on this list and they pull in different directions.
 *
 * *Order* is kernel precedence: two SPKs covering the same body, later wins.
 * The workers hold their own CSPICE instances and have to reproduce the main
 * thread's order exactly, or the same search answers a different question
 * depending on which path ran it (#68). That is why there is one ordered list
 * here rather than a list per source, and why the worker's list is a *filter*
 * over it — a subsequence cannot disagree about order with the sequence it came
 * from, so the invariant holds by construction instead of by two call sites
 * remembering to append in step.
 *
 * *Ownership* is lifetime. A scene load replaces the previous scene, so the
 * kernels the previous catalog contributed have to go with it: otherwise
 * Scene B's geometry resolves against Scene A's kernels, the later furnish
 * wins wherever they overlap, and nothing is ever reclaimed (#70). Kernels the
 * user dropped in without a catalog are not a scene's, though — they are the
 * user's own, and surviving a catalog switch is what someone who dragged a
 * file in would expect. So each entry records which it is, and only the
 * catalog's are released.
 *
 * Files are held as handles, not bytes, and re-read on every worker start --
 * the geometry worker is rebuilt whenever a cancellation had to terminate it,
 * so a dropped kernel the user has since moved or deleted will fail to
 * re-furnish.
 */

import { kernelNameFromUrl } from '@cosmolabe/frames';

/** A kernel a worker can be given: fetched by URL, or read from a dropped file. */
export type KernelSourceRef = { url: string } | { file: File };

/**
 * Who a furnished kernel belongs to, which is what decides when it is released.
 *
 * `catalog` — furnished because a catalog asked for it, whether that catalog
 * came from a URL or was dropped in alongside its kernels. Released when the
 * next scene loads.
 *
 * `user` — dropped in with no catalog in the same drop: either onto an empty
 * viewer or onto a scene that is already up. Kept across scene loads.
 */
export type KernelOwner = 'catalog' | 'user';

export interface FurnishedKernel {
  readonly source: KernelSourceRef;
  readonly owner: KernelOwner;
  /** The name SPICE knows it by, which is what `unload` takes. */
  readonly name: string;
}

/**
 * The kernel types furnished into the SPICE workers.
 *
 * Ephemeris, leapseconds and text PCK: what a trajectory cache needs, and what
 * the geometry-event searches that now run there need too — `gfdist` over an
 * observer→target distance reads SPK and LSK, and body shapes come from the
 * text PCK. Attitude (`.bc`), frame (`.tf`) and instrument (`.ti`) kernels are
 * deliberately not loaded: nothing in the worker reads them today, and they are
 * the expensive ones. An event kind that needs them — an FOV or a body-fixed
 * `gfposc` search — must add them here, or its search will find nothing in the
 * worker that the main thread would have found.
 */
const WORKER_KERNEL_EXTS = ['.bsp', '.tls', '.tpc'];

export function isWorkerKernel(name: string): boolean {
  const lower = name.toLowerCase().replace(/\.gz$/, '');
  return WORKER_KERNEL_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * The name SPICE knows a kernel by.
 *
 * It has to match what was handed to `furnish`, because it is what `unload`
 * and the per-file coverage queries take -- and what the workers name the same
 * kernel, or their sets cannot be compared. So a URL goes through the adapter's
 * own `kernelNameFromUrl` rather than a second basename rule here: a signed URL
 * whose query string one side kept and the other dropped would be furnished
 * under one name and unloaded under another, and nothing would say so. A
 * dropped file is furnished under its own name, verbatim.
 */
export function kernelName(source: KernelSourceRef): string {
  return 'url' in source ? kernelNameFromUrl(source.url) : source.file.name;
}

/** The furnished set: one ordered list, filtered for the workers, pruned per scene. */
export class KernelRegistry {
  #entries: FurnishedKernel[] = [];

  /** Every kernel furnished on the main thread, in furnish order. */
  get entries(): readonly FurnishedKernel[] {
    return this.#entries;
  }

  /** Whether this URL is already furnished — the check that skips a re-fetch. */
  has(url: string): boolean {
    return this.#entries.some((e) => 'url' in e.source && e.source.url === url);
  }

  register(source: KernelSourceRef, owner: KernelOwner): void {
    this.#entries.push({ source, owner, name: kernelName(source) });
  }

  /**
   * What the workers are furnished with: the same list, same order, minus the
   * kernel types no worker reads.
   */
  workerSources(): KernelSourceRef[] {
    return this.#entries.filter((e) => isWorkerKernel(e.name)).map((e) => e.source);
  }

  /** Drop one entry, for a kernel the SPICE instance turned out not to have. */
  forget(entry: FurnishedKernel): void {
    const at = this.#entries.indexOf(entry);
    if (at >= 0) this.#entries.splice(at, 1);
  }

  /** Forget everything, for an instance that had to be abandoned wholesale. */
  clear(): void {
    this.#entries = [];
  }

  /**
   * Forget every catalog-owned kernel and report what to unload.
   *
   * Reverse furnish order, which is the order CSPICE itself would undo them
   * in, and never a name some surviving entry still holds — a user-dropped
   * kernel sharing a filename with the catalog's is furnished under the one
   * name, so unloading the catalog's would take the user's with it.
   */
  releaseCatalogKernels(): string[] {
    const released = this.#entries.filter((e) => e.owner === 'catalog');
    this.#entries = this.#entries.filter((e) => e.owner !== 'catalog');

    const kept = new Set(this.#entries.map((e) => e.name));
    const names: string[] = [];
    for (let i = released.length - 1; i >= 0; i--) {
      const name = released[i].name;
      if (kept.has(name) || names.includes(name)) continue;
      names.push(name);
    }
    return names;
  }
}

/**
 * What a release needs of the SPICE instance behind the registry.
 *
 * An interface rather than the instance itself so the failure path below is
 * reachable from a test: it is the path that cannot be exercised by asking a
 * healthy CSPICE to misbehave.
 */
export interface KernelReleaseHost {
  /** Unload one kernel by the name it was furnished under. Throws on failure. */
  unload(name: string): void;
  /**
   * Abandon the SPICE instance, start a fresh one, and re-furnish `keep` in
   * order. Returns the entries that came back -- anything missing from the
   * result is a kernel the new instance does not have.
   */
  rebuild(keep: readonly FurnishedKernel[]): Promise<readonly FurnishedKernel[]>;
}

export interface KernelReleaseResult {
  /** The names the release tried to unload. */
  readonly released: readonly string[];
  /** The ones that would not unload, which is what forced a rebuild. */
  readonly failed: readonly string[];
  /** Whether the instance had to be replaced rather than unloaded from. */
  readonly rebuilt: boolean;
}

/**
 * Release the previous catalog's kernels, leaving the registry and the SPICE
 * instance agreeing about what is furnished.
 *
 * That agreement is the whole point, and it is why a failed unload cannot just
 * be logged. The registry is what the new scene's workers are built from, so an
 * entry dropped here while the kernel stayed furnished on the main thread gives
 * the two paths different kernel sets -- the exact thing this module exists to
 * prevent -- and leaves a kernel no longer belonging to any scene answering
 * main-thread geometry for the rest of the session. Leaving the entry in place
 * instead is no better: Scene B would go on seeing Scene A's kernel, knowingly.
 *
 * So an unload that fails escalates: the instance is abandoned and rebuilt from
 * the entries that survive, which is the one outcome that is true of both sides
 * however the unload failed. A survivor the rebuild cannot re-furnish (a dropped
 * file the user has since moved) is forgotten with it, because the new instance
 * really does not have it. If the rebuild itself fails the registry is emptied
 * and the error is raised: the scene load that called this is abandoned, and
 * nothing downstream gets to believe in kernels that are not there.
 */
export async function releaseCatalogKernels(
  registry: KernelRegistry,
  host: KernelReleaseHost,
): Promise<KernelReleaseResult> {
  const released = registry.releaseCatalogKernels();
  if (released.length === 0) return { released, failed: [], rebuilt: false };

  const failed: string[] = [];
  for (const name of released) {
    try {
      host.unload(name);
    } catch {
      failed.push(name);
    }
  }
  if (failed.length === 0) return { released, failed, rebuilt: false };

  const keep = [...registry.entries];
  let refurnished: readonly FurnishedKernel[];
  try {
    refurnished = await host.rebuild(keep);
  } catch (err) {
    registry.clear();
    throw err;
  }

  const kept = new Set(refurnished);
  for (const entry of keep) {
    if (!kept.has(entry)) registry.forget(entry);
  }
  return { released, failed, rebuilt: true };
}
