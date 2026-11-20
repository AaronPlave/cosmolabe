import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const ENTRY = 'science.json';
const FILE = /^(overview\.f32\.gz|native\/\d+\/\d+\.f32\.gz|features\/\d+\.geojson\.gz)$/;
const sha256 = data => createHash('sha256').update(data).digest('hex');

export function validateScienceRaster(entries, dir) {
  const manifest = JSON.parse(readFileSync(join(dir, ENTRY), 'utf8'));
  const { width, height, stepM } = manifest.grid ?? {};
  const { tileSize, displayStride } = manifest;
  if (manifest.format !== 'cosmolabe-south-polar-raster-1' || manifest.frame !== 'MOON_ME_DE421' ||
      ![width, height, tileSize, displayStride].every(v => Number.isSafeInteger(v) && v > 0) ||
      !Number.isFinite(stepM) || stepM <= 0 || !manifest.source?.originalSha256) {
    throw new Error('Invalid science raster registration or source lock');
  }
  const counts = new Map([['overview.f32.gz', Math.ceil(width / displayStride) * Math.ceil(height / displayStride) * 4]]);
  for (const key of manifest.nativeTiles) {
    if (!/^\d+\/\d+$/.test(key)) throw new Error(`Invalid native tile ${key}`);
    const [x, y] = key.split('/').map(Number);
    const w = Math.min(tileSize, width - x * tileSize);
    const h = Math.min(tileSize, height - y * tileSize);
    if (w <= 0 || h <= 0) throw new Error(`Native tile outside the registered grid: ${key}`);
    counts.set(`native/${key}.f32.gz`, w * h * 4);
  }
  const expected = new Set([...counts.keys(), ...Object.keys(manifest.features ?? {}).map(id => `features/${id}.geojson.gz`)]);
  if (expected.size !== Object.keys(manifest.files).length) throw new Error('Science file hashes must match the manifest inventory');
  const actual = new Set(entries.map(e => e.path));
  if (!actual.has(ENTRY) || actual.size !== expected.size + 1) throw new Error('Unexpected or missing science product files');
  for (const path of expected) {
    if (!FILE.test(path) || !actual.has(path)) throw new Error(`Invalid or missing science asset ${path}`);
    const data = readFileSync(join(dir, path));
    if (sha256(data) !== manifest.files[path]) throw new Error(`Science asset digest does not match: ${path}`);
    const size = counts.get(path);
    if (size && gunzipSync(data, { maxOutputLength: size }).length !== size) throw new Error(`Wrong science tile dimensions: ${path}`);
  }
}

export function scienceRasterManifest({ dataset, build, entries, inventorySha256, srcDir, gitCommit, now = new Date() }) {
  const raw = readFileSync(join(srcDir, ENTRY));
  const manifest = JSON.parse(raw);
  return {
    version: 1, kind: 'science-raster', name: dataset.name, build,
    revision: sha256(raw),
    createdAt: now.toISOString(),
    publisher: { tool: 'scripts/publish-data.mjs', gitCommit },
    fileCount: entries.length, tileCount: manifest.nativeTiles.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    inventory: { key: 'inventory.jsonl.gz', sha256: inventorySha256, entries: entries.length },
    sampleTiles: ['overview.f32.gz', ...manifest.nativeTiles.slice(0, 2).map(key => `native/${key}.f32.gz`)],
    source: manifest.source,
  };
}
