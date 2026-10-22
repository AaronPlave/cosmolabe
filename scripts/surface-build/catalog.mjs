#!/usr/bin/env node
// Offline catalog candidates. No deployment or credential access.
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { jsonFile, assert } from './plan.mjs';
import { catalogCandidate, applyCatalogCandidate } from './publication.mjs';

export async function catalogCli(args) {
  const { positionals, values: v } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries(
    ['lock', 'cache', 'receipt', 'catalog', 'catalog-rel', 'prefixes', 'candidate'].map(k => [k, { type: 'string' }])) });
  assert(positionals.length === 1 && ['prepare', 'apply', 'rollback'].includes(positionals[0]),
    'Usage: catalog.mjs prepare --lock FILE --cache DIR --receipt FILE --catalog FILE --catalog-rel PATH --prefixes FILE --candidate NEW_FILE; or apply|rollback --candidate FILE --catalog FILE');
  if (positionals[0] !== 'prepare') return applyCatalogCandidate(await jsonFile(v.candidate), v.catalog, { rollback: positionals[0] === 'rollback' });
  const candidate = await catalogCandidate(await jsonFile(v.lock), { cache: v.cache, receipt: await jsonFile(v.receipt),
    catalog: await jsonFile(v.catalog), catalogRel: v['catalog-rel'], catalogPrefixes: await jsonFile(v.prefixes) });
  await writeFile(v.candidate, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
  return { candidate: v.candidate, beforeIdentity: candidate.beforeIdentity, afterIdentity: candidate.afterIdentity, deployed: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await catalogCli(process.argv.slice(2)), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 2; }
}
