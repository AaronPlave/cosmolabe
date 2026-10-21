import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fetchOdeMarsMetadata, normalizeOdeMarsProduct } from './ode-mars-metadata.mjs';
const template = 'https://pilot.rsl.wustl.edu/api/v1/search/products/metadata/mars/page/{page}/size/{pageSize}';
const sample = (id) => ({
  pds3ProductId: id, mission: 'MRO', instrument: 'HiRISE',
  productType: 'DTM', productVersionId: '1', detailUrl: 'https://ode.rsl.wustl.edu/mars',
  observationStartUtc: '2016-01-01T00:00:00',
});
describe('opt-in PDS ODE Mars adapter (#249)', () => {
  it('normalizes only documented fields and makes no geometry or DTM accuracy claims', () => {
    expect(normalizeOdeMarsProduct(sample('DTEEC_TEST'))).toMatchObject({
      productId: 'DTEEC_TEST', nativeGsdM: null, footprint: null,
      validPixelCoverage: null, accuracyM: null, instrument: 'HiRISE',
    });
    expect(normalizeOdeMarsProduct({ productType: 'DTM' })).toBeNull();
  });
  it('uses bounded pagination with deterministic identity de-duplication', async () => {
    const seen = [];
    const result = await fetchOdeMarsMetadata(template, {
      pageSize: 2, maxPages: 4,
      fetchImpl: async url => {
        seen.push(url);
        const page = Number(url.match(/page\/(\d+)/)[1]);
        return new Response(JSON.stringify(page === 1 ? [sample('A'), sample('B')] :
          page === 2 ? [sample('B'), sample('C')] : []), { status: 200 });
      },
    });
    expect(result.observations.map(o => o.productId)).toEqual(['A', 'B', 'C']);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toContain('/page/1/size/2');
  });
  it('reports failures and unexpected format as partial, not empty verified coverage', async () => {
    const response = await fetchOdeMarsMetadata(template, { fetchImpl: async () => new Response('upstream error', { status: 503 }) });
    expect(response.diagnostics[0].code).toBe('ode-unavailable');
    const unknown = await fetchOdeMarsMetadata(template, { fetchImpl: async () => new Response('{"wrapper":{"unrecognized":[]}}') });
    expect(unknown.diagnostics[0].code).toBe('ode-unrecognized-payload');
  });
  it('rejects unapproved hosts, paging abuse and suspicious API redirects', async () => {
    await expect(fetchOdeMarsMetadata('https://example.invalid/mars/{page}/{pageSize}')).rejects.toThrow(/ODE Mars metadata|Mars ODE metadata/);
    await expect(fetchOdeMarsMetadata(template, { pageSize: 999 })).rejects.toThrow(/ODE limits/);
    const redirected = await fetchOdeMarsMetadata(template, {
      fetchImpl: async (_url, opts) => {
        expect(opts.redirect).toBe('error');
        throw new Error('redirect rejected');
      },
    });
    expect(redirected.diagnostics[0].code).toBe('ode-unavailable');
  });
});
describe('offline source discovery CLI', () => {
  const run = (...args) => spawnSync(process.execPath,
    [resolve('scripts/discover-surface.mjs'), ...args], { encoding: 'utf8', timeout: 20000 });
  const plan = resolve('docs/examples/surface-plans/jezero.plan.json');
  const inv = resolve('docs/examples/surface-plans/mars-jezero.inventory.json');
  it('produces a reproducible source report without network access', () => {
    const a = run(plan, '--inventory', inv), b = run(plan, '--inventory', inv);
    expect(a.status).toBe(0); expect(a.stdout).toBe(b.stdout);
    const report = JSON.parse(a.stdout);
    expect(report.recommendations).toHaveLength(6);
    expect(report.recommendations.every(r => r.status !== 'verified-candidate')).toBe(true);
    expect(a.stderr).toBe('');
  });
  it('rejects unknown flags and overwriting inputs', () => {
    expect(run('--help').stdout).toContain('discover:surface');
    expect(run(plan, '--inventory', inv, '--typo').status).toBe(2);
    expect(run(plan, '--inventory', inv, '--out', inv).status).toBe(2);
  });
});
