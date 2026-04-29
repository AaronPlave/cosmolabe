/**
 * Web Worker for off-main-thread trajectory cache building.
 *
 * Initializes its own timecraftjs SPICE instance, loads kernels from URLs
 * (browser HTTP cache makes re-fetching instant), and builds trajectory
 * caches using adaptive sampling + Visvalingam-Whyatt simplification.
 *
 * Results are transferred back via Transferable Float64Arrays (zero-copy).
 */

import { Spice, type SpiceInstance } from '@cosmolabe/spice';
import { TrajectoryCache, type TrajectoryCacheConfig, type CoverageWindow } from '../TrajectoryCache.js';

let spice: SpiceInstance | null = null;

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  switch (msg.type) {
    case 'init': {
      try {
        spice = await Spice.init();
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
      const { id, url } = msg;
      try {
        if (!spice) throw new Error('SPICE not initialized');

        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        let buffer = await response.arrayBuffer();

        // Auto-detect gzip by magic bytes and decompress
        const header = new Uint8Array(buffer, 0, 2);
        if (header[0] === 0x1f && header[1] === 0x8b) {
          buffer = await decompressGzip(buffer);
        }

        // Strip .gz from filename so CSPICE can identify the kernel type from
        // the extension (.bsp, .tls, .tpc). Without this, kernels get a .gz
        // extension in the Emscripten FS and CSPICE silently ignores them.
        const filename = url.replace(/\.gz$/i, '');
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
