/** Physical-GPU profiling of the reusable near-surface camera path (#246).
 * node scripts/test-near-surface-performance.mjs [VIEWER_URL] [OUTPUT_DIR]
 * Reports real frame/navigation CPU timings; thresholds bound navigation work,
 * rather than asserting a hardware-independent total frame rate.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'work/ingenuity-246/navigation-performance';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  args: [process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const result = { version: 1, scenarios: [], errors: [], passed: false };
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', e => result.errors.push(e.message));
async function pose(body, lat, lon, altitudeKm) {
  await page.evaluate(async ({ body, lat, lon, altitudeKm }) => {
    const r = window.renderer, b = r.getBodyMesh(body), t = b.terrainManager, V = r.camera.position.constructor;
    window.cosmo.setPlaying(false); window.cosmo.untrack();
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    const d = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const outer = t.bodyRadiusKm + 50;
    const ray = { origin: { xKm: d[0] * outer, yKm: d[1] * outer, zKm: d[2] * outer }, direction: d.map(x => -x), nearKm: 0, farKm: 150 };
    await t.cube.surface.ensureRayCoverage(ray, { maxMeshErrorKm: 0 }, AbortSignal.timeout(30000));
    const hit = b.intersectTerrainRay(ray, { maxMeshErrorKm: 0 });
    if (hit?.kind !== 'hit') throw new Error('No physical surface for ' + body);
    const centre = new V(); b.getWorldPosition(centre);
    const toWorld = ([x, y, z]) => new V(x, z, -y).applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
    const p = [hit.position.xKm, hit.position.yKm, hit.position.zKm];
    const c = r.camera, controls = r.cameraController.controls;
    controls.enableDamping = false; controls.target.copy(toWorld(p));
    c.position.copy(toWorld(p.map((x, i) => x + d[i] * altitudeKm)));
    c.up.copy(toWorld([-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)]).sub(centre).normalize());
    c.fov = 45; c.updateProjectionMatrix(); c.lookAt(controls.target); c.updateMatrixWorld(true);
    window.performancePose = { body, direction: d, point: p, altitudeKm };
  }, { body, lat, lon, altitudeKm });
}
try {
  for (const [catalog, body, lat, lon] of [
    ['ingenuity-jezero', 'Mars', 18.44486301, 77.45101915],
    ['moonfall-shackleton', 'Moon', -89.67, 129.78],
  ]) {
    await page.goto(`${base}?catalog=test-catalogs/${catalog}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(body => window.renderer?.getBodyMesh(body)?.terrainManager?.cubeStats?.version, body);
    await page.evaluate(async body => { const t = window.renderer.getBodyMesh(body).terrainManager; await t.cube.source.ready; await t.cubeImageryLayer.ready; }, body);
    await pose(body, lat, lon, .05);
    await page.waitForFunction(body => { const t = window.renderer.getBodyMesh(body).terrainManager, n = t.metrics.network; return t.tiles.visibleTiles.size > 0 && n.queued + n.downloading + n.parsing === 0; }, body, { timeout: 120000 });
    for (const scenario of ['stationary-ground', 'moving-ground', 'flight-follow', 'orbit-to-surface']) {
      await pose(body, lat, lon, .05);
      if (scenario === 'flight-follow') await page.evaluate(body => { window.cosmo.track(body === 'Mars' ? 'Ingenuity' : 'Polaris-A'); window.cosmo.setPlaying(true); }, body);
      const row = await page.evaluate(async ({ body, scenario }) => {
        const r = window.renderer, b = r.getBodyMesh(body), t = b.terrainManager;
        const gl = r.getContext().webglRenderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
        const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        const nav = t.navigationSurface, intersect = t.intersectSurfaceRay, ensure = t.cube.surface.ensureRayCoverage, requestCoordinate = t.cube.source.requestCoordinate, physicalRay = t.cube.surface.intersectRay, frame = r.renderFrame;
        const navigationMs = [], physicalRayMs = [], coordinateMs = [], frameMs = [], frameIntervalsMs = [], discrepanciesM = [], clearancesM = [];
        let rayCalls = 0, coverageCalls = 0, coordinateCalls = 0, callsThisFrame = 0, maxCallsPerFrame = 0, previous;
        const networkBefore = { ...t.cubeStats }, frames = 360;
        t.intersectSurfaceRay = function(...args) { rayCalls++; return intersect.apply(this, args); };
        t.cube.surface.ensureRayCoverage = function(...args) { coverageCalls++; return ensure.apply(this, args); };
        t.cube.surface.intersectRay = function(...args) { const start=performance.now();const value=physicalRay.apply(this,args);physicalRayMs.push(performance.now()-start);return value; };
        t.cube.source.requestCoordinate = function(...args) { const start=performance.now();coordinateCalls++; const value=requestCoordinate.apply(this, args);coordinateMs.push(performance.now()-start);return value; };
        t.navigationSurface = function(...args) {
          const start = performance.now(); const value = nav.apply(this, args); navigationMs.push(performance.now() - start); callsThisFrame++;
          if (value?.discrepancyM != null) discrepanciesM.push(Math.abs(value.discrepancyM));
          if (value?.radiusKm != null) { const p = args[0]; clearancesM.push((Math.hypot(p.xKm,p.yKm,p.zKm)-value.radiusKm)*1000); }
          return value;
        };
        r.renderFrame = function(...args) { const start = performance.now(); const value = frame.apply(this, args); frameMs.push(performance.now()-start); maxCallsPerFrame = Math.max(maxCallsPerFrame,callsThisFrame); callsThisFrame=0;return value; };
        const camera = r.camera, target = r.cameraController.controls.target.clone(), offset = camera.position.clone().sub(target), side = camera.up.clone();
        try {
          for(let i=0;i<frames;i++) {
            await new Promise(resolve => requestAnimationFrame(time => { if(previous!=null)frameIntervalsMs.push(time-previous);previous=time;resolve(); }));
            if(scenario==='moving-ground') { const shift=side.clone().multiplyScalar(.04*r.scaleFactor*Math.sin(i/40));r.cameraController.controls.target.copy(target).add(shift);camera.position.copy(target).add(offset).add(shift);camera.lookAt(r.cameraController.controls.target);camera.updateMatrixWorld(true); }
            if(scenario==='orbit-to-surface') { const heightKm=.05+50*(1-i/(frames-1))**3;camera.position.copy(target).addScaledVector(offset,heightKm/.05);camera.lookAt(target);camera.updateMatrixWorld(true); }
          }
        } finally { t.navigationSurface=nav;t.intersectSurfaceRay=intersect;t.cube.surface.ensureRayCoverage=ensure;t.cube.source.requestCoordinate=requestCoordinate;t.cube.surface.intersectRay=physicalRay;r.renderFrame=frame;window.cosmo.setPlaying(false); }
        const stats = values => { const a=[...values].sort((a,b)=>a-b);const at=q=>a[Math.min(a.length-1,Math.floor(q*a.length))]??null;return {count:a.length,p50:at(.5),p95:at(.95),p99:at(.99),max:a.at(-1)??null}; };
        return { body,scenario,gpu,frames,visibleTiles:t.tiles.visibleTiles.size,navigationMs:stats(navigationMs),physicalRayMs:stats(physicalRayMs),coordinateMs:stats(coordinateMs),frameMs:stats(frameMs),frameIntervalsMs:stats(frameIntervalsMs),rayCalls,coverageCalls,coordinateCalls,maxCallsPerFrame,discrepanciesM:stats(discrepanciesM),minimumQueriedClearanceM:clearancesM.length?Math.min(...clearancesM):null,networkBefore,networkAfter:t.cubeStats };
      }, { body, scenario });
      assert.doesNotMatch(row.gpu,/swiftshader|llvmpipe|software/i);
      assert.ok(row.navigationMs.count>0, `${body}/${scenario} did not exercise navigation`);

      result.scenarios.push(row);await writeFile(`${out}/metrics.json`,JSON.stringify(result,null,2)+'\n');
      console.log(body, scenario, JSON.stringify({nav:row.navigationMs,frame:row.frameMs,rayCalls:row.rayCalls,coverageCalls:row.coverageCalls,maxCallsPerFrame:row.maxCallsPerFrame}));
    }
  }
  assert.equal(result.errors.length,0,result.errors.join('\n'));
  for(const row of result.scenarios)assert.ok(row.navigationMs.p99 < 4, `${row.body}/${row.scenario}: navigation p99 ${row.navigationMs.p99} ms`);
  result.passed=true;
} catch(e) {result.failure=String(e.stack??e);throw e;}
finally {await writeFile(`${out}/metrics.json`,JSON.stringify(result,null,2)+'\n');await browser.close();}
