#!/usr/bin/env node
// Filesystem adapter only. All contracts and estimation live in renderer-free core.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  estimateSurfacePlan, formatSurfacePlanEstimate, parseSurfacePlan, SurfacePlanError,
  validateSurfaceSources,
} from '../packages/core/dist/surface-plan/index.js';

const USAGE = `Usage: npm run --silent plan:surface -- PLAN.json [--sources SOURCES.json] [--out ESTIMATE.json] [--json]

Offline dry run only. Relative GeoJSON paths resolve from the plan directory.
--sources  Local JSON array of source descriptors (metadata only).
--out      Save machine-readable summary JSON alongside the text report.
--json     Print only summary JSON to stdout.
--help     Show this help.
`;
async function localText(path) {
  if (/^[a-z][a-z\d+.-]*:/i.test(path)) throw new SurfacePlanError([{ severity: 'error', code: 'local-files-only', path, message: 'Supply a local path; the dry run never fetches URLs.' }]);
  if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error(`${path}: exceeds 2 MiB`);
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error(`${path}: exceeds 2 MiB`);
  return text;
}
export async function runSurfacePlanCli(args) {
  if (args.length === 1 && args[0] === '--help') return { stdout: USAGE };
  if (!args[0] || args[0].startsWith('--')) throw new Error(USAGE);
  const planPath = resolve(args[0]), options = new Map();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (!['--sources', '--out', '--json'].includes(flag) || options.has(flag)) throw new Error(`Unknown or duplicate option ${flag}\n${USAGE}`);
    if (flag === '--json') options.set(flag, true);
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`);
      options.set(flag, args[++i]);
    }
  }
  const plan = parseSurfacePlan(await localText(planPath));
  const references = new Map();
  let bytes = 0;
  for (const layer of plan.layers) if (!layer.geojson && !references.has(layer.source)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(layer.source)) throw new SurfacePlanError([{ severity: 'error', code: 'unresolved-reference', path: layer.source, message: 'External references require a local file. No network access is performed.' }]);
    let text;
    try { text = await localText(resolve(dirname(planPath), layer.source)); }
    catch (e) { throw new SurfacePlanError([{ severity: 'error', code: 'unresolved-reference', path: layer.source, message: String(e) }]); }
    bytes += Buffer.byteLength(text);
    if (bytes > 8 * 1024 * 1024) throw new Error('Referenced GeoJSON exceeds 8 MiB total');
    references.set(layer.source, text);
  }
  const sources = options.has('--sources') ? validateSurfaceSources(JSON.parse(await localText(options.get('--sources')))) : [];
  const estimate = await estimateSurfacePlan(plan, { references, sources });
  const json = JSON.stringify(estimate, null, 2) + '\n';
  if (options.has('--out')) {
    const output = resolve(options.get('--out'));
    const inputs = [planPath, ...plan.layers.filter(l => !l.geojson).map(l => resolve(dirname(planPath), l.source))];
    if (options.has('--sources')) inputs.push(resolve(options.get('--sources')));
    if (inputs.includes(output)) throw new Error('--out must not overwrite an input file');
    await writeFile(output, json);
  }
  return { stdout: options.has('--json') ? json : formatSurfacePlanEstimate(estimate) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write((await runSurfacePlanCli(process.argv.slice(2))).stdout); }
  catch (e) {
    const diagnostics = e instanceof SurfacePlanError ? e.diagnostics : [{ severity: 'error', code: 'cli', path: '$', message: String(e) }];
    process.stderr.write(JSON.stringify({ diagnostics }, null, 2) + '\n');
    process.exitCode = 2;
  }
}
