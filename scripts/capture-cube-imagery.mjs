#!/usr/bin/env node
/**
 * Rendered evidence for independent cube-face imagery (#149): the viewer with
 * the cube-sphere terrain and a cube imagery pyramid (CubeImageryLayer), driven
 * through explicit IAU_MOON body-fixed camera poses at the catalog epoch.
 *
 * Start the viewer (`npm --prefix apps/viewer run dev`), build the products
 * (scripts/build-moon-terrain/cube.sh, cube-imagery.sh), then e.g.
 *
 *   node scripts/capture-cube-imagery.mjs --experiments fixed,registration,markers,failure,navigation,nac
 *
 * Experiments (each on a fresh page = cold caches unless noted):
 *  fixed         Grid fixture. Settle with imagery capped at level 3, record the
 *                geometry tile set, then lift the cap without moving: imagery
 *                refines while geometry tile ids, mesh objects and .glb requests
 *                stay identical. Shaded + imagery-level frames, coarse and fine.
 *  frozen        Grid fixture with the terrain held at level 2 (TilesRenderer.maxDepth 4)
 *                at Shackleton and the pole: imagery reaches level 10 on 13.6 km cells.
 *  registration  Registration fixture, imagery-unlit: a pixel grid is decoded to
 *                (face, level, column, row) and compared with the cube coordinate of
 *                the ray-cast body-fixed point it shows. Errors in texels and metres.
 *  markers       Grid fixture, imagery-unlit, nadir over each marker from 14 km: the
 *                marker-coloured pixels inside its 0.75 km ring (0.21–0.675 km annulus,
 *                inner rings, centre) — screen centroid vs the projected body-fixed centre,
 *                and their ray-cast ground points' footprint-weighted centroid vs the centre.
 *  failure       Grid fixture with every request at level ≥ 7 failing: coarse fallback,
 *                failure counts, no untextured blocks.
 *  navigation    Grid fixture: a path pole → Shackleton → antimeridian → edge → corner
 *                → orbit and five zoom cycles on one page (warm), sampling textures,
 *                bytes, requests, evictions, in-flight and blocks, under a 64 MiB budget.
 *  nac           LROC NAC mosaic: shaded and imagery-level frames at Shackleton and
 *                the pole, and an orbital view of its footprint.
 *
 * Env: CL_VIEWER_URL (default http://127.0.0.1:5173/), CHROMIUM_PATH.
 * Software WebGL (SwiftShader) here: frames establish correctness and
 * request/byte/texture counts, not hardware-GPU frame time.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, release } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? true : all[i + 1]]);
  return acc;
}, []));
const { directionToCubeFace } = await import(pathToFileURL(join(ROOT, 'packages/three/dist/surface/CubeSphere.js')).href);
const { texelGroundSizeKm } = await import(pathToFileURL(join(ROOT, 'packages/three/dist/surface/CubeImagery.js')).href);
const BASE = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173/';
const OUT = resolve(args.out ?? join(ROOT, 'work/cube-imagery/captures'));
const VIEWPORT = { width: Number(args.width ?? 1280), height: Number(args.height ?? 800) };
const EXPERIMENTS = String(args.experiments ?? 'fixed,frozen,registration,markers,failure,navigation,nac').split(',');
const TIMEOUT_MS = Number(args.timeout ?? 600_000);
const STABLE = Number(args.stable ?? 6);
const R = 1737.4;
const ONLY = args.views ? new Set(String(args.views).split(',')) : null;
const views = (names) => names.filter(n => !ONLY || ONLY.has(n));
const CATALOG = (k) => `test-catalogs/experiments/moon-terrain-cube-imagery-${k}`;

const at = (latDeg, lonDeg, hKm) => {
  const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180, r = R + hKm;
  return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)];
};
const VIEWS = {
  shackleton: { eye: at(-89.07, 129.78, 6.0), target: at(-89.67, 129.78, -2.5), fov: 60 },
  pole: { eye: at(-89.6, -50, 12.0), target: at(-90, 0, 0), fov: 60 },
  'antimeridian-60s': { eye: at(-59.4, 179.2, 40), target: at(-60, 180, 0), fov: 60 },
  'face-edge': { eye: at(-44.4, -0.8, 40), target: at(-45, 0, 0), fov: 60 },
  'face-corner': { eye: at(-34.6, 45.6, 60), target: at(-35.26438968, 45, 0), fov: 60 },
  overview: { eye: at(-55, 60, 3000), target: at(-70, 60, 0), fov: 50 },
  'nac-footprint': { eye: at(-80, 20, 450), target: at(-90, 0, 0), fov: 50 },
};
const MARKERS = [
  ['shackleton', -89.67, 129.78], ['south-pole', -90, 0], ['antimeridian-88s', -88, 180], ['antimeridian-60s', -60, 180],
  ['antimeridian-equator', 0, 180], ['edge-px-nz', -45, 0], ['corner-px-py-nz', -35.26438968, 45],
];
const MARKER_COLOURS = { shackleton: [255, 40, 40], 'south-pole': [40, 255, 40], 'antimeridian-88s': [0, 255, 255], 'antimeridian-60s': [255, 0, 255],
  'antimeridian-equator': [255, 255, 0], 'edge-px-nz': [255, 140, 0], 'corner-px-py-nz': [160, 60, 255] };

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-gpu-blocklist'] });
mkdirSync(OUT, { recursive: true });
const results = {};
let env = null;

async function openViewer(catalog, setup) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await page.addInitScript(() => performance.setResourceTimingBufferSize(1_000_000));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Errors, plus warnings other than the expected per-tile load warnings and missing catalog textures.
  page.on('console', m => {
    if (m.type() === 'error' || (m.type() === 'warning' && !/Tile load error|tiles versions|Failed to load (baseMap|normalMap)|Initial assets settled/.test(m.text()))) errors.push(`${m.type()}: ${m.text()}`);
  });
  if (setup) await setup(page);
  await page.goto(new URL(`?catalog=${catalog}&test=1`, BASE).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady === true, null, { timeout: 180_000 });
  await page.evaluate(async () => {
    const source = await (await fetch('/src/lib/commands.ts')).text();
    const stateURL = source.match(/from ["']([^"']*viewer-state\.svelte[^"']*)["']/)?.[1];
    window.ci = await import(stateURL ?? '/src/lib/viewer-state.svelte.ts');
    window.ciMoon = () => window.ci.getRenderer().getBodyMesh('Moon');
    window.ciLayer = () => window.ciMoon().terrainManager?.cubeImageryLayer;
  });
  await page.waitForFunction(() => window.ciLayer()?.manifest != null, null, { timeout: 60_000 });
  if (!env) {
    env = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
      return { userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio,
        webglRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER), hardwareConcurrency: navigator.hardwareConcurrency };
    });
  }
  return { page, errors };
}

/** Pose the camera (every poll: the app's controls own it) and set the debug view. */
const pose = (page, view, mode) => page.evaluate(({ view, mode }) => {
  const r = window.ci.getRenderer(), bm = window.ciMoon();
  window.cosmo.setPlaying(false); window.cosmo.untrack();
  r.setTerrainDebugMode(mode === 'shaded' ? 'none' : mode, 'Moon');
  const V = r.camera.position.constructor;
  const centre = new V(); bm.getWorldPosition(centre);
  const toWorld = ([x, y, z]) => new V(x, z, -y).applyQuaternion(bm.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
  const eye = toWorld(view.eye), target = toWorld(view.target);
  const c = r.camera, controls = r.cameraController.controls;
  controls.enableDamping = false;
  c.fov = view.fov; c.updateProjectionMatrix();
  c.position.copy(eye); c.up.copy(eye.clone().sub(centre).normalize()); controls.target.copy(target);
  c.lookAt(target); c.updateMatrixWorld(true);
}, { view, mode });

const snapshot = (page) => page.evaluate(() => {
  const bm = window.ciMoon(), tm = bm.terrainManager;
  const visible = [];
  tm.tiles.visibleTiles.forEach(t => { if (t.content?.uri) visible.push(t.content.uri); });
  visible.sort();
  const meshIds = [];
  tm.tiles.visibleTiles.forEach(t => t.engineData?.scene?.traverse(o => { if (o.isMesh && !o.name.startsWith('cube-imagery-block')) meshIds.push(o.uuid); }));
  meshIds.sort();
  const res = performance.getEntriesByType('resource');
  const glb = res.filter(e => e.name.includes('/moon-terrain-cube/') && e.name.endsWith('.glb'));
  const img = res.filter(e => e.name.includes('/moon-imagery-cube-') && e.name.endsWith('.png'));
  let levels = {};
  tm.tiles.visibleTiles.forEach(t => { const m = /\/(\d+)\/\d+\/\d+\.glb$/.exec(t.content?.uri ?? ''); if (m) levels[m[1]] = (levels[m[1]] ?? 0) + 1; });
  return { metrics: bm.terrainMetrics, imagery: bm.terrainCubeImageryStats, visibleTiles: visible, geometryLevels: levels,
    meshIds, glbRequests: glb.length, glbBytes: glb.reduce((s, e) => s + (e.encodedBodySize || 0), 0),
    imageryRequests: img.length, imageryBytes: img.reduce((s, e) => s + (e.encodedBodySize || 0), 0) };
});

/** Wait until terrain and imagery are both idle and unchanged for STABLE polls. */
async function settle(page, view, mode, { imagery = true } = {}) {
  const start = Date.now();
  let stable = 0, last = '', s = null;
  while (Date.now() - start < TIMEOUT_MS) {
    await page.waitForTimeout(500);
    await pose(page, view, mode);
    s = await snapshot(page);
    const n = s.metrics.network, i = s.imagery;
    // A full texture budget is a settled state too: the layer stops requesting and keeps fallbacks.
    const busy = n.queued + n.downloading + n.parsing + (imagery ? i.inFlight + (i.budgetLimited ? 0 : i.queued + i.fallbackBlocks) : 0);
    const key = `${s.visibleTiles.length}|${i.maxDisplayedLevel}|${i.blocks}`;
    stable = busy === 0 && s.visibleTiles.length > 0 && key === last ? stable + 1 : 0;
    last = key;
    if (stable >= STABLE) return { ...s, settleMs: Date.now() - start, finished: true };
  }
  return { ...s, settleMs: Date.now() - start, finished: false };
}

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.jpg`), type: 'jpeg', quality: 88 });
  return `${name}.jpg`;
}
/** One synchronous canvas frame (no UI) decoded to RGBA. */
async function canvasPixels(page) {
  const url = await page.evaluate(() => window.__cosmolabe.capture());
  const { data, info } = await sharp(Buffer.from(url.split(',')[1], 'base64')).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, at: (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 3)] };
}
/** Ray-cast screen pixels (centres) against the rendered terrain meshes → body-fixed metres. */
const rayCast = (page, pixels) => page.evaluate(async (pixels) => {
  const r = window.ci.getRenderer(), tm = window.ciMoon().terrainManager;
  // The same pre-bundled three.js module instance the viewer loaded.
  const depUrl = performance.getEntriesByType('resource').map(e => e.name).find(n => /\/\.vite\/deps\/three\.js(\?|$)/.test(n));
  const { Raycaster } = await import(depUrl);
  const canvas = r.renderer.domElement;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  tm.tiles.group.updateMatrixWorld(true);
  const inv = tm.tiles.group.matrixWorld.clone().invert();
  const meshes = [];
  tm.tiles.visibleTiles.forEach(t => t.engineData?.scene?.traverse(o => { if (o.isMesh && !o.name.startsWith('cube-imagery-block')) meshes.push(o); }));
  const ray = new Raycaster();
  return pixels.map(([x, y]) => {
    const ndc = { x: (x + 0.5) / w * 2 - 1, y: -((y + 0.5) / h * 2 - 1) };
    ray.setFromCamera(ndc, r.camera);
    let best = null;
    for (const m of meshes) {
      const hits = [];
      m.raycast(ray, hits);
      for (const hit of hits) if (!best || hit.distance < best.distance) best = hit;
    }
    if (!best) return null;
    const p = best.point.clone().applyMatrix4(inv);
    // Ground footprint of this pixel ∝ distance² / |cos(incidence)|: weights an area centroid.
    const n = best.face.normal.clone().transformDirection(best.object.matrixWorld);
    const weight = best.distance ** 2 / Math.max(0.05, Math.abs(n.dot(ray.ray.direction)));
    return [p.x, p.y, p.z, weight];
  });
}, pixels);
/** Project body-fixed km points to screen pixels. */
const project = (page, points) => page.evaluate((points) => {
  const r = window.ci.getRenderer(), bm = window.ciMoon();
  const V = r.camera.position.constructor;
  const centre = new V(); bm.getWorldPosition(centre);
  const canvas = r.renderer.domElement;
  return points.map(([x, y, z]) => {
    const p = new V(x, z, -y).applyQuaternion(bm.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre).project(r.camera);
    return [(p.x + 1) / 2 * canvas.clientWidth, (1 - p.y) / 2 * canvas.clientHeight, p.z];
  });
}, points);

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return a.map(c => c / l); };
const summary = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, median: s[Math.floor(s.length / 2)], rms: Math.sqrt(s.reduce((a, b) => a + b * b, 0) / s.length), p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
};
const pick = (s) => s && ({ settleMs: s.settleMs, finished: s.finished, geometryLevels: s.geometryLevels, visibleTiles: s.visibleTiles.length,
  glbRequests: s.glbRequests, glbBytes: s.glbBytes, imageryRequests: s.imageryRequests, imageryBytes: s.imageryBytes,
  imagery: s.imagery, tiles: s.metrics.tiles, memory: s.metrics.memory });

try {
  // ---------------------------------------------------------------------------
  if (EXPERIMENTS.includes('fixed')) {
    results.fixed = [];
    for (const name of views(['shackleton', 'pole', 'antimeridian-60s', 'face-edge', 'face-corner'])) {
      const { page, errors } = await openViewer(CATALOG('grid'));
      const view = VIEWS[name];
      await page.evaluate(() => window.ciLayer().setOptions({ maxLevel: 3 }));
      const coarse = await settle(page, view, 'shaded');
      const files = { coarse: await shot(page, `fixed-${name}-coarse-shaded`) };
      await pose(page, view, 'imagery-level'); await page.waitForTimeout(800);
      files.coarseLevel = await shot(page, `fixed-${name}-coarse-level`);
      await page.evaluate(() => { window.ciLayer().setOptions({ maxLevel: undefined }); window.ciLayer().resetCounters(); });
      const t0 = Date.now();
      const fine = await settle(page, view, 'shaded');
      const coldToTargetMs = Date.now() - t0;
      files.fine = await shot(page, `fixed-${name}-fine-shaded`);
      await pose(page, view, 'imagery-level'); await page.waitForTimeout(800);
      files.fineLevel = await shot(page, `fixed-${name}-fine-level`);
      const sameTiles = JSON.stringify(coarse.visibleTiles) === JSON.stringify(fine.visibleTiles);
      const sameMeshes = JSON.stringify(coarse.meshIds) === JSON.stringify(fine.meshIds);
      const row = { view: name, files, sameGeometryTiles: sameTiles, sameMeshObjects: sameMeshes, glbRequestsDuringRefinement: fine.glbRequests - coarse.glbRequests,
        imageryRequestsDuringRefinement: fine.imagery.requests, imageryBytesDuringRefinement: fine.imagery.bytes, imageryRefineMs: coldToTargetMs,
        coarse: pick(coarse), fine: pick(fine), errors };
      results.fixed.push(row);
      console.log(`fixed ${name}: geometry ${sameTiles && sameMeshes ? 'unchanged' : 'CHANGED'} (${fine.visibleTiles.length} tiles, L${Object.keys(fine.geometryLevels).join(',')}), `
        + `imagery L${coarse.imagery.maxDisplayedLevel}→L${fine.imagery.maxDisplayedLevel}, +${fine.imagery.requests} requests / ${(fine.imagery.bytes / 1e6).toFixed(1)} MB in ${(coldToTargetMs / 1000).toFixed(0)} s, `
        + `${fine.imagery.blocks} blocks (+${fine.imagery.extraDraws} draws), ${fine.glbRequests - coarse.glbRequests} new .glb`);
      await page.close();
    }
  }

  // ---------------------------------------------------------------------------
  if (EXPERIMENTS.includes('frozen')) {
    results.frozen = [];
    for (const name of views(['shackleton', 'pole'])) {
      const { page, errors } = await openViewer(CATALOG('grid'));
      // The renderer's depth counts its own root above the tileset's content-less root, so
      // maxDepth 4 holds the cube geometry at level ≤ 2 (13.6 km vertex spacing at the face centre).
      await page.evaluate(() => { window.ciMoon().terrainManager.tiles.maxDepth = 4; });
      const s = await settle(page, VIEWS[name], 'shaded');
      const files = { shaded: await shot(page, `frozen-${name}-shaded`) };
      await pose(page, VIEWS[name], 'imagery-level'); await page.waitForTimeout(800);
      files.level = await shot(page, `frozen-${name}-level`);
      await pose(page, VIEWS[name], 'imagery-unlit'); await page.waitForTimeout(800);
      files.unlit = await shot(page, `frozen-${name}-unlit`);
      await pose(page, VIEWS[name], 'lod'); await page.waitForTimeout(800);
      files.lod = await shot(page, `frozen-${name}-lod`);
      results.frozen.push({ view: name, files, ...pick(s), errors });
      console.log(`frozen ${name}: geometry L${Object.keys(s.geometryLevels).join(',')} (${s.visibleTiles.length} tiles), imagery to L${s.imagery.maxDisplayedLevel}, `
        + `${s.imagery.blocks} blocks over ${s.imagery.splitTiles} split tiles, block geometry ${(s.imagery.blockGeometryBytes / 1e6).toFixed(1)} MB`);
      await page.close();
    }
  }

  // ---------------------------------------------------------------------------
  if (EXPERIMENTS.includes('registration')) {
    results.registration = [];
    const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
    for (const name of views(['shackleton', 'pole', 'antimeridian-60s', 'face-edge', 'face-corner', 'overview'])) {
      const { page, errors } = await openViewer(CATALOG('registration'));
      const s = await settle(page, VIEWS[name], 'imagery-unlit');
      const img = await canvasPixels(page);
      const grid = [];
      for (let y = 20; y < img.height - 20; y += 23) for (let x = 20; x < img.width - 20; x += 29) grid.push([x, y]);
      const hits = await rayCast(page, grid);
      const errs = [], metres = [], faceMismatch = [];
      let skipped = 0, tileMismatch = 0;
      grid.forEach(([x, y], i) => {
        const hit = hits[i];
        if (!hit) { skipped++; return; }
        const [R8, G8, B8] = img.at(x, y);
        // Exclude texels whose filtering reaches a tile edge (clamped ramps, mixed B).
        const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => img.at(x + dx, y + dy));
        if (R8 <= 1 || R8 >= 254 || G8 <= 1 || G8 >= 254 || neighbours.some(n => n[2] !== B8)) { skipped++; return; }
        const face = faces[B8 >> 5], level = B8 & 31;
        const c = directionToCubeFace(hit);
        if (c.face !== face) { faceMismatch.push({ x, y, decoded: face, expected: c.face }); return; }
        const n = 2 ** level;
        const fu = (c.u + 1) / 2 * n, fv = (c.v + 1) / 2 * n;
        const ex = (fu - Math.floor(fu)) * 256 - 0.5, ey = (fv - Math.floor(fv)) * 256 - 0.5;
        let dx = R8 - ex, dy = G8 - ey;
        if (Math.abs(dx) > 128 || Math.abs(dy) > 128) { tileMismatch++; return; }
        const e = Math.hypot(dx, dy);
        errs.push(e);
        metres.push(e * texelGroundSizeKm(level, c.u, c.v, R, 256) * 1000);
      });
      const file = await shot(page, `registration-${name}-unlit`);
      const row = { view: name, file, samples: grid.length, measured: errs.length, skippedNearTileEdgesOrSky: skipped, faceMismatch: faceMismatch.length,
        tileMismatch, errorTexels: summary(errs), errorMetres: summary(metres), displayedLevels: s.imagery.displayedLevels, faceMismatches: faceMismatch.slice(0, 10), errors };
      results.registration.push(row);
      console.log(`registration ${name}: ${errs.length} px, error texels median ${row.errorTexels?.median.toFixed(2)} p95 ${row.errorTexels?.p95.toFixed(2)} max ${row.errorTexels?.max.toFixed(2)}`
        + ` (max ${row.errorMetres?.max.toFixed(2)} m), face mismatches ${faceMismatch.length}, tile mismatches ${tileMismatch}`);
      await page.close();
    }
  }

  // ---------------------------------------------------------------------------
  if (EXPERIMENTS.includes('markers')) {
    results.markers = [];
    const { page, errors } = await openViewer(CATALOG('grid'));
    for (const [name, lat, lon] of MARKERS) {
      const view = { eye: at(lat, lon, 14), target: at(lat === 90 || lat === -90 ? lat : lat, lon, 0), fov: 60 };
      if (Math.abs(lat) === 90) view.eye = at(lat > 0 ? 89.999 : -89.999, lon, 14);
      const s = await settle(page, view, 'imagery-unlit');
      const sample = await page.evaluate(([la, lo]) => window.ciMoon().sampleTerrain(la, lo)?.elevationKm ?? null, [lat, lon]);
      // The marker centre and four points on its 0.75 km (black) ring, on the CPU-sampled surface.
      const h = sample ?? 0, d = at(lat, lon, 0).map(c => c / R);
      const e1 = norm(Math.abs(d[2]) < 0.9 ? cross(d, [0, 0, 1]) : cross(d, [1, 0, 0])), e2 = cross(d, e1);
      const a = 0.75 / R;
      const ring = [e1, e2, e1.map(c => -c), e2.map(c => -c)].map(e => d.map((c, k) => (Math.cos(a) * c + Math.sin(a) * e[k]) * (R + h)));
      const [[cx, cy], ...ringPx] = await project(page, [d.map(c => c * (R + h)), ...ring]);
      const cutPx = Math.min(...ringPx.map(([x, y]) => Math.hypot(x - cx, y - cy)));
      const img = await canvasPixels(page);
      const colour = MARKER_COLOURS[name];
      let sx = 0, sy = 0, n = 0;
      const matched = [];
      // Inside the 0.75 km ring only the marker's own concentric features (0.21–0.675 km annulus,
      // inner rings, centre disc) carry its colour. A wider cut leaks the 3.4–10.8 km annulus in
      // on the downslope side where relief is strong (the pole sits on Shackleton's rim).
      for (let y = Math.max(0, Math.floor(cy - cutPx)); y < Math.min(img.height, cy + cutPx); y++) for (let x = Math.max(0, Math.floor(cx - cutPx)); x < Math.min(img.width, cx + cutPx); x++) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > cutPx) continue;
        const v = img.at(x, y);
        // sRGB bytes pass through unconverted in imagery-unlit; allow filtering at annulus edges.
        if (Math.abs(v[0] - colour[0]) <= 3 && Math.abs(v[1] - colour[1]) <= 3 && Math.abs(v[2] - colour[2]) <= 3) { sx += x + 0.5; sy += y + 0.5; n++; matched.push([x, y]); }
      }
      const groundPerPx = 2 * 14 * Math.tan(30 * Math.PI / 180) / img.height;
      const errPx = n ? Math.hypot(sx / n - cx, sy / n - cy) : null;
      // Ground-space check, free of the perspective bias relief adds to a screen centroid:
      // ray-cast every marker pixel, footprint-weighted centroid in the marker's tangent plane.
      const hits = (await rayCast(page, matched)).filter(Boolean);
      let gx = 0, gy = 0, gw = 0;
      for (const [x, y, z, w] of hits) {
        const v = [x / 1000, y / 1000, z / 1000].map((c, k) => c - d[k] * (R + h));
        gx += w * (v[0] * e1[0] + v[1] * e1[1] + v[2] * e1[2]); gy += w * (v[0] * e2[0] + v[1] * e2[1] + v[2] * e2[2]); gw += w;
      }
      const groundErrorM = gw ? Math.hypot(gx / gw, gy / gw) * 1000 : null;
      const file = await shot(page, `markers-${name}-unlit`);
      results.markers.push({ marker: name, latDeg: lat, lonDeg: lon, elevationKm: sample, projected: [cx, cy], ring075kmPx: cutPx, pixels: n, centroid: n ? [sx / n, sy / n] : null,
        screenCentroidErrorPx: errPx, screenCentroidErrorMetresApprox: errPx != null ? errPx * groundPerPx * 1000 : null, groundCentroidErrorM: groundErrorM, rayHits: hits.length, displayedLevels: s.imagery.displayedLevels, file });
      console.log(`marker ${name}: ${n} px, screen centroid ${errPx?.toFixed(2)} px (≈${(errPx * groundPerPx * 1000).toFixed(1)} m) from the projected centre; ground centroid ${groundErrorM?.toFixed(1)} m from the body-fixed centre; imagery L${s.imagery.maxDisplayedLevel}`);
    }
    results.markersErrors = errors;
    await page.close();
  }

  // ---------------------------------------------------------------------------
  if (EXPERIMENTS.includes('failure')) {
    const blocked = [];
    const { page, errors } = await openViewer(CATALOG('grid'), (p) => p.route(/moon-imagery-cube-grid\/tiles\/\w+\/(\d+)\//, (route) => {
      const level = Number(/tiles\/\w+\/(\d+)\//.exec(route.request().url())[1]);
      if (level >= 7) { blocked.push(route.request().url()); return route.abort('failed'); }
      return route.continue();
    }));
    const s = await settle(page, VIEWS.shackleton, 'shaded');
    const files = { shaded: await shot(page, 'failure-shackleton-shaded') };
    await pose(page, VIEWS.shackleton, 'imagery-level'); await page.waitForTimeout(800);
    files.level = await shot(page, 'failure-shackleton-level');
    // Within the retry window the failed tiles are not requested again.
    const before = (await snapshot(page)).imagery.requests;
    await page.waitForTimeout(5000);
    const after = (await snapshot(page)).imagery.requests;
    results.failure = { view: 'shackleton', files, blockedRequests: blocked.length, requestsInNext5s: after - before, ...pick(s),
      consoleErrors: errors.length };
    console.log(`failure: ${blocked.length} blocked, imagery stays at L${s.imagery.maxDisplayedLevel}, failures ${s.imagery.failures}, untextured ${s.imagery.untexturedBlocks}, ${after - before} retries in 5 s`);
    await page.close();
  }

  // ---------------------------------------------------------------------------
  if (EXPERIMENTS.includes('navigation')) {
    const { page, errors } = await openViewer(CATALOG('grid'));
    // A tight budget so eviction actually happens along the path.
    await page.evaluate(() => window.ciLayer().setOptions({ maxTextureBytes: 64 * 2 ** 20 }));
    const path = ['pole', 'shackleton', 'antimeridian-60s', 'face-edge', 'face-corner', 'overview', 'shackleton', 'pole'];
    const zoom = [0.3, 3, 30, 300, 3000];
    const steps = [];
    const sample = async (label) => {
      const s = await snapshot(page);
      steps.push({ label, t: Date.now(), imagery: s.imagery, glbRequests: s.glbRequests, visibleTiles: s.visibleTiles.length });
    };
    for (const name of path) {
      await settle(page, VIEWS[name], 'shaded');
      await sample(name);
    }
    for (let cycle = 0; cycle < 5; cycle++) for (const h of [...zoom, ...zoom.slice().reverse()]) {
      const v = { eye: at(-89.4, 129.78, h), target: at(-89.67, 129.78, -2.5), fov: 60 };
      for (let i = 0; i < 6; i++) { await pose(page, v, 'shaded'); await page.waitForTimeout(250); }
      await sample(`zoom${cycle}-${h}km`);
    }
    await settle(page, VIEWS.shackleton, 'shaded');
    await sample('final');
    const tex = steps.map(s => s.imagery.textures), bytes = steps.map(s => s.imagery.textureBytes);
    results.navigation = { budgetBytes: 64 * 2 ** 20, steps: steps.map(s => ({ label: s.label, textures: s.imagery.textures, textureMB: +(s.imagery.textureBytes / 2 ** 20).toFixed(1),
      inFlight: s.imagery.inFlight, queued: s.imagery.queued, requests: s.imagery.requests, MB: +(s.imagery.bytes / 1e6).toFixed(1), evicted: s.imagery.evicted, aborted: s.imagery.aborted,
      blocks: s.imagery.blocks, extraDraws: s.imagery.extraDraws, blockGeometryMB: +(s.imagery.blockGeometryBytes / 1e6).toFixed(2), maxLevel: s.imagery.maxDisplayedLevel,
      updateMs: +s.imagery.updateMs.toFixed(2), budgetLimited: s.imagery.budgetLimited, glbRequests: s.glbRequests })),
      maxTextures: Math.max(...tex), maxTextureMB: Math.max(...bytes) / 2 ** 20, errors };
    console.log(`navigation: ${steps.length} samples, textures ≤ ${Math.max(...tex)}, texture MB ≤ ${(Math.max(...bytes) / 2 ** 20).toFixed(1)} (budget 64), `
      + `evicted ${steps.at(-1).imagery.evicted}, aborted ${steps.at(-1).imagery.aborted}, requests ${steps.at(-1).imagery.requests}`);
    await page.close();
  }

  // ---------------------------------------------------------------------------
  if (EXPERIMENTS.includes('nac')) {
    results.nac = [];
    for (const name of views(['shackleton', 'pole', 'nac-footprint'])) {
      const { page, errors } = await openViewer(CATALOG('nac'));
      const s = await settle(page, VIEWS[name], 'shaded');
      const files = { shaded: await shot(page, `nac-${name}-shaded`) };
      await pose(page, VIEWS[name], 'imagery-unlit'); await page.waitForTimeout(800);
      files.unlit = await shot(page, `nac-${name}-unlit`);
      await pose(page, VIEWS[name], 'imagery-level'); await page.waitForTimeout(800);
      files.level = await shot(page, `nac-${name}-level`);
      results.nac.push({ view: name, files, ...pick(s), errors });
      console.log(`nac ${name}: imagery to L${s.imagery.maxDisplayedLevel} in ${(s.settleMs / 1000).toFixed(0)} s, ${s.imageryRequests} requests / ${(s.imageryBytes / 1e6).toFixed(1)} MB, geometry L${Object.keys(s.geometryLevels).join(',')}`);
      await page.close();
    }
  }
} catch (err) {
  // Keep what finished: a partial record still documents the completed experiments.
  results.error = String(err?.stack ?? err);
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser.close();
}

const record = {
  generator: 'scripts/capture-cube-imagery.mjs', created: new Date().toISOString(), viewport: VIEWPORT,
  poses: { frame: 'IAU_MOON body-fixed, km, Z-up; catalog defaultTime 2028-12-15T10:04:00Z, paused; terrain errorTarget 2; imagery maxScreenTexelError 1.5 (default)', views: VIEWS },
  browser: { ...env, launch: 'playwright chromium headless, --use-angle=swiftshader (software WebGL; no GPU in this host); ?test=1 (no antialias/bloom/stars)' },
  host: { platform: `${platform()} ${release()}`, cpus: cpus().length, cpuModel: cpus()[0]?.model, memoryGB: Math.round(totalmem() / 2 ** 30) },
  results,
};
const file = join(OUT, `imagery-captures-${EXPERIMENTS.join('-')}.json`);
writeFileSync(file, JSON.stringify(record, null, 1) + '\n');
console.log(`wrote ${file}`);
