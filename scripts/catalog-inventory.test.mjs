import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogInventory, validateIndex } from './catalog-inventory.mjs';

const root = fileURLToPath(new URL('../apps/viewer/test-catalogs/', import.meta.url));
const read = name => JSON.parse(readFileSync(`${root}/${name}`, 'utf8'));

describe('curated catalog discovery', () => {
  const publicIndex = read('index.json');
  const devIndex = read('dev-index.json');
  it('keeps twelve distinct experiences and six representative featured entries', () => {
    const groups = publicIndex.catalogs.reduce((counts, e) => ({ ...counts, [e.group]: (counts[e.group] ?? 0) + 1 }), {});
    expect(groups).toEqual({ Explore: 2, Missions: 9, Tours: 1 });
    expect(publicIndex.catalogs.filter(e => e.featured)).toHaveLength(6);
    expect(publicIndex.catalogs.find(e => e.id === 'base/solarsys').featured).toBe(true);
    const ids = publicIndex.catalogs.map(e => e.id);
    expect(ids).toEqual(['base/solarsys', 'iss', 'europa-clipper', 'cassini-soi', 'ingenuity-jezero', 'voyagers', 'lro-moon', 'moonfall-shackleton', 'msl-dingo-gap', 'rosetta', 'psyche', 'earth-moon-tour']);
    expect(publicIndex.catalogs.find(e => e.id === 'earth-moon-tour').script).toBe('./earth-moon-tour.cosmo');
  });
  it('retains regression families and technical direct-load scenes in a separate index', () => {
    const paths = devIndex.catalogs.map(e => e.catalog);
    expect(paths.filter(p => p.startsWith('./atmosphere-'))).toHaveLength(8);
    expect(paths.filter(p => p.startsWith('./geographic-vectors'))).toHaveLength(8);
    expect(paths.filter(p => p.startsWith('./experiments/moon-'))).toHaveLength(7);
    for (const id of ['earth-moon', 'planetary-places', 'oem-ingest', 'sensor-demo', 'arrokoth-dsk', 'solar-system', 'inner-planets-keplerian', 'rotation-demo', 'io-volcanos', 'mars-cube-imagery-experiment']) {
      expect(paths).toContain(`./${id}.json`);
    }
    for (const id of ['mars-imagery-jezero', 'moon-imagery-apollo15']) {
      expect(paths).toContain(`./${id}.json`);
      expect(JSON.stringify(read(`${id}.json`))).not.toMatch(/"terrain"\s*:/);
    }
    // Neither the named-place datasets nor the OEM / SPK / DSK assets disappear.
    const report = catalogInventory();
    expect(report.catalogGraph).toContain('base/earth-system.json');
    for (const path of ['places/mars.json', 'places/moon.json', 'base/main-belt-300.json']) {
      expect(report.catalogGraph).toContain(path);
    }
    expect(report.dependencies.some(d => d.path.endsWith('.oem'))).toBe(true);
    expect(report.dependencies.some(d => /\.bds(\.gz)?$/.test(d.path))).toBe(true);
    expect(report.dependencies.some(d => /\.bsp(\.gz)?$/.test(d.path))).toBe(true);
  });
  it('rejects duplicate ids, missing files, escaping paths and missing groups', () => {
    const entry = publicIndex.catalogs[0];
    for (const catalogs of [[entry, entry], [{ ...entry, catalog: './absent.json' }], [{ ...entry, catalog: './../package.json' }], [{ ...entry, group: '' }], [{ ...entry, script: './absent.cosmo' }]]) {
      expect(() => validateIndex({ version: 1, catalogs }, root)).toThrow();
    }
  });
});

describe('bundle inventory guards', () => {
  it('checks shipped scripts and require dependencies and reports missing optional local assets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-inventory-'));
    const root = join(dir, 'source');
    const dist = join(dir, 'dist');
    const shipped = join(dist, 'test-catalogs');
    mkdirSync(root, { recursive: true });
    mkdirSync(shipped, { recursive: true });
    const write = (base, name, value) => writeFileSync(join(base, name), JSON.stringify(value));
    try {
      write(root, 'index.json', { version: 1, catalogs: [{ id: 'a', name: 'A', group: 'Explore', description: 'Example', catalog: './a.json', script: './a.cosmo' }] });
      write(root, 'dev-index.json', { version: 1, catalogs: [] });
      const a = { require: ['b.json'], source: 'keep.oem' };
      write(root, 'a.json', a);
      write(root, 'b.json', { items: [] });
      writeFileSync(join(root, 'a.cosmo'), 'wait 1');
      write(shipped, 'a.json', a);
      expect(() => catalogInventory({ root, dist })).toThrow(/script missing/);
      writeFileSync(join(shipped, 'a.cosmo'), 'wait 1');
      expect(() => catalogInventory({ root, dist })).toThrow(/catalog dependency missing/);
      write(shipped, 'b.json', { items: [] });
      const report = catalogInventory({ root, dist });
      expect(report.bundle.listed).toEqual(['a.json']);
      expect(report.bundle.unlistedScenes).toEqual(['b.json']);
      expect(report.dependencies.find(d => d.path === 'keep.oem').localPresent).toBe(false);
      rmSync(join(root, 'b.json'));
      expect(() => catalogInventory({ root, dist })).toThrow(/missing require/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
