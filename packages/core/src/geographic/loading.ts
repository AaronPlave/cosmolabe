import type { CatalogJson } from '../catalog/CatalogLoader.js';
import { checkGeographicText, geographicLimits, geographicObject, parseGeographicGeoJson, validateGeographicDefinition } from './import.js';
import type { GeographicLayer, GeographicLayerLoad, GeographicSource, GeographicLimits } from './model.js';

export interface GeographicLoadOptions {
  catalogUrl?: string;
  /** Non-URL identity (for example a selected local catalog filename). */
  catalogIdentity?: string;
  sourceKind?: GeographicSource['kind'];
  signal?: AbortSignal;
  limits?: Partial<GeographicLimits>;
  /** Must bound input before reading/decoding it. The default streams HTTP with a hard byte cap. */
  readText?: (source: string, maxBytes: number, signal: AbortSignal) => Promise<string>;
  /** Browser hosts can dispatch the pure parser to a disposable worker. */
  parse?: typeof parseGeographicGeoJson | ((...args: Parameters<typeof parseGeographicGeoJson>) => Promise<GeographicLayer>);
}

/** Byte cap applies to the decoded HTTP body, even with missing or misleading Content-Length. */
export async function fetchGeographicText(url: string, maxBytes: number, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`GeoJSON fetch failed: ${url} (${response.status})`);
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) {
    await response.body?.cancel();
    throw new Error(`GeoJSON exceeds ${maxBytes} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`GeoJSON response has no body: ${url}`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`GeoJSON exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

const MAX_LAYERS = 16;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

function entries(catalog: CatalogJson): unknown[] {
  if (catalog.geographicLayers === undefined) return [];
  if (!Array.isArray(catalog.geographicLayers) || catalog.geographicLayers.length > MAX_LAYERS) {
    throw new Error(`geographicLayers must be an array of at most ${MAX_LAYERS} layers`);
  }
  return catalog.geographicLayers;
}
function sourceOf(raw: unknown, catalog: CatalogJson, options: GeographicLoadOptions): GeographicSource {
  const path = geographicObject(raw) && typeof raw.source === 'string' ? raw.source : '';
  return {
    kind: options.sourceKind ?? (options.catalogUrl ? 'catalog' : 'local-file'),
    identity: options.catalogUrl && path ? new URL(path, options.catalogUrl).href : path,
    catalog: options.catalogIdentity ?? options.catalogUrl ?? catalog.name ?? 'local-catalog',
  };
}
function failure(raw: unknown, source: GeographicSource, error: unknown): GeographicLayerLoad {
  return { id: geographicObject(raw) && typeof raw.id === 'string' ? raw.id : '', source, status: 'error',
    diagnostics: [{ severity: 'error', code: 'layer-load', message: error instanceof Error ? error.message : String(error) }] };
}

/** Independent sources fail independently. Sequential reads bound peak memory; a catalog also has a total byte budget. */
export async function loadGeographicLayers(catalog: CatalogJson, options: GeographicLoadOptions = {}): Promise<GeographicLayerLoad[]> {
  const results: GeographicLayerLoad[] = [];
  let remaining = MAX_CATALOG_BYTES;
  const ids = new Set<string>();
  let rawEntries: unknown[];
  try { rawEntries = entries(catalog); }
  catch (error) { return [failure(null, sourceOf(null, catalog, options), error)]; }
  for (const raw of rawEntries) {
    options.signal?.throwIfAborted();
    let source: GeographicSource = { kind: options.sourceKind ?? 'catalog', identity: '', catalog: options.catalogUrl };
    try {
      source = sourceOf(raw, catalog, options);
      const spec = validateGeographicDefinition(raw, catalog.geographicCoordinates);
      if (ids.has(spec.id)) throw new Error(`Duplicate geographic layer id ${spec.id}`);
      ids.add(spec.id);
      if (remaining <= 0) throw new Error('GeoJSON catalog byte budget exhausted');
      const limits = geographicLimits({ ...options.limits, maxBytes: Math.min(geographicLimits(options.limits).maxBytes, remaining) });
      // A broken optional source must not keep the scene waiting indefinitely.
      const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15_000)]);
      const text = await (options.readText ?? fetchGeographicText)(source.identity, limits.maxBytes, signal);
      signal.throwIfAborted();
      remaining -= new TextEncoder().encode(text).byteLength;
      checkGeographicText(text, limits);
      const layer = await (options.parse ?? parseGeographicGeoJson)(text, spec, source, undefined, limits);
      signal.throwIfAborted();
      results.push({ id: spec.id, source, status: 'ready', layer, diagnostics: layer.diagnostics });
    } catch (error) {
      options.signal?.throwIfAborted();
      results.push(failure(raw, source, error));
    }
  }
  return results;
}

/** Synchronous companion for Universe.loadCatalog's existing preloaded-file resolver. */
export function geographicLayersFromFiles(
  catalog: CatalogJson, resolveFile?: (path: string) => string | undefined, catalogSource?: string, catalogIdentity?: string,
): GeographicLayerLoad[] {
  const options: GeographicLoadOptions = { catalogUrl: catalogSource, catalogIdentity, sourceKind: catalogSource ? 'catalog' : 'local-file' };
  let rawEntries: unknown[];
  try { rawEntries = entries(catalog); }
  catch (error) { return [failure(null, sourceOf(null, catalog, options), error)]; }
  let remaining = MAX_CATALOG_BYTES;
  const ids = new Set<string>();
  return rawEntries.map(raw => {
    let source: GeographicSource = { kind: options.sourceKind!, identity: '' };
    try {
      source = sourceOf(raw, catalog, options);
      const spec = validateGeographicDefinition(raw, catalog.geographicCoordinates);
      if (ids.has(spec.id)) throw new Error(`Duplicate geographic layer id ${spec.id}`);
      ids.add(spec.id);
      const text = resolveFile?.(source.identity) ?? resolveFile?.(spec.source);
      if (text === undefined) throw new Error(`GeoJSON source unavailable: ${source.identity}; preload via loadGeographicLayers or resolveFile`);
      if (remaining <= 0) throw new Error('GeoJSON catalog byte budget exhausted');
      const maxBytes = Math.min(remaining, geographicLimits().maxBytes);
      remaining -= new TextEncoder().encode(text).byteLength;
      const layer = parseGeographicGeoJson(text, spec, source, undefined, { maxBytes });
      return { id: spec.id, source, status: 'ready', layer, diagnostics: layer.diagnostics };
    } catch (error) { return failure(raw, source, error); }
  });
}

/** Scene-owned records. Later catalogs override IDs; replacing an owner also removes its old definitions/failures. */
export class GeographicLayerStore {
  private owners = new Map<string, readonly GeographicLayerLoad[]>();
  replaceCatalog(owner: string, loads: readonly GeographicLayerLoad[]): void {
    this.owners.delete(owner);
    this.owners.set(owner, loads);
  }
  get loads(): readonly GeographicLayerLoad[] {
    const merged = new Map<string, GeographicLayerLoad>();
    const unidentified: GeographicLayerLoad[] = [];
    for (const loads of this.owners.values()) for (const entry of loads) {
      if (entry.id) merged.set(entry.id, entry);
      else unidentified.push(entry);
    }
    return [...merged.values(), ...unidentified];
  }
  get layers(): readonly GeographicLayer[] { return this.loads.flatMap(x => x.status === 'ready' && x.layer ? [x.layer] : []); }
  get(id: string): GeographicLayer | undefined { return this.layers.find(x => x.id === id); }
  removeCatalog(owner: string): void { this.owners.delete(owner); }
  clear(): void { this.owners.clear(); }
}
