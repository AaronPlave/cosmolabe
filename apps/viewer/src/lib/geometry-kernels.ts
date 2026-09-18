/**
 * Which kernels a geometry search actually needs.
 *
 * The geometry worker holds its own CSPICE heap and its own copy of every
 * kernel furnished into it. Furnishing the catalog's whole set is what makes
 * that expensive: the Cassini catalog ships fourteen SPKs totalling 106 MB
 * compressed, near 300 MB once staged, and a second copy of that is a second
 * 300 MB for as long as the worker lives.
 *
 * Almost none of it is reachable. A search is confined to a window, and a state
 * at an epoch inside that window can only come from a segment covering that
 * epoch -- so an SPK whose coverage misses the window contributes nothing to the
 * answer. For the finder's ninety-day default that is one or two of the fourteen.
 *
 * The test is deliberately coverage-only, and not "which bodies did the query
 * name". Bodies are the tempting filter and the wrong one: `spkpos` chains
 * through intermediate centres, so the files serving Cassini -> Saturn include
 * whatever carries the barycentres between them, and a body-name filter would
 * quietly drop one and turn a real search into "insufficient ephemeris data".
 * Overlap is safe in a way body identity is not -- dropping only files that
 * cannot contribute at any epoch in range leaves every chain that was available
 * before still available.
 */

/** A coverage interval, as SPICE reports it. */
export interface KernelWindow {
  readonly start: number;
  readonly end: number;
}

/**
 * How far outside the search window a kernel may still be needed.
 *
 * Three effects reach beyond the confinement window's endpoints, and this
 * covers all of them at once rather than trying to bound each: GF may evaluate
 * its geometry a couple of seconds outside while bracketing a root; aberration
 * correction looks back by the light time to the target, which is hours at
 * solar-system scale; and a kernel's coverage is only known to the precision
 * SPICE reports. A day is far larger than any of them and still discards
 * thirteen of Cassini's fourteen SPKs on the default window, so there is
 * nothing to be gained by cutting it finer.
 */
export const KERNEL_WINDOW_PAD_SECONDS = 86_400;

/** Whether a file's coverage could serve any epoch in the padded window. */
export function coversWindow(
  coverage: readonly KernelWindow[],
  window: KernelWindow,
  pad = KERNEL_WINDOW_PAD_SECONDS,
): boolean {
  const start = window.start - pad;
  const end = window.end + pad;
  return coverage.some((c) => c.end >= start && c.start <= end);
}

/**
 * Narrow a kernel list to those a search over `window` could reach.
 *
 * `coverage` returns a file's coverage, or null when it has none to report --
 * which is the answer for every non-SPK. Those are kept unconditionally: a
 * leapseconds or text PCK kernel has no coverage window to test, is required by
 * every search, and is measured in kilobytes. So is any SPK the caller cannot
 * get coverage for, since "I could not tell" must not read as "not needed".
 *
 * Order is preserved, because furnish order is kernel precedence and a search
 * over a differently-ordered pool can answer a different question.
 */
export function kernelsForWindow<T>(
  sources: readonly T[],
  nameOf: (source: T) => string,
  coverage: (name: string) => readonly KernelWindow[] | null,
  window: KernelWindow,
  pad = KERNEL_WINDOW_PAD_SECONDS,
): T[] {
  return sources.filter((source) => {
    const windows = coverage(nameOf(source));
    if (windows === null || windows.length === 0) return true;
    return coversWindow(windows, window, pad);
  });
}

/**
 * Identity of a narrowed set, for deciding whether a furnished worker still
 * suits the next search.
 *
 * The names rather than the window: two windows needing the same files should
 * not cost a rebuild, and that is the common case while a user edits a query
 * inside one mission phase.
 */
export function kernelSetKey(names: readonly string[]): string {
  return names.join('\n');
}
