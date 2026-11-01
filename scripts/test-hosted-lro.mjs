/** Normal production build + hosted rewrite; cold deterministic and normal GPU sessions.
 * node scripts/test-hosted-lro.mjs VIEWER_URL OUTPUT_DIR
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { loadDatasets } from './data-hosting/lib/datasets.mjs';
import { rewriteCatalog } from './data-hosting/lib/hosted-catalogs.mjs';
const [base, out] = process.argv.slice(2);
assert.ok(base && out, 'VIEWER_URL OUTPUT_DIR required');
await mkdir(out, { recursive: true });
const source = JSON.parse(await readFile('apps/viewer/test-catalogs/lro-moon.json', 'utf8'));
const expected = rewriteCatalog(source, 'test-catalogs/lro-moon.json', loadDatasets().datasets, 'https://data.aaronplave.com').json;
const terrain = expected.items.find(i => i.name === 'Moon').geometry.terrain;
const terrainRoot = new URL('.', terrain.url).href, imageryRoot = new URL('.', terrain.cubeSphere.imagery.url).href;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROMIUM_PATH ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
  args: [...(process.env.CHROMIUM_HOST_RESOLVER_RULES ? [`--host-resolver-rules=${process.env.CHROMIUM_HOST_RESOLVER_RULES}`] : []),
    '--enable-gpu', '--ignore-gpu-blocklist', process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader'] });
const report = { passed: false, baseUrl: base, catalogInterception: false,
  productUrls: { terrain: terrain.url, cpu: terrain.cubeSphere.cpuGrids, imagery: terrain.cubeSphere.imagery.url }, runs: [] };
try {
  for (const deterministic of [true, false]) {
    // Separate contexts also discard localStorage, IndexedDB and kernel caches.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const run = { deterministic, coldBrowserCache: true, products: { terrain: 0, cpu: 0, imagery: 0 }, errors: [], transportFailures: [], views: [] };
    report.runs.push(run);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    page.on('pageerror', e => run.errors.push(e.message));
    page.on('requestfailed', request => run.transportFailures.push({ url: request.url(), reason: request.failure()?.errorText }));
    page.on('console', m => { if (m.type() === 'error') run.errors.push(m.text()); });
    page.on('response', response => {
      const url = response.url();
      if (response.status() >= 400 && !url.endsWith('favicon.ico')) run.errors.push(`${response.status()} ${url}`);
      if (!response.ok()) return;
      // Count actual payloads independently; manifests cannot satisfy these gates.
      if (url.startsWith(terrainRoot) && /\.glb(?:\?|$)/.test(url)) run.products.terrain++;
      if (url.startsWith(terrainRoot) && /\.f32(?:\?|$)/.test(url)) run.products.cpu++;
      if (url.startsWith(imageryRoot) && !/\.json(?:\?|$)/.test(url)) run.products.imagery++;
    });
    const idle = () => {
      const t = window.renderer?.getBodyMesh('Moon')?.terrainManager, n = t?.metrics.network, i = t?.cubeImageryStats;
      return t?.tiles.visibleTiles.size > 0 && n.queued + n.downloading + n.parsing === 0 && t.cubeStats?.inFlight === 0
        && i?.ready && i.inFlight === 0 && (i.queued === 0 || i.budgetLimited);
    };
    const settle = async () => {
      const deadline = Date.now() + 120000;
      do {
        await page.waitForFunction(idle, null, { timeout: Math.max(1, deadline - Date.now()) });
        await page.waitForTimeout(500);
        if (await page.evaluate(idle)) return;
      } while (Date.now() < deadline);
      throw new Error('Lunar terrain/imagery requests did not settle');
    };
    // Query the physical CPU grid along the same radial direction as a real rendered pick.
    const physicalPick = () => page.evaluate(async () => {
      const r = window.renderer, b = r.getBodyMesh('Moon'), canvas = r.getContext().webglRenderer.domElement;
      const drawn = r.pickScene(canvas.clientWidth / 2, canvas.clientHeight / 2, 'probe', { renderedOnly: true })?.point;
      if (!drawn || drawn.bodyName !== 'Moon') return { drawn, physical: null };
      const [x, y, z] = drawn.bodyFixedPositionKm, radius = Math.hypot(x, y, z), d = [x / radius, y / radius, z / radius];
      const ray = { origin: { xKm: d[0] * 1800, yKm: d[1] * 1800, zKm: d[2] * 1800 }, direction: d.map(v => -v), nearKm: 0, farKm: 100 };
      const cube = b.terrainManager.cube;
      await cube.surface.ensureRayCoverage(ray, { maxMeshErrorKm: 0 }, AbortSignal.timeout(30000));
      const physical = cube.surface.intersectRay(ray, { maxMeshErrorKm: 0 });
      return { drawn, physical };
    });
    const assertPick = pick => {
      assert.equal(pick.drawn?.bodyName, 'Moon'); assert.equal(pick.drawn.frame, 'MOON_ME_DE421');
      assert.equal(pick.drawn.source, 'terrain');
      assert.ok(pick.drawn.bodyFixedPositionKm.every(Number.isFinite));
      assert.equal(pick.physical?.kind, 'hit'); assert.equal(pick.physical.metadata.frame, 'MOON_ME_DE421');
      assert.equal(pick.physical.metadata.source.kind, 'height-grid');
      assert.ok(pick.physical.distanceKm > 0 && Number.isFinite(pick.physical.distanceKm));
      assert.ok(pick.physical.triangleIndex >= 0);
    };
    const capture = async (view, pickRequired) => {
      await settle();
      const pick = pickRequired ? await physicalPick() : null;
      if (pick) assertPick(pick);
      await settle();
      const state = await page.evaluate(() => {
        const r = window.renderer, b = r.getBodyMesh('Moon'), t = b.terrainManager;
        return { frame: t.frameAvailability, terrain: t.cubeStats, imagery: t.cubeImageryStats, network: t.metrics.network,
          assets: r.initialAssetsSummary, camera: r.camera.position.toArray(), instrument: r.getSensorClipSummary('LROC WAC') };
      });
      run.views.push({ view, ...state, pick });
      assert.equal(state.frame.kind, 'available'); assert.equal(state.frame.frame, 'MOON_ME_DE421');
      assert.equal(state.assets.failed, 0); assert.equal(state.assets.timedOut, false);
      assert.equal(state.terrain.failed, 0); assert.equal(state.network.failed, 0);
      assert.ok(state.imagery.blocks > 0); assert.equal(state.imagery.baseUncoveredBlocks, 0);
      assert.equal(state.imagery.failedTiles, 0); assert.equal(state.imagery.failures, 0);
      assert.equal(state.imagery.gpuError, null); assert.deepEqual(state.imagery.inheritedGlErrors, []);
      await page.screenshot({ path: `${out}/${deterministic ? 'test' : 'normal'}-${view.replaceAll(' ', '-')}.png` });
      console.log(`${deterministic ? 'test' : 'normal'}: ${view}`);
    };
    try {
      const response = await page.goto(new URL('test-catalogs/lro-moon.json', base).href);
      assert.equal(response.status(), 200); assert.deepEqual(await response.json(), expected);
      console.log('Hosted catalog matches the normal rewrite');
      await page.goto(`${base}?catalog=test-catalogs/lro-moon${deterministic ? '&test=1' : ''}`, { waitUntil: 'domcontentloaded' });
      console.log('Cold viewer document loaded');
      await page.waitForFunction(() => window.renderer?.getBodyMesh('Moon')?.terrainManager?.cubeImageryStats?.ready, null, { timeout: 120000 });
      await page.evaluate(async () => { await window.renderer.waitForInitialAssets(); window.cosmo.setPlaying(false); });
      console.log('Initial assets complete');
      run.gpu = await page.evaluate(() => { const gl = window.renderer.getContext().webglRenderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER); });
      assert.doesNotMatch(run.gpu, /swiftshader|llvmpipe|software/i, 'Normal visual acceptance requires a physical GPU');
      for (const view of ['Track LRO', 'Moon Overview', 'LRO Close-up', 'Lunar North Pole']) {
        assert.equal(await page.evaluate(view => window.cosmo.viewpoint(view), view), true);
        await page.waitForTimeout(1800);
        await capture(view, view === 'Moon Overview' || view === 'Lunar North Pole');
      }
      // Existing mission attitude/IK, not an invented observation: instrument rendering/intersection smoke only.
      await page.evaluate(() => { window.cosmo.viewpoint('Track LRO'); window.renderer.setInstrumentView('LROC WAC'); });
      await page.waitForTimeout(2000);
      run.instrument = await page.evaluate(async () => {
        const r = window.renderer, b = r.getBodyMesh('Moon'), camera = r.instrumentView.camera, V = r.camera.position.constructor;
        const inverse = b.mesh.quaternion.clone().invert();
        const p = camera.position.clone().sub(b.position).divideScalar(r.scaleFactor).applyQuaternion(inverse);
        const d = camera.getWorldDirection(new V()).applyQuaternion(inverse);
        const ray = { origin: { xKm: p.x, yKm: -p.z, zKm: p.y }, direction: [d.x, -d.z, d.y], nearKm: 0, farKm: 1000 };
        const cube = b.terrainManager.cube;
        await cube.surface.ensureRayCoverage(ray, { maxMeshErrorKm: 0 }, AbortSignal.timeout(30000));
        return { info: r.getInstrumentViewInfo(), ray, intersection: cube.surface.intersectRay(ray, { maxMeshErrorKm: 0 }), clip: r.getSensorClipSummary('LROC WAC') };
      });
      assert.equal(run.instrument.info.sensor, 'LROC WAC'); assert.notEqual(run.instrument.info.pointing, 'unavailable');
      assert.equal(run.instrument.intersection.kind, 'hit'); assert.equal(run.instrument.intersection.metadata.frame, 'MOON_ME_DE421');
      assert.equal(run.instrument.intersection.metadata.source.kind, 'height-grid');
      await capture('LROC WAC', false);
      await page.evaluate(() => window.renderer.setInstrumentView(null));
      // Look down at the adopted Shackleton product, five km above the CPU ground.
      run.southPole = await page.evaluate(async () => {
        const r = window.renderer, b = r.getBodyMesh('Moon'), V = r.camera.position.constructor;
        window.cosmo.untrack();
        const lat = -89.67 * Math.PI / 180, lon = 129.78 * Math.PI / 180;
        const d = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
        const ray = { origin: { xKm: d[0] * 1800, yKm: d[1] * 1800, zKm: d[2] * 1800 }, direction: d.map(v => -v), nearKm: 0, farKm: 100 };
        const cube = b.terrainManager.cube;
        await cube.surface.ensureRayCoverage(ray, { maxMeshErrorKm: 0 }, AbortSignal.timeout(30000));
        const hit = cube.surface.intersectRay(ray, { maxMeshErrorKm: 0 });
        if (hit.kind !== 'hit') throw new Error('Missing south-pole CPU terrain');
        const p = new V(hit.position.xKm, hit.position.zKm, -hit.position.yKm);
        const world = p => p.clone().applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(b.position);
        const cc = r.cameraController; cc.cancelAnimation(); cc.controls.enableDamping = false;
        cc.controls.target.copy(world(p)); r.camera.position.copy(world(p.clone().setLength(p.length() + 5)));
        r.camera.up.set(-Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon)).applyQuaternion(b.mesh.quaternion);
        r.camera.lookAt(cc.controls.target); r.camera.updateMatrixWorld(true);
        return { latDeg: -89.67, lonDeg: 129.78, altitudeAboveCpuGroundKm: 5, hit };
      });
      await capture('Shackleton Close-up', true);
      const south = run.views.at(-1).pick.drawn;
      assert.ok(south.latDeg < -89.5, 'Near-surface view must actually pick the south pole');
      for (const [product, count] of Object.entries(run.products)) assert.ok(count > 0, `No hosted ${product} payload observed`);
      assert.deepEqual(run.errors, []); assert.deepEqual(run.transportFailures, []);
    } catch (error) {
      run.failure = error.stack;
      run.failureState = await page.evaluate(() => {
        const r = window.renderer, t = r?.getBodyMesh('Moon')?.terrainManager;
        return { text: document.body.innerText.slice(-2000), assets: r?.initialAssetsSummary, frame: t?.frameAvailability,
          network: t?.metrics.network, cube: t?.cubeStats, imagery: t?.cubeImageryStats };
      }).catch(() => null);
      await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
  report.passed = true;
} finally {
  await writeFile(`${out}/metrics.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
