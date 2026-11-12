import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadDatasets, remotePrefix } from './data-hosting/lib/datasets.mjs';
import { rewriteCatalog } from './data-hosting/lib/hosted-catalogs.mjs';
import { lunarOpticalImagery } from './lib/lunar-optical-imagery.mjs';
const read = name => JSON.parse(readFileSync(new URL(`../apps/viewer/test-catalogs/${name}.json`, import.meta.url)));
const catalog = read('lro-moon');
const moon = catalog.items.find(i => i.name === 'Moon');

describe('LRO hosted lunar surface migration', () => {
  it('uses the adopted geometry, sampling, imagery and exact lunar frame', () => {
    const reference = read('moonfall-shackleton').items.find(i => i.name === 'Moon');
    expect(moon.geometry.terrain).toEqual(reference.geometry.terrain);
    expect(moon.rotationModel).toEqual(reference.rotationModel);
    expect(moon.rotationModel.bodyFrame).toBe('MOON_ME_DE421');
    expect(catalog.spiceKernels).toContain('kernels/lro/moon_080317.tf.gz');
    expect(catalog.spiceKernels).toContainEqual(expect.objectContaining({ url: 'kernels/lro/moon_pa_de421_1900_2050.bpc.gz' }));
  });

  it('rewrites the terrain and independent optical products to immutable production revisions', () => {
    const datasets = loadDatasets().datasets;
    const result = rewriteCatalog(catalog, 'test-catalogs/lro-moon.json', datasets, 'https://data.aaronplave.com');
    expect(result.unpublished).toEqual([]);
    const terrain = result.json.items.find(i => i.name === 'Moon').geometry.terrain;
    const root = 'https://data.aaronplave.com/cube-terrain/moon-terrain-cube/cube-fused-79895697c6b6-g3-m12-b6747ec9d/';
    expect(terrain.url).toBe(root + 'tileset.json');
    expect(terrain.cubeSphere.cpuGrids).toBe(root + 'cpu-grids.json');
    for (const [i, name] of ['wac', 'nac-independent', 'psr-nac-stretch'].entries()) {
      const dataset = datasets[`cube-imagery/moon-imagery-cube-${name}`];
      expect(dataset.build).toBeTruthy();
      expect(terrain.imagery[i].url).toBe(`https://data.aaronplave.com/${remotePrefix(dataset)}imagery.json`);
    }
    expect(catalog.items.find(i => i.name === 'Moon').geometry.terrain.url).toBe('data/moon-terrain-cube/tileset.json');
  });

  it('shares the generated stack, retains NAC by default, and identifies optional PSR photography', () => {
    const layers = moon.geometry.terrain.imagery;
    expect(layers).toEqual(lunarOpticalImagery());
    expect(layers.map(l => l.id)).toEqual(['wac', 'nac', 'psr-nac']);
    expect(layers[1].visible).not.toBe(false);
    expect(layers[2]).toMatchObject({ visible: false, illumination: 'baked', resolutionMeters: 10 });
    expect(layers[2].description).toContain('not calibrated reflectance or sunlight at the simulation time');
  });

  it('keeps the real mission and instrument definitions independent of surface authoring', () => {
    expect(catalog.defaultTime).toBe('2025-01-15T00:00:00Z');
    expect(catalog.defaultViewpoint).toBe('Track LRO');
    expect(catalog.items.filter(i => i.type === 'Viewpoint').map(i => i.name)).toEqual(['Moon Overview', 'Track LRO', 'LRO Close-up', 'Lunar North Pole']);
    const lro = moon.items[0];
    expect(lro.trajectory).toEqual({ type: 'Spice', target: 'LRO', center: 'MOON' });
    expect(lro.rotationModel).toEqual({ type: 'Nadir', target: 'LRO', center: 'MOON' });
    expect(lro.surfaceTrajectory).toBeUndefined();
    expect(lro.items.map(i => i.name)).toEqual(['LROC NAC Left', 'LROC WAC', 'LOLA', 'LAMP', 'Diviner', 'LEND', 'CRaTER']);
    expect(lro.items.every(i => i.geometry.target === 'Moon')).toBe(true);
    expect(catalog.spiceKernels).toContainEqual(expect.objectContaining({ url: 'kernels/lro/lrorg_2024350_2025074_v01.bsp.gz' }));
  });
});
