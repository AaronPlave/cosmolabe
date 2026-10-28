/** Fixed site-mesh/Curiosity regression in the actual viewer and GPU.
 * node scripts/test-curiosity-site-mesh.mjs VIEWER_URL OUTPUT_DIR
 * SITE_MESH_SYNTHETIC=1 adds the second, synthetic ENU site through catalog input.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://127.0.0.1:5177/';
const out = process.argv[3] ?? 'work/curiosity-247/browser';
await mkdir(out, { recursive: true });
const synthetic = process.env.SITE_MESH_SYNTHETIC === '1';
const localized = process.env.SITE_MESH_LOCALIZED === '1';
const catalogId = localized ? 'msl-dingo-gap-localized' : 'msl-dingo-gap';
const states = localized
  ? { rows: JSON.parse(await readFile('docs/validation/curiosity-gale/pose-chain.json', 'utf8')).rows.map(r =>
    ({ utc:r.utc, et:r.et, positionKm:r.localizedPositionKm, roverToBody:r.localizedRoverToBody })) }
  : JSON.parse(await readFile('docs/validation/curiosity-gale/spice-states.json', 'utf8'));
const browser = await chromium.launch({ headless: true,
  ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  args: ['--enable-gpu', '--ignore-gpu-blocklist', process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
const page = await context.newPage(); page.setDefaultTimeout(120000);
const report = { synthetic, localized, passed: false, views: [], states: [], errors: [], requestFailures: [] };
let sourceFault = false;
await page.route('**/NASA-AMMOS/3DTilesSampleData/**', route => sourceFault && route.request().url().endsWith('.b3dm')
  ? route.fulfill({ status: 503, body: 'Deliberate site-mesh outage fixture' }) : route.continue());
page.on('pageerror', e => report.errors.push(e.message));
page.on('requestfailed', r => report.requestFailures.push({ url: r.url(), error: r.failure()?.errorText }));
if (synthetic) await page.route(`**/test-catalogs/${catalogId}.json`, async route => {
  const response = await route.fetch(), catalog = await response.json();
  const mesh = structuredClone(catalog.items.find(i => i.name === 'Mars').geometry.surfaceTiles[0]);
  const m = mesh.registration.bodyFixedKmFromLocalMeters;
  // Source axes ENU differ from Dingo Gap's NED. Place the synthetic square 30m north.
  mesh.registration.bodyFixedKmFromLocalMeters = [
    ...m.slice(4,8), ...m.slice(0,4), ...m.slice(8,12).map((v,i) => i < 3 ? -v : v),
    ...m.slice(12,15).map((v,i) => v+30*m[i]), 1,
  ];
  Object.assign(mesh, { name: 'Synthetic ENU square', url: 'fixtures/site-mesh/tileset.json', sourceVersion: 'synthetic-v1',
    coverage: { min: [-2,-2,-.1], max: [2,2,.1] }, priority: 10 });
  mesh.registration.version = 'synthetic-enu-v1';
  catalog.items.find(i => i.name === 'Mars').geometry.surfaceTiles.push(mesh);
  await route.fulfill({ response, json: catalog });
});
async function snapshot() {
  return page.evaluate(() => {
    const r = window.renderer, b = r.getBodyMesh('Mars'), t = b.terrainManager;
    return { overlays: b.getSurfaceOverlays().map(o => ({ name: o.name, fixed: o.tiles.group.matrix.toArray(),
      registration: o.registration, visible: o.group.visible, models: o.tiles.visibleTiles.size,
      failed: o.tiles.stats.failed, policy: o.physicalQueryPolicy })),
      cameraToRoverKm: r.camera.position.distanceTo(r.getBodyMesh('Curiosity').position)/r.scaleFactor,
      imagery: b.imageryLayers.map(({id,visible,opacity}) => ({id,visible,opacity})),
      cube: t?.cubeStats, imageStats: t?.cubeImageryStats };
  });
}
async function settledSite() {
  await page.waitForFunction(() => {
    const b = window.renderer.getBodyMesh('Mars');
    // The small second site is legitimately outside a rover close-up's frustum.
    const o=b.getSurfaceOverlays()[0];return !o.group.visible || o.tiles.visibleTiles.size > 0;
  });
  await page.waitForTimeout(1000);
}
try {
  await page.goto(`${base}?catalog=test-catalogs/${catalogId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.renderer?.getBodyMesh('Mars')?.hasSurfaceTiles);
  await page.waitForFunction(() => window.renderer.getBodyMesh('Mars').terrainManager?.cubeImageryStats?.version);
  await page.evaluate(async () => { await window.renderer.waitForInitialAssets(); window.cosmo.setPlaying(false); });
  await page.getByText(localized
    ? 'Orbital-localized rover position + telemetry attitude. Estimated site registration; this view does not establish measured wheel clearance.'
    : 'Telemetry rover pose: apparent height is not measured ground clearance. Compare the orbital-localized Curiosity demo in the catalog browser.', { exact: true }).waitFor({state:'visible'});
  report.gpu = await page.evaluate(() => { const gl = window.renderer.getContext().webglRenderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER); });
  const initial = await snapshot(), fixed = initial.overlays.map(o => o.fixed);
  for (const name of ['Mars Orbit','Dingo Gap Approach','Curiosity Surface','Curiosity Close-up','Dingo Gap Daylight']) {
    assert.equal(await page.evaluate(name => window.cosmo.viewpoint(name), name), true);
    await page.waitForTimeout(4000); await settledSite();
    if (name === 'Curiosity Close-up') await page.waitForFunction(() => {
      const r=window.renderer; return r.camera.position.distanceTo(r.getBodyMesh('Curiosity').position)/r.scaleFactor < .0201;
    },null,{timeout:30000});
    const state = await snapshot(); assert.deepEqual(state.overlays.map(o => o.fixed), fixed);
    assert.ok(state.cube?.version, 'Cube geometry/CPU manifest must load');
    assert.equal(state.imageStats?.baseUncoveredBlocks, 0, 'Mandatory Viking base must cover visible terrain');
    report.views.push({ name, ...state });
    console.log(JSON.stringify({view:name,meshes:state.overlays.map(o=>o.models),terrain:state.cube.version}));
    await page.screenshot({ path: `${out}/${name.toLowerCase().replaceAll(' ','-')}.png` });
  }
  for (const expected of states.rows) {
    const row = await page.evaluate(expected => {
      const r=window.renderer; r.timeController.setTime(expected.et); r.renderFrame();
      const b=r.getBodyMesh('Mars'), rover=r.getBodyMesh('Curiosity');
      const p=rover.position.clone().sub(b.position).divideScalar(r.scaleFactor).applyQuaternion(b.mesh.quaternion.clone().invert());
      const point=[p.x,-p.z,p.y], e=expected.positionKm;
      const mq=b.body.rotationAt(expected.et),rq=rover.body.rotationAt(expected.et),Q=r.camera.quaternion.constructor;
      const relative=new Q(mq[1],mq[2],mq[3],mq[0]).multiply(new Q(rq[1],rq[2],rq[3],rq[0]).invert());
      const matrix=new b.mesh.matrix.constructor().makeRotationFromQuaternion(relative).elements;
      const actual=[matrix[0],matrix[4],matrix[8],matrix[1],matrix[5],matrix[9],matrix[2],matrix[6],matrix[10]];
      return {utc:expected.utc, bodyFixedKm:point, errorM:Math.hypot(point[0]-e.x,point[1]-e.y,point[2]-e.z)*1000,
        attitudeMatrixMaxError:Math.max(...actual.map((v,i)=>Math.abs(v-expected.roverToBody[i])))};
    }, expected);
    report.states.push(row); assert.ok(row.errorM < .01, `SPICE pose changed: ${JSON.stringify(row)}`);
    assert.ok(row.attitudeMatrixMaxError < 1e-10, 'SPICE attitude changed');
  }
  await page.evaluate(() => { for (const o of window.renderer.getBodyMesh('Mars').getSurfaceOverlays()) o.retryFailed(); });
  assert.deepEqual((await snapshot()).overlays.map(o => o.fixed), fixed);
  report.recoveryTransformStable = true;
  // Physical picking and camera clearance continue to come from the cube,
  // even while a reconstruction with detailed rocks is drawn over its pixels.
  assert.equal(await page.evaluate(() => window.cosmo.viewpoint('Dingo Gap Daylight')),true);
  await settledSite();
  report.physicalQuery = await page.evaluate(async () => {
    const b=window.renderer.getBodyMesh('Mars'),o=b.getSurfaceOverlays()[0],m=o.registration.bodyFixedKmFromLocalMeters;
    const p=m.slice(12,15),length=Math.hypot(...p),d=p.map(x=>x/length);
    const ray={origin:{xKm:d[0]*3500,yKm:d[1]*3500,zKm:d[2]*3500},direction:d.map(x=>-x),nearKm:0,farKm:200};
    await b.terrainManager.cube.surface.ensureRayCoverage(ray,{maxMeshErrorKm:0},AbortSignal.timeout(30000));
    return b.intersectTerrainRay(ray,{maxMeshErrorKm:0});
  });
  assert.equal(report.physicalQuery?.kind,'hit');
  assert.equal(report.physicalQuery.metadata.source.kind,'height-grid');

  // Drive an actual loader failure after evicting unused content, then recover
  // at the same fixed placement. The original cube remains the physical fallback.
  report.cacheBefore = await page.evaluate(() => window.renderer.getBodyMesh('Mars').getSurfaceOverlays()[0].tiles.lruCache.cachedBytes);
  sourceFault=true;
  await page.evaluate(() => {
    window.cosmo.viewpoint('Mars Orbit');
    for(const o of window.renderer.getBodyMesh('Mars').getSurfaceOverlays()) {
      o.tiles.lruCache.maxBytesSize=256*1024;o.tiles.lruCache.minBytesSize=0;
      o.tiles.lruCache.minSize=0;
    }
  });
  await page.evaluate(async () => {
    for(let i=0;i<120;i++) {
      await new Promise(requestAnimationFrame);
      for(const o of window.renderer.getBodyMesh('Mars').getSurfaceOverlays()) {
        o.tiles.lruCache.markAllUnused();o.tiles.lruCache.unloadUnusedContent();
      }
    }
  });
  report.cacheAfterEviction = await page.evaluate(() => window.renderer.getBodyMesh('Mars').getSurfaceOverlays()[0].tiles.lruCache.cachedBytes);
  assert.ok(report.cacheAfterEviction < report.cacheBefore, 'The cache eviction phase must release content');
  await page.evaluate(() => window.cosmo.viewpoint('Curiosity Close-up'));
  await page.waitForFunction(() => window.renderer.getBodyMesh('Mars').getSurfaceOverlays()[0].tiles.stats.failed > 0);
  report.failed = await snapshot();
  assert.deepEqual(report.failed.overlays.map(o=>o.fixed),fixed);
  sourceFault=false;
  await page.evaluate(() => { for(const o of window.renderer.getBodyMesh('Mars').getSurfaceOverlays()) {
    o.tiles.lruCache.maxBytesSize=128*1024*1024;o.tiles.lruCache.minBytesSize=96*1024*1024;o.retryFailed();
  }});
  await settledSite();report.recovered=await snapshot();
  assert.deepEqual(report.recovered.overlays.map(o=>o.fixed),fixed);
  assert.ok(report.recovered.overlays[0].models>0);
  if (synthetic) {
    assert.equal(initial.overlays.length, 2);
    assert.ok(report.views.some(v=>v.overlays[1].models>0),'Second ENU mesh must actually load and draw');
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(1000);
  await page.screenshot({ path: `${out}/compact.png` });
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  await writeFile(`${out}/acceptance.json`, JSON.stringify(report,null,2)+'\n'); await browser.close();
}
console.log(JSON.stringify({passed:report.passed,gpu:report.gpu,views:report.views.length,states:report.states},null,2));
