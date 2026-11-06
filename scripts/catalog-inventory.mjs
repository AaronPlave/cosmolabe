/** Discovery validation and serving inventory; never deletes or rewrites assets. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveLocalPath, matchDataset } from './data-hosting/lib/hosted-catalogs.mjs';
import { loadDatasets } from './data-hosting/lib/datasets.mjs';

const defaultRoot = fileURLToPath(new URL('../apps/viewer/test-catalogs/', import.meta.url));
const read = path => JSON.parse(readFileSync(path, 'utf8'));

export function validateIndex(index, root) {
  assert.equal(index.version, 1, 'index version');
  assert.ok(Array.isArray(index.catalogs), 'catalogs array');
  const ids = new Set();
  for (const e of index.catalogs) {
    assert.ok(typeof e.id === 'string' && e.id && !ids.has(e.id), `duplicate/empty id: ${e.id}`);
    ids.add(e.id);
    assert.ok(e.name?.trim() && e.description?.trim() && e.group?.trim(), `${e.id}: missing discovery copy/group`);
    for (const key of ['catalog', ...(e.script ? ['script'] : [])]) {
      assert.ok(e[key].startsWith('./'), `${e.id}: ${key} must be relative`);
      const path = resolve(root, e[key]);
      assert.ok(!relative(root, path).startsWith('..') && existsSync(path), `${e.id}: missing/escaping ${e[key]}`);
    }
  }
  return index.catalogs;
}

function files(root, rel = '') {
  if (!existsSync(resolve(root, rel))) return [];
  return readdirSync(resolve(root, rel), { withFileTypes: true }).flatMap(e => {
    const path = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? files(root, path) : [path];
  });
}

export function catalogInventory({ root = defaultRoot, dist } = {}) {
  const publicIndex = read(resolve(root, 'index.json'));
  const publicEntries = validateIndex(publicIndex, root);
  const devEntries = validateIndex(read(resolve(root, 'dev-index.json')), root);
  const datasets = loadDatasets().datasets;
  const scenes = new Set();
  const dependencies = new Map();
  function visit(path) {
    if (scenes.has(path)) return;
    scenes.add(path);
    const json = read(resolve(root, path));
    for (const dep of json.require ?? []) {
      const target = resolveLocalPath(dep, path);
      assert.ok(target && existsSync(resolve(root, target)), `${path}: missing require ${dep}`);
      visit(target);
    }
    const strings = value => {
      if (typeof value === 'string') {
        const target = resolveLocalPath(value, path);
        // Resource paths, not arbitrary prose or entity names.
        if (!target || !/\.(json|bsp|bc|bds|tls|tpc|tf|tsc|gz|jpg|jpeg|png|dds|glb|gltf|obj|xyzv|oem)$/i.test(target)) return;
        const dataset = matchDataset(target, datasets);
        const record = dependencies.get(target) ?? { path: target, referencedBy: [], dataset: dataset?.id ?? null,
          build: dataset?.ds.build ?? null, localOnly: !!dataset?.ds.localOnly, localPresent: existsSync(resolve(root, target)) };
        record.referencedBy.push(path);
        dependencies.set(target, record);
      } else if (Array.isArray(value)) value.forEach(strings);
      else if (value && typeof value === 'object') Object.values(value).forEach(strings);
    };
    strings(json);
  }
  for (const e of [...publicEntries, ...devEntries]) visit(e.catalog.slice(2));
  const publicPaths = new Set(publicEntries.map(e => e.catalog.slice(2)));
  const localOnly = Object.values(datasets).filter(d => d.localOnly).flatMap(d => d.catalogs ?? []);
  const report = { publicEntries: publicEntries.length, developerEntries: devEntries.length,
    catalogGraph: [...scenes].sort(), localOnlyCatalogs: localOnly,
    dependencies: [...dependencies.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  if (dist) {
    const shipped = files(resolve(dist, 'test-catalogs'));
    for (const path of publicPaths) assert.ok(shipped.includes(path), `public catalog missing from bundle: ${path}`);
    for (const e of [...publicEntries, ...devEntries].filter(e => e.script)) {
      assert.ok(shipped.includes(e.script.slice(2)), `script missing from bundle: ${e.script}`);
    }
    for (const path of scenes) {
      if (!localOnly.includes(path)) assert.ok(shipped.includes(path), `catalog dependency missing from bundle: ${path}`);
    }
    for (const path of localOnly) assert.ok(!shipped.includes(path), `local-only catalog shipped: ${path}`);
    let bytes = 0;
    const outsideReferences = new Map();
    for (const path of shipped) {
      const size = statSync(resolve(dist, 'test-catalogs', path)).size;
      bytes += size;
      if (!scenes.has(path) && !dependencies.has(path)) {
        const root = path.split('/').slice(0, 2).join('/');
        const group = outsideReferences.get(root) ?? { root, files: 0, bytes: 0, examples: [] };
        group.files++; group.bytes += size;
        if (group.examples.length < 3) group.examples.push(path);
        outsideReferences.set(root, group);
      }
    }
    report.bundle = { files: shipped.length, bytes,
      listed: shipped.filter(p => publicPaths.has(p)),
      unlistedScenes: shipped.filter(p => scenes.has(p) && !publicPaths.has(p)),
      unindexedScenes: shipped.filter(p => /^(?:[^/]+|(?:base|experiments|fixtures)\/[^/]+)\.json$/.test(p) && !scenes.has(p))
        .filter(p => { const json = read(resolve(dist, 'test-catalogs', p)); return json.items || json.require; }),
      omittedCatalogs: [...scenes].filter(p => !shipped.includes(p)),
      // Unreferenced in the discovered graph is a review candidate, never proof of non-use.
      filesOutsideCatalogReferences: [...outsideReferences.values()] };
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const i = process.argv.indexOf('--dist');
  assert.ok(i < 0 || process.argv[i + 1], '--dist requires a directory');
  console.log(JSON.stringify(catalogInventory({ dist: i < 0 ? undefined : resolve(process.argv[i + 1]) }), null, 2));
}
