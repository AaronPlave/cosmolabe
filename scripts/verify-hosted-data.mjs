#!/usr/bin/env node
/**
 * Smoke-test the data a built viewer depends on, over its public URLs (issue #137).
 *
 *   node scripts/verify-hosted-data.mjs --dist apps/viewer/dist --origin https://aaronplave.com
 *
 * Reads <dist>/hosted-data.json (written by build-hosted-catalogs.mjs) and, for
 * every dataset it lists, runs the checks in data-hosting/lib/verify.mjs: manifest,
 * layer.json and sample tiles with CORS / Content-Encoding / cache headers, a plain
 * 404 for a missing object, and every kernel's size (add --deep to hash them).
 * Exits non-zero on any problem, so a deployment cannot ship pointing at missing
 * or mismatched data.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT } from './data-hosting/lib/datasets.mjs';
import { verifyBuild } from './data-hosting/lib/verify.mjs';
import { withRetry } from './data-hosting/lib/publish.mjs';

const { values: opt } = parseArgs({
  options: {
    dist: { type: 'string', default: 'apps/viewer/dist' },
    origin: { type: 'string', multiple: true },
    deep: { type: 'boolean', default: false },
  },
});

const record = JSON.parse(readFileSync(join(resolve(ROOT, opt.dist), 'hosted-data.json'), 'utf8'));
const origins = opt.origin?.length ? opt.origin : ['http://localhost:5173'];
// Retry transport errors only; status, CORS and content checks still fail normally.
const fetchPublic = (url, init) => withRetry(async () => {
  const response = await fetch(url, init);
  if (!response.ok || !response.body) return response;
  const body = await response.arrayBuffer();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}, { tries: 4, baseMs: 1000, what: `public request ${url}` });
let failed = false;
for (const [id, d] of Object.entries(record.datasets)) {
  console.log(`${id} (${d.prefix})`);
  const r = await verifyBuild({ baseUrl: record.baseUrl, prefix: d.prefix, origins, deepKernels: opt.deep, fetchImpl: fetchPublic, log: console.log });
  for (const p of r.problems) console.error(`  - ${p}`);
  if (!r.ok) failed = true;
}
if (failed) {
  console.error('verify-hosted-data: FAILED');
  process.exit(1);
}
console.log(`verify-hosted-data: ${Object.keys(record.datasets).length} dataset(s) ok`);
