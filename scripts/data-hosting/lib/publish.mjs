// Immutable, resumable dataset publisher (issue #137).
//
// Order of operations for one build:
//   1. inventory the source directory (size + sha256 + gzip flag per file)
//   2. validate it (dataset-specific hook, e.g. layer.json / kernel headers)
//   3. refuse if the build prefix already holds a completion manifest
//   4. upload every file except the deferred ones, skipping keys that already
//      exist with the same size (an interrupted upload resumes; puts are atomic,
//      so a present key is a complete key)
//   5. upload inventory.jsonl.gz, then the deferred files (layer.json), then
//      manifest.json — the completion marker — last
// A failed run leaves an unreferenced prefix with no manifest.json; nothing
// points at it until the build id is written to datasets.json.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

const CONTENT_TYPES = {
  '.terrain': 'application/vnd.quantized-mesh',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.bsp': 'application/octet-stream',
  '.bc': 'application/octet-stream',
  '.bpc': 'application/octet-stream',
  '.gz': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.tf': 'text/plain; charset=utf-8',
  '.ti': 'text/plain; charset=utf-8',
  '.tls': 'text/plain; charset=utf-8',
  '.tpc': 'text/plain; charset=utf-8',
  '.tsc': 'text/plain; charset=utf-8',
  '.tm': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Headers stored with an object.
 *
 * `Content-Encoding: gzip` is set only for `.terrain` files that really are
 * gzip streams: the browser then inflates them transparently, which is what the
 * quantized-mesh loader expects (the Vite dev server does the same job in
 * middleware for local files). Kernels named `*.gz` are served as opaque bytes —
 * the viewer's kernel loader gunzips by magic number and must not be handed
 * pre-inflated data by surprise.
 */
export function objectMeta(relPath, gzip) {
  const dot = relPath.lastIndexOf('.');
  const ext = dot < 0 ? '' : relPath.slice(dot).toLowerCase();
  const meta = {
    contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
    cacheControl: IMMUTABLE_CACHE,
  };
  if (ext === '.terrain' && gzip) meta.contentEncoding = 'gzip';
  return meta;
}

async function* walk(dir, recursive, rel = '') {
  const entries = await readdir(join(dir, rel), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (recursive) yield* walk(dir, recursive, r);
    } else if (e.isFile()) yield r;
  }
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function isGzip(path) {
  const fh = await open(path, 'r');
  try {
    const b = Buffer.alloc(2);
    const { bytesRead } = await fh.read(b, 0, 2, 0);
    return bytesRead === 2 && b[0] === 0x1f && b[1] === 0x8b;
  } finally {
    await fh.close();
  }
}

/** Run `fn` over `items` with at most `limit` in flight; rejects on the first failure. */
export async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function withRetry(fn, { tries = 4, baseMs = 500, what = 'operation' } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries) throw new Error(`${what} failed after ${tries} attempts: ${err.message ?? err}`);
      await new Promise((r) => setTimeout(r, baseMs * 2 ** (attempt - 1)));
    }
  }
}

/** Inventory a directory: [{ path, size, sha256, gzip }], sorted by path. */
export async function buildInventory(srcDir, { recursive = true, concurrency = 16, log = () => {} } = {}) {
  const paths = [];
  for await (const p of walk(srcDir, recursive)) paths.push(p);
  const entries = new Array(paths.length);
  let done = 0;
  await mapLimit(paths, concurrency, async (p, i) => {
    const abs = join(srcDir, ...p.split('/'));
    const [st, sha256, gzip] = await Promise.all([stat(abs), sha256File(abs), isGzip(abs)]);
    entries[i] = { path: p, size: st.size, sha256, gzip };
    if (++done % 20000 === 0) log(`  inventory ${done.toLocaleString()}/${paths.length.toLocaleString()}`);
  });
  return entries;
}

export function serializeInventory(entries) {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/**
 * Publish `srcDir` under `prefix`. Returns { manifest, uploaded, skipped }.
 *
 * `validate(entries, srcDir)` may throw to stop before anything is uploaded.
 * `buildManifest(entries, inventorySha256)` returns (or resolves to) the manifest object body;
 * the publisher adds nothing to it, so kernel and terrain manifests can differ.
 * `deferred` lists relative paths uploaded after everything else (layer.json).
 */
export async function publishDirectory({
  storage, srcDir, prefix, recursive = true, deferred = [], concurrency = 16,
  validate, buildManifest, dryRun = false, stateDir, stateName = 'build', log = console.log,
}) {
  log(`Inventorying ${srcDir} …`);
  const entries = await buildInventory(srcDir, { recursive, log });
  if (!entries.length) throw new Error(`${srcDir} contains no files`);
  const totalBytes = entries.reduce((s, e) => s + e.size, 0);
  log(`  ${entries.length.toLocaleString()} files, ${(totalBytes / 1e9).toFixed(3)} GB`);
  if (validate) await validate(entries, srcDir);

  const inventoryText = serializeInventory(entries);
  const inventoryGz = gzipSync(Buffer.from(inventoryText), { level: 9 });
  const inventorySha256 = createHash('sha256').update(inventoryText).digest('hex');
  if (stateDir) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, `${stateName}.inventory.jsonl`), inventoryText);
  }
  const manifest = await buildManifest(entries, inventorySha256);
  if (dryRun) {
    log('Dry run: nothing uploaded.');
    return { manifest, uploaded: 0, skipped: 0, dryRun: true };
  }

  // A completed build is immutable. If it holds exactly this content (same
  // inventory), there is nothing to upload and the caller can go on to verify and
  // pin it — the case after a verification failure that was then fixed.
  const published = await storage.get(`${prefix}manifest.json`);
  if (published) {
    let sha;
    try { sha = JSON.parse(published.toString()).inventory?.sha256; } catch { /* treated as a mismatch */ }
    if (sha === inventorySha256) {
      log(`${prefix} is already complete with identical content; skipping upload.`);
      return { manifest: JSON.parse(published.toString()), uploaded: 0, skipped: entries.length, alreadyPublished: true };
    }
    throw new Error(`${prefix}manifest.json already exists with different content: that build is complete and immutable. Choose a new --build id.`);
  }

  const deferredSet = new Set(deferred);
  const existing = await storage.list(prefix);
  const bulk = entries.filter((e) => !deferredSet.has(e.path));
  const todo = bulk.filter((e) => existing.get(prefix + e.path) !== e.size);
  const skipped = bulk.length - todo.length;
  if (skipped) log(`Resuming: ${skipped.toLocaleString()} objects already present, ${todo.length.toLocaleString()} to upload.`);

  let done = 0;
  const started = Date.now();
  await mapLimit(todo, concurrency, async (e) => {
    const key = prefix + e.path;
    await withRetry(
      () => storage.put(key, { path: join(srcDir, ...e.path.split('/')), size: e.size }, objectMeta(e.path, e.gzip)),
      { what: `upload ${key}` },
    );
    if (++done % 2000 === 0 || done === todo.length) {
      const rate = done / ((Date.now() - started) / 1000);
      log(`  uploaded ${done.toLocaleString()}/${todo.length.toLocaleString()} (${rate.toFixed(0)}/s)`);
    }
  });

  await withRetry(
    () => storage.put(`${prefix}inventory.jsonl.gz`, { body: inventoryGz }, { contentType: 'application/octet-stream', cacheControl: IMMUTABLE_CACHE }),
    { what: 'upload inventory' },
  );
  for (const rel of deferred) {
    const e = entries.find((x) => x.path === rel);
    if (!e) continue;
    await withRetry(
      () => storage.put(prefix + rel, { path: join(srcDir, ...rel.split('/')), size: e.size }, objectMeta(rel, e.gzip)),
      { what: `upload ${rel}` },
    );
  }
  await withRetry(
    () => storage.put(`${prefix}manifest.json`, { body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
      { contentType: 'application/json', cacheControl: 'public, max-age=300' }),
    { what: 'upload manifest' },
  );
  return { manifest, uploaded: todo.length, skipped };
}

/** Pick a shallow, a middle and a deep tile path from an inventory, for verification. */
export function sampleTiles(entries) {
  const tiles = entries
    .map((e) => e.path)
    .filter((p) => /^\d+\/\d+\/\d+\.terrain$/.test(p))
    .map((p) => ({ p, z: Number(p.split('/')[0]) }))
    .sort((a, b) => a.z - b.z || (a.p < b.p ? -1 : 1));
  if (!tiles.length) return [];
  const pick = (t) => t.p;
  const maxZ = tiles[tiles.length - 1].z;
  const midZ = Math.floor(maxZ / 2);
  const first = tiles[0];
  const mid = tiles.find((t) => t.z === midZ) ?? tiles[Math.floor(tiles.length / 2)];
  const deepest = tiles.filter((t) => t.z === maxZ);
  const deep = deepest[Math.floor(deepest.length / 2)];
  return [...new Set([first, mid, deep].map(pick))];
}

export const toPosix = (p) => p.split(sep).join(posix.sep);
