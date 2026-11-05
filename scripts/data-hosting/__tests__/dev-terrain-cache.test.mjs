import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createDevCatalogResolver, validateDevTerrain } from '../lib/dev-catalogs.mjs';
import { quadTile, writePyramid } from './helpers.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dev-terrain-cache-'));
  roots.push(root);
  const dir = join(root, 'pyramid');
  const cacheDir = join(root, 'cache');
  const tiles = writePyramid(dir, { maxZoom: 6 });
  const datasets = { terrain: { kind: 'terrain', name: 'test', localDir: 'pyramid', catalogPrefix: 'data/terrain/', build: 'v1' } };
  const logs = [];
  const select = () => createDevCatalogResolver({ root, datasets, cacheDir, log: m => logs.push(m) })('data/terrain/', 'test.json');
  return { dir, cacheDir, tiles, logs, select };
}
const hosted = 'https://data.aaronplave.com/terrain/test/v1/';

it('requires explicit validation for a large product, then rejects deleted tiles and changed manifests', async () => {
  const f = fixture();
  expect(await f.select()).toBe(hosted);
  expect(f.logs.join('\n')).toContain('validate-dev-data.mjs');
  expect((await validateDevTerrain(f.dir, f.cacheDir)).tiles).toBe(f.tiles);
  expect(await f.select()).toBe('data/terrain/');

  const tile = join(f.dir, '1/0/1.terrain'); // outside decoded header samples
  const original = readFileSync(tile);
  rmSync(tile);
  expect(await f.select()).toBe(hosted);
  writeFileSync(tile, original);
  await validateDevTerrain(f.dir, f.cacheDir);
  expect(await f.select()).toBe('data/terrain/');
  writeFileSync(join(f.dir, 'terrain-product.json'), '{}');
  expect(await f.select()).toBe(hosted);
}, 30000);

it('retains exhaustive mixed-encoding safety in the explicit workflow and removes prior success receipts', async () => {
  const f = fixture();
  await validateDevTerrain(f.dir, f.cacheDir);
  // In-place edits are supported by revalidating, not by trusting the old
  // immutable-build receipt. A failed revalidation must revoke that receipt.
  writeFileSync(join(f.dir, '1/0/1.terrain'), quadTile());
  await expect(validateDevTerrain(f.dir, f.cacheDir)).rejects.toThrow('mixed tile encodings');
  expect(await f.select()).toBe(hosted);
}, 30000);

it('rejects corrupt receipts and sampled tile edits', async () => {
  const f = fixture();
  await validateDevTerrain(f.dir, f.cacheDir);
  writeFileSync(join(f.dir, '0/0/0.terrain'), quadTile());
  expect(await f.select()).toBe(hosted);
  const { readdirSync } = await import('node:fs');
  writeFileSync(join(f.cacheDir, readdirSync(f.cacheDir)[0]), '{}');
  expect(await f.select()).toBe(hosted);
}, 30000);
