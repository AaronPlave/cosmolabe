import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, readdir, stat, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLockedSurfacePlan } from '../packages/core/dist/surface-plan/index.js';
import { compileBuild, inspectBindings, hashFile, buildInputs, identity as contentIdentity } from './surface-build/plan.mjs';
import { buildInventory } from './data-hosting/lib/publish.mjs';
import { runBuildCli } from './build-surface.mjs';
import { createFixture } from './surface-build/fixture.mjs';
import { executeBuild, publishLocalFixture, readCompleted } from './surface-build/run.mjs';
import { publicationPlan, publishBuild, catalogCandidate, applyCatalogCandidate } from './surface-build/publication.mjs';
import { publishedFeedback } from './surface-build/report.mjs';
import { createLocalStorage } from './data-hosting/lib/storage.mjs';
import { serveStore } from './data-hosting/__tests__/helpers.mjs';

const example = resolve('docs/examples/surface-plans/synthetic-build.lock.json');
const fixture = JSON.parse(await readFile(example, 'utf8'));
const relock = async modify => {
  const { identity, desiredIdentity, ...value } = structuredClone(fixture);
  modify(value);
  return createLockedSurfacePlan(value);
};
const outputDatum = { referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] },
  verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' };
const datumAsset = byte => ({ retrieval: 'Synthetic datum fixture', bytes: 10, checksum: { algorithm: 'sha256', value: byte.repeat(64) } });
const convert = value => {
  // The controlled areoid equals the sphere at the equator; keep the exact
  // geodetic conversion control there, independently of the interior UI site.
  value.processing.parameters.gates.controls[0] = {lat:0,lon:0,heightM:1000,toleranceM:1};
  for (const source of value.sources.filter(s => s.channel === 'elevation')) source.datum.verticalDatum = 'areoid';
  for (const selection of value.selections.filter(s => s.channel === 'elevation')) selection.transformations = [{
    kind: 'areoid-radial', areoid: { label: datumAsset('a'), image: datumAsset('b') }, outputDatum }];
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
    const patch = await relock(v => { v.processing.parameters.terrain.patches = ['unproved']; });
    await expect(compileBuild(patch)).rejects.toThrow(/unsupported field patches/);
    const coarse = await relock(v => { v.processing.parameters.imagery[1].regions = []; });
    await expect(compileBuild(coarse)).rejects.toThrow(/spacing/);
    const changed = await relock(v => { v.sources[0].asset.checksum.value = 'b'.repeat(64); });
    const changedDag=await compileBuild(changed);
    expect(changedDag.buildId).not.toBe(old.buildId);
    expect(changedDag.products.slice(1).map(p=>p.id)).toEqual(old.products.slice(1).map(p=>p.id));
    expect(changedDag.products[0].id).not.toBe(old.products[0].id);
    const taper = await relock(v => { v.processing.parameters.terrain.blendM *= 2; });
    const taperedDag=await compileBuild(taper);
    expect(taperedDag.buildId).not.toBe(old.buildId);
    expect(taperedDag.products.slice(1).map(p=>p.id)).toEqual(old.products.slice(1).map(p=>p.id));
  });
  it('pins both detached datum assets in the shared lock and DAG, with separate binding verification', async () => {
    const lock = await relock(convert);
    const dag = await compileBuild(lock);
    expect(buildInputs(lock)).toHaveLength(lock.sources.length + 2);
    expect(dag.nodes.find(n => n.id === dag.products[0].id).dependencies).toEqual([
      'fusion', 'source:datum:areoid-label', 'source:datum:areoid-image']);
    expect((await inspectBindings(lock, {}, temp)).slice(-2).map(s => s.sourceId)).toEqual(['datum:areoid-label', 'datum:areoid-image']);
    for (const role of ['label', 'image']) {
      const changed = await relock(v => { convert(v); for (const s of v.selections.filter(s => s.channel === 'elevation'))
        s.transformations[0].areoid[role].checksum.value = 'c'.repeat(64); });
      expect(changed.identity).not.toBe(lock.identity);
      expect((await compileBuild(changed)).buildId).not.toBe(dag.buildId);
      await expect(relock(v => { convert(v); delete v.selections[0].transformations[0].areoid[role].checksum; })).rejects.toThrow();
    }
    await expect(relock(v => { convert(v); v.selections[0].transformations[0].outputDatum = v.sources[0].datum; })).rejects.toThrow(/output datum/);
    await expect(relock(v => { convert(v); v.sources[0].datum.heightConvention = 'geodetic-normal'; })).rejects.toThrow(/datum must match/);
    const mixed = await relock(v => { convert(v); v.selections[2].transformations[0].areoid.image.checksum.value = 'c'.repeat(64); });
    await expect(compileBuild(mixed)).rejects.toThrow(/identical explicit transforms/);
    const file = join(temp, 'datum-bytes'); await writeFile(file, '0123456789');
    const bound = await relock(v => { convert(v); for (const s of v.selections.filter(s => s.channel === 'elevation'))
      s.transformations[0].areoid.label.checksum.value = 'a'.repeat(64); });
    expect((await inspectBindings(bound, { 'datum:areoid-label': file }, temp)).at(-2).state).toBe('checksum-mismatch');
  });
  it('retains all 73 mission controls while preserving fixture and real-profile bounds', async () => {
    const controls = n => Array.from({length:n}, (_,i) => ({lat:i/100,lon:0,heightM:1000,toleranceM:1}));
    const small = await relock(v => { v.processing.parameters.gates.controls=controls(65); });
    await expect(compileBuild(small)).rejects.toThrow(/1\.\.64/);
    const mission = n => relock(v => {
      convert(v);
      v.processing.parameters.profile='bounded-real-mars';
      v.processing.parameters.toolchain={python:'controlled',gdal:'controlled',numpy:'controlled'};
      v.processing.parameters.terrain.fusionAsset=datumAsset('c');
      v.processing.parameters.gates.controls=controls(n);
    });
    const lock=await mission(73);
    expect(lock.processing.parameters.gates.controls).toHaveLength(73);
    expect((await compileBuild(lock)).products).toHaveLength(3);
    await expect(compileBuild(await mission(128))).resolves.toBeDefined();
    await expect(compileBuild(await mission(129))).rejects.toThrow(/1\.\.128/);
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
  it('stages both pinned PDS assets and executes ellipsoidal radial conversion reproducibly', async () => {
    const input = join(temp, 'ellipsoid-input');
    const { lock: original, bindings } = await createFixture(input, python);
    const { identity, desiredIdentity, ...payload } = structuredClone(original);
    convert(payload);
    for (const selection of payload.selections.filter(s => s.channel === 'elevation')) for (const [role, filename] of [
      ['label', 'MEGA90N000EB.LBL'], ['image', 'MEGA90N000EB.IMG']]) {
      const file = join(input, filename);
      selection.transformations[0].areoid[role] = { retrieval: 'Controlled synthetic PDS datum',
        bytes: (await stat(file)).size, checksum: { algorithm: 'sha256', value: await hashFile(file) } };
      bindings['datum:areoid-' + role] = filename;
    }
    const lock = await createLockedSurfacePlan(payload);
    const options = { bindings, bindingsDir: input, python, workers: 1 };
    const a = await executeBuild(lock, { ...options, cache: join(temp, 'ellipsoid-a') });
    expect(a.products[0].datum).toEqual(outputDatum);
    expect(a.products[0].controls[0].errorM).toBeCloseTo(0, 3);
    const grids = JSON.parse(await readFile(join(a.directory, a.products[0].id, 'cpu-grids.json')));
    expect(grids.geometry.kind).toBe('radial-lattice');
    const b = await executeBuild(lock, { ...options, cache: join(temp, 'ellipsoid-b') });
    for (const product of a.products) expect(await buildInventory(join(b.directory, product.id)))
      .toEqual(await buildInventory(join(a.directory, product.id)));
    // A label may not resolve a different image, even if the new label itself
    // has a valid content pin. The worker must not read any unpinned dependency.
    const label = join(input, 'MEGA90N000EB.LBL');
    await writeFile(label, (await readFile(label, 'utf8')).replace('^IMAGE = "MEGA90N000EB.IMG"', '^IMAGE = "other.IMG"'));
    for (const s of payload.selections.filter(s => s.channel === 'elevation')) {
      s.transformations[0].areoid.label.bytes = (await stat(label)).size;
      s.transformations[0].areoid.label.checksum.value = await hashFile(label);
    }
    const bad = await createLockedSurfacePlan(payload);
    await expect(executeBuild(bad, { ...options, cache: join(temp, 'ellipsoid-bad') })).rejects.toThrow(/unsupported detached areoid/);
  }, 300000);
  it('executes a pinned existing fusion with projected masked DEMs and native raster imagery', async () => {
    const input = join(temp, 'projected-input');
    const { lock: original, bindings } = await createFixture(input, python);
    const projected = spawnSync(python, ['-c', `
from osgeo import gdal,osr
import numpy as np,sys,json
from pathlib import Path
root=Path(sys.argv[1]); k=3396190*np.pi/180
s=osr.SpatialReference();s.ImportFromProj4('+proj=eqc +lat_ts=0 +lon_0=0 +R=3396190 +units=m +no_defs')
d=gdal.Open(str(root/'detail.tif'),gdal.GA_Update);gt=d.GetGeoTransform();d.SetGeoTransform(tuple(v*k for v in gt));d.SetProjection(s.ExportToWkt());b=d.GetRasterBand(1);b.SetNoDataValue(-32768);a=b.ReadAsArray();a[0,0]=-32768;b.WriteArray(a);d=None
d=gdal.GetDriverByName('GTiff').Create(str(root/'ortho.tif'),32,32,1,gdal.GDT_Byte);d.SetProjection(s.ExportToWkt());d.SetGeoTransform((-20*k,1.25*k,0,20*k,0,-1.25*k));d.GetRasterBand(1).WriteArray((np.indices((32,32)).sum(axis=0)*3+10).astype('uint8'));d=None
import numpy
print(json.dumps({'python':sys.version.split()[0],'gdal':gdal.VersionInfo('RELEASE_NAME'),'numpy':numpy.__version__}))
`, input], { encoding: 'utf8' });
    expect(projected.status).toBe(0);
    const { identity, desiredIdentity, ...payload } = structuredClone(original);
    convert(payload);
    const metadata = source => ({ evidenceUrl: 'https://example.invalid/native-raster', confidence: 'verified-mask', unknowns: [],
      rasterGsdM: 1.25*3396190*Math.PI/180, dataType: 'Float32', bands: ['value'], acquisitionUtc: null, observationId: null,
      sourceProjection: source.projection, sourceCoordinates: 'planetocentric', sourceDatum: source.datum.verticalDatum,
      registration: null, illumination: null, stereoProductIds: [], assets: [], reuse: { status: 'allowed', evidenceUrl: null },
      validData: { geometry: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'valid', properties: null,
        geometry: { type: 'Polygon', coordinates: [[[-12,-12],[12,-12],[12,12],[-12,12],[-12,-12]]] } }] },
        evidenceUrl: 'https://example.invalid/native-raster', method: 'Complete native cell and interpolation support check', extent: 'known-valid-subset' } });
    const pin = async file => ({ retrieval: 'Controlled fixture file', bytes: (await stat(file)).size,
      checksum: { algorithm: 'sha256', value: await hashFile(file) } });
    const detail = payload.sources.find(s => s.id === 'detail');
    detail.projection = 'Mars-EQC-0-0'; detail.nodata = { maskUrl: 'https://example.invalid/native-raster' };
    detail.asset = await pin(join(input, 'detail.tif')); detail.metadata = metadata(detail);
    const image = payload.sources.find(s => s.id === 'detail-image');
    image.projection = 'Mars-EQC-0-0'; image.asset = await pin(join(input, 'ortho.tif')); image.metadata = metadata(image);
    bindings['detail-image'] = 'ortho.tif';
    // Keep two independent image controls: the existing XYZ context plus native raster detail.
    for (const selection of payload.selections.filter(s => s.channel === 'elevation')) for (const [role,filename] of [['label','MEGA90N000EB.LBL'],['image','MEGA90N000EB.IMG']]) {
      selection.transformations[0].areoid[role] = await pin(join(input, filename)); bindings['datum:areoid-'+role] = filename;
    }
    const fusion = join(input,'existing-fusion');
    const fused = spawnSync(python, [resolve('scripts/terrain/dem.py'),'fuse','--base',join(input,'base.tif'),'--detail',join(input,'detail.tif'),
      '--out',fusion,'--blend-m','150000','--fit-stride','2','--bias','none'], { encoding:'utf8' });
    expect(fused.status, fused.stderr).toBe(0);
    const files = {};
    for (const name of ['fusion.json','residual.tif','coverage.tif','weight.tif','fused.tif']) files[name] = {
      path:name,bytes:(await stat(join(fusion,name))).size,sha256:await hashFile(join(fusion,name)) };
    const bundle = join(fusion,'bundle.json');
    await writeFile(bundle,JSON.stringify({version:1,kind:'locked-fusion-bundle',baseSha256:payload.sources[0].asset.checksum.value,detailSha256:detail.asset.checksum.value,files}));
    bindings['terrain:fusion'] = bundle;
    payload.processing.parameters.profile = 'bounded-real-mars';
    payload.processing.parameters.toolchain = JSON.parse(projected.stdout);
    payload.processing.parameters.terrain.fusionAsset = await pin(bundle);
    const strict = structuredClone(payload);
    strict.desired.regions.find(r=>r.id==='landing').fallback='require-target';
    strict.desired.regions.find(r=>r.id==='landing').elevation.gsdM=100000;
    strict.desired.regions.find(r=>r.id==='landing').imagery.gsdM=50000;
    await expect(createLockedSurfacePlan(strict)).rejects.toThrow(/physical fidelity/);
    const lock = await createLockedSurfacePlan(payload);
    const options = { bindings, bindingsDir:input, python, workers:1, cache:join(temp,'projected-cache') };
    const report = await executeBuild(lock,options);
    expect(await hashFile(join(report.directory,'fusion/fusion.json'))).toBe(files['fusion.json'].sha256);
    const clean = await executeBuild(lock,{...options,cache:join(temp,'projected-clean-cache')});
    for(const product of report.products) expect(await buildInventory(join(clean.directory,product.id))).toEqual(await buildInventory(join(report.directory,product.id)));
    expect(report.resources.actual.sampledPeakScratchBytes).toBeGreaterThan(0);
    expect(report.resources.actual.peakDiskBytes).toBeNull();

    expect(report.resources.actual.sourceAudit.rasters.detail.invalidPixels).toBe(1);
    expect(report.resources.actual.sourceAudit.rasters.detail.nativeValidSubset.features[0].nativeCells).toBeGreaterThan(0);
    expect(report.resources.actual.sourceAudit.imagery['detail-image'].sourceToOutputRegistration.checkedPixels).toBeGreaterThanOrEqual(64);
    expect((await executeBuild(lock,options)).reused).toBe(true);
    const {identity: priorId,desiredIdentity: priorDesired,...imageOnlyPayload}=structuredClone(lock);
    imageOnlyPayload.processing.parameters.imagery[1].regions=['landing@0,0:1=2000,2=1500,3=1000,4=400'];
    // Guard the actual worker operations, not just reported tile-builder reuse.
    // Node preflight still hashes every current dependency before this starts.
    const guardedPython=join(input,'guarded-python');
    const executable=spawnSync(python,['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).stdout.trim();
    await writeFile(guardedPython,`#!${executable}
import sys,importlib.util,argparse,pathlib
worker_path=pathlib.Path(sys.argv[1]);sys.path.insert(0,str(worker_path.parent))
spec=importlib.util.spec_from_file_location('guarded_worker',worker_path);w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
original_copy=w.shutil.copyfile
original_raster=w.raster
original_command=w.command
def guarded_copy(src,dst,*a,**kw):
    assert pathlib.Path(src).name not in ['base.tif','detail.tif','MEGA90N000EB.LBL','MEGA90N000EB.IMG','fusion.json','residual.tif','coverage.tif','weight.tif','fused.tif','bundle.json'], 'unchanged terrain dependency was staged'
    return original_copy(src,dst,*a,**kw)
def guarded_raster(path,radius,source,*a,**kw):
    assert source['channel'] != 'elevation', 'unchanged terrain pixels were audited'
    return original_raster(path,radius,source,*a,**kw)
def guarded_command(*args):
    assert not {'fuse','cube-tile','cube-error'}.intersection(str(a) for a in args), 'unchanged terrain was built'
    return original_command(*args)
w.shutil.copyfile=guarded_copy;w.raster=guarded_raster;w.command=guarded_command
p=argparse.ArgumentParser();p.add_argument('--job');p.add_argument('--out');p.add_argument('--workers',type=int)
w.build(p.parse_args(sys.argv[2:]))
`);
    await chmod(guardedPython,0o755);
    const imageOnly=await executeBuild(await createLockedSurfacePlan(imageOnlyPayload),{...options,python:guardedPython});
    expect(imageOnly.products.slice(0,2).every(p=>p.reusedFromBuild===report.buildId)).toBe(true);
    const imageOnlyAudit=imageOnly.resources.actual.sourceAudit;
    expect(imageOnlyAudit.executionWork).toEqual({stagedSources:['detail-image'],auditedSources:['detail-image'],terrainStaging:false,fusion:false});
    expect(imageOnlyAudit.rasters).toEqual(report.resources.actual.sourceAudit.rasters);
    expect(imageOnlyAudit.fusion).toEqual(report.resources.actual.sourceAudit.fusion);
    expect(imageOnlyAudit.imagery['detail-image'].dtmGridAlignment).toEqual(report.resources.actual.sourceAudit.imagery['detail-image'].dtmGridAlignment);
    expect(await readdir(imageOnly.directory)).not.toContain('fusion');
    const incrementalInputs=await readdir(join(imageOnly.directory,'inputs'));
    expect(incrementalInputs).not.toContain('areoid');
    expect(incrementalInputs).not.toContain('fusion-bundle.json');
    for(const source of lock.sources.filter(s=>s.channel==='elevation'))
      expect(incrementalInputs.some(name=>name.startsWith(source.asset.checksum.value))).toBe(false);
    const product = report.products.find(p=>p.sourceIds.includes('detail-image'));
    const manifestFile = join(report.directory,product.id,'imagery.json');
    const manifestBytes = await readFile(manifestFile);
    const manifest = JSON.parse(manifestBytes);
    expect(manifest.provenance.sources[0].productId).toBe(image.productId);
    expect(manifest.provenance.sources[0].asset.checksum).toEqual(image.asset.checksum);
    expect(manifest.provenance.sources[0].license).toEqual(image.license);
    expect(manifest.provenance.sources[0].validData).toEqual(image.metadata.validData);
    expect(manifest.source.attribution).toBeTruthy();
    expect(manifest.filtering.supersample).toBe(4);
    manifest.tiles = manifest.tiles.filter(id=>Number(id.split('/')[1])!==manifest.maxLevel);
    await writeFile(manifestFile,JSON.stringify(manifest));
    const descriptor = join(input,'descriptor.json');await writeFile(descriptor,JSON.stringify(image));
    const registration = spawnSync(python,[resolve('scripts/surface-build/validate_imagery.py'),'--source',join(input,'ortho.tif'),
      '--descriptor',descriptor,'--manifest',manifestFile,'--requests',join(report.directory,'inputs/detail-image-requests.json'),
      '--out',join(input,'should-not-pass.json')],{encoding:'utf8'});
    expect(registration.status).not.toBe(0);expect(registration.stderr).toContain('continuous footprint lacks finest output coverage');
    await writeFile(manifestFile,manifestBytes);
    const {identity: oldIdentity,desiredIdentity: oldDesired,...wrongToolchain}=structuredClone(lock);
    wrongToolchain.processing.parameters.toolchain.python='0.0-test';
    await expect(executeBuild(await createLockedSurfacePlan(wrongToolchain),{...options,cache:join(temp,'wrong-toolchain')})).rejects.toThrow(/toolchain differs/);
    const {identity: oldBudgetIdentity,desiredIdentity: oldBudgetDesired,...unbounded}=structuredClone(lock);
    unbounded.processing.parameters.terrain.globalLevel=0;
    unbounded.processing.parameters.terrain.regions=['huge@0,0:'+Array.from({length:17},(_,i)=>`${i+1}=20000`).join(',')];
    await expect(compileBuild(await createLockedSurfacePlan(unbounded))).rejects.toThrow(/exceeds 2048 tiles/);
    await writeFile(join(fusion,'residual.tif'),'changed');
    expect((await inspectBindings(lock,bindings,input)).find(s=>s.sourceId==='terrain:fusion').state).toBe('response-missing-or-changed');
    await expect(executeBuild(lock,options)).rejects.toThrow(/changed source/);
  },300000);
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
    expect(report.version).toBe(2);
    expect(report.resources.actual.publishedBytes).toBeNull();
    expect(report.plannerFeedback.products.every(p=>p.publication.status==='not-published')).toBe(true);
    expect(report.plannerFeedback.requested.find(r=>r.regionId==='landing').channels.find(c=>c.channel==='elevation').targetMetByNativeSource).toBe(false);
    expect(report.plannerFeedback.requested.find(r=>r.regionId==='landing').channels.find(c=>c.channel==='elevation').diagnostic).toContain('native-target-unavailable');
    expect(report.caveats.join(' ')).toContain('No observed HiRISE DTM');
    expect((await executeBuild(lock, options)).reused).toBe(true);
    const rebuilt = await executeBuild(lock, { ...options, cache: join(temp, 'second-cache') });
    expect(rebuilt.products.map(p => p.revision)).toEqual(report.products.map(p => p.revision));
    for (const product of report.products) {
      expect(await buildInventory(join(rebuilt.directory, product.id))).toEqual(await buildInventory(join(report.directory, product.id)));
    }
    const host = await serveStore(createLocalStorage(storeDir), { html404: true });
    try {
      const origins = ['https://custom-viewer.example', 'http://localhost:5173'];
      const published = await publishLocalFixture(lock, { cache, localDir: storeDir, baseUrl: host.url, origins });
      expect(published.verificationOrigins).toEqual(origins);
      expect(published.catalogPinned).toBe(false);
      expect(published.storageObjects).toBe(published.objects+2*published.products.length);
      expect(published.storageBytes).toBeGreaterThan(published.bytes);
      expect(published.products.every(p => p.verified)).toBe(true);
      for (const item of published.products) {
        const product = report.products.find(p=>p.id===item.productId);
        const standalone = await (await fetch(host.url+'/'+item.prefix+(product.kind==='cube-terrain'?'terrain-product.json':'imagery.json'))).json();
        expect(standalone.provenance.productIdentity).toBe(product.productIdentity);
        expect(standalone.provenance.sources.map(s=>s.id)).toEqual(lock.sources.filter(s=>product.sourceIds.includes(s.id)).map(s=>s.id));
        expect(standalone.provenance.sources.every(s=>s.productId&&s.asset.checksum.value&&s.license.name)).toBe(true);
      }
      const republished = await publishLocalFixture(lock, { cache, localDir: storeDir, baseUrl: host.url });
      expect(republished.products.every(p => p.reused)).toBe(true);
      expect(republished.products.map(p=>p.prefix)).toEqual(published.products.map(p=>p.prefix));
      await expect(publishLocalFixture(lock, { cache, localDir: storeDir, baseUrl: host.url,
        fetchImpl: async () => new Response('missing', { status: 404 }) })).rejects.toThrow(/verification failed/);
      const preflight = await publicationPlan(lock, { cache });
      await expect(publishBuild(lock, { cache, baseUrl: host.url, confirm: 'wrong' })).rejects.toThrow(/no credentials read/);
      expect(preflight.products.every(p=>p.inventorySha256&&p.entries.length)).toBe(true);
      expect(publishedFeedback(report,published).products.every(p=>p.publication.status==='verified-local-http')).toBe(true);
      const catalog = { name:'Synthetic Skyfall only', terrain: '/test-catalogs/data/'+report.products[0].id+'/tileset.json',
        grids: '/test-catalogs/data/'+report.products[0].id+'/cpu-grids.json',
        imagery: report.products.slice(1).map(p=>'/test-catalogs/data/'+p.id+'/imagery.json'), untouched:'https://example.invalid/trajectory' };
      const catalogPrefixes = Object.fromEntries(report.products.map(p=>[p.id,'data/'+p.id+'/']));
      const checkedOrigins = new Set();
      const candidate = await catalogCandidate(lock,{cache,receipt:published,catalog,catalogRel:'test-catalogs/skyfall.json',catalogPrefixes,
        fetchImpl: (url, options) => { if (options?.headers?.Origin) checkedOrigins.add(options.headers.Origin); return fetch(url, options); }});
      expect(checkedOrigins).toEqual(new Set(origins));
      expect(candidate.after.terrain).toContain(published.products[0].prefix);
      expect(candidate.after.untouched).toBe(catalog.untouched);
      const file = join(input,'candidate-catalog.json');await writeFile(file,JSON.stringify(catalog));
      await applyCatalogCandidate(candidate,file);
      expect(JSON.parse(await readFile(file))).toEqual(candidate.after);
      await applyCatalogCandidate(candidate,file,{rollback:true});
      expect(JSON.parse(await readFile(file))).toEqual(catalog);
      await writeFile(file,JSON.stringify({...catalog,name:'concurrent edit'}));
      await expect(applyCatalogCandidate(candidate,file)).rejects.toThrow(/changed since candidate/);
      const tampered=structuredClone(published);tampered.products.pop();
      await expect(catalogCandidate(lock,{cache,receipt:tampered,catalog,catalogRel:'skyfall.json',catalogPrefixes})).rejects.toThrow(/receipt changed/);
      const {identity: oldReceiptPin,...partialBody}=tampered;
      const partial={...partialBody,identity:contentIdentity(partialBody)};
      await expect(catalogCandidate(lock,{cache,receipt:partial,catalog,catalogRel:'skyfall.json',catalogPrefixes})).rejects.toThrow(/does not match completed/);
      // Actual region-only rebuild: identical global context and physical product
      // are copied from verified completion, without invoking either builder.
      const {identity: ignored,desiredIdentity: ignoredDesired,...regionalPayload}=structuredClone(lock);
      regionalPayload.processing.parameters.imagery[1].regions=['landing@0,0:1=2000,2=1500,3=1000,4=400'];
      const regionalLock=await createLockedSurfacePlan(regionalPayload);
      const regionalDag=await compileBuild(regionalLock);
      expect(regionalDag.products.slice(0,2).map(p=>p.id)).toEqual(report.products.slice(0,2).map(p=>p.id));
      expect(regionalDag.products[2].id).not.toBe(report.products[2].id);
      const interrupted=join(cache,regionalDag.buildId+'.building');await mkdir(interrupted);
      await expect(executeBuild(regionalLock,options)).rejects.toThrow(/EEXIST/);
      await expect(publicationPlan(regionalLock,{cache})).rejects.toThrow(/incomplete/);
      await rm(interrupted,{recursive:true});
      const regional=await executeBuild(regionalLock,options);
      expect(regional.products.slice(0,2).every(p=>p.reusedFromBuild===report.buildId)).toBe(true);
      expect(regional.products[2].reusedFromBuild).toBeNull();
      const incrementalAudit = regional.resources.actual.sourceAudit;
      expect(incrementalAudit.executionWork).toEqual({stagedSources:[regional.products[2].sourceIds[0]],
        auditedSources:[regional.products[2].sourceIds[0]],terrainStaging:false,fusion:false});
      expect(await readdir(regional.directory)).not.toContain('fusion');
      const stagedFiles=await readdir(join(regional.directory,'inputs'));
      for(const source of regionalLock.sources.filter(s=>s.channel==='elevation'))
        expect(stagedFiles.some(name=>name.startsWith(source.asset.checksum.value))).toBe(false);
      expect(incrementalAudit.rasters).toEqual(report.resources.actual.sourceAudit.rasters);
      expect(incrementalAudit.fusion).toEqual(report.resources.actual.sourceAudit.fusion);
      expect(regional.plannerFeedback.sourceTransfers.every(s=>s.downloadedBytesThisExecution===0)).toBe(true);
      const regionalPublished=await publishLocalFixture(regionalLock,{cache,localDir:storeDir,baseUrl:host.url});
      expect(regionalPublished.products.slice(0,2).map(p=>p.prefix)).toEqual(published.products.slice(0,2).map(p=>p.prefix));
      expect(regionalPublished.products.slice(0,2).every(p=>p.reused)).toBe(true);
      // Damage a non-sampled object after a successful publish. Full HTTP
      // verification and pin preparation must still reject it.
      const selected=preflight.products[2];const badObject=selected.entries.find(e=>e.path.endsWith('.png'));
      const objectFile=join(storeDir,selected.prefix,badObject.path),originalObject=await readFile(objectFile);
      const badBytes=Buffer.from(originalObject);badBytes[badBytes.length-1]^=1;await writeFile(objectFile,badBytes);
      await expect(catalogCandidate(lock,{cache,receipt:published,catalog,catalogRel:'skyfall.json',catalogPrefixes})).rejects.toThrow(/checksum mismatch/);
      await expect(publishLocalFixture(lock,{cache,localDir:storeDir,baseUrl:host.url})).rejects.toThrow(/partial publication checksum mismatch/);
      await writeFile(objectFile,originalObject);
      await rm(objectFile);
      await expect(catalogCandidate(lock,{cache,receipt:published,catalog,catalogRel:'skyfall.json',catalogPrefixes})).rejects.toThrow(/missing|HTTP/);
      await writeFile(objectFile,originalObject);
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
    await expect(executeBuild(badRegistration, { ...options, cache: join(temp,'bad-registration-cache'), bindings: bad.bindings, bindingsDir: badInput })).rejects.toThrow(/registration offset/);
    expect(await readCompleted(join(cache, (await compileBuild(badRegistration)).buildId), await compileBuild(badRegistration))).toBeNull();
  }, 300000);
});
