#!/usr/bin/env node
// Explicit integration smoke; not part of offline CI. At most 2 metadata pages x 2 products.
import { writeFile } from 'node:fs/promises';
import { fetchOdeMarsMetadata } from './ode-mars-metadata.mjs';
import { validateSurfaceSources } from '../packages/core/dist/surface-plan/index.js';
const query = { mission: 'mro', instrument: 'ctx', productType: 'edr', minLat: 18.3, maxLat: 18.6, westernLon: 77.2, easternLon: 77.7 };
if (process.argv.length !== 3) throw new Error('Usage: node scripts/smoke-ode-mars.mjs CACHE-OUT.json');
const result = await fetchOdeMarsMetadata(query, { pageSize: 2, maxPages: 2 });
validateSurfaceSources(result.records.map(r => r.descriptor));
if (result.pages.length !== 2 || result.records.length !== 4 || result.records.some(r => !r.descriptor.footprint))
  throw new Error('Live bounded metadata/pagination smoke failed: ' + JSON.stringify(result.diagnostics));
await writeFile(process.argv[2], JSON.stringify({ query, pageSize: 2, maxPages: 2, pages: result.pages }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ productIds: result.records.map(r => r.descriptor.productId), diagnostics: result.diagnostics, cache: process.argv[2] }, null, 2) + '\n');
