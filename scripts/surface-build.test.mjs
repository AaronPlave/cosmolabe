import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLockedSurfacePlan } from '../packages/core/dist/surface-plan/index.js';
import { compileBuild, inspectBindings, hashFile } from './surface-build/plan.mjs';
import { buildInventory } from './data-hosting/lib/publish.mjs';
import { runBuildCli } from './build-surface.mjs';
import { createFixture } from './surface-build/fixture.mjs';
import { executeBuild, publishLocalFixture, readCompleted } from './surface-build/run.mjs';
import { createLocalStorage } from './data-hosting/lib/storage.mjs';
import { serveStore } from './data-hosting/__tests__/helpers.mjs';

const example = resolve('docs/examples/surface-plans/synthetic-build.lock.json');
const fixture = JSON.parse(await readFile(example, 'utf8'));
const relock = async modify => {
  const { identity, desiredIdentity, ...value } = structuredClone(fixture);
  modify(value);
  return createLockedSurfacePlan(value);
};
let temp;
beforeAll(async () => { temp = await mkdtemp(join(tmpdir(), 'surface-build-test-')); });
afterAll(async () => { await rm(temp, { recursive: true, force: true }); });

describe('finite locked surface build planning', () => {
  it('produces a stable DAG with independent imagery, physical source fidelity and honest unknown resources', async () => {
    const a = await compileBuild(fixture), b = await compileBuild(fixture);
    expect(a).toEqual(b);
    expect(a.products.map(p => p.kind)).toEqual(['cube-terrain', 'cube-imagery', 'cube-imagery']);
    expect(a.nodes.find(n => n.id === 'fusion').bias).toBe('none');
    expect(a.nodes.at(-1).dependencies).toHaveLength(3);
    expect(a.resources.peakRamBytes).toBeNull();
    expect(a.resources.peakDiskBytes.max).toBeNull();
    const result = JSON.parse(await runBuildCli([example]));
    expect(result.sourcesVerified).toBe(false);
    expect(result.sources.every(s => s.state === 'missing')).toBe(true);
    expect(result.sourceDownloadBytes).toBeGreaterThan(0);
  });
  it('fails tampered locks, unknown flags and unsupported generators before execution', async () => {
    const bad = structuredClone(fixture); bad.processing.parameters.terrain.blendM++;
    await expect(compileBuild(bad)).rejects.toThrow(/Content changed/);
    await expect(runBuildCli([example, '--typo'])).rejects.toThrow();
    const lock = await relock(v => { v.processing.generator.version = 'unknown'; });
    await expect(compileBuild(lock)).rejects.toThrow(/unsupported generator/);
  });
  it('refuses version-only pins, silent bias removal, unknown transforms and mismatched resampling', async () => {
    const versionOnly = await relock(v => { v.sources[0].asset.version = 'v1'; delete v.sources[0].asset.checksum; });
    await expect(compileBuild(versionOnly)).rejects.toThrow(/requires SHA-256/);
    const bias = await relock(v => { v.processing.fusion = 'residual-plane'; });
    await expect(compileBuild(bias)).rejects.toThrow(/bias none/);
    await expect(relock(v => { v.selections[0].transformations = ['areoid-to-ellipsoid']; })).rejects.toThrow(/identity/);
    const resampling = await relock(v => { v.selections[0].resampling = 'nearest'; });
    await expect(compileBuild(resampling)).rejects.toThrow(/resampling must match/);
  });
  it('rejects unbounded tiling and finer advertised density without finer output; source/transform changes create new IDs', async () => {
    const old = await compileBuild(fixture);
    const global = await relock(v => { v.processing.parameters.terrain.globalLevel = 18; });
    await expect(compileBuild(global)).rejects.toThrow(/bounded overview/);
    const regional = await relock(v => { v.processing.parameters.imagery[1].regions = ['landing@0,0:1=2000,2=1500,3=1000,4=500,5=250']; });
    await expect(compileBuild(regional)).rejects.toThrow(/fixture levels/);
    const coarse = await relock(v => { v.processing.parameters.imagery[1].regions = []; });
    await expect(compileBuild(coarse)).rejects.toThrow(/spacing/);
    const changed = await relock(v => { v.sources[0].asset.checksum.value = 'b'.repeat(64); });
    expect((await compileBuild(changed)).buildId).not.toBe(old.buildId);
    const taper = await relock(v => { v.processing.parameters.terrain.blendM *= 2; });
    expect((await compileBuild(taper)).buildId).not.toBe(old.buildId);
  });
  it('checks content hashes even when a source has the correct byte count and never writes on dry-run', async () => {
    const dir = join(temp, 'bindings');
    const { mkdir } = await import('node:fs/promises'); await mkdir(dir);
    const bytes = Buffer.alloc(fixture.sources[0].asset.bytes, 1), path = join(dir, 'base.tif');
    await writeFile(path, bytes);
    const checksum = await hashFile(path);
    const lock = await relock(v => { v.sources[0].asset.checksum.value = checksum; });
    const before = await readdir(dir);
    expect((await inspectBindings(lock, { base: 'base.tif' }, dir))[0].state).toBe('verified');
    bytes[0] ^= 1; await writeFile(path, bytes);
    expect((await inspectBindings(lock, { base: 'base.tif' }, dir))[0].state).toBe('checksum-mismatch');
    expect(await readdir(dir)).toEqual(before);
  });
});

const python = ['/usr/bin/python3', 'python3'].find(p => spawnSync(p, ['-c', 'from osgeo import gdal; import numpy'], { stdio: 'ignore' }).status === 0);
describe.skipIf(!python)('offline GDAL fixture execution and immutable #137 publication', () => {
  it('builds, validates and reuses separate products, verifies local publication, and blocks corrupt caches or controls', async () => {
    const input = join(temp, 'fixture'), cache = join(temp, 'cache'), storeDir = join(temp, 'store');
    const { lock, bindings } = await createFixture(input, python);
    const options = { bindings, bindingsDir: input, cache, python };
    const report = await executeBuild(lock, options);
    expect(report.validation).toBe('passed-supported-gates');
    expect(report.productionReady).toBe(false);
    expect(report.products[2].maxLevel).toBeGreaterThan(report.products[0].maxLevel);
    expect(report.products[2].outputSpacingMByLevel.at(-1)).toBeLessThan(report.products[0].outputSpacingMByLevel.at(-1));
    expect(report.products[2].nativeFidelity[0].nativeGsdM).toBeGreaterThan(report.products[2].outputSpacingMByLevel.at(-1));
    expect(report.caveats.join(' ')).toContain('No observed HiRISE DTM');
    expect((await executeBuild(lock, options)).reused).toBe(true);
    const rebuilt = await executeBuild(lock, { ...options, cache: join(temp, 'second-cache') });
    expect(rebuilt.products.map(p => p.revision)).toEqual(report.products.map(p => p.revision));
    for (const product of report.products) {
      expect(await buildInventory(join(rebuilt.directory, product.id))).toEqual(await buildInventory(join(report.directory, product.id)));
    }
    const host = await serveStore(createLocalStorage(storeDir));
    try {
      const published = await publishLocalFixture(lock, { cache, localDir: storeDir, baseUrl: host.url });
      expect(published.catalogPinned).toBe(false);
      expect(published.products.every(p => p.verified)).toBe(true);
      expect((await publishLocalFixture(lock, { cache, localDir: storeDir, baseUrl: host.url })).products).toEqual(published.products);
      await expect(publishLocalFixture(lock, { cache, localDir: storeDir, baseUrl: host.url,
        fetchImpl: async () => new Response('missing', { status: 404 }) })).rejects.toThrow(/verification failed/);
      const missingControl = structuredClone(lock);
      delete missingControl.identity; delete missingControl.desiredIdentity;
      missingControl.processing.parameters.gates.controls[0].heightM += 100;
      const badLock = await createLockedSurfacePlan(missingControl);
      // A different lock cannot promote the previously completed output.
      await expect(publishLocalFixture(badLock, { cache, localDir: storeDir, baseUrl: host.url })).rejects.toThrow(/incomplete/);
      const tile = join(report.directory, report.products[0].id, 'heights/px/0/0/0.f32');
      const bytes = await readFile(tile); bytes[0] ^= 1; await writeFile(tile, bytes);
      await expect(readCompleted(report.directory, await compileBuild(lock))).rejects.toThrow(/content changed/);
      await expect(publishLocalFixture(lock, { cache, localDir: storeDir, baseUrl: host.url })).rejects.toThrow(/content changed/);
    } finally { await host.close(); }
    const sourcePng = join(input, 'detail-image.png');
    await writeFile(sourcePng, 'corrupt');
    expect((await inspectBindings(lock, bindings, input)).find(s => s.sourceId === 'detail-image').state).toBe('response-missing-or-changed');
    await expect(executeBuild(lock, options)).rejects.toThrow(/changed source/);
    // A physically bad source registration must fail before producing geometry.
    const badInput = join(temp, 'bad-registration');
    const bad = await createFixture(badInput, python);
    const detailPath = join(badInput, 'detail.tif');
    const edited = spawnSync(python, ['-c', 'from osgeo import gdal; import sys; d=gdal.Open(sys.argv[1],gdal.GA_Update); d.GetRasterBand(1).Fill(1100); d=None', detailPath]);
    expect(edited.status).toBe(0);
    const { identity, desiredIdentity, ...badPayload } = bad.lock;
    badPayload.sources.find(s => s.id === 'detail').asset.checksum.value = await hashFile(detailPath);
    const badRegistration = await createLockedSurfacePlan(badPayload);
    await expect(executeBuild(badRegistration, { ...options, bindings: bad.bindings, bindingsDir: badInput })).rejects.toThrow(/registration offset/);
    expect(await readCompleted(join(cache, (await compileBuild(badRegistration)).buildId), await compileBuild(badRegistration))).toBeNull();
  }, 300000);
});
