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
import type { KernelWindow } from './geometry-kernels';

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
  /**
   * What this kernel covers, measured when it was furnished, or null for one
   * with no coverage to report.
   *
   * Carried on the entry rather than looked up by name when a search needs it,
   * because `spkFileCoverage` answers about the file staged at
   * `/kernels/<name>` -- and two entries can share that name, in which case the
   * lookup would give one kernel's coverage for the other's entry and narrow a
   * search to the wrong set. Measured at furnish time is the one moment the
   * name unambiguously means this kernel. It cannot go stale: coverage is a
   * property of the bytes.
   */
  readonly coverage: readonly KernelWindow[] | null;
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

  /**
   * The entry furnished under `name`, if one is.
   *
   * There is at most one, and keeping it that way is what
   * `displaceKernelNamed` in the loader exists for: the wasm build stages every
   * kernel at `/kernels/<name>`, so a second kernel furnished under a name
   * another still holds does not become a second file. It overwrites the bytes
   * of the one that is there while CSPICE still holds that file open against
   * its old contents -- measured, the newcomer's data is unreachable and the
   * occupant's reads come back corrupt ("beginning address greater than ending
   * address"). A name is a slot, and this is how the loader checks whether the
   * slot is taken before putting something in it.
   */
  findByName(name: string): FurnishedKernel | undefined {
    return this.#entries.find((e) => e.name === name);
  }

  /** Whether this URL is already furnished — the check that skips a re-fetch. */
  has(url: string): boolean {
    return this.#entries.some((e) => 'url' in e.source && e.source.url === url);
  }

  /**
   * Record a kernel just furnished.
   *
   * `coverage` is measured by the caller, which is the only place that can:
   * it has the SPICE instance, and it is there at the moment this kernel is
   * what its name refers to. Null for anything with no coverage to report.
   */
  register(
    source: KernelSourceRef,
    owner: KernelOwner,
    coverage: readonly KernelWindow[] | null = null,
  ): void {
    this.#entries.push({ source, owner, name: kernelName(source), coverage });
  }

  /**
   * What the workers are furnished with: the same list, same order, minus the
   * kernel types no worker reads.
   */
  workerEntries(): FurnishedKernel[] {
    return this.#entries.filter((e) => isWorkerKernel(e.name));
  }

  /** The same list as sources, for a caller that needs no more than that. */
  workerSources(): KernelSourceRef[] {
    return this.workerEntries().map((e) => e.source);
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
   * Forget every catalog-owned kernel, and say how to take them out of SPICE.
   *
   * Unload names come back in reverse furnish order, which is the order CSPICE
   * would undo them in.
   *
   * A name held by more than one entry is reported as a collision instead, and
   * the caller rebuilds the instance rather than unloading anything.
   *
   * This is a backstop, not the primary defence. The loader keeps one entry per
   * name by displacing the occupant before it furnishes (`findByName`), so a
   * collision should not arise at all. It is checked anyway because the cost of
   * being wrong is not a warning: `furnsh_c` records every load, including a
   * repeat under a name it already has, and `unload_c` undoes only the most
   * recent -- so N furnishes under one name need N unloads, and one call leaves
   * the rest furnished and unaccounted for. A future furnish path that forgets
   * to displace should cost a rebuilt instance, not a silently divergent one.
   *
   * Counting entries is a sound proxy for counting furnishes because they are
   * one to one: the only skip on the furnish path is by URL (`has`), so a
   * repeat of the same URL is never furnished twice, and everything that is
   * furnished is registered.
   */
  releaseCatalog(): KernelReleasePlan {
    const released = this.#entries.filter((e) => e.owner === 'catalog');

    // Counted before the prune, over everything furnished: a released name that
    // a survivor also holds is exactly as unloadable-by-name as one two
    // catalogs both brought, which is to say not at all.
    const furnishes = new Map<string, number>();
    for (const e of this.#entries) furnishes.set(e.name, (furnishes.get(e.name) ?? 0) + 1);

    this.#entries = this.#entries.filter((e) => e.owner !== 'catalog');

    const unload: string[] = [];
    const collisions: string[] = [];
    for (let i = released.length - 1; i >= 0; i--) {
      const name = released[i].name;
      if (unload.includes(name) || collisions.includes(name)) continue;
      if ((furnishes.get(name) ?? 0) > 1) collisions.push(name);
      else unload.push(name);
    }
    return { unload, collisions };
  }
}

/** How a release can be carried out, or why it cannot be. */
export interface KernelReleasePlan {
  /** Names to unload, once each, in reverse furnish order. */
  readonly unload: readonly string[];
  /** Released names standing for more than one furnish, which force a rebuild. */
  readonly collisions: readonly string[];
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
  /** The names the release unloaded, or would have but for a rebuild. */
  readonly released: readonly string[];
  /** The ones that would not unload, if that is what forced the rebuild. */
  readonly failed: readonly string[];
  /** The names that stood for more than one furnish, if that is what did. */
  readonly collided: readonly string[];
  /** Whether the instance had to be replaced rather than unloaded from. */
  readonly rebuilt: boolean;
}

/**
 * Release the previous catalog's kernels, leaving the registry and the SPICE
 * instance agreeing about what is furnished.
 *
 * That agreement is the whole point. The registry is what the new scene's
 * workers are built from, so a kernel the registry has forgotten but the
 * instance still holds gives the two paths different kernel sets -- the exact
 * thing this module exists to prevent -- and leaves a kernel belonging to no
 * scene answering main-thread geometry for the rest of the session.
 *
 * Two things can cost that agreement, and both take the same way out: abandon
 * the instance and rebuild it from the entries that survive. It is the one
 * outcome that is true of both sides whatever went wrong.
 *
 * A *collision* is known before anything is attempted -- a released name that
 * stands for more than one furnish, which no number of `unload` calls can be
 * trusted to undo (see `releaseCatalog`). Nothing is unloaded in that case; the
 * rebuild is the plan, not a recovery.
 *
 * An *unload that fails* is the recovery. Logging it and going on would be the
 * silent divergence above; leaving the entry in the registry instead is no
 * better, since Scene B would then go on seeing Scene A's kernel knowingly.
 *
 * Either way, a survivor the rebuild cannot re-furnish (a dropped file the user
 * has since moved) is forgotten with it, because the new instance really does
 * not have it. If the rebuild itself fails the registry is emptied and the
 * error is raised: the scene load that called this is abandoned, and nothing
 * downstream gets to believe in kernels that are not there.
 */
export async function releaseCatalogKernels(
  registry: KernelRegistry,
  host: KernelReleaseHost,
): Promise<KernelReleaseResult> {
  const { unload, collisions } = registry.releaseCatalog();
  const released = [...unload, ...collisions];
  if (released.length === 0) {
    return { released, failed: [], collided: [], rebuilt: false };
  }

  const failed: string[] = [];
  if (collisions.length === 0) {
    for (const name of unload) {
      try {
        host.unload(name);
      } catch {
        failed.push(name);
      }
    }
    if (failed.length === 0) return { released, failed, collided: [], rebuilt: false };
  }

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
  return { released, failed, collided: collisions, rebuilt: true };
}
