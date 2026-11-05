#!/usr/bin/env node
// Explicit local validation; no upload, credentials, or registry changes.
import { join, resolve } from 'node:path';
import { ROOT, loadDatasets } from './data-hosting/lib/datasets.mjs';
import { validateDevTerrain } from './data-hosting/lib/dev-catalogs.mjs';

const id = process.argv[2];
const dataset = loadDatasets().datasets[id];
if (!dataset || dataset.kind !== 'terrain' || process.argv.length !== 3) {
  console.error('Usage: node scripts/validate-dev-data.mjs <terrain/dataset-id>');
  process.exitCode = 1;
} else {
  try {
    const start = performance.now();
    const result = await validateDevTerrain(resolve(ROOT, dataset.localDir), join(ROOT, '.data-hosting/dev-validation'));
    console.log(`Validated ${id}: ${result.tiles.toLocaleString()} tiles in ${((performance.now() - start) / 1000).toFixed(2)} s. Restart Vite to select this immutable local build.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
