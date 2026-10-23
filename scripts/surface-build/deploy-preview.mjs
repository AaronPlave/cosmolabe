#!/usr/bin/env node
// Publish only a content-addressed experimental viewer; never replace Pages.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import assert from 'node:assert/strict';
import { createS3Storage } from '../data-hosting/lib/storage.mjs';

const [action, directory, receiptFile] = process.argv.slice(2);
assert(['plan', 'publish', 'rollback'].includes(action) && directory && receiptFile,
  'Usage: deploy-preview.mjs plan|publish|rollback DIST RECEIPT.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const entries = [];
async function walk(dir, rel = '') {
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = rel + item.name;
    assert(!item.isSymbolicLink(), 'preview must not contain symlinks');
    if (item.isDirectory()) await walk(join(dir, item.name), name + '/');
    else {
      const bytes = await readFile(join(dir, item.name));
      entries.push({ path: name, bytes: bytes.length, sha256: hash(bytes),
        contentType: types[extname(name)] ?? 'application/octet-stream' });
    }
  }
}
await walk(resolve(directory));
assert(entries.some(e => e.path === 'index.html'));
const catalogPath = 'test-catalogs/experiments/mars-surface-build-pilot.json';
const planned = JSON.parse(await readFile('docs/releases/surface-build-jezero/catalog.planned.json'));
assert.deepEqual(JSON.parse(await readFile(join(directory, catalogPath))), planned);
const identity = hash(JSON.stringify(entries));
const prefix = `previews/pr-287/${identity}/`;
const baseUrl = `https://data.aaronplave.com/${prefix}`;
const record = { schemaVersion: 1, identity, prefix, viewerUrl: `${baseUrl}index.html?catalog=test-catalogs/experiments/mars-surface-build-pilot`,
  previousPrefixAbsent: true, entries, objectCount: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0),
  mainSiteChanged: false, immutableProductsChanged: false };
if (action === 'plan') {
  await writeFile(receiptFile, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
} else {
  const approved = JSON.parse(await readFile(receiptFile));
  assert.deepEqual(approved, record, 'preview differs from reviewed plan');
  const store = createS3Storage();
  const existing = await store.list(prefix);
  const expected = new Set(entries.map(e => prefix + e.path));
  for (const key of existing.keys()) assert(expected.has(key), `unexpected preview object ${key}`);
  // Check all existing bytes before mutation, including rollback. Never delete
  // or overwrite an object belonging to any other release or data product.
  for (const entry of entries) {
    const bytes = await store.get(prefix + entry.path);
    if (bytes) assert.equal(hash(bytes), entry.sha256, `preview collision: ${entry.path}`);
  }
  if (action === 'rollback') {
    const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: 'auto', endpoint: process.env.R2_ENDPOINT ?? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
    // Remove entry point first. Original state was absence, not another viewer.
    for (const entry of [...entries].sort((a, b) => Number(b.path === 'index.html') - Number(a.path === 'index.html'))) {
      await client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: prefix + entry.path }));
    }
    assert.equal((await store.list(prefix)).size, 0);
    assert.equal((await fetch(baseUrl + 'index.html', { cache: 'no-store' })).status, 404);
  } else {
    // Entry point is exposed only after every dependency is uploaded.
    for (const entry of [...entries].sort((a, b) => Number(a.path === 'index.html') - Number(b.path === 'index.html'))) {
      if (!existing.has(prefix + entry.path)) await store.put(prefix + entry.path,
        { path: join(directory, entry.path), size: entry.bytes }, { contentType: entry.contentType, cacheControl: 'no-store' });
    }
    for (const entry of entries) {
      const response = await fetch(baseUrl + entry.path, { cache: 'no-store' });
      assert.equal(response.status, 200, entry.path);
      assert.equal(hash(Buffer.from(await response.arrayBuffer())), entry.sha256, entry.path);
      assert.equal(response.headers.get('content-type'), entry.contentType, entry.path);
      assert.equal(response.headers.get('cache-control'), 'no-store', entry.path);
    }
  }
}
console.log(JSON.stringify({ action, identity, prefix, viewerUrl: record.viewerUrl, objectCount: record.objectCount, bytes: record.bytes }));
