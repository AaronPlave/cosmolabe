/**
 * What a scene's SPICE instance is furnished with, and in what order.
 *
 * A scene load builds a *new* SPICE instance rather than editing the old one
 * into shape (#70). That is the whole design, and it is what keeps this file
 * small: there is no unloading, so there is nothing here about what CSPICE does
 * with a kernel furnished twice, or with an `unload` that fails, or with two
 * files staged under one name. The instance a scene runs on holds exactly the
 * kernels that scene should have, because it has never held anything else.
 *
 * What is left is order, which is the one thing a fresh instance does not give
 * for free. Furnish order *is* kernel precedence -- two SPKs covering the same
 * body, later wins -- and the workers hold their own CSPICE instances that have
 * to reproduce the main thread's order exactly, or the same search answers a
 * different question depending on which path ran it (#68). So the furnish list
 * is decided once, up front, and both sides are built from it.
 */

import { kernelNameFromUrl } from '@cosmolabe/frames';
import type { KernelWindow } from './geometry-kernels';

/** A kernel a worker can be given: fetched by URL, or read from a dropped file. */
export type KernelSourceRef = { url: string } | { file: File };

/** One kernel furnished into the current instance. */
export interface FurnishedKernel {
  readonly source: KernelSourceRef;
  /** The name SPICE knows it by. */
  readonly name: string;
  /**
   * What it covers, measured when it was furnished, or null for a kernel with
   * no coverage to report.
   *
   * Carried here rather than looked up by name when a search needs it. The
   * lookup would ask SPICE about whatever is staged under that name in the
   * instance that exists *now*, which after a scene switch is a different
   * instance entirely -- and it needed a cache, and the cache needed
   * invalidating. This cannot go stale: coverage is a property of the bytes,
   * and the entry is discarded with the instance it describes.
   */
  readonly coverage: readonly KernelWindow[] | null;
}

/**
 * The kernel types furnished into the SPICE workers.
 *
 * Ephemeris, leapseconds and text PCK: what a trajectory cache needs, and what
 * the geometry-event searches that run there need too — `gfdist` over an
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
 * It has to match what was handed to `furnish`, and it has to be what the
 * workers call the same kernel, or the two sets cannot be compared. So a URL
 * goes through the adapter's own `kernelNameFromUrl` rather than a second
 * basename rule here -- a signed URL whose query string one side kept and the
 * other dropped would be furnished under two names, and nothing would say so.
 * A dropped file is furnished under its own name, verbatim.
 */
export function kernelName(source: KernelSourceRef): string {
  return 'url' in source ? kernelNameFromUrl(source.url) : source.file.name;
}

/**
 * The order to furnish a scene in: the user's kernels, then the catalog's.
 *
 * Both halves matter. Kernels the user dropped in with no catalog are theirs
 * and outlive any one scene, so they go into every instance built after them;
 * putting them first lets the scene's own catalog override them where the two
 * describe the same thing, which is the right way round for a scene the user
 * asked to load.
 *
 * A name appearing twice is reduced to its last occurrence, in that
 * occurrence's place. Not an optimisation: the wasm build stages every kernel
 * at `/kernels/<name>`, so furnishing two different kernels under one name does
 * not give the instance two files -- it overwrites the bytes of one CSPICE
 * already has open, and what the instance answers afterwards stops being
 * describable. Keeping the last is what "later wins" means when only one can be
 * there, and it is why a catalog's kernel displaces a user's of the same name
 * rather than colliding with it.
 */
export function furnishOrder<T>(
  userKernels: readonly T[],
  catalogKernels: readonly T[],
  nameOf: (kernel: T) => string,
): T[] {
  const ordered = [...userKernels, ...catalogKernels];
  const seen = new Set<string>();
  const kept: T[] = [];
  for (let i = ordered.length - 1; i >= 0; i--) {
    const name = nameOf(ordered[i]);
    if (seen.has(name)) continue;
    seen.add(name);
    kept.push(ordered[i]);
  }
  return kept.reverse();
}

/**
 * What the workers are furnished with: the same list, same order, minus the
 * kernel types no worker reads.
 *
 * A filter over the one list rather than a list of its own, so the two cannot
 * disagree about order -- a subsequence cannot contradict the sequence it came
 * from.
 */
export function workerKernels(furnished: readonly FurnishedKernel[]): FurnishedKernel[] {
  return furnished.filter((k) => isWorkerKernel(k.name));
}
