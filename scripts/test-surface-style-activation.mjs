/** Compare legacy tile-local normals and shared hillshade normals on live
 * streamed Mars terrain in a close, tilted view. No synthetic elevation data. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.SURFACE_VIEWER_URL ?? 'http://127.0.0.1:5182';
const output = 'docs/validation/surface-appearance/activation';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
  page.on('console', msg => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(msg.text())) errors.push(msg.text()); });
  const catalog = { name: 'Mars hillshade boundary review', defaultViewpoint: 'Terrain', items: [
    { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: [1e8, -1e8, 0] }, geometry: { type: 'Globe', radius: 695700 } },
    { name: 'Mars', class: 'planet', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, rotationModel: { type: 'Fixed', quaternion: [1, 0, 0, 0], inertialFrame: 'EclipticJ2000' }, geometry: {
      type: 'Globe', radii: [3396.19, 3396.19, 3376.2], terrain: {
        type: 'quantized-mesh', url: 'https://marshub.s3.amazonaws.com/mars_v14/', referenceRadiusOffsetKm: 8.765, errorTarget: 0.25,
        imagery: { url: 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg', levels: 7 },
      },
    } },
    { name: 'Terrain', type: 'Viewpoint', center: 'Mars', distance: 3430, latitude: -11, longitude: -70 },
  ] };
  await page.route('**/hillshade-boundary-validation.json', route => route.fulfill({ json: catalog }));
  await page.goto(`${base}/?catalog=hillshade-boundary-validation&test=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
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
  const client = await page.context().newCDPSession(page);
  const results = [];
  for (const cpuRate of [1, 4]) {
    await client.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    for (const mode of ['elevation', 'hillshade']) {
      const result = await page.evaluate(async mode => {
        const bm = window.renderer.getBodyMesh('Mars');
        const style = bm.terrainManager.surfaceStyle;
        const original = style.update.bind(style), batches = [];
        style.set({ ...style.current, baseColor: 'imagery', hillshade: false });
        const visible = mesh => { for (let o = mesh; o; o = o.parent) if (!o.visible) return false; return true; };
        const entries = [...style.meshes.keys()];
        const counts = { cachedMeshes: entries.length, cachedVertices: entries.reduce((n, m) => n + m.geometry.getAttribute('position').count, 0),
          visibleMeshes: entries.filter(visible).length, visibleVertices: entries.filter(visible).reduce((n, m) => n + m.geometry.getAttribute('position').count, 0) };
        style.update = budget => { const r = original(budget); if (r.meshes) batches.push(r); return r; };
        const start = performance.now();
        style.set({ ...style.current, baseColor: mode === 'elevation' ? 'elevation' : 'neutral', hillshade: mode === 'hillshade' });
        const setterMs = performance.now() - start;
        await new Promise(resolve => setTimeout(resolve, 0));
        const eventLoopResponsiveMs = performance.now() - start;
        let readyMs = null;
        for (let i = 0; i < 600; i++) {
          await new Promise(requestAnimationFrame);
          if ([...style.meshes].every(([mesh, entry]) => !visible(mesh) || entry.ready)) { readyMs = performance.now() - start; break; }
        }
        style.update = original;
        return { ...counts, setterMs, eventLoopResponsiveMs, readyMs, processedMeshes: batches.reduce((n, b) => n + b.meshes, 0),
          processedVertices: batches.reduce((n, b) => n + b.vertices, 0), preparationMs: batches.reduce((n, b) => n + b.elapsedMs, 0),
          maxBatchMs: Math.max(0, ...batches.map(b => b.elapsedMs)), maxTileMs: Math.max(0, ...batches.map(b => b.maxTileMs)), batches: batches.length };
      }, mode);
      assert.ok(result.readyMs !== null, 'visible tiles must finish');
      assert.ok(result.processedMeshes < result.cachedMeshes, 'inactive cached meshes must be deferred');
      results.push({ cpuRate, mode, ...result });
      console.log(results.at(-1));
    }
  }
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  assert.deepEqual(errors, []);
  await page.getByLabel('Surface base color', { exact: true }).selectOption('neutral');
  await page.getByLabel('Hillshade effect', { exact: true }).check();
  await page.getByLabel('Imagery amount', { exact: true }).fill('0');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${output}/mars-close.png` });
  await writeFile(`${output}/metrics.json`, JSON.stringify({ results, errors }, null, 2) + '\n');
} finally { await browser.close(); }
