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
 *  frametime     Per view, warm: terrain only, imagery without split tiles (capped at L0)
 *                and imagery refined; FRAMES (--frames, 120) back-to-back renderFrame calls,
 *                each fenced by readPixels, plus GPU TIME_ELAPSED queries and draw counts.
 *                Meaningful with --gpu (hardware ANGLE backend); --catalog nac for real imagery.
 *  cracks        Mixed-LOD crack mitigation at rest (finished detail): Shackleton, the pole,
 *                the px/nz edge and the px/py/nz corner, oblique, near-ground and grazing,
 *                terrain only, grid fixture and NAC. Per view: a hole mask (visible terrain
 *                only, white on black, one synchronous pass) as displayed with skirts and
 *                for the same tiles' surface triangles only; neighbour level differences
 *                of the visible tiles; picks on unmitigated hole pixels; shaded frames
 *                with skirts on/off; draws and triangles both ways; skirt pixels drawn over
 *                nearer surface (a depth-precision failure the hole masks cannot see).
 *  cracks-dynamic  The same hole masks along camera paths without waiting for detail
 *                (refining in, coarsening out, panning across pole/edge/corner), on a
 *                normal network, with child .glb requests delayed or failing, and under
 *                a small tile cache that evicts.
 *  compare       (--throttle RTT_MS,MBPS for cold loads over an emulated network; --error-target N overrides)
 *                The layout comparison, geometry only (no baseline has matched imagery yet):
 *                cube, polar cap and geographic products from the same poses, cold page
 *                each: time to finished detail, requests/bytes, tiles, achieved level and
 *                vertex spacing under the screen centre, geometry/cache memory, terrain
 *                pixel coverage (the polar cap has no horizon), then warm frame timing.
 *  skirt-cost    Per view, warm, one page: frame timing with skirts on and off (terrain
 *                only and grid imagery refined). Meaningful with --gpu.
 *
 * --log-depth-fix serves three.js with the log depth precision fix (patchLogDepthPrecision
 * in UniverseRenderer, on its own branch) until this branch has it.
 *
 * Env: CL_VIEWER_URL (default http://127.0.0.1:5173/), CHROMIUM_PATH.
 * Default is SwiftShader software WebGL (correctness, counts); --gpu uses the
 * host GPU (--angle metal|vulkan|…) and is the only mode whose timings mean anything.
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
const FRAMES = Number(args.frames ?? 120);
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

/**
 * Grazing and near-ground poses resolved on the CPU surface (km above the sample
 * below each point): eye and target given as [lat, lon, height above surface].
 */
/** Comparison poses with heights fixed from the cube CPU grids (same fused field), so every product gets identical poses. */
const COMPARE_VIEWS = {
  shackleton: VIEWS.shackleton, pole: VIEWS.pole, overview: VIEWS.overview, 'face-corner': VIEWS['face-corner'],
  'shackleton-grazing': { eye: at(-89.33, 129.78, 0.9117 + 0.4), target: at(-89.67, -50.22, -1.1193 + 0.3), fov: 60 },
  'pole-grazing': { eye: at(-89.7, -30, -0.6767 + 0.5), target: at(-89.4, 150, 0.6022 + 0.2), fov: 60 },
  // Inside the polar cap's 200 km square from edge to edge of the frame: no horizon to account for.
  'cap-nadir': { eye: at(-89.5, 60, 40), target: at(-89.55, 60, 0), fov: 60 },
};
const PRODUCTS = {
  cube: { catalog: 'test-catalogs/experiments/moon-terrain-cube', data: '/moon-terrain-cube/', spacingM: (L) => 2 * R * 1000 / (64 * 2 ** L) },
  // Geometric error per vertex spacing: cube 0.25 (dem.py), geographic ≈ 0.25 (QuantizedMeshPlugin:
  // πR / (4·65·2^z) against πR / (64·2^z)), polar cap 0.125. Matched screen-space spacing therefore
  // needs the cap at half the others' errorTarget; --equal-error-target keeps 2 everywhere.
  polar: { catalog: 'test-catalogs/experiments/moon-terrain-polar', data: '/moon-terrain-polar/', spacingM: (L) => 200_000 / 2 ** L / 64, errorTarget: 1 },
  geographic: { catalog: 'test-catalogs/experiments/moon-terrain-geographic', data: '/moon-terrain-fused/', spacingM: (L) => Math.PI * R * 1000 / 2 ** L / 64 },
};

const SURFACE_VIEWS = {
  'shackleton-grazing': { eye: [-89.33, 129.78, 0.4], target: [-89.67, -50.22, 0.3], fov: 60 }, // rim, across the crater
  'shackleton-near': { eye: [-89.55, 129.78, 0.15], target: [-89.67, 129.78, 0], fov: 60 },
  'pole-grazing': { eye: [-89.7, -30, 0.5], target: [-89.4, 150, 0.2], fov: 60 }, // across the exact pole
  'edge-grazing': { eye: [-45.3, -0.4, 1.0], target: [-44.4, 0.6, 0.2], fov: 60 }, // across the px/nz edge
  'corner-grazing': { eye: [-35.6, 44.5, 1.5], target: [-34.8, 45.6, 0.3], fov: 60 }, // across the px/py/nz corner
  // Reported in review: skirts drawing through nearer surface (log depth precision, 1–4 km away).
  'pole-low': { eye: [-89.98, -173.87, 0.97], target: [-89.9992, -137.11, 0], fov: 60 },
  'rim-low': { eye: [-88.032, 87.33, 1.69], target: [-88.039, 90.435, 0], fov: 60 },
};

// --gpu: the host's hardware GPU through ANGLE (`--angle metal|vulkan|d3d11|gl`, default metal on macOS,
// vulkan elsewhere); otherwise SwiftShader software WebGL, which is correctness evidence only.
const GPU = !!args.gpu;
const ANGLE = GPU ? String(args.angle ?? (platform() === 'darwin' ? 'metal' : 'vulkan')) : 'swiftshader';
const LAUNCH = GPU ? ['--use-angle=' + ANGLE, '--ignore-gpu-blocklist', '--enable-gpu']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: LAUNCH });
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
  if (args['log-depth-fix']) await page.route(/\/\.vite\/deps\/chunk-.*\.js/, async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace('vFragDepth = 1.0 + gl_Position.w;', 'vFragDepth = 1.0 + 1e9 * gl_Position.w;')
      .replace('log2( vFragDepth ) * logDepthBufFC * 0.5', 'log2( vFragDepth ) / log2( 1.0 + 1e9 * ( exp2( 2.0 / logDepthBufFC ) - 1.0 ) )');
    await route.fulfill({ response: res, body });
  });
  if (setup) await setup(page);
  await page.goto(new URL(`?catalog=${catalog}&test=1`, BASE).href, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady === true, null, { timeout: 180_000 });
  if (args.throttle) {
    // --throttle RTT_MS,MBPS: tile traffic over a network instead of localhost, for cold-load
    // timing; applied once the app (thousands of dev-server modules) has loaded.
    const [rtt, mbps] = String(args.throttle).split(',').map(Number);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: rtt, downloadThroughput: mbps * 125_000, uploadThroughput: mbps * 125_000 });
  }
  await page.evaluate(async () => {
    const source = await (await fetch('/src/lib/commands.ts')).text();
    const stateURL = source.match(/from ["']([^"']*viewer-state\.svelte[^"']*)["']/)?.[1];
    window.ci = await import(stateURL ?? '/src/lib/viewer-state.svelte.ts');
    window.ciMoon = () => window.ci.getRenderer().getBodyMesh('Moon');
    window.ciLayer = () => window.ciMoon().terrainManager?.cubeImageryLayer;
  });
  if (/imagery/.test(catalog)) await page.waitForFunction(() => window.ciLayer()?.manifest != null, null, { timeout: 60_000 });
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
    const n = s.metrics.network, i = s.imagery ?? { inFlight: 0, queued: 0, fallbackBlocks: 0, budgetLimited: false, maxDisplayedLevel: -1, blocks: 0 };
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
    const cosInc = Math.abs(n.dot(ray.ray.direction));
    const weight = best.distance ** 2 / Math.max(0.05, cosInc);
    const st = best.object.geometry.userData?.surfaceTriangles;
    return [p.x, p.y, p.z, weight, best.distance, cosInc, typeof st === 'number' && best.faceIndex >= st ? 1 : 0];
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

/**
 * Render FRAMES frames back to back through the viewer's own renderFrame, each
 * fenced by a 1-pixel readPixels (so wall time includes GPU completion, not
 * vsync) and, where EXT_disjoint_timer_query_webgl2 exists, a TIME_ELAPSED
 * query around it (GPU time). Also the draw calls/triangles of one frame.
 */
const frameTiming = (page, frames) => page.evaluate(async (frames) => {
  const r = window.ci.getRenderer(), ctx = r.getContext(), gl = r.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  for (let i = 0; i < 10; i++) { ctx.renderFrame(); sync(); }
  const info = r.renderer.info, auto = info.autoReset;
  info.autoReset = false; info.reset(); ctx.renderFrame(); sync();
  const draws = { calls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length ?? null,
    geometries: info.memory.geometries, textures: info.memory.textures };
  info.autoReset = auto;
  const wall = [], queries = [];
  if (ext) gl.getParameter(ext.GPU_DISJOINT_EXT);
  for (let i = 0; i < frames; i++) {
    const q = ext ? gl.createQuery() : null;
    if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    const t0 = performance.now();
    ctx.renderFrame();
    if (q) gl.endQuery(ext.TIME_ELAPSED_EXT);
    sync();
    wall.push(performance.now() - t0);
    if (q) queries.push(q);
  }
  const gpu = [];
  for (let tries = 0; tries < 100 && queries.length; tries++) {
    await new Promise(requestAnimationFrame);
    while (queries.length && gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)) {
      gpu.push(gl.getQueryParameter(queries[0], gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(queries.shift());
    }
  }
  const disjoint = ext ? gl.getParameter(ext.GPU_DISJOINT_EXT) : null;
  const stat = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b);
    return { n: s.length, median: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)], max: s.at(-1), mean: s.reduce((a, b) => a + b, 0) / s.length }; };
  return { wallMs: stat(wall), gpuMs: disjoint ? null : stat(gpu), gpuDisjoint: disjoint, draws };
}, frames);

/** A SURFACE_VIEWS pose in body-fixed km, heights from the CPU grids (waits for the finest grid at each point). */
async function surfacePose(page, v) {
  const h = await page.evaluate(async (pts) => {
    const bm = window.ciMoon(), out = [];
    for (const [lat, lon] of pts) {
      let s = null;
      for (let i = 0; i < 200; i++) {
        s = bm.sampleTerrain(lat, lon);
        if (s && bm.terrainCubeCoverage(lat, lon)?.state === 'finest') break;
        await new Promise(r => setTimeout(r, 50));
      }
      out.push(s?.elevationKm ?? 0);
    }
    return out;
  }, [v.eye, v.target]);
  return { eye: at(v.eye[0], v.eye[1], h[0] + v.eye[2]), target: at(v.target[0], v.target[1], h[1] + v.target[2]), fov: v.fov };
}

/**
 * Geometric holes in the rendered terrain, free of shading: the visible terrain
 * only, unlit white on black, rendered twice in one task (no tile update between):
 * `mitigated` as displayed (skirts, imagery blocks), `unmitigated` the same tiles'
 * original meshes drawing only their surface triangles. A black pixel not
 * 4-connected to the image border is a hole. Masks are bottom-up, 1 byte per pixel.
 */
const holeMasks = (page, { masks = false } = {}) => page.evaluate(async (masks) => {
  const r = window.ci.getRenderer(), tm = window.ciMoon().terrainManager;
  const depUrl = performance.getEntriesByType('resource').map(e => e.name).find(n => /\/\.vite\/deps\/three\.js(\?|$)/.test(n));
  const { MeshBasicMaterial, Color } = await import(depUrl);
  const gl = r.renderer, cam = r.camera, scene = r.scene, LAYER = 31;
  const originals = [], blocks = [];
  tm.tiles.visibleTiles.forEach(t => t.engineData?.scene?.traverse(o => { if (o.isMesh) (o.name.startsWith('cube-imagery-block') ? blocks : originals).push(o); }));
  const saved = { mask: cam.layers.mask, override: scene.overrideMaterial, background: scene.background, clear: gl.getClearColor(new Color()), alpha: gl.getClearAlpha(), target: gl.getRenderTarget() };
  scene.overrideMaterial = new MeshBasicMaterial({ color: 0xffffff });
  scene.background = null;
  gl.setRenderTarget(null); gl.setClearColor(0x000000, 1);
  cam.layers.set(LAYER);
  const ctx = gl.getContext(), w = ctx.drawingBufferWidth, h = ctx.drawingBufferHeight;
  const pass = () => {
    gl.clear(); gl.render(scene, cam);
    const px = new Uint8Array(w * h * 4);
    ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
    const m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) m[i] = px[4 * i] > 127 ? 1 : 0;
    return m;
  };
  const visibleNow = [...originals, ...blocks].filter(o => o.visible && o.parent?.visible !== false);
  for (const o of visibleNow) o.layers.enable(LAYER);
  const mitigated = pass();
  for (const o of visibleNow) o.layers.disable(LAYER);
  const restore = originals.map(o => ({ o, visible: o.visible, range: { ...o.geometry.drawRange } }));
  for (const o of originals) {
    const n = o.geometry.userData?.surfaceTriangles;
    o.visible = true; o.layers.enable(LAYER);
    if (typeof n === 'number') o.geometry.setDrawRange(0, 3 * n);
  }
  const unmitigated = pass();
  for (const { o, visible, range } of restore) { o.visible = visible; o.layers.disable(LAYER); o.geometry.setDrawRange(range.start, range.count); }
  cam.layers.mask = saved.mask; scene.overrideMaterial = saved.override; scene.background = saved.background;
  gl.setClearColor(saved.clear, saved.alpha); gl.setRenderTarget(saved.target);
  const holes = (m) => {
    // Flood the background from the border; black pixels left over are holes.
    const seen = new Uint8Array(w * h), stack = [];
    const push = (i) => { if (!m[i] && !seen[i]) { seen[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
    }
    let pixels = 0, components = 0;
    const comp = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (m[i] || seen[i]) continue;
      pixels++;
      if (comp[i]) continue;
      components++;
      const st = [i]; comp[i] = 1;
      while (st.length) {
        const j = st.pop(), x = j % w, y = (j / w) | 0;
        for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) if (k >= 0 && !m[k] && !seen[k] && !comp[k]) { comp[k] = 1; st.push(k); }
      }
    }
    // Hole mask: 1 where a hole is.
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = !m[i] && !seen[i] ? 1 : 0;
    let terrain = 0; for (let i = 0; i < w * h; i++) terrain += m[i];
    return { pixels, components, terrainPixels: terrain, out };
  };
  const a = holes(mitigated), b = holes(unmitigated);
  const enc = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  // Pixels whose coverage differs between the passes: where skirts show (or, if any, where they hide surface).
  let skirtVisible = 0; for (let i = 0; i < w * h; i++) skirtVisible += mitigated[i] !== unmitigated[i] ? 1 : 0;
  return { width: w, height: h, visibleMeshes: visibleNow.length, blocks: visibleNow.filter(o => o.name.startsWith('cube-imagery-block')).length,
    mitigated: { holePixels: a.pixels, holeComponents: a.components, terrainPixels: a.terrainPixels },
    unmitigated: { holePixels: b.pixels, holeComponents: b.components, terrainPixels: b.terrainPixels },
    coverageDifferencePixels: skirtVisible,
    ...(masks ? { mitigatedHoles: enc(a.out), unmitigatedHoles: enc(b.out) } : {}) };
}, masks);

/**
 * Skirts drawn where the surface is nearer: the visible tiles' original meshes with
 * surface triangles white and skirts red, then exact ray-casts (pickSurface) on a
 * sample of the red pixels. A red pixel whose nearest hit is a surface triangle is
 * a skirt winning the depth test it should lose; the coverage masks above cannot
 * see it, since the surface is there either way.
 */
const skirtBleed = (page, samples = 400) => page.evaluate(async (samples) => {
  const r = window.ci.getRenderer(), tm = window.ciMoon().terrainManager;
  const depUrl = performance.getEntriesByType('resource').map(e => e.name).find(n => /\/\.vite\/deps\/three\.js(\?|$)/.test(n));
  const { MeshBasicMaterial, Color } = await import(depUrl);
  const gl = r.renderer, cam = r.camera, scene = r.scene, LAYER = 31;
  const meshes = [];
  tm.tiles.visibleTiles.forEach(t => t.engineData?.scene?.traverse(o => { if (o.isMesh && !o.name.startsWith('cube-imagery-block') && typeof o.geometry.userData?.surfaceTriangles === 'number') meshes.push(o); }));
  const materials = [new MeshBasicMaterial({ color: 0xffffff }), new MeshBasicMaterial({ color: 0xff0000 })];
  const saved = { mask: cam.layers.mask, background: scene.background, clear: gl.getClearColor(new Color()), alpha: gl.getClearAlpha(), target: gl.getRenderTarget() };
  const restore = meshes.map(o => ({ o, visible: o.visible, material: o.material }));
  for (const o of meshes) {
    const n = 3 * o.geometry.userData.surfaceTriangles;
    o.geometry.clearGroups(); o.geometry.addGroup(0, n, 0); o.geometry.addGroup(n, Infinity, 1);
    o.material = materials; o.visible = true; o.layers.enable(LAYER);
  }
  scene.background = null; gl.setRenderTarget(null); gl.setClearColor(0x000000, 1); cam.layers.set(LAYER);
  gl.clear(); gl.render(scene, cam);
  const ctx = gl.getContext(), w = ctx.drawingBufferWidth, h = ctx.drawingBufferHeight, px = new Uint8Array(w * h * 4);
  ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
  for (const { o, visible, material } of restore) { o.geometry.clearGroups(); o.material = material; o.visible = visible; o.layers.disable(LAYER); }
  cam.layers.mask = saved.mask; scene.background = saved.background; gl.setClearColor(saved.clear, saved.alpha); gl.setRenderTarget(saved.target);
  const red = [];
  for (let i = 0; i < w * h; i++) if (px[4 * i] > 127 && px[4 * i + 1] < 128) red.push(i);
  const step = Math.max(1, Math.floor(red.length / samples));
  let checked = 0, behindSurface = 0;
  for (let k = 0; k < red.length; k += step) {
    const x = red[k] % w, yUp = (red[k] / w) | 0;
    const p = r.pickSurface((x + 0.5) / w * 2 - 1, (yUp + 0.5) / h * 2 - 1);
    if (!p) continue;
    checked++;
    if (!p.renderedSkirt) behindSurface++;
  }
  // Estimated pixels where a skirt shows through nearer surface.
  return { skirtPixels: red.length, checked, behindSurface, bleedPixels: checked ? Math.round(red.length * behindSurface / checked) : 0 };
}, samples);

/**
 * Level differences between visible geometry tiles that share an edge, sampled
 * at 16 points just outside each edge (CubeSphere addressing, so across faces
 * and corners too): what edge stitching would have to handle.
 */
function neighbourLevels(visibleUris) {
  const vis = new Set(), tiles = [];
  for (const uri of visibleUris) {
    const m = /(px|nx|py|ny|pz|nz)\/(\d+)\/(\d+)\/(\d+)\.glb/.exec(uri);
    if (!m) continue;
    const t = { face: m[1], level: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
    vis.add(`${t.face}/${t.level}/${t.x}/${t.y}`); tiles.push(t);
  }
  const BASES = { px: [[1, 0, 0], [0, 0, -1], [0, 1, 0]], nx: [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], py: [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    ny: [[0, -1, 0], [1, 0, 0], [0, 0, 1]], pz: [[0, 0, 1], [1, 0, 0], [0, 1, 0]], nz: [[0, 0, -1], [-1, 0, 0], [0, 1, 0]] };
  const hist = {}, crossFace = {};
  let maxDelta = 0, uncovered = 0;
  for (const t of tiles) {
    const N = 2 ** t.level, [n, a, b] = BASES[t.face];
    for (let e = 0; e < 4; e++) for (let k = 0; k < 16; k++) {
      const f = (k + 0.5) / 16, eps = 1e-9;
      const u = e === 0 ? -1 + 2 * (t.x + f) / N : e === 1 ? -1 + 2 * (t.x + 1) / N + eps : e === 2 ? -1 + 2 * (t.x + f) / N : -1 + 2 * t.x / N - eps;
      const v = e === 0 ? -1 + 2 * t.y / N - eps : e === 1 ? -1 + 2 * (t.y + f) / N : e === 2 ? -1 + 2 * (t.y + 1) / N + eps : -1 + 2 * (t.y + f) / N;
      const d = [0, 1, 2].map(i => n[i] + u * a[i] + v * b[i]);
      const c = directionToCubeFace(d);
      let found = null;
      for (let L = 30; L >= 0 && !found; L--) {
        const M = 2 ** L, x = Math.min(M - 1, Math.floor((c.u + 1) / 2 * M)), y = Math.min(M - 1, Math.floor((c.v + 1) / 2 * M));
        if (vis.has(`${c.face}/${L}/${x}/${y}`)) found = { level: L, face: c.face };
      }
      if (!found) { uncovered++; continue; }
      const delta = t.level - found.level;
      if (delta <= 0) continue; // count each pair once, from its finer side
      hist[delta] = (hist[delta] ?? 0) + 1;
      if (found.face !== t.face) crossFace[delta] = (crossFace[delta] ?? 0) + 1;
      maxDelta = Math.max(maxDelta, delta);
    }
  }
  return { samplesByDelta: hist, crossFaceSamplesByDelta: crossFace, maxDelta, samplesWithoutNeighbour: uncovered };
}

/** Draws and triangles of one frame. */
const drawInfo = (page) => page.evaluate(() => {
  const r = window.ci.getRenderer(), ctx = r.getContext(), info = r.renderer.info, auto = info.autoReset;
  ctx.renderFrame();
  info.autoReset = false; info.reset(); ctx.renderFrame();
  const out = { calls: info.render.calls, triangles: info.render.triangles };
  info.autoReset = auto;
  return out;
});
const setSkirts = (page, on) => page.evaluate((on) => window.ciMoon().terrainManager.setCubeSkirts(on), on);

/** Hole overlays: a frame with its hole mask painted magenta (masks are bottom-up). */
async function overlay(page, maskB64, width, height) {
  const png = Buffer.from((await page.evaluate(() => window.__cosmolabe.capture())).split(',')[1], 'base64');
  const { data, info } = await sharp(png).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  const mask = Buffer.from(maskB64, 'base64');
  const sx = info.width / width, sy = info.height / height;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const mx = Math.min(width - 1, Math.floor(x / sx)), my = height - 1 - Math.min(height - 1, Math.floor(y / sy));
    if (mask[my * width + mx]) { const i = (y * info.width + x) * 4; data[i] = 255; data[i + 1] = 0; data[i + 2] = 255; }
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).jpeg({ quality: 88 }).toBuffer();
}
/** The 160×100 px window holding the most hole pixels (top-down image coordinates), or null. */
function densestWindow(maskB64, width, height, w = 160, h = 100) {
  const m = Buffer.from(maskB64, 'base64');
  let best = null, bestN = 0;
  for (let y0 = 0; y0 + h <= height; y0 += 20) for (let x0 = 0; x0 + w <= width; x0 += 20) {
    let n = 0;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) n += m[(height - 1 - y) * width + x];
    if (n > bestN) { bestN = n; best = { left: x0, top: y0, width: w, height: h }; }
  }
  return best;
}
/** Frames side by side; with a window, a 4× nearest-neighbour inset of it from each frame underneath. */
async function montage(buffers, name, window = null) {
  const metas = await Promise.all(buffers.map(b => sharp(b).metadata()));
  const W = metas.reduce((s, m) => s + m.width, 0), H = Math.max(...metas.map(m => m.height));
  let x = 0;
  const parts = buffers.map((b, i) => { const p = { input: b, left: x, top: 0 }; x += metas[i].width; return p; });
  let total = H;
  if (window) {
    const insets = await Promise.all(buffers.map(b => sharp(b).extract(window).resize(window.width * 4, window.height * 4, { kernel: 'nearest' }).toBuffer()));
    insets.forEach((b, i) => parts.push({ input: b, left: i * metas[0].width + Math.max(0, (metas[0].width - window.width * 4) / 2), top: H }));
    total = H + window.height * 4;
  }
  await sharp({ create: { width: W, height: total, channels: 3, background: '#000' } }).composite(parts).jpeg({ quality: 85 }).toFile(join(OUT, `${name}.jpg`));
  return `${name}.jpg`;
}

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
      const errs = [], metres = [], faceMismatch = [], samples = [];
      let skipped = 0, tileMismatch = 0;
      /** Decoded vs expected texel at a pixel, or why it is not measured. */
      const decode = (x, y, hit) => {
        if (!hit) return { skip: 'sky' };
        const [R8, G8, B8] = img.at(x, y);
        // Exclude texels whose filtering reaches a tile edge (clamped ramps, mixed B).
        const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => img.at(x + dx, y + dy));
        if (R8 <= 1 || R8 >= 254 || G8 <= 1 || G8 >= 254 || neighbours.some(n => n[2] !== B8)) return { skip: 'edge' };
        const face = faces[B8 >> 5], level = B8 & 31;
        const c = directionToCubeFace(hit);
        if (c.face !== face) return { skip: 'face', face, expectedFace: c.face };
        const n = 2 ** level;
        const fu = (c.u + 1) / 2 * n, fv = (c.v + 1) / 2 * n;
        const ex = (fu - Math.floor(fu)) * 256 - 0.5, ey = (fv - Math.floor(fv)) * 256 - 0.5;
        const dx = R8 - ex, dy = G8 - ey;
        if (Math.abs(dx) > 128 || Math.abs(dy) > 128) return { skip: 'tile' };
        return { e: Math.hypot(dx, dy), dx, dy, R8, G8, B8, face, level, c, fu, fv, ex, ey };
      };
      grid.forEach(([x, y], i) => {
        const hit = hits[i];
        const r = decode(x, y, hit);
        if (r.skip === 'sky' || r.skip === 'edge') { skipped++; return; }
        if (r.skip === 'face') { faceMismatch.push({ x, y, decoded: r.face, expected: r.expectedFace }); return; }
        if (r.skip === 'tile') { tileMismatch++; return; }
        const { R8, G8, B8, face, level, c, fu, fv, ex, ey } = r;
        const e = r.e;
        errs.push(e);
        samples.push({ x, y, errorTexels: e, face, level, tile: [Math.floor(fu), Math.floor(fv)], decoded: [R8, G8, B8], expected: [ex, ey],
          neighbourhood: [-1, 0, 1].flatMap(oy => [-1, 0, 1].map(ox => img.at(x + ox, y + oy).slice(0, 3))),
          distanceKm: hit[4], cosIncidence: hit[5], onSkirt: !!hit[6] });
        metres.push(e * texelGroundSizeKm(level, c.u, c.v, R, 256) * 1000);
      });
      // The worst samples, with what tells measurement, filtering, rasterization and mapping apart:
      // depth discontinuity (ray-cast distance of the four neighbours), incidence, skirt, 3×3 texels.
      samples.sort((a, b) => b.errorTexels - a.errorTexels);
      const worst = samples.slice(0, Number(args['worst-samples'] ?? 5));
      if (worst.length) {
        const around = await rayCast(page, worst.flatMap(w => [[w.x + 1, w.y], [w.x - 1, w.y], [w.x, w.y + 1], [w.x, w.y - 1]]));
        worst.forEach((w, i) => {
          const d = around.slice(4 * i, 4 * i + 4).map(h => h?.[4] ?? null);
          w.neighbourDistanceKm = d;
          w.maxNeighbourDistanceRatio = Math.max(...d.map(v => (v == null ? Infinity : Math.max(v / w.distanceKm, w.distanceKm / v))));
        });
        // A 9×9 error map around the worst pixel: one isolated pixel (silhouette, rasterization)
        // or a local offset (mapping, filtering) look different.
        const w = worst[0], cells = [];
        for (let oy = -4; oy <= 4; oy++) for (let ox = -4; ox <= 4; ox++) cells.push([w.x + ox, w.y + oy]);
        const local = await rayCast(page, cells);
        w.localErrorTexels = cells.map(([x, y], i) => { const r = decode(x, y, local[i]); return r.e != null ? Number(r.e.toFixed(2)) : r.skip; });
        w.localDistanceKm = local.map(h => (h ? Number(h[4].toFixed(4)) : null));
      }
      const file = await shot(page, `registration-${name}-unlit`);
      const row = { view: name, file, samples: grid.length, measured: errs.length, skippedNearTileEdgesOrSky: skipped, faceMismatch: faceMismatch.length,
        tileMismatch, worstSamples: worst, errorTexels: summary(errs), errorMetres: summary(metres), displayedLevels: s.imagery.displayedLevels, faceMismatches: faceMismatch.slice(0, 10), errors };
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

  // ---------------------------------------------------------------------------
  if (EXPERIMENTS.includes('frametime')) {
    // Same pose, three states, warm: terrain only (cube catalog without imagery), imagery with
    // no split tiles (capped at level 0: one draw per tile), imagery refined (blocks).
    results.frametime = [];
    for (const name of views(['shackleton', 'pole', 'antimeridian-60s', 'face-edge', 'face-corner', 'overview'])) {
      const row = { view: name };
      {
        const { page, errors } = await openViewer('test-catalogs/experiments/moon-terrain-cube');
        await settle(page, VIEWS[name], 'shaded', { imagery: false });
        row.terrainOnly = { ...(await frameTiming(page, FRAMES)), errors };
        await page.close();
      }
      const { page, errors } = await openViewer(CATALOG(args.catalog ?? 'grid'));
      await page.evaluate(() => window.ciLayer().setOptions({ maxLevel: 0 }));
      let s = await settle(page, VIEWS[name], 'shaded');
      row.imageryWhole = { ...(await frameTiming(page, FRAMES)), blocks: s.imagery.blocks, splitTiles: s.imagery.splitTiles, maxLevel: s.imagery.maxDisplayedLevel };
      await page.evaluate(() => window.ciLayer().setOptions({ maxLevel: undefined }));
      s = await settle(page, VIEWS[name], 'shaded');
      row.imageryRefined = { ...(await frameTiming(page, FRAMES)), blocks: s.imagery.blocks, splitTiles: s.imagery.splitTiles, extraDraws: s.imagery.extraDraws,
        blockGeometryMB: s.imagery.blockGeometryBytes / 1e6, textures: s.imagery.textures, textureMiB: s.imagery.textureBytes / 2 ** 20, maxLevel: s.imagery.maxDisplayedLevel,
        layerUpdateMs: s.imagery.updateMs, visibleTiles: s.visibleTiles.length };
      row.errors = errors;
      results.frametime.push(row);
      const f = (x) => x ? `${x.median.toFixed(2)}/${x.p95.toFixed(2)}` : 'n/a';
      console.log(`frametime ${name}: wall median/p95 ms terrain ${f(row.terrainOnly.wallMs)}, whole ${f(row.imageryWhole.wallMs)}, refined ${f(row.imageryRefined.wallMs)}; `
        + `GPU ${f(row.terrainOnly.gpuMs)} / ${f(row.imageryWhole.gpuMs)} / ${f(row.imageryRefined.gpuMs)}; draws ${row.terrainOnly.draws.calls}/${row.imageryWhole.draws.calls}/${row.imageryRefined.draws.calls}; L${row.imageryRefined.maxLevel}`);
      await page.close();
    }
  }
  // ---------------------------------------------------------------------------
  if (EXPERIMENTS.includes('cracks')) {
    results.cracks = [];
    const catalogs = String(args.catalogs ?? 'terrain,grid,nac').split(',');
    const VIEWS_BY = {
      terrain: ['shackleton', 'pole', 'face-edge', 'face-corner', ...Object.keys(SURFACE_VIEWS)],
      grid: ['shackleton', 'pole', 'face-edge', 'face-corner', ...Object.keys(SURFACE_VIEWS)],
      nac: ['shackleton', 'pole', 'shackleton-grazing', 'shackleton-near', 'pole-grazing', 'pole-low', 'rim-low'],
    };
    for (const cat of catalogs) {
      for (const name of views(VIEWS_BY[cat])) {
        const { page, errors } = await openViewer(cat === 'terrain' ? 'test-catalogs/experiments/moon-terrain-cube' : CATALOG(cat));
        const view = SURFACE_VIEWS[name] ? await surfacePose(page, SURFACE_VIEWS[name]) : VIEWS[name];
        const s = await settle(page, view, 'shaded', { imagery: cat !== 'terrain' });
        const h = await holeMasks(page, { masks: true });
        const bleed = await skirtBleed(page);
        const nb = neighbourLevels(s.visibleTiles);
        // Picks on unmitigated hole pixels (skirts drawn): what a click in that spot returns.
        const holePx = [];
        const mask = Buffer.from(h.unmitigatedHoles, 'base64');
        for (let i = 0, step = Math.max(1, Math.floor(h.unmitigated.holePixels / 24)), seen = 0; i < mask.length && holePx.length < 24; i++) {
          if (mask[i] && seen++ % step === 0) holePx.push([i % h.width, i / h.width | 0]);
        }
        // Baseline: the nearest non-hole pixel 3 px away from each — the same LOD state, no crack.
        const near = holePx.map(([x, y]) => [[x + 3, y], [x - 3, y], [x, y + 3], [x, y - 3]].find(([a, b]) => a >= 0 && b >= 0 && a < h.width && b < h.height && !mask[b * h.width + a]) ?? [x, y]);
        const doPicks = (pts) => page.evaluate((px) => px.map(([x, yUp]) => {
          const r = window.ci.getRenderer(), c = r.renderer.getContext();
          const p = r.pickSurface((x + 0.5) / c.drawingBufferWidth * 2 - 1, (yUp + 0.5) / c.drawingBufferHeight * 2 - 1);
          return p && { renderedSkirt: !!p.renderedSkirt, physical: p.physical?.kind ?? null, renderedOffsetM: p.physical?.renderedOffsetKm != null ? p.physical.renderedOffsetKm * 1000 : null };
        }), pts);
        const picks = await doPicks(holePx), nearPicks = await doPicks(near);
        const on = await drawInfo(page);
        // Frames unlit (some poses are in lunar night): tile level, or raw imagery texels.
        const frameMode = cat === 'terrain' ? 'cube-face' : 'imagery-unlit';
        await pose(page, view, frameMode); await page.waitForTimeout(800);
        const files = { mitigated: await overlay(page, h.mitigatedHoles, h.width, h.height) };
        await setSkirts(page, false);
        const off = await settle(page, view, 'shaded', { imagery: cat !== 'terrain' });
        const offDraws = await drawInfo(page);
        await pose(page, view, frameMode); await page.waitForTimeout(800);
        files.unmitigated = await overlay(page, h.unmitigatedHoles, h.width, h.height);
        const file = await montage([files.unmitigated, files.mitigated], `cracks-${cat}-${name}`, densestWindow(h.unmitigatedHoles, h.width, h.height));
        await setSkirts(page, true);
        const row = { catalog: cat, view: name, pose: view, file, settled: s.finished, settleMs: s.settleMs, visibleTiles: s.visibleTiles.length, geometryLevels: s.geometryLevels,
          sameTilesSkirtsOff: JSON.stringify(off.visibleTiles) === JSON.stringify(s.visibleTiles), holes: { mitigated: h.mitigated, unmitigated: h.unmitigated, coverageDifferencePixels: h.coverageDifferencePixels }, skirtBleed: bleed,
          neighbours: nb, picksOnHoles: { n: picks.length, onSkirt: picks.filter(p => p?.renderedSkirt).length, physicalHits: picks.filter(p => p?.physical === 'hit').length,
            renderedOffsetM: summary(picks.filter(p => p?.renderedOffsetM != null).map(p => p.renderedOffsetM)),
            nearbySurfacePixelOffsetM: summary(nearPicks.filter(p => p?.renderedOffsetM != null).map(p => p.renderedOffsetM)) },
          draws: { skirts: on, surfaceOnly: offDraws }, imagery: s.imagery && { maxDisplayedLevel: s.imagery.maxDisplayedLevel, blocks: s.imagery.blocks }, errors };
        results.cracks.push(row);
        console.log(`cracks ${cat} ${name}: ${s.visibleTiles.length} tiles L${Object.keys(s.geometryLevels).join(',')}, neighbour Δ ${JSON.stringify(nb.samplesByDelta)} (cross-face ${JSON.stringify(nb.crossFaceSamplesByDelta)}); `
          + `holes ${h.unmitigated.holePixels} px / ${h.unmitigated.holeComponents} without skirts → ${h.mitigated.holePixels} px / ${h.mitigated.holeComponents} with; `
          + `skirts drawn over nearer surface ≈${bleed.bleedPixels} px (${bleed.behindSurface}/${bleed.checked} sampled of ${bleed.skirtPixels} skirt px); `
          + `picks on holes ${row.picksOnHoles.onSkirt}/${picks.length} on a skirt, rendered−physical ${row.picksOnHoles.renderedOffsetM?.median?.toFixed(2)}/${row.picksOnHoles.renderedOffsetM?.max?.toFixed(2)} m (3 px away ${row.picksOnHoles.nearbySurfacePixelOffsetM?.median?.toFixed(2)}/${row.picksOnHoles.nearbySurfacePixelOffsetM?.max?.toFixed(2)}); triangles ${on.triangles} vs ${offDraws.triangles}`);
        await page.close();
      }
    }
  }

  // ---------------------------------------------------------------------------
  if (EXPERIMENTS.includes('cracks-dynamic')) {
    results.cracksDynamic = [];
    const lerp = (a, b, f) => a.map((c, i) => c + (b[i] - c) * f);
    const path = [];
    // Refine in: from 3,000 km to the Shackleton oblique pose, no waiting for detail.
    const far = { eye: at(-80, 129.78, 3000), target: at(-89.67, 129.78, 0), fov: 60 };
    for (let i = 0; i <= 12; i++) { const f = 1 - (1 - i / 12) ** 3; path.push({ phase: 'refine', view: { eye: lerp(far.eye, VIEWS.shackleton.eye, f), target: lerp(far.target, VIEWS.shackleton.target, f), fov: 60 } }); }
    // Coarsen out to 600 km.
    const out = { eye: at(-84, 129.78, 600), target: at(-89.67, 129.78, 0), fov: 60 };
    for (let i = 1; i <= 8; i++) path.push({ phase: 'coarsen', view: { eye: lerp(VIEWS.shackleton.eye, out.eye, (i / 8) ** 2), target: VIEWS.shackleton.target, fov: 60 } });
    // Pan pole → px/nz edge → px/py/nz corner at 40–60 km.
    for (const [a, b] of [[VIEWS.pole, VIEWS['face-edge']], [VIEWS['face-edge'], VIEWS['face-corner']]]) {
      for (let i = 0; i <= 6; i++) path.push({ phase: 'pan', view: { eye: lerp(a.eye, b.eye, i / 6).map((c, _, e) => c * (R + 50) / Math.hypot(...e)), target: lerp(a.target, b.target, i / 6), fov: 60 } });
    }
    const scenarios = String(args.scenarios ?? 'normal,delayed,failed,evicting').split(',');
    for (const scenario of scenarios) {
      const setup = async (page) => {
        const level = (url) => Number(/\/moon-terrain-cube\/(?:px|nx|py|ny|pz|nz)\/(\d+)\//.exec(url)?.[1] ?? -1);
        if (scenario === 'delayed') await page.route(/\/moon-terrain-cube\/.*\.glb$/, async (route) => { if (level(route.request().url()) >= 6) await new Promise(r => setTimeout(r, 2500)); await route.continue(); });
        if (scenario === 'failed') await page.route(/\/moon-terrain-cube\/.*\.glb$/, (route) => (level(route.request().url()) >= 9 ? route.abort() : route.continue()));
      };
      const { page, errors } = await openViewer(CATALOG('grid'), setup);
      if (scenario === 'evicting') await page.evaluate(() => { const c = window.ciMoon().terrainManager.tiles.lruCache; c.minBytesSize = 24 * 2 ** 20; c.maxBytesSize = 40 * 2 ** 20; });
      const steps = [];
      for (const [i, p] of path.entries()) {
        await pose(page, p.view, 'shaded');
        await page.waitForTimeout(scenario === 'delayed' ? 700 : 400);
        await pose(page, p.view, 'shaded');
        const s = await snapshot(page);
        const h = await holeMasks(page);
        const nb = neighbourLevels(s.visibleTiles);
        const n = s.metrics.network;
        steps.push({ i, phase: p.phase, visibleTiles: s.visibleTiles.length, geometryLevels: s.geometryLevels, loading: n.queued + n.downloading + n.parsing,
          cacheBytes: s.metrics.memory?.cacheBytes, mitigatedHolePixels: h.mitigated.holePixels, unmitigatedHolePixels: h.unmitigated.holePixels,
          coverageDifferencePixels: h.coverageDifferencePixels, maxNeighbourDelta: nb.maxDelta, neighbourSamplesByDelta: nb.samplesByDelta });
      }
      const failedReq = await page.evaluate(() => window.ciMoon().terrainMetrics.network);
      const row = { scenario, steps, maxMitigatedHolePixels: Math.max(...steps.map(s => s.mitigatedHolePixels)), maxUnmitigatedHolePixels: Math.max(...steps.map(s => s.unmitigatedHolePixels)),
        stepsWithUnmitigatedHoles: steps.filter(s => s.unmitigatedHolePixels > 0).length, stepsWithMitigatedHoles: steps.filter(s => s.mitigatedHolePixels > 0).length,
        stepsLoading: steps.filter(s => s.loading > 0).length, maxNeighbourDelta: Math.max(...steps.map(s => s.maxNeighbourDelta)), network: failedReq, errors: errors.slice(0, 10) };
      results.cracksDynamic.push(row);
      console.log(`cracks-dynamic ${scenario}: ${steps.length} steps (${row.stepsLoading} still loading), holes without skirts in ${row.stepsWithUnmitigatedHoles} (max ${row.maxUnmitigatedHolePixels} px), `
        + `with skirts in ${row.stepsWithMitigatedHoles} (max ${row.maxMitigatedHolePixels} px); max neighbour Δlevel ${row.maxNeighbourDelta}`);
      await page.close();
    }
  }

  // ---------------------------------------------------------------------------
  if (EXPERIMENTS.includes('compare')) {
    results.compare = [];
    for (const product of String(args.products ?? 'cube,polar,geographic').split(',')) {
      const P = PRODUCTS[product];
      for (const name of views(Object.keys(COMPARE_VIEWS))) {
        if (product === 'polar' && name === 'face-corner') continue; // outside the cap
        const view = COMPARE_VIEWS[name];
        const { page, errors } = await openViewer(P.catalog);
        const errorTarget = Number(args['error-target'] ?? (args['equal-error-target'] ? 2 : (P.errorTarget ?? 2)));
        await page.evaluate((e) => { window.ciMoon().terrainManager.tiles.errorTarget = e; }, errorTarget);
        // What the catalog's initial view already loaded: reported apart from what the pose costs.
        const atPose = await page.evaluate((data) => { const r = performance.getEntriesByType('resource').filter(e => e.name.includes(data));
          return { requests: r.length, bytes: r.reduce((s, e) => s + (e.encodedBodySize || e.transferSize || 0), 0) }; }, P.data);
        await pose(page, view, 'shaded');
        const t0 = Date.now();
        // Finished detail: nothing queued/downloading/parsing (and no CPU grid in flight), visible set unchanged.
        // 100 ms polls; finished = start of the final 2 s stable streak (local loads finish in seconds).
        let stable = 0, last = '', m = null, streakStart = 0;
        while (Date.now() - t0 < TIMEOUT_MS && stable < 20) {
          await page.waitForTimeout(100);
          await pose(page, view, 'shaded');
          m = await page.evaluate(() => { const bm = window.ciMoon(); return { metrics: bm.terrainMetrics, cube: bm.terrainCubeStats }; });
          const busy = m.metrics.network.queued + m.metrics.network.downloading + m.metrics.network.parsing + (m.cube?.inFlight ?? 0);
          const key = String(m.metrics.tiles.visible);
          const ok = busy === 0 && m.metrics.tiles.visible > 0 && key === last;
          if (ok && stable === 0) streakStart = Date.now();
          stable = ok ? stable + 1 : 0;
          last = key;
        }
        const coldMs = streakStart - t0;
        const detail = await page.evaluate(async (data) => {
          const r = window.ci.getRenderer(), tm = window.ciMoon().terrainManager;
          const depUrl = performance.getEntriesByType('resource').map(e => e.name).find(n => /\/\.vite\/deps\/three\.js(\?|$)/.test(n));
          const { Raycaster, Vector2 } = await import(depUrl);
          const owner = new Map(), levels = {};
          tm.tiles.visibleTiles.forEach(t => {
            const mm = /(?:^|\/)(?:(?:px|nx|py|ny|pz|nz)\/)?(\d+)\/\d+\/\d+\.(?:glb|terrain)/.exec(t.content?.uri ?? '');
            if (!mm) return;
            levels[mm[1]] = (levels[mm[1]] ?? 0) + 1;
            t.engineData?.scene?.traverse(o => { if (o.isMesh) owner.set(o, Number(mm[1])); });
          });
          const ray = new Raycaster(); ray.setFromCamera(new Vector2(0, 0), r.camera);
          const hit = ray.intersectObjects([...owner.keys()], false)[0];
          const res = performance.getEntriesByType('resource').filter(e => e.name.includes(data));
          return { levels, centreLevel: hit ? owner.get(hit.object) : null,
            requests: res.length, bytes: res.reduce((s, e) => s + (e.encodedBodySize || e.transferSize || 0), 0), cpuGridRequests: res.filter(e => e.name.includes('/heights/')).length };
        }, P.data);
        const cover = await holeMasks(page);
        // Achieved detail across the frame, not just under the centre: a 32×20 pixel grid ray-cast
        // onto the rendered meshes (body-fixed metres); `dem.py field-error` scores them against
        // the fused field itself.
        const grid = [];
        for (let j = 0; j < 20; j++) for (let i = 0; i < 32; i++) grid.push([Math.floor((i + 0.5) * VIEWPORT.width / 32), Math.floor((j + 0.5) * VIEWPORT.height / 20)]);
        const surfaceHits = (await rayCast(page, grid)).map(h => (h ? h.slice(0, 3).map(v => Math.round(v * 1000) / 1000) : null));
        const timing = await frameTiming(page, FRAMES);
        const row = { product, view: name, errorTarget, throttle: args.throttle ?? null, finished: stable >= 20, coldToFinishedMs: coldMs, visibleTiles: m.metrics.tiles.visible, levels: detail.levels,
          centreLevel: detail.centreLevel, centreVertexSpacingM: detail.centreLevel == null ? null : P.spacingM(detail.centreLevel),
          requests: detail.requests, bytes: detail.bytes, sincePose: { requests: detail.requests - atPose.requests, bytes: detail.bytes - atPose.bytes }, cpuGridRequests: detail.cpuGridRequests, memory: m.metrics.memory, cubeGrids: m.cube,
          terrainPixelFraction: cover.mitigated.terrainPixels / (cover.width * cover.height), holePixels: cover.mitigated.holePixels, surfaceHits,
          frames: timing, errors };
        results.compare.push(row);
        const f = (x) => x ? `${x.median.toFixed(2)}/${x.p95.toFixed(2)}` : 'n/a';
        console.log(`compare ${product} ${name}: ${row.finished ? '' : 'UNFINISHED '}${(coldMs / 1000).toFixed(1)} s cold, ${detail.requests} req / ${(detail.bytes / 1e6).toFixed(1)} MB, `
          + `${row.visibleTiles} tiles, centre L${detail.centreLevel} (${row.centreVertexSpacingM?.toFixed(1)} m), terrain ${(100 * row.terrainPixelFraction).toFixed(1)}% of frame, `
          + `geometry ${(m.metrics.memory.geometryBytes / 1e6).toFixed(1)} MB; warm wall ${f(timing.wallMs)} GPU ${f(timing.gpuMs)} ms, ${timing.draws.calls} draws / ${timing.draws.triangles} tris`);
        await page.close();
      }
    }
  }

  // ---------------------------------------------------------------------------
  if (EXPERIMENTS.includes('skirt-cost')) {
    results.skirtCost = [];
    for (const cat of ['terrain', 'grid']) {
      for (const name of views(['shackleton', 'pole', 'face-edge', 'face-corner', 'overview', 'shackleton-grazing'])) {
        const { page, errors } = await openViewer(cat === 'terrain' ? 'test-catalogs/experiments/moon-terrain-cube' : CATALOG(cat));
        const view = SURFACE_VIEWS[name] ? await surfacePose(page, SURFACE_VIEWS[name]) : VIEWS[name];
        const s = await settle(page, view, 'shaded', { imagery: cat !== 'terrain' });
        const on = await frameTiming(page, FRAMES);
        await setSkirts(page, false);
        await settle(page, view, 'shaded', { imagery: cat !== 'terrain' });
        const off = await frameTiming(page, FRAMES);
        await setSkirts(page, true);
        await settle(page, view, 'shaded', { imagery: cat !== 'terrain' });
        const on2 = await frameTiming(page, FRAMES);
        const row = { catalog: cat, view: name, visibleTiles: s.visibleTiles.length, skirts: on, surfaceOnly: off, skirtsRepeat: on2, geometryMB: s.metrics.memory?.geometryBytes / 1e6, errors };
        results.skirtCost.push(row);
        const f = (x) => x ? `${x.median.toFixed(2)}/${x.p95.toFixed(2)}` : 'n/a';
        console.log(`skirt-cost ${cat} ${name}: triangles ${off.draws.triangles} → ${on.draws.triangles}; wall ${f(off.wallMs)} → ${f(on.wallMs)} (repeat ${f(on2.wallMs)}); GPU ${f(off.gpuMs)} → ${f(on.gpuMs)} (repeat ${f(on2.gpuMs)})`);
        await page.close();
      }
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
  browser: { ...env, launch: `playwright chromium headless, ${LAUNCH.join(' ')}${GPU ? ' (hardware GPU)' : ' (software WebGL)'}; ?test=1 (no antialias/bloom/stars)` },
  host: { platform: `${platform()} ${release()}`, cpus: cpus().length, cpuModel: cpus()[0]?.model, memoryGB: Math.round(totalmem() / 2 ** 30) },
  results,
};
const file = join(OUT, `imagery-captures-${EXPERIMENTS.join('-')}.json`);
writeFileSync(file, JSON.stringify(record, null, 1) + '\n');
console.log(`wrote ${file}`);
