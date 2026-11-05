#!/usr/bin/env node
// Read-only benchmark against an existing local pyramid. Run validate-dev-data
// first; this deliberately does not hide exhaustive validation in request timing.
import { join, resolve } from 'node:path';
import { ROOT, loadDatasets } from './data-hosting/lib/datasets.mjs';
import { createDevCatalogResolver } from './data-hosting/lib/dev-catalogs.mjs';

const id = process.argv[2] ?? 'terrain/mars-terrain-fused';
const dataset = loadDatasets().datasets[id];
if (!dataset || dataset.kind !== 'terrain') throw new Error(`Expected a registered terrain dataset, got ${id}`);
const dir = resolve(ROOT, dataset.localDir);
const product = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'terrain-product.json'), 'utf8'));
const decisions = [];
const options = { datasets: { [id]: dataset }, log: message => decisions.push(message) };
const catalog = { url: dataset.catalogPrefix };
const resolver = createDevCatalogResolver(options);
const start = performance.now();
const selected = await resolver(catalog, 'benchmark.json');
const firstMs = performance.now() - start;
const cachedStart = performance.now();
await resolver(catalog, 'benchmark.json');
const cachedMs = performance.now() - cachedStart;
const localStart = performance.now();
await createDevCatalogResolver({ ...options, mode: 'local' })(catalog, 'benchmark.json');
const localMs = performance.now() - localStart;
console.log(JSON.stringify({ dataset: id, tiles: product.tileCount, firstMs, cachedMs, localMs, selected, decision: decisions[0] }, null, 2));
if (selected.url !== catalog.url || decisions[0]?.includes('local unavailable') || firstMs > 2000) {
  throw new Error('Expected validated local terrain selected within 2 seconds; run validate-dev-data.mjs first');
}
