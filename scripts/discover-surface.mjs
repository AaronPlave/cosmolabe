#!/usr/bin/env node
// Explicit offline metadata planning adapter for #249. Never loads source rasters.
// Optional --ode-query invokes the separately bounded archive metadata adapter.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recommendSurfaceSources, discoveryEstimatorSources, parseSurfacePlan } from '../packages/core/dist/surface-plan/index.js';
import { fetchOdeMarsMetadata, replayOdeMarsMetadata } from './ode-mars-metadata.mjs';

const USAGE = 'Usage: npm run --silent discover:surface -- PLAN.json --inventory INVENTORY.json\n'
  + '  [--policy consistent|finest-imagery|physical-accuracy] [--out REPORT.json] [--sources-out SOURCES.json]\n'
  + '  [--inventory-out FULL-INVENTORY.json] [--ode-query QUERY.json | --ode-cache CACHE.json] [--ode-cache-out CACHE.json]\n'
  + 'Offline by default. Sources export contains only top recommended candidates, never a build lock.\n'
  + 'Live ODE query requires mission/instrument/productType and bounds or productId; at most 2 x 16 products.\n';
async function readLocal(path, max = 2 * 1024 * 1024) {
  if (/^[a-z][a-z\d+.-]*:/i.test(path)) throw new Error('Local paths only; archive access is opt-in');
  if ((await stat(path)).size > max) throw new Error(path + ': too large');
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > max) throw new Error(path + ': too large');
  return text;
}
export async function runSurfaceDiscoveryCli(args) {
  if (args.length === 1 && args[0] === '--help') return USAGE;
  if (!args[0] || args[0].startsWith('--')) throw new Error(USAGE);
  const planPath = resolve(args[0]), options = new Map();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (!['--inventory', '--policy', '--out', '--sources-out', '--inventory-out', '--ode-query', '--ode-cache', '--ode-cache-out'].includes(flag) || options.has(flag))
      throw new Error('Unknown or duplicate option: ' + flag + '\n' + USAGE);
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing ' + flag + ' value');
    options.set(flag, args[++i]);
  }
  if (!options.has('--inventory')) throw new Error('--inventory is required\n' + USAGE);
  const inventoryPath = resolve(options.get('--inventory'));
  const plan = parseSurfacePlan(await readLocal(planPath));
  const references = new Map();
  let referenceBytes = 0;
  for (const layer of plan.layers) {
    if (layer.geojson || references.has(layer.source)) continue;
    const path = resolve(dirname(planPath), layer.source);
    const text = await readLocal(path);
    referenceBytes += Buffer.byteLength(text);
    if (referenceBytes > 8 * 1024 * 1024) throw new Error('Referenced GeoJSON exceeds 8 MiB total');
    references.set(layer.source, text);
  }
  const inventory = JSON.parse(await readLocal(inventoryPath));
  if (!Array.isArray(inventory)) throw new Error('Expected inventory JSON array');
  if (options.has('--ode-query') && options.has('--ode-cache')) throw new Error('Choose live query or offline cache');
  if (options.has('--ode-cache-out') && !options.has('--ode-query')) throw new Error('--ode-cache-out requires --ode-query');
  const extraInputs = ['--ode-query', '--ode-cache'].filter(k => options.has(k)).map(k => resolve(options.get(k)));
  const inputs = [planPath, inventoryPath, ...extraInputs, ...[...references.keys()].map(k => resolve(dirname(planPath), k))];
  const destinations = ['--out', '--sources-out', '--inventory-out', '--ode-cache-out'].filter(k => options.has(k)).map(k => resolve(options.get(k)));
  if (destinations.some(p => inputs.includes(p)) || new Set(destinations).size !== destinations.length)
    throw new Error('Output destinations must be distinct from each other and all input files');
  const query = options.has('--ode-query') ? JSON.parse(await readLocal(resolve(options.get('--ode-query')))) : null;
  const ode = query ? await fetchOdeMarsMetadata(query) : options.has('--ode-cache')
    ? await replayOdeMarsMetadata(JSON.parse(await readLocal(resolve(options.get('--ode-cache'))))) : null;
  const normalized = [...inventory];
  const ids = new Set(inventory.map(r => r.descriptor.productId));
  for (const r of ode?.records ?? []) {
    if (ids.has(r.descriptor.productId)) continue; // Reviewed offline records take precedence, no silent metadata replacement.
    if (normalized.length === 32) { ode.diagnostics.push({ severity: 'warning', code: 'discovery-inventory-cap', path: 'ode', message: '32-product inventory cap; additional metadata remains in cache' }); break; }
    ids.add(r.descriptor.productId); normalized.push(r);
  }
  const report = recommendSurfaceSources(plan, normalized,
    { policy: options.get('--policy') ?? 'consistent', references });
  const output = {
    ...report, diagnostics: [...report.diagnostics, ...(ode?.diagnostics ?? [])],
    input: { plan: planPath, inventory: inventoryPath },
    estimatorHandoff: { kind: 'recommended-source-candidates', buildLock: false,
      sourceIds: report.recommendedSourceIds, regions: report.combinations.map(c => ({ regionId: c.regionId, combinationId: c.alternatives[0]?.id ?? null })) },
    ...(ode ? { ode } : {}),
  };
  const json = JSON.stringify(output, null, 2) + '\n';
  if (options.has('--out')) {
    const target = resolve(options.get('--out'));
    await writeFile(target, json);
  }
  if (options.has('--sources-out')) await writeFile(resolve(options.get('--sources-out')),
    JSON.stringify(discoveryEstimatorSources(report, normalized), null, 2) + '\n');
  if (options.has('--inventory-out')) await writeFile(resolve(options.get('--inventory-out')), JSON.stringify(normalized, null, 2) + '\n');
  if (options.has('--ode-cache-out')) await writeFile(resolve(options.get('--ode-cache-out')),
    JSON.stringify({ query, pageSize: ode.constraints.pageSize, maxPages: ode.constraints.maxPages, pages: ode.pages }, null, 2) + '\n');
  return json;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(await runSurfaceDiscoveryCli(process.argv.slice(2))); }
  catch (e) { process.stderr.write(JSON.stringify({ diagnostics: [{ severity: 'error', code: 'discovery-cli',
    message: String(e) }] }, null, 2) + '\n'); process.exitCode = 2; }
}
