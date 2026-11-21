#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compileBuild, inspectBindings, jsonFile } from './surface-build/plan.mjs';

const USAGE = `Usage: npm run build:surface -- LOCK.json [--bindings FILE] [--cache DIR]
  Default: validate lock and print build DAG/resources/cache status. No writes/network.
  --execute       Build a validated bounded Mars profile locally.
  --python FILE   Python with numpy and GDAL (default python3).
  --workers N     1..8, default 1.
  --publish-local Publish completed products through #137's local storage backend.
  --local-dir DIR --verify-url URL   Required for --publish-local; never pins catalogs.
  --publication-plan  Preflight completed outputs; print exact inventory/confirmation identity.
  --publish-r2    Explicit remote publish through #137 (credentials read only here).
  --confirm-publication HASH  Required exact preflight identity for --publish-r2.
  --verify-origin ORIGIN  Repeat for each viewer origin to verify over public HTTP.
  --help          Show limitations and usage.
The real profile supports pinned existing fusion, masked EQC DEMs and native raster imagery.
No automatic production upload or source download is performed.
`;
export async function runBuildCli(args) {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean' }, bindings: { type: 'string' }, cache: { type: 'string' }, execute: { type: 'boolean' },
    python: { type: 'string' }, workers: { type: 'string' }, 'publish-local': { type: 'boolean' },
    'local-dir': { type: 'string' }, 'verify-url': { type: 'string' },
    'publication-plan': { type: 'boolean' }, 'publish-r2': { type: 'boolean' }, 'confirm-publication': { type: 'string' },
    'verify-origin': { type: 'string', multiple: true },
  } });
  if (v.help) return USAGE;
  if (positionals.length !== 1 || [v.execute, v['publish-local'], v['publish-r2'], v['publication-plan']].filter(Boolean).length > 1) throw new Error(USAGE);
  const lock = await jsonFile(resolve(positionals[0]));
  const dag = await compileBuild(lock);
  const bindings = v.bindings ? await jsonFile(resolve(v.bindings)) : {};
  const bindingsDir = v.bindings ? dirname(resolve(v.bindings)) : process.cwd();
  if (v['publication-plan'] || v['publish-r2']) {
    const { publicationPlan, publishBuild } = await import('./surface-build/publication.mjs');
    const options = { cache: v.cache, baseUrl: v['verify-url'], confirm: v['confirm-publication'], origins: v['verify-origin'], log: text => process.stderr.write(text + '\n') };
    const result = v['publication-plan'] ? await publicationPlan(lock, options) : await publishBuild(lock, options);
    return JSON.stringify(result, null, 2) + '\n';
  }
  if (v.execute || v['publish-local']) {
    const { executeBuild, publishLocalFixture } = await import('./surface-build/run.mjs');
    const log = text => process.stderr.write(text.endsWith('\n') ? text : text + '\n');
    const result = v.execute ? await executeBuild(lock, { bindings, bindingsDir, cache: v.cache, python: v.python,
      workers: v.workers ? Number(v.workers) : 1, log }) : await publishLocalFixture(lock, {
      cache: v.cache, localDir: v['local-dir'], baseUrl: v['verify-url'], log,
    });
    return JSON.stringify(result, null, 2) + '\n';
  }
  const sources = await inspectBindings(lock, bindings, bindingsDir);
  let productReuse = 'not-inspected';
  if (v.cache) {
    // Avoid loading renderer/Sharp dependencies in the offline DAG command.
    const { buildInventory } = await import('./data-hosting/lib/publish.mjs');
    const { identity } = await import('./surface-build/plan.mjs');
    try {
      const path = resolve(v.cache, dag.buildId), receipt = await jsonFile(resolve(path, 'complete.json'), 32 * 1024 * 1024);
      const actual = (await buildInventory(path)).filter(e => e.path !== 'complete.json');
      productReuse = receipt.buildId === dag.buildId && identity(actual) === identity(receipt.inventory) ? 'verified' : 'content-mismatch';
    } catch (e) { if (e.code !== 'ENOENT') throw e; productReuse = 'missing'; }
  }
  return JSON.stringify({ ...dag, sources, productReuse, sourceDownloadBytes: sources.reduce((n, s) => n + s.downloadBytes, 0),
    sourcesVerified: sources.every(s => s.state === 'verified'),
    limitations: ['Bounded fixtures and real Mars pilots support explicit pinned adapters; absolute source accuracy and production promotion are not certified.',
      'XYZ response inventories are verified during execution, never fetched by this dry run.', 'Unknown peak RAM/disk estimates are null.'] }, null, 2) + '\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(await runBuildCli(process.argv.slice(2))); }
  catch (e) {
    process.stderr.write(JSON.stringify({ diagnostics: e.diagnostics ?? [{ severity: 'error', code: 'surface-build', path: '$', message: e.message }] }, null, 2) + '\n');
    process.exitCode = 2;
  }
}
