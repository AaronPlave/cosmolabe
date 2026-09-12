/**
 * Web Worker for off-main-thread trajectory cache building.
 *
 * Initializes its own SPICE instance, loads kernels from URLs (browser HTTP
 * cache makes re-fetching instant), and builds trajectory caches using
 * adaptive sampling + Visvalingam-Whyatt simplification.
 *
 * Results are transferred back via Transferable Float64Arrays (zero-copy).
 *
 * The instance is @cosmolabe/frames' heritage adapter over cspice-wasm. It
 * implements the same surface timecraftjs' Spice did, verified two ways: call
 * parity at relative 1e-12 (packages/frames/src/differential.test.ts) and
 * pipeline parity at exactly zero through the core's own accumulation and
 * frame composition (packages/core/src/__tests__/pipeline-parity.test.ts).
 * This worker uses furnish, spkcov, spkpos, vnorm, the constructor and the
 * four `gf*` searches, so the swap is a one-line change in behaviour terms.
 *
 * Two jobs share the one SPICE instance: building trajectory caches, and
 * running the viewer's geometry-event searches (`geometry` messages). They
 * share it precisely so the kernels are furnished once — a GF search that
 * brought its own instance would re-fetch and re-load every kernel in the
 * catalog before it could answer.
 *
 * The `?url` import is how the WASM binary gets found: only the host's bundler
 * knows where the asset lands, so Vite hands us the emitted URL and we pass it
 * through as locateFile.
 */

import { createHeritageSpice, type HeritageSpice } from '@cosmolabe/frames';
import cspiceWasmUrl from 'cspice-wasm/wasm/cspice.wasm?url';
import { TrajectoryCache, type TrajectoryCacheConfig, type CoverageWindow } from '../TrajectoryCache.js';

let spice: HeritageSpice | null = null;

/**
 * Searches the main thread has given up on.
 *
 * CSPICE is synchronous and this worker has one thread, so a `gf*` call already
 * under way cannot be interrupted — what cancellation buys is that none of the
 * calls *after* it run. A search is usually several calls (an extremum search
 * nested inside each interval a window search found, plus a position lookup per
 * event), so dropping the queued remainder is most of the work in the cases
 * that take long enough for anyone to want to cancel.
 *
 * Bounded: ids only ever arrive from this worker's own client, but a session
 * can run any number of searches and nothing tells us when the last call of a
 * cancelled one has gone by.
 */
const cancelled = new Set<string>();
const MAX_REMEMBERED_CANCELLATIONS = 64;

/** The geometry calls a `geometry` message may name. */
type GeometryCall = 'gfdist' | 'gfsep' | 'gfoclt' | 'gfposc' | 'range';

const GEOMETRY_CALLS: readonly GeometryCall[] = ['gfdist', 'gfsep', 'gfoclt', 'gfposc', 'range'];

/** The adapter's own aberration-correction type, without importing cspice-wasm. */
type Abcorr = Parameters<HeritageSpice['spkpos']>[3];

/**
 * Runs one geometry call against the worker's SPICE instance.
 *
 * The arguments are passed through untouched, so these are the same routines
 * with the same inputs the main-thread provider would have used — the results
 * are identical because they come from the same adapter over the same kernels,
 * not because anything here re-derives them.
 *
 * `range` is the one call that is not a GF routine: GF says *when* a condition
 * held and never *how far*, so a closest-approach result gets its number from
 * one `spkpos`, measured with SPICE's own `vnorm`. J2000 only has to be a frame
 * every kernel set can chain to — a vector's magnitude does not depend on the
 * frame it is expressed in.
 */
function runGeometryCall(s: HeritageSpice, fn: GeometryCall, args: unknown[]): unknown {
  switch (fn) {
    case 'gfdist':
      return s.gfdist(...(args as Parameters<HeritageSpice['gfdist']>));
    case 'gfsep':
      return s.gfsep(...(args as Parameters<HeritageSpice['gfsep']>));
    case 'gfoclt':
      return s.gfoclt(...(args as Parameters<HeritageSpice['gfoclt']>));
    case 'gfposc':
      return s.gfposc(...(args as Parameters<HeritageSpice['gfposc']>));
    case 'range': {
      const [target, abcorr, observer, et] = args as [string, string, string, number];
      return s.vnorm(s.spkpos(target, et, 'J2000', abcorr as Abcorr, observer).position);
    }
  }
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  switch (msg.type) {
    case 'init': {
      try {
        spice = await createHeritageSpice({ locateFile: () => cspiceWasmUrl });
        (self as unknown as Worker).postMessage({ type: 'ready' });
      } catch (e) {
        (self as unknown as Worker).postMessage({
          type: 'error', id: 'init',
          message: e instanceof Error ? e.message : String(e),
        });
      }
      break;
    }

    case 'loadKernel': {
      // Either a URL to fetch, or the bytes themselves — a kernel the user
      // dropped into the viewer has no URL to fetch, and the worker's SPICE
      // has to end up with the same kernels the main thread's has or its
      // searches answer a different question.
      const { id, url, data, name } = msg as {
        id: string; url?: string; data?: ArrayBuffer; name?: string;
      };
      try {
        if (!spice) throw new Error('SPICE not initialized');

        let buffer: ArrayBuffer;
        if (data) {
          buffer = data;
        } else {
          const response = await fetch(url!);
          if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
          buffer = await response.arrayBuffer();
        }

        // Auto-detect gzip by magic bytes and decompress
        const header = new Uint8Array(buffer, 0, 2);
        if (header[0] === 0x1f && header[1] === 0x8b) {
          buffer = await decompressGzip(buffer);
        }

        // Strip .gz from filename so CSPICE can identify the kernel type from
        // the extension (.bsp, .tls, .tpc). Without this, kernels get a .gz
        // extension in the Emscripten FS and CSPICE silently ignores them.
        const filename = (name ?? url!).replace(/\.gz$/i, '');
        await spice.furnish({
          type: 'buffer',
          data: buffer,
          filename,
        });

        (self as unknown as Worker).postMessage({ type: 'kernelLoaded', id });
      } catch (e) {
        (self as unknown as Worker).postMessage({
          type: 'error', id,
          message: e instanceof Error ? e.message : String(e),
        });
      }
      break;
    }

    case 'buildCache': {
      const { id, params } = msg;
      try {
        if (!spice) throw new Error('SPICE not initialized');

        const { target, center, frame, naifId, searchStart, searchEnd, config } = params as {
          target: string;
          center: string;
          frame: string;
          naifId?: number;
          searchStart: number;
          searchEnd: number;
          config?: TrajectoryCacheConfig;
        };

        // Get coverage via spkcov if NAIF ID is available
        let coverageWindows: CoverageWindow[] | undefined;
        let effectiveStart = searchStart;
        let effectiveEnd = searchEnd;

        if (naifId != null) {
          try {
            coverageWindows = spice.spkcov(naifId);
            if (coverageWindows && coverageWindows.length > 0) {
              const MAX_CACHE_RANGE = 86400 * 365.25 * 30; // 30 years
              const covStart = coverageWindows[0].start;
              const covEnd = coverageWindows[coverageWindows.length - 1].end;
              if (covEnd - covStart <= MAX_CACHE_RANGE) {
                effectiveStart = covStart;
                effectiveEnd = covEnd;
              }
            }
          } catch { /* spkcov not available — use search range */ }
        }

        const resolver = (t: number): [number, number, number] => {
          try {
            const result = spice!.spkpos(target, t, frame, 'NONE', center);
            return [result.position[0], result.position[1], result.position[2]];
          } catch {
            return [NaN, NaN, NaN];
          }
        };

        const cache = TrajectoryCache.build(resolver, effectiveStart, effectiveEnd, {
          ...config,
          coverageWindows,
        });

        // Transfer Float64Arrays (zero-copy move, not copy)
        const timesBuffer = cache.times.buffer;
        const positionsBuffer = cache.positions.buffer;
        (self as unknown as Worker).postMessage(
          {
            type: 'cacheBuilt',
            id,
            times: cache.times,
            positions: cache.positions,
            count: cache.count,
          },
          [timesBuffer, positionsBuffer],
        );
      } catch (e) {
        (self as unknown as Worker).postMessage({
          type: 'error', id,
          message: e instanceof Error ? e.message : String(e),
        });
      }
      break;
    }

    case 'geometry': {
      const { id, search, fn, args } = msg as {
        id: string; search?: string; fn: GeometryCall; args: unknown[];
      };
      try {
        if (!spice) throw new Error('SPICE not initialized');
        if (!GEOMETRY_CALLS.includes(fn)) throw new Error(`Unknown geometry call "${fn}"`);

        // Checked here rather than only on the main thread because a call can
        // already be in the queue when the cancel is sent; the point of
        // cancelling is that it does not run.
        if (search != null && cancelled.has(search)) {
          (self as unknown as Worker).postMessage({ type: 'geometryCancelled', id });
          break;
        }

        (self as unknown as Worker).postMessage({
          type: 'geometryResult', id, value: runGeometryCall(spice, fn, args),
        });
      } catch (e) {
        (self as unknown as Worker).postMessage({
          type: 'error', id,
          message: e instanceof Error ? e.message : String(e),
        });
      }
      break;
    }

    case 'cancelGeometry': {
      const { search } = msg as { search: string };
      cancelled.add(search);
      // Oldest first, which is insertion order for a Set.
      while (cancelled.size > MAX_REMEMBERED_CANCELLATIONS) {
        cancelled.delete(cancelled.values().next().value as string);
      }
      break;
    }
  }
};

/** Decompress a gzip-compressed ArrayBuffer using DecompressionStream. */
async function decompressGzip(compressed: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array(compressed));
  writer.close();

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}
