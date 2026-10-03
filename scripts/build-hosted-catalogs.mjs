#!/usr/bin/env node
/**
 * Point a built viewer's catalogs at the data host and drop hosted data from the
 * Pages artifact (issue #137).
 *
 *   node scripts/build-hosted-catalogs.mjs --dist apps/viewer/dist --base-url https://data.example.org
 *
 * Reads scripts/data-hosting/datasets.json. Only paths that resolve into a
 * dataset with a published `build` are rewritten; NASA imagery and other
 * external URLs are untouched. Without --base-url it uses $DATA_BASE_URL.
 * Fails if a catalog references a dataset with no published build, unless
 * --allow-unpublished (those references then stay local and will 404 when deployed).
 * Writes <dist>/hosted-data.json, which scripts/verify-hosted-data.mjs reads.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, loadDatasets } from './data-hosting/lib/datasets.mjs';
import { buildHostedCatalogs } from './data-hosting/lib/hosted-catalogs.mjs';

const { values: opt } = parseArgs({
  options: {
    dist: { type: 'string', default: 'apps/viewer/dist' },
    'base-url': { type: 'string' },
    'allow-unpublished': { type: 'boolean', default: false },
  },
});

const baseUrl = opt['base-url'] ?? process.env.DATA_BASE_URL;
if (!baseUrl) {
  console.error('build-hosted-catalogs: set --base-url or DATA_BASE_URL');
  process.exit(2);
}
try {
  const record = await buildHostedCatalogs({
    dist: resolve(ROOT, opt.dist),
    baseUrl,
    datasets: loadDatasets().datasets,
    strict: !opt['allow-unpublished'],
  });
  console.log(`Hosted data base: ${record.baseUrl}`);
  for (const [id, d] of Object.entries(record.datasets)) console.log(`  ${id} → ${d.prefix}`);
  console.log(`Rewrote ${record.rewritten.length} catalog file(s); pruned ${record.pruned.length} dataset(s) from ${opt.dist}.`);
} catch (err) {
  console.error(`build-hosted-catalogs: ${err.message ?? err}`);
  process.exit(1);
}
