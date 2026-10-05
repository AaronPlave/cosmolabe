// Generate the deployed copy of the example catalogs, pointing managed datasets
// at the data host (issue #137).
//
// The checked-in catalogs keep their local paths (`kernels/…`, `/test-catalogs/
// data/…`) so local development is unchanged. For a deployment this walks the
// built `dist/`, and rewrites only string values that resolve — against the
// catalog's own location, the way the viewer resolves them — into a managed
// dataset's `catalogPrefix`. Everything else (NASA imagery URLs, textures,
// models) is left alone. Managed data is then pruned from `dist/`.
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { joinUrl, remotePrefix } from './datasets.mjs';

const MAX_JSON_BYTES = 10 * 1024 * 1024;
const LOCAL_ABS_PREFIX = '/test-catalogs/';

/** Resolve a catalog string to a path relative to the catalog root, or null if it is not a local path. */
export function resolveLocalPath(value, catalogRel) {
  if (typeof value !== 'string' || !value || /[\s:?#]/.test(value)) return null;
  let rel;
  if (value.startsWith(LOCAL_ABS_PREFIX)) rel = value.slice(LOCAL_ABS_PREFIX.length);
  else if (value.startsWith('/')) return null;
  else rel = posix.join(posix.dirname(catalogRel), value);
  rel = posix.normalize(rel);
  if (rel.startsWith('..')) return null;
  // posix.join/normalize keep a trailing slash, which prefix matching relies on.
  return value.endsWith('/') && !rel.endsWith('/') ? `${rel}/` : rel;
}

/** The dataset (and remaining path) a resolved local path falls under, if any. */
export function matchDataset(resolved, datasets) {
  let best;
  for (const [id, ds] of Object.entries(datasets)) {
    const prefix = ds.catalogPrefix;
    if (!resolved.startsWith(prefix)) continue;
    const rest = resolved.slice(prefix.length);
    if (ds.recursive === false && rest.includes('/')) continue;
    if (!best || prefix.length > best.ds.catalogPrefix.length) best = { id, ds, rest };
  }
  return best;
}

/**
 * Rewrite one parsed catalog. Returns { json, changed, unpublished } where
 * `unpublished` lists dataset ids the catalog references that have no build yet
 * (those references are left as local paths).
 */
export function rewriteCatalog(json, catalogRel, datasets, baseUrl) {
  let changed = 0;
  const unpublished = new Set();
  const used = new Set();
  const visit = (v) => {
    if (typeof v === 'string') {
      const resolved = resolveLocalPath(v, catalogRel);
      if (!resolved) return v;
      const m = matchDataset(resolved, datasets);
      if (!m) return v;
      if (!m.ds.build) { unpublished.add(m.id); return v; }
      changed++;
      used.add(m.id);
      return joinUrl(baseUrl, remotePrefix(m.ds) + m.rest);
    }
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
    return v;
  };
  return { json: visit(json), changed, unpublished: [...unpublished], used: [...used] };
}

async function* jsonFiles(dir, rel = '') {
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* jsonFiles(dir, r);
    else if (e.isFile() && e.name.endsWith('.json')) yield r;
  }
}

/**
 * Rewrite every catalog under `dist`, prune managed data from it, and write
 * `hosted-data.json` describing what the deployment depends on.
 * With `strict`, any reference to an unpublished managed dataset is an error, except
 * for dataset ids listed in `allow` (their references stay local).
 */
export async function buildHostedCatalogs({ dist, baseUrl, datasets, strict = true, allow = [], log = console.log }) {
  if (!/^https?:\/\//.test(baseUrl)) throw new Error(`data base URL must be absolute http(s), got ${JSON.stringify(baseUrl)}`);
  const unpublished = new Set();
  const used = new Set();
  const pending = []; // [abs, json, references]: written only once strictness has passed
  for await (const rel of jsonFiles(dist)) {
    if (rel === 'hosted-data.json') continue;
    const abs = join(dist, rel);
    if ((await stat(abs)).size > MAX_JSON_BYTES) continue;
    let json;
    try { json = JSON.parse(await readFile(abs, 'utf8')); } catch { continue; }
    const r = rewriteCatalog(json, rel, datasets, baseUrl);
    r.unpublished.forEach((u) => unpublished.add(u));
    r.used.forEach((u) => used.add(u));
    if (r.changed) pending.push({ file: rel, abs, json: r.json, references: r.changed });
  }
  // Decide before touching dist, so a refused run leaves it as it found it.
  const blocking = [...unpublished].filter((id) => !allow.includes(id));
  if (strict && blocking.length) {
    throw new Error(`catalogs reference datasets with no published build: ${blocking.join(', ')}. Publish them (scripts/publish-data.mjs) or pass --allow-unpublished <dataset-id>.`);
  }
  const rewritten = [];
  for (const p of pending) {
    await writeFile(p.abs, `${JSON.stringify(p.json, null, 2)}\n`);
    rewritten.push({ file: p.file, references: p.references });
  }
  for (const id of unpublished) log(`warning: ${id} has no published build; its catalog paths stay local`);

  // Everything that is hosted leaves the Pages artifact, referenced or not.
  const pruned = [];
  for (const [id, ds] of Object.entries(datasets)) {
    if (!ds.build) continue;
    const dir = join(dist, ds.catalogPrefix);
    if (ds.recursive === false) {
      let names = [];
      try { names = await readdir(dir, { withFileTypes: true }); } catch { /* absent */ }
      for (const e of names) if (e.isFile()) { await rm(join(dir, e.name)); }
    } else {
      await rm(dir, { recursive: true, force: true });
    }
    pruned.push(id);
  }

  const record = {
    version: 1,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    datasets: Object.fromEntries([...used].sort().map((id) => {
      const ds = datasets[id];
      return [id, { kind: ds.kind, name: ds.name, build: ds.build, prefix: remotePrefix(ds) }];
    })),
    rewritten,
    pruned,
  };
  await writeFile(join(dist, 'hosted-data.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
