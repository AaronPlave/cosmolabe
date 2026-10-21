/** Real #245 Mars terrain + separately built source pyramids; no test-mode scene.
 * Build: python3 scripts/build-mars-terrain/cube-imagery.py
 * Serve: DEV_DATA_MODE=local npm --prefix apps/viewer run dev -- --port 5196
 * Run: node scripts/test-mars-cube-imagery.mjs
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.MARS_IMAGERY_URL ?? 'http://127.0.0.1:5196';
const output = process.env.MARS_IMAGERY_OUT ?? 'work/cube-imagery/mars';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [], requests = [];
let faultActive = false, expectedFaults = 0;
page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
page.on('response', r=>{ if(faultActive && r.status()===404 && /ctx-global\/tiles/.test(r.url())) { expectedFaults++; return; } if(r.status()>=400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${r.url()}`); });
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('status of 404')) { errors.push(m.text()); console.error(m.text()); } });
page.on('request', r => { if (/\.(glb|png)(\?|$)/.test(r.url())) requests.push(r.url()); });
const result = { views: {}, cycles: [], errors };
async function settle(allowBudgetLimited = false) {
  await page.waitForFunction(allowBudgetLimited => {
    const t = window.renderer.getBodyMesh('Mars').terrainManager, n = t.metrics.network, i = t.cubeImageryStats;
    return t.tiles.visibleTiles.size > 0 && n.queued + n.downloading + n.parsing === 0 && (i?.queued === 0 || (allowBudgetLimited && i?.budgetLimited)) && i?.inFlight === 0;
  }, allowBudgetLimited, { timeout: 120000 });
  await page.waitForTimeout(300);
}
async function pose(lat, lon, altitudeKm) {
  return page.evaluate(async ({ lat, lon, altitudeKm }) => {
    const r = window.renderer, b = r.getBodyMesh('Mars'), t = b.terrainManager, V = r.camera.position.constructor;
    window.cosmo.setPlaying(false); window.cosmo.untrack();
    const rad = Math.PI / 180, d = [Math.cos(lat*rad)*Math.cos(lon*rad), Math.cos(lat*rad)*Math.sin(lon*rad), Math.sin(lat*rad)];
    const ray = { origin: { xKm: d[0]*3500, yKm: d[1]*3500, zKm: d[2]*3500 }, direction: d.map(x => -x), nearKm: 0, farKm: 300 };
    await t.cube.surface.ensureRayCoverage(ray, { maxMeshErrorKm: 0 }, new AbortController().signal);
    const hit = b.intersectTerrainRay(ray, { maxMeshErrorKm: 0 });
    if (hit?.kind !== 'hit') throw new Error('No physical Mars surface for pose: '+JSON.stringify(hit));
    window.marsImageryRay = ray;
    const point = hit.position, target = [point.xKm, point.yKm, point.zKm];
    const centre = new V(); b.getWorldPosition(centre);
    const toWorld = ([x,y,z]) => new V(x,z,-y).applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
    const eye = toWorld(target.map((x,i) => x + d[i]*altitudeKm)), aim = toWorld(target), c = r.camera, controls = r.cameraController.controls;
    controls.enableDamping = false; controls.target.copy(aim); c.fov = 40; c.updateProjectionMatrix(); c.position.copy(eye);
    const north = [-Math.sin(lat*rad)*Math.cos(lon*rad), -Math.sin(lat*rad)*Math.sin(lon*rad), Math.cos(lat*rad)];
    c.up.copy(toWorld(north).sub(centre).normalize()); c.lookAt(aim); c.updateMatrixWorld(true);
    return hit;
  }, { lat, lon, altitudeKm });
}
async function snapshot() {
  return page.evaluate(async root => {
    const { cubeTileAt, cubeTileId, directionToCubeFace } = await import(root + '/packages/three/src/surface/CubeSphere.ts');
    const { texelGroundSizeKm } = await import(root + '/packages/three/src/surface/CubeImagery.ts');
    const r = window.renderer, b = r.getBodyMesh('Mars'), t = b.terrainManager, renderer = r.getContext().webglRenderer;
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    const ids = [...t.tiles.visibleTiles].map(x => x.content?.uri).sort();
    const attributes = [...t.tiles.visibleTiles].flatMap(tile => {
      const positions = [];
      tile.engineData?.scene?.traverse(o => { if (o.isMesh && !o.name.startsWith('cube-imagery-block')) positions.push([o.uuid, o.geometry.uuid, o.geometry.getAttribute('position').uuid, o.geometry.getAttribute('position').count]); });
      return positions;
    });
    const cpuHit = b.intersectTerrainRay(window.marsImageryRay, { maxMeshErrorKm: 0 });
    const radiusKm = Math.hypot(...Object.values(cpuHit.position));
    const d = Object.values(window.marsImageryRay.origin), face = directionToCubeFace(d), layer = t.cubeImageryLayer;
    let centreImagery = null;
    for (const record of layer.tiles.values()) {
      if (!record.scene.parent || !record.scene.visible || cubeTileId(cubeTileAt(d,record.address.level)) !== cubeTileId(record.address)) continue;
      for (const m of record.meshes) {
        const candidates = m.mesh.visible ? [{ uniforms:m.uniforms }] : [...m.blocks].filter(([id,block]) => block.mesh.visible && cubeTileId(cubeTileAt(d,Number(id.split('/')[1])))===id).map(([,block])=>block);
        for (const candidate of candidates) centreImagery = { geometry:record.address, sources:candidate.uniforms.layers.map((u,i)=> {
          const entry = [...layer.entries.values()].find(e=>e.texture && e.texture===u.map.value), source = layer.order[i];
          return { id:source.info.id, enabled:u.enabled.value, level:u.level.value, address:entry?.address,
            outputMetersPerPixel:u.enabled.value ? texelGroundSizeKm(u.level.value,face.u,face.v,radiusKm,source.manifest.tileSize)*1000:null };
        }) };
      }
    }
    return { centreImagery, eyeWorld: r.camera.position.toArray(), centre: b.position.toArray(), scale: r.scaleFactor, eyeBodyKm: t.tiles.group.worldToLocal(r.camera.position.clone()).multiplyScalar(.001).toArray(), ray: window.marsImageryRay, gpu: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER), ids, attributes, imagery: t.cubeImageryStats,
      terrain: t.metrics, layers: b.imageryLayers, cpuHit, draws: renderer.info.render.calls,
      textureCount: renderer.info.memory.textures, drawingSize: renderer.getDrawingBufferSize(r.camera.position.clone()).toArray().slice(0,2) };
  }, '/@fs' + process.cwd());
}
async function cap(level) { await page.evaluate(maxLevel => window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.setOptions({ maxLevel }), level); }
async function timing(motion = false) {
  const measurement = page.evaluate(async motion => {
    const r = window.renderer, old = r.renderFrame, gl = r.getContext().webglRenderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const cpu = [], completed = [], timestamps = [], queries = [];
    const startEye = r.camera.position.clone();
    r.renderFrame = function (...args) {
      // Drain earlier submissions; finish includes actual GPU completion, giving
      // a conservative total frame cost when hardware timer queries are unavailable.
      gl.finish();
      const query = ext ? gl.createQuery() : null;
      const start = performance.now();
      if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      const value = old.apply(this, args);
      if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); queries.push(query); }
      const submitted = performance.now(); gl.finish();
      cpu.push(submitted-start); completed.push(performance.now()-start); timestamps.push(start);
      return value;
    };
    try { for (let i=0; i<120; i++) await new Promise(requestAnimationFrame); }
    finally { r.renderFrame = old; }
    const gpu = [];
    const disjoint = ext ? gl.getParameter(ext.GPU_DISJOINT_EXT) : null;
    for (const query of queries) {
      if (!disjoint && gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT)/1e6);
      gl.deleteQuery(query);
    }
    const summarize = samples => { samples.sort((a,b)=>a-b); return { frames: samples.length, medianMs: samples[samples.length>>1], p95Ms: samples[Math.floor(samples.length*.95)] }; };
    const intervals = timestamps.slice(1).map((t,i)=>t-timestamps[i]);
    const cameraDistance = startEye.distanceTo(r.camera.position);
    if (motion && cameraDistance === 0) throw new Error('Motion benchmark camera did not move');
    return { ...summarize(cpu), completedFrame: summarize(completed), frameIntervals: summarize(intervals),
      gpu: gpu.length ? summarize(gpu) : null, timerQueryAvailable: !!ext, disjoint, motion, cameraDistance };
  }, motion);
  if (motion) {
    await page.mouse.move(600,450); await page.mouse.down();
    try {
      for (let i=0; i<100; i++) {
        await page.mouse.move(600+i*2,450+i*.3);
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
    } finally { await page.mouse.up(); }
  }
  return measurement;
}
try {
  await page.goto(`${base}/?catalog=test-catalogs/mars-cube-imagery-experiment`, { timeout: 120000 });
  await page.waitForFunction(() => window.renderer?.getBodyMesh('Mars')?.terrainManager?.cubeImageryStats?.ready, null, { timeout: 120000 });
  await page.evaluate(async () => { await window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.ready; window.cosmo.setPlaying(false); window.cosmo.select('Mars'); });
  for (const [name, lat, lon] of [['inside',18.4447,77.4508], ['outside',18.9,77.4]]) {
    console.log('view', name);
    await cap(3); const hit = await pose(lat,lon,1.2); await settle();
    await cap(Number(hit.tileId.split('/')[1])); await settle();
    const coarse = await snapshot(), coarseTiming = await timing();

    await page.locator('canvas').first().screenshot({ path: `${output}/${name}-coarse.png` });
    const before = requests.length;
    await cap(undefined); await settle();
    const fine = await snapshot(), fineTiming = await timing();
    await page.locator('canvas').first().screenshot({ path: `${output}/${name}-fine.png` });
    assert.deepEqual(fine.ids, coarse.ids);
    assert.deepEqual(fine.attributes, coarse.attributes);
    assert.deepEqual(fine.cpuHit, coarse.cpuHit);
    assert.equal(requests.slice(before).filter(u=>u.endsWith('.glb')).length, 0);
    assert.ok(fine.centreImagery);
    const source = fine.centreImagery.sources.find(s=>s.id === (name==='outside' ? 'ctx-global':'jezero-hirise'));
    assert.ok(source.enabled);
    assert.ok(source.level > fine.centreImagery.geometry.level);
    if(name === 'outside') assert.ok(source.outputMetersPerPixel <= 5);
    assert.ok(fine.imagery.textureBytes <= fine.imagery.maxTextureBytes);
    result.views[name] = { coarse, fine, coarseTiming, fineTiming };
  }
  for (let i=0; i<5; i++) {
    await pose(18.9,77.4,i%2 ? 1.2 : 30); await settle(); const s=await snapshot();
    assert.ok(s.imagery.textureBytes <= s.imagery.maxTextureBytes); result.cycles.push(s.imagery);
  }
  const hiddenRequests = requests.length;
  await page.evaluate(() => { const b=window.renderer.getBodyMesh('Mars'); b.setImageryLayerVisible('ctx-global',false); b.setImageryLayerVisible('jezero-ctx',false); b.setImageryLayerVisible('jezero-hirise',false); });
  await settle(); result.baseOnly = await snapshot();
  assert.ok(!requests.slice(hiddenRequests).some(u=>/mars-imagery-cube\/(ctx-global|jezero-ctx|jezero-hirise)\//.test(u)));
  await page.locator('canvas').first().screenshot({ path: `${output}/base-only.png` });
  await page.evaluate(() => { const b=window.renderer.getBodyMesh('Mars'); ['ctx-global','jezero-ctx','jezero-hirise'].forEach(id=>b.setImageryLayerVisible(id,true)); });
  await pose(18.4447,77.4508,1.2); await settle();
  const original = await page.locator('canvas').first().screenshot(), originalState = await snapshot();
  await page.evaluate(() => { const b=window.renderer.getBodyMesh('Mars'); b.moveImageryLayer('jezero-hirise',1); b.setImageryLayerOpacity('jezero-ctx',0.5); });
  await settle(); const reordered = await page.locator('canvas').first().screenshot();
  assert.notDeepEqual(reordered,original);
  await page.evaluate(() => { const b=window.renderer.getBodyMesh('Mars'); b.moveImageryLayer('jezero-hirise',3); b.setImageryLayerOpacity('jezero-ctx',1); });
  await settle(); const restored = await page.locator('canvas').first().screenshot(), restoredState = await snapshot();
  assert.deepEqual(restored,original);
  assert.deepEqual(restoredState.attributes,originalState.attributes);
  assert.deepEqual(restoredState.cpuHit,originalState.cpuHit);
  result.controls = { reorderAndOpacityChangePixels:true, restoresExactPixels:true, physicalGeometryUnchanged:true };
  // Deliberately constrain residency and revisit both regions to exercise eviction.
  await page.evaluate(() => window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.setOptions({maxTextureBytes:24*2**20}));
  for (const lat of [18.9,18.4447,18.9]) {
    await pose(lat,lat===18.9?77.4:77.4508,1.2); await settle(true); const s=await snapshot();
    assert.ok(s.imagery.textureBytes<=24*2**20); result.cycles.push(s.imagery);
  }
  assert.ok(result.cycles.at(-1).evicted > 0);
  // Cold missing-source-tile path, followed by explicit outage recovery.
  await page.route('**/mars-imagery-cube/ctx-global/tiles/**', route => {
    const level=Number(/tiles\/[^/]+\/(\d+)\//.exec(route.request().url())[1]);
    return faultActive && level>=10 ? route.fulfill({status:404,body:'simulated missing source tile'}) : route.continue();
  });
  faultActive=true;
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.renderer?.getBodyMesh('Mars')?.terrainManager?.cubeImageryStats?.ready,null,{timeout:120000});
  await page.evaluate(async()=>{ await window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.ready; window.cosmo.setPlaying(false); });
  await pose(18.9,77.4,1.2); await settle();
  const missing=await snapshot();
  assert.ok(missing.imagery.failures>0);
  assert.equal(missing.imagery.untexturedBlocks,0);
  const count=missing.imagery.requests;
  await page.waitForTimeout(1000);
  assert.equal((await snapshot()).imagery.requests,count);
  await page.locator('canvas').first().screenshot({path:`${output}/outside-missing.png`});
  faultActive=false;
  await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.retryFailed());
  await settle();
  const recovered=await snapshot();
  assert.equal(recovered.centreImagery.sources.find(s=>s.id==='ctx-global').level,13);
  assert.deepEqual(recovered.attributes,missing.attributes);
  assert.deepEqual(recovered.cpuHit,missing.cpuHit);
  await page.locator('canvas').first().screenshot({path:`${output}/outside-recovered.png`});
  result.missingSource={expectedFaults,missing,recovered,noRetryStorm:true};
  result.motionTiming = {};
  for (const [name, lat, lon] of [['inside',18.4447,77.4508], ['outside',18.9,77.4]]) {
    await pose(lat,lon,1.2); await settle();
    result.motionTiming[name] = await timing(true);
  }
  assert.equal(errors.length,0,errors.join('\n'));
  await writeFile(`${output}/metrics.json`,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({ gpu: result.views.inside.fine.gpu, views: Object.fromEntries(Object.entries(result.views).map(([k,v])=>[k,{levels:v.fine.imagery.displayedLevels,bytes:v.fine.imagery.textureBytes,draws:v.fine.draws,p95Ms:v.fineTiming.p95Ms}])) },null,2));
} finally { await browser.close(); }
