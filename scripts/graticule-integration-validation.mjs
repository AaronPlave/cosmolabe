/** Real catalogs, current renderer and hardware/software GPU identity.
 * GRID_VIEWER_URL=http://127.0.0.1:5188 GRID_OUTPUT=/tmp/grid-integration node scripts/graticule-integration-validation.mjs
 * Uses shipped data paths unchanged. Missing data remains missing acceptance.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const base = process.env.GRID_VIEWER_URL ?? 'http://127.0.0.1:5188';
const out = resolve(process.env.GRID_OUTPUT ?? '/tmp/grid-integration');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: process.platform === 'darwin' ? 'chrome' : undefined, headless: true,
  args: process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const report = { passed: false, views: [], errors: [], missing: [], gpu: null };
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript(() => {
  window.gridImport = path => import(performance.getEntriesByType('resource').map(e => e.name)
    .filter(url => new URL(url).pathname === path).at(-1) ?? path);
});
page.on('pageerror', e => report.errors.push(e.message));
page.on('console', m => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(m.text())) report.errors.push(m.text()); });
try {
  for (const [catalog, body, lat, lon, altitude] of [
    ['earth-moon', 'Earth', 17, 5, 1000],
    ['moonfall-shackleton', 'Moon', -89.67, 129.78, 25],
    ['ingenuity-jezero', 'Mars', 18.444, 77.45, 5],
    ['msl-dingo-gap', 'Mars', -4.63, 137.4, 5],
  ]) {
    if (process.env.GRID_CATALOGS && !process.env.GRID_CATALOGS.split(',').includes(catalog)) continue;
    console.log('Loading', catalog);
    await page.goto(`${base}/?catalog=test-catalogs/${catalog}&test=1`, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForFunction(body => window.renderer?.getBodyMesh(body) && window.__cosmolabe?.assetsReady, body, { timeout: 60000 });
    } catch {
      report.missing.push({ catalog, reason: 'Initial assets did not become ready within 60 seconds' });
      console.log('Unavailable initial assets', catalog); continue;
    }
    if (process.env.GRID_NAMED_VIEWS === '1' && catalog === 'msl-dingo-gap') {
      for (const name of ['Dingo Gap Approach', 'Curiosity Surface', 'Curiosity Close-up']) {
        await page.evaluate(async name => {
          const state = await window.gridImport('/src/lib/viewer-state.svelte.ts');
          window.cosmo.setPlaying(false); state.setLighting('flood');
          if (state.getRenderer() !== window.renderer) throw new Error('Harness imported a different viewer session');
          if (!state.applyViewpoint(name, { animate: false })) throw new Error(`Unavailable catalog viewpoint: ${name}`);
          window.cosmo.setLayer('grid', true); window.cosmo.setGridScope('bodies', 'Mars'); window.cosmo.setGridDensity('auto');
        }, name);
        await page.waitForTimeout(3000);
        for (const coordinateFrame of [false, true]) {
          await page.evaluate(value => window.cosmo.setGridCoordinateFrame(value), coordinateFrame);
          await page.waitForTimeout(1500);
          const sample = await page.evaluate(() => {
            const r = window.renderer, bm = r.getBodyMesh('Mars'), m = bm.gridMetrics;
            return { frame: bm.bodyFixedFrame, available: bm.attitudeAvailable, camera: r.camera.position.toArray(),
              roverDistanceKm: r.camera.position.distanceTo(r.getBodyMesh('Curiosity').position) / r.scaleFactor,
              labels: m.labels, divisions: m.frameTicks.length, alignmentPx: Math.max(0, ...m.frameTicks.map(t => t.alignmentPx ?? 0)),
              local: bm.getSurfaceOverlays().map(o => ({ visible: o.group.visible, tiles: o.tiles.visibleTiles.size })),
              visibleTerrain: bm.terrainManager.tiles.visibleTiles.size, physicalRevision: bm.terrainRevision,
              places: r.placeNames.getScreenRects().length };
          });
          report.views.push({ catalog, namedView: name, coordinateFrame, ...sample });
          console.log(name, coordinateFrame, JSON.stringify(sample));
          await page.screenshot({ path: `${out}/${name.toLowerCase().replaceAll(' ', '-')}-${coordinateFrame ? 'frame' : 'surface'}.png` });
        }
      }
      continue;
    }
    await page.evaluate(async ({ body, lat, lon, altitude, coreUrl }) => {
      const r = window.renderer, bm = r.getBodyMesh(body), c = window.cosmo;
      c.setPlaying(false); c.untrack(); c.select(null); c.setLayer('grid', true); c.setGridScope('bodies', body);
      c.setGridDensity('auto'); c.setGridLabels(true);
      c.setGridCoordinateFrame(false);
      r.placeNames.setBodyVisible(body, true);
      if (body === 'Earth' || body === 'Mars') { const state = await window.gridImport('/src/lib/viewer-state.svelte.ts'); state.setLighting('flood'); }
      const core = await import(coreUrl), V = r.camera.position.constructor;
      const coord = bm.surfaceCoordinates;
      const toWorld = (latDeg, lonDeg, heightKm) => {
        const p = core.surfacePositionToBodyFixed({ latDeg, lonDeg, heightKm }, coord);
        return new V(p.xKm, p.yKm, p.zKm).applyQuaternion(bm.bodyToWorldQuaternion(r.camera.quaternion.clone()))
          .multiplyScalar(r.scaleFactor).add(bm.position);
      };
      const h = bm.sampleResidentTerrain(lat, lon)?.elevationKm ?? 0;
      const eye = toWorld(lat, lon, h + altitude), target = toWorld(lat, lon, h);
      r.cameraController.controls.enableDamping = false;
      r.camera.position.copy(eye); r.camera.up.copy(toWorld(Math.min(89.99, lat + 0.01), lon, h).sub(target).normalize());
      r.cameraController.controls.target.copy(target); r.camera.lookAt(target); r.camera.updateMatrixWorld(true);
      if (bm.surfaceAppearance) bm.setSurfaceAppearance({ ...bm.surfaceAppearance, contours: true, contourLabels: true, hillshade: true });
      window.gridValidationPose = { eye: eye.toArray(), target: target.toArray(), up: r.camera.up.toArray() };
    }, { body, lat, lon, altitude, coreUrl: `/@fs/${process.cwd()}/packages/core/dist/index.js` });
    if (catalog !== 'earth-moon') {
      try { await page.waitForFunction(body => (() => { const t = window.renderer.getBodyMesh(body).terrainManager; const n = t?.metrics.network; return t?.tiles.visibleTiles.size > 0 && n.queued + n.downloading + n.parsing === 0 && (!t.cubeImageryStats || t.cubeImageryStats.inFlight === 0); })(), body, { timeout: 60000 }); }
      catch { report.missing.push({ catalog, reason: 'No streamed terrain became visible within 60 seconds' }); }
    }
    const context = await page.evaluate(async () => {
      const r = window.renderer, c = window.cosmo;
      const a = r.pickScene(250, 280, 'probe'), b = r.pickScene(420, 360, 'probe');
      if (a?.kind === 'surface') r.setProbePin(a.point);
      if (a?.kind === 'surface' && b?.kind === 'surface') {
        const core = await import(`/@fs//Users/aplave/code/cosmolabe-dupe-1/packages/core/dist/index.js`);
        const measures = await window.gridImport('/src/lib/spatial-measurements.svelte.ts');
        measures.addMeasurement({ id: 'grid-validation-distance', kind: 'distance',
          source: core.surfacePointEndpoint(a.point, 'A'), target: core.surfacePointEndpoint(b.point, 'B') });
      }
      const activities = c.listActivities();
      const time = c.getTime();
      const activity = activities.reduce((best, item) => !best || Math.abs(item.start - time) < Math.abs(best.start - time) ? item : best, null);
      if (activity) {
        c.selectActivity(activity.id); c.showTrajectory(activity.vehicle, true);
        await new Promise(requestAnimationFrame);
        const module = await window.gridImport('/src/lib/mission-activities.ts');
        const event = module.activityEvent(activity);
        // Use the actual activity record through the host renderer's event API.
        r.setEventResults([event], event, `${event.label}\nCatalog activity`);
      }
      return { probe: a?.kind === 'surface', measurement: a?.kind === 'surface' && b?.kind === 'surface', activity: activity?.id ?? null };
    });
    for (const coordinateFrame of [false, true]) {
      await page.evaluate(coordinateFrame => window.cosmo.setGridCoordinateFrame(coordinateFrame), coordinateFrame);
      await page.waitForTimeout(1500);
      const result = await page.evaluate(async ({ body, coordinateFrame }) => {
        const r = window.renderer, bm = r.getBodyMesh(body), tm = bm.terrainManager;
        const gl = r.renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
        const frames = [], costs = [], update = bm.updateGrid;
        const uploadsBefore = bm.gridMetrics.frameTextureUploads;
        bm.updateGrid = function(...args) { const start = performance.now(); const value = update.apply(this, args); costs.push(performance.now() - start); return value; };
        try {
          for (let i = 0; i < 90; i++) {
            // Slow roll, optical zoom and nearly stationary motion use the real frame loop.
            if (i === 20) { r.camera.fov *= 0.9; r.camera.updateProjectionMatrix(); }
            if (i > 30 && i < 50) r.camera.up.applyAxisAngle(r.camera.getWorldDirection(r.camera.position.clone()), 0.0005);
            await new Promise(requestAnimationFrame);
            const m = bm.gridMetrics;
            frames.push({ count: coordinateFrame ? m.frameTicks.length : m.labels,
              axes: [...new Set(coordinateFrame ? m.frameTicks.map(t => t.axis) : m.annotations.map(a => a.axis))],
              error: Math.max(0, ...m.frameTicks.map(t => t.alignmentPx ?? 0)) });
          }
        } finally { bm.updateGrid = update; }
        costs.sort((a,b) => a-b);
        const m = bm.gridMetrics, images = tm?.cubeImageryStats;
        return { coordinateFrame, density: r.gridSettings.density, frame: bm.bodyFixedFrame, available: bm.attitudeAvailable,
          gpu: gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
          pose: window.gridValidationPose, minDivisions: Math.min(...frames.map(f => f.count)), maxDivisions: Math.max(...frames.map(f => f.count)),
          bothAxesFrames: frames.filter(f => f.axes.length === 2).length, maxAlignmentPx: Math.max(...frames.map(f => f.error)),
          updateMedianMs: costs[Math.floor(costs.length / 2)], updateP95Ms: costs[Math.floor(costs.length * 0.95)],
          frameTextureBytes: m.frameTextureBytes, frameTextureUploads: m.frameTextureUploads, uploadsDuringMotion: m.frameTextureUploads - uploadsBefore,
          visibleTerrain: tm?.tiles.visibleTiles.size ?? 0, cpuRevision: bm.terrainRevision,
          imagery: images ? { ready: images.ready, requests: images.requests, failures: images.failedRequests, queued: images.queued, inFlight: images.inFlight, bytes: images.bytes } : null,
          obstacles: { measurements: r.spatialCalloutRects.length, probe: r.probeCalloutRects.length, event: !!r.eventCalloutRect, placeCandidates: r.placeNames.metrics.candidates, placeBodies: [...r.placeNames.bodies], indexedPlaces: r.placeNames.index.places.length, places: r.placeNames.getScreenRects().length, contours: tm?.contourLabels?.group.children.filter(s => s.visible).length ?? 0 },
          siteMeshes: bm.getSurfaceOverlays().map(o => ({ visible: o.group.visible, tiles: o.tiles.visibleTiles.size })),
          sceneCounts: { ...r.renderer.info.render }, initialAssets: r.initialAssetsSummary };
      }, { body, coordinateFrame });
      report.gpu = result.gpu;
      report.views.push({ catalog, context, ...result });
      console.log(catalog, coordinateFrame ? 'frame' : 'surface', JSON.stringify(result));
      await page.screenshot({ path: `${out}/${catalog}-${coordinateFrame ? 'frame' : 'surface'}.png` });
    }
    const lifecycle = await page.evaluate(async body => {
      const r = window.renderer, bm = r.getBodyMesh(body), c = window.cosmo;
      const wait = async n => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); };
      const before = { eye: r.camera.position.clone(), target: r.cameraController.controls.target.clone(), up: r.camera.up.clone(), fov: r.camera.fov };
      c.setLayer('grid', false); await wait(2);
      const disabled = { labels: bm.gridMetrics.labels, frameElements: bm.gridMetrics.frameElements };
      c.setLayer('grid', true); c.setGridCoordinateFrame(false);
      const radial = r.camera.position.clone().sub(bm.position).normalize();
      r.camera.position.copy(bm.position).addScaledVector(radial, bm.displayRadius * 4 * r.scaleFactor);
      r.cameraController.controls.target.copy(bm.position); r.camera.lookAt(bm.position); r.camera.updateMatrixWorld(true);
      await wait(60);
      const globe = { labels: bm.gridMetrics.labels, step: [bm.gridMetrics.latitudeStep, bm.gridMetrics.longitudeStep] };
      r.camera.position.copy(before.eye); r.camera.up.copy(before.up); r.camera.fov = before.fov; r.camera.updateProjectionMatrix();
      r.cameraController.controls.target.copy(before.target); r.camera.lookAt(before.target); r.camera.updateMatrixWorld(true);
      c.setGridCoordinateFrame(true); await wait(60);
      const uploads = bm.gridMetrics.frameTextureUploads; await wait(30);
      const restored = { divisions: bm.gridMetrics.frameTicks.length, stationaryUploads: bm.gridMetrics.frameTextureUploads - uploads, visibleTerrain: bm.terrainManager?.tiles.visibleTiles.size ?? 0 };
      c.setTimeRate(10); c.setPlaying(true); await wait(45); c.setPlaying(false);
      return { disabled, globe, restored, playback: { frame: bm.bodyFixedFrame, available: bm.attitudeAvailable, divisions: bm.gridMetrics.frameTicks.length } };
    }, body);
    report.views.push({ catalog, lifecycle });
    console.log(catalog, 'lifecycle', JSON.stringify(lifecycle));
    if (catalog === 'earth-moon') {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(async () => { const shell = await window.gridImport('/src/lib/shell.svelte.ts'); shell.openTool('display'); });
      await page.waitForTimeout(500);
      const frameToggle = page.getByRole('checkbox', { name: 'Labels at viewport border', exact: true });
      await frameToggle.uncheck(); await frameToggle.check();
      await page.getByRole('combobox', { name: 'Grid density', exact: true }).selectOption('manual');
      await page.getByLabel('Grid angular spacing', { exact: true }).selectOption('5');
      const compact = await page.evaluate(async () => {
        const state = await window.gridImport('/src/lib/viewer-state.svelte.ts');
        const bodies = [...document.querySelectorAll('.instrument-body')].filter(e => e.clientHeight > 0);
        return { grid: window.renderer.gridSettings, sameRenderer: state.getRenderer() === window.renderer,
          scroll: bodies.map(e => ({ scrollTop: e.scrollTop, clientHeight: e.clientHeight, scrollHeight: e.scrollHeight,
            parentScrollTop: e.closest('.instrument')?.parentElement?.scrollTop ?? 0 })) };
      });
      report.views.push({ catalog, compact });
      if (!compact.sameRenderer || compact.grid.spacingDeg !== 5 || !compact.grid.coordinateFrame) throw new Error('Compact grid controls did not reach the loaded renderer');
      await page.screenshot({ path: `${out}/compact-grid-controls.png` });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  }
  report.passed = report.errors.length === 0 && report.missing.length === 0;
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
if (report.errors.length) throw new Error(`${report.errors.length} browser/shader errors; see ${out}/report.json`);
