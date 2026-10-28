/** Normal hosted rewrite, cold GPU load, controls, navigation and catalog reload.
 * node scripts/test-hosted-curiosity.mjs VIEWER_URL OUTPUT_DIR
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { identity } from './surface-build/plan.mjs';
import { loadDatasets } from './data-hosting/lib/datasets.mjs';
import { rewriteCatalog } from './data-hosting/lib/hosted-catalogs.mjs';
const [base, out] = process.argv.slice(2);
assert.ok(base && out, 'VIEWER_URL OUTPUT_DIR required');
await mkdir(out, { recursive: true });
const receipt = JSON.parse(await readFile('docs/validation/curiosity-gale/publication-receipt.json', 'utf8'));
const { identity: receiptId, ...receiptBody } = receipt;
assert.equal(identity(receiptBody), receiptId);
assert.equal(receipt.localOnly, false);
const source = JSON.parse(await readFile('apps/viewer/test-catalogs/msl-dingo-gap.json', 'utf8'));
const expected = rewriteCatalog(source, 'test-catalogs/msl-dingo-gap.json', loadDatasets().datasets, receipt.baseUrl).json;
const browser = await chromium.launch({ headless: true,
  ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  args: ['--enable-gpu', '--ignore-gpu-blocklist', process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
const page = await context.newPage(); page.setDefaultTimeout(180000);
page.on('console', message => { if (message.type() === 'error') console.log('browser: ' + message.text().slice(0, 400)); });
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
const report = { passed: false, coldBrowserCache: true, catalogInterception: false, publicationIdentity: receipt.publicationIdentity,
  products: {}, errors: [], views: [], controls: [], navigation: [], regressions: [] }, pending = [];
page.on('pageerror', e => report.errors.push(e.message));
page.on('response', response => {
  if (response.status() >= 400 && !response.url().endsWith('favicon.ico')) report.errors.push(`${response.status()} ${response.url()}`);
  const product = receipt.products.find(p => response.url().startsWith(receipt.baseUrl + '/' + p.prefix));
  if (product && response.status() === 200) {
    const observed = report.products[product.productId] ??= { requests: 0 };
    observed.requests++;
    if (!observed.sample) pending.push(response.allHeaders().then(headers => { observed.sample ??= { url: response.url(), headers }; }));
  }
});
const settle = async body => {
  const idle = body => {
    const t = window.renderer?.getBodyMesh(body)?.terrainManager, n = t?.metrics.network, i = t?.cubeImageryStats;
    return t?.tiles.visibleTiles.size > 0 && n.queued + n.downloading + n.parsing === 0
      && t.cubeStats.inFlight === 0 && (!i || (i.inFlight === 0 && (i.queued === 0 || i.budgetLimited)));
  };
  const deadline = Date.now() + 180000;
  do {
    await page.waitForFunction(idle, body, { timeout: Math.max(1, deadline - Date.now()) });
    await page.waitForTimeout(500);
    if (await page.evaluate(idle, body)) return;
  } while (Date.now() < deadline);
  throw new Error('Requests did not settle: ' + body);
};
const snapshot = () => page.evaluate(() => {
  const r = window.renderer, b = r.getBodyMesh('Mars');
  return { fixed: b.getSurfaceOverlays().map(o => o.tiles.group.matrix.toArray()),
    models: b.getSurfaceOverlays().map(o => o.tiles.visibleTiles.size), imagery: b.imageryLayers,
    cube: b.terrainManager.cubeStats, images: b.terrainManager.cubeImageryStats,
    cameraToRoverKm: r.camera.position.distanceTo(r.getBodyMesh('Curiosity').position) / r.scaleFactor };
});
try {
  const response = await context.request.get(new URL('test-catalogs/msl-dingo-gap.json', base).href);
  assert.equal(response.status(), 200); assert.deepEqual(await response.json(), expected);
  console.log('hosted catalog matches normal rewrite');
  await page.goto(`${base}?catalog=test-catalogs/msl-dingo-gap`, { waitUntil: 'domcontentloaded' });
  console.log('viewer document loaded');
  await page.waitForFunction(() => window.renderer?.getBodyMesh('Mars')?.hasSurfaceTiles);
  console.log('site mesh initialized');
  await page.evaluate(async () => { await window.renderer.waitForInitialAssets(); window.cosmo.setPlaying(false); });
  console.log('initial assets complete');
  assert.equal(await page.evaluate(() => window.cosmo.viewpoint('Mars Orbit')), true);
  await settle('Mars');
  report.gpu = await page.evaluate(() => { const gl = window.renderer.getContext().webglRenderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER); });
  assert.doesNotMatch(report.gpu, /swiftshader|llvmpipe|software/i);
  const fixed = (await snapshot()).fixed;
  for (const view of ['Mars Orbit', 'Dingo Gap Approach', 'Curiosity Close-up', 'Dingo Gap Daylight']) {
    assert.equal(await page.evaluate(view => window.cosmo.viewpoint(view), view), true);
    await settle('Mars');
    if (view !== 'Mars Orbit') await page.waitForFunction(() => window.renderer.getBodyMesh('Mars').getSurfaceOverlays()[0].tiles.visibleTiles.size > 0);
    const state = await snapshot(); assert.deepEqual(state.fixed, fixed);
    assert.equal(state.images.baseUncoveredBlocks, 0);
    if (view === 'Curiosity Close-up') assert.ok(state.cameraToRoverKm < .0201);
    report.views.push({ view, ...state });
    await page.screenshot({ path: `${out}/${view.toLowerCase().replaceAll(' ', '-')}.png` });
    console.log('hosted view: ' + view);
  }
  // Exercise the same independent stack API used by the existing imagery UI.
  for (const id of ['viking', 'gale-ctx', 'curiosity-hirise']) {
    await page.evaluate(id => { const b = window.renderer.getBodyMesh('Mars');
      for (const l of b.imageryLayers) b.setImageryLayerVisible(l.id, l.id === id || l.id === 'viking');
      b.setImageryLayerOpacity(id, .35); b.moveImageryLayer(id, b.imageryLayers.length - 1);
    }, id);
    await settle('Mars'); const state = await snapshot();
    const layer = state.imagery.find(l => l.id === id); assert.equal(layer.visible, true); assert.equal(layer.opacity, .35);
    assert.equal(id === 'viking' ? state.imagery[0].id : state.imagery.at(-1).id, id);
    assert.deepEqual(state.fixed, fixed);
    assert.equal(state.images.baseUncoveredBlocks, 0); report.controls.push({ id, imagery: state.imagery });
  }
  await page.evaluate(() => { const b = window.renderer.getBodyMesh('Mars');
    for (const [i, id] of ['viking', 'gale-ctx', 'curiosity-hirise'].entries()) {
      b.setImageryLayerVisible(id, true); b.setImageryLayerOpacity(id, 1); b.moveImageryLayer(id, i);
    }
  });
  // Walk radial ground views across the local crop and its global fallback.
  for (const northM of [-300, -100, 0, 100, 300]) {
    report.navigation.push(await page.evaluate(async northM => {
      const r = window.renderer, b = r.getBodyMesh('Mars'), V = r.camera.position.constructor;
      window.cosmo.untrack();
      const lat = (-4.626550593 + northM / 59274.696) * Math.PI / 180, lon = 137.407262581 * Math.PI / 180;
      const d = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
      const ray = { origin: { xKm: d[0]*3500, yKm: d[1]*3500, zKm: d[2]*3500 }, direction: d.map(v => -v), nearKm: 0, farKm: 200 };
      await b.terrainManager.cube.surface.ensureRayCoverage(ray, { maxMeshErrorKm: 0 }, AbortSignal.timeout(30000));
      const hit = b.intersectTerrainRay(ray, { maxMeshErrorKm: 0 });
      if (hit.kind !== 'hit') throw new Error('Missing ground at ' + northM);
      const p = new V(hit.position.xKm, hit.position.zKm, -hit.position.yKm);
      const toWorld = p => p.clone().applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(b.position);
      r.cameraController.controls.enableDamping = false;
      r.cameraController.controls.target.copy(toWorld(p));
      r.camera.position.copy(toWorld(p.clone().setLength(p.length()+.05)));
      r.camera.lookAt(r.cameraController.controls.target); r.camera.updateMatrixWorld(true);
      return { northM, source: hit.metadata.source.kind, radiusKm: p.length() };
    }, northM));
    await settle('Mars');
    const clearance = await page.evaluate(() => {
      const r = window.renderer, b = r.getBodyMesh('Mars');
      const p = r.camera.position.clone().sub(b.position).divideScalar(r.scaleFactor).applyQuaternion(b.mesh.quaternion.clone().invert());
      const nav = b.terrainNavigationSurface({ xKm: p.x, yKm: -p.z, zKm: p.y });
      return nav?.radiusKm == null ? null : (p.length() - nav.radiusKm)*1000;
    });
    assert.ok(clearance != null && clearance >= .09, 'Camera must clear both physical and drawn ground');
    report.navigation.at(-1).clearanceM = clearance;
    assert.deepEqual((await snapshot()).fixed, fixed);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.renderer?.getBodyMesh('Mars')?.hasSurfaceTiles);
  await page.evaluate(async () => { await window.renderer.waitForInitialAssets(); window.cosmo.setPlaying(false); window.cosmo.viewpoint('Dingo Gap Daylight'); });
  await settle('Mars'); assert.deepEqual((await snapshot()).fixed, fixed); report.reloadTransformStable = true;
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: `${out}/compact.png` });
  await Promise.all(pending);
  for (const p of receipt.products) {
    const observed = report.products[p.productId]; assert.ok(observed?.requests > 0, p.productId);
    assert.match(observed.sample.headers.server, /cloudflare/i);
    assert.match(observed.sample.headers['cache-control'], /immutable/i);
  }
  // Both missions share the camera/terrain path changed here. Cold reload each
  // catalog and use its existing surface-locked model close-up.
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [catalog, body, view] of [['ingenuity-jezero', 'Mars', null], ['moonfall-shackleton', 'Moon', 'Polaris-A Close-up']]) {
    await page.goto(`${base}?catalog=test-catalogs/${catalog}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(body => window.renderer?.getBodyMesh(body)?.terrainManager?.cubeStats?.version, body);
    await page.evaluate(async view => { await window.renderer.waitForInitialAssets(); window.cosmo.setPlaying(false); if (view && !window.cosmo.viewpoint(view)) throw new Error('Missing regression viewpoint'); }, view);
    await settle(body);
    const state = await page.evaluate(body => { const r = window.renderer, b = r.getBodyMesh(body), c = r.camera.position;
      return { cube: b.terrainManager.cubeStats, imagery: b.terrainManager.cubeImageryStats, finiteCamera: c.toArray().every(Number.isFinite), surface: b.surfaceTransitionState };
    }, body);
    assert.equal(state.finiteCamera, true); if (state.imagery) assert.equal(state.imagery.baseUncoveredBlocks, 0);
    report.regressions.push({ catalog, view, ...state }); await page.screenshot({ path: `${out}/${catalog}.png` });
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  report.failure = error.stack; await page.screenshot({ path: `${out}/failure.png` }).catch(() => {}); throw error;
} finally {
  await writeFile(`${out}/acceptance.json`, JSON.stringify(report, null, 2)+'\n'); await browser.close();
}
console.log(JSON.stringify({ passed: report.passed, gpu: report.gpu, products: Object.keys(report.products), regressions: report.regressions.map(r => r.catalog) }));
