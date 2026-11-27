/**
 * Web Worker for virtual cube imagery (#136): fetches, decodes and resamples
 * XYZ/WMTS source tiles into registered cube tiles off the render thread.
 *
 * It owns the shared source-tile cache, so a source tile requested by several
 * cube tiles (or layers) is fetched and decoded once. Finished tiles are
 * transferred back. Hosts bundle it through a relay that imports this module
 * and register it with `setVirtualImageryWorkerFactory`.
 */
import { SourceTileCache, produceVirtualTile, type VirtualSourceDescriptor, type VirtualWorkerReply, type VirtualWorkerRequest } from '../VirtualCubeImagery.js';

let cache = new SourceTileCache();
const sources = new Map<string, VirtualSourceDescriptor>();
const jobs = new Map<number, AbortController>();
const post = (reply: VirtualWorkerReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = async (event: MessageEvent<VirtualWorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init': cache = new SourceTileCache({ maxBytes: msg.maxBytes, maxConcurrent: msg.maxConcurrent, retryFailedMs: msg.retryFailedMs }); return;
    case 'source': sources.set(msg.key, msg.source); return;
    case 'abort': jobs.get(msg.id)?.abort(); return;
    case 'retryFailed': cache.retryFailed(); return;
    case 'resetCounters': cache.resetCounters(); return;
    case 'produce': {
      const controller = new AbortController();
      jobs.set(msg.id, controller);
      try {
        const source = sources.get(msg.key);
        if (!source) throw new Error(`Unknown virtual imagery source ${msg.key}`);
        const result = await produceVirtualTile(source, msg.address, msg.date, cache, controller.signal);
        post({ type: 'tile', id: msg.id, result, stats: cache.stats }, [result.data.buffer]);
      } catch (error) {
        const aborted = (error as { name?: string })?.name === 'AbortError' || controller.signal.aborted;
        post({ type: 'error', id: msg.id, message: String((error as Error)?.message ?? error), aborted, stats: cache.stats });
      } finally {
        jobs.delete(msg.id);
      }
    }
  }
};
