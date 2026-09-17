/**
 * A memory readout for the real session, behind `?mem=1`.
 *
 * Written for one question: when a long viewer session grows by hundreds of
 * megabytes, which realm is holding them? The viewer runs SPICE in up to three
 * places -- the main thread, the trajectory-cache worker, and the geometry
 * worker that event searches run on -- and each holds its own CSPICE heap and
 * its own copy of the furnished kernels. Scene geometry, textures and
 * trajectory caches sit on the main thread alongside the first of those. A
 * single process-wide number cannot tell those apart, so it cannot say whether
 * growth is SPICE or the scene, which is the first fork in any such hunt.
 *
 * `performance.measureUserAgentSpecificMemory()` can: it breaks its total down
 * by the realm that owns the memory, and in a cross-origin-isolated page that
 * includes same-origin dedicated workers. Hence the two requirements below --
 * and hence this being a dev aid rather than something shipped on: the viewer
 * deliberately does not require cross-origin isolation in production (see
 * vite.config.ts), so the readout is only available where the dev server's
 * COOP/COEP headers are in force.
 *
 * Two honest limits on what comes back:
 *
 *   - The measurement is deliberately slow. The browser resolves it at a moment
 *     of its choosing, usually the next major GC, which can be many seconds
 *     away. That is also what makes it worth trusting: it reports what survived
 *     collection, not what happens to be uncollected right now. Do not read a
 *     single sample as a leak.
 *   - The CSPICE heaps are included, which is what makes this worth running at
 *     all, but they are not broken out. Measured in Chromium 1194: a touched
 *     256 MB `WebAssembly.Memory` raised the reported total by exactly 256.0 MB,
 *     as did a 256 MB `ArrayBuffer`, both under the owning realm's `JavaScript`
 *     type. So a worker's row is the CSPICE heap plus the kernel bytes in its
 *     MEMFS plus its JavaScript, with no split between them -- read it as "what
 *     this thread holds", which is the question. The spec calls the whole result
 *     user-agent-specific, so that equivalence is Chromium's, not a guarantee.
 *
 * Usage: load the viewer with `?mem=1`, then call `__cosmolabeMemory()` from
 * the console whenever you want a sample. Each one prints a table and, from the
 * second onwards, the change since the previous sample -- which is the number
 * that actually localises growth. With the flag on, a sample is also taken
 * after every event search, since that is the operation this was built to
 * investigate.
 */

/** One realm's share of the total. */
export interface MemoryRealm {
  /** The realm, as the browser attributes it: the page, or a worker's script. */
  readonly label: string;
  readonly bytes: number;
  /** The browser's own categories, e.g. `JavaScript`, `DOM`, `Shared`. */
  readonly types: readonly string[];
}

export interface MemorySnapshot {
  readonly at: number;
  readonly total: number;
  readonly realms: readonly MemoryRealm[];
  /** Chrome's `performance.memory` JS heap, when present. Main thread only. */
  readonly jsHeap?: number;
}

/** Why no measurement could be taken. Never thrown: this is a dev aid. */
export interface MemoryUnavailable {
  readonly unavailable: string;
}

export type MemoryResult = MemorySnapshot | MemoryUnavailable;

export function isUnavailable(result: MemoryResult): result is MemoryUnavailable {
  return 'unavailable' in result;
}

// Neither API is in lib.dom. Both are described where they are used rather than
// widened into the app's global types, which would suggest they are usable.
interface MemoryBreakdownEntry {
  bytes: number;
  attribution: { url?: string; scope?: string }[];
  types: string[];
}
type MeasureMemory = () => Promise<{ bytes: number; breakdown: MemoryBreakdownEntry[] }>;

export const MEMORY_PROBE_ENABLED =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('mem');

/**
 * A realm's name, short enough to read in a table.
 *
 * Attribution carries a URL and a scope; the scope is what distinguishes the
 * page from a worker, and the worker's script name is what distinguishes one
 * worker from another. An entry with no attribution at all is memory the
 * browser could not assign to a realm -- reported as such rather than dropped,
 * since a growing unattributed share is itself a finding.
 */
function realmLabel(entry: MemoryBreakdownEntry): string {
  const first = entry.attribution[0];
  if (!first) return `(unattributed: ${entry.types.join(', ') || 'no type'})`;

  const scope = first.scope ?? '';
  // A worker is identified by its script -- the bundler's hashed filename is
  // what distinguishes the cache worker from the geometry one. A page is
  // identified by its path: its URL usually ends in a directory, so the last
  // segment is empty, and where it is not it is a bare `index.html`.
  if (scope.includes('Worker')) {
    const file = first.url?.split('/').pop()?.split('?')[0];
    return `worker: ${file || first.url || 'unknown'}`;
  }
  if (scope.includes('Window')) {
    let path = first.url;
    try {
      if (first.url) path = new URL(first.url).pathname;
    } catch {
      // Not a URL the runtime will parse; the raw string still names the realm.
    }
    return `page: ${path || '/'}`;
  }
  return first.url ?? scope ?? 'unknown';
}

/**
 * Take one sample.
 *
 * Resolves slowly by design; see the note at the top. Returns a reason rather
 * than throwing when it cannot measure, so a caller can print it and carry on.
 */
export async function measureMemory(): Promise<MemoryResult> {
  const measure = (performance as unknown as { measureUserAgentSpecificMemory?: MeasureMemory })
    .measureUserAgentSpecificMemory;

  if (!measure) {
    return {
      unavailable: globalThis.crossOriginIsolated
        ? 'performance.measureUserAgentSpecificMemory() is not implemented in this browser (Chromium only).'
        : 'The page is not cross-origin isolated, so performance.measureUserAgentSpecificMemory() is not exposed. '
          + 'The dev server sends the COOP/COEP headers that enable it; a production build deliberately does not.',
    };
  }

  let result: Awaited<ReturnType<MeasureMemory>>;
  try {
    result = await measure.call(performance);
  } catch (err) {
    return { unavailable: `Measurement failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Several breakdown entries can share a realm -- one per type. Summing them
  // is what turns the raw list into "what does each thread hold", which is the
  // question. Entries of zero bytes are noise and would crowd out the rest.
  const byRealm = new Map<string, { bytes: number; types: Set<string> }>();
  for (const entry of result.breakdown) {
    if (entry.bytes === 0) continue;
    const label = realmLabel(entry);
    const realm = byRealm.get(label) ?? { bytes: 0, types: new Set<string>() };
    realm.bytes += entry.bytes;
    for (const type of entry.types) realm.types.add(type);
    byRealm.set(label, realm);
  }

  const jsHeap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    ?.usedJSHeapSize;

  return {
    at: Date.now(),
    total: result.bytes,
    realms: [...byRealm.entries()]
      .map(([label, r]) => ({ label, bytes: r.bytes, types: [...r.types] }))
      .sort((a, b) => b.bytes - a.bytes),
    ...(jsHeap === undefined ? {} : { jsHeap }),
  };
}

const MB = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;
const signedMB = (bytes: number): string => `${bytes >= 0 ? '+' : ''}${(bytes / 1048576).toFixed(1)} MB`;

/** The previous sample, so every sample after the first can report a change. */
let previous: MemorySnapshot | null = null;

/**
 * Sample, print, and return.
 *
 * The delta against the previous sample is the point: a single total says how
 * big the tab is, which is rarely in doubt by the time anyone goes looking. The
 * change per realm across an operation says where it went.
 */
export async function sampleMemory(label = 'sample'): Promise<MemoryResult> {
  const result = await measureMemory();
  if (isUnavailable(result)) {
    console.warn(`[Cosmolabe] memory (${label}): ${result.unavailable}`);
    return result;
  }

  const before = previous;
  const priorByLabel = new Map(before?.realms.map((r) => [r.label, r.bytes]));
  const rows = result.realms.map((realm) => {
    const prior = priorByLabel.get(realm.label);
    return {
      realm: realm.label,
      held: MB(realm.bytes),
      // A realm that did not exist at the previous sample is called out as new
      // rather than shown as a large increase from zero: the geometry worker is
      // created on the first search, and that is a step, not growth.
      since: before ? (prior === undefined ? '(new)' : signedMB(realm.bytes - prior)) : '',
      types: realm.types.join(', '),
    };
  });

  const elapsed = before ? `, ${((result.at - before.at) / 1000).toFixed(0)}s since previous` : '';
  console.groupCollapsed(
    `[Cosmolabe] memory (${label}): ${MB(result.total)} total`
      + (before ? `, ${signedMB(result.total - before.total)}` : '')
      + elapsed,
  );
  console.table(rows);
  if (result.jsHeap !== undefined) {
    console.log(`main-thread JS heap (performance.memory): ${MB(result.jsHeap)}`);
  }
  // Realms present before and gone now: a terminated worker whose memory came
  // back. Worth showing, because the geometry worker is rebuilt after a
  // cancellation on a page without SharedArrayBuffer, and whether the old one
  // is actually reclaimed is exactly the kind of thing this is here to answer.
  const gone = before?.realms.filter((r) => !result.realms.some((n) => n.label === r.label)) ?? [];
  for (const realm of gone) console.log(`released: ${realm.label} (held ${MB(realm.bytes)})`);
  console.groupEnd();

  previous = result;
  return result;
}

/** Sample only when `?mem=1`; a no-op otherwise, so callers need no guard. */
export function noteMemory(label: string): void {
  if (!MEMORY_PROBE_ENABLED) return;
  void sampleMemory(label);
}

/**
 * Wire up `__cosmolabeMemory()` and take a baseline.
 *
 * The baseline matters more than it looks: every later sample is reported as a
 * change from the one before it, so without one taken before any searching, the
 * first sample after a search has nothing to be compared against.
 */
export function installMemoryProbe(): void {
  if (!MEMORY_PROBE_ENABLED) return;

  (globalThis as { __cosmolabeMemory?: (label?: string) => Promise<MemoryResult> })
    .__cosmolabeMemory = (label?: string) => sampleMemory(label ?? 'manual');

  console.info(
    '[Cosmolabe] Memory probe on. Call __cosmolabeMemory() for a sample; one is also taken '
      + 'after every event search. Each resolves at the browser\'s convenience (often the next '
      + 'major GC), so expect a delay of seconds.',
  );
  void sampleMemory('baseline');
}
