import type { WMTSCapabilitiesResult } from '3d-tiles-renderer/three/plugins';
import { fetchWithRetry } from './fetchWithRetry.js';
import type { TerrainImageryConfig } from './TerrainManager.js';
import type { ImageryAddress } from './surface/CubeImagery.js';
import {
  DEFAULT_MAX_SOURCE_PIXELS, SourceBudgetError, VirtualImageryInventory, affordableMatrix, geocentricDataBounds, mercatorY, parentSourceTile, planReprojection,
  resampleYielding, sourcePixelAngle, tileMaxLevel, upsampleFromParent, virtualLevelRange, xyzSourceGrid,
  type DecodedSourceTile, type ProjectedSourceGrid, type SourceLatitudeConvention, type SourceMatrix, type VirtualLevelRange,
} from './surface/ProjectedImagery.js';

/**
 * Browser-side virtual cube imagery (#136): ordinary XYZ / TMS / WMTS tile
 * sources resampled on demand into the registered cube tiles that
 * `CubeImageryLayer` draws, with no preprocessing service. One shared source
 * tile cache deduplicates requests across overlapping cube tiles and layers;
 * decoding, reprojection and request concurrency are bounded.
 */

/**
 * A virtual source's configuration cannot work (unsupported type, projection or
 * CRS; missing layer or tile matrix set; no RESTful template; a date the URL
 * cannot carry). Unlike a network or capabilities outage, retrying cannot help.
 */
export class VirtualSourceConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'VirtualSourceConfigError'; }
}
/** A day was asked of a source whose URL cannot carry one. */
export class UndatableSourceError extends VirtualSourceConfigError {
  constructor(message: string) { super(message); this.name = 'UndatableSourceError'; }
}

export type SourceTileDecoder = (blob: Blob, signal: AbortSignal) => Promise<DecodedSourceTile>;

/** Off-thread decode to straight (unpremultiplied) RGBA8, no colour conversion. */
export async function decodeImageBlob(blob: Blob, signal: AbortSignal): Promise<DecodedSourceTile> {
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas unavailable for source tile decode');
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
  } finally { bitmap.close(); }
}

interface CacheEntry {
  url: string;
  state: 'queued' | 'loading' | 'ready' | 'failed';
  tile: DecodedSourceTile | null;
  bytes: number;
  consumers: number;
  controller: AbortController;
  lastUsed: number;
  failedAt: number;
  failures: number;
  error: unknown;
  waiters: Array<{ resolve: (tile: DecodedSourceTile) => void; reject: (error: unknown) => void }>;
}

export interface SourceTileCacheStats {
  /** Network requests started, completed bytes, cache hits, declared gaps (404/204), fully transparent
   * tiles kept as gaps, failures and abandoned requests. */
  requests: number; bytes: number; hits: number; nodata: number; transparent: number; failures: number; aborted: number;
  /** Decoded bytes resident, their budget, resident tiles, and requests in flight / waiting.
   * `decodeMs` is wall time from response body to decoded pixels, including any wait
   * for the thread that also plans and resamples tiles: a queueing figure, not codec cost. */
  residentBytes: number; maxBytes: number; tiles: number; inFlight: number; queued: number;
  evicted: number; decodeMs: number;
  /** Remembered failures (for backoff), bounded by `maxFailedEntries`; oldest are forgotten first. */
  failedEntries: number;
}

/**
 * Decoded source tiles keyed by their full request URL (which carries source,
 * matrix, tile and acquisition day), so tiles of different days or sources can
 * never be mixed. A request is shared by every cube tile that needs it and is
 * aborted only when all of them abandon it. Declared gaps (HTTP 404/204) are
 * cached as transparent; failures are remembered with backoff, never as data.
 */
export class SourceTileCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly queue: CacheEntry[] = [];
  private active = 0;
  private clock = 0;
  private counters = { requests: 0, bytes: 0, hits: 0, nodata: 0, transparent: 0, failures: 0, aborted: 0, evicted: 0, decodeMs: 0 };
  readonly maxBytes: number;
  readonly maxConcurrent: number;
  readonly maxFailedEntries: number;
  private readonly retryFailedMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly decode: SourceTileDecoder;

  constructor(options: { maxBytes?: number; maxConcurrent?: number; maxFailedEntries?: number; retryFailedMs?: number; fetchImpl?: typeof fetch; decode?: SourceTileDecoder } = {}) {
    this.maxBytes = options.maxBytes ?? 96 * 2 ** 20;
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 8));
    this.maxFailedEntries = Math.max(0, Math.floor(options.maxFailedEntries ?? 1024));
    this.retryFailedMs = options.retryFailedMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.decode = options.decode ?? decodeImageBlob;
  }

  get stats(): SourceTileCacheStats {
    let residentBytes = 0, tiles = 0, inFlight = 0, failedEntries = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'ready') { residentBytes += e.bytes; tiles++; } else if (e.state === 'loading') inFlight++; else if (e.state === 'failed') failedEntries++;
    }
    return { ...this.counters, residentBytes, maxBytes: this.maxBytes, tiles, inFlight, queued: this.queue.length, failedEntries };
  }

  resetCounters(): void { this.counters = { requests: 0, bytes: 0, hits: 0, nodata: 0, transparent: 0, failures: 0, aborted: 0, evicted: 0, decodeMs: 0 }; }

  /** Forget remembered failures so the next request retries (explicit recovery). */
  retryFailed(prefix?: string): void {
    for (const [url, e] of this.entries) if (e.state === 'failed' && (!prefix || url.startsWith(prefix))) this.entries.delete(url);
  }

  /** The decoded tile (data null for a declared gap); rejects on failure or when `signal` aborts. */
  get(url: string, signal: AbortSignal): Promise<DecodedSourceTile> {
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    let e = this.entries.get(url);
    if (e?.state === 'ready') { e.lastUsed = ++this.clock; this.counters.hits++; return Promise.resolve(e.tile!); }
    if (e?.state === 'failed') {
      const backoff = this.retryFailedMs * 2 ** Math.min(e.failures - 1, 4);
      if (performance.now() - e.failedAt < backoff) return Promise.reject(e.error);
      this.entries.delete(url); e = undefined;
    }
    if (!e) {
      e = { url, state: 'queued', tile: null, bytes: 0, consumers: 0, controller: new AbortController(), lastUsed: ++this.clock, failedAt: 0, failures: this.entries.get(url)?.failures ?? 0, error: null, waiters: [] };
      this.entries.set(url, e);
      this.queue.push(e);
    }
    const entry = e;
    entry.consumers++;
    return new Promise<DecodedSourceTile>((resolve, reject) => {
      const waiter = {
        resolve: (tile: DecodedSourceTile) => { signal.removeEventListener('abort', onAbort); resolve(tile); },
        reject: (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
      };
      const onAbort = () => {
        const i = entry.waiters.indexOf(waiter);
        if (i >= 0) entry.waiters.splice(i, 1);
        entry.consumers--;
        reject(new DOMException('Aborted', 'AbortError'));
        if (entry.consumers <= 0 && (entry.state === 'queued' || entry.state === 'loading')) {
          entry.controller.abort(); this.counters.aborted++;
          if (this.entries.get(entry.url) === entry) this.entries.delete(entry.url);
          const q = this.queue.indexOf(entry); if (q >= 0) this.queue.splice(q, 1);
        }
      };
      entry.waiters.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const e = this.queue.shift()!;
      if (e.consumers <= 0 || this.entries.get(e.url) !== e) continue;
      e.state = 'loading'; this.active++; this.counters.requests++;
      // Refill from a task, not a microtask: aborts already queued as messages run first.
      void this.load(e).finally(() => { this.active--; setTimeout(() => this.pump(), 0); });
    }
  }

  private async load(e: CacheEntry): Promise<void> {
    try {
      const response = await fetchWithRetry(e.url, { signal: e.controller.signal }, { tries: 3, fetchImpl: this.fetchImpl });
      let tile: DecodedSourceTile;
      if (response.status === 404 || response.status === 204) {
        // A declared gap: transparent, never filled from another tile or day.
        tile = { width: 0, height: 0, data: null }; this.counters.nodata++;
        await response.body?.cancel().catch(() => {});
      } else if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      } else {
        const blob = await response.blob();
        this.counters.bytes += blob.size;
        const started = performance.now();
        tile = await this.decode(blob, e.controller.signal);
        this.counters.decodeMs += performance.now() - started;
        if (!tile.data || tile.width < 1 || tile.height < 1 || tile.data.length !== tile.width * tile.height * 4) throw new Error('Malformed decoded source tile');
        // Sparse overlays (coastlines, labels, regional mosaics) serve many fully
        // transparent tiles: keep them as transparent gaps, not megabytes of zeros.
        if (fullyTransparent(tile.data)) { tile = { width: tile.width, height: tile.height, data: null }; this.counters.transparent++; }
      }
      if (this.entries.get(e.url) !== e) return;
      e.state = 'ready'; e.tile = tile; e.bytes = tile.data ? tile.data.byteLength : 64; e.lastUsed = ++this.clock;
      for (const w of e.waiters.splice(0)) w.resolve(tile);
      this.evict();
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError' || e.controller.signal.aborted) {
        for (const w of e.waiters.splice(0)) w.reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      this.counters.failures++;
      if (this.entries.get(e.url) === e) {
        e.state = 'failed'; e.failedAt = performance.now(); e.failures++; e.error = error;
        this.forgetOldFailures();
      }
      for (const w of e.waiters.splice(0)) w.reject(error);
    } finally {
      e.consumers = 0;
    }
  }

  /** Failures are remembered only for backoff; a long outage across many tiles and days must not grow without bound. */
  private forgetOldFailures(): void {
    let failed = 0;
    for (const e of this.entries.values()) if (e.state === 'failed') failed++;
    if (failed <= this.maxFailedEntries) return;
    const oldest = [...this.entries.values()].filter(e => e.state === 'failed').sort((a, b) => a.failedAt - b.failedAt);
    for (const e of oldest.slice(0, failed - this.maxFailedEntries)) this.entries.delete(e.url);
  }

  private evict(): void {
    let total = 0;
    const ready: CacheEntry[] = [];
    for (const e of this.entries.values()) if (e.state === 'ready') { total += e.bytes; ready.push(e); }
    if (total <= this.maxBytes) return;
    ready.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of ready) {
      if (total <= this.maxBytes) break;
      this.entries.delete(e.url); total -= e.bytes; this.counters.evicted++;
    }
  }
}

function fullyTransparent(data: Uint8Array | Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}

/** A `/default/YYYY-MM-DD/` REST segment (GIBS-style) that a day replaces. */
const DATED_SEGMENT = /\/default\/\d{4}-\d{2}-\d{2}\//;

export interface VirtualSourceOptions {
  tileSize: number;
  gutter: number;
  /** Terrain body radii `[a, c]`, metres, for geodetic sources on an ellipsoid. */
  ellipsoid: readonly [number, number] | null;
  /** Equatorial radius, km, for reported ground resolutions. */
  radiusKm: number;
  /** Where tiles are produced (shares the source cache). */
  executor: VirtualTileExecutor;
  /** Cap on cube levels (fixed-level comparisons). */
  maxLevel?: number;
  /** Upper bound on decoded source pixels one cube tile may read. */
  maxSourcePixels?: number;
  fetchCapabilities?: (url: string) => Promise<WMTSCapabilitiesResult>;
  onCapabilities?: (capabilities: WMTSCapabilitiesResult) => void;
}

export interface VirtualTileResult {
  data: Uint8Array;
  span: number;
  /** Source matrix read, the one the texel size asked for, distinct source tiles and their coverage. */
  matrix: string;
  wantedMatrix: string;
  sourceTiles: number;
  /** Tiles drawn from a coarser parent because theirs failed; declared gaps (transparent). */
  degradedTiles: number;
  nodataTiles: number;
  planMs: number;
  resampleMs: number;
}

export interface VirtualSourceStats {
  produced: number;
  degraded: number;
  /** Tiles that read a coarser matrix than their texel size asked for, to stay within the read budget. */
  sourceLimited: number;
  planMs: number;
  resampleMs: number;
  maxTileMs: number;
}

/** Native and offered resolution of a virtual source, never inferred beyond what the source serves. */
export interface VirtualSourceCoverage {
  kind: 'virtual';
  projection: 'geographic' | 'mercator';
  latitudeConvention: SourceLatitudeConvention;
  /** Finest source matrix identifier and its pixel size on the meridian at the equator, metres. */
  nativeMatrix: string;
  nativeMetersPerPixel: number;
  /** First source matrix with data. */
  firstMatrix: string;
  /** Cube levels offered and the face-centre texel size at the deepest. For Mercator, `maxLevel`
   * is reached only toward the data's latitude limit; `equatorMaxLevel` is the equatorial depth. */
  minLevel: number;
  maxLevel: number;
  equatorMaxLevel: number;
  cubeMetersPerPixel: number;
  /** Geocentric data bounds (null: global within the projection). */
  bounds: [number, number, number, number] | null;
}

/**
 * Serializable request-URL recipe: the template with `{z}`/`{x}`/`{y}` or
 * `{TileMatrix}`/`{TileRow}`/`{TileCol}`, the TMS row flip, and default values of
 * other WMTS dimensions. A day replaces `{Time}` or a `/default/YYYY-MM-DD/` segment.
 */
export interface UrlSpec { template: string; tms: boolean; dimensions: Record<string, string> }

export function buildTileUrl(spec: UrlSpec, matrix: SourceMatrix, col: number, row: number, date: string | undefined): string {
  const y = String(spec.tms ? matrix.rows - 1 - row : row);
  let url = spec.template;
  if (date) url = url.includes('{Time}') ? url.replaceAll('{Time}', date) : url.replace(DATED_SEGMENT, `/default/${date}/`);
  for (const [k, v] of Object.entries(spec.dimensions)) url = url.replaceAll(`{${k}}`, v);
  return url.replaceAll('{z}', matrix.id).replaceAll('{TileMatrix}', matrix.id)
    .replaceAll('{x}', String(col)).replaceAll('{TileCol}', String(col)).replaceAll('{y}', y).replaceAll('{TileRow}', y);
}

/** Everything a producer (in this thread or a worker) needs to make a source's cube tiles. Plain data. */
export interface VirtualSourceDescriptor {
  grid: ProjectedSourceGrid;
  url: UrlSpec;
  tileSize: number;
  gutter: number;
  ellipsoid: readonly [number, number] | null;
  maxSourcePixels: number;
}

/**
 * Produce one cube tile: plan, fetch (shared, deduplicated), resample. A
 * failed source tile is drawn from its true parent (counted degraded) when
 * that parent loads; otherwise the whole cube tile fails so the layer keeps the
 * resident ancestor and retries later, instead of drawing a hole as data.
 * Pure of DOM state: runs in a worker or on the main thread.
 */
export async function produceVirtualTile(source: VirtualSourceDescriptor, address: ImageryAddress, date: string | undefined, cache: SourceTileCache, outer: AbortSignal): Promise<VirtualTileResult> {
  // Abandon this tile's remaining source requests as soon as it fails or is aborted:
  // a failed tile must not keep (old-day) fetches alive with nothing waiting for them.
  const local = new AbortController();
  const forward = () => local.abort(outer.reason);
  if (outer.aborted) forward(); else outer.addEventListener('abort', forward, { once: true });
  try {
    return await produceWith(source, address, date, cache, local.signal);
  } catch (error) {
    local.abort();
    throw error;
  } finally {
    outer.removeEventListener('abort', forward);
  }
}

async function produceWith(source: VirtualSourceDescriptor, address: ImageryAddress, date: string | undefined, cache: SourceTileCache, signal: AbortSignal): Promise<VirtualTileResult> {
  const { grid, tileSize, gutter, ellipsoid, maxSourcePixels } = source;
  const url = (m: SourceMatrix, col: number, row: number) => buildTileUrl(source.url, m, col, row, date);
  const started = performance.now();
  const plan = planReprojection(grid, address, { tileSize, gutter, ellipsoid, maxSourcePixels });
  const planMs = performance.now() - started;
  const tiles = new Map<string, DecodedSourceTile>();
  let degraded = 0, nodata = 0;
  const aborted = (e: unknown) => (e as { name?: string })?.name === 'AbortError' || signal.aborted;
  await Promise.all(plan.tiles.map(async t => {
    try {
      const tile = await cache.get(url(plan.matrix, t.col, t.row), signal);
      if (!tile.data) nodata++;
      tiles.set(t.key, tile);
    } catch (error) {
      if (aborted(error)) throw error;
      // Corrupt/failed tile (not a declared gap): its true parent, up to three matrices coarser.
      let m: SourceMatrix = plan.matrix, col = t.col, row = t.row;
      for (let k = 0; k < 3; k++) {
        const parent = parentSourceTile(grid, m, col, row);
        if (!parent) break;
        try {
          let up = await cache.get(url(parent.matrix, parent.col, parent.row), signal), pm = parent.matrix;
          // Upsample one matrix at a time back down to the planned one.
          for (let level = parent.matrix.index + 1; level <= plan.matrix.index; level++) {
            const cm = grid.matrices[level];
            const cc = Math.floor(((plan.matrix.x0 + (t.col + 0.5) * plan.matrix.tileWidth * plan.matrix.dx) - cm.x0) / (cm.dx * cm.tileWidth));
            const cr = Math.floor((cm.y0 - (plan.matrix.y0 - (t.row + 0.5) * plan.matrix.tileHeight * plan.matrix.dy)) / (cm.dy * cm.tileHeight));
            up = upsampleFromParent(up, pm, cm, cc, cr); pm = cm;
          }
          tiles.set(t.key, up); degraded++;
          return;
        } catch (parentError) {
          if (aborted(parentError)) throw parentError;
          m = parent.matrix; col = parent.col; row = parent.row;
        }
      }
      throw error;
    }
  }));
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const resampleStarted = performance.now();
  const data = await resampleYielding(plan, (col, row) => tiles.get(`${plan.matrix.index}/${col}/${row}`), signal);
  const resampleMs = performance.now() - resampleStarted;
  return { data, span: plan.span, matrix: plan.matrix.id, wantedMatrix: grid.matrices[plan.wantedMatrix].id, sourceTiles: plan.tiles.length,
    degradedTiles: degraded, nodataTiles: nodata, planMs, resampleMs };
}

/** Where virtual tiles are produced: this thread, or a worker holding the shared source cache. */
export interface VirtualTileExecutor {
  produce(sourceKey: string, source: VirtualSourceDescriptor, address: ImageryAddress, date: string | undefined, signal: AbortSignal): Promise<VirtualTileResult>;
  readonly stats: SourceTileCacheStats;
  retryFailed(): void;
  resetCounters(): void;
  dispose(): void;
}

/** In-thread production (tests, hosts without a worker). Resampling then runs on the calling thread. */
export class InThreadExecutor implements VirtualTileExecutor {
  constructor(readonly cache: SourceTileCache) {}
  produce(_key: string, source: VirtualSourceDescriptor, address: ImageryAddress, date: string | undefined, signal: AbortSignal) {
    return produceVirtualTile(source, address, date, this.cache, signal);
  }
  get stats() { return this.cache.stats; }
  retryFailed() { this.cache.retryFailed(); }
  resetCounters() { this.cache.resetCounters(); }
  dispose() {}
}

/** Messages of the virtual imagery worker protocol (`workers/virtual-imagery.worker.ts`). */
export type VirtualWorkerRequest =
  | { type: 'init'; maxBytes?: number; maxConcurrent?: number; retryFailedMs?: number }
  | { type: 'source'; key: string; source: VirtualSourceDescriptor }
  | { type: 'produce'; id: number; key: string; address: ImageryAddress; date: string | undefined }
  | { type: 'abort'; id: number }
  | { type: 'retryFailed' } | { type: 'resetCounters' };
export type VirtualWorkerReply =
  | { type: 'tile'; id: number; result: VirtualTileResult; stats: SourceTileCacheStats }
  | { type: 'error'; id: number; message: string; aborted: boolean; code?: 'source-budget'; stats: SourceTileCacheStats }
  /** Unsolicited while busy, so the render thread never reads a stale idle cache. */
  | { type: 'stats'; stats: SourceTileCacheStats };

const EMPTY_STATS: SourceTileCacheStats = { requests: 0, bytes: 0, hits: 0, nodata: 0, transparent: 0, failures: 0, aborted: 0, residentBytes: 0, maxBytes: 0, tiles: 0, inFlight: 0, queued: 0, evicted: 0, decodeMs: 0, failedEntries: 0 };

/**
 * Split pool budgets exactly: worker shares sum to the configured totals, so the
 * pool never holds more bytes or concurrent requests than asked. The pool uses
 * at most one worker per allowed concurrent request.
 */
export function splitBudget(total: number, workers: number): number[] {
  const n = Math.max(1, workers), base = Math.floor(total / n), extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Production in dedicated workers: fetch, decode, plan and resample all leave
 * the render thread; finished tiles return as transferred buffers. Each worker
 * owns a source cache. A cube tile is routed by its source and its ancestor
 * three levels up, so neighbouring tiles (which share source tiles) meet the
 * same cache while distant regions and other sources resample in parallel.
 */
export class WorkerExecutor implements VirtualTileExecutor {
  private nextId = 1;
  private readonly pending = new Map<number, { worker: number; resolve: (r: VirtualTileResult) => void; reject: (e: unknown) => void }>();
  private readonly sent: Array<Set<string>>;
  private readonly last: SourceTileCacheStats[];
  private failed: Error | null = null;
  private readonly workers: Worker[];
  constructor(workers: Worker | Worker[], cache: { maxBytes?: number; maxConcurrent?: number; retryFailedMs?: number } = {}) {
    const all = Array.isArray(workers) ? [...workers] : [workers];
    if (!all.length) throw new Error('WorkerExecutor needs at least one worker');
    // The budgets are for the whole pool: split them exactly across workers, and
    // never run more workers than concurrent requests allowed (each needs one).
    const maxConcurrent = Math.max(1, Math.floor(cache.maxConcurrent ?? 8));
    for (const extra of all.splice(Math.min(all.length, maxConcurrent))) extra.terminate();
    this.workers = all;
    const n = this.workers.length;
    const concurrency = splitBudget(maxConcurrent, n), bytes = splitBudget(Math.floor(cache.maxBytes ?? 96 * 2 ** 20), n);
    this.sent = this.workers.map(() => new Set());
    this.last = this.workers.map((_, i) => ({ ...EMPTY_STATS, maxBytes: bytes[i] }));
    this.workers.forEach((worker, index) => {
      worker.onmessage = (event: MessageEvent<VirtualWorkerReply>) => {
        const reply = event.data;
        this.last[index] = reply.stats;
        if (reply.type === 'stats') return;
        const job = this.pending.get(reply.id);
        if (!job) return;
        this.pending.delete(reply.id);
        if (reply.type === 'tile') job.resolve(reply.result);
        else job.reject(reply.aborted ? new DOMException(reply.message, 'AbortError')
          : reply.code === 'source-budget' ? new SourceBudgetError(reply.message) : new Error(reply.message));
      };
      worker.onerror = (event) => {
        this.failed = new Error(`Virtual imagery worker failed: ${event.message ?? 'unknown error'}`);
        for (const job of this.pending.values()) job.reject(this.failed);
        this.pending.clear();
      };
      worker.postMessage({ type: 'init', retryFailedMs: cache.retryFailedMs, maxBytes: bytes[index], maxConcurrent: concurrency[index] } satisfies VirtualWorkerRequest);
    });
  }
  private route(key: string, address: ImageryAddress): number {
    if (this.workers.length === 1) return 0;
    const shift = Math.min(3, address.level);
    const id = `${key}|${address.face}/${address.level - shift}/${address.x >> shift}/${address.y >> shift}`;
    let hash = 2166136261;
    for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0;
    return hash % this.workers.length;
  }
  produce(key: string, source: VirtualSourceDescriptor, address: ImageryAddress, date: string | undefined, signal: AbortSignal): Promise<VirtualTileResult> {
    if (this.failed) return Promise.reject(this.failed);
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    const index = this.route(key, address), worker = this.workers[index];
    if (!this.sent[index].has(key)) { worker.postMessage({ type: 'source', key, source } satisfies VirtualWorkerRequest); this.sent[index].add(key); }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => { worker.postMessage({ type: 'abort', id } satisfies VirtualWorkerRequest); };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        worker: index,
        resolve: r => { signal.removeEventListener('abort', onAbort); resolve(r); },
        reject: e => { signal.removeEventListener('abort', onAbort); reject(e); },
      });
      worker.postMessage({ type: 'produce', id, key, address, date } satisfies VirtualWorkerRequest);
    });
  }
  /** Pool totals. */
  get stats(): SourceTileCacheStats {
    const total = { ...EMPTY_STATS };
    for (const s of this.last) for (const k of Object.keys(total) as Array<keyof SourceTileCacheStats>) total[k] += s[k];
    return total;
  }
  get size(): number { return this.workers.length; }
  retryFailed() { for (const w of this.workers) w.postMessage({ type: 'retryFailed' } satisfies VirtualWorkerRequest); }
  resetCounters() { for (const w of this.workers) w.postMessage({ type: 'resetCounters' } satisfies VirtualWorkerRequest); }
  dispose() {
    for (const job of this.pending.values()) job.reject(new DOMException('Disposed', 'AbortError'));
    this.pending.clear();
    for (const w of this.workers) w.terminate();
  }
}

let workerFactory: (() => Worker) | null = null;
/**
 * Let virtual cube imagery resample in a worker. Hosts call this once with a
 * factory for a worker that imports `@cosmolabe/three/src/workers/virtual-imagery.worker`
 * (only the host's bundler can emit it). Without one, tiles are produced in-thread.
 */
export function setVirtualImageryWorkerFactory(factory: (() => Worker) | null): void { workerFactory = factory; }
export function virtualImageryWorkerFactory(): (() => Worker) | null { return workerFactory; }

/** One configured non-cube layer, served as virtual cube tiles. */
export class VirtualCubeSource {
  grid: ProjectedSourceGrid | null = null;
  inventory: VirtualImageryInventory | null = null;
  range: VirtualLevelRange | null = null;
  /** `undefined`: time-independent; `null`: no day to show (requests nothing); otherwise the UTC day drawn. */
  date: string | null | undefined = undefined;
  readonly ready: Promise<void>;
  /** Why setup failed (capabilities outage, unsupported configuration); null while pending or ready. */
  setupError: unknown = null;
  private descriptor: VirtualSourceDescriptor | null = null;
  private generation = 0;
  private static keys = 0;
  private readonly key = `virtual-${++VirtualCubeSource.keys}`;
  private counters: VirtualSourceStats = { produced: 0, degraded: 0, sourceLimited: 0, planMs: 0, resampleMs: 0, maxTileMs: 0 };

  constructor(readonly config: TerrainImageryConfig, private readonly options: VirtualSourceOptions) {
    this.ready = this.setup().catch((error: unknown) => { this.setupError = error; throw error; });
    // Setup failure is reported through `ready` to whoever awaits it; never as an unhandled rejection.
    this.ready.catch(() => {});
  }

  /** Setup failed; a new source must be created to try again. */
  get setupFailed(): boolean { return this.setupError !== null; }

  get stats(): VirtualSourceStats { return { ...this.counters }; }

  /** Identity of the pixels currently produced: source, template and day. Part of every request URL. */
  get identity(): string { return `${this.config.type ?? 'xyz'}|${this.descriptor?.url.template ?? this.config.url}|${this.date ?? ''}`; }

  get coverage(): VirtualSourceCoverage | null {
    const { grid, range } = this;
    if (!grid || !range) return null;
    const finest = grid.matrices[grid.matrices.length - 1];
    return {
      kind: 'virtual', projection: grid.projection, latitudeConvention: grid.latitudeConvention,
      nativeMatrix: finest.id, nativeMetersPerPixel: sourcePixelAngle(grid, finest, 0) * this.options.radiusKm * 1000,
      firstMatrix: grid.matrices[grid.minMatrix].id, minLevel: range.minLevel, maxLevel: range.maxLevel, equatorMaxLevel: range.equatorMaxLevel,
      cubeMetersPerPixel: 2 / (this.options.tileSize * 2 ** range.maxLevel) * this.options.radiusKm * 1000,
      bounds: geocentricDataBounds(grid, this.options.ellipsoid),
    };
  }

  /**
   * Show another day (`null`: none). Throws when the source URL cannot carry a
   * day, so a dated layer never draws one unlabelled image under a dated name.
   */
  setDate(date: string | null | undefined): void {
    if (date && this.descriptor) assertDatable(this.descriptor.url.template, date);
    if (date !== this.date) this.generation++;
    this.date = date;
  }

  /** Request URL of one source tile for the current day. */
  tileUrl(matrix: SourceMatrix, col: number, row: number): string {
    if (!this.descriptor) throw new Error('Virtual imagery source is not ready');
    return buildTileUrl(this.descriptor.url, matrix, col, row, this.date ?? undefined);
  }

  private async setup(): Promise<void> {
    const cfg = this.config, type = cfg.type ?? 'xyz';
    const latitudeConvention: SourceLatitudeConvention = cfg.latitudeConvention ?? 'geodetic';
    let grid: ProjectedSourceGrid, url: UrlSpec;
    if (type === 'xyz' || type === 'tms' || type === 'wmts') {
      const declared = cfg.projection ?? 'EPSG:4326';
      if (declared !== 'EPSG:4326' && declared !== 'EPSG:3857') {
        throw new VirtualSourceConfigError(`Imagery projection "${declared}" cannot be resampled onto cube terrain; use EPSG:4326 or EPSG:3857`);
      }
      const projection = declared === 'EPSG:3857' ? 'mercator' : 'geographic';
      grid = xyzSourceGrid({ projection, levels: cfg.levels ?? 8, tileSize: cfg.dimension ?? 256, minZoom: cfg.minZoom, latitudeConvention, bounds: cfg.bounds ?? null });
      url = { template: cfg.url, tms: type === 'tms', dimensions: {} };
    } else if (type === 'wmts-capabilities') {
      if (!this.options.fetchCapabilities) throw new VirtualSourceConfigError('WMTS capabilities source needs a capabilities loader');
      const capabilities = await this.options.fetchCapabilities(cfg.url);
      this.options.onCapabilities?.(capabilities);
      ({ grid, url } = capabilitiesGrid(capabilities, cfg, latitudeConvention));
    } else {
      throw new VirtualSourceConfigError(`Imagery type "${type}" cannot be drawn over cube terrain; use cube, xyz, tms, wmts or wmts-capabilities`);
    }
    if (this.date) assertDatable(url.template, this.date);
    const { tileSize, gutter, ellipsoid } = this.options;
    const maxSourcePixels = this.options.maxSourcePixels ?? DEFAULT_MAX_SOURCE_PIXELS;
    this.grid = grid;
    this.descriptor = { grid, url, tileSize, gutter, ellipsoid, maxSourcePixels };
    this.range = virtualLevelRange(grid, tileSize, this.options.maxLevel);
    const planOptions = { tileSize, gutter, ellipsoid, maxSourcePixels };
    const range = this.range;
    this.inventory = new VirtualImageryInventory(range, geocentricDataBounds(grid, ellipsoid), a => affordableMatrix(grid, a, planOptions) !== null,
      a => tileMaxLevel(grid, tileSize, a, range));
  }

  /** Produce one cube tile of the current day through the configured executor. */
  async produce(address: ImageryAddress, signal: AbortSignal): Promise<VirtualTileResult> {
    await this.ready;
    if (this.date === null) throw new Error('No day to show');
    const generation = this.generation;
    const result = await this.options.executor.produce(this.key, this.descriptor!, address, this.date, signal);
    // A day change while producing retires this result; its pixels belong to the old day.
    if (generation !== this.generation) throw new DOMException('Retired', 'AbortError');
    this.counters.produced++; this.counters.planMs += result.planMs; this.counters.resampleMs += result.resampleMs;
    this.counters.maxTileMs = Math.max(this.counters.maxTileMs, result.planMs + result.resampleMs);
    if (result.degradedTiles) this.counters.degraded++;
    if (result.matrix !== result.wantedMatrix) this.counters.sourceLimited++;
    return result;
  }
}

function assertDatable(template: string, date: string): void {
  if (!template.includes('{Time}') && !DATED_SEGMENT.test(template)) {
    throw new UndatableSourceError(`the tile URL has no /default/YYYY-MM-DD/ segment or {Time} dimension, so the date ${date} cannot take effect`);
  }
}

/** Matrices and URL recipe of one capabilities layer. */
export function capabilitiesGrid(capabilities: WMTSCapabilitiesResult, cfg: TerrainImageryConfig, latitudeConvention: SourceLatitudeConvention): {
  grid: ProjectedSourceGrid; template: string; url: UrlSpec;
} {
  const layer = cfg.layer ? capabilities.layers.find(l => l.identifier === cfg.layer) : capabilities.layers[0];
  if (!layer) throw new VirtualSourceConfigError(`WMTS layer ${cfg.layer ?? '(first)'} not found`);
  const set = (cfg.tileMatrixSet ? layer.tileMatrixSets.find(t => t?.identifier === cfg.tileMatrixSet) : layer.tileMatrixSets[0]) as unknown as {
    identifier: string; supportedCRS: string;
    tileMatrices: Array<{ identifier: string; tileWidth: number; tileHeight: number; matrixWidth: number; matrixHeight: number; bounds: number[] }>;
  } | undefined;
  if (!set) throw new VirtualSourceConfigError(`WMTS tile matrix set ${cfg.tileMatrixSet ?? '(first)'} not found`);
  // Only the CRSs whose matrix extents the capabilities parser converts to degrees:
  // EPSG:3857 (metres → degrees) and geographic EPSG:4326 / CRS84. Anything else
  // (polar stereographic, other projected or planetary CRSs) is refused, never guessed.
  const crs = set.supportedCRS ?? '';
  const mercator = /:3857$/i.test(crs.trim());
  const geographic = /EPSG:{1,2}(\d+:)?4326$|CRS:?84$/i.test(crs.trim());
  if (!mercator && !geographic) {
    throw new VirtualSourceConfigError(`WMTS tile matrix set ${set.identifier} uses ${crs || 'an undeclared CRS'}; cube terrain resamples only EPSG:4326/CRS84 and EPSG:3857 matrix sets`);
  }
  const deg = 180 / Math.PI;
  // Upstream parses each matrix's extent to radians [west, south, east, north].
  const matrices: SourceMatrix[] = set.tileMatrices.map((tm, index) => {
    const [w, s, e, n] = tm.bounds.map(v => v * deg);
    const y0 = mercator ? mercatorY(Math.min(n, 89.999999)) : n, y1 = mercator ? mercatorY(Math.max(s, -89.999999)) : s;
    return { id: tm.identifier, index, cols: tm.matrixWidth, rows: tm.matrixHeight, tileWidth: tm.tileWidth, tileHeight: tm.tileHeight,
      x0: w, y0, dx: (e - w) / (tm.matrixWidth * tm.tileWidth), dy: (y0 - y1) / (tm.matrixHeight * tm.tileHeight) };
  });
  const resource = layer.resourceUrls.find(r => !r.resourceType || r.resourceType === 'tile') ?? layer.resourceUrls[0];
  if (!resource?.template) throw new VirtualSourceConfigError('WMTS layer has no RESTful tile template');
  const style = layer.styles.find(s => s.isDefault)?.identifier ?? layer.styles[0]?.identifier ?? 'default';
  const template = resource.template.replaceAll('{TileMatrixSet}', set.identifier).replaceAll('{Style}', style);
  const minZoom = Math.max(0, Math.min(matrices.length - 1, cfg.minZoom ?? 0));
  const bbox = layer.boundingBox?.bounds?.map(v => v * deg);
  const bounds = cfg.bounds ?? (bbox && (bbox[0] > -179.9 || bbox[2] < 179.9 || bbox[1] > -89.9 || bbox[3] < 89.9) ? [bbox[0], bbox[1], bbox[2], bbox[3]] as [number, number, number, number] : null);
  // Non-time dimensions take their declared default; Time stays a placeholder for the day (or its default).
  const dimensions: Record<string, string> = {};
  for (const d of layer.dimensions) if (!/^time$/i.test(d.identifier) || !template.includes(`{${d.identifier}}`)) dimensions[d.identifier] = d.defaultValue;
  const time = layer.dimensions.find(d => /^time$/i.test(d.identifier));
  const datedTemplate = time && time.identifier !== 'Time' ? template.replaceAll(`{${time.identifier}}`, '{Time}') : template;
  const url: UrlSpec = { template: datedTemplate, tms: false, dimensions };
  if (time) url.dimensions.Time = time.defaultValue; // used only when no day is given
  return { grid: { projection: mercator ? 'mercator' : 'geographic', latitudeConvention, matrices, minMatrix: minZoom, bounds }, template: datedTemplate, url };
}
