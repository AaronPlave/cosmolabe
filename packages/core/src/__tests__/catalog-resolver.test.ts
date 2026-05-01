import { describe, it, expect } from 'vitest';
import { loadCatalogFromUrl } from '../catalog/CatalogResolver.js';
import type { CatalogJson } from '../catalog/CatalogLoader.js';

function makeFetcher(files: Record<string, CatalogJson>) {
  return async (url: string): Promise<CatalogJson> => {
    const json = files[url];
    if (!json) throw new Error(`No mock for ${url}`);
    // Return a fresh copy so accidental mutation in tests doesn't poison the fixture
    return JSON.parse(JSON.stringify(json));
  };
}

describe('loadCatalogFromUrl', () => {
  it('returns a single catalog when there are no requires', async () => {
    const files = {
      'file:///a/leaf.json': { name: 'Leaf', items: [] },
    };
    const result = await loadCatalogFromUrl('file:///a/leaf.json', makeFetcher(files));
    expect(result.catalogs).toHaveLength(1);
    expect(result.catalogs[0].url).toBe('file:///a/leaf.json');
    expect(result.catalogs[0].json.name).toBe('Leaf');
    expect(result.kernels).toEqual([]);
  });

  it('orders parents before children', async () => {
    const files: Record<string, CatalogJson> = {
      'file:///base/a.json': { name: 'A' },
      'file:///base/b.json': { name: 'B', require: ['a.json'] },
      'file:///base/c.json': { name: 'C', require: ['b.json'] },
    };
    const result = await loadCatalogFromUrl('file:///base/c.json', makeFetcher(files));
    expect(result.catalogs.map(c => c.json.name)).toEqual(['A', 'B', 'C']);
  });

  it('de-duplicates diamond requires', async () => {
    const files: Record<string, CatalogJson> = {
      'file:///base/shared.json': { name: 'Shared' },
      'file:///base/left.json':   { name: 'Left',   require: ['shared.json'] },
      'file:///base/right.json':  { name: 'Right',  require: ['shared.json'] },
      'file:///base/top.json':    { name: 'Top',    require: ['left.json', 'right.json'] },
    };
    const result = await loadCatalogFromUrl('file:///base/top.json', makeFetcher(files));
    const names = result.catalogs.map(c => c.json.name);
    expect(names.filter(n => n === 'Shared')).toHaveLength(1); // de-duped
    expect(names.indexOf('Shared')).toBeLessThan(names.indexOf('Left'));
    expect(names.indexOf('Shared')).toBeLessThan(names.indexOf('Right'));
    expect(names.indexOf('Left')).toBeLessThan(names.indexOf('Top'));
    expect(names.indexOf('Right')).toBeLessThan(names.indexOf('Top'));
  });

  it('resolves require paths relative to the parent catalog URL', async () => {
    const files: Record<string, CatalogJson> = {
      'file:///base/missions/lro.json': { name: 'LRO', require: ['../base/earth-system.json'] },
      'file:///base/base/earth-system.json': { name: 'Earth System' },
    };
    const result = await loadCatalogFromUrl('file:///base/missions/lro.json', makeFetcher(files));
    expect(result.catalogs.map(c => c.json.name)).toEqual(['Earth System', 'LRO']);
  });

  it('throws on cycles with the cycle path', async () => {
    const files: Record<string, CatalogJson> = {
      'file:///base/a.json': { name: 'A', require: ['b.json'] },
      'file:///base/b.json': { name: 'B', require: ['a.json'] },
    };
    await expect(loadCatalogFromUrl('file:///base/a.json', makeFetcher(files)))
      .rejects.toThrow(/cycle/i);
  });

  it('aggregates spiceKernels across the require graph, de-duped by absolute URL', async () => {
    const files: Record<string, CatalogJson> = {
      'file:///base/base.json': {
        name: 'Base',
        spiceKernels: [
          'kernels/naif0012.tls',
          { url: 'kernels/de440s.bsp', size: 32_000_000, label: 'Planets' },
        ],
      },
      'file:///base/mission.json': {
        name: 'Mission',
        require: ['base.json'],
        spiceKernels: [
          'kernels/naif0012.tls', // dup with base — should de-dup
          'kernels/mission/extra.bsp',
        ],
      },
    };
    const result = await loadCatalogFromUrl('file:///base/mission.json', makeFetcher(files));
    expect(result.kernels.map(k => k.url)).toEqual([
      'file:///base/kernels/naif0012.tls',
      'file:///base/kernels/de440s.bsp',
      'file:///base/kernels/mission/extra.bsp',
    ]);
    const de440 = result.kernels.find(k => k.url.endsWith('de440s.bsp'))!;
    expect(de440.size).toBe(32_000_000);
    expect(de440.label).toBe('Planets');
  });

  it('collects kernels declared at item and nested-item level', async () => {
    const files: Record<string, CatalogJson> = {
      'file:///x/cat.json': {
        name: 'Catalog',
        spiceKernels: ['kernels/top.bsp'],
        items: [
          {
            name: 'Spacecraft',
            spiceKernels: ['kernels/sc.bsp'],
            items: [
              {
                name: 'Sensor',
                spiceKernels: ['kernels/sensor.ti'],
              },
            ],
          },
        ],
      },
    };
    const result = await loadCatalogFromUrl('file:///x/cat.json', makeFetcher(files));
    expect(result.kernels.map(k => k.url)).toEqual([
      'file:///x/kernels/top.bsp',
      'file:///x/kernels/sc.bsp',
      'file:///x/kernels/sensor.ti',
    ]);
  });

  it('resolves kernel paths against each catalog\'s own URL', async () => {
    const files: Record<string, CatalogJson> = {
      'file:///root/missions/lro/lro.json': {
        name: 'LRO',
        spiceKernels: ['kernels/lro.bsp'],
      },
      'file:///root/scene.json': {
        name: 'Scene',
        require: ['missions/lro/lro.json'],
        spiceKernels: ['kernels/scene.bsp'],
      },
    };
    const result = await loadCatalogFromUrl('file:///root/scene.json', makeFetcher(files));
    expect(result.kernels.map(k => k.url)).toEqual([
      'file:///root/missions/lro/kernels/lro.bsp',
      'file:///root/kernels/scene.bsp',
    ]);
  });
});
