/** Compare legacy tile-local normals and shared hillshade normals on live
 * streamed Mars terrain in a close, tilted view. No synthetic elevation data. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.SURFACE_VIEWER_URL ?? 'http://127.0.0.1:5182';
const output = 'docs/validation/surface-appearance/seams';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(msg.text())) errors.push(msg.text()); });
  const catalog = { name: 'Mars hillshade boundary review', defaultViewpoint: 'Terrain', items: [
    { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: [1e8, -1e8, 0] }, geometry: { type: 'Globe', radius: 695700 } },
    { name: 'Mars', class: 'planet', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, rotationModel: { type: 'Fixed', quaternion: [1, 0, 0, 0], inertialFrame: 'EclipticJ2000' }, geometry: {
      type: 'Globe', radii: [3396.19, 3396.19, 3376.2], terrain: {
        type: 'quantized-mesh', url: 'https://marshub.s3.amazonaws.com/mars_v14/', referenceRadiusOffsetKm: 8.765, errorTarget: 2,
        imagery: { url: 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg', levels: 7 },
      },
    } },
    { name: 'Terrain', type: 'Viewpoint', center: 'Mars', distance: 3430, latitude: -11, longitude: -70 },
  ] };
  await page.route('**/hillshade-boundary-validation.json', route => route.fulfill({ json: catalog }));
  await page.goto(`${base}/?catalog=hillshade-boundary-validation&test=1`);
  await page.waitForFunction(() => window.__cosmolabe?.ready, { timeout: 120000 });
  await page.evaluate(() => {
    const r = window.renderer;
    r.timeController.pause(); window.cosmo.select('Mars');
    const lat = -11 * Math.PI / 180, lon = -70 * Math.PI / 180;
    const target = r.cameraController.controls.target;
    target.set(3396.19 * Math.cos(lat) * Math.cos(lon) - 45 * Math.sin(lat) * Math.cos(lon),
      3396.19 * Math.cos(lat) * Math.sin(lon) - 45 * Math.sin(lat) * Math.sin(lon),
      3396.19 * Math.sin(lat) + 45 * Math.cos(lat)).multiplyScalar(r.scaleFactor);
    r.camera.lookAt(target);
  });
  await page.waitForFunction(() => window.renderer.getBodyMesh('Mars').terrainDiagnostics.tileCount > 25, { timeout: 120000 });
  await page.waitForTimeout(10000);
  await page.getByLabel('Surface base color', { exact: true }).selectOption('neutral');
  await page.getByLabel('Imagery amount', { exact: true }).fill('0');
  await page.getByLabel('Hillshade effect', { exact: true }).check();
  await page.getByLabel('Light azimuth', { exact: true }).fill('170');
  await page.getByLabel('Light elevation', { exact: true }).fill('25');
  await page.getByLabel('Hillshade contrast', { exact: true }).fill('3');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${output}/mars-close-current.png` });
  await page.evaluate(() => {
    window.__legacyMaterials = new Map();
    window.renderer.getBodyMesh('Mars').terrainTileGroup.traverse(mesh => {
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (window.__legacyMaterials.has(material)) continue;
        const compile = material.onBeforeCompile, key = material.customProgramCacheKey;
        window.__legacyMaterials.set(material, { compile, key });
        material.onBeforeCompile = (shader, r) => {
          compile(shader, r);
          shader.vertexShader = 'varying vec3 vLegacyNormal;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvLegacyNormal = normal;');
          shader.fragmentShader = 'varying vec3 vLegacyNormal;\n' + shader.fragmentShader.replace(/vec3 saNormal = [^;]+;/, 'vec3 saNormal = normalize(mat3(saLocalToBody) * vLegacyNormal);');
        };
        material.customProgramCacheKey = () => key() + '_legacy_comparison';
        material.needsUpdate = true;
      }
    });
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${output}/mars-close-legacy.png` });
  const metrics = await page.evaluate(() => ({ terrain: window.renderer.getBodyMesh('Mars').terrainMetrics, source: window.renderer.getBodyMesh('Mars').terrainDiagnostics }));
  assert.deepEqual(errors, []);
  await writeFile(`${output}/mars-close-metrics.json`, JSON.stringify({ ...metrics, errors }, null, 2) + '\n');
  console.log(metrics.source);
} finally { await browser.close(); }
