// Prepare the finite #246 terrain lock from a clean fusion and the numerical audit.
// Optional full-size imagery inputs produce all four independent mission products.
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

export async function prepareIngenuity({ source, fusion, areoid, audit: auditFile, output, imageryRoot }) {
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
  const imagery = [], imageSelections = [], imageBindings = {};
  // A continuous corridor contains every original horizontal path vertex.
  // Successive retained centres are <=100 m apart; 240 m squares overlap.
  // Keep individual polygons so coverage validation need not claim the empty
  // corners of a single envelope as high-resolution operational coverage.
  const corridor = [];
  const prior = [];
  for (const f of paths.features) for (const [lon,lat] of f.geometry.coordinates) {
    const p = point(lat,lon);
    if (prior.some(v => Math.acos(Math.min(1,Math.max(-1,v.reduce((s,x,i)=>s+x*p[i],0))))*3396190 < 100)) continue;
    prior.push(p);
    const dLat = 120/3396190*180/Math.PI, dLon = dLat/Math.cos(lat*Math.PI/180);
    corridor.push(rectangle('path',lon-dLon,lat-dLat,lon+dLon,lat+dLat).geometry.coordinates);
  }
  const operational = collection([{type:'Feature',id:'operations',properties:null,geometry:{type:'MultiPolygon',coordinates:corridor}}]);
  if (imageryRoot) {
    imageryRoot = resolve(imageryRoot);
    const specs = [
      ['viking','viking-bundle-1024/bundle.json','EPSG:4326',232,7,400,'NASA Trek / USGS Viking MDIM 2.1'],
      ['ctx-global','ctx-v01-bundle-1024/bundle.json','EPSG:4326',5,13,6,'Caltech Murray Lab / Esri'],
      ['jezero-ctx','upstream/jezero-ctx.tif','Mars-EQC-0-0',6,11,6,'NASA/USGS Mars 2020 TRN CTX soc_008'],
      ['jezero-hirise','upstream/hirise-ortho.tif','Mars-EQC-0-0',.25,14,.5,'NASA/USGS Mars 2020 TRN HiRISE soc_006'],
    ];
    for (const [id,relative,projection,gsd,lastLevel,outputGsd,attribution] of specs) {
      const local = join(imageryRoot,relative), raster = projection !== 'EPSG:4326';
      const service = raster ? null : JSON.parse(await readFile(local,'utf8')).config;
      // The service grid can be coarser than the original mosaic's nominal GSD.
      // Use its equatorial interval conservatively for the source target gate;
      // keep the original nominal GSD separately as rasterGsdM.
      const availableGsd = raster ? gsd : Math.max(gsd,2*Math.PI*3396190/(2**(service.levels??8)*(service.dimension??256)));
      const sourceUrl = raster ? `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/${id === 'jezero-ctx' ? 'CTX/JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif' : 'HiRISE/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif'}`
        : JSON.parse(await readFile(local,'utf8')).config.url;
      const valid = raster ? collection(Array.from({length:48},(_,i)=>{ const x=i%8,y=Math.floor(i/8);return rectangle(`native-${i}`,77.320+x*.01675,18.425+y*.013,77.320+(x+1)*.01675,18.425+(y+1)*.013); })) : collection([rectangle('native-check',77.45075,18.44465,77.45085,18.44475)]);
      sources.push({ id,productId:id==='ctx-global'?'murray-ctx-v01':id,channel:'imagery',body:'Mars',frame:'IAU_MARS',coordinates,
        footprint:roi,
        nodata:raster ? {maskUrl:sourceUrl} : 'none',nativeGsdM:availableGsd,accuracyM:null,projection,
        datum:{referenceShape:coordinates.referenceShape,verticalDatum:'reference-sphere',heightConvention:'radial'},
        asset:{...await pin(local),retrieval:sourceUrl},license:{name:'NASA/USGS public data; upstream attribution retained',attribution},
        metadata:{evidenceUrl:sourceUrl,confidence:'verified-mask',rasterGsdM:gsd,dataType:'Byte',bands:['imagery'],
          acquisitionUtc:null,observationId:null,sourceProjection:projection,sourceCoordinates:'planetocentric, east-positive',
          sourceDatum:'controlled orbital map directions',registration:{group:id,evidenceUrl:sourceUrl,accuracyM:null},illumination:null,
          stereoProductIds:[],assets:[{url:sourceUrl,role:'raster',bytes:(await stat(local)).size,sizeEvidence:'verified original bytes or finite response bundle'}],
          unknowns:['Absolute registration and illumination uncertainty remain unknown.','Native interval is separate from generated output spacing.','CTX service has pinned unavailable responses; gaps remain transparent.'],
          validData:{geometry:valid,evidenceUrl:sourceUrl,method:raster ? 'Every native cell and halo in this small subset checked; whole-source mask counted separately.' : 'Pinned original source response and complete decoded alpha checked at this mission subset; failures remain separately pinned holes.',extent:'known-valid-subset'},
          reuse:{status:'allowed',evidenceUrl:raster ? 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits' : sourceUrl}} });
      const regionSpecs = id==='viking' || id==='ctx-global'
        ? [`mission@18.46,77.4:${Array.from({length:lastLevel-2},(_,j)=>`${j+3}=${[50,35,25,18,12,8,6,4,3,2.5,2][j]}`).join(',')}`]
        : centres.map(([lat,lon],i)=>`mission${i}@${lat},${lon}:${Array.from({length:lastLevel-2},(_,j)=>`${j+3}=${Math.max(2.4,[50,35,25,18,12,8,6,4,3,2.5,2.4,2.4][j])}`).join(',')}`);
      imagery.push({sourceId:id,globalLevel:2,regions:regionSpecs,visible:true,opacity:1});
      imageSelections.push({regionId:`image-${id}`,channel:'imagery',sourceIds:[id],outputGsdM:outputGsd,resampling:'bilinear',transformations:['identity']});
      imageBindings[id]=local;
    }
  }
  const { execFileSync } = await import('node:child_process');
  const toolchain = JSON.parse(execFileSync('python3', ['-c', 'import sys,json,numpy; from osgeo import gdal; print(json.dumps({"python":sys.version.split()[0],"gdal":gdal.VersionInfo("RELEASE_NAME"),"numpy":numpy.__version__}))'], { encoding: 'utf8' }));
  const desired = { version: 1, kind: 'desired-surface-plan', body: 'Mars', frame: 'IAU_MARS', coordinates,
    layers: [{ id: 'mission', name: 'All Ingenuity operations; source coordinates', body: 'Mars', source: 'embedded', geojson: roi },
      ...(imageryRoot ? [{id:'operations',name:'Observed flight corridor',body:'Mars',source:'embedded',geojson:operational},{id:'image-checks',name:'XYZ response check subset; remaining native coverage is reported separately',body:'Mars',source:'embedded',geojson:collection([rectangle('native-check',77.45075,18.44465,77.45085,18.44475)])}] : [])],
    regions: [{ id: 'mission', feature: { layerId: 'mission', featureId: 'string:mission' }, elevation: { gsdM: 4 }, fallback: 'require-target' },
      ...imageSelections.map(s=>({id:s.regionId,feature:s.sourceIds[0]==='viking'||s.sourceIds[0]==='ctx-global' ? {layerId:'image-checks',featureId:'string:native-check'} : {layerId:'operations',featureId:'string:operations'},imagery:{gsdM:s.outputGsdM},fallback:'require-target'}))] };
  const lock = await createLockedSurfacePlan({ version: 1, kind: 'locked-surface-plan', desired, sources,
    selections: [{ regionId: 'mission', channel: 'elevation', sourceIds: ['base','detail'], outputGsdM: 4, resampling: 'cubic', transformations: [transform] },...imageSelections],
    processing: { generator: GENERATOR, fusion: 'residual-bias-none', parameters: { profile: 'bounded-real-mars', toolchain,
      terrain: { base: 'base', detail: 'detail', globalLevel: 2, regions, blendM: 1000, fitStride: 8,
        fusionAsset: { ...await pin(bundle), retrieval: 'Clean recomputation from the pinned original DEMs; normalized provenance; complete raster inventory' },
        baseOverviewAsset: { ...await pin(files[0]+'.ovr'), retrieval: 'Pinned global source overview dependency' } },
      imagery, gates: { maxOffsetM: 10, maxBoundaryStepM: 1, clearanceM: 50, controls,
        ...(imageryRoot ? { independentImageGrids: ['jezero-ctx'], distinctImageTiles: ['viking', 'ctx-global'] } : {}) },
      caveats: [imageryRoot ? 'Complete mission product selection: one authoritative terrain/CPU product plus four independent imagery products; publication remains an explicit authorization boundary.' : 'Terrain-only selection; independent imagery is not selected.',
        'Every original path sample is within an L15 cap; ~3.24 m maximum grid spacing is distinct from 1 m native DTM fidelity.',
        '73 scalar controls share provenance, use conditional radial placement, and do not certify absolute physical accuracy.',
        'Runtime near-surface representation/loading evidence is separate from source accuracy and retained in the mission acceptance report. No production publication is performed by execution.'] } },
    output: { representation: 'tiled-raster-pyramid', formatVersion: 'cosmolabe-cube-1', tileSize: 1024, gutter: 2, imageryEncoding: 'png', elevationEncoding: 'float32' } });
  const bindings = { base: files[0], detail: files[1], 'terrain:fusion': bundle, 'terrain:base-overview': files[0]+'.ovr',
    'datum:areoid-label': join(areoid,'MEGA90N000EB.LBL'), 'datum:areoid-image': join(areoid,'MEGA90N000EB.IMG'),...imageBindings };
  await writeFile(join(output, 'lock.json'), json(lock));
  await writeFile(join(output, 'bindings.json'), json(bindings));
  return { lock: join(output,'lock.json'), bindings: join(output,'bindings.json') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, fusion, areoid, audit, output, imageryRoot] = process.argv.slice(2);
  if (!output) throw new Error('Usage: ingenuity.mjs SOURCE_DIR CLEAN_FUSION_DIR AREOID_DIR AUDIT.json NEW_OUTPUT_DIR');
  console.log(await prepareIngenuity({source,fusion,areoid,audit,output,imageryRoot}));
}
