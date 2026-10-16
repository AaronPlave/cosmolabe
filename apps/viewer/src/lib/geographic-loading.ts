import {
  GEOGRAPHIC_LIMITS, fetchGeographicText, loadGeographicLayers,
  type GeographicLayer, type GeographicLayerLoad, type ResolvedCatalog, type parseGeographicGeoJson,
} from '@cosmolabe/core';

/** One worker per source, released after success/failure/timeout/cancellation. */
export function parseGeographicInWorker(
  args: Parameters<typeof parseGeographicGeoJson>, signal?: AbortSignal,
): Promise<GeographicLayer> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/geographic.worker.ts', import.meta.url), { type: 'module' });
    const finish = (error?: unknown, layer?: GeographicLayer) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else if (layer) resolve(layer);
      else reject(new Error('GeoJSON worker returned no layer'));
    };
    const abort = () => finish(signal?.reason ?? new Error('GeoJSON import cancelled'));
    const timer = setTimeout(() => finish(new Error('GeoJSON parsing timed out')), 15_000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ layer?: GeographicLayer; error?: string }>) =>
      finish(event.data.error ? new Error(event.data.error) : undefined, event.data.layer);
    worker.onerror = () => finish(new Error('GeoJSON worker failed'));
    worker.onmessageerror = () => finish(new Error('GeoJSON worker response could not be decoded'));
    try { worker.postMessage(args); } catch (error) { finish(error); }
  });
}

export interface PreparedGeographicCatalog {
  source: string;
  loads: GeographicLayerLoad[];
}

/** The same path is used by Open local catalog and drag/drop; files are never made into blob URLs. */
export async function prepareGeographicCatalogs(
  catalogs: readonly ResolvedCatalog[], signal: AbortSignal, localFiles?: ReadonlyMap<string, string>,
  parser = parseGeographicInWorker,
): Promise<PreparedGeographicCatalog[]> {
  const prepared: PreparedGeographicCatalog[] = [];
  let remaining = 16 * 1024 * 1024;
  let layerCount = 0;
  for (const { url, json } of catalogs) {
    const loads = await loadGeographicLayers(json, {
      catalogUrl: localFiles ? undefined : url,
      catalogIdentity: url,
      sourceKind: localFiles ? 'local-file' : 'catalog', signal,
      parse: (...args) => parser(args, signal),
      readText: async (source, maxBytes, sourceSignal) => {
        if (++layerCount > 64 || remaining <= 0) throw new Error('Scene GeoJSON import budget exhausted');
        const cap = Math.min(maxBytes, remaining, GEOGRAPHIC_LIMITS.maxBytes);
        let text: string;
        if (localFiles) {
          const direct = localFiles.get(source);
          const matches = [...localFiles].filter(([path]) => path.split('/').pop() === source.split('/').pop());
          if (direct === undefined && matches.length !== 1) throw new Error(`GeoJSON local source missing or ambiguous: ${source}`);
          text = direct ?? matches[0][1];
          if (new TextEncoder().encode(text).byteLength > cap) throw new Error(`GeoJSON exceeds ${cap} bytes`);
        } else text = await fetchGeographicText(source, cap, sourceSignal);
        remaining -= new TextEncoder().encode(text).byteLength;
        return text;
      },
    });
    prepared.push({ source: url, loads });
  }
  return prepared;
}
