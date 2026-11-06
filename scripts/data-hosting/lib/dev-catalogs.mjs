// Development-only source selection. Catalogs keep their checked-in URLs;
// the deployment rewriter remains the authority for managed URL resolution.
import { readdir, readFile, stat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ROOT, remotePrefix, joinUrl } from './datasets.mjs';
import { matchDataset, resolveLocalPath, rewriteCatalog } from './hosted-catalogs.mjs';
import { validateCubeTerrain, validateCubeImagery } from './cube.mjs';
import { validateTerrain } from './terrain.mjs';
import { validateKernelHeader } from './kernels.mjs';
import { directorySignature, invalidateTerrainValidation, checkTerrainValidation, saveTerrainValidation, terrainValidationSnapshot } from './dev-terrain-cache.mjs';

export const DEFAULT_DEV_DATA_BASE_URL = 'https://data.aaronplave.com';

// Bound both directory traversal and per-file metadata/header work. Never hash
// tiles or read their bodies; quantized-mesh encoding needs only two bytes.
const INVENTORY_CONCURRENCY = 32;
const INLINE_TERRAIN_LIMIT = 4096;
async function inventory(dir, recursive = true, terrain = false, limit = Infinity, captureDirectories = false) {
  const entries = [];
  const directories = [''];
  const signatures = new Map();
  for (let offset = 0; offset < directories.length;) {
    const batch = directories.slice(offset, offset + INVENTORY_CONCURRENCY);
    offset += batch.length;
    await Promise.all(batch.map(async (rel) => {
      if (captureDirectories) signatures.set(rel, await directorySignature(join(dir, rel)));
      for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory() && recursive) directories.push(p);
        else if (e.isFile()) {
          entries.push({ path: p });
          if (entries.length > limit) throw new Error('large terrain needs validation; run node scripts/validate-dev-data.mjs <dataset-id>');
        }
      }
    }));
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(INVENTORY_CONCURRENCY, entries.length) }, async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      const path = join(dir, entry.path);
      if (terrain && entry.path.endsWith('.terrain')) {
        const file = await open(path, 'r');
        try {
          const header = Buffer.alloc(2);
          const { bytesRead } = await file.read(header, 0, 2, 0);
          entry.gzip = bytesRead === 2 && header[0] === 0x1f && header[1] === 0x8b;
        } finally { await file.close(); }
      } else {
        // Cube height grids need exact sizes. Quantized-mesh validation needs
        // only tile paths/encoding plus its decoded header samples.
        entry.size = (await stat(path)).size;
      }
    }
  }));
  return { entries, directories, initialDirectories: directories.map(p => [p, signatures.get(p)]) };
}

/** Exhaustive encoding/completeness validation, deliberately outside Vite requests. */
export async function validateDevTerrain(dir, cacheDir) {
  // Revalidation must revoke an old receipt even if inventory itself fails.
  await invalidateTerrainValidation(dir, cacheDir);
  const { entries, directories, initialDirectories } = await inventory(dir, true, true, Infinity, true);
  const before = await terrainValidationSnapshot(dir, directories, entries);
  if (JSON.stringify(initialDirectories) !== JSON.stringify(before.dirs)) throw new Error('terrain changed during inventory; stop generation and retry');
  const product = JSON.parse(await readFile(join(dir, 'terrain-product.json'), 'utf8'));
  if (!Number.isInteger(product.tileCount) || product.tileCount <= 0) throw new Error('terrain-product.json needs a positive tileCount');
  await saveTerrainValidation(dir, cacheDir, entries, directories, before);
  return { tiles: product.tileCount, directories: directories.length };
}

function references(json, catalogRel, datasets, found = new Map()) {
  if (typeof json === 'string') {
    const local = resolveLocalPath(json, catalogRel);
    const match = local && matchDataset(local, datasets);
    if (match) {
      if (!found.has(match.id)) found.set(match.id, new Set());
      found.get(match.id).add(match.rest);
    }
  } else if (json && typeof json === 'object') {
    for (const v of Object.values(json)) references(v, catalogRel, datasets, found);
  }
  return found;
}

/** One resolver per dev server; product decisions last until server restart. */
export function createDevCatalogResolver({
  datasets, root = ROOT, baseUrl = DEFAULT_DEV_DATA_BASE_URL, mode = 'auto', log = console.info,
  cacheDir = join(root, '.data-hosting/dev-validation'), hostedBaseUrl = baseUrl,
}) {
  if (!['auto', 'local'].includes(mode)) throw new Error('DEV_DATA_MODE must be auto or local');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('DATA_BASE_URL must be an absolute http(s) URL');
  const checks = new Map();
  const messages = new Set();
  const report = (message) => {
    if (!messages.has(message)) { messages.add(message); log(`[dev-data] ${message}`); }
  };

  async function check(ds, paths) {
    const dir = resolve(root, ds.localDir);
    try {
      if (ds.kind === 'kernels') {
        // A kernel set has no generated product manifest. Check every kernel
        // referenced by this catalog together; never fall back file by file.
        for (const p of paths) await validateKernelHeader(join(dir, p));
      } else {
        if (ds.kind === 'terrain') {
          const product = JSON.parse(await readFile(join(dir, 'terrain-product.json'), 'utf8'));
          if (!Number.isInteger(product.tileCount) || product.tileCount <= 0) {
            throw new Error('terrain-product.json needs a positive tileCount to establish completeness');
          }
          if (product.tileCount > INLINE_TERRAIN_LIMIT) {
            await checkTerrainValidation(dir, cacheDir);
          } else {
            const { entries } = await inventory(dir, true, true, INLINE_TERRAIN_LIMIT + 64);
            validateTerrain(entries, dir);
          }
        } else {
          const { entries } = await inventory(dir, ds.recursive !== false);
          if (ds.kind === 'cube-terrain') validateCubeTerrain(entries, dir);
          else if (ds.kind === 'cube-imagery') validateCubeImagery(entries, dir);
          else throw new Error(`unsupported product kind ${ds.kind}`);
        }
      }
      // Also check catalog entry points, beyond the publisher's product checks.
      for (const p of paths) {
        const info = await stat(join(dir, p));
        if (p && !p.endsWith('/') && (!info.isFile() || info.size === 0)) throw new Error(`${p} is empty or not a file`);
      }
      return null;
    } catch (error) { return error.message; }
  }

  return async (json, catalogRel) => {
    const selected = { ...datasets };
    for (const [id, paths] of references(json, catalogRel, datasets)) {
      const ds = datasets[id];
      if (mode === 'local' || ds.localOnly) {
        selected[id] = { ...ds, build: null };
        const reason = mode === 'local' ? 'DEV_DATA_MODE=local' : 'local-only dataset';
        report(`${id}: local ${ds.localDir} (${reason}; completeness checks skipped)`);
        continue;
      }
      // Kernel references differ between catalogs; generated products describe
      // their complete contents in their own manifests.
      const key = `${id}:${[...paths].sort().join(',')}`;
      if (!checks.has(key)) checks.set(key, check(ds, paths));
      const problem = await checks.get(key);
      if (!problem) {
        // Keep the dataset in the matcher so nested unpublished/local sets
        // cannot accidentally be rewritten through a broader hosted prefix.
        selected[id] = { ...ds, build: null };
        report(`${id}: local ${ds.localDir}`);
      } else if (ds.build) {
        report(`${id}: hosted ${joinUrl(baseUrl, remotePrefix(ds))} (local unavailable: ${problem}). Set DEV_DATA_MODE=local to inspect local output; restart Vite after rebuilding.`);
      } else {
        const message = `${id}: local unavailable (${problem}) and no pinned hosted build. Generate/fetch ${ds.localDir}, or publish with scripts/publish-data.mjs. Local URLs retained; missing assets will return 404.`;
        report(message);
        // Keep the demo/catalog usable even when this optional local product
        // has never been published. Its missing assets retain normal 404s.
        selected[id] = { ...ds, build: null };
      }
    }
    return rewriteCatalog(json, catalogRel, selected, hostedBaseUrl).json;
  };
}
