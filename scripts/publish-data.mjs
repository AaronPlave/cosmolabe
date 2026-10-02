#!/usr/bin/env node
/**
 * Publish a large static data product to the data host (issue #137).
 *
 *   node scripts/publish-data.mjs list
 *   node scripts/publish-data.mjs terrain/mars-terrain-fused --build mola-hrsc-jezero-v1
 *   node scripts/publish-data.mjs kernels/cassini --build 2026-10-02
 *   node scripts/publish-data.mjs kernels/cassini --build 2026-10-02 --dry-run
 *
 * Each build lands under an immutable prefix (terrain/<name>/<build>/ or
 * kernels/<name>-<build>/) and is never overwritten. The build id is written to
 * scripts/data-hosting/datasets.json only after the public URL verifies, and that
 * recorded id is what hosted catalogs pin. Re-running the same command resumes an
 * interrupted upload.
 *
 * Storage: Cloudflare R2 through its S3 API —
 *   R2_ACCOUNT_ID  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY  R2_BUCKET
 *   DATA_BASE_URL  public URL of the bucket (custom domain), used for verification
 * or `--local-dir <dir>` to publish into a directory (tests, dry runs).
 *
 * Options
 *   --build <id>          required; letters, digits . _ -
 *   --src <dir>           override the dataset's localDir
 *   --concurrency <n>     parallel uploads (default 16)
 *   --dry-run             inventory + validate only
 *   --verify-url <url>    verify against this base URL instead of DATA_BASE_URL
 *   --origin <origin>     CORS origin to verify (repeatable; default Pages + localhost)
 *   --no-verify           skip the public-URL check (the build is then NOT pinned)
 *   --no-pin              verify but do not write the build id to datasets.json
 *   --strict-provenance   kernels: fail if a file's upstream URL cannot be resolved
 */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, assertBuildId, loadDatasets, remotePrefix, saveDatasets } from './data-hosting/lib/datasets.mjs';
import { publishDirectory } from './data-hosting/lib/publish.mjs';
import { createLocalStorage, createS3Storage } from './data-hosting/lib/storage.mjs';
import { terrainManifest, validateTerrain } from './data-hosting/lib/terrain.mjs';
import { kernelManifest, validateKernelHeader } from './data-hosting/lib/kernels.mjs';
import { verifyBuild } from './data-hosting/lib/verify.mjs';

const DEFAULT_ORIGINS = ['https://aaronplave.github.io', 'http://localhost:5173'];

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    build: { type: 'string' },
    src: { type: 'string' },
    concurrency: { type: 'string', default: '16' },
    'dry-run': { type: 'boolean', default: false },
    'local-dir': { type: 'string' },
    'verify-url': { type: 'string' },
    origin: { type: 'string', multiple: true },
    'no-verify': { type: 'boolean', default: false },
    'no-pin': { type: 'boolean', default: false },
    'strict-provenance': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function gitCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return undefined; }
}

async function main() {
  const [id] = positionals;
  if (opt.help || !id) {
    console.log('usage: publish-data.mjs <list | kind/name --build <id> [options]>  (see the header of this file)');
    return;
  }
  const doc = loadDatasets();
  if (id === 'list') {
    for (const [k, ds] of Object.entries(doc.datasets)) {
      console.log(`${k.padEnd(28)} ${ds.build ? `build ${ds.build} → ${remotePrefix(ds)}` : 'unpublished'}`);
    }
    return;
  }
  const dataset = doc.datasets[id];
  if (!dataset) throw new Error(`unknown dataset ${id}. Known: ${Object.keys(doc.datasets).join(', ')}`);
  assertBuildId(opt.build);
  const build = opt.build;
  const prefix = remotePrefix(dataset, build);
  const srcDir = resolve(ROOT, opt.src ?? dataset.localDir);
  const concurrency = Math.max(1, Number.parseInt(opt.concurrency, 10) || 16);
  const commit = gitCommit();

  const storage = opt['dry-run'] ? null : opt['local-dir'] ? createLocalStorage(resolve(opt['local-dir'])) : createS3Storage();
  console.log(`${id} → ${prefix}  (${storage?.name ?? 'dry run'})`);

  const isKernels = dataset.kind === 'kernels';
  const result = await publishDirectory({
    storage, srcDir, prefix, concurrency, dryRun: opt['dry-run'],
    recursive: dataset.recursive !== false,
    deferred: isKernels ? [] : ['layer.json'],
    stateDir: join(ROOT, '.data-hosting'),
    stateName: `${id.replace('/', '-')}-${build}`,
    validate: isKernels
      ? async (entries) => { for (const e of entries) await validateKernelHeader(join(srcDir, e.path)); }
      : validateTerrain,
    buildManifest: isKernels
      ? (entries, inventorySha256) => kernelManifest({
        dataset, build, entries, inventorySha256, srcDir, root: ROOT, gitCommit: commit, strictProvenance: opt['strict-provenance'],
      })
      : (entries, inventorySha256) => terrainManifest({ dataset, build, entries, inventorySha256, srcDir, gitCommit: commit }),
  });
  if (result.dryRun) return;
  console.log(`Uploaded ${result.uploaded.toLocaleString()} objects (${result.skipped.toLocaleString()} already present).`);

  if (opt['no-verify']) {
    console.log('Skipping verification; build NOT pinned in datasets.json.');
    return;
  }
  const baseUrl = opt['verify-url'] ?? process.env.DATA_BASE_URL;
  if (!baseUrl) {
    console.log('No DATA_BASE_URL / --verify-url: cannot verify through the public URL, so the build is NOT pinned in datasets.json.');
    process.exitCode = 1;
    return;
  }
  const check = await verifyBuild({
    baseUrl, prefix, origins: opt.origin?.length ? opt.origin : DEFAULT_ORIGINS, log: console.log,
  });
  if (!check.ok) {
    console.error(`Verification failed:\n${check.problems.map((p) => `  - ${p}`).join('\n')}`);
    console.error('The uploaded prefix is unreferenced; fix the host configuration and re-run to resume.');
    process.exitCode = 1;
    return;
  }
  if (opt['no-pin']) { console.log('Verified. Not pinning (--no-pin).'); return; }
  doc.datasets[id].build = build;
  saveDatasets(doc);
  console.log(`Verified. Pinned ${id} build ${build} in scripts/data-hosting/datasets.json — commit it.`);
}

main().catch((err) => {
  console.error(`publish-data: ${err.message ?? err}`);
  process.exit(1);
});
