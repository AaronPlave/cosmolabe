// Explicit publication orchestration over #137. Importing this module never
// reads credentials. Catalog changes are offline candidates, never deployment.
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assert, compileBuild, identity, digest } from './plan.mjs';
import { readCompleted, validateProduct } from './run.mjs';
import { publishDirectory, serializeInventory, mapLimit, objectMeta } from '../data-hosting/lib/publish.mjs';
import { cubeTerrainManifest, cubeImageryManifest, validateCubeTerrain, validateCubeImagery } from '../data-hosting/lib/cube.mjs';
import { createLocalStorage, createS3Storage } from '../data-hosting/lib/storage.mjs';
import { verifyBuild } from '../data-hosting/lib/verify.mjs';
import { rewriteCatalog } from '../data-hosting/lib/hosted-catalogs.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const DEFAULT_ORIGINS = ['http://localhost:5173', 'https://aaronplave.github.io'];
function validateOrigins(origins) {
  assert(Array.isArray(origins) && origins.length > 0 && origins.every(o => {
    try { const u = new URL(o); return ['http:', 'https:'].includes(u.protocol) && u.origin === o; }
    catch { return false; }
  }), 'verification requires explicit HTTP(S) origins without paths');
}
export async function publicationPlan(lock, { cache }) {
  assert(cache, 'publication requires --cache');
  const dag = await compileBuild(lock), directory = join(resolve(cache), dag.buildId);
  const complete = await readCompleted(directory, dag);
  assert(complete, 'incomplete build cannot publish');
  assert(complete.report.validation === 'passed-supported-gates', 'build validation did not pass');
  const products = [];
  // Preflight ALL products before even initializing a remote storage client.
  for (const p of complete.report.products) {
    const entries = await validateProduct(p, join(directory, p.id));
    products.push({ productId: p.id, kind: p.kind, productIdentity: p.productIdentity,
      prefix: `${p.kind}/${p.id}/${p.productIdentity.slice(0, 32)}/`,
      inventorySha256: digest(serializeInventory(entries)), entries,
      objects: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0) });
  }
  const plan = { version: 1, kind: 'surface-publication-plan', buildId: dag.buildId,
    lockIdentity: lock.identity, products };
  return { ...plan, identity: identity(plan), directory };
}

/** Full inventory/hash/headers HTTP check, in addition to #137's runtime checks. */
export async function verifyPublishedProduct(p, { baseUrl, fetchImpl = fetch, origins = DEFAULT_ORIGINS }) {
  validateOrigins(origins);
  const verification = await verifyBuild({ baseUrl, prefix: p.prefix, fetchImpl, origins });
  assert(verification.ok, `publication verification failed: ${verification.problems.join('; ')}`);
  assert(verification.manifest.kind === p.kind && verification.manifest.name === p.productId
    && verification.manifest.build === p.productIdentity.slice(0, 32)
    && verification.manifest.fileCount === p.objects && verification.manifest.totalBytes === p.bytes, 'published manifest identity/count mismatch');
  assert(verification.manifest.inventory.sha256 === p.inventorySha256, 'published inventory pin mismatch');
  const missing = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/${p.prefix}__missing__/surface-publication-probe`, { headers: { Origin: origins[0] } });
  assert(missing.status === 404 && !/html/i.test(missing.headers.get('content-type') ?? ''), 'publication requires a non-HTML missing-object 404');
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/${p.prefix}inventory.jsonl.gz`);
  assert(response.ok, 'published inventory is missing');
  const inventory = gunzipSync(Buffer.from(await response.arrayBuffer())).toString();
  assert(digest(inventory) === p.inventorySha256 && inventory === serializeInventory(p.entries), 'published inventory content mismatch');
  await mapLimit(p.entries, 8, async e => {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/${p.prefix}${e.path}`, { headers: { Origin: origins[0] } });
    assert(res.status === 200, `published object missing: ${e.path} HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    assert(body.length === e.size && digest(body) === e.sha256, `published object checksum mismatch: ${e.path}`);
    const meta = objectMeta(e.path, e.gzip);
    assert(res.headers.get('content-type')?.startsWith(meta.contentType), `published content type mismatch: ${e.path}`);
    assert(res.headers.get('cache-control')?.includes('immutable'), `published cache policy mismatch: ${e.path}`);
    const cors = res.headers.get('access-control-allow-origin');
    assert(cors === '*' || cors === origins[0], `published CORS mismatch: ${e.path}`);
  });
  return { objects: p.objects, bytes: p.bytes, inventorySha256: p.inventorySha256 };
}

export async function publishBuild(lock, { cache, localDir, baseUrl, confirm, origins = DEFAULT_ORIGINS, fetchImpl = fetch, log = () => {} }) {
  validateOrigins(origins);
  const plan = await publicationPlan(lock, { cache });
  assert(/^https?:\/\//.test(baseUrl ?? ''), 'publication requires absolute --verify-url');
  if (!localDir) assert(confirm === plan.identity, `R2 publication requires --confirm-publication ${plan.identity}; no credentials read`);
  const storage = localDir ? createLocalStorage(resolve(localDir)) : createS3Storage();
  const products = [];
  for (const p of plan.products) {
    // #137 can resume by size. Strengthen that contract here: a same-sized
    // partial object must have the expected hash before it may be skipped.
    const existing = await storage.list(p.prefix);
    const allowed = new Set([...p.entries.map(e => p.prefix + e.path), p.prefix + 'manifest.json', p.prefix + 'inventory.jsonl.gz']);
    assert([...existing.keys()].every(k => allowed.has(k)), 'publication prefix has unexpected objects');
    for (const e of p.entries) if (existing.has(p.prefix + e.path)) {
      const body = await storage.get(p.prefix + e.path);
      assert(body && body.length === e.size && digest(body) === e.sha256, `partial publication checksum mismatch: ${e.path}; choose a clean prefix, never overwrite`);
    }
    const terrain = p.kind === 'cube-terrain', srcDir = join(plan.directory, p.productId);
    const result = await publishDirectory({ storage, srcDir, prefix: p.prefix, log,
      validate: terrain ? validateCubeTerrain : validateCubeImagery,
      deferred: terrain ? ['tileset.json', 'cpu-grids.json'] : ['imagery.json'],
      buildManifest: (entries, inventorySha256) => (terrain ? cubeTerrainManifest : cubeImageryManifest)({
        dataset: { kind: p.kind, name: p.productId }, build: p.productIdentity.slice(0, 32), entries, inventorySha256, srcDir, gitCommit: null,
      }) });
    const verified = await verifyPublishedProduct(p, { baseUrl, fetchImpl, origins });
    const hosted = await storage.list(p.prefix);
    assert(hosted.size === p.objects + 2 && [...hosted.keys()].every(k => allowed.has(k)), 'published object inventory is not exact');
    const storageBytes = [...hosted.values()].reduce((n, bytes) => n + bytes, 0);
    const { entries, ...summary } = p;
    products.push({ ...summary, verified: true, ...verified, storageObjects: hosted.size, storageBytes, reused: !!result.alreadyPublished });
  }
  const receipt = { version: 1, kind: 'surface-publication-receipt', buildId: plan.buildId, lockIdentity: plan.lockIdentity,
    publicationIdentity: plan.identity, baseUrl: baseUrl.replace(/\/$/, ''), localOnly: !!localDir,
    catalogPinned: false, verificationOrigins: origins, products, objects: products.reduce((n, p) => n + p.objects, 0), bytes: products.reduce((n, p) => n + p.bytes, 0),
    storageObjects: products.reduce((n,p)=>n+p.storageObjects,0), storageBytes: products.reduce((n,p)=>n+p.storageBytes,0) };
  return { ...receipt, identity: identity(receipt) };
}

/** Reverify HTTP from a receipt, then reuse the existing deployment rewrite.
 * Returns a candidate + exact rollback; neither is applied to any live catalog.
 */
export async function catalogCandidate(lock, { cache, receipt, catalog, catalogRel, catalogPrefixes, origins = receipt.verificationOrigins ?? DEFAULT_ORIGINS, fetchImpl = fetch }) {
  const { identity: pin, ...body } = receipt;
  assert(pin === identity(body), 'publication receipt changed');
  const plan = await publicationPlan(lock, { cache });
  assert(receipt.version === 1 && receipt.kind === 'surface-publication-receipt'
    && receipt.buildId === plan.buildId && receipt.lockIdentity === plan.lockIdentity
    && receipt.publicationIdentity === plan.identity && receipt.products.length === plan.products.length
    && plan.products.every(p => receipt.products.some(r => r.verified && r.productId === p.productId
      && r.prefix === p.prefix && r.inventorySha256 === p.inventorySha256)), 'publication receipt does not match completed build');
  for (const p of plan.products) await verifyPublishedProduct(p, { baseUrl: receipt.baseUrl, fetchImpl, origins });
  const datasets = Object.fromEntries(plan.products.map(p => {
    const prefix = catalogPrefixes[p.productId];
    assert(typeof prefix === 'string' && /^data\/[\w./-]+\/$/.test(prefix) && !prefix.includes('..'), 'explicit safe local catalog prefix required for every product');
    return [p.productId, { kind: p.kind, name: p.productId, build: p.productIdentity.slice(0, 32), catalogPrefix: prefix }];
  }));
  const rewritten = rewriteCatalog(catalog, catalogRel, datasets, receipt.baseUrl);
  assert(!rewritten.unpublished.length && plan.products.every(p => rewritten.used.includes(p.productId)), 'catalog must reference every verified product');
  const result = { version: 1, kind: 'surface-catalog-candidate', publicationIdentity: plan.identity,
    before: catalog, beforeIdentity: identity(catalog), after: rewritten.json, afterIdentity: identity(rewritten.json), datasets };
  return { ...result, identity: identity(result) };
}

/** Optimistic local apply/rollback: refuse concurrent catalog edits. */
export async function applyCatalogCandidate(candidate, file, { rollback = false } = {}) {
  const { identity: pin, ...body } = candidate;
  assert(pin === identity(body), 'catalog candidate changed');
  const current = JSON.parse(await readFile(file, 'utf8'));
  assert(identity(current) === (rollback ? candidate.afterIdentity : candidate.beforeIdentity), 'catalog changed since candidate; refusing overwrite');
  const temporary = `${file}.partial-${process.pid}`;
  try {
    await writeFile(temporary, json(rollback ? candidate.before : candidate.after), { flag: 'wx' });
    assert(identity(JSON.parse(await readFile(file, 'utf8'))) === identity(current), 'catalog changed while preparing atomic replacement');
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  return { catalogIdentity: rollback ? candidate.beforeIdentity : candidate.afterIdentity, rollback, deployed: false };
}
