import { execFileSync } from 'node:child_process';
import { writeFile, stat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLockedSurfacePlan } from '../../packages/core/dist/surface-plan/index.js';
import { GENERATOR, ROOT, hashFile } from './plan.mjs';

const json = v => JSON.stringify(v, null, 2) + '\n';
export async function createFixture(dir, python = 'python3') {
  dir = resolve(dir);
  await mkdir(dir, { recursive: true });
  execFileSync(python, [join(ROOT, 'scripts/surface-build/fixture.py'), dir]);
  const rectangle = (id, size) => ({ type: 'Feature', id, properties: null,
    geometry: { type: 'Polygon', coordinates: [[[-size, -size], [size, -size], [size, size], [-size, size], [-size, -size]]] } });
  const footprint = { type: 'FeatureCollection', features: [rectangle('source', 20)] };
  const coordinates = { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180',
    referenceShape: { kind: 'sphere', radiusKm: 3396.19 } };
  const desired = { version: 1, kind: 'desired-surface-plan', body: 'Mars', frame: 'IAU_MARS', coordinates,
    layers: [{ id: 'synthetic', name: 'Synthetic Skyfall-style fixture; no actual mission geometry', body: 'Mars', source: 'embedded',
      geojson: { type: 'FeatureCollection', features: [rectangle('approach', 10), rectangle('landing', 1), {type:'Feature',id:'no-dtm',properties:null,geometry:{type:'Polygon',coordinates:[[[40,-1],[42,-1],[42,1],[40,1],[40,-1]]]}}] } }],
    regions: [{ id: 'approach', feature: { layerId: 'synthetic', featureId: 'string:approach' }, imagery: { gsdM: 500000 }, elevation: { gsdM: 30000 }, fallback: 'allow-coarser' },
      { id: 'landing', feature: { layerId: 'synthetic', featureId: 'string:landing' }, imagery: { gsdM: 15000 }, elevation: { gsdM: 30000 }, fallback: 'allow-coarser' },
      {id:'no-dtm',feature:{layerId:'synthetic',featureId:'string:no-dtm'},imagery:{gsdM:500000},elevation:{gsdM:1000},fallback:'allow-coarser'}] };
  const bundle = async (id, dimension) => {
    const png = join(dir, id + '.png');
    const entry = { path: id + '.png', sha256: await hashFile(png) };
    const config = { type: 'xyz', projection: 'EPSG:4326', latitudeConvention: 'planetocentric',
      ...(id==='detail-image'?{bounds:[-20,-20,20,20]}:{}),
      url: `https://example.invalid/synthetic-${id}/{z}/{x}/{y}`, levels: 1, minZoom: 0, dimension };
    await writeFile(join(dir, id + '.json'), json({ version: 1, kind: 'locked-xyz-bundle', config, tiles: { '0/0/0': entry, '0/1/0': entry } }));
  };
  await bundle('context', 32); await bundle('detail-image', 512);
  const sources = [];
  for (const [id, file, channel, nativeGsdM] of [['base', 'base.tif', 'elevation', 333000], ['detail', 'detail.tif', 'elevation', 74000],
    ['context', 'context.json', 'imagery', 333500], ['detail-image', 'detail-image.json', 'imagery', 20850]]) {
    sources.push({ id, productId: `synthetic-${id}-v1`, channel, body: 'Mars', frame: 'IAU_MARS', coordinates, footprint: ['base','context'].includes(id) ? {type:'FeatureCollection',features:[rectangle('declared-envelope',80)]} : footprint,
      nodata: 'none', nativeGsdM, accuracyM: channel === 'elevation' ? 1 : null, projection: 'EPSG:4326',
      datum: { referenceShape: coordinates.referenceShape, verticalDatum: 'reference-sphere', heightConvention: 'radial' },
      asset: { retrieval: `Generated synthetic fixture: ${file}`, bytes: (await stat(join(dir, file))).size,
        checksum: { algorithm: 'sha256', value: await hashFile(join(dir, file)) } },
      license: { name: 'Apache-2.0 synthetic fixture', attribution: 'Cosmolabe diagnostic data; not observational Mars data' } });
  }
  const selections = desired.regions.flatMap(r => [
    { regionId: r.id, channel: 'elevation', sourceIds: r.id==='no-dtm'?['base']:['base', 'detail'], outputGsdM: 30000, resampling: 'cubic', transformations: ['identity'] },
    { regionId: r.id, channel: 'imagery', sourceIds: [r.id !== 'landing' ? 'context' : 'detail-image'], outputGsdM: r.imagery.gsdM, resampling: 'bilinear', transformations: ['identity'] },
  ]);
  const parameters = { terrain: { base: 'base', detail: 'detail', globalLevel: 2, regions: [], blendM: 150000, fitStride: 2 },
    imagery: [{ sourceId: 'context', globalLevel: 0, regions: [], visible: true, opacity: 1 },
      { sourceId: 'detail-image', globalLevel: 0, regions: ['landing@0,0:1=2000,2=1500,3=1000,4=500'], visible: true, opacity: 1 }],
    gates: { maxOffsetM: 1, maxBoundaryStepM: 1, clearanceM: 100, controls: [{ lat: 0.5, lon: 0.5, heightM: 1000, toleranceM: 1 }] },
    caveats: ['Synthetic spherical Mars only; not the real ellipsoid foundation.', 'No observed HiRISE DTM at the synthetic landing site; no regional DTM at no-dtm (40..42E).',
      'Independent image density exceeds terrain density; source-native resolution remains coarser than some output texels.'] };
  const lock = await createLockedSurfacePlan({ version: 1, kind: 'locked-surface-plan', desired, sources, selections,
    processing: { generator: GENERATOR, fusion: 'residual-bias-none', parameters },
    output: { representation: 'tiled-raster-pyramid', formatVersion: 'cosmolabe-cube-1', tileSize: 32, gutter: 2,
      imageryEncoding: 'png', elevationEncoding: 'float32' } });
  await writeFile(join(dir, 'lock.json'), json(lock));
  const bindings = Object.fromEntries(sources.map(s => [s.id, s.id + (s.channel === 'elevation' ? '.tif' : '.json')]));
  await writeFile(join(dir, 'bindings.json'), json(bindings));
  return { lock, bindings };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/surface-build/fixture.mjs OUT_DIR [PYTHON]');
  await createFixture(process.argv[2], process.argv[3]);
}
