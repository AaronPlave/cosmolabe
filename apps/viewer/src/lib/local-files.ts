import { GEOGRAPHIC_LIMITS, type ResolvedCatalog, type CatalogJson } from '@cosmolabe/core';
import { readLocalJsonType } from './local-json-type';
import { LocalFileMap, resolveLocalFile, selectedFilePaths } from './local-paths';
export { rememberLocalFilePath } from './local-paths';

const KERNEL_EXTENSIONS = new Set([
  '.bsp', '.tls', '.tpc', '.tf', '.tsc', '.ti', '.ck', '.bc', '.bpc', '.spk', '.pck', '.fk', '.tm',
]);
// `.bds` is a DSK shape model. It is read for a Dsk geometry, not furnished, so
// it travels with the models rather than the kernels.
const MODEL_EXTENSIONS = new Set(['.gltf', '.glb', '.obj', '.cmod', '.3ds', '.bds']);
const TEXTURE_EXTENSIONS = new Set(['.dds', '.jpg', '.jpeg', '.png', '.bmp', '.tga']);

function isKernelFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return KERNEL_EXTENSIONS.has(ext);
}

export interface LoadedFiles {
  jsonFiles: Map<string, { json: Record<string, unknown>; text: string }>;
  kernelFiles: File[];
  dataFiles: Map<string, string>;
  binaryFiles: Map<string, ArrayBuffer>;
  modelFiles: Map<string, string>;
}

export async function categorizeFiles(files: File[], signal?: AbortSignal): Promise<LoadedFiles> {
  const { paths, hasDirectoryPaths } = selectedFilePaths(files);
  const jsonFiles = new LocalFileMap<{ json: Record<string, unknown>; text: string }>(hasDirectoryPaths);
  const kernelFiles: File[] = [];
  const dataFiles = new LocalFileMap<string>(hasDirectoryPaths);
  const binaryFiles = new LocalFileMap<ArrayBuffer>(hasDirectoryPaths);
  const modelFiles = new LocalFileMap<string>(hasDirectoryPaths);
  let vectorBytes = 0;

  for (const [index, file] of files.entries()) {
    signal?.throwIfAborted();
    const path = paths[index];
    const name = file.name.toLowerCase();
    const ext = name.slice(name.lastIndexOf('.'));
    if (name.endsWith('.geojson')) {
      if (file.size > GEOGRAPHIC_LIMITS.maxBytes || vectorBytes + file.size > 16 * 1024 * 1024) {
        console.warn(`[Cosmolabe] GeoJSON ${file.name} exceeds the source or scene byte budget`);
        continue;
      }
      vectorBytes += file.size;
      const text = await file.text();
      dataFiles.set(path, text);
    } else if (name.endsWith('.json')) {
      try {
        // Large catalogs remain supported. Classify large JSON via a bounded-memory
        // stream before reading it whole, so oversized GeoJSON never reaches JSON.parse.
        if (file.size > GEOGRAPHIC_LIMITS.maxBytes && await readLocalJsonType(file, signal) === 'FeatureCollection') {
          throw new Error('GeoJSON exceeds the 2 MiB source byte budget');
        }
        const text = await file.text();
        signal?.throwIfAborted();
        const json = JSON.parse(text);
        if (json?.type === 'FeatureCollection') {
          if (vectorBytes + file.size > 16 * 1024 * 1024) throw new Error('GeoJSON scene byte budget exceeded');
          vectorBytes += file.size;
          dataFiles.set(path, text);
          continue;
        }
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Catalog JSON must be an object');
        jsonFiles.set(path, { json, text });
      } catch (error) {
        signal?.throwIfAborted();
        console.warn(`[Cosmolabe] Cannot open JSON ${path}:`, error);
      }
    } else if (isKernelFile(file.name)) {
      kernelFiles.push(file);
    } else if (name.endsWith('.xyzv') || name.endsWith('.xyz')) {
      const text = await file.text();
      dataFiles.set(path, text);
    } else if (name.endsWith('.cheb')) {
      const buf = await file.arrayBuffer();
      binaryFiles.set(path, buf);
    } else if (MODEL_EXTENSIONS.has(ext) || TEXTURE_EXTENSIONS.has(ext)) {
      const blobUrl = URL.createObjectURL(file);
      modelFiles.set(path, blobUrl);
    }
  }
  return { jsonFiles, kernelFiles, dataFiles, binaryFiles, modelFiles };
}

export function resolveCatalogOrder(
  jsonFiles: Map<string, { json: Record<string, unknown>; text: string }>,
): ResolvedCatalog[] {
  const ordered: ResolvedCatalog[] = [];
  const loaded = new Set<string>();
  const visiting = new Set<string>();

  function loadCatalog(name: string) {
    if (loaded.has(name)) return;
    if (visiting.has(name)) throw new Error(`Local catalog require cycle: ${[...visiting, name].join(' -> ')}`);
    visiting.add(name);
    const entry = jsonFiles.get(name)!;
    const requires = entry.json.require;
    if (requires !== undefined) {
      if (!Array.isArray(requires) || !requires.every(dep => typeof dep === 'string' && dep)) throw new Error(`Invalid require list in local catalog "${name}"`);
      for (const dep of requires) {
        try { loadCatalog(resolveLocalFile(jsonFiles, dep as string, name).path); }
        catch (error) { throw new Error(`Cannot resolve require "${dep}" in "${name}": ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    visiting.delete(name);
    loaded.add(name);
    if ((entry.json.items && (entry.json.items as unknown[]).length > 0) || entry.json.geographicLayers || requires) {
      ordered.push({ url: name, json: entry.json as CatalogJson });
    }
  }

  for (const [name, entry] of jsonFiles) {
    if (entry.json.require) loadCatalog(name);
  }
  for (const [name] of jsonFiles) {
    if (!loaded.has(name)) loadCatalog(name);
  }
  return ordered;
}
