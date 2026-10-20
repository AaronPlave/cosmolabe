/** Measured-terrain registration through real viewer tile/LOD transitions.
 * CL_MOON_TERRAIN points at a built LOLA cube pyramid; no synthetic DEM fallback.
 * CL_CHROMIUM selects Chrome; CL_VIEWER_URL selects this checkout's Vite server.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5188/';
const output = process.env.CL_OUTPUT ?? 'docs/validation/geographic-vectors/m4-max';
const moonRoot = process.env.CL_MOON_TERRAIN;
assert.ok(moonRoot, 'CL_MOON_TERRAIN must identify the measured LOLA cube pyramid');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CL_CHROMIUM,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  page.setDefaultNavigationTimeout(60_000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(m.text())) errors.push(m.text()); });
  await page.route('**/__measured/moon/**', async route => {
    const root = resolve(moonRoot), path = resolve(root, new URL(route.request().url()).pathname.split('/__measured/moon/')[1]);
    assert.ok(path.startsWith(root + sep));
    try { await route.fulfill({ body: await readFile(path), contentType: path.endsWith('.json') ? 'application/json' : 'application/octet-stream' }); }
    catch { await route.fulfill({ status: 404, body: 'Measured terrain file missing' }); }
  });
  for (const [body, lon, lat, radius] of [['Mars', 77.45, 18.45, 3396.19], ['Moon', 129.78, -89.67, 1737.4]]) {
    const terrain = body === 'Mars'
      ? { type: 'quantized-mesh', url: new URL('test-catalogs/data/mars-terrain-fused/', base).href, fadeDurationMs: 0,
        datum: { verticalDatum: 'areoid', heightConvention: 'geodetic-normal' }, sourceMetadata: { id: 'MOLA/HRSC + Jezero HiRISE 1m residual' } }
      : { type: '3dtiles', url: new URL('__measured/moon/tileset.json', base).href, errorTarget: 2, fadeDurationMs: 0,
        datum: { verticalDatum: 'reference-sphere', heightConvention: 'radial' }, cubeSphere: { cpuGrids: new URL('__measured/moon/cpu-grids.json', base).href },
        sourceMetadata: { id: 'LOLA 118m + south-pole LOLA 10m residual', kind: 'height-grid' } };
    const shape = body === 'Mars' ? { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] } : { kind: 'sphere', radiusKm: radius };
    const step = body === 'Mars' ? 0.02 : 4;
    const fixture = { type: 'FeatureCollection', features: Array.from({ length: 13 }, (_, i) => ({ type: 'Feature', id: i, properties: { synthetic: true },
      geometry: { type: 'Point', coordinates: [lon + (i - 6) * step, lat] } })) };
    fixture.features.push({ type: 'Feature', id: 'traverse', properties: { synthetic: true }, geometry: { type: 'LineString', coordinates: [[lon - step * 6, lat], [lon + step * 6, lat]] } });
    const rectangle = (x, y) => [[lon - x, lat - y], [lon + x, lat - y], [lon + x, lat + y], [lon - x, lat + y], [lon - x, lat - y]];
    fixture.features.push({ type: 'Feature', id: 'region-with-hole', properties: { synthetic: true }, geometry: { type: 'Polygon',
      coordinates: [rectangle(step * 3, body === 'Mars' ? 0.04 : 0.08), rectangle(step, body === 'Mars' ? 0.01 : 0.02)] } });
    const catalog = { name: `${body} measured-terrain vector registration`, defaultViewpoint: 'Registration',
      geographicLayers: [{ id: 'registration', name: 'Synthetic registration marks on measured terrain', body, source: new URL('__registration.geojson', base).href,
        coordinates: { latitude: 'planetographic', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: shape } }],
      items: [{ name: 'Registration', type: 'Viewpoint', center: body, distance: radius + 1000, latitude: lat, longitude: lon },
        { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: [20000000, 100000000, -20000000] }, geometry: { type: 'Globe', radius: 695000 } },
        { name: body, class: 'planet', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, rotationModel: { type: 'Fixed', quaternion: [1, 0, 0, 0], inertialFrame: 'ECLIPJ2000' },
          geometry: { type: 'Globe', ...(body === 'Mars' ? { radii: [3396.19, 3396.19, 3376.2] } : { radius }), terrain } }] };
    await page.route('**/__registration.geojson', route => route.fulfill({ json: fixture }));
    await page.route('**/__registration.json', route => route.fulfill({ json: catalog }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async base => {
      const loader = await import('/src/lib/loader.ts');
      await loader.loadCatalogUrl(document.querySelector('canvas'), new URL('__registration.json', base).href, 'Measured terrain validation');
      window.registrationLoader = loader;
      const renderer = loader.getCurrentRenderer(); renderer.stop(); renderer.setLabelsVisible(false); renderer.setLightingMode('shadow');
      renderer.cameraController.controls.enableDamping = false;
    }, base);
    const views = [];
    for (const distance of [1000, 100, 15, 3, 100]) {
      const samples = [];
      let stable = 0, previous;
      const start = Date.now();
      while (Date.now() - start < 60_000) {
        const sample = await page.evaluate(async ({ body, lon, lat, distance, root }) => {
          const THREE = await import('/node_modules/.vite/deps/three.js');
          const { geodeticToBodyFixed } = await import(`/@fs/${root}/packages/core/src/index.ts`);
          const renderer = window.registrationLoader.getCurrentRenderer(), bm = renderer.getBodyMesh(body);
          const datum = window.registrationLoader.getUniverse().geographicLayers.get('registration').datum;
          const p = geodeticToBodyFixed({ lonDeg: lon, latDeg: lat, heightKm: 0 }, datum);
          const q = geodeticToBodyFixed({ lonDeg: lon, latDeg: lat, heightKm: distance }, datum);
          const rotation = bm.bodyToWorldQuaternion(new THREE.Quaternion());
          const world = p => new THREE.Vector3(p.xKm, p.yKm, p.zKm).multiplyScalar(renderer.scaleFactor).applyQuaternion(rotation).add(bm.position);
          const target = world(p), eye = world(q), camera = renderer.camera;
          camera.position.copy(eye); camera.up.set(0, 0, 1).applyQuaternion(rotation);
          camera.lookAt(target); renderer.cameraController.controls.target.copy(target); camera.updateMatrixWorld(true);
          renderer.renderFrame();
          const metrics = bm.terrainMetrics, cube = bm.terrainCubeStats;
          const hit = renderer.pickSurface(0, 0);
          const rect = renderer.renderer.domElement.getBoundingClientRect();
          const feature = renderer.pickScene(rect.width / 2, rect.height / 2, 'select', { labelSlopPx: 0 });
          const gl = renderer.renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
          return { metrics, cube, hit, feature, vectorMetrics: renderer.geographicVectors.metrics,
            diagnostics: renderer.geographicVectors.diagnostics, gpu: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) };
        }, { body, lon, lat, distance, root: resolve('.') });
        samples.push({ elapsedMs: Date.now() - start, visible: sample.metrics?.tiles.visible, source: sample.hit?.point.source });
        const busy = sample.metrics ? sample.metrics.network.queued + sample.metrics.network.downloading + sample.metrics.network.parsing + (sample.cube?.inFlight ?? 0) : 1;
        const visible = sample.metrics?.tiles.visible;
        stable = !busy && visible > 0 && visible === previous ? stable + 1 : 0; previous = visible;
        if (samples.length === 1) await page.screenshot({ path: `${output}/${body.toLowerCase()}-${distance}-loading.png` });
        if (stable >= 5) {
          assert.doesNotMatch(sample.gpu, /swiftshader|llvmpipe|software/i);
          assert.equal(sample.hit?.point.source, 'terrain', `${body} ${distance}: center must hit measured terrain`);
          assert.equal(sample.feature?.kind, 'geographic-feature', `${body} ${distance}: center registration target must be pickable`);
          assert.equal(sample.feature.featureId, 'number:6');
          assert.deepEqual(sample.diagnostics, []);
          await page.screenshot({ path: `${output}/${body.toLowerCase()}-${distance}-settled.png` });
          await page.evaluate(body => {
            const renderer = window.registrationLoader.getCurrentRenderer(); renderer.setTerrainDebugMode('lod', body); renderer.renderFrame();
          }, body);
          await page.screenshot({ path: `${output}/${body.toLowerCase()}-${distance}-lod.png` });
          await page.evaluate(body => {
            const renderer = window.registrationLoader.getCurrentRenderer(); renderer.setTerrainDebugMode('none', body); renderer.renderFrame();
          }, body);
          views.push({ distanceKmAboveDatum: distance, settledMs: Date.now() - start, samples, ...sample });
          console.log(body, distance, 'settled', sample.metrics.tiles, sample.feature);
          break;
        }
        await page.waitForTimeout(200);
      }
      assert.ok(stable >= 5, `${body} ${distance}: measured tiles did not settle`);
    }
    const metadata = await readFile(body === 'Mars' ? 'apps/viewer/test-catalogs/data/mars-terrain-fused/terrain-product.json' : resolve(moonRoot, 'fusion.json'));
    results.push({ body, sourceMetadataText: metadata.toString('utf8'), metadataSha256: createHash('sha256').update(metadata).digest('hex'), views });
    await writeFile(`${output}/measured-terrain.json`, JSON.stringify({ results, errors }, null, 2) + '\n');
    await page.unroute('**/__registration.geojson'); await page.unroute('**/__registration.json');
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
