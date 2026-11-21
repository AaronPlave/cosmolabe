// Finite #247 inputs for the existing shared executor. No acquisition or upload.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLockedSurfacePlan } from '../../packages/core/dist/surface-plan/index.js';
import { bodyFixedToGeodetic } from '../../packages/three/dist/TerrainSampler.js';
import { hashFile, GENERATOR } from './plan.mjs';

const [inputArg, baseArg, areoidArg, auditArg, outArg, ctxArg, hiriseArg] = process.argv.slice(2);
if (!outArg) throw new Error('Usage: curiosity.mjs INPUTS BASE_TIF AREOID_DIR AUDIT_JSON NEW_OUTPUT [CTX_BUNDLE HIRISE_BUNDLE]');
const inputs = resolve(inputArg), base = resolve(baseArg), areoid = resolve(areoidArg), out = resolve(outArg);
const audit = JSON.parse(await readFile(auditArg, 'utf8'));
if (audit.kind !== 'curiosity-registration-source-gate' || !audit.terrain.allPixelsValid) throw new Error('Source audit required');
const detail = join(inputs, 'gale-dingo-dem-window.tif');
const pin = async path => ({ bytes: (await stat(path)).size, checksum: { algorithm: 'sha256', value: await hashFile(path) } });
for (const path of [base, detail]) {
  const expected = audit.inputs[path === base ? 'Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif' : 'gale-dingo-dem-window.tif'];
  if ((await hashFile(path)) !== expected.sha256) throw new Error('Audited source changed');
}
await mkdir(out, { recursive: false });
const fusion = resolve(inputs, '../fusion'), metadata = JSON.parse(await readFile(join(fusion, 'fusion.json'), 'utf8'));
if (metadata.registration.removed || metadata.taper.blendM !== 50) throw new Error('Require the audited bias-preserving 50m taper');
// Normalize volatile provenance only, retaining every original fused sample.
delete metadata.created; metadata.base.path = 'base.tif'; metadata.detail.path = 'detail.tif';
await writeFile(join(fusion, 'fusion.json'), JSON.stringify(metadata, null, 2)+'\n');
const files = {};
for (const name of ['fusion.json', 'residual.tif', 'coverage.tif', 'weight.tif', 'fused.tif']) {
  const path = join(fusion, name);
  files[name] = { path: name, bytes: (await stat(path)).size, sha256: await hashFile(path) };
}
const bundle = join(fusion, 'bundle.json');
await writeFile(bundle, JSON.stringify({ version: 1, kind: 'locked-fusion-bundle',
  baseSha256: await hashFile(base), detailSha256: await hashFile(detail), files }, null, 2)+'\n');
const rect = (id, w, s, e, n) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', id, properties: null,
  geometry: { type: 'Polygon', coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]] } }] });
const k = 3396190*Math.PI/180, lat = Number(audit.anchor.row.planetocentric_latitude), lon = Number(audit.anchor.row.longitude);
const roi = rect('dingo', lon-130/k, lat-130/k, lon+130/k, lat+130/k);
const coordinates = { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: { kind: 'sphere', radiusKm: 3396.19 } };
const outputDatum = { referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19,3396.19,3376.2] }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' };
const baseUrl = 'https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif';
const detailUrl = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif';
const sources = [];
for (const [id, path, url, gsd, projection] of [['base',base,baseUrl,200,'EPSG:4326'], ['detail',detail,detailUrl,1,'Mars-EQC-0-0']]) {
  sources.push({ id, productId: id === 'base' ? 'USGS-HRSC-MOLA-200m-v2' : 'USGS-Gale-merged-DEM-v3-native-window', channel: 'elevation', body: 'Mars', frame: 'IAU_MARS',
    coordinates, footprint: roi, nodata: { maskUrl: url }, nativeGsdM: gsd, accuracyM: null, projection,
    datum: { referenceShape: coordinates.referenceShape, verticalDatum: 'areoid', heightConvention: 'radial' },
    asset: { ...await pin(path), retrieval: `${url}; original pixel window or original global raster; source-grid interval ${gsd}m does not establish physical accuracy` },
    license: { name: 'NASA/USGS public domain', attribution: 'NASA/JPL-Caltech/USGS Astrogeology/University of Arizona; T. Parker and F. Calef III' },
    metadata: { evidenceUrl: url, confidence: 'verified-mask', rasterGsdM: gsd, dataType: id === 'base' ? 'Int16' : 'Float32', bands: ['height'],
      acquisitionUtc: null, observationId: null, sourceProjection: projection, sourceCoordinates: 'planetocentric east-positive', sourceDatum: 'MOLA areoid elevation',
      registration: { group: id === 'base' ? 'HRSC-MOLA' : 'Gale-controlled-mosaic-v3', evidenceUrl: url, accuracyM: null }, illumination: null, stereoProductIds: [],
      assets: [{ url, role: 'raster', bytes: (await stat(path)).size, sizeEvidence: 'pinned local input bytes; detail is a finite exact source window' }],
      unknowns: ['Absolute body-fixed accuracy is unknown.', 'The merged 1m Gale grid mixes source resolutions; native stereo source at Dingo Gap is unverified.'],
      validData: { geometry: roi, evidenceUrl: url, method: 'Executor checks every touched native pixel and interpolation halo; source audit checks complete 400m crop mask.', extent: 'known-valid-subset' },
      reuse: { status: 'allowed', evidenceUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits' } } });
}
const bindings = { base, detail, 'terrain:fusion': bundle, 'terrain:base-overview': base+'.ovr',
  'datum:areoid-label': join(areoid,'MEGA90N000EB.LBL'), 'datum:areoid-image': join(areoid,'MEGA90N000EB.IMG') };
const terrainRegions = [`gale@${lat},${lon}:3=50,4=35,5=25,6=18,7=12,8=8,9=4,10=2,11=1,12=0.6,13=0.4,14=0.3,15=0.25`];
const imageRegions = [
  [`gale@${lat},${lon}:3=20,4=12,5=8,6=5,7=2,8=1,9=0.5`],
  [`dingo@${lat},${lon}:3=20,4=12,5=8,6=5,7=2,8=1,9=0.5,10=0.4,11=0.3,12=0.3`],
];
const imagery = [], selections = [];
for (const [i, id, pathArg, gsd] of [[0,'gale-ctx',ctxArg,25],[1,'curiosity-hirise',hiriseArg,2]]) {
  if (!pathArg) continue;
  const path = resolve(pathArg), responseBundle = JSON.parse(await readFile(path, 'utf8')), config = responseBundle.config;
  const spacing = 2*Math.PI*3396190/(2**config.levels*config.dimension);
  const source = structuredClone(sources[1]);
  Object.assign(source, { id, productId: id, channel: 'imagery', nativeGsdM: spacing, projection: 'EPSG:4326',
    datum: { referenceShape: coordinates.referenceShape, verticalDatum: 'reference-sphere', heightConvention: 'radial' },
    asset: { ...await pin(path), retrieval: config.url } });
  Object.assign(source.metadata, { evidenceUrl: config.url, rasterGsdM: spacing, dataType: 'Byte', bands: ['imagery'], sourceProjection: 'EPSG:4326',
    sourceDatum: 'orbital mosaic directions; no elevation claim', registration: { group: id, evidenceUrl: config.url, accuracyM: null },
    assets: [{ url: config.url, role: 'raster', bytes: (await stat(path)).size, sizeEvidence: 'finite response inventory' }],
    unknowns: ['Absolute registration and acquisition illumination are unknown.', 'Available service grid interval is distinct from original instrument GSD.'],
    validData: { geometry: roi, evidenceUrl: config.url, method: 'All acquired original responses and full decoded masks checked by shared executor.', extent: 'known-valid-subset' } });
  sources.push(source); bindings[id] = path;
  imagery.push({ sourceId: id, globalLevel: 2, regions: imageRegions[i], visible: true, opacity: 1 });
  selections.push({ regionId: `image-${id}`, channel: 'imagery', sourceIds: [id], outputGsdM: gsd, resampling: 'bilinear', transformations: ['identity'] });
}
const transform = { kind: 'areoid-radial', outputDatum, areoid: {} };
for (const [role, suffix] of [['label','LBL'],['image','IMG']]) transform.areoid[role] = { ...await pin(join(areoid,`MEGA90N000EB.${suffix}`)), retrieval: 'Official detached MEG016 datum asset' };
const controls = audit.physicalSites.filter(r => r.coverage === 'root-triangle').map(row => {
  const [n,e] = row.localNorthEastM;
  const phi = lat+n/k, lam = lon+e/k/Math.cos(lat*Math.PI/180), p = phi*Math.PI/180, l = lam*Math.PI/180;
  const r = row.demRadiusM/1000;
  const point = bodyFixedToGeodetic({xKm:r*Math.cos(p)*Math.cos(l),yKm:r*Math.cos(p)*Math.sin(l),zKm:r*Math.sin(p)},outputDatum);
  return { lat: point.latDeg, lon: point.lonDeg, heightM: point.heightKm*1000, toleranceM: 1 };
});
const toolchain = JSON.parse(execFileSync('python3', ['-c', 'import sys,json,numpy;from osgeo import gdal;print(json.dumps(dict(python=sys.version.split()[0],gdal=gdal.VersionInfo("RELEASE_NAME"),numpy=numpy.__version__)))'], { encoding: 'utf8' }));
const desired = { version: 1, kind: 'desired-surface-plan', body: 'Mars', frame: 'IAU_MARS', coordinates,
  layers: [{ id: 'site', name: 'Dingo Gap finite source-mask check', body: 'Mars', source: 'embedded', geojson: roi }],
  regions: [{ id: 'site', feature: { layerId: 'site', featureId: 'string:dingo' }, elevation: { gsdM: 4 }, fallback: 'require-target' },
    ...selections.map(s => ({ id: s.regionId, feature: { layerId: 'site', featureId: 'string:dingo' }, imagery: { gsdM: s.outputGsdM }, fallback: 'require-target' }))] };
const lock = await createLockedSurfacePlan({ version: 1, kind: 'locked-surface-plan', desired, sources,
  selections: [{ regionId: 'site', channel: 'elevation', sourceIds: ['base','detail'], outputGsdM: 4, resampling: 'cubic', transformations: [transform] }, ...selections],
  processing: { generator: GENERATOR, fusion: 'residual-bias-none', parameters: { profile: 'bounded-real-mars', toolchain,
    terrain: { base: 'base', detail: 'detail', globalLevel: 2, regions: terrainRegions, blendM: 50, fitStride: 8,
      fusionAsset: { ...await pin(bundle), retrieval: 'Pinned Gale residual; no bias removal' }, baseOverviewAsset: { ...await pin(base+'.ovr'), retrieval: 'Pinned global source overview' } },
    imagery, gates: { maxOffsetM: 10, maxBoundaryStepM: 1, clearanceM: 50, controls },
    caveats: ['Only the bounded Gale crop contributes local elevation. Jezero residuals are not reused.',
      'The 1m source grid and 4m output target do not certify native stereo resolution or physical accuracy.',
      'Dingo Gap is visual-only, with unknown absolute registration uncertainty. SPICE rover states are never adjusted.',
      'Viking is independently reused from the already published immutable product; it is not rebuilt here.'] } },
  output: { representation: 'tiled-raster-pyramid', formatVersion: 'cosmolabe-cube-1', tileSize: 1024, gutter: 2, imageryEncoding: 'png', elevationEncoding: 'float32' } });
for (const [name,value] of [['lock.json',lock],['bindings.json',bindings]]) await writeFile(join(out,name),JSON.stringify(value,null,2)+'\n');
console.log(JSON.stringify({ lock: join(out,'lock.json'), bindings: join(out,'bindings.json') }));
