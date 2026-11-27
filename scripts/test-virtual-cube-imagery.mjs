/** Browser acceptance for virtual cube imagery (#136) over coarse cube terrain.
 *
 * Build the local fixtures first (gitignored):
 *   /usr/bin/python3.12 scripts/terrain/coarse_cube_fixture.py mars  --source <mola dir> --work <dir>
 *   /usr/bin/python3.12 scripts/terrain/coarse_cube_fixture.py earth --source <etopo dir> --work <dir>
 *   /usr/bin/python3.12 scripts/terrain/cube_imagery.py xyz --source <bluemarble-3857.json> \
 *     --out apps/viewer/test-catalogs/data/earth-bluemarble-cube --body Earth --frame IAU_EARTH --radius-km 6378.137 --global-level 3
 * Serve:  DEV_DATA_MODE=local npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5196
 * Run:    node scripts/test-virtual-cube-imagery.mjs [mars|earth|all] [outDir]
 *
 * Mars uses the live upstream XYZ services (Trek Viking/HiRISE, Esri CTX); Earth uses
 * live NASA GIBS for two real days and a deterministic mock (one colour per UTC day,
 * delayed responses) for gaps, failures, cancellation and race conditions.
 * GPU: software GL by default (frame times are then SwiftShader, not GPU timings).
 * VIRTUAL_IMAGERY_GPU=metal|hardware launches with a real GPU for Metal/desktop numbers.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const [which = 'all', output = 'work/virtual-cube-imagery'] = process.argv.slice(2);
const base = process.env.VIRTUAL_IMAGERY_URL ?? 'http://127.0.0.1:5196';
const gpu = process.env.VIRTUAL_IMAGERY_GPU ?? 'software';
await mkdir(output, { recursive: true });
const args = gpu === 'metal' ? ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu']
  : gpu === 'hardware' ? ['--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ headless: true, args, executablePath: process.env.CL_CHROMIUM ?? (gpu === 'software' ? '/opt/pw-browsers/chromium' : undefined) });
const result = { gpu, base, startedAt: new Date().toISOString(), mars: null, earth: null, errors: [], environmentErrors: [] };
const only = process.env.VIRTUAL_IMAGERY_SITES?.split(',') ?? null;
// SwiftShader has no S3TC: a compressed DDS static base map has no decodable image there. Not imagery-path errors.
const environmental = (e) => gpu === 'software' && /reading 'width'/.test(e.message) && /uploadTexture/.test(e.stack ?? '');
const round = (v, d = 3) => (typeof v === 'number' ? Number(v.toFixed(d)) : v);

async function open(catalog, bodyName) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(180_000);
  const requests = [], requestTimes = [];
  page.on('pageerror', e => {
    if (environmental(e)) { if (!result.environmentErrors.includes(e.message)) result.environmentErrors.push(e.message); return; }
    result.errors.push(`${bodyName}: ${e.message}`); console.error(e.message);
  });
  page.on('console', m => { if (/GL_INVALID|INVALID_OPERATION|Shader Error/.test(m.text())) result.errors.push(`${bodyName}: ${m.text()}`); });
  // Request start on the browser's clock: Playwright may receive events seconds late under load.
  const upstream = /astro\.arcgis|trek\.nasa|gibs\.earthdata/;
  const indexOf = new Map();
  page.on('request', r => { if (upstream.test(r.url())) { indexOf.set(r, requests.length); requests.push(r.url()); requestTimes.push(Date.now()); } });
  const started = r => { const i = indexOf.get(r), t = r.timing().startTime; if (i !== undefined && t > 0) requestTimes[i] = t; };
  page.on('requestfinished', started); page.on('requestfailed', started);
  await page.goto(`${base}/?catalog=test-catalogs/experiments/${catalog}`, { timeout: 180_000 });
  await page.waitForFunction(b => window.renderer?.getBodyMesh(b)?.terrainManager?.cubeImageryStats?.ready, bodyName, { timeout: 180_000 });
  // Flood lighting: imagery visible wherever the camera is, independent of the Sun (evidence captures, not a lighting claim).
  await page.evaluate(async b => { await window.renderer.getBodyMesh(b).terrainManager.cubeImageryLayer.ready; window.cosmo.setPlaying(false); window.cosmo.select(b); window.renderer.setLightingMode('flood'); }, bodyName);
  const api = {
    page, requests, requestTimes,
    /** Requests (from index `from`) that the browser started at least `graceMs` after `since` (browser clock). */
    requestsAfter(from, since, graceMs = 3000) { return requests.slice(from).filter((_, i) => requestTimes[from + i] >= since + graceMs); },
    /** Latest start (ms after `since`) of a request matching `predicate`, from index `from`. */
    latestStart(from, since, predicate) { let worst = null; requests.slice(from).forEach((u, i) => { if (predicate(u)) worst = Math.max(worst ?? -Infinity, requestTimes[from + i] - since); }); return worst; },
    browserNow: () => page.evaluate(() => Date.now()),
    /** Idle and unchanged (requests, produced tiles, displayed cover) for 3 consecutive 600 ms polls. */
    async settle(allowBudget = true, timeout = 600_000) {
      await page.evaluate(() => { window.__settle = { key: '', stable: 0 }; });
      await page.waitForFunction(({ b, allowBudget }) => {
        const t = window.renderer.getBodyMesh(b).terrainManager, n = t.metrics.network, i = t.cubeImageryStats;
        const idle = t.tiles.visibleTiles.size > 0 && n.queued + n.downloading + n.parsing === 0 && i && i.inFlight === 0 &&
          (i.queued === 0 || (allowBudget && i.budgetLimited)) && (!i.sourceCache || (i.sourceCache.inFlight === 0 && i.sourceCache.queued === 0));
        const key = idle ? JSON.stringify([i.requests, i.virtualTiles?.produced, i.displayedLevels, i.sourceCache?.requests]) : '';
        const s = window.__settle;
        s.stable = idle && key === s.key ? s.stable + 1 : 0; s.key = key;
        return s.stable >= 3;
      }, { b: bodyName, allowBudget }, { timeout, polling: 600 }).catch(async error => {
        const state = await page.evaluate(b => { const t = window.renderer.getBodyMesh(b).terrainManager, i = t.cubeImageryStats;
          return { network: t.metrics.network, inFlight: i.inFlight, queued: i.queued, budgetLimited: i.budgetLimited, failures: i.failures, sourceCache: i.sourceCache, layers: t.imageryLayers.map(l => [l.id, l.status, l.requests, l.failedTiles]) }; }, bodyName);
        throw new Error(`settle timed out: ${JSON.stringify(state)}`, { cause: error });
      });
    },
    /** Camera `altitudeKm` above the physical surface hit along the local vertical, looking down, north up. */
    pose: (lat, lon, altitudeKm, fov = 40) => page.evaluate(async ({ b, lat, lon, altitudeKm, fov }) => {
      const r = window.renderer, body = r.getBodyMesh(b), t = body.terrainManager, V = r.camera.position.constructor;
      window.cosmo.setPlaying(false); window.cosmo.untrack();
      const rad = Math.PI / 180, d = [Math.cos(lat * rad) * Math.cos(lon * rad), Math.cos(lat * rad) * Math.sin(lon * rad), Math.sin(lat * rad)];
      const R = t.bodyRadiusKm + 30;
      const ray = { origin: { xKm: d[0] * R, yKm: d[1] * R, zKm: d[2] * R }, direction: d.map(x => -x), nearKm: 0, farKm: 120 };
      await t.cube.surface.ensureRayCoverage(ray, { maxMeshErrorKm: 0 }, new AbortController().signal);
      const hit = body.intersectTerrainRay(ray, { maxMeshErrorKm: 0 });
      if (hit?.kind !== 'hit') throw new Error('No physical surface for pose: ' + JSON.stringify(hit));
      window.virtualImageryRay = ray;
      const target = [hit.position.xKm, hit.position.yKm, hit.position.zKm];
      const centre = new V(); body.getWorldPosition(centre);
      const toWorld = ([x, y, z]) => new V(x, z, -y).applyQuaternion(body.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
      const eye = toWorld(target.map((x, i) => x + d[i] * altitudeKm)), aim = toWorld(target), c = r.camera, controls = r.cameraController.controls;
      controls.enableDamping = false; controls.target.copy(aim); c.fov = fov; c.updateProjectionMatrix(); c.position.copy(eye);
      const north = [-Math.sin(lat * rad) * Math.cos(lon * rad), -Math.sin(lat * rad) * Math.sin(lon * rad), Math.cos(lat * rad)];
      c.up.copy(toWorld(north).sub(centre).normalize()); c.lookAt(aim); c.updateMatrixWorld(true);
      return hit;
    }, { b: bodyName, lat, lon, altitudeKm, fov }),
    snapshot: () => page.evaluate(async ({ b, root }) => {
      const { directionToCubeFace } = await import(root + '/packages/three/src/surface/CubeSphere.ts');
      const { texelGroundSizeKm } = await import(root + '/packages/three/src/surface/CubeImagery.ts');
      const r = window.renderer, body = r.getBodyMesh(b), t = body.terrainManager, layer = t.cubeImageryLayer, renderer = r.getContext().webglRenderer;
      const ids = [...t.tiles.visibleTiles].map(x => x.content?.uri).filter(Boolean).sort();
      const geometryLevels = ids.map(u => Number(/\/(\d+)\/\d+\/\d+\.glb/.exec(u)?.[1] ?? -1));
      const attributes = [...t.tiles.visibleTiles].flatMap(tile => {
        const out = [];
        tile.engineData?.scene?.traverse(o => { if (o.isMesh) out.push([o.geometry.getAttribute('position').uuid, o.geometry.getAttribute('position').count]); });
        return out;
      }).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const ray = window.virtualImageryRay, cpuHit = body.intersectTerrainRay(ray, { maxMeshErrorKm: 0 });
      const radiusKm = Math.hypot(cpuHit.position.xKm, cpuHit.position.yKm, cpuHit.position.zKm);
      const d = [ray.origin.xKm, ray.origin.yKm, ray.origin.zKm].map(v => v / Math.hypot(ray.origin.xKm, ray.origin.yKm, ray.origin.zKm));
      const face = directionToCubeFace(d), tileSize = layer.manifest.tileSize;
      const centre = layer.sampleAt(d).map(s => ({ id: s.id, enabled: s.enabled, level: s.level,
        transparent: s.texture ? (s.texture.image?.width ?? 0) <= 1 : null,
        displayedMetersPerPixel: s.level >= 0 ? texelGroundSizeKm(s.level, face.u, face.v, radiusKm, tileSize) * 1000 : null }));
      const stats = t.cubeImageryStats;
      return { ids, maxGeometryLevel: Math.max(...geometryLevels), geometryTiles: ids.length, attributes, cpuHit: cpuHit.position, centre,
        layers: body.imageryLayers.map(l => ({ id: l.id, status: l.status, requests: l.requests, failedTiles: l.failedTiles, view: l.view, date: l.temporal?.date ?? null })),
        virtual: layer.virtualSources.map(v => ({ id: v.id, date: v.date, coverage: v.coverage, stats: v.stats, degradedResident: v.degradedResident })),
        imagery: { requests: stats.requests, textures: stats.textures, textureBytes: stats.textureBytes, maxTextureBytes: stats.maxTextureBytes,
          gpuAllocatedBytes: stats.gpuAllocatedBytes, failures: stats.failures, aborted: stats.aborted, evicted: stats.evicted, budgetLimited: stats.budgetLimited,
          baseUncoveredBlocks: stats.baseUncoveredBlocks, maxDisplayedLevel: stats.maxDisplayedLevel, displayedLevels: stats.displayedLevels, updateMs: stats.updateMs,
          sourceCache: stats.sourceCache, virtualTiles: stats.virtualTiles },
        draws: renderer.info.render.calls, textureCount: renderer.info.memory.textures, terrainBytes: t.tiles.lruCache.cachedBytes };
    }, { b: bodyName, root: '/@fs' + process.cwd() }),
    cap: level => page.evaluate(({ b, level }) => window.renderer.getBodyMesh(b).terrainManager.cubeImageryLayer.setOptions({ maxLevel: level }), { b: bodyName, level }),
    shot: name => page.locator('canvas').first().screenshot({ path: `${output}/${name}.png` }),
    async timing(frames = 60) {
      return page.evaluate(async frames => {
        const r = window.renderer, old = r.renderFrame, gl = r.getContext().webglRenderer.getContext(), cpu = [];
        r.renderFrame = function (...a) { gl.finish(); const s = performance.now(); const v = old.apply(this, a); gl.finish(); cpu.push(performance.now() - s); return v; };
        try { for (let i = 0; i < frames; i++) await new Promise(requestAnimationFrame); } finally { r.renderFrame = old; }
        cpu.sort((x, y) => x - y);
        return { frames: cpu.length, medianMs: cpu[cpu.length >> 1], p95Ms: cpu[Math.floor(cpu.length * 0.95)] };
      }, frames);
    },
  };
  return api;
}

/** Fixed terrain, imagery capped at the deepest drawn geometry level, then uncapped: imagery-only refinement. */
async function independence(api, name, site, layerId) {
  await api.cap(3); await api.pose(site.lat, site.lon, site.altitudeKm); await api.settle();
  const geometryLevel = (await api.snapshot()).maxGeometryLevel;
  await api.cap(geometryLevel); await api.settle();
  const coarse = await api.snapshot(); await api.shot(`${name}-capped-L${geometryLevel}`);
  const before = api.requests.length;
  await api.cap(undefined); await api.settle();
  const fine = await api.snapshot(); await api.shot(`${name}-native`);
  const timing = await api.timing();
  const layer = fine.centre.find(c => c.id === layerId), coverage = fine.virtual.find(v => v.id === layerId)?.coverage;
  // Terrain geometry and CPU surface are untouched by imagery refinement.
  assert.deepEqual(fine.ids, coarse.ids, `${name}: terrain tile set changed with imagery`);
  assert.deepEqual(fine.attributes, coarse.attributes, `${name}: terrain buffers changed with imagery`);
  assert.deepEqual(fine.cpuHit, coarse.cpuHit, `${name}: CPU surface hit changed with imagery`);
  assert.ok(layer.level > fine.maxGeometryLevel, `${name}: ${layerId} level ${layer.level} not finer than geometry ${fine.maxGeometryLevel}`);
  return { site, geometryLevel: fine.maxGeometryLevel, geometryTiles: fine.geometryTiles, layer, coverage, upstreamRequests: api.requests.length - before,
    coarse: { centre: coarse.centre, imagery: coarse.imagery, draws: coarse.draws }, fine: { centre: fine.centre, imagery: fine.imagery, draws: fine.draws, layers: fine.layers, virtual: fine.virtual }, timing };
}

async function mars() {
  const api = await open('mars-virtual-imagery', 'Mars');
  const out = result.mars = { sites: {}, cycle: [], outage: null };
  const sites = {
    gale: { lat: -4.59, lon: 137.44, altitudeKm: 1.5, note: 'py/nx face seam (135°E), southern hemisphere' },
    olympus: { lat: 18.4, lon: -133.8, altitudeKm: 1.5, note: 'nx face, northern hemisphere, high relief' },
    hale: { lat: -35.7, lon: -36.4, altitudeKm: 1.5, note: 'px face, southern mid-latitude' },
    korolev: { lat: 73.0, lon: 164.5, altitudeKm: 1.5, note: 'pz face, northern high latitude' },
    antimeridian: { lat: 4.0, lon: 179.9, altitudeKm: 1.5, note: 'near the source antimeridian on the nx face' },
    // Views straddling the seams themselves (a ~2 km wide view must contain the line).
    seam135: { lat: -4.59, lon: 135.0, altitudeKm: 1.5, note: 'on the py/nx cube-face edge (135°E), west of Gale' },
    wrap180: { lat: 4.0, lon: 180.0, altitudeKm: 1.5, note: 'on the source antimeridian (±180°): longitude wrap mid-view' },
  };
  for (const [name, site] of Object.entries(sites)) {
    if (only && !only.includes(name)) continue;
    console.log('mars', name);
    out.sites[name] = await independence(api, `mars-${name}`, site, 'ctx-global');
    const c = out.sites[name];
    console.log(`  geometry L${c.geometryLevel}; CTX L${c.layer.level} (${round(c.layer.displayedMetersPerPixel, 2)} m/px), transparent=${c.layer.transparent}; native ${round(c.coverage.nativeMetersPerPixel, 2)} m/px`);
  }
  // HiRISE: a regional source inside its bounds, deeper than CTX.
  if (!only || only.includes('jezero')) out.sites.jezero = await independence(api, 'mars-jezero-hirise', { lat: 18.4447, lon: 77.4508, altitudeKm: 0.3, note: 'regional HiRISE bounds' }, 'jezero-hirise');
  if (only) { await api.page.close(); return out; }
  // Region changes: residency stays bounded.
  for (let pass = 0; pass < 2; pass++) for (const [name, s] of Object.entries(sites)) {
    await api.pose(s.lat, s.lon, s.altitudeKm); await api.settle();
    const snap = await api.snapshot();
    out.cycle.push({ pass, name, textureBytes: snap.imagery.textureBytes, gpuAllocatedBytes: snap.imagery.gpuAllocatedBytes, sourceCacheBytes: snap.imagery.sourceCache.residentBytes,
      textures: snap.imagery.textures, draws: snap.draws, evicted: snap.imagery.evicted, terrainBytes: snap.terrainBytes });
    assert.ok(snap.imagery.sourceCache.residentBytes <= snap.imagery.sourceCache.maxBytes, 'source cache over budget');
  }
  // Optional source outage at a new site: base coverage holds, the layer reports it, recovery restores detail.
  const syrtis = { lat: 8.4, lon: 69.5, altitudeKm: 1.5 };
  await api.page.route(/astro\.arcgis\.com/, route => route.abort('failed'));
  await api.pose(syrtis.lat, syrtis.lon, syrtis.altitudeKm); await api.settle(true, 240_000);
  const down = await api.snapshot(); await api.shot('mars-outage-ctx');
  await api.page.unroute(/astro\.arcgis\.com/);
  await api.page.evaluate(() => window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.retryFailed());
  await api.settle(); await api.page.waitForTimeout(1000); await api.settle();
  const up = await api.snapshot(); await api.shot('mars-outage-recovered');
  out.outage = { site: syrtis, down: { centre: down.centre, layers: down.layers, baseUncoveredBlocks: down.imagery.baseUncoveredBlocks },
    recovered: { centre: up.centre, layers: up.layers } };
  assert.equal(down.imagery.baseUncoveredBlocks, 0, 'base coverage lost during optional outage');
  assert.ok(up.centre.find(c => c.id === 'ctx-global').level > down.centre.find(c => c.id === 'ctx-global').level, 'CTX did not recover after outage');
  await api.page.close();
  return out;
}

/** Deterministic GIBS: one colour per day, delayed so day switches race in-flight requests. */
const COLOURS = { '2026-11-01': [255, 0, 0], '2026-11-02': [0, 255, 0], '2026-11-03': [0, 0, 255], '2026-11-05': [255, 255, 0] };
const GAP = '2026-11-04';
const solidCache = new Map();
const solid = async (rgb, format = 'jpeg') => {
  const key = rgb.join() + format;
  if (!solidCache.has(key)) solidCache.set(key, await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })[format]().toBuffer());
  return solidCache.get(key);
};

async function earth() {
  // VIRTUAL_IMAGERY_EARTH=live,sites,mock selects phases (default all).
  const phases = process.env.VIRTUAL_IMAGERY_EARTH?.split(',') ?? ['live', 'sites', 'identity', 'mock'];
  const api = await open('earth-virtual-imagery', 'Earth');
  const out = result.earth = { live: {}, sites: {}, mock: {} };
  const day = (d) => api.page.evaluate(d => window.renderer.getBodyMesh('Earth').setImageryLayerTime('viirs-daily', { date: d }), d);
  const centrePixel = async () => {
    const png = await api.page.locator('canvas').first().screenshot();
    const { data, info } = await sharp(png).extract({ left: 650, top: 400, width: 100, height: 100 }).raw().toBuffer({ resolveWithObject: true });
    const mean = [0, 1, 2].map(c => { let s = 0; for (let i = c; i < data.length; i += info.channels) s += data[i]; return s / (data.length / info.channels); });
    return { mean: mean.map(v => round(v, 1)), buffer: data };
  };
  // Live GIBS: two real days at a fixed camera; rendered pixels and requests both change.
  const california = { lat: 36.5, lon: -121.9, altitudeKm: 400, fov: 30 };
  await api.pose(california.lat, california.lon, california.altitudeKm, california.fov);
  if (phases.includes('live')) for (const d of ['2026-11-03', '2026-11-04']) {
    const before = api.requests.length, since = await api.browserNow();
    await day(d); await api.settle();
    const snap = await api.snapshot(), px = await centrePixel(); await api.shot(`earth-live-${d}`);
    const dated = api.requests.slice(before).filter(u => u.includes('VIIRS_NOAA20'));
    // Old-day fetches already handed to the worker may still start within the abort's message latency.
    const late = api.requestsAfter(before, since).filter(u => u.includes('VIIRS_NOAA20') && !u.includes(`/${d}/`));
    out.live[d] = { requests: dated.length, thisDay: dated.filter(u => u.includes(`/${d}/`)).length, otherDayWithinGrace: dated.length - dated.filter(u => u.includes(`/${d}/`)).length - late.length,
      otherDayAfterGrace: late.length, centre: snap.centre, pixel: px.mean, virtual: snap.virtual };
    out.live[d].lateSamples = late.slice(0, 3);
    out.live[d].lastSupersededStartMs = api.latestStart(before, since, u => u.includes('VIIRS_NOAA20') && !u.includes(`/${d}/`));
    assert.ok(out.live[d].thisDay > 0 && late.length === 0, `live ${d}: a superseded day was requested after the switch: ${JSON.stringify(out.live[d])}`);
    out.live[d].raw = px.buffer;
  }
  if (phases.includes('live')) {
  const a = out.live['2026-11-03'].raw, b = out.live['2026-11-04'].raw;
  let changed = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 12) changed++;
  out.live.changedFraction = round(changed / a.length, 3);
  delete out.live['2026-11-03'].raw; delete out.live['2026-11-04'].raw;
  assert.ok(out.live.changedFraction > 0.05, 'two live days rendered the same pixels');
  // EPSG:4326 capabilities overlay (GIBS Coastlines, transparent PNG, 2×1/3×2/5×3… matrices) over the
  // Web Mercator day and the cube-native base: three projections registered at one coast.
  {
    await api.pose(36.6, -121.9, 60, 30);
    await api.page.evaluate(() => window.renderer.getBodyMesh('Earth').setImageryLayerVisible('coastlines', true));
    // Its capabilities document (~5 MB) loads first; settle only once the source is set up and requesting.
    await api.page.waitForFunction(() => { const t = window.renderer.getBodyMesh('Earth').terrainManager;
      return t.cubeImageryLayer.virtualSources.some(v => v.id === 'coastlines' && v.coverage) && t.imageryLayers.find(l => l.id === 'coastlines').requests > 6; }, null, { timeout: 180_000 });
    await api.settle();
    const snap = await api.snapshot(); await api.shot('earth-live-coastlines-registration');
    out.live.coastlines = { centre: snap.centre, layer: snap.layers.find(l => l.id === 'coastlines'), coverage: snap.virtual.find(v => v.id === 'coastlines')?.coverage,
      transparentSourceTiles: snap.imagery.sourceCache.transparent };
    // The view centre may be open water (a transparent coastline tile): judge the layer over the view.
    const coast = snap.virtual.find(v => v.id === 'coastlines');
    assert.ok(out.live.coastlines.layer.view?.zoomLevel != null && coast.stats.produced > 0, 'coastlines not drawn in view');
    await api.page.evaluate(() => window.renderer.getBodyMesh('Earth').setImageryLayerVisible('coastlines', false));
  }
  // `latest` through the EPSG:4326 capabilities layer: the provider's newest day (less latency), its own grid and {Time}.
  {
    const before = api.requests.length;
    await api.page.evaluate(() => window.renderer.getBodyMesh('Earth').setImageryLayerVisible('viirs-latest-4326', true));
    await api.page.waitForFunction(() => window.renderer.getBodyMesh('Earth').imageryLayers.find(l => l.id === 'viirs-latest-4326').temporal?.date, null, { timeout: 120_000 });
    await api.settle();
    const snap = await api.snapshot(); await api.shot('earth-live-latest-4326');
    const layer = snap.layers.find(l => l.id === 'viirs-latest-4326'), info = await api.page.evaluate(() => window.renderer.getBodyMesh('Earth').imageryLayers.find(l => l.id === 'viirs-latest-4326').temporal);
    const dated = api.requests.slice(before).filter(u => u.includes('/epsg4326/') && u.includes('VIIRS_NOAA20'));
    out.live.latest = { date: layer.date, temporal: info, requests: dated.length, allThatDay: dated.every(u => u.includes(`/${layer.date}/`)),
      matrices: [...new Set(dated.map(u => u.split('/250m/')[1]?.split('/')[0]))], centre: snap.centre.find(c => c.id === 'viirs-latest-4326'),
      coverage: snap.virtual.find(v => v.id === 'viirs-latest-4326')?.coverage };
    assert.equal(info.policy, 'latest');
    assert.ok(dated.length > 0 && out.live.latest.allThatDay, 'latest: requests not for the resolved day');
    await api.page.evaluate(() => window.renderer.getBodyMesh('Earth').setImageryLayerVisible('viirs-latest-4326', false));
  }
  }
  // Registration and imagery-only refinement at several latitudes and seams (cube-native base + 3857 + 4326 layers).
  if (phases.includes('sites')) for (const [name, site] of Object.entries({
    himalaya: { lat: 28.0, lon: 86.9, altitudeKm: 25 }, seam45E: { lat: 12.0, lon: 45.0, altitudeKm: 25 },
    scandinavia: { lat: 66.0, lon: 16.0, altitudeKm: 25 }, fiji: { lat: -17.5, lon: 179.5, altitudeKm: 25 },
  })) {
    console.log('earth', name);
    out.sites[name] = await independence(api, `earth-${name}`, site, 'viirs-daily');
  }
  // Terrain geometry and CPU surface across day changes: same camera, same clock, two real days.
  if (phases.includes('identity')) {
    await api.pose(california.lat, california.lon, california.altitudeKm, california.fov);
    const snaps = [];
    for (const d of ['2026-11-02', '2026-11-04', '2026-11-02']) { await day(d); await api.settle(); snaps.push(await api.snapshot()); }
    for (const snap of snaps.slice(1)) {
      assert.deepEqual(snap.ids, snaps[0].ids, 'terrain tiles changed across a date change');
      assert.deepEqual(snap.attributes, snaps[0].attributes, 'terrain buffers changed across a date change');
      assert.deepEqual(snap.cpuHit, snaps[0].cpuHit, 'CPU surface changed across a date change');
    }
    out.identity = { days: ['2026-11-02', '2026-11-04', '2026-11-02'], terrainTiles: snaps[0].ids.length, vertexBuffers: snaps[0].attributes.length,
      cpuHit: snaps[0].cpuHit, viirsDates: snaps.map(s => s.layers.find(l => l.id === 'viirs-daily').date), unchanged: true };
  }
  if (!phases.includes('mock')) { await api.page.close(); return out; }
  // Mock provider: gaps, failures, cancellation and races.
  await api.page.route(/gibs\.earthdata\.nasa\.gov\/wmts\/epsg3857\/best\/VIIRS/, async route => {
    const d = /\/default\/(\d{4}-\d{2}-\d{2})\//.exec(route.request().url())?.[1];
    await new Promise(r => setTimeout(r, 350));
    const cors = { 'access-control-allow-origin': '*' };
    if (d === GAP) return route.fulfill({ status: 404, headers: cors, body: '' });
    if (d === '2026-11-05' && /\/[0-9]+\/[0-9]*[02468]\.jpeg$/.test(route.request().url())) return route.fulfill({ status: 503, headers: cors, body: '' });
    return route.fulfill({ status: 200, contentType: 'image/jpeg', headers: cors, body: await solid(COLOURS[d] ?? [255, 0, 255]) });
  });
  await api.pose(california.lat, california.lon, california.altitudeKm, california.fov);
  // Rapid switching: only the final day may be requested after it, drawn or kept resident.
  const textures0 = (await api.snapshot()).imagery;
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-01', '2026-11-02']) { await day(d); await api.page.waitForTimeout(60); }
  const marker = api.requests.length, raceSwitch = await api.browserNow();
  await day('2026-11-03'); await api.settle();
  const raced = await api.snapshot(), racedPixel = await centrePixel(); await api.shot('earth-mock-race-final-day');
  const after = api.requests.slice(marker).filter(u => u.includes('VIIRS_NOAA20'));
  const lateRace = api.requestsAfter(marker, raceSwitch).filter(u => u.includes('VIIRS_NOAA20') && !u.includes('/2026-11-03/'));
  out.mock.race = { requestsAfterFinalSwitch: after.length, otherDayAfterGrace: lateRace.length,
    lastSupersededStartMs: api.latestStart(marker, raceSwitch, u => u.includes('VIIRS_NOAA20') && !u.includes('/2026-11-03/')), onlyFinalDay: lateRace.length === 0, date: raced.virtual.find(v => v.id === 'viirs-daily').date,
    pixel: racedPixel.mean, aborted: raced.imagery.aborted, sourceCache: raced.imagery.sourceCache };
  assert.ok(out.mock.race.onlyFinalDay, 'a superseded day was requested after the final switch');
  assert.ok(racedPixel.mean[2] > racedPixel.mean[0] + 20 && racedPixel.mean[2] > racedPixel.mean[1] + 20, 'final (blue) day not dominant: stale day drawn');
  // Repeated scrubbing does not grow residency.
  const residency = [];
  for (let i = 0; i < 4; i++) { await day(i % 2 ? '2026-11-01' : '2026-11-02'); await api.settle(); const s = await api.snapshot(); residency.push({ textureBytes: s.imagery.textureBytes, gpuAllocatedBytes: s.imagery.gpuAllocatedBytes, sourceCacheBytes: s.imagery.sourceCache.residentBytes }); }
  out.mock.scrub = { before: { textureBytes: textures0.textureBytes, gpuAllocatedBytes: textures0.gpuAllocatedBytes }, residency };
  assert.ok(residency.at(-1).gpuAllocatedBytes <= residency[1].gpuAllocatedBytes * 1.25, 'GPU pages grew across date switches');
  // Missing day (404): transparent, Blue Marble shows, no other day fetched.
  const gapMarker = api.requests.length, gapSwitch = await api.browserNow();
  await day(GAP); await api.settle();
  const gap = await api.snapshot(), gapPixel = await centrePixel(); await api.shot('earth-mock-gap-day');
  const gapRequests = api.requests.slice(gapMarker).filter(u => u.includes('VIIRS_NOAA20'));
  out.mock.gap = { requests: gapRequests.length, onlyGapDay: api.requestsAfter(gapMarker, gapSwitch).filter(u => u.includes('VIIRS_NOAA20') && !u.includes(`/${GAP}/`)).length === 0, centre: gap.centre, pixel: gapPixel.mean, layer: gap.layers.find(l => l.id === 'viirs-daily') };
  assert.ok(out.mock.gap.onlyGapDay, 'another day was fetched in place of a missing day');
  assert.equal(gap.centre.find(c => c.id === 'blue-marble-cube').enabled, 1, 'cube-native base not shown under a missing day');
  // Failed tiles (503 on half the tiles): reported, never another day.
  const failMarker = api.requests.length, failSwitch = await api.browserNow();
  await day('2026-11-05'); await api.settle(true, 600_000);
  const failed = await api.snapshot(); await api.shot('earth-mock-failed-tiles');
  out.mock.failed = { onlyThisDay: api.requestsAfter(failMarker, failSwitch).filter(u => u.includes('VIIRS_NOAA20') && !u.includes('/2026-11-05/')).length === 0, layer: failed.layers.find(l => l.id === 'viirs-daily'), sourceCache: failed.imagery.sourceCache };
  assert.ok(out.mock.failed.onlyThisDay, 'failed tiles were filled from another day');
  // Follow-simulation: the layer takes the simulation's UTC day. (Moving the clock rotates the
  // body under a world-fixed camera, so terrain identity is checked in the 'identity' phase instead.)
  await api.page.evaluate(() => window.renderer.getBodyMesh('Earth').setImageryLayerTime('viirs-daily', { policy: 'follow-simulation' }));
  await api.page.evaluate(() => window.cosmo.setTime({ kind: 'calendar', text: '2026-11-02T12:00:00Z' }));
  await api.page.waitForFunction(() => window.renderer.getBodyMesh('Earth').imageryLayers.find(l => l.id === 'viirs-daily').temporal?.date === '2026-11-02', null, { timeout: 30_000 });
  out.mock.follow = { date: '2026-11-02' };
  await api.page.close();
  return out;
}

try {
  if (which === 'mars' || which === 'all') await mars();
  if (which === 'earth' || which === 'all') await earth();
  result.passed = result.errors.length === 0;
} catch (error) {
  result.passed = false; result.failure = String(error?.stack ?? error); console.error(error);
} finally {
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2));
  await browser.close();
  console.log(`wrote ${output}/result.json; passed=${result.passed}`);
  if (!result.passed) process.exitCode = 1;
}
