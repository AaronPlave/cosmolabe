#!/usr/bin/env node
/**
 * Reproducible finished-detail captures of the Moon terrain products (#149):
 * the cube-sphere experiment and, from the same script and camera poses, the
 * polar-cap (#145) and geographic (#48) baselines.
 *
 * Start the viewer first (`npm --prefix apps/viewer run dev`), then e.g.
 *
 *   node scripts/capture-cube-terrain.mjs --product cube
 *   node scripts/capture-cube-terrain.mjs --product polar --views shackleton,pole
 *
 * Each view is an explicit body-fixed camera pose (km, IAU_MOON Z-up) at the
 * catalog epoch with playback paused, so every product is photographed from the
 * same place at the same time with the same errorTarget (2). A capture waits
 * for *finished detail*: no tile queued, downloading or parsing, the visible
 * tile set unchanged for STABLE consecutive polls, and no CPU grid in flight.
 * It records the time that took (cold: each view starts from an empty tile
 * cache unless --warm), requests and bytes from Resource Timing, tile counts,
 * geometry bytes, the finest rendered level and its vertex spacing, and the
 * browser / WebGL renderer / viewport / device-pixel-ratio / host.
 *
 * Modes: `shaded` (sun-lit, the catalog's real lighting) or any TerrainManager
 * debug view, flat and unlit: `lod` (tile depth; a mixed-LOD crack shows as
 * background between colours), `cube-face` (face hue, brighter with depth) and
 * `cpu-coverage` (green where the tile's own CPU grid is resident).
 *
 * Env: CL_VIEWER_URL (default http://127.0.0.1:5173/), CHROMIUM_PATH.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, release } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? true : all[i + 1]]);
  return acc;
}, []));
const PRODUCTS = {
  cube: { catalog: 'test-catalogs/experiments/moon-terrain-cube', data: 'moon-terrain-cube/' },
  polar: { catalog: 'test-catalogs/experiments/moon-terrain-polar', data: 'moon-terrain-polar/' },
  geographic: { catalog: 'test-catalogs/experiments/moon-terrain-geographic', data: 'moon-terrain-fused/' },
};
const productName = args.product ?? 'cube';
const product = args.catalog ? { catalog: args.catalog, data: args.data ?? '' } : PRODUCTS[productName];
const BODY = args.body ?? 'Moon';
if (!product) throw new Error(`--product must be one of ${Object.keys(PRODUCTS)}`);
const BASE = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173/';
const OUT = resolve(args.out ?? join(ROOT, 'work/cube-terrain/captures'));
const VIEWPORT = { width: Number(args.width ?? 1280), height: Number(args.height ?? 800) };
const MODES = String(args.modes ?? 'shaded,lod').split(',');
const STABLE = Number(args.stable ?? 8);
const TIMEOUT_MS = Number(args.timeout ?? 900_000);
const R = Number(args['radius-km'] ?? 1737.4);

/** Body-fixed point at geocentric lat/lon and height above the 1737.4 km sphere (km). */
const at = (latDeg, lonDeg, hKm) => {
  const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180, r = R + hKm;
  return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)];
};
/**
 * Camera poses: eye and look-at target in body-fixed km, up = local radial.
 * Shackleton centre 89.67°S 129.78°E (rim ~10.5 km radius, floor ~4 km deep).
 */
const VIEWS = {
  // Oblique over the rim, across the crater: the finished-detail L12 (13 m) region.
  shackleton: { eye: at(-89.07, 129.78, 6.0), target: at(-89.67, 129.78, -2.5), fov: 60 },
  // Obliquely down onto the pole itself from 12 km (the nz face centre: no seam, no sliver).
  pole: { eye: at(-89.6, -50, 12.0), target: at(-90, 0, 0), fov: 60 },
  // The south polar hemisphere from 3,000 km: faces, refinement and the corner region in one frame.
  overview: { eye: at(-55, 60, 3000), target: at(-70, 60, 0), fov: 50 },
  // The px/py/nz corner (35.26°S 45°E) from 60 km: three faces and mixed-LOD transitions.
  'face-boundary': { eye: at(-34.6, 45.6, 60), target: at(-35.26438968, 45, 0), fov: 60 },
};
if (args['views-file']) Object.assign(VIEWS, JSON.parse(readFileSync(resolve(args['views-file']), 'utf8')));
const viewNames = String(args.views ?? Object.keys(VIEWS).join(',')).split(',');

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-gpu-blocklist'] });
mkdirSync(OUT, { recursive: true });
const results = [];
try {
  for (const viewName of viewNames) {
    const view = VIEWS[viewName];
    if (!view) throw new Error(`unknown view ${viewName}`);
    for (const mode of MODES) {
      // A fresh page per capture: a cold tile cache, so request and time counts are comparable.
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      // The dev server's module graph alone overflows the default 250-entry buffer.
      await page.addInitScript(body => { window.cubeBody = body; performance.setResourceTimingBufferSize(1_000_000); }, BODY);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(new URL(`?catalog=${product.catalog}&test=1`, BASE).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForFunction(() => window.__cosmolabe?.assetsReady === true, null, { timeout: 180_000 });
      await page.evaluate(async () => {
        const source = await (await fetch('/src/lib/commands.ts')).text();
        const stateURL = source.match(/from ["']([^"']*viewer-state\.svelte[^"']*)["']/)?.[1];
        window.cubeCapture = await import(stateURL ?? '/src/lib/viewer-state.svelte.ts');
      });
      const env = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
        return { userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio,
          webglVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl?.getParameter(gl.VENDOR),
          webglRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER),
          hardwareConcurrency: navigator.hardwareConcurrency };
      });
      const start = Date.now();
      // Pose the camera every poll: the app's loop owns the camera, so a pose
      // set once can be overridden by controls before the tiles settle.
      const pose = async () => page.evaluate(({ view, mode }) => {
        const { getRenderer } = window.cubeCapture;
        const r = getRenderer(), bm = r.getBodyMesh(window.cubeBody);
        window.cosmo.setPlaying(false); window.cosmo.untrack();
        r.setTerrainDebugMode(mode === 'shaded' ? 'none' : mode, window.cubeBody);
        const THREE = r.camera.position.constructor;
        const centre = new THREE(); bm.getWorldPosition(centre);
        const toWorld = ([x, y, z]) => new THREE(x, z, -y).applyQuaternion(bm.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
        const eye = toWorld(view.eye), target = toWorld(view.target);
        const up = eye.clone().sub(centre).normalize();
        const c = r.camera, controls = r.cameraController.controls;
        controls.enableDamping = false;
        c.fov = view.fov; c.updateProjectionMatrix();
        c.position.copy(eye); c.up.copy(up); controls.target.copy(target);
        c.lookAt(target); c.updateMatrixWorld(true);
      }, { view, mode });
      await pose();
      let stable = 0, lastVisible = -1, polls = 0, metrics = null, cube = null;
      while (Date.now() - start < TIMEOUT_MS) {
        await page.waitForTimeout(500);
        await pose();
        ({ metrics, cube } = await page.evaluate(() => {
          const bm = window.cubeCapture.getRenderer().getBodyMesh(window.cubeBody);
          return { metrics: bm.terrainMetrics, cube: bm.terrainCubeStats };
        }));
        polls++;
        const busy = metrics.network.queued + metrics.network.downloading + metrics.network.parsing + (cube?.inFlight ?? 0);
        const settled = busy === 0 && metrics.tiles.visible > 0 && metrics.tiles.visible === lastVisible;
        stable = settled ? stable + 1 : 0;
        lastVisible = metrics.tiles.visible;
        if (stable >= STABLE) break;
      }
      const settleMs = Date.now() - start;
      const finished = stable >= STABLE;
      const detail = await page.evaluate((data) => {
        const r = window.cubeCapture.getRenderer(), tiles = r.getBodyMesh(window.cubeBody).terrainManager?.tiles ?? null;
        const levels = {};
        let finest = -1;
        tiles?.visibleTiles?.forEach((tile) => {
          const uri = tile.content?.uri ?? '';
          const m = uri.match(/(?:^|\/)(?:(px|nx|py|ny|pz|nz)\/)?(\d+)\/\d+\/\d+\.(glb|terrain)/);
          if (!m) return;
          const level = Number(m[2]);
          levels[level] = (levels[level] ?? 0) + 1;
          finest = Math.max(finest, level);
        });
        const resources = performance.getEntriesByType('resource').filter(e => e.name.includes(data));
        return { levels, finest,
          requests: resources.length,
          bytes: resources.reduce((s, e) => s + (e.encodedBodySize || e.transferSize || 0), 0),
          cpuGridRequests: resources.filter(e => e.name.includes('/heights/')).length };
      }, product.data);
      // Ground vertex spacing of the finest visible level, per product's tiling.
      const spacingM = detail.finest < 0 ? null
        : productName === 'cube' ? 2 * R * 1000 / (64 * 2 ** detail.finest)
        : productName === 'polar' ? 200_000 / 2 ** detail.finest / 64
        : Math.PI * R * 1000 / 2 ** detail.finest / 64;
      // The CPU readout at the look-at point: the query itself requests the
      // finest grid there, independently of what the renderer drew. Record the
      // first answer, then wait (bounded) for the finest level and record again.
      const readout = () => page.evaluate(({ target }) => {
        const bm = window.cubeCapture.getRenderer().getBodyMesh(window.cubeBody);
        const [x, y, z] = target, r = Math.hypot(x, y, z);
        const geo = bm.terrainBodyFixedToGeodetic({ xKm: x, yKm: y, zKm: z });
        const lat = geo?.latDeg ?? Math.asin(z / r) * 180 / Math.PI, lon = geo?.lonDeg ?? Math.atan2(y, x) * 180 / Math.PI;
        const s = bm.sampleTerrain(lat, lon);
        return { latDeg: lat, lonDeg: lon, elevationKm: s?.elevationKm ?? null, tileId: s?.tileId ?? null,
          source: s?.source?.version ?? s?.source?.id ?? null, coverage: bm.terrainCubeCoverage(lat, lon) };
      }, { target: view.target });
      const firstReadout = await readout();
      let sample = firstReadout;
      for (let i = 0; i < 40 && sample.coverage && sample.coverage.state !== 'finest'; i++) {
        await page.waitForTimeout(250);
        sample = await readout();
      }
      // The viewer's own pick at the screen centre: the rendered hit plus, for
      // the cube product, the same ray answered by CPU grids through #148.
      // A pick answers from resident grids and starts loading the finer ones
      // along its ray; a repeat pick once they arrive is what a user re-clicking sees.
      const pickOnce = () => page.evaluate(() => {
        const r = window.cubeCapture.getRenderer(), p = r.pickSurface(0, 0);
        return p && { latDeg: p.latDeg, lonDeg: p.lonDeg, altKm: p.altKm, cameraDistanceKm: p.cameraDistanceKm, physical: p.physical ?? null };
      });
      const firstPick = await pickOnce();
      for (let i = 0; i < 40 && firstPick?.physical; i++) {
        await page.waitForTimeout(250);
        if ((await page.evaluate(() => window.cubeCapture.getRenderer().getBodyMesh(window.cubeBody).terrainCubeStats?.inFlight)) === 0) break;
      }
      const pick = firstPick?.physical ? await pickOnce() : firstPick;
      const file = `${productName}-${viewName}-${mode}.jpg`;
      await page.screenshot({ path: join(OUT, file), type: 'jpeg', quality: 88 });
      const row = { product: productName, view: viewName, mode, file, finished, settleMs, polls,
        pose: { frame: `${args.frame ?? 'IAU_MOON'} body-fixed, km, Z-up`, ...view, epoch: 'catalog defaultTime, paused' },
        errorTarget: 2, finestVisibleLevel: detail.finest, finestVertexSpacingM: spacingM, visibleByLevel: detail.levels,
        requests: detail.requests, bytes: detail.bytes, cpuGridRequests: detail.cpuGridRequests,
        tiles: metrics.tiles, network: metrics.network, memory: metrics.memory, update: metrics.update, parse: metrics.parse,
        cpuReadoutAtTarget: { first: firstReadout, settled: sample }, centrePick: { first: firstPick, afterRayCoverage: pick }, cubeGrids: cube, errors };
      results.push({ ...row, env });
      console.log(`${file}: ${finished ? 'finished' : 'TIMED OUT'} in ${(settleMs / 1000).toFixed(0)} s, finest L${detail.finest} `
        + `(${spacingM?.toFixed(1)} m), ${detail.requests} requests / ${(detail.bytes / 1e6).toFixed(1)} MB, `
        + `${metrics.tiles.visible} visible, CPU ${sample.tileId ?? 'none'} ${sample.coverage?.state ?? ''}`
        + (pick?.physical ? `, centre pick CPU ${pick.physical.kind} ${pick.physical.tileId ?? pick.physical.reason ?? ''} ${pick.physical.renderedOffsetKm != null ? (pick.physical.renderedOffsetKm * 1000).toFixed(2) + ' m from rendered' : ''}` : ''));
      await page.close();
    }
  }
} finally {
  await browser.close();
}
const env = results[0]?.env ?? {};
const record = {
  generator: 'scripts/capture-cube-terrain.mjs',
  created: new Date().toISOString(),
  product: productName, catalog: product.catalog, viewport: VIEWPORT,
  browser: { userAgent: env.userAgent, webglVendor: env.webglVendor, webglRenderer: env.webglRenderer,
    devicePixelRatio: env.devicePixelRatio, launch: 'playwright chromium headless, --use-angle=swiftshader (software WebGL; no GPU in this host)' },
  host: { platform: `${platform()} ${release()}`, cpus: cpus().length, cpuModel: cpus()[0]?.model, memoryGB: Math.round(totalmem() / 2 ** 30) },
  stableCriterion: `queued+downloading+parsing+CPU grids in flight = 0 and visible tile count unchanged for ${STABLE} polls of 500 ms`,
  captures: results.map(({ env: _env, ...rest }) => rest),
};
writeFileSync(join(OUT, `${productName}-captures.json`), JSON.stringify(record, null, 2) + '\n');
console.log(`wrote ${join(OUT, `${productName}-captures.json`)}`);
