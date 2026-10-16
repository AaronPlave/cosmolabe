import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevCatalogResolver, DEFAULT_DEV_DATA_BASE_URL } from '../lib/dev-catalogs.mjs';
import { loadDatasets, ROOT, remotePrefix } from '../lib/datasets.mjs';
import { writeCubeProducts, writeKernels, writePyramid, quadTile } from './helpers.mjs';

const roots = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dev-catalogs-'));
  roots.push(root);
  const { terrain, imagery } = writeCubeProducts(root);
  const datasets = {
    terrain: { kind: 'cube-terrain', name: 'terrain', localDir: relative(root, terrain), catalogPrefix: 'data/terrain/', build: 'terrain-v1' },
    imagery: { kind: 'cube-imagery', name: 'imagery', localDir: relative(root, imagery), catalogPrefix: 'data/imagery/', build: 'imagery-v2' },
  };
  const catalog = {
    tiles: '/test-catalogs/data/terrain/tileset.json',
    grids: 'data/terrain/cpu-grids.json',
    imagery: 'data/imagery/imagery.json',
  };
  const logs = [];
  const resolver = createDevCatalogResolver({ root, datasets, log: (m) => logs.push(m), ...options });
  return { root, terrain, imagery, datasets, catalog, logs, resolver };
}
const hosted = (ds, file, base = DEFAULT_DEV_DATA_BASE_URL) => `${base}/${remotePrefix(ds)}${file}`;

describe('development managed datasets', () => {
  it('keeps complete local products and reports each choice once', async () => {
    const f = fixture();
    expect(await f.resolver(f.catalog, 'example.json')).toEqual(f.catalog);
    expect(await f.resolver(f.catalog, 'example.json')).toEqual(f.catalog);
    expect(f.logs).toHaveLength(2);
    expect(f.logs.every((m) => m.includes(': local '))).toBe(true);
  });

  it('uses pinned builds for absent products without changing the source catalog', async () => {
    const f = fixture({ baseUrl: 'https://custom.example/data/' });
    rmSync(f.terrain, { recursive: true });
    rmSync(f.imagery, { recursive: true });
    expect(await f.resolver(f.catalog, 'example.json')).toEqual({
      tiles: hosted(f.datasets.terrain, 'tileset.json', 'https://custom.example/data'),
      grids: hosted(f.datasets.terrain, 'cpu-grids.json', 'https://custom.example/data'),
      imagery: hosted(f.datasets.imagery, 'imagery.json', 'https://custom.example/data'),
    });
    expect(f.catalog.grids).toBe('data/terrain/cpu-grids.json');
  });

  it.each(['cpu-grids.json', 'nz/0/0/0.glb', 'heights/px/0/0/0.f32'])('falls back for the entire terrain product when %s is missing', async (file) => {
    const f = fixture();
    rmSync(join(f.terrain, file));
    const result = await f.resolver(f.catalog, 'example.json');
    expect(result.tiles).toBe(hosted(f.datasets.terrain, 'tileset.json'));
    expect(result.grids).toBe(hosted(f.datasets.terrain, 'cpu-grids.json'));
    expect(result.imagery).toBe(f.catalog.imagery);
    expect(f.logs.join('\n')).toContain('DEV_DATA_MODE=local');
  });

  it('rejects mixed geometry/CPU revisions as a local product', async () => {
    const f = fixture();
    const p = join(f.terrain, 'tileset.json');
    const tileset = JSON.parse(readFileSync(p, 'utf8'));
    tileset.asset.tilesetVersion = 'other-build';
    writeFileSync(p, JSON.stringify(tileset));
    expect((await f.resolver(f.catalog, 'example.json')).grids).toBe(hosted(f.datasets.terrain, 'cpu-grids.json'));
    expect(f.logs.join('\n')).toContain('revision mismatch');
  });

  it('falls back for the whole imagery product when a tile is absent', async () => {
    const f = fixture();
    rmSync(join(f.imagery, 'tiles/px/0/0/0.png'));
    const result = await f.resolver(f.catalog, 'example.json');
    expect(result.imagery).toBe(hosted(f.datasets.imagery, 'imagery.json'));
    expect(result.tiles).toBe(f.catalog.tiles);
  });

  it.each(['partial', 'absent'])('local-only preserves %s output without completeness checks', async (state) => {
    const f = fixture({ mode: 'local' });
    rmSync(state === 'partial' ? join(f.terrain, 'cpu-grids.json') : f.terrain, { recursive: true });
    expect(await f.resolver(f.catalog, 'example.json')).toEqual(f.catalog);
    expect(f.logs.join('\n')).toContain('DEV_DATA_MODE=local; completeness checks skipped');
  });

  it('keeps unpublished products local and warns when unavailable without rejecting the catalog', async () => {
    const f = fixture();
    f.datasets.terrain.build = null;
    expect(await f.resolver(f.catalog, 'example.json')).toEqual(f.catalog);
    rmSync(f.terrain, { recursive: true });
    const fresh = createDevCatalogResolver({ root: f.root, datasets: f.datasets, log: (m) => f.logs.push(m) });
    expect(await fresh(f.catalog, 'example.json')).toEqual(f.catalog);
    expect(f.logs.join('\n')).toContain('no pinned hosted build. Generate/fetch terrain');
    expect(f.logs.join('\n')).toContain('Local URLs retained; missing assets will return 404');
  });

  it('does not rewrite NASA services, textures, models, unknown paths or arbitrary URLs', async () => {
    const f = fixture();
    const catalog = { urls: ['https://trek.nasa.gov/data/terrain/', 'https://elsewhere/data/terrain/tileset.json', '//external/data/terrain/', 'textures/moon.jpg', 'models/craft.glb', 'data/unmanaged/tileset.json'] };
    expect(await f.resolver(catalog, 'example.json')).toEqual(catalog);
    expect(f.logs).toHaveLength(0);
  });

  it('resolves nested catalogs and keeps local nested datasets out of broader hosted prefixes', async () => {
    const f = fixture();
    writeKernels(join(f.root, 'kernels', 'nested'));
    const datasets = {
      generic: { kind: 'kernels', name: 'generic', localDir: 'kernels', catalogPrefix: 'kernels/', build: 'v1' },
      nested: { kind: 'kernels', name: 'nested', localDir: 'kernels/nested', catalogPrefix: 'kernels/nested/', build: null },
    };
    const resolver = createDevCatalogResolver({ root: f.root, datasets, log: () => {} });
    expect(await resolver(['../kernels/missing.bsp', '../kernels/nested/a.bsp'], 'base/moon.json')).toEqual([
      hosted(datasets.generic, 'missing.bsp'), '../kernels/nested/a.bsp',
    ]);
  });

  it('selects all referenced kernels together when one is missing', async () => {
    const f = fixture();
    writeKernels(join(f.root, 'kernels'));
    const ds = { kind: 'kernels', name: 'generic', localDir: 'kernels', catalogPrefix: 'kernels/', build: 'v1' };
    const resolver = createDevCatalogResolver({ root: f.root, datasets: { kernels: ds }, log: () => {} });
    expect(await resolver(['kernels/a.bsp', 'kernels/missing.bsp'], 'a.json')).toEqual([
      hosted(ds, 'a.bsp'), hosted(ds, 'missing.bsp'),
    ]);
  });

  it('prefers a complete quantized-mesh pyramid but falls back if tileCount is incomplete', async () => {
    const f = fixture();
    writePyramid(join(f.root, 'pyramid'), 0);
    const ds = { kind: 'terrain', name: 'pyramid', localDir: 'pyramid', catalogPrefix: 'data/pyramid/', build: 'v1' };
    const options = { root: f.root, datasets: { pyramid: ds }, log: () => {} };
    const catalog = { url: 'data/pyramid/' };
    expect(await createDevCatalogResolver(options)(catalog, 'a.json')).toEqual(catalog);
    rmSync(join(f.root, 'pyramid', '0', '0', '0.terrain'));
    expect((await createDevCatalogResolver(options)(catalog, 'a.json')).url).toBe(hosted(ds, ''));
  });

  it.each([true, false])('accepts uniform quantized-mesh encoding (gzip=%s)', async (gzip) => {
    const f = fixture();
    writePyramid(join(f.root, 'pyramid'), { gzip, maxZoom: 1 });
    const ds = { kind: 'terrain', name: 'pyramid', localDir: 'pyramid', catalogPrefix: 'data/pyramid/', build: 'v1' };
    const resolver = createDevCatalogResolver({ root: f.root, datasets: { pyramid: ds }, log: () => {} });
    expect(await resolver('data/pyramid/', 'a.json')).toBe('data/pyramid/');
  });

  it('falls back for mixed gzip/raw terrain even when the changed tile is not a header sample', async () => {
    const f = fixture();
    writePyramid(join(f.root, 'pyramid'), { maxZoom: 2 });
    writeFileSync(join(f.root, 'pyramid/1/0/1.terrain'), quadTile());
    const ds = { kind: 'terrain', name: 'pyramid', localDir: 'pyramid', catalogPrefix: 'data/pyramid/', build: 'v1' };
    const resolver = createDevCatalogResolver({ root: f.root, datasets: { pyramid: ds }, log: (m) => f.logs.push(m) });
    expect(await resolver('data/pyramid/', 'a.json')).toBe(hosted(ds, ''));
    expect(f.logs.join('\n')).toContain('mixed tile encodings');
  });

  it('keeps the real Ingenuity catalog usable without unpublished Mars terrain', async () => {
    const f = fixture();
    const datasets = loadDatasets().datasets;
    const catalog = JSON.parse(readFileSync(join(ROOT, 'apps/viewer/test-catalogs/ingenuity-jezero.json'), 'utf8'));
    const resolver = createDevCatalogResolver({ root: f.root, datasets, log: (m) => f.logs.push(m) });
    const body = JSON.stringify(await resolver(catalog, 'ingenuity-jezero.json'));
    expect(body).toContain('data/mars-terrain-fused/');
    expect(f.logs.join('\n')).toContain('no pinned hosted build');
    expect(f.logs.join('\n')).toContain('Local URLs retained');
  });

  it('resolves the real MoonFall catalog against its two pinned products in an empty checkout', async () => {
    const f = fixture();
    const datasets = loadDatasets().datasets;
    const catalog = JSON.parse(readFileSync(join(ROOT, 'apps/viewer/test-catalogs/moonfall-shackleton.json'), 'utf8'));
    const resolver = createDevCatalogResolver({ root: f.root, datasets, log: () => {} });
    const body = JSON.stringify(await resolver(catalog, 'moonfall-shackleton.json'));
    for (const [id, file] of [
      ['cube-terrain/moon-terrain-cube', 'tileset.json'],
      ['cube-terrain/moon-terrain-cube', 'cpu-grids.json'],
      ['cube-imagery/moon-imagery-cube-wac-nac', 'imagery.json'],
    ]) expect(body).toContain(hosted(datasets[id], file));
    expect(body).not.toContain('/test-catalogs/data/moon-terrain-cube/');
  });

  it('rejects mistyped modes and invalid data hosts', () => {
    expect(() => fixture({ mode: 'oops' })).toThrow('DEV_DATA_MODE');
    expect(() => fixture({ baseUrl: '/relative' })).toThrow('DATA_BASE_URL');
  });
});
