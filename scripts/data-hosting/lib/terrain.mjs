// Terrain-pyramid validation and manifest for the publisher (issue #137).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { sampleTiles } from './publish.mjs';

const QM_HEADER_BYTES = 88; // quantized-mesh-1.0 fixed header

export function validateTerrain(entries, srcDir) {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const layerEntry = byPath.get('layer.json');
  if (!layerEntry) throw new Error('terrain source has no layer.json');
  const layer = JSON.parse(readFileSync(join(srcDir, 'layer.json'), 'utf8'));
  if (layer.format !== 'quantized-mesh-1.0') throw new Error(`layer.json format is ${JSON.stringify(layer.format)}, expected quantized-mesh-1.0`);
  if (!Array.isArray(layer.tiles) || !layer.tiles.length) throw new Error('layer.json has no tiles template');
  if (layer.tiles.some((t) => /^[a-z]+:|^\//i.test(t))) {
    throw new Error('layer.json tiles template must be relative so the pyramid is relocatable');
  }
  const tiles = entries.filter((e) => e.path.endsWith('.terrain'));
  if (!tiles.length) throw new Error('terrain source has no .terrain tiles');
  const bad = tiles.filter((t) => !/^\d+\/\d+\/\d+\.terrain$/.test(t.path));
  if (bad.length) throw new Error(`unexpected tile path ${bad[0].path} (expected <z>/<x>/<y>.terrain)`);

  const gz = tiles.filter((t) => t.gzip).length;
  if (gz !== 0 && gz !== tiles.length) {
    throw new Error(`mixed tile encodings: ${gz} gzip and ${tiles.length - gz} raw; a pyramid must be uniform`);
  }
  // Every tile counted in the product description must be present.
  const productEntry = byPath.get('terrain-product.json');
  if (productEntry) {
    const product = JSON.parse(readFileSync(join(srcDir, 'terrain-product.json'), 'utf8'));
    if (typeof product.tileCount === 'number' && product.tileCount !== tiles.length) {
      throw new Error(`terrain-product.json lists ${product.tileCount} tiles but ${tiles.length} .terrain files are present`);
    }
  }
  for (const p of sampleTiles(entries)) {
    let buf = readFileSync(join(srcDir, ...p.split('/')));
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
    if (buf.length < QM_HEADER_BYTES) throw new Error(`${p} is ${buf.length} bytes after decoding; too short for a quantized-mesh tile`);
  }
}

export function terrainManifest({ dataset, build, entries, inventorySha256, srcDir, gitCommit, now = new Date() }) {
  let product;
  try { product = JSON.parse(readFileSync(join(srcDir, 'terrain-product.json'), 'utf8')); } catch { /* optional */ }
  const tiles = entries.filter((e) => e.path.endsWith('.terrain'));
  return {
    version: 1,
    kind: 'terrain',
    name: dataset.name,
    build,
    createdAt: now.toISOString(),
    publisher: { tool: 'scripts/publish-data.mjs', gitCommit },
    fileCount: entries.length,
    tileCount: tiles.length,
    totalBytes: entries.reduce((s, e) => s + e.size, 0),
    tileEncoding: tiles.some((t) => t.gzip) ? 'gzip' : 'identity',
    inventory: { key: 'inventory.jsonl.gz', sha256: inventorySha256, entries: entries.length },
    sampleTiles: sampleTiles(entries),
    // Source provenance and build parameters, copied from the generator's own record.
    product: product && {
      generator: product.generator,
      created: product.created,
      sources: product.sources,
      mesh: product.mesh,
      levels: product.levels,
      verticalDatum: product.verticalDatum,
    },
  };
}
