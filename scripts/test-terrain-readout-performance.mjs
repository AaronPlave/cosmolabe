/** Controlled #374 main/head comparison. Run once against each checkout's
 * Vite URL; keep browser, viewport, scenes and sample count identical.
 * CHROME=/usr/bin/chromium node scripts/test-terrain-readout-performance.mjs URL OUTPUT */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.argv[2] ?? 'http://localhost:3000/';
const out = process.argv[3] ?? '/tmp/terrain-readout-performance';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME,
  args: ['--no-sandbox', ...(process.env.CL_GPU === 'hardware' ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: Number(process.env.CL_DPR ?? 1) });
const errors = [], results = [];
const browserVersion = browser.version();
const frames = Number(process.env.CL_FRAMES ?? 120), visual = process.env.CL_VISUAL === '1';
const cpuOnly = process.env.CL_CPU_ONLY === '1';
page.on('pageerror', e => { errors.push(e.message); console.error(e.stack); });
if (cpuOnly) await page.addInitScript(() => {
  // Explicit CPU isolation mode for hosts without a physical GPU. Keep scene
  // updates, draw submission, geometry, LOD, and annotation tests; omit GPU draws.
  for (const api of [WebGLRenderingContext, WebGL2RenderingContext]) for (const method of
    ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
    if (api.prototype[method]) api.prototype[method] = () => {};
  }
});
await page.addInitScript(() => { window.liveModule = path => import(performance.getEntriesByType('resource')
  .map(e => e.name).filter(url => new URL(url).pathname === path).at(-1) ?? path); });
try {
  await page.goto(base + '?catalog=test-catalogs/ingenuity-jezero', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.renderer?.placeNames?.index.places.length > 2000, {}, { timeout: 120000 });
  await page.evaluate(async () => {
    window.s = await window.liveModule('/src/lib/viewer-state.svelte.ts');
    window.p = await window.liveModule('/src/lib/places.ts');
    window.nv = await window.liveModule('/src/lib/navigation-view.svelte.ts');
    await window.renderer.waitForInitialAssets();
    window.cosmo.setPlaying(false);
    window.renderer.timeController.setTime(678747677.5888);
    window.renderer.renderFrame();
    if (window.s.getRenderer() !== window.renderer) throw new Error('Renderer singleton mismatch');
  });
  for (const scene of ['ingenuity', 'horizon', 'gale']) {
    await page.evaluate(async scene => {
      const r = window.renderer, V = r.camera.position.constructor;
      window.s.selectBody(null); window.cosmo.untrack();
      await new Promise(requestAnimationFrame);
      if (scene === 'ingenuity') {
        window.cosmo.track('Ingenuity');
        for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
        const body = r.getBodyMesh('Ingenuity'), mars = r.getBodyMesh('Mars');
        const radial = body.position.clone().sub(mars.position).normalize();
        r.cameraController.controls.enableDamping = false;
        r.cameraController.controls.target.copy(body.position);
        r.camera.position.copy(body.position).addScaledVector(radial, 3.5 * r.scaleFactor);
        r.camera.lookAt(body.position); r.camera.updateMatrixWorld(true);
      } else {
        const place = window.p.searchPlaces(scene === 'gale' ? 'Gale' : 'Sakarya Vallis')[0];
        if (!place) throw new Error('Missing scene place ' + scene);
        window.s.releaseSurfaceTarget(); window.p.selectPlace(null);
        const mars = r.getBodyMesh('Mars'), t = mars.terrainManager;
        const seed = r.placeNames.anchors.get(place.ref).offset.clone().normalize();
        const d = [seed.x, -seed.z, seed.y], outer = t.bodyRadiusKm + 50;
        const ray = { origin: { xKm: d[0]*outer, yKm: d[1]*outer, zKm: d[2]*outer },
          direction: d.map(x=>-x), nearKm: 0, farKm: 150 };
        await t.cube.surface.ensureRayCoverage(ray, { maxMeshErrorKm: 0 }, AbortSignal.timeout(30000));
        const hit = mars.intersectTerrainRay(ray, { maxMeshErrorKm: 0 });
        if (hit?.kind !== 'hit') throw new Error('No terrain for ' + scene);
        const target = new V(hit.position.xKm, hit.position.zKm, -hit.position.yKm).multiplyScalar(r.scaleFactor);
        const up = target.clone().normalize(), side = up.clone().cross(new V(0, 1, 0)).normalize();
        r.cameraController.controls.enableDamping = false;
        r.cameraController.jumpToSurface(mars, { target, position: target.clone().addScaledVector(up, 3.5*r.scaleFactor)
          .addScaledVector(side, (scene === 'gale' ? 10 : 50)*r.scaleFactor), up });
        r.camera.updateMatrixWorld(true);
      }
    }, scene);
    console.log('POSE', scene, await page.evaluate(() => ({ camera: window.renderer.camera.position.toArray(), terrain: window.renderer.getBodyMesh('Mars').terrainSurfaceStatus })));
    await page.waitForFunction(() => window.renderer.getBodyMesh('Mars').terrainRevision > 0
      && window.renderer.getBodyMesh('Mars').terrainManager.tiles.visibleTiles.size > 0, {}, { timeout: 120000 });
    let quiet = 0, previousCoverage = '';
    for (let i = 0; i < 300 && quiet < 20; i++) {
      const coverage = await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        const b = window.renderer.getBodyMesh('Mars'), t = b.terrainManager, n = t.metrics.network;
        return { key: [b.terrainRevision, t.tiles.visibleTiles.size].join(':'), quiet: n.queued + n.downloading + n.parsing === 0 };
      });
      quiet = coverage.quiet && coverage.key === previousCoverage ? quiet + 1 : 0;
      previousCoverage = coverage.key;
    }
    if (quiet < 20) throw new Error('Terrain did not settle for ' + scene);
    await page.waitForTimeout(1000);
    for (const panel of (visual ? [true] : [false, true])) for (const names of (visual ? [true] : [false, true])) {
      await page.evaluate(({ panel, names, scene }) => {
        window.s.selectBody(panel ? (scene === 'ingenuity' ? 'Ingenuity' : 'Mars') : null);
        window.renderer.placeNames.setBodyVisible('Mars', names);
      }, { panel, names, scene });
      await page.waitForTimeout(1200);
      if (names) await page.waitForFunction(() => window.renderer.placeNames.metrics.drawn > 0, {}, { timeout: 120000 });
      if (panel && scene === 'ingenuity') await page.waitForFunction(() => document.body.innerText.includes('Above Mars terrain'), {}, { timeout: 120000 });
      if (visual && names) {
        await page.evaluate(() => {
          window.checkPlaceAttachments = () => {
            const r = window.renderer, differences = [];
            let checked = 0;
            for (const { place } of r.placeNames.drawn) {
              const cached = r.placeNames.visibility.get(place.ref), body = r.getBodyMesh(place.layer.body);
              if (!cached || cached.anchor.source === 'source-height') continue;
              const local = cached.anchor.offsetKm.clone();
              const geo = body.terrainBodyFixedToGeodetic({ xKm: local.x, yKm: -local.z, zKm: local.y });
              const up = local.clone().normalize();
              if (geo) {
                const lat = geo.latDeg * Math.PI / 180, lon = geo.lonDeg * Math.PI / 180;
                up.set(Math.cos(lat)*Math.cos(lon), Math.sin(lat), -Math.cos(lat)*Math.sin(lon));
              }
              up.applyQuaternion(body.mesh.quaternion);
              const point = local.multiplyScalar(r.scaleFactor).applyQuaternion(body.mesh.quaternion).add(body.position);
              r._surfaceRaycaster.set(point.addScaledVector(up, .1*r.scaleFactor), up.negate());
              r._surfaceRaycaster.far = .2*r.scaleFactor;
              let hit;
              try { hit = r._castSurfaces(); } finally { r._surfaceRaycaster.far = Infinity; }
              const gapM = hit ? Math.abs(hit.distance/r.scaleFactor-.1)*1000 : null;
              checked++;
              if (gapM === null || gapM > 1) differences.push({ name: place.name, gapM });
            }
            return { checked, differences };
          };
        });
        await page.waitForFunction(() => { const result = window.checkPlaceAttachments(); return result.checked > 0 && result.differences.length === 0; }, {}, { timeout: 120000 });
      }
      console.log('CAPTURE', scene, panel, names);
      const session = await page.context().newCDPSession(page);
      await session.send('Profiler.enable');
      await session.send('Profiler.start');
      await session.send('Tracing.start', { categories: 'devtools.timeline,toplevel', transferMode: 'ReturnAsStream' });
      const row = await page.evaluate(async ({ panel, names, scene, frames }) => {
        const r = window.renderer, b = r.getBodyMesh('Mars'), t = b.terrainManager;
        const frameTimes = [], intervals = [], labels = [], longTasks = [];
        const counts = { analysis: 0, resident: 0, raycasts: 0, placeWork: 0, labelChunks: 0 };
        const restore = [];
        function wrap(object, key, kind) {
          if (!object?.[key]) return;
          const old = object[key]; object[key] = function (...args) { counts[kind]++; return old.apply(this, args); };
          restore.push(() => object[key] = old);
        }
        wrap(b, 'sampleTerrainBodyFixed', 'analysis'); wrap(b, 'sampleResidentTerrainSteps', 'resident');
        wrap(b, 'sampleResidentTerrain', 'resident');
        if (r._placeWork) {
          const work = r._placeWork;
          r._placeWork = function (...args) {
            counts.placeWork++;
            const iterator = work.apply(this, args), next = iterator.next.bind(iterator);
            iterator.next = (...a) => { counts.labelChunks++; return next(...a); };
            return iterator;
          };
          restore.push(() => r._placeWork = work);
        } wrap(r, '_castSurfaces', 'raycasts');
        const labelUpdate = r.placeNames.update;
        r.placeNames.update = function (...args) { const value = labelUpdate.apply(this, args); counts.raycasts += this.metrics.raycasts ?? 0; return value; };
        restore.push(() => r.placeNames.update = labelUpdate);
        const frameOwner = Object.getPrototypeOf(r);
        const old = frameOwner.renderFrame;
        frameOwner.renderFrame = function (...args) { const start = performance.now(); const value = old.apply(this, args); frameTimes.push(performance.now() - start); return value; };
        const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
        observer.observe({ type: 'longtask', buffered: false });
        let previous;
        try {
          for (let i = 0; i < frames; i++) {
            const now = await new Promise(requestAnimationFrame);
            if (previous !== undefined) intervals.push(now - previous); previous = now;
            labels.push(r.placeNames.metrics.cpuMs);
          }
        } finally { frameOwner.renderFrame = old; for (const fn of restore) fn(); observer.disconnect(); }
        const stats = values => { const a = [...values].sort((a,b) => a-b); return { count: a.length, p95: a[Math.floor(a.length*.95)] ?? null, max: a.at(-1) ?? null, over16_7: a.filter(x=>x>16.7).length, over50: a.filter(x=>x>50).length }; };
        const gl = r.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
        return { scene, panel, names, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          frame: stats(frameTimes), intervals: stats(intervals), labels: stats(labels), longTasks: stats(longTasks),
          counts, panelText: document.body.innerText.match(/Above Mars (?:terrain|ref)\n[^\n]+/)?.[0] ?? null,
          perFrame: Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,v/(frameTimes.length || frames)])),
          drawn: r.placeNames.metrics.drawn, visibleNames: [...document.querySelectorAll('.cl-place-name')].filter(e=>e.dataset.accepted==='true').map(e=>e.textContent),
          anchors: [...r.placeNames.visibility].filter(([id])=>r.placeNames.drawn.some(d=>d.place.ref===id)).map(([id,v])=>({id,offset:v.anchor.offsetKm.toArray(),source:v.anchor.source,hidden:v.hidden})),
          deferred: r.placeNames.metrics.losDeferred, terrainRevision: b.terrainRevision,
          camera: r.camera.position.toArray(), target: r.cameraController.controls.target.toArray(), et: window.s.vs.et,
          visibleTiles: t.tiles.visibleTiles.size };
      }, { panel, names, scene, frames });
      const { profile } = await session.send('Profiler.stop');
      await writeFile(out + '/' + scene + '-' + panel + '-' + names + '.cpuprofile', JSON.stringify(profile));
      const done = new Promise(resolve => session.once('Tracing.tracingComplete', resolve));
      await session.send('Tracing.end');
      const { stream } = await done;
      let traceText = '';
      while (true) { const chunk = await session.send('IO.read', { handle: stream }); traceText += chunk.data; if (chunk.eof) break; }
      await session.send('IO.close', { handle: stream });
      const trace = JSON.parse(traceText).traceEvents;
      const main = trace.find(e => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
      const tasks = trace.filter(e => e.ph === 'X' && e.tid === main?.tid && /RunTask/.test(e.name)).map(e => e.dur / 1000).sort((a,b)=>a-b);
      row.mainTasks = { count: tasks.length, p95: tasks[Math.floor(tasks.length*.95)] ?? null, max: tasks.at(-1) ?? null,
        over16_7: tasks.filter(x=>x>16.7).length, over50: tasks.filter(x=>x>50).length };
      await session.detach();
      if (visual && names) row.losParity = await page.evaluate(() => {
        const r = window.renderer, differences = [];
        let checked = 0;
        for (const { place } of r.placeNames.drawn) {
          const cached = r.placeNames.visibility.get(place.ref), body = r.getBodyMesh(place.layer.body);
          if (!cached) continue;
          const point = cached.anchor.offsetKm.clone().multiplyScalar(r.scaleFactor).applyQuaternion(body.mesh.quaternion).add(body.position);
          const direction = point.clone().sub(r.camera.position), distance = direction.length();
          r._surfaceRaycaster.set(r.camera.position, direction.divideScalar(distance)); r._surfaceRaycaster.far = distance;
          let hit;
          try { hit = r._castSurfaces(); } finally { r._surfaceRaycaster.far = Infinity; }
          const hidden = !!hit && hit.distance < distance - .01*r.scaleFactor;
          checked++;
          if (hidden !== cached.hidden) differences.push({ name: place.name, cached: cached.hidden, synchronous: hidden, gapKm: hit ? (distance-hit.distance)/r.scaleFactor : null });
        }
        return { checked, differences };
      });
      if (visual && names) row.attachmentParity = await page.evaluate(() => window.checkPlaceAttachments());
      results.push(row); console.log(JSON.stringify(row));
      await page.screenshot({ path: out + '/' + scene + '-' + panel + '-' + names + '.png' });
      await writeFile(out + '/metrics.json', JSON.stringify({ base, browserVersion, nodeVersion: process.version, cpuOnly, frames, dpr: Number(process.env.CL_DPR ?? 1), errors, results }, null, 2));
    }
  }
} finally { await writeFile(out + '/metrics.json', JSON.stringify({ base, browserVersion, nodeVersion: process.version, cpuOnly, frames, dpr: Number(process.env.CL_DPR ?? 1), errors, results }, null, 2)); await browser.close(); }
if (errors.length) throw new Error(errors.join('\n'));
if (results.some(r=>r.losParity?.differences.length || r.attachmentParity?.differences.length)) throw new Error('Rendered LOS parity failed; see metrics.json');
