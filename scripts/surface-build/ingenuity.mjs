// Prepare the finite #246 terrain lock from a clean fusion and the numerical audit.
// This is a mission terrain prerequisite, not imagery or production acceptance.
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLockedSurfacePlan } from '../../packages/core/dist/surface-plan/index.js';
import { bodyFixedToGeodetic } from '../../packages/three/dist/TerrainSampler.js';
import { GENERATOR, hashFile } from './plan.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const rectangle = (id, w, s, e, n) => ({ type: 'Feature', id, properties: null,
  geometry: { type: 'Polygon', coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]] } });
const collection = features => ({ type: 'FeatureCollection', features });

export async function prepareIngenuity({ source, fusion, areoid, audit: auditFile, output }) {
  source = resolve(source); fusion = resolve(fusion); areoid = resolve(areoid); output = resolve(output);
  const audit = JSON.parse(await readFile(auditFile, 'utf8'));
  if (audit.controls.count !== 73 || audit.flights.count !== 72 || audit.cleanFusion.registration.removed) {
    throw new Error('A complete bias-preserving #246 numerical audit is required');
  }
  const pathFile = 'apps/viewer/test-catalogs/data/ingenuity/m20_heli_flight_path.json';
  if (await hashFile(pathFile) !== audit.inputs.paths.sha256) throw new Error('Original path observations changed since the audit');
  const files = [join(source, 'Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif'),
    join(source, 'JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif')];
  const pin = async path => ({ bytes: (await stat(path)).size,
    checksum: { algorithm: 'sha256', value: await hashFile(path) } });
  for (const [id, file] of [['base', files[0]], ['detail', files[1]], ['areoidLabel', join(areoid, 'MEGA90N000EB.LBL')],
    ['areoidImage', join(areoid, 'MEGA90N000EB.IMG')]]) {
    const actual = await pin(file), expected = audit.inputs[id];
    if (actual.bytes !== expected.bytes || actual.checksum.value !== expected.sha256) throw new Error(`${id}: audit input changed`);
  }
  if ((await hashFile(join(fusion, 'fusion.json'))) !== audit.cleanFusion.metadata.sha256) throw new Error('Clean fusion metadata changed');
  // No directory exists until all required primary pins above have been verified.
  await mkdir(output, { recursive: false });
  const staged = join(output, 'fusion'); await mkdir(staged);
  const metadata = JSON.parse(await readFile(join(fusion, 'fusion.json'), 'utf8'));
  // Normalize volatile provenance only. All four newly computed rasters must
  // match the audit. The historical fusion is never an execution binding.
  delete metadata.created;
  metadata.base.path = 'base.tif'; metadata.detail.path = 'detail.tif';
  await writeFile(join(staged, 'fusion.json'), json(metadata));
  const inventory = {};
  for (const name of ['fusion.json', 'residual.tif', 'coverage.tif', 'weight.tif', 'fused.tif']) {
    if (name !== 'fusion.json') {
      const file = join(fusion, name), expected = audit.cleanFusion.comparisonToHistorical[name].clean;
      if ((await stat(file)).size !== expected.bytes || await hashFile(file) !== expected.sha256) throw new Error(`${name}: clean fusion changed`);
      await symlink(file, join(staged, name));
    }
    const file = join(staged, name);
    inventory[name] = { path: name, bytes: (await stat(file)).size, sha256: await hashFile(file) };
  }
  const bundle = join(staged, 'bundle.json');
  await writeFile(bundle, json({ version: 1, kind: 'locked-fusion-bundle',
    baseSha256: audit.inputs.base.sha256, detailSha256: audit.inputs.detail.sha256, files: inventory }));
  const coordinates = { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180',
    referenceShape: { kind: 'sphere', radiusKm: 3396.19 } };
  const outputDatum = { referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19,3396.19,3376.2] },
    verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' };
  const roi = collection([rectangle('mission', 77.320,18.425,77.454,18.503)]);
  // Split native validity inspection into finite windows, each with a two-cell
  // interpolation halo. These are proved from the bound source masks by worker.py.
  const subset = collection([]);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) subset.features.push(
    rectangle(`mission-${x}-${y}`,77.320+x*.0335,18.425+y*.039,77.320+(x+1)*.0335,18.425+(y+1)*.039));
  const urls = ['https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif',
    'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif'];
  const sources = await Promise.all(['base', 'detail'].map(async (id, i) => ({ id, productId: id === 'base' ? 'USGS-HRSC-MOLA-200m-v2' : 'JEZ-TRN-soc-006-DTM-1m-DeltaGeoid-blend40',
    channel: 'elevation', body: 'Mars', frame: 'IAU_MARS', coordinates, footprint: roi,
    nodata: { maskUrl: urls[i] }, nativeGsdM: i ? 1 : 200, accuracyM: null,
    projection: i ? 'Mars-EQC-0-0' : 'EPSG:4326',
    datum: { referenceShape: coordinates.referenceShape, verticalDatum: 'areoid', heightConvention: 'radial' },
    asset: { ...await pin(files[i]), retrieval: urls[i] },
    license: { name: 'NASA/USGS public domain', attribution: 'NASA/USGS MOLA, MEX HRSC, Mars 2020 TRN HiRISE' },
    metadata: { evidenceUrl: urls[i], confidence: 'verified-mask', rasterGsdM: i ? 1 : 200,
      dataType: i ? 'Float32' : 'Int16', bands: ['height'], acquisitionUtc: null, observationId: null,
      sourceProjection: i ? 'Mars-EQC-0-0' : 'geographic on the Mars 2000 map sphere',
      sourceCoordinates: 'planetocentric, east-positive', sourceDatum: 'MOLA areoid topography',
      registration: { group: 'Mars-2020-TRN-soc-006', evidenceUrl: urls[i], accuracyM: null },
      illumination: null, stereoProductIds: [], assets: [{ url: urls[i], role: 'raster',
        bytes: audit.inputs[id].bytes, sizeEvidence: 'verified original file bytes' }],
      unknowns: ['Absolute physical accuracy is not certified.', 'A source envelope is not a complete native-valid footprint.'],
      validData: { geometry: subset, evidenceUrl: urls[i], method: 'Every native cell and two-cell interpolation halo checked during execution.', extent: 'known-valid-subset' },
      reuse: { status: 'allowed', evidenceUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits' } } })));
  const transform = { kind: 'areoid-radial', outputDatum, areoid: {
    label: { ...await pin(join(areoid, 'MEGA90N000EB.LBL')), retrieval: 'Official MOLA MEG016 label' },
    image: { ...await pin(join(areoid, 'MEGA90N000EB.IMG')), retrieval: 'Official MOLA MEG016 image' } } };
  const centres = [[18.44,77.447],[18.455,77.405],[18.487,77.348]];
  const regions = centres.map(([lat,lon], i) => `mission${i}@${lat},${lon}:3=50,4=35,5=25,6=18,7=12,8=8,9=6,10=4,11=3,12=2.5,13=2.5,14=2.2,15=2`);
  const controls = audit.controls.rows.map(row => {
    const [xKm,yKm,zKm] = row.conditionalRadialBodyFixedM.map(x => x/1000);
    const p = bodyFixedToGeodetic({xKm,yKm,zKm},outputDatum);
    return { lat: p.latDeg, lon: p.lonDeg, heightM: p.heightKm*1000, toleranceM: 1 };
  });
  // Verify complete operational coverage on original path samples, not just controls.
  const paths = JSON.parse(await readFile(pathFile, 'utf8'));
  const point = (lat, lon) => { lat*=Math.PI/180;lon*=Math.PI/180;return [Math.cos(lat)*Math.cos(lon),Math.cos(lat)*Math.sin(lon),Math.sin(lat)]; };
  const vectors = centres.map(([lat,lon]) => point(lat,lon));
  for (const f of paths.features) for (const [lon,lat] of f.geometry.coordinates) {
    const p = point(lat,lon);
    const distance = Math.min(...vectors.map(v => Math.acos(Math.min(1,Math.max(-1,v.reduce((s,x,i)=>s+x*p[i],0))))*3396.19));
    if (distance > 2) throw new Error('An original path sample falls outside finest terrain caps');
  }
  const { execFileSync } = await import('node:child_process');
  const toolchain = JSON.parse(execFileSync('python3', ['-c', 'import sys,json,numpy; from osgeo import gdal; print(json.dumps({"python":sys.version.split()[0],"gdal":gdal.VersionInfo("RELEASE_NAME"),"numpy":numpy.__version__}))'], { encoding: 'utf8' }));
  const desired = { version: 1, kind: 'desired-surface-plan', body: 'Mars', frame: 'IAU_MARS', coordinates,
    layers: [{ id: 'mission', name: 'All Ingenuity operations; source coordinates', body: 'Mars', source: 'embedded', geojson: roi }],
    regions: [{ id: 'mission', feature: { layerId: 'mission', featureId: 'string:mission' }, elevation: { gsdM: 4 }, fallback: 'require-target' }] };
  const lock = await createLockedSurfacePlan({ version: 1, kind: 'locked-surface-plan', desired, sources,
    selections: [{ regionId: 'mission', channel: 'elevation', sourceIds: ['base','detail'], outputGsdM: 4, resampling: 'cubic', transformations: [transform] }],
    processing: { generator: GENERATOR, fusion: 'residual-bias-none', parameters: { profile: 'bounded-real-mars', toolchain,
      terrain: { base: 'base', detail: 'detail', globalLevel: 2, regions, blendM: 1000, fitStride: 8,
        fusionAsset: { ...await pin(bundle), retrieval: 'Clean recomputation from the pinned original DEMs; normalized provenance; complete raster inventory' },
        baseOverviewAsset: { ...await pin(files[0]+'.ovr'), retrieval: 'Pinned global source overview dependency' } },
      imagery: [], gates: { maxOffsetM: 10, maxBoundaryStepM: 1, clearanceM: 50, controls },
      caveats: ['Terrain prerequisite only: four-source imagery and mission browser acceptance remain required.',
        'Every original path sample is within an L15 cap; ~3.24 m maximum grid spacing is distinct from 1 m native DTM fidelity.',
        '73 scalar controls share provenance, use conditional radial placement, and do not certify absolute physical accuracy.',
        'Ground-level rendered loading/LOD acceptance remains open; no production upload or catalog switch.'] } },
    output: { representation: 'tiled-raster-pyramid', formatVersion: 'cosmolabe-cube-1', tileSize: 1024, gutter: 2, imageryEncoding: 'png', elevationEncoding: 'float32' } });
  const bindings = { base: files[0], detail: files[1], 'terrain:fusion': bundle, 'terrain:base-overview': files[0]+'.ovr',
    'datum:areoid-label': join(areoid,'MEGA90N000EB.LBL'), 'datum:areoid-image': join(areoid,'MEGA90N000EB.IMG') };
  await writeFile(join(output, 'lock.json'), json(lock));
  await writeFile(join(output, 'bindings.json'), json(bindings));
  return { lock: join(output,'lock.json'), bindings: join(output,'bindings.json') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, fusion, areoid, audit, output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: ingenuity.mjs SOURCE_DIR CLEAN_FUSION_DIR AREOID_DIR AUDIT.json NEW_OUTPUT_DIR');
  console.log(await prepareIngenuity({source,fusion,areoid,audit,output}));
}
