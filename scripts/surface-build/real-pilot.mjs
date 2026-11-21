// Prepare a bounded, real Jezero pilot from existing immutable local assets.
// No downloads, fusion fitting, output bake or publication occurs here.
import { readFile, writeFile, stat, mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLockedSurfacePlan } from '../../packages/core/dist/surface-plan/index.js';
import { bodyFixedToGeodetic } from '../../packages/three/dist/TerrainSampler.js';
import { hashFile, GENERATOR, ROOT } from './plan.mjs';

const json = v => JSON.stringify(v, null, 2) + '\n';
export async function prepareRealPilot({ sourceRoot, inputs, datumDir, toolchain }) {
  inputs = resolve(inputs); sourceRoot = resolve(sourceRoot); datumDir = resolve(datumDir);
  const pin = async (file, retrieval) => ({ retrieval, bytes: (await stat(file)).size,
    checksum: { algorithm: 'sha256', value: await hashFile(file) } });
  const rectangle = (id, w, s, e, n) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', id, properties: null,
    geometry: { type: 'Polygon', coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]] } }] });
  const coordinates = { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: { kind: 'sphere', radiusKm: 3396.19 } };
  const outputDatum = { referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19,3396.19,3376.2] }, verticalDatum: 'ellipsoid', heightConvention: 'geodetic-normal' };
  const nativeSubset = rectangle('valid-pilot',77.4498,18.4437,77.4518,18.4457);
  const roi = rectangle('pilot',77.4506,18.4445,77.4510,18.4449);
  const sourceFiles = [join(sourceRoot,'data/source/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif'),
    join(sourceRoot,'data/source/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif'),
    join(inputs,'hirise-ortho-native-crop.tif')];
  const crop = JSON.parse(await readFile(join(inputs,'ortho-crop-provenance.json')));
  const sources = [];
  const dtmUrl = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif';
  const baselineUrl = 'https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif';
  const dtmLabelSha = await hashFile(join(inputs,'dtm.lbl'));
  for (const [i,id,nativeGsdM,projection] of [[0,'base',200,'EPSG:4326'],[1,'detail',1,'Mars-EQC-0-0'],[2,'hirise-ortho',0.25,'Mars-EQC-0-0']]) {
    const elevation = i < 2, url = i === 0 ? baselineUrl : i === 1 ? dtmUrl : crop.sourceUrl;
    sources.push({ id, productId: i === 0 ? 'USGS-HRSC-MOLA-200m-v2' : i === 1 ? 'JEZ-hirise-soc-006-DTM-1m-DeltaGeoid-blend40' : 'JEZ-hirise-soc-006-ortho-25cm-native-window',
      channel: elevation ? 'elevation' : 'imagery', body: 'Mars', frame: 'IAU_MARS', coordinates,
      footprint: i === 0 ? rectangle('base-pilot-envelope',77.3,18.3,77.6,18.6) : i === 1 ? rectangle(id,77.22294,18.30681,77.58395,18.66930)
        : rectangle(id, (crop.sourceGeoTransform[0]+crop.sourceWindow[0]*.25)/(3396190*Math.PI/180),
          (crop.sourceGeoTransform[3]-(crop.sourceWindow[1]+crop.sourceWindow[3])*.25)/(3396190*Math.PI/180),
          (crop.sourceGeoTransform[0]+(crop.sourceWindow[0]+crop.sourceWindow[2])*.25)/(3396190*Math.PI/180),
          (crop.sourceGeoTransform[3]-crop.sourceWindow[1]*.25)/(3396190*Math.PI/180)),
      nodata: i === 2 ? 'none' : { maskUrl: url }, nativeGsdM, accuracyM: null, projection,
      datum: { referenceShape: coordinates.referenceShape, verticalDatum: elevation ? 'areoid' : 'reference-sphere', heightConvention: 'radial' },
      asset: await pin(sourceFiles[i], i === 2 ? `Exact native crop: ${json(crop).trim()}` : `${url}; ${i === 1 ? 'DTM label SHA-256 '+dtmLabelSha : 'canonical global source'}; existing #50 input, no reprojection`),
      license: { name: 'USGS/NASA public domain', attribution: 'NASA/USGS MOLA, MEX HRSC and Mars 2020 TRN HiRISE' },
      metadata: { evidenceUrl: url, confidence: 'verified-mask', unknowns: ['Absolute physical accuracy is not certified.', 'Illumination varies across the source mosaic; no single acquisition angle is asserted.'],
        rasterGsdM: nativeGsdM, dataType: i === 0 ? 'Int16' : i === 1 ? 'Float32' : 'Byte', bands: [elevation ? 'height' : 'grayscale'],
        acquisitionUtc: null, observationId: null, sourceProjection: projection, sourceCoordinates: 'planetocentric, east-positive',
        sourceDatum: elevation ? 'MOLA areoid topography' : 'controlled orthomosaic map directions',
        registration: { group: 'Mars-2020-TRN-soc-006', evidenceUrl: url, accuracyM: null }, illumination: null, stereoProductIds: [],
        assets: [{url,role:'raster',bytes:i === 2 ? crop.sourceBytes : (await stat(sourceFiles[i])).size,sizeEvidence:'source file or HTTP Content-Length'}],
        reuse: { status: 'allowed', evidenceUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits' },
        validData: { geometry: nativeSubset, evidenceUrl: url, method: 'Executor verifies every touched native cell and two-cell interpolation halo from the pinned raster; subset only.', extent: 'known-valid-subset' } } });
  }
  const context=structuredClone(sources.find(s=>s.id==='hirise-ortho'));
  context.id='hirise-context';
  context.asset.retrieval += '; independent coarser context pyramid of the same observed native crop';
  sources.push(context);
  const fusionDir=join(inputs,'fusion');await mkdir(fusionDir,{recursive:true});
  const files={};
  for (const name of ['fusion.json','residual.tif','coverage.tif','weight.tif','fused.tif']) {
    const original=join(sourceRoot,'data/fused',name), local=join(fusionDir,name);
    try { await symlink(original,local); } catch(e) { if(e.code!=='EEXIST') throw e; }
    files[name]={path:name,bytes:(await stat(local)).size,sha256:await hashFile(local)};
  }
  const fusionBundle=join(fusionDir,'bundle.json');
  await writeFile(fusionBundle,json({version:1,kind:'locked-fusion-bundle',baseSha256:sources[0].asset.checksum.value,detailSha256:sources[1].asset.checksum.value,files}));
  const transform={kind:'areoid-radial',outputDatum,areoid:{label:await pin(join(datumDir,'MEGA90N000EB.LBL'),'Official MOLA MEG016 detached label'),image:await pin(join(datumDir,'MEGA90N000EB.IMG'),'Official MOLA MEG016 detached image')}};
  // Existing source controls are shared-provenance checks, not independent
  // absolute geolocation certification. Convert their physical Cartesian point.
  const controlsReport=JSON.parse(await readFile(join(ROOT,'work/surface-build/real-mars-source-validation.json')));
  const cp=controlsReport.rows.find(r=>r.id.startsWith('flight-'));
  const lat=cp.lat*Math.PI/180,lon=cp.lon*Math.PI/180,r=(cp.areoidRadiusM+cp.fieldAreoidM)/1000;
  const geodetic=bodyFixedToGeodetic({xKm:r*Math.cos(lat)*Math.cos(lon),yKm:r*Math.cos(lat)*Math.sin(lon),zKm:r*Math.sin(lat)},outputDatum);
  const desired={version:1,kind:'desired-surface-plan',body:'Mars',frame:'IAU_MARS',coordinates,
    layers:[{id:'pilot',name:'Bounded real Jezero source pilot; no mission trajectory claim',body:'Mars',source:'embedded',geojson:roi}],
    regions:[{id:'pilot',feature:{layerId:'pilot',featureId:'string:pilot'},elevation:{gsdM:100},imagery:{gsdM:0.5},fallback:'require-target'},
      {id:'context',feature:{layerId:'pilot',featureId:'string:pilot'},imagery:{gsdM:5},fallback:'require-target'}]};
  const parameters={profile:'bounded-real-mars',toolchain,
    terrain:{base:'base',detail:'detail',globalLevel:0,regions:['jezero@18.45,77.4:1=80,2=60,3=50,4=35,5=25,6=18,7=12,8=8,9=6,10=4,11=2'],blendM:1000,fitStride:8,
      fusionAsset:await pin(fusionBundle,'Pinned unchanged #50 fusion and its complete raster dependency inventory'),baseOverviewAsset:await pin(sourceFiles[0]+'.ovr','Canonical global source overview pyramid; pinned because it affects coarse sampling')},
    imagery:[{sourceId:'hirise-context',globalLevel:0,regions:['context@18.4447,77.4508:1=80,2=60,3=40,4=20,5=10,6=5,7=2,8=1,9=.5,10=.25,11=.15,12=.1,13=.08'],visible:true,opacity:1},
      {sourceId:'hirise-ortho',globalLevel:0,regions:['pilot@18.4447,77.4508:1=80,2=60,3=40,4=20,5=10,6=5,7=2,8=1,9=.5,10=.25,11=.15,12=.1,13=.08,14=.05,15=.03,16=.02'],visible:true,opacity:1}],
    gates:{maxOffsetM:10,maxBoundaryStepM:1,clearanceM:50,controls:[{lat:geodetic.latDeg,lon:geodetic.lonDeg,heightM:geodetic.heightKm*1000,toleranceM:10}]},
    caveats:['Existing #50 residual and registration plane preserved byte-for-byte.','Native-valid subset is limited to the explicit pilot geometry.','Source control shares provenance; absolute terrain/image accuracy and mission placement are not certified.','Production publication requires separate review and acceptance.']};
  const lock=await createLockedSurfacePlan({version:1,kind:'locked-surface-plan',desired,sources,selections:[
    {regionId:'pilot',channel:'elevation',sourceIds:['base','detail'],outputGsdM:100,resampling:'cubic',transformations:[transform]},
    {regionId:'pilot',channel:'imagery',sourceIds:['hirise-ortho'],outputGsdM:0.5,resampling:'bilinear',transformations:['identity']},
    {regionId:'context',channel:'imagery',sourceIds:['hirise-context'],outputGsdM:5,resampling:'bilinear',transformations:['identity']}],
    processing:{generator:GENERATOR,fusion:'residual-bias-none',parameters},output:{representation:'tiled-raster-pyramid',formatVersion:'cosmolabe-cube-1',tileSize:256,gutter:2,imageryEncoding:'png',elevationEncoding:'float32'}});
  const bindings={base:sourceFiles[0],detail:sourceFiles[1],'hirise-ortho':sourceFiles[2],'hirise-context':sourceFiles[2],'terrain:fusion':fusionBundle,'terrain:base-overview':sourceFiles[0]+'.ovr','datum:areoid-label':join(datumDir,'MEGA90N000EB.LBL'),'datum:areoid-image':join(datumDir,'MEGA90N000EB.IMG')};
  await writeFile(join(inputs,'lock.json'),json(lock));await writeFile(join(inputs,'bindings.json'),json(bindings));
  return {lock:join(inputs,'lock.json'),bindings:join(inputs,'bindings.json')};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [sourceRoot,inputs,datumDir,toolchainFile]=process.argv.slice(2);
  if(!toolchainFile)throw new Error('Usage: real-pilot.mjs SOURCE_ROOT INPUTS DATUM_DIR TOOLCHAIN.json');
  console.log(await prepareRealPilot({sourceRoot,inputs,datumDir,toolchain:JSON.parse(await readFile(toolchainFile))}));
}
