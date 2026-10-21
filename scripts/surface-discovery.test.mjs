import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fetchOdeMarsMetadata, normalizeOdeMarsProduct, odeMarsUrl, odeFootprint, replayOdeMarsMetadata } from './ode-mars-metadata.mjs';
const fixture = async n => JSON.parse(await readFile(resolve('docs/examples/surface-plans/evidence', n), 'utf8'));
const query = { mission: 'mro', instrument: 'ctx', productType: 'edr', minLat: 18.3, maxLat: 18.6, westernLon: 77.2, easternLon: 77.7 };
const response = rows => new Response(JSON.stringify({ ODEResults: { Status: 'Success', Products: { Product: rows } } }));
const raw = (id) => ({ pdsid: id, Target_name: 'MARS', ihid: 'MRO', iid: 'CTX', pt: 'EDR', Map_scale: '6',
  ProductURL: 'https://ode.rsl.wustl.edu/mars', Footprint_geometry: 'POLYGON ((77 18, 78 18, 78 19, 77 19, 77 18))' });
describe('documented PDS ODE live2 adapter (#249)', () => {
  it('replays actual live smoke with advancing 1-based offsets into validated inventory records', async () => {
    const cache = await fixture('jezero-ctx-live.cache.json'), a = await replayOdeMarsMetadata(cache), b = await replayOdeMarsMetadata(cache);
    expect(a).toEqual(b); expect(a.records.map(r => r.descriptor.productId)).toEqual([
      'P02_001820_1984_XI_18N282W', 'P03_002387_1987_XI_18N282W', 'P04_002664_1988_XI_18N282W', 'P04_002743_1987_XI_18N282W',
    ]);
    expect(a.records.every(r => r.descriptor.footprint && r.descriptor.metadata && r.descriptor.nodata === 'unknown')).toBe(true);
    expect(a.pages.map(p => new URL(p.url).searchParams.get('offset'))).toEqual(['1', '3']);
    expect(a.diagnostics.at(-1).code).toBe('ode-page-cap');
  });
  it('preserves archive footprint, native/source sampling, assets, timing and illumination without fabricating masks or DEMs', () => {
    const record = normalizeOdeMarsProduct({ ...raw('CTX_TEST'), Incidence_angle: '45', UTC_start_time: '2011-01-01T00:00:00',
      Product_files: { Product_file: { FileName: 'CTX_TEST.IMG', Type: 'Product', Description: 'PRODUCT DATA FILE WITH LABEL', KBytes: '123', URL: 'https://example.test/CTX_TEST.IMG' } } });
    expect(record.descriptor).toMatchObject({ nativeGsdM: 6, accuracyM: null, nodata: 'unknown', asset: { bytes: 123000 } });
    expect(record.descriptor.metadata).toMatchObject({ illumination: { incidenceDeg: 45 }, acquisitionUtc: '2011-01-01T00:00:00', stereoProductIds: [] });
    expect(normalizeOdeMarsProduct({ ...raw('X'), pt: 'NOT_SUPPORTED' })).toBeNull();
    expect(normalizeOdeMarsProduct({ ...raw('X'), Target_name: 'MOON' })).toBeNull();
    expect(normalizeOdeMarsProduct({})).toBeNull();
  });
  it('requires a full supported search tuple and region, refuses arbitrary URLs and bounds abuse', async () => {
    expect(odeMarsUrl(query)).toContain('target=mars');
    expect(odeMarsUrl({ mission: 'mex', instrument: 'hrsc', productType: 'dtmrdr', productId: '*DT4*' })).toContain('productid=');
    expect(odeMarsUrl({ ...query, westernLon: 359, easternLon: 1 })).toContain('westernlon=359');
    for (const q of ['https://example.invalid/mars', { ...query, productType: '' }, { ...query, minLat: -100 }, { ...query, url: 'https://example.test' }])
      await expect(fetchOdeMarsMetadata(q)).rejects.toThrow();
    await expect(fetchOdeMarsMetadata(query, { pageSize: 17 })).rejects.toThrow(/ODE limits/);
  });
  it('handles singleton/empty product envelopes, repeated pages, oversized responses and partial failures', async () => {
    const singleton = await fetchOdeMarsMetadata(query, { fetchImpl: async () => response(raw('ONE')) });
    expect(singleton.records).toHaveLength(1);
    const empty = await fetchOdeMarsMetadata(query, { fetchImpl: async () => response(null) }); expect(empty.records).toEqual([]);
    const repeated = await fetchOdeMarsMetadata(query, { pageSize: 1, fetchImpl: async () => response(raw('ONE')) });
    expect(repeated.records).toHaveLength(1); expect(repeated.diagnostics.at(-1).code).toBe('ode-repeated-page');
    let count = 0;
    const partial = await fetchOdeMarsMetadata(query, { pageSize: 1, fetchImpl: async () => ++count === 1 ? response(raw('ONE')) : new Response('offline', { status: 503 }) });
    expect(partial.records).toHaveLength(1); expect(partial.diagnostics.at(-1).message).toContain('503');
    const large = await fetchOdeMarsMetadata(query, { fetchImpl: async () => new Response('a'.repeat(1024 * 1024 + 1)) });
    expect(large.diagnostics[0].message).toContain('1 MiB');
    const invalid = await fetchOdeMarsMetadata(query, { fetchImpl: async () => new Response('{"wrong":true}') });
    expect(invalid.diagnostics[0].message).toContain('envelope');
    const error = await fetchOdeMarsMetadata(query, { fetchImpl: async () => new Response('{"ODEResults":{"Status":"ERROR","Error":"wrong IIPT"}}') });
    expect(error.diagnostics[0].message).toContain('ERROR');
    const redirected = await fetchOdeMarsMetadata(query, { fetchImpl: async (_url, opts) => { expect(opts.redirect).toBe('error'); throw new Error('redirect rejected'); } });
    expect(redirected.diagnostics[0].code).toBe('ode-unavailable');
  });
  it('parses multipolygons with holes/dateline without dropping rings or accepting unsupported WKT', () => {
    const f = odeFootprint('MULTIPOLYGON (((179 0, 181 0, 181 1, 179 1, 179 0), (179.2 .2, 179.4 .2, 179.4 .4, 179.2 .4, 179.2 .2)))');
    expect(f.features[0].geometry.coordinates[0]).toHaveLength(2);
    for (const wkt of ['POLYGON EMPTY', 'POINT (1 2)', 'POLYGON ((1 2, 2 3))', 'POLYGON ((0 0, 1 0, 1 100, 0 0))', 'POLYGON ((NaN 0))']) expect(odeFootprint(wkt)).toBeNull();
  });
  it('verifies cached primary evidence integrity and deterministic inventory regeneration', async () => {
    const manifest = await fixture('manifest.json');
    for (const e of manifest.entries) {
      const bytes = await readFile(resolve('docs/examples/surface-plans/evidence', e.file));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(e.sha256);
    }
    const paths = ['jezero', 'gale'].map(r => resolve(`docs/examples/surface-plans/mars-${r}.inventory.json`));
    const before = await Promise.all(paths.map(p => readFile(p, 'utf8')));
    const result = spawnSync(process.execPath, ['scripts/build-mars-discovery-inventories.mjs'], { encoding: 'utf8' });
    expect(result.status).toBe(0); expect(await Promise.all(paths.map(p => readFile(p, 'utf8')))).toEqual(before);
  });
});
describe('offline discovery and #248 estimator CLI integration', () => {
  const run = (...args) => spawnSync(process.execPath, [resolve('scripts/discover-surface.mjs'), ...args], { encoding: 'utf8', timeout: 20000 });
  const plan = resolve('docs/examples/surface-plans/jezero.plan.json'), inv = resolve('docs/examples/surface-plans/mars-jezero.inventory.json');
  it('produces stable independent Jezero/Gale reports and compact combinations with honest coverage', () => {
    for (const r of ['jezero', 'gale']) {
      const args = [resolve(`docs/examples/surface-plans/${r}.plan.json`), '--inventory', resolve(`docs/examples/surface-plans/mars-${r}.inventory.json`)];
      const a = run(...args), b = run(...args); expect(a.status).toBe(0); expect(a.stdout).toBe(b.stdout);
      const report = JSON.parse(a.stdout);
      expect(report.combinations).toHaveLength(r === 'jezero' ? 3 : 2);
      expect(report.recommendations.every(v => v.status !== 'verified-complete')).toBe(true);
      expect(report.estimatorHandoff.buildLock).toBe(false);
    }
  });
  it('feeds only top recommended sources to estimator and exports the complete inventory separately', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'surface-discovery-'));
    try {
      const selectedPath = join(dir, 'selected.json'), allPath = join(dir, 'all.json');
      const output = run(plan, '--inventory', inv, '--sources-out', selectedPath, '--inventory-out', allPath);
      expect(output.status).toBe(0);
      const report = JSON.parse(output.stdout), selected = JSON.parse(await readFile(selectedPath, 'utf8')), all = JSON.parse(await readFile(allPath, 'utf8'));
      expect(selected.map(s => s.id)).toEqual(report.recommendedSourceIds);
      expect(selected.length).toBeLessThan(all.length);
      expect(selected.every(s => s.metadata.evidenceUrl.startsWith('https://'))).toBe(true);
      const estimate = spawnSync(process.execPath, ['scripts/plan-surface.mjs', plan, '--sources', selectedPath], { encoding: 'utf8' });
      expect(estimate.status).toBe(0);
      expect(estimate.stdout).toContain('unknown');
      expect(estimate.stdout).not.toContain('locked-surface-plan');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('uses ODE replay in the same recommendation pipeline and preserves partial offline failure diagnostics', async () => {
    const cache = resolve('docs/examples/surface-plans/evidence/jezero-ctx-live.cache.json');
    const output = run(plan, '--inventory', inv, '--ode-cache', cache);
    expect(output.status).toBe(0);
    const report = JSON.parse(output.stdout);
    expect(report.ode.records).toHaveLength(4);
    expect(report.recommendations.flatMap(r => r.candidates).some(c => c.productId === 'P03_002387_1987_XI_18N282W')).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), 'surface-ode-offline-'));
    try {
      const path = join(dir, 'empty-cache.json');
      await writeFile(path, JSON.stringify({ query, pageSize: 2, maxPages: 2, pages: [] }));
      const failed = run(plan, '--inventory', inv, '--ode-cache', path);
      expect(failed.status).toBe(0); expect(JSON.parse(failed.stdout).diagnostics.some(d => d.code === 'ode-unavailable')).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('rejects invalid options, conflicting live/cache choices and overwriting any input', () => {
    expect(run('--help').stdout).toContain('discover:surface');
    expect(run(plan, '--inventory', inv, '--typo').status).toBe(2);
    expect(run(plan, '--inventory', inv, '--sources-out', inv).status).toBe(2);
    expect(run(plan, '--inventory', inv, '--sources-out', '/tmp/a.json', '--inventory-out', '/tmp/a.json').status).toBe(2);
    expect(run(plan, '--inventory', inv, '--ode-query', inv, '--ode-cache', inv).status).toBe(2);
    expect(run(plan, '--inventory', inv, '--ode-cache', inv, '--out', inv).status).toBe(2);
  });
});
