import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { absolutizeCatalogAssets, resolveCatalogRelative } from '../catalog-assets';

describe('resolveCatalogRelative', () => {
  const cat = 'https://mission.example/catalogs/scenes/main.json';

  it('resolves against the catalog, not the page', () => {
    expect(resolveCatalogRelative('models/sc.glb', cat)).toBe('https://mission.example/catalogs/scenes/models/sc.glb');
    expect(resolveCatalogRelative('./models/sc.glb', cat)).toBe('https://mission.example/catalogs/scenes/models/sc.glb');
    expect(resolveCatalogRelative('../models/sc.glb', cat)).toBe('https://mission.example/catalogs/models/sc.glb');
    expect(resolveCatalogRelative('../../../../x.png', cat)).toBe('https://mission.example/x.png');
    expect(resolveCatalogRelative('../tiles/', cat)).toBe('https://mission.example/catalogs/tiles/');
    expect(resolveCatalogRelative('..', cat)).toBe('https://mission.example/catalogs/');
  });

  it('leaves absolute and root-relative references on their own terms', () => {
    expect(resolveCatalogRelative('https://cdn.example/a.jpg', cat)).toBe('https://cdn.example/a.jpg');
    expect(resolveCatalogRelative('data:image/png;base64,AAAA', cat)).toBe('data:image/png;base64,AAAA');
    expect(resolveCatalogRelative('//cdn.example/a.jpg', cat)).toBe('https://cdn.example/a.jpg');
    expect(resolveCatalogRelative('/terrain/', cat)).toBe('https://mission.example/terrain/');
  });

  it('keeps template characters and query strings as written', () => {
    expect(resolveCatalogRelative('../tiles/{z}/{y}/{x}.jpg', cat)).toBe('https://mission.example/catalogs/tiles/{z}/{y}/{x}.jpg');
    expect(resolveCatalogRelative('tex/mars_%level_%column_%row.dds', cat)).toBe(
      'https://mission.example/catalogs/scenes/tex/mars_%level_%column_%row.dds',
    );
    expect(resolveCatalogRelative('../a.jpg?v=../2#x', cat)).toBe('https://mission.example/catalogs/a.jpg?v=../2#x');
  });
});

describe('absolutizeCatalogAssets', () => {
  it('pins a nested remote catalog’s model and textures to that catalog', () => {
    const url = 'https://mission.example/catalogs/scenes/main.json';
    const catalog = {
      version: '1.0',
      name: 'Main',
      items: [
        {
          name: 'Spacecraft',
          trajectory: { type: 'InterpolatedStates', source: 'eph/sc.xyzv' },
          geometry: { type: 'Mesh', source: '../models/spacecraft.glb', size: 0.01 },
        },
        {
          name: 'Planet',
          geometry: {
            type: 'Globe',
            radius: 1000,
            baseMap: '../textures/planet.jpg',
            normalMap: 'textures/planet-normal.jpg',
            terrain: {
              type: 'quantized-mesh',
              url: '../terrain/',
              imagery: [{ url: '../tiles/{z}/{y}/{x}.jpg' }, { url: 'https://trek.example/{z}/{y}/{x}.jpg' }],
            },
            surfaceTiles: [{ name: 'Site', url: 'site/tileset.json' }],
          },
          items: [
            { name: 'Ring', geometry: { type: 'Rings', innerRadius: 1, outerRadius: 2, texture: '../textures/rings.png' } },
          ],
        },
        {
          name: 'Tiled',
          geometry: { type: 'Globe', radius: 1, baseMap: { type: 'NameTemplate', template: 'tex/t_%level_%column_%row.dds' } },
        },
      ],
    };
    absolutizeCatalogAssets(catalog, url);
    const [sc, planet, tiled] = catalog.items as any[];

    expect(sc.geometry.source).toBe('https://mission.example/catalogs/models/spacecraft.glb');
    // Trajectory data stays as written: the viewer pre-fetches it keyed by that path.
    expect(sc.trajectory.source).toBe('eph/sc.xyzv');

    expect(planet.geometry.baseMap).toBe('https://mission.example/catalogs/textures/planet.jpg');
    expect(planet.geometry.normalMap).toBe('https://mission.example/catalogs/scenes/textures/planet-normal.jpg');
    expect(planet.geometry.terrain.url).toBe('https://mission.example/catalogs/terrain/');
    expect(planet.geometry.terrain.imagery.map((i: any) => i.url)).toEqual([
      'https://mission.example/catalogs/tiles/{z}/{y}/{x}.jpg',
      'https://trek.example/{z}/{y}/{x}.jpg',
    ]);
    expect(planet.geometry.surfaceTiles[0].url).toBe('https://mission.example/catalogs/scenes/site/tileset.json');
    expect(planet.items[0].geometry.texture).toBe('https://mission.example/catalogs/textures/rings.png');
    expect(tiled.geometry.baseMap.template).toBe('https://mission.example/catalogs/scenes/tex/t_%level_%column_%row.dds');
  });
});

describe('the repository catalogs', () => {
  const ROOT = fileURLToPath(new URL('../../../test-catalogs/', import.meta.url));
  const SKIP_DIRS = new Set(['data', 'models', 'textures', 'kernels', 'ephemerides', 'draco']);

  function catalogFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(name)) out.push(...catalogFiles(full));
      } else if (name.endsWith('.json') && name !== 'index.json') out.push(full);
    }
    return out.sort();
  }

  /** Every asset URL the renderer would load from this catalog. */
  function assetUrls(node: unknown, out: string[] = []): string[] {
    if (Array.isArray(node)) node.forEach((n) => assetUrls(n, out));
    else if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      const take = (v: unknown) => typeof v === 'string' && out.push(v);
      if (o.type === 'Mesh') take(o.source);
      if (o.type === 'Globe') ['baseMap', 'normalMap', 'displacementMap', 'bumpMap'].forEach((k) => take(o[k]));
      if (o.type === 'Rings') take(o.texture);
      Object.values(o).forEach((v) => assetUrls(v, out));
    }
    return out;
  }

  // Catalogs resolve their own assets. This guards the `base/` library in
  // particular, whose textures once only loaded relative to the viewer page.
  it('reference model and texture files that exist, relative to each catalog', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const file of catalogFiles(ROOT)) {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      absolutizeCatalogAssets(json, pathToFileURL(file).href);
      for (const url of assetUrls(json)) {
        if (!url.startsWith('file:')) continue; // remote assets aren't this test's business
        checked++;
        if (!existsSync(fileURLToPath(url))) missing.push(`${relative(ROOT, file)} -> ${url}`);
      }
    }
    expect(checked).toBeGreaterThan(50); // guards against a vacuous pass
    expect(missing).toEqual([]);
  });
});
