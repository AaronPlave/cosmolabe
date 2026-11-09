#!/usr/bin/env node
/**
 * Before/after captures and cost of terrain-cast solar shadows (#205) on the real Moon cube-sphere terrain.
 *
 * Start the viewer first (`npm --prefix apps/viewer run dev -- --port 5290 --host 127.0.0.1`), then
 *
 *   node scripts/capture-terrain-solar-shadow.mjs --viewer http://127.0.0.1:5290/ --out docs/validation/terrain-solar-shadow
 *
 * The catalog is `experiments/moon-terrain-cube-solar-shadow` (the #149 fused LOLA cube terrain with
 * `terrain.solarShadows: true`). Every view is an explicit body-fixed pose (km, Z-up) at a fixed physical epoch, chosen
 * by scanning the simulation clock for the Sun elevation wanted at the view's target, with playback paused. For each
 * view the same pose and epoch is captured as:
 *
 *   off        terrain-cast shadows disabled: the #204 shading, the "before"
 *   on         shadows enabled: the "after"
 *   flood      lighting mode `flood`: the Sun-less reference (shadows disabled by design)
 *   visibility debug view 1: the per-fragment Sun fraction (white lit, black shadowed)
 *   unknown    debug view 2: the same, with terrain the clipmap does not hold tinted magenta
 *   alignment  debug view 3: rendered surface vs clipmap height (green: within 10 m; magenta: no data)
 *
 * and the clipmap's residency/quality status, the Sun geometry, the CPU time of each clipmap build, and a frame time
 * with shadows on and off. Software WebGL (no GPU in the capture host) and an optional CPU throttle (--throttle 4)
 * are repeatable proxies, not hardware or mobile measurements.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, release } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? true : all[i + 1]]);
  return acc;
}, []));
const BASE = args.viewer ?? process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5290/';
const CATALOG = args.catalog ?? 'test-catalogs/experiments/moon-terrain-cube-solar-shadow';
const OUT = resolve(args.out ?? join(ROOT, 'work/terrain-solar-shadow'));
const VIEWPORT = { width: Number(args.width ?? 1280), height: Number(args.height ?? 720) };
const THROTTLE = Number(args.throttle ?? 1);
const QUALITY = args.quality ?? 'high';
const R = 1737.4;
const at = (latDeg, lonDeg, hKm) => {
  const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180, r = R + hKm;
  return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)];
};
/**
 * `site`: where the Sun elevation is read. `wantElevationDeg`: the epoch scan picks the time (within a lunar day)
 * whose elevation there is closest. A *sunward* view looks toward the Sun, so ridge shadows fall toward the camera.
 */
const VIEWS = {
  'shackleton-rim': { site: [-89.67, 129.78], wantElevationDeg: 1.0, eye: at(-89.07, 129.78, 6.0), target: at(-89.67, 129.78, -2.5), fov: 60 },
  'polar-ridge': { site: [-88.4, 20], wantElevationDeg: 2.5, eye: at(-88.25, 20, 9), target: at(-88.55, 20, 0), fov: 55 },
  'equatorial-crater': { site: [9.62, -20.08], wantElevationDeg: 3.0, eye: at(8.9, -20.1, 45), target: at(9.62, -20.08, -3), fov: 55 },
};
const viewNames = String(args.views ?? Object.keys(VIEWS).join(',')).split(',');
const MODES = String(args.modes ?? 'off,on,flood,visibility,unknown,alignment').split(',');
const SETTLE_POLLS = Number(args.stable ?? 6);
const TIMEOUT_MS = Number(args.timeout ?? 900_000);

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-gpu-blocklist'] });
mkdirSync(OUT, { recursive: true });
const results = [];
let env = {};
try {
  for (const viewName of viewNames) {
    const view = VIEWS[viewName];
    if (!view) throw new Error(`unknown view ${viewName}`);
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    if (THROTTLE > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/GL Driver Message|SPKLEF/.test(m.text())) errors.push(m.text()); });
    await page.goto(new URL(`?catalog=${CATALOG}&test=1`, BASE).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => window.__cosmolabe?.assetsReady === true, null, { timeout: 180_000 });
    await page.evaluate(async () => {
      const source = await (await fetch('/src/lib/commands.ts')).text();
      const stateURL = source.match(/from ["']([^"']*viewer-state\.svelte[^"']*)["']/)?.[1];
      window.cap = await import(stateURL ?? '/src/lib/viewer-state.svelte.ts');
    });
    env = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
      return { userAgent: navigator.userAgent, webglRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER),
        hardwareConcurrency: navigator.hardwareConcurrency };
    });

    // Choose the epoch: the clock time within 30 days of the catalog's whose Sun elevation at the site is closest to the
    // wanted one. Coarse 12 h steps, then 1 h steps around the best; each reading waits for the scene to take the time.
    const epoch = await page.evaluate(async ({ site, want }) => {
      const r = window.cap.getRenderer(), tc = r.timeController;
      window.cap.setPlaying(false);
      const frames = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
      const read = async (et) => {
        tc.setTime(et); await frames();
        const g = r.solarGeometryAt('Moon', site[0], site[1]);
        return g && { d: Math.abs(g.elevationDeg - want), et, elevationDeg: g.elevationDeg, azimuthDeg: g.azimuthDeg };
      };
      const et0 = tc.et;
      let best = null;
      for (let k = 0; k < 60; k++) { const c = await read(et0 + k * 12 * 3600); if (c && (!best || c.d < best.d)) best = c; }
      const centre = best.et;
      for (let k = -12; k <= 12; k++) { const c = await read(centre + k * 3600); if (c && c.d < best.d) best = c; }
      return best;
    }, { site: view.site, want: view.wantElevationDeg });
    console.log(`${viewName}: epoch et=${epoch.et} Sun elevation ${epoch.elevationDeg.toFixed(2)} deg azimuth ${epoch.azimuthDeg.toFixed(1)} at the site`);

    const pose = () => page.evaluate(({ view, et }) => {
      const r = window.cap.getRenderer(), bm = r.getBodyMesh('Moon');
      window.cap.setPlaying(false); window.cosmo.untrack();
      r.timeController.setTime(et);
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
    }, { view, et: epoch.et });
    const applyMode = (mode) => page.evaluate(({ mode, quality }) => {
      const r = window.cap.getRenderer();
      r.setLightingMode(mode === 'flood' ? 'flood' : 'natural');
      r.setTerrainShadows(mode !== 'off' && mode !== 'flood');
      r.setTerrainShadowQuality(quality);
      r.setTerrainShadowDebug(mode === 'visibility' ? 1 : mode === 'unknown' ? 2 : mode === 'alignment' ? 3 : 0);
    }, { mode, quality: QUALITY });
    const state = () => page.evaluate(() => {
      const r = window.cap.getRenderer(), bm = r.getBodyMesh('Moon');
      return { metrics: bm.terrainMetrics, cube: bm.terrainCubeStats, shadow: bm.solarShadowStatus };
    });

    await applyMode('on');
    await pose();
    // Settle: tiles and CPU grids idle, every clipmap level built, and no level rebuilt for SETTLE_POLLS polls.
    const start = Date.now();
    let stable = 0, last = '';
    while (Date.now() - start < TIMEOUT_MS) {
      await page.waitForTimeout(500);
      await pose();
      const { metrics, cube, shadow } = await state();
      const busy = metrics.network.queued + metrics.network.downloading + metrics.network.parsing + (cube?.inFlight ?? 0);
      const key = JSON.stringify([metrics.tiles.visible, shadow?.levels.map(l => [l.builds, l.valid])]);
      const ok = busy === 0 && metrics.tiles.visible > 0 && shadow?.levels.every(l => l.valid) && key === last;
      stable = ok ? stable + 1 : 0;
      last = key;
      if (stable >= SETTLE_POLLS) break;
    }
    const settleMs = Date.now() - start;

    for (const mode of MODES) {
      await applyMode(mode);
      await pose();
      await page.waitForTimeout(1500);
      await pose();
      await page.waitForTimeout(500);
      // Frame time over 40 frames, then the screenshot and the state it shows.
      const frameMs = await page.evaluate(() => new Promise(resolveFrames => {
        const times = [];
        let prev = performance.now(), n = 0;
        const tick = (now) => { times.push(now - prev); prev = now; if (++n < 40) requestAnimationFrame(tick); else resolveFrames(times.slice(5)); };
        requestAnimationFrame(tick);
      }));
      const mean = frameMs.reduce((a, b) => a + b, 0) / frameMs.length;
      const { metrics, shadow } = await state();
      const geometry = await page.evaluate(({ site }) => window.cap.getRenderer().solarGeometryAt('Moon', site[0], site[1]), { site: view.site });
      const file = `${viewName}-${mode}${QUALITY === 'high' ? '' : '-' + QUALITY}${THROTTLE > 1 ? '-throttle' + THROTTLE : ''}.png`;
      await page.screenshot({ path: join(OUT, file), type: 'png' });
      results.push({ view: viewName, mode, file, epochEt: epoch.et, sun: geometry, frameMeanMs: +mean.toFixed(1), frameMaxMs: +Math.max(...frameMs).toFixed(1),
        shadow, tiles: metrics.tiles, pose: { eye: view.eye, target: view.target, fov: view.fov }, settleMs });
      console.log(`${file}: frame ${mean.toFixed(0)} ms (software WebGL), clipmap ${shadow?.state}, `
        + `unknown ${shadow?.levels.map(l => (l.unknownFraction * 100).toFixed(0) + '%').join('/')}, build ${shadow?.levels.map(l => l.lastBuildMs.toFixed(0) + ' ms').join('/')}`);
    }
    results.push({ view: viewName, errors });
    await page.close();
  }
} finally {
  await browser.close();
}
const record = {
  generator: 'scripts/capture-terrain-solar-shadow.mjs', created: new Date().toISOString(), catalog: CATALOG, viewport: VIEWPORT,
  cpuThrottle: THROTTLE, quality: QUALITY,
  browser: { ...env, launch: 'playwright chromium headless, --use-angle=swiftshader (software WebGL; no GPU in this host)' },
  host: { platform: `${platform()} ${release()}`, cpus: cpus().length, cpuModel: cpus()[0]?.model, memoryGB: Math.round(totalmem() / 2 ** 30) },
  captures: results,
};
writeFileSync(join(OUT, `captures${QUALITY === 'high' ? '' : '-' + QUALITY}${THROTTLE > 1 ? `-throttle${THROTTLE}` : ''}.json`), JSON.stringify(record, null, 2) + '\n');
console.log(`wrote ${OUT}`);
