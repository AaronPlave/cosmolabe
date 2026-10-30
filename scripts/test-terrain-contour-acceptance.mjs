/** Physical-GPU acceptance over actual Mars/Moon terrain and imagery.
 * Uses the existing datum-supported MarsHub v14 catalog source and actual
 * NASA imagery. No generated contour/DEM products or datum relabeling.
 */
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.SURFACE_VIEWER_URL ?? 'http://localhost:5174';
const scene = process.env.CONTOUR_SCENE ?? 'mars';
const output = process.env.CONTOUR_OUTPUT ?? `work/issue-183/acceptance-${scene}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'vulkan'}`, '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl-developer-extensions'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], failures = [], imagery = new Set(), terrain = new Set();
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(m.text())) errors.push(m.text()); });
page.on('response', r => {
  if (r.status() >= 400) failures.push({ url: r.url(), status: r.status() });
  if (r.ok() && /trek.nasa.gov/.test(r.url())) imagery.add(r.url());
  if (r.ok() && /\.terrain(?:\?|$)/.test(r.url())) terrain.add(r.url());
});
const bodyName = scene === 'mars' ? 'Mars' : 'Moon';
const result = { scene, body: bodyName, viewport: [1440, 1000], views: {} };
try {
  let catalogUrl = 'test-catalogs/moonfall-shackleton';
  if (scene === 'mars') {
    const original = JSON.parse(await readFile('apps/viewer/test-catalogs/ingenuity-jezero.json', 'utf8'));
    const mars = original.items.find(i => i.name === 'Mars');
    mars.geometry.terrain = { type: 'quantized-mesh', url: 'https://marshub.s3.amazonaws.com/mars_v14/', referenceRadiusOffsetKm: 8.765, errorTarget: 3, fadeDurationMs: 300, skirtScale: 0.1 };
    mars.geometry.baseMap = `${base}/test-catalogs/textures/mars.dds`;
    // Same catalog Viking + Jezero CTX imagery; keep the validation bounded.
    mars.geometry.imagery = mars.geometry.imagery.filter(i => ['viking', 'jezero-ctx'].includes(i.id));
    const catalog = { name: 'Contour acceptance: real Jezero terrain and imagery', defaultTime: original.defaultTime,
      defaultViewpoint: 'Jezero Overhead', items: original.items.filter(i => ['Sun', 'Mars', 'Jezero Overhead'].includes(i.name)) };
    delete mars.items;
    await page.route('**/contour-acceptance.json', r => r.fulfill({ json: catalog }));
    catalogUrl = 'contour-acceptance';
    result.source = { terrain: 'Existing MarsHub v14 quantized mesh (MSL catalog source), 8.765 km source encoding offset, IAU ellipsoid datum',
      imagery: mars.geometry.imagery.map(i => ({ id: i.id, attribution: i.attribution, url: i.url })), lighting: 'Catalog Sun and built-in Mars ephemeris/rotation; not a fabricated event' };
  }
  await page.goto(`${base}/?catalog=${catalogUrl}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(name => window.renderer?.getBodyMesh(name)?.surfaceAppearance != null, bodyName, { timeout: 120000 });
  console.log(scene, 'renderer ready');
  result.assets = await page.evaluate(() => window.renderer.waitForInitialAssets());
  console.log(scene, 'assets', JSON.stringify(result.assets));
  await page.evaluate(name => { window.cosmo.setPlaying(false); window.renderer.cameraController.resetToFreeOrbit(); window.cosmo.untrack(); window.cosmo.select(name); }, bodyName);
  const views = scene === 'mars' ? {
    close: { eye: [18.44, 77.43, 0], target: [18.45, 77.45, -4.2] },
    regional: { eye: [18.45, 77.4, 80], target: [18.45, 77.4, -4.2] },
    grazing: { eye: [18.43, 77.4, -2], target: [18.46, 77.48, -3.5] },
  } : { close: { eye: [-89.07, 129.78, 6], target: [-89.67, 129.78, -2.5] }, globe: { eye: [-55, 20, 3500], target: null } };
  const profileWholeFrame = async () => page.evaluate(async name => {
    const r = window.renderer, bm = r.getBodyMesh(name), tm = bm.terrainManager, gl = r.renderer.getContext();
    r.stop(); const initial = { ...bm.surfaceAppearance }, pixel = new Uint8Array(4), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const draw = () => { r.renderFrame(); sync(); };
    const stat = values => { const s = [...values].sort((a, b) => a - b); return s.length ? { samples: s.length, medianMs: s[s.length >> 1], p95Ms: s[Math.floor(s.length * 0.95)], maxMs: s.at(-1) } : null; };
    const read = () => { const a = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4); gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, a); return a; };
    const modes = [{ id: 'baseline', contours: false, contourLabels: false }, { id: 'lines', contours: true, contourLabels: false },
      { id: 'labels', contours: true, contourLabels: true }, { id: 'disabled-again', contours: false, contourLabels: false }];
    const measurements = [], activation = []; let baseline;
    for (const mode of modes) {
      const start = performance.now(); bm.setSurfaceAppearance({ ...initial, ...mode, hillshade: false, baseColor: 'imagery' });
      const setterMs = performance.now() - start, first = performance.now(); draw(); const firstSyncFrameMs = performance.now() - first;
      let frames = 1;
      for (; frames < 600; frames++) {
        draw();
        const ready = [...tm.surfaceStyle.meshes].every(([mesh,e]) => {
          let visible = !e.visibilityRoot || !!e.visibilityRoot.parent;
          for(let n=e.visibilityRoot??mesh;n;n=n.parent)if(!n.visible)visible=false;return !visible||e.ready;
        });
        if (ready && (!mode.contourLabels || tm.contourLabels.settled)) break;
        await new Promise(requestAnimationFrame);
      }
      if (frames === 600) throw new Error(`Preparation did not settle: ${mode.id}`);
      activation.push({ mode: mode.id, setterMs, firstSyncFrameMs, readyMs: performance.now() - start, frames });
      for (let i = 0; i < 8; i++) draw();
      const cpu = [], wall = [], queries = [];
      for (let i = 0; i < 60; i++) {
        const q = ext ? gl.createQuery() : null; if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        const start = performance.now(); r.renderFrame(); const submitted = performance.now();
        if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); queries.push(q); } sync();
        cpu.push(submitted - start); wall.push(performance.now() - start);
      }
      const gpu = [];
      for (let attempt = 0; queries.length && attempt < 100; attempt++) {
        await new Promise(requestAnimationFrame);
        while (queries.length && gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)) { gpu.push(gl.getQueryParameter(queries[0], gl.QUERY_RESULT) / 1e6); gl.deleteQuery(queries.shift()); }
      }
      const disjoint = ext ? gl.getParameter(ext.GPU_DISJOINT_EXT) : null;
      measurements.push({ mode: mode.id, cpuSubmission: stat(cpu), synchronizedFrame: stat(wall), gpu: disjoint ? null : stat(gpu), disjoint,
        draws: r.renderer.info.render.calls, triangles: r.renderer.info.render.triangles });
      if (mode.id === 'baseline') baseline = read();
      if (mode.id === 'disabled-again') {
        const after = read(); let changed = 0; for (let i = 0; i < after.length; i += 4) if (Math.max(Math.abs(after[i] - baseline[i]), Math.abs(after[i + 1] - baseline[i + 1]), Math.abs(after[i + 2] - baseline[i + 2])) > 2) changed++;
        measurements.at(-1).restorationChangedPixels = changed;
      }
    }
    return { drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], gpuTimerAvailable: !!ext, activation, measurements };
  }, bodyName);
  for (const [name, pose] of Object.entries(views)) {
    await page.evaluate(({ name, pose }) => {
      const r = window.renderer, bm = r.getBodyMesh(name), V = r.camera.position.constructor;
      const center = bm.getWorldPosition(new V());
      const at = coords => bm.geodeticOffsetKm(...coords, new V()).applyQuaternion(bm.mesh.quaternion).multiplyScalar(r.scaleFactor).add(center);
      const eye = at(pose.eye), target = pose.target ? at(pose.target) : center;
      const controls = r.cameraController.controls; controls.enableDamping = false;
      r.camera.position.copy(eye); r.camera.up.copy(eye.clone().sub(center).normalize());
      controls.target.copy(target); r.camera.lookAt(target); r.camera.updateMatrixWorld(true);
    }, { name: bodyName, pose });
    if (Object.keys(result.views).length) {
      const transition = [];
      for (let block = 0; block < 3; block++) {
        transition.push(...await page.evaluate(async name => {
          const frames=[];
          for(let frame=0;frame<30;frame++) {
            await new Promise(requestAnimationFrame);
            const m=window.renderer.getBodyMesh(name).terrainManager, sources=m.surfaceStyle.contourSources();
            const detached=sources.filter(mesh=>{for(let n=mesh;n;n=n.parent)if(n===m.tiles.group)return false;return true;}).length;
            const levels=[...new Set([...m.tiles.visibleTiles].map(t=>t.internal.depth))].sort((a,b)=>a-b);
            frames.push({visible:m.tiles.visibleTiles.size,levels,sources:sources.length,detached,labels:m.contourLabels.visiblePlacements.size,
              pending:m.metrics.network.queued+m.metrics.network.downloading+m.metrics.network.parsing, intervalKm:m.surfaceStyle.contourIntervalKm});
          }
          return frames;
        }, bodyName));
        if(block===0)await page.screenshot({path:`${output}/${name}-refining.png`});
      }
      result.transitions ??= {}; result.transitions[name]=transition;
      assert.ok(transition.every(f=>f.detached===0),'detached cache roots entered live contour sampling');
    }
    await page.waitForFunction(name => {
      const m = window.renderer.getBodyMesh(name).terrainManager, n = m.metrics.network;
      return m.tiles.visibleTiles.size > 0 && n.queued + n.downloading + n.parsing === 0;
    }, bodyName, { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(4000);
    result.views[name] = await page.evaluate(name => {
      const r = window.renderer, bm = r.getBodyMesh(name), tm = bm.terrainManager, gl = r.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      const point=tm.tiles.group.worldToLocal(r.camera.position.clone()).multiplyScalar(0.001);
      const eye=bm.terrainBodyFixedToGeodetic({xKm:point.x,yKm:point.y,zKm:point.z});
      return { snapshotPhase:'before per-view label settlement', actualCamera:eye, optics:{lighting:r._lightingMode, atmosphereStrength:tm.aerialPerspectiveUniforms?.uAPStrength.value??0, shadowMap:r.renderer.shadowMap.enabled}, gpu: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER), visibleTiles: tm.tiles.visibleTiles.size,
        sourceMeshes: tm.surfaceStyle.contourSources().length, style: bm.surfaceAppearance, paths: tm.contourLabels.paths.length, placements: tm.contourLabels.placements.length, terrain: tm.metrics, source: bm.terrainDiagnostics };
    }, bodyName);
    assert.ok(result.views[name].visibleTiles > 0, 'terrain must be rendered');
    assert.ok(!/swiftshader|software/i.test(result.views[name].gpu), 'acceptance requires the physical GPU');
    if (!result.performance) {
      await page.waitForLoadState('networkidle', { timeout: 30000 });
      result.performance = await profileWholeFrame();
      await page.evaluate(() => { window.renderer.start(); window.cosmo.setPlaying(false); });
      await page.getByRole('checkbox', { name: 'Contours', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Contour elevation labels', exact: true }).check();
    }
    await page.evaluate(name => { const b = window.renderer.getBodyMesh(name); b.setSurfaceAppearance({ ...b.surfaceAppearance, contours: true, contourLabels: true }); }, bodyName);
    await page.waitForFunction(name => window.renderer.getBodyMesh(name).terrainManager.contourLabels.settled, bodyName, { timeout: 120000 });
    await page.waitForTimeout(400);
    result.views[name].labels = await page.evaluate(name => window.renderer.getBodyMesh(name).terrainManager.contourLabels.visiblePlacements.size, bodyName);
    result.views[name].labelDiagnostics = await page.evaluate(name => { const m=window.renderer.getBodyMesh(name).terrainManager;return {interval:m.surfaceStyle.contourIntervalKm,paths:m.contourLabels.paths.length,caches:m.contourLabels.caches.size,placements:m.contourLabels.placements.length,focus:m.contourLabels.focusDistance,source:m.surfaceStyle.contourSources().length,style:m.surfaceStyle.current}; }, bodyName);
    await writeFile(`${output}/progress.json`,JSON.stringify(result,null,2));
    assert.ok(result.views[name].labels > 0, `${name}: actual terrain must have readable labels`);
    await page.screenshot({ path: `${output}/${name}-imagery.png` });
    console.log(scene, name, result.views[name].visibleTiles, 'tiles', result.views[name].labels, 'labels');
    if (name === 'close') {
      for (const [mode, patch] of Object.entries({ hillshade: { hillshade: true }, elevation: { hillshade: false, baseColor: 'elevation' }, imagery: { hillshade: false, baseColor: 'imagery' } })) {
        await page.evaluate(({ name, patch }) => { const b = window.renderer.getBodyMesh(name); b.setSurfaceAppearance({ ...b.surfaceAppearance, ...patch }); }, { name: bodyName, patch });
        await page.waitForTimeout(700); await page.screenshot({ path: `${output}/close-${mode}.png` });
      }
    }
  }
  result.requests = { imagery: [...imagery], terrain: [...terrain] };
  if (scene === 'mars') assert.ok(imagery.size > 0, 'must load actual NASA imagery, not procedural pixels');
  // Complete viewer frames, fenced by readPixels, plus independent GPU timer
  // queries where the hardware/driver exposes them. Timing excludes PNG I/O.

  result.errors = errors; result.failures = failures;
  await writeFile(`${output}/metrics.json`, JSON.stringify(result, null, 2) + '\n');
  assert.ok(result.performance.gpuTimerAvailable, 'acceptance requires hardware GPU timing');
  assert.ok(result.performance.measurements.every(m => m.gpu?.samples === 60 && !m.disjoint), 'GPU samples must complete without a disjoint event');
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, [], 'terrain and imagery requests must succeed');
  assert.equal(result.performance.measurements.at(-1).restorationChangedPixels, 0, 'disabling must restore the original view');
} finally { await browser.close(); }
