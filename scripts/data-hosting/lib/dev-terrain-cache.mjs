// Receipts for explicitly validated, immutable local quantized-mesh products.
// Request-time checks visit directories and manifest/header samples, never all
// tile bodies. In-place pipeline edits require revalidation (or local-only mode).
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mapLimit, sampleTiles } from './publish.mjs';
import { validateTerrain } from './terrain.mjs';

const VERSION = 1;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const signature = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs];
const safePath = p => typeof p === 'string' && (p === '' || !p.split('/').some(s => !s || s === '.' || s === '..' || s.includes('\\')));

async function location(dir, cacheDir) {
  const source = await realpath(dir);
  return { source, file: join(cacheDir, `${digest(source)}.json`) };
}

export async function directorySignature(path) {
  const s = await stat(path);
  if (!s.isDirectory()) throw new Error(`${path} is not a directory`);
  return signature(s);
}

async function snapshot(source, directories, samples) {
  const dirs = new Array(directories.length);
  await mapLimit(directories, 32, async (p, i) => {
    dirs[i] = [p, await directorySignature(join(source, p))];
  });
  const files = await Promise.all(samples.map(async p => [p, digest(await readFile(join(source, p)))]));
  return { dirs, files };
}

export async function invalidateTerrainValidation(dir, cacheDir) {
  const { file } = await location(dir, cacheDir);
  await rm(file, { force: true });
}

/** Called by the explicit validator, after its exhaustive inventory. */
export async function saveTerrainValidation(dir, cacheDir, entries, directories, before) {
  const { source, file } = await location(dir, cacheDir);
  validateTerrain(entries, source);
  const samples = ['layer.json', 'terrain-product.json', ...sampleTiles(entries)];
  const after = await snapshot(source, directories, samples);
  if (JSON.stringify(before.dirs) !== JSON.stringify(after.dirs) || JSON.stringify(before.files) !== JSON.stringify(after.files)) {
    throw new Error('terrain changed during validation; stop generation and retry');
  }
  await mkdir(cacheDir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ version: VERSION, source, ...after }));
  await rename(temp, file);
}

export async function terrainValidationSnapshot(dir, directories, entries) {
  return snapshot(await realpath(dir), directories, ['layer.json', 'terrain-product.json', ...sampleTiles(entries)]);
}

/** Validate the receipt's product revision and directory structure cheaply.
 * Directory signatures detect additions/deletions/replacements; file hashes
 * detect manifest and sampled-header edits. This is an immutable-build cache,
 * not a watcher or a substitute for validating arbitrary in-place tile edits. */
export async function checkTerrainValidation(dir, cacheDir) {
  const { source, file } = await location(dir, cacheDir);
  let receipt;
  try { receipt = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('no validation receipt; run node scripts/validate-dev-data.mjs <dataset-id>'); }
  if (receipt.version !== VERSION || receipt.source !== source || !Array.isArray(receipt.dirs) || !receipt.dirs.length
    || !Array.isArray(receipt.files) || !receipt.files.length
    || !receipt.dirs.every(([p]) => safePath(p)) || !receipt.files.every(([p]) => p && safePath(p))) {
    throw new Error('invalid terrain validation receipt; revalidate the local product');
  }
  const current = await snapshot(source, receipt.dirs.map(([p]) => p), receipt.files.map(([p]) => p));
  if (JSON.stringify(current) !== JSON.stringify({ dirs: receipt.dirs, files: receipt.files })) {
    throw new Error('local terrain changed since validation; run node scripts/validate-dev-data.mjs <dataset-id>');
  }
}
