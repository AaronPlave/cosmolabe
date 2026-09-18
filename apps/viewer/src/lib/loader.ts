/**
 * Catalog & kernel loading logic.
 *
 * Catalog-driven: a catalog file (URL or dropped JSON) declares its `require`
 * dependencies and `spiceKernels`. The resolver walks the require graph,
 * furnishes all referenced kernels (with `.tm` meta-kernels expanded), and
 * initializes the scene. There is no per-mission code path.
 */
import * as THREE from 'three';
import {
  Universe,
  loadCatalogFromUrl,
  bodyFixedOffsetToWorld,
  etFromCalendarString,
  type ResolvedCatalogGraph,
  type ResolvedKernel,
} from '@cosmolabe/core';
// The runtime SPICE instance is @cosmolabe/frames' heritage adapter over
// cspice-wasm, and HeritageSpice — the adapter's own type — is what the
// exported getSpice() accessor returns. The app genuinely programs against the
// wide heritage surface (spkFileCoverage, totalLoaded, vnorm), so it names the
// implementation's type rather than core's injection interface, which is
// deliberately only what core itself calls.
// The ?url import hands Vite's emitted wasm asset to the engine's locateFile —
// only the bundler knows where that asset lands.
import { createHeritageSpice, kernelNameFromUrl, type HeritageSpice } from '@cosmolabe/frames';
import cspiceWasmUrl from 'cspice-wasm/wasm/cspice.wasm?url';
import { UniverseRenderer, SpiceCacheWorker, ScreenshotPlugin, VideoRecordPlugin, OrbitalInfoPlugin, captureFrameDataUrl } from '@cosmolabe/three';
import { GeometrySearchWorker, type GeometrySearchScope, type KernelSource } from '@cosmolabe/three';
import { execute, parse, type ExecutionReport, type ViewerControl } from '@cosmolabe/control';
import SpiceCacheRelayWorker from '../workers/spice-cache-relay.ts?worker';
import { parseMetaKernel } from './metakernel';
import { kernelSetKey, kernelsForWindow, type KernelWindow } from './geometry-kernels';
import {
  KernelRegistry,
  kernelName,
  releaseCatalogKernels as releaseFromRegistry,
  type FurnishedKernel,
  type KernelSourceRef,
} from './kernel-registry';
import {
  bindRenderer,
  gotoObject,
  syncBodies,
  setSceneLoaded,
  setKernelCount,
  setLoadingState,
  beginLoad,
  setPhaseProgress,
  endLoad,
  selectBody,
  formatBytes,
} from './viewer-state.svelte';
import { createViewerControl } from './viewer-control';

// ── State ──
let spice: HeritageSpice | null = null;
let universe: Universe | null = null;
let renderer: UniverseRenderer | null = null;
let cacheWorker: SpiceCacheWorker | null = null;
/**
 * How long the geometry worker may sit idle before it is released.
 *
 * It costs 235 MB on the Cassini catalog -- a CSPICE instance's fixed 160 MB
 * heap plus the kernels its last search needed -- and the event finder is used
 * in bursts. Holding that between bursts is the worse trade: coming back to it
 * costs about a second (the wasm instantiates in tens of milliseconds, and the
 * narrowed kernel set furnishes at roughly 7-20 ms per megabyte after its
 * fetch, which the browser's HTTP cache serves), against searches that
 * themselves take seconds.
 *
 * A minute rather than something tighter because every call pushes the release
 * back, so this is the gap after which someone has plainly stopped searching --
 * not a budget for one search. Editing a query and re-running never pays it.
 */
const GEOMETRY_WORKER_IDLE_MS = 60_000;

/**
 * Searches run here, not on the cache worker.
 *
 * Two reasons, both about the fact that CSPICE is synchronous and a worker has
 * one thread. A search sharing the cache worker blocks every trajectory build
 * queued behind it for as long as it runs; and cancelling a running search means
 * terminating its worker -- the only thing that stops synchronous wasm -- which
 * is survivable only if that worker holds nothing else. Built on the first
 * search, not here.
 */
let geometryWorker: GeometrySearchWorker | null = null;

/**
 * Every kernel furnished on the main thread, in furnish order, with whose it
 * is. The workers' list is a filter over it, so the two cannot disagree about
 * order; releasing a scene's kernels is a prune of it. See `kernel-registry`.
 */
const kernels = new KernelRegistry();

/**
 * What a kernel covers, asked the moment it is furnished.
 *
 * Asked then, and kept on its registry entry, because that is the only moment
 * its name unambiguously means this kernel: `spkFileCoverage` answers about the
 * file staged at `/kernels/<name>`, and a later kernel sharing that basename
 * takes the name over. Asking at search time would then narrow one kernel's
 * search by its namesake's coverage and drop a file that does cover the window
 * -- a silently wrong answer, which is what narrowing must never cost.
 *
 * It is also cheaper than it looks: this walks an SPK's segment summaries,
 * against a furnish that has just read the whole file. And it cannot go stale,
 * because a kernel's coverage is a property of its bytes.
 *
 * Null means "no coverage to test": a leapseconds or text PCK kernel, or an SPK
 * SPICE would not answer for. Both must be kept, so both are reported the same
 * way -- a file we cannot judge is never one we drop.
 */
function measureCoverage(s: HeritageSpice, name: string): readonly KernelWindow[] | null {
  if (!/\.(bsp|spk)$/i.test(name)) return null;
  try {
    return s.spkFileCoverage(name);
  } catch {
    // Unreadable coverage is not absent coverage; keeping the kernel is the
    // safe reading, which null already means.
    return null;
  }
}

/** The scope a viewer search carries: its key, plus the window that produced it. */
interface ViewerGeometryScope extends GeometrySearchScope {
  readonly window: KernelWindow;
}

function scopeWindow(scope?: GeometrySearchScope): KernelWindow | null {
  return scope && 'window' in scope ? (scope as ViewerGeometryScope).window : null;
}

/** The kernels a search over `window` could reach, or all of them for no window. */
function scopedKernelEntries(window: KernelWindow | null): readonly FurnishedKernel[] {
  const entries = kernels.workerEntries();
  if (!window) return entries;
  // By the entry's own measured coverage, never by a lookup on its name: two
  // entries can share a name, and only the entry knows which kernel it is.
  return kernelsForWindow(entries, (e) => e.coverage, window);
}

/**
 * The scope for a search over `window`, or undefined when nothing can be
 * narrowed and the full set is what the worker should hold.
 */
export function geometryScopeForWindow(window: KernelWindow): GeometrySearchScope | undefined {
  if (!getSpice()) return undefined;
  const names = scopedKernelEntries(window).map((e) => e.name);
  const scope: ViewerGeometryScope = { key: kernelSetKey(names), window };
  return scope;
}

/**
 * The worker kernel list as bytes-or-URLs, read fresh each call.
 *
 * Called once per worker start rather than once per session, because the
 * geometry worker is rebuilt after a cancellation that had to terminate it, or
 * when a search needs a different set, and has to come back furnished for
 * whatever it is being started for.
 *
 * With a scope, the list is narrowed to the kernels that search can reach --
 * the geometry worker holds its own copy of every one, so the catalog's whole
 * set is a second copy of the catalog. Without one (the trajectory-cache
 * worker, which serves the whole timeline) it is everything.
 */
async function currentWorkerKernels(scope?: GeometrySearchScope): Promise<KernelSource[]> {
  return Promise.all(
    scopedKernelEntries(scopeWindow(scope)).map(async ({ source }) =>
      'url' in source
        ? source.url
        : { name: source.file.name, data: await source.file.arrayBuffer() },
    ),
  );
}

/** Visual-regression test mode — set via `?test=1`. Strips GPU-variant noise
 *  (antialias / bloom / starfield) and installs the `window.__cosmolabe`
 *  deterministic-capture hook. Never true in normal use. */
const TEST_MODE =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('test');

const KERNEL_EXTENSIONS = new Set([
  '.bsp', '.tls', '.tpc', '.tf', '.tsc', '.ti', '.ck', '.bc', '.bpc', '.spk', '.pck', '.fk', '.tm',
]);
const MODEL_EXTENSIONS = new Set(['.gltf', '.glb', '.obj', '.cmod']);
const TEXTURE_EXTENSIONS = new Set(['.dds', '.jpg', '.jpeg', '.png', '.bmp', '.tga']);

/**
 * Release the kernels the previous catalog furnished.
 *
 * Called at the top of every scene load, before the new catalog's own kernels
 * go in, so a scene's geometry is resolved against that scene's kernels and
 * nothing else. Without it the SPICE instance accumulates every catalog of the
 * session: the later furnish wins wherever two catalogs' SPKs, PCKs or LSKs
 * overlap -- whichever scene the user is actually looking at -- and nothing is
 * ever reclaimed.
 *
 * Kernels the user dropped in without a catalog survive this; see
 * `kernel-registry` for why, and `handleFileList` for which drops count as a
 * catalog's.
 *
 * Two cases escalate to rebuilding the whole instance rather than unloading
 * from it -- a name that stands for more than one furnish, and an unload that
 * fails. `releaseCatalogKernels` in `kernel-registry` has the reasoning for
 * both. It throws if even the rebuild fails, which fails the scene load: the
 * caller closes the loading bar and the error surfaces, rather than a scene
 * building on a kernel set nobody can describe.
 *
 * The cost of the ordinary path is that switching demos back and forth
 * re-furnishes each time rather than finding everything already loaded. The
 * browser's HTTP cache covers the fetch but not the CSPICE load, so this is a
 * real second or two on a large catalog -- paid for answers that belong to the
 * scene on screen.
 */
async function releaseCatalogKernels(): Promise<void> {
  const s = spice;
  if (!s) {
    // Nothing is furnished, so nothing can be registered either; a release
    // before the first `ensureSpice` is the drop path arriving early.
    kernels.releaseCatalog();
    return;
  }

  const { released, failed, collided, rebuilt } = await releaseFromRegistry(kernels, {
    unload: (name) => s.unload(name),
    rebuild: refurnishOnFreshSpice,
  });

  if (rebuilt) {
    const why = collided.length > 0
      ? `${collided.join(', ')} named more than one furnished kernel`
      : `${failed.join(', ')} would not unload`;
    console.warn(`[Cosmolabe] Rebuilt SPICE: ${why}`);
  }
  setKernelCount(spice?.totalLoaded() ?? 0);
}

/**
 * Throw away the SPICE instance and furnish `keep` into a fresh one.
 *
 * The recovery half of a failed unload. A new instance is the only way to be
 * sure of what is furnished once CSPICE has refused to unload something: it
 * starts empty, and what goes back into it is exactly the registry's surviving
 * entries, in their order.
 *
 * Returns the ones that made it. A dropped file the user has since moved cannot
 * be re-read, and reporting it back is what lets the registry forget it rather
 * than promise the workers a kernel the main thread does not have.
 *
 * The entries come back unchanged, coverage included: same bytes, same
 * coverage, so there is nothing to re-measure.
 *
 * The scene on screen keeps the old instance until `initScene` replaces it --
 * this only ever runs at the top of a scene load, so that is a moment away, and
 * an old instance nothing new points at is collected with its heap.
 */
async function refurnishOnFreshSpice(
  keep: readonly FurnishedKernel[],
): Promise<readonly FurnishedKernel[]> {
  spice = null;
  const s = await ensureSpice();

  const refurnished: FurnishedKernel[] = [];
  for (const entry of keep) {
    try {
      const data = 'url' in entry.source
        ? await fetchWithProgress(entry.source.url)
        : await entry.source.file.arrayBuffer();
      await s.furnish({ type: 'buffer', data, filename: entry.name });
      refurnished.push(entry);
    } catch (err) {
      console.warn(`[Cosmolabe] Could not restore ${entry.name} after rebuild:`, err);
    }
  }
  return refurnished;
}

// ── Fetch with progress + gzip decompression ──

async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const isGz = url.endsWith('.gz');

  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onprogress = (e) => onProgress?.(e.loaded, e.lengthComputable ? e.total : 0);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as ArrayBuffer);
      else reject(new Error(`Fetch failed: ${url} (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error(`Network error: ${url}`));
    xhr.send();
  });

  if (!isGz) return buffer;

  // Check gzip magic bytes — if the server already decompressed, skip
  const header = new Uint8Array(buffer, 0, 2);
  if (header[0] !== 0x1f || header[1] !== 0x8b) return buffer;

  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array(buffer));
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

// ── Kernel pipeline ──

async function ensureSpice(): Promise<HeritageSpice> {
  if (!spice) {
    setLoadingState({ label: 'Initializing SPICE...' });
    spice = await createHeritageSpice({ locateFile: () => cspiceWasmUrl });
  }
  return spice;
}

function isLargeKernel(k: ResolvedKernel): boolean {
  return typeof k.size === 'number' && k.size > 1_000_000;
}

/** Weight given to a kernel the catalog did not size. Only ever used to spread
 *  the loading bar across the kernel phase — never shown as a byte count. */
const NOMINAL_KERNEL_BYTES = 250_000;

/**
 * The key a kernel URL is registered under.
 *
 * Absolute, because a catalog's own `spiceKernels` are resolved against the
 * catalog URL while a meta-kernel's are resolved against the `.tm`, and the
 * already-furnished check has to see the two spellings of one file as one file.
 */
function absoluteKernelUrl(url: string): string {
  return new URL(url, location.href).href;
}

/**
 * Take `name` out of SPICE if something is furnished under it, so the caller
 * can furnish under it safely. False means it could not be, and the caller must
 * not furnish.
 *
 * A name is a slot, because the wasm build stages every kernel at
 * `/kernels/<name>`. Furnishing over an occupied slot does not add a second
 * file: it overwrites the bytes of the one that is there while CSPICE still
 * holds that file open against its old contents. Measured on two SPKs sharing a
 * basename, the newcomer's data never becomes reachable *and* the occupant's
 * own reads start failing with "beginning address greater than ending address"
 * -- a corrupted instance, from one furnish, before anything is released.
 *
 * So the occupant is unloaded first, which the same measurement shows is clean:
 * the slot then holds exactly the new kernel, and what it displaced is gone
 * honestly rather than half-readable. Later-furnish-wins is the precedence rule
 * this module is built on anyway; this is that rule holding for a whole file
 * rather than for the bodies inside it.
 *
 * It is worth saying out loud when it happens. A catalog whose kernel displaces
 * one the user dropped in is not what either of them asked for, and the only
 * other honest outcome -- leaving the drop and refusing the scene's own kernel
 * -- is worse for the scene on screen.
 */
function displaceKernelNamed(s: HeritageSpice, name: string): boolean {
  const held = kernels.findByName(name);
  if (!held) return true;

  try {
    s.unload(held.name);
  } catch (err) {
    // Furnishing over it anyway would corrupt what is there, so the caller
    // goes without rather than the scene going wrong.
    console.warn(`[Cosmolabe] Skipping ${name}: ${held.name} is furnished and would not unload:`, err);
    return false;
  }
  kernels.forget(held);
  console.warn(`[Cosmolabe] ${name} replaced the kernel already furnished under that name`);
  return true;
}

/** Furnish a single kernel URL. Handles `.gz` decompression. Registers it as the catalog's. */
async function furnishKernelUrl(url: string, opts?: { size?: number; onProgress?: (loaded: number) => void }): Promise<void> {
  if (kernels.has(absoluteKernelUrl(url))) return;
  const s = await ensureSpice();
  const name = kernelNameFromUrl(url);

  if (opts?.size && opts.size > 0) {
    // Fetched before the slot is cleared, so a fetch that fails costs nothing.
    const buffer = await fetchWithProgress(url, (loaded) => opts.onProgress?.(loaded));
    if (!displaceKernelNamed(s, name)) return;
    await s.furnish({ type: 'buffer', data: buffer, filename: name });
  } else {
    // This path fetches inside `furnish`, so the slot is cleared first and a
    // failed fetch leaves it empty -- one kernel short, which is what the
    // caller's warning already says, rather than one kernel corrupt.
    if (!displaceKernelNamed(s, name)) return;
    await s.furnish({ type: 'url', url });
  }
  kernels.register({ url: absoluteKernelUrl(url) }, 'catalog', measureCoverage(s, name));
}

/** Resolve a meta-kernel (.tm) into a list of absolute kernel URLs. */
async function expandMetaKernel(metaUrl: string): Promise<string[]> {
  const resp = await fetch(metaUrl);
  if (!resp.ok) throw new Error(`Failed to fetch meta-kernel: ${metaUrl} (${resp.status})`);
  const text = await resp.text();
  const mk = parseMetaKernel(text);
  return mk.kernels.map(k => new URL(k, metaUrl).href);
}

/** Furnish every kernel referenced by a resolved catalog graph. */
async function furnishKernelsFromGraph(graph: ResolvedCatalogGraph): Promise<void> {
  // Expand any .tm meta-kernels first so we have the complete flat list.
  const flat: ResolvedKernel[] = [];
  for (const k of graph.kernels) {
    if (kernels.has(absoluteKernelUrl(k.url))) continue;
    if (k.url.toLowerCase().endsWith('.tm')) {
      try {
        const expanded = await expandMetaKernel(k.url);
        for (const exp of expanded) flat.push({ url: exp });
      } catch (err) {
        console.warn(`[Cosmolabe] Failed to expand meta-kernel ${k.url}:`, err);
      }
    } else {
      flat.push(k);
    }
  }

  const small = flat.filter(k => !isLargeKernel(k));
  const large = flat.filter(k => isLargeKernel(k));

  // Both loops report into one `kernels` fraction, which is one slice of one bar
  // (see the load-progress notes in viewer-state). Small kernels are furnished
  // straight from a URL with no byte-level progress, so they are weighed at a
  // nominal size — enough to keep a catalog of many small kernels from looking
  // frozen at 0% while it works through them.
  const sizeOf = (k: ResolvedKernel) => k.size ?? NOMINAL_KERNEL_BYTES;
  const totalBytes = flat.reduce((s, k) => s + sizeOf(k), 0) || 1;
  let doneBytes = 0;

  for (let i = 0; i < small.length; i++) {
    const k = small[i];
    setPhaseProgress('kernels', doneBytes / totalBytes, {
      label: `Loading ${k.label ?? kernelNameFromUrl(k.url)}...`,
      detail: `${i + 1} / ${flat.length} kernels`,
    });
    try {
      await furnishKernelUrl(k.url);
    } catch (err) {
      console.warn(`[Cosmolabe] Failed to load ${k.url}:`, err);
    }
    doneBytes += sizeOf(k);
  }

  if (large.length > 0) {
    const largeTotal = large.reduce((s, k) => s + (k.size ?? 0), 0);
    let largeLoaded = 0;

    for (let i = 0; i < large.length; i++) {
      const k = large[i];
      const progress = `(${i + 1}/${large.length})`;
      setPhaseProgress('kernels', doneBytes / totalBytes, {
        label: `${progress} ${k.label ?? kernelNameFromUrl(k.url)}`,
      });
      try {
        await furnishKernelUrl(k.url, {
          size: k.size,
          onProgress: (loaded) => {
            setPhaseProgress('kernels', (doneBytes + loaded) / totalBytes, {
              // Real transferred bytes of the large set — the nominal sizes above
              // weigh the bar but are never shown as if they were measured.
              detail: `${formatBytes(largeLoaded + loaded)} / ${formatBytes(largeTotal)}`,
            });
          },
        });
      } catch (err) {
        console.warn(`[Cosmolabe] Failed to load ${k.url}:`, err);
      }
      doneBytes += sizeOf(k);
      largeLoaded += k.size ?? 0;
    }
  }

  setPhaseProgress('kernels', 1, { label: 'Building scene...', detail: '' });
  setKernelCount(spice?.totalLoaded() ?? 0);
}

// ── File handling ──

function isKernelFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return KERNEL_EXTENSIONS.has(ext);
}

async function collectFilesFromEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      (entry as FileSystemFileEntry).file(f => resolve([f]), () => resolve([]));
    });
  }
  if (entry.isDirectory) {
    const dirReader = (entry as FileSystemDirectoryEntry).createReader();
    const entries: FileSystemEntry[] = [];
    await new Promise<void>((resolve) => {
      const readBatch = () => {
        dirReader.readEntries((batch) => {
          if (batch.length === 0) { resolve(); return; }
          entries.push(...batch);
          readBatch();
        }, () => resolve());
      };
      readBatch();
    });
    const nested = await Promise.all(entries.map(e => collectFilesFromEntry(e)));
    return nested.flat();
  }
  return [];
}

async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  if (dataTransfer.items) {
    const entries: FileSystemEntry[] = [];
    for (const item of dataTransfer.items) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) {
      const nested = await Promise.all(entries.map(e => collectFilesFromEntry(e)));
      return nested.flat();
    }
  }
  return Array.from(dataTransfer.files);
}

interface LoadedFiles {
  jsonFiles: Map<string, { json: Record<string, unknown>; text: string }>;
  kernelFiles: File[];
  dataFiles: Map<string, string>;
  binaryFiles: Map<string, ArrayBuffer>;
  modelFiles: Map<string, string>;
}

async function categorizeFiles(files: File[]): Promise<LoadedFiles> {
  const jsonFiles = new Map<string, { json: Record<string, unknown>; text: string }>();
  const kernelFiles: File[] = [];
  const dataFiles = new Map<string, string>();
  const binaryFiles = new Map<string, ArrayBuffer>();
  const modelFiles = new Map<string, string>();

  for (const file of files) {
    const name = file.name.toLowerCase();
    const ext = name.slice(name.lastIndexOf('.'));
    if (name.endsWith('.json')) {
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        jsonFiles.set(file.name, { json, text });
      } catch { /* skip invalid JSON */ }
    } else if (isKernelFile(file.name)) {
      kernelFiles.push(file);
    } else if (name.endsWith('.xyzv') || name.endsWith('.xyz')) {
      const text = await file.text();
      dataFiles.set(file.name, text);
      const webkitPath = (file as any).webkitRelativePath;
      if (webkitPath) dataFiles.set(webkitPath, text);
    } else if (name.endsWith('.cheb')) {
      const buf = await file.arrayBuffer();
      const webkitPath = (file as any).webkitRelativePath;
      binaryFiles.set(file.name, buf);
      if (webkitPath) binaryFiles.set(webkitPath, buf);
    } else if (MODEL_EXTENSIONS.has(ext) || TEXTURE_EXTENSIONS.has(ext)) {
      const blobUrl = URL.createObjectURL(file);
      modelFiles.set(file.name, blobUrl);
      const webkitPath = (file as any).webkitRelativePath;
      if (webkitPath) modelFiles.set(webkitPath, blobUrl);
    }
  }
  return { jsonFiles, kernelFiles, dataFiles, binaryFiles, modelFiles };
}

function resolveCatalogOrder(
  jsonFiles: Map<string, { json: Record<string, unknown>; text: string }>,
): Record<string, unknown>[] {
  const ordered: Record<string, unknown>[] = [];
  const loaded = new Set<string>();

  function loadCatalog(name: string) {
    if (loaded.has(name)) return;
    loaded.add(name);
    const entry = jsonFiles.get(name);
    if (!entry) return;
    const requires = entry.json.require as string[] | undefined;
    if (requires) for (const dep of requires) loadCatalog(dep);
    if (entry.json.items && (entry.json.items as unknown[]).length > 0) ordered.push(entry.json);
  }

  for (const [name, entry] of jsonFiles) {
    if (entry.json.require) loadCatalog(name);
  }
  for (const [name] of jsonFiles) {
    if (!loaded.has(name)) loadCatalog(name);
  }
  return ordered;
}

// ── Scene initialization ──

function initScene(
  canvas: HTMLCanvasElement,
  catalogs: Record<string, unknown>[],
  dataFiles?: Map<string, string>,
  binaryFiles?: Map<string, ArrayBuffer>,
  modelFiles?: Map<string, string>,
) {
  // Clean up previous
  renderer?.dispose();
  universe?.dispose();

  const findInMap = <T>(map: Map<string, T>, source: string): T | undefined => {
    if (map.has(source)) return map.get(source);
    const basename = source.split('/').pop()!;
    for (const [key, value] of map) {
      if (key.endsWith(basename)) return value;
    }
    return undefined;
  };

  const resolveFile = dataFiles?.size ? (source: string) => findInMap(dataFiles, source) : undefined;
  const resolveFileBinary = binaryFiles?.size ? (source: string) => findInMap(binaryFiles, source) : undefined;

  universe = new Universe(
    spice ?? undefined,
    (resolveFile || resolveFileBinary) ? { resolveFile, resolveFileBinary } : undefined,
  );

  // Inject Cesium Ion token from VITE_CESIUM_ION_TOKEN into any `terrain` block
  // of type "cesium-ion" before the Universe parses the catalog. Keeps the
  // catalog files shareable (no token in source) — operator just sets the env
  // var in apps/viewer/.env.local once.
  const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;
  for (const json of catalogs) {
    injectCesiumIonToken(json, ionToken);
    universe.loadCatalog(json as any);
  }

  // Set initial time from catalog defaultTime. SPICE str2et needs the LSK kernel —
  // if it isn't loaded (e.g. TLE-only demos) the call throws; fall back to Date math
  // so a missing kernel doesn't silently leave the universe at J2000.
  for (const json of catalogs) {
    const dt = (json as Record<string, unknown>).defaultTime;
    if (typeof dt === 'string') {
      let et: number | undefined;
      if (spice) {
        try { et = spice.str2et(dt); } catch { /* fall through */ }
      }
      if (et === undefined) {
        // Not `new Date(dt)`: it reads an offset-less date-time as LOCAL time,
        // which made a naive `defaultTime` land the scene at a different epoch
        // for every viewer's timezone. Every catalog shipped here writes an
        // explicit "Z", so this path is only reached by author-supplied
        // catalogs — which is exactly why it should not depend on the browser.
        const fallback = etFromCalendarString(dt);
        if (!Number.isNaN(fallback)) et = fallback;
      }
      if (et !== undefined) universe.setTime(et);
      else console.warn(`[Cosmolabe] Failed to parse defaultTime "${dt}"`);
      break;
    }
  }

  // Create cache worker. Skipped in TEST_MODE: with no worker, long-duration
  // spacecraft trajectory caches build SYNCHRONOUSLY during scene init
  // (UniverseRenderer.buildCacheSync) instead of popping in async a second
  // later — so a capture is deterministic and includes every trail (e.g.
  // Cassini's), with no timing/settle race.
  cacheWorker?.dispose();
  cacheWorker = null;
  geometryWorker?.dispose();
  geometryWorker = null;
  if (!TEST_MODE && kernels.workerSources().length > 0) {
    try {
      cacheWorker = new SpiceCacheWorker(new SpiceCacheRelayWorker());
      const worker = cacheWorker;
      void currentWorkerKernels()
        .then((sources) => worker.loadKernels(sources))
        .catch((err) => {
          console.warn('[Cosmolabe] Cache worker kernel loading failed:', err);
        });
      // Lazy: nothing is spawned until a search actually runs, and the same
      // kernel list is replayed whenever the geometry worker is rebuilt after a
      // cancellation that had to terminate it.
      geometryWorker = new GeometrySearchWorker({
        createWorker: () => new SpiceCacheRelayWorker(),
        kernels: currentWorkerKernels,
        idleTimeoutMs: GEOMETRY_WORKER_IDLE_MS,
      });
    } catch (err) {
      console.warn('[Cosmolabe] Failed to create cache worker:', err);
      cacheWorker = null;
      geometryWorker = null;
    }
  }

  // Visual-regression test mode (`?test=1`): strip GPU-variant noise so
  // screenshots are stable across machines — no antialias, no bloom, no
  // starfield, DPR pinned to 1 (applied below). Never affects normal use.
  renderer = new UniverseRenderer(canvas, universe, {
    scaleFactor: 1e-6,
    showTrajectories: true,
    showLabels: true,
    showStars: !TEST_MODE,
    starFieldOptions: { catalogUrl: `${import.meta.env.BASE_URL}stars.bin` },
    trajectoryOptions: { trailDuration: 86400 * 30 },
    minBodyPixels: 0,
    antialias: !TEST_MODE,
    cacheWorker: cacheWorker ?? undefined,
    modelResolver: modelFiles?.size
      ? (source: string) => findInMap(modelFiles, source)
      : (source: string) => `./${source}`,
    bloom: { enabled: !TEST_MODE },
  });
  // DPR is pinned to 1 for capture via the browser context (Playwright
  // deviceScaleFactor: 1) — the renderer already follows window.devicePixelRatio.

  renderer.camera.position.set(0, 300, 500);
  renderer.camera.lookAt(0, 0, 0);

  // Register stock plugins
  renderer.use(new ScreenshotPlugin());
  renderer.use(new VideoRecordPlugin());
  renderer.use(new OrbitalInfoPlugin());

  // Double-click a body → fly to it + select it for the info panel.
  // Delegated to the same mutator the `gotoObject` verb drives, so the two
  // cannot drift: the pointer and the script reach one implementation.
  const r = renderer;
  r.events.on('body:dblclick', ({ bodyName }) => {
    gotoObject(bodyName, { animate: true });
    selectBody(bodyName);
  });

  // Bind reactive state
  bindRenderer(renderer, universe);
  syncBodies(universe);
  setKernelCount(spice?.totalLoaded() ?? 0);

  // Load catalog viewpoints
  const scaleFactor = 1e-6;
  for (const vpDef of universe.viewpoints) {
    let pos: { x: number; y: number; z: number };
    if (vpDef.eye) {
      pos = { x: vpDef.eye[0] * scaleFactor, y: vpDef.eye[1] * scaleFactor, z: vpDef.eye[2] * scaleFactor };
    } else if (vpDef.distance != null) {
      const dist = vpDef.distance * scaleFactor;
      // Viewpoint distance + lat/lon are a body-fixed offset from the tracked
      // body (e.g. "Jezero Overhead" should point at Jezero on Mars, not at
      // inertial coords Mars no longer faces), so it is mapped to world coords
      // through the tracked body's (or its parent's) orientation at the epoch
      // the viewpoint is for. The convention and the composition both live in
      // core's `bodyFixedOffsetToWorld` so they are tested against SPICE.
      //
      // That epoch is the viewpoint's own `time` when it names one, and
      // `defaultTime` otherwise: "Titan T-A Flyby (2004-10-26)" is a lat/lon on
      // Titan four months after defaultTime, and orienting it with Titan's
      // defaultTime attitude would aim the camera at the wrong hemisphere even
      // though the clock it seeks to is right.
      const layoutEt = vpDef.epoch ?? universe.time;
      const refBody = vpDef.center ? universe.getBody(vpDef.center) : undefined;
      // For a body that itself spins (planet, moon), use the body's own rotation.
      // For a child of a spinning body (e.g. Ingenuity → Mars), use the parent's rotation.
      const spinBody = refBody?.rotation
        ? refBody
        : refBody?.parentName ? universe.getBody(refBody.parentName) : undefined;
      const q = spinBody?.rotationAt(layoutEt);
      const sourceFrame = spinBody?.rotation?.sourceFrame;
      if (q && sourceFrame) {
        const [x, y, z] = bodyFixedOffsetToWorld(
          dist,
          vpDef.latitude ?? 0,
          vpDef.longitude ?? 0,
          q,
          sourceFrame,
        );
        pos = { x, y, z };
      } else {
        // No rotation model to orient against: fall back to treating the
        // offset as world-frame, which is what it degenerates to anyway.
        const [x, y, z] = bodyFixedOffsetToWorld(
          dist,
          vpDef.latitude ?? 0,
          vpDef.longitude ?? 0,
          [1, 0, 0, 0],
          'EclipticJ2000',
        );
        pos = { x, y, z };
      }
    } else {
      pos = { x: 0, y: 300, z: 500 };
    }

    const tgt = vpDef.target
      ? new THREE.Vector3(vpDef.target[0] * scaleFactor, vpDef.target[1] * scaleFactor, vpDef.target[2] * scaleFactor)
      : new THREE.Vector3(0, 0, 0);
    const up = vpDef.up ? new THREE.Vector3(vpDef.up[0], vpDef.up[1], vpDef.up[2]).normalize() : new THREE.Vector3(0, 1, 0);

    renderer.cameraController.addViewpoint({
      name: vpDef.name,
      position: new THREE.Vector3(pos.x, pos.y, pos.z),
      target: tgt,
      up,
      trackBody: vpDef.center,
      // Resolved by CatalogLoader (SPICE str2et, else core's calendar parse),
      // and undefined when the catalog named no time — which is what keeps a
      // timeless viewpoint from moving the clock.
      epoch: vpDef.epoch,
    });
  }
  renderer.cameraController.saveViewpoint('Default');

  // Apply default viewpoint. Also seeks the clock if that viewpoint declares a
  // `time`, which is why `catalogEt` below is read after this and not before.
  if (universe.defaultViewpoint) {
    renderer.applyNamedViewpoint(universe.defaultViewpoint, { animate: true });
  }

  // The scene graph is complete. Its models, textures and spacecraft trajectory
  // caches are not — the renderer is still fetching and computing them, and
  // `bindRenderer` above has the UI waiting on `assets:ready` before it calls the
  // scene loaded to the user (issue #19).
  setSceneLoaded(true);
  // The epoch the catalog asked for, before the clock is allowed to run.
  const catalogEt = universe.time;
  renderer.start();

  if (TEST_MODE) {
    // `start()` plays at real-time rate, so without this the captured epoch is
    // whatever the wall clock reached while the page settled — and the goldens
    // were never deterministic. At Saturn orbit insertion Cassini covers
    // 29.8 km/s, so the harness's 6 s settle window drifted the scene ~180 km;
    // raising the window to 20 s made the diff worse rather than better, which
    // is how this was found. Freeze at the catalog's epoch and restore it,
    // since a few frames have already advanced it.
    renderer.timeController.pause();
    // setTime notifies through to universe.setTime, so this is the one call.
    renderer.timeController.setTime(catalogEt);
  }

  // Expose for console-based tuning during development.
  (window as unknown as { renderer: UniverseRenderer }).renderer = renderer;

  // The script host, beside it. `cosmo` is a *binding* of the ViewerControl
  // contract, not the contract itself — an embedded app or a test holds an
  // instance from `createViewerControl()` directly, and nothing in the port
  // reaches for this global. Exposed unconditionally because driving the viewer
  // from the browser console is the point; only `runScript` below is gated.
  (window as unknown as { cosmo: ViewerControl }).cosmo = getCosmo();

  // Visual-regression capture hook (`?test=1` only). Lets the offscreen driver
  // (scripts/visual-regression.mjs) seek to a fixed epoch, apply a named
  // catalog viewpoint, render exactly one synchronous frame, and read the
  // canvas back as a PNG data URL — the same render-then-toDataURL flow
  // ScreenshotPlugin uses (safe without preserveDrawingBuffer).
  if (TEST_MODE) {
    const r = renderer;
    const u = universe;
    const hook = {
      ready: true,
      /** Flips true once the catalog's initial models, textures and trajectory
       *  caches have loaded or failed. The harness waits on this instead of
       *  sleeping a fixed settle window and hoping the textures made it
       *  (issue #19). In test mode the cache worker is skipped entirely (see
       *  above), so here that set is models and textures. */
      assetsReady: false,
      /** Populated alongside `assetsReady` — lets the harness report assets the
       *  scene is missing instead of silently photographing a thinner scene. */
      assetSummary: null as unknown,
      /** Promise form of the same signal, for a driver that would rather await. */
      whenAssetsReady: () => r.waitForInitialAssets(),
      viewpoints: () => u.viewpoints.map((v) => v.name),
      /** Seek to a UTC ISO epoch (no-op if SPICE/LSK unavailable). Routed
       *  through the TimeController rather than `universe.setTime` so its
       *  `_et` does not go stale and fight the next tick. */
      seek: (iso: string) => {
        if (!spice) return false;
        try { r.timeController.setTime(spice.str2et(iso)); return true; } catch { return false; }
      },
      /** Apply a named viewpoint, render one frame, return a PNG data URL.
       *  A viewpoint that declares a `time` seeks the clock to it first, so a
       *  golden captured at "Huygens Landing (2005-01-14)" is that landing and
       *  not whatever epoch the previous capture in the scene left behind. */
      capture: (viewpointName?: string) => {
        // Throw rather than photograph whatever the camera happened to be
        // looking at. A viewpoint name that no longer resolves — renamed in the
        // catalog, or mistyped in the harness — used to yield a confident
        // picture of the wrong thing, and the harness would baseline it.
        if (viewpointName && !r.applyNamedViewpoint(viewpointName)) {
          throw new Error(
            `[Cosmolabe] No viewpoint named ${JSON.stringify(viewpointName)}. ` +
              `This catalog defines: ${u.viewpoints.map((v) => JSON.stringify(v.name)).join(', ')}`,
          );
        }
        return captureFrameDataUrl(r.getContext());
      },
      /**
       * Run a script against the viewer, throwing on the first failing line.
       *
       * Throws for the same reason `capture` throws on an unresolved viewpoint:
       * a scene half-set-up still renders, still looks plausible, and would be
       * baselined. `forbidWait` is what a deterministic capture passes — a
       * golden that depends on a wall-clock settle is a coin flip.
       */
      runScript: async (source: string, opts?: { forbidWait?: boolean }) => {
        const program = parse(source, opts?.forbidWait ? { forbid: ['wait'] } : undefined);
        const report: ExecutionReport = await execute(program, getCosmo());
        return { ran: report.ran };
      },
    };
    (window as unknown as { __cosmolabe: unknown }).__cosmolabe = hook;
    void r.waitForInitialAssets().then((summary) => {
      hook.assetSummary = summary;
      hook.assetsReady = true;
    });
  }
}

// ── Public API for components ──

/** Load a demo catalog by name. The catalog drives kernel furnishing via `require` + `spiceKernels`. */
export async function loadDemo(canvas: HTMLCanvasElement, name: string) {
  // One bar for the whole load. It opens here and closes on `assets:ready`
  // (viewer-state), so the kernel download and the models/textures/trajectories
  // that follow it are one continuous run rather than two 0→100 passes. The
  // catalog graph is what knows the kernel byte total, so the bar sits at zero
  // for the moment it takes to fetch and then gets its phase weights.
  beginLoad(`Loading ${name}...`);

  try {
    const entryUrl = new URL(`./${name}.json`, location.href).href;
    const graph = await loadCatalogFromUrl(entryUrl);
    beginLoad(`Loading ${name}...`, {
      kernelBytes: graph.kernels.reduce((sum, k) => sum + (k.size ?? 0), 0),
    });

    // Only once the graph is in hand: a catalog that failed to fetch is not a
    // scene load, and must leave the scene on screen with its kernels intact.
    // Unconditional after that, kernels or none — a catalog with no kernels of
    // its own still replaces the scene, and would otherwise resolve what
    // geometry it has against the last catalog's.
    await releaseCatalogKernels();

    // SPICE-free path: if the catalog graph declares no kernels, skip SPICE init
    // entirely. The CatalogLoader falls through to Keplerian/analytical trajectories.
    if (graph.kernels.length > 0) {
      await ensureSpice();
      await furnishKernelsFromGraph(graph);
    }

    const dataFiles = await fetchCatalogDataFiles(graph);
    initScene(canvas, graph.catalogs.map(c => c.json as Record<string, unknown>), dataFiles);
  } catch (err) {
    // A load that dies mid-way (missing catalog, a kernel the scene can't do
    // without) must not leave the bar sitting at whatever fraction it reached.
    // Close it and let the error surface — the welcome screen comes back, which
    // is the honest end state for a scene that never built.
    endLoad();
    throw err;
  }
}

/**
 * Pre-fetch text data files referenced by trajectory specs (`.xyzv` for
 * InterpolatedStates, `.oem` for OEM). Drag-drop already populates a dataFiles
 * map; URL-loaded demos otherwise have no way to resolve relative `source:`
 * paths — CatalogLoader's resolveFile is synchronous, so anything it might be
 * asked for has to be in hand before the catalog is parsed.
 */
async function fetchCatalogDataFiles(graph: ResolvedCatalogGraph): Promise<Map<string, string> | undefined> {
  const refs: { absUrl: string; sourcePath: string }[] = [];
  for (const { url: catalogUrl, json } of graph.catalogs) {
    collectDataRefs(json as Record<string, unknown>, catalogUrl, refs);
  }
  if (refs.length === 0) return undefined;

  const files = new Map<string, string>();
  await Promise.all(refs.map(async ({ absUrl, sourcePath }) => {
    const res = await fetch(absUrl);
    if (!res.ok) {
      console.warn(`[Cosmolabe] Failed to fetch trajectory data ${absUrl}: ${res.status}`);
      return;
    }
    files.set(sourcePath, await res.text());
  }));
  return files;
}

/**
 * Walk a catalog tree and inject `cesiumIonToken` into any `terrain` block
 * whose `type` is `"cesium-ion"`. Token comes from VITE_CESIUM_ION_TOKEN.
 * If a terrain config already has its own token, leave it alone. If neither
 * is set, leave the field unset and let TerrainManager throw a clear error
 * later — that's better than silently swallowing here.
 */
function injectCesiumIonToken(node: unknown, token: string | undefined): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) injectCesiumIonToken(child, token);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.type === 'cesium-ion' && obj.cesiumIonToken == null && token) {
    obj.cesiumIonToken = token;
  }
  for (const value of Object.values(obj)) injectCesiumIonToken(value, token);
}

/** Trajectory types whose `source` is a TEXT file resolved through
 *  CatalogLoader's `resolveFile`. Kept explicit rather than matching any node
 *  with a `source` key: catalogs use `source` for other things too, and
 *  speculatively fetching those would mean spurious 404s on every load.
 *  Binary-source types (ChebyshevPoly) go through resolveFileBinary and are
 *  not pre-fetched for URL-loaded catalogs. */
const TEXT_SOURCE_TRAJECTORY_TYPES = new Set(['InterpolatedStates', 'OEM']);

function collectDataRefs(
  node: unknown,
  baseUrl: string,
  out: { absUrl: string; sourcePath: string }[],
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectDataRefs(child, baseUrl, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.type === 'string' && TEXT_SOURCE_TRAJECTORY_TYPES.has(obj.type) && typeof obj.source === 'string') {
    out.push({ absUrl: new URL(obj.source, baseUrl).href, sourcePath: obj.source });
  }
  for (const value of Object.values(obj)) collectDataRefs(value, baseUrl, out);
}

/** Handle dropped files */
export async function handleDrop(canvas: HTMLCanvasElement, dataTransfer: DataTransfer) {
  const files = await collectDroppedFiles(dataTransfer);
  await handleFileList(canvas, files);
}

/**
 * Handle file input selection.
 *
 * Whose the dropped kernels are is decided here, and it is decided by whether
 * the same drop brought a catalog.
 *
 * A drop carrying a catalog is a scene load like any other: its kernels are
 * that scene's, they are registered as the catalog's, and they go when the next
 * scene replaces this one -- with the previous catalog's released first, before
 * anything in this drop is furnished, so furnish order stays the order the
 * workers will reproduce.
 *
 * A drop with no catalog is the user adding kernels: onto an empty viewer, or
 * onto a scene already up (a CK for an attitude the catalog omitted, a newer
 * SPK). Those are registered as the user's and survive every later scene load,
 * because a file someone dragged in by hand disappearing on a catalog switch
 * they made for other reasons is not what they asked for. Clearing them means
 * reloading the page.
 */
export async function handleFileList(canvas: HTMLCanvasElement, files: File[]) {
  // Dropped kernels are already on disk — no download to weigh — so the whole
  // bar belongs to the asset phase that follows.
  beginLoad(`Processing ${files.length} file(s)...`);
  const { jsonFiles, kernelFiles, dataFiles, binaryFiles, modelFiles } = await categorizeFiles(files);

  if (jsonFiles.size === 0 && kernelFiles.length === 0) {
    endLoad();
    return;
  }

  // Resolved before the kernels are furnished, not after, because it is what
  // says whether this drop is a scene load — and a scene load releases the
  // previous catalog's kernels first. A release that cannot leave SPICE in a
  // state it can describe throws, and takes the drop down with it rather than
  // furnishing onto it; the bar has to close on the way out either way.
  const catalogs = jsonFiles.size > 0 ? resolveCatalogOrder(jsonFiles) : [];
  if (catalogs.length > 0) {
    try {
      await releaseCatalogKernels();
    } catch (err) {
      endLoad();
      throw err;
    }
  }

  if (kernelFiles.length > 0) {
    const s = await ensureSpice();
    for (let i = 0; i < kernelFiles.length; i++) {
      const file = kernelFiles[i];
      setPhaseProgress('kernels', (i + 1) / kernelFiles.length, {
        label: `Furnishing ${file.name}...`,
        detail: `${i + 1} / ${kernelFiles.length} kernels`,
      });
      const buffer = await file.arrayBuffer();
      if (!displaceKernelNamed(s, file.name)) continue;
      await s.furnish({ type: 'buffer', data: buffer, filename: file.name });
      kernels.register({ file }, catalogs.length > 0 ? 'catalog' : 'user', measureCoverage(s, file.name));
    }
    setKernelCount(s.totalLoaded());
  }

  // Only `initScene` opens the asset phase that closes the bar, so a drop that
  // furnishes kernels and nothing else has to close it here.
  if (catalogs.length === 0) {
    endLoad();
    return;
  }

  try {
    initScene(canvas, catalogs, dataFiles, binaryFiles, modelFiles);
  } catch (err) {
    endLoad();
    throw err;
  }
}

/**
 * The script host, built once.
 *
 * One instance is enough and a new one per scene would be wrong: every method
 * reads the current renderer when it is called, so this survives a catalog
 * load — which a host that had captured a renderer would not.
 */
let cosmo: ViewerControl | null = null;

export function getCosmo(): ViewerControl {
  cosmo ??= createViewerControl({ getSpice });
  return cosmo;
}

/** Get the current renderer instance */
export function getCurrentRenderer(): UniverseRenderer | null {
  return renderer;
}

/** Get the current SPICE instance */
export function getSpice(): HeritageSpice | null {
  return spice;
}

/**
 * The SPICE worker backing the scene, when there is one.
 *
 * It exists for the trajectory caches, but its SPICE instance has the same
 * kernels furnished as the main thread's — so it is also where a geometry-event
 * search runs, which is the only way a long search leaves the viewer usable.
 * Null in TEST_MODE and for a catalog with no kernels; callers fall back to the
 * main thread.
 */
export function getCacheWorker(): SpiceCacheWorker | null {
  return cacheWorker;
}

/**
 * The worker geometry-event searches run on, when there is one.
 *
 * Separate from the cache worker so a long search never delays a trajectory
 * build, and so cancelling one can take its worker down without taking the
 * scene's caches with it. Null in TEST_MODE and for a catalog with no kernels;
 * callers fall back to the main thread.
 */
export function getGeometryWorker(): GeometrySearchWorker | null {
  return geometryWorker;
}

/** Resize the renderer */
export function resize(w: number, h: number) {
  renderer?.resize(w, h);
}
