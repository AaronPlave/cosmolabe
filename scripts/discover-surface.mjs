#!/usr/bin/env node
// Explicit offline metadata planning adapter for #249. Never loads source rasters.
// Optional --ode-template invokes the separately bounded archive metadata adapter.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recommendSurfaceSources, parseSurfacePlan } from '../packages/core/dist/surface-plan/index.js';
import { fetchOdeMarsMetadata } from './ode-mars-metadata.mjs';

const USAGE = 'Usage: npm run --silent discover:surface -- PLAN.json --inventory INVENTORY.json\n'
  + '  [--policy consistent|finest-imagery|physical-accuracy] [--out REPORT.json]\n'
  + '  [--ode-template HTTPS-ODE-MARS-METADATA-URL]\n'
  + 'Offline by default. Inventory metadata is not a build lock.\n'
  + 'Optional ODE URL needs {page} and {pageSize} placeholders; host allowlisted.\n'
  + 'Live search is bounded (2 pages x 25 products), opt-in and non-fatal on failure.\n';
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
    if (!['--inventory', '--policy', '--out', '--ode-template'].includes(flag) || options.has(flag))
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
  const report = recommendSurfaceSources(plan, inventory,
    { policy: options.get('--policy') ?? 'consistent', references });
  const output = {
    ...report, input: { plan: planPath, inventory: inventoryPath },
    ...(options.has('--ode-template') ? { ode: await fetchOdeMarsMetadata(options.get('--ode-template')) } : {}),
  };
  const json = JSON.stringify(output, null, 2) + '\n';
  if (options.has('--out')) {
    const target = resolve(options.get('--out'));
    if ([planPath, inventoryPath, ...[...references.keys()].map(k => resolve(dirname(planPath), k))].includes(target))
      throw new Error('--out must not overwrite an input');
    await writeFile(target, json);
  }
  return json;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(await runSurfaceDiscoveryCli(process.argv.slice(2))); }
  catch (e) { process.stderr.write(JSON.stringify({ diagnostics: [{ severity: 'error', code: 'discovery-cli',
    message: String(e) }] }, null, 2) + '\n'); process.exitCode = 2; }
}
