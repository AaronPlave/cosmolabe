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
 *   neutral    debug view 4: neutral grey albedo lit by the Sun, with terrain shadows (no imagery, no baked light)
 *   neutral-off debug view 5: the same without terrain shadows
 *   on-rehorizon  shadows on with the horizon maps re-rendered every frame: their cost while the Sun moves faster
 *              than 1/16 of its radius per frame (time warp). Paused or at 1× they re-render about once a minute or less.
 *
 * --sequence adds two controlled motion sequences per view, each frame captured as off (debug 6: shadows bypassed,
 * clipmap still updating) / visibility / neutral / on at one pose, with a per-frame trace of every clipmap level
 * (centre, builds, last rebuild reason and texels sampled, anchor resets):
 *
 *   camera   time frozen; the camera pans 20 km (re-centring the 8 km and 64 km levels), yaws 12 deg and zooms in,
 *            then returns along the same path; the first and last frames (same pose) are compared pixel by pixel.
 *   time     camera fixed; the clock advances 2 min per frame; consecutive frames are compared (a pop is a spike).
 *
 * Frames are assembled into a 2×2 MP4 per sequence (off | visibility / neutral | on) with ffmpeg.
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
const RES_TAG = (VIEWPORT.width === 1280 ? '' : `-${VIEWPORT.width}w`) + (args.tag ? `-${args.tag}` : '');
const SCREENSHOTS = !args['no-screenshots'];
const FRAMES = Number(args.frames ?? (args.gpu ? 160 : 40));
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
  // Low-resolution terrain (LOLA 118 m only, no polar DEM) seen from 90 km: most of the frame is in the 0.5 km and
  // 2.5 km clipmap levels. Harkhebi J (43 km) and H (29 km).
  harkhebi: { site: [38.4, 101.5], wantElevationDeg: 4.0, eye: at(36.2, 101.5, 90), target: at(38.4, 101.5, -2), fov: 55 },
  // The coarsest terrain that casts shadows: the polar product's 0.85 km ring, 130 km from Shackleton, lit from the side,
  // from 30 km up; part of the foreground (1.7 km) is too coarse to.
  'polar-coarse': movedPose({ site: [-85.8, 40], wantElevationDeg: 3.0, eye: at(-85.0, 40, 30), target: at(-85.8, 40, -1), fov: 55 }, 0, -43, 1),
};
const viewNames = String(args.views ?? Object.keys(VIEWS).join(',')).split(',');
const MODES = String(args.modes ?? 'off,on,flood,visibility,unknown,alignment').split(',');
const SETTLE_POLLS = Number(args.stable ?? 6);
const TIMEOUT_MS = Number(args.timeout ?? 900_000);

// --gpu: the machine's real GPU through the installed Chrome (Metal on macOS), with the frame-rate limit and vsync off so the
// frame interval is the cost of the frame, not the display refresh. Default: software WebGL (SwiftShader).
const GPU = !!args.gpu;
const browser = await chromium.launch(GPU
  ? { channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] }
  : { headless: true, executablePath: process.env.CHROMIUM_PATH,
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

    const pose = (p = view, et = epoch.et) => page.evaluate(({ view, et }) => {
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
    }, { view: p, et });
    const DEBUG = { visibility: 1, unknown: 2, alignment: 3, neutral: 4, 'neutral-off': 5, bypass: 6 };
    const applyMode = (mode) => page.evaluate(({ mode, quality, debug }) => {
      const r = window.cap.getRenderer();
      r.setLightingMode(mode === 'flood' ? 'flood' : 'natural');
      r.setTerrainShadowMode(mode === "off" || mode === "flood" ? "off" : quality);
      r.setTerrainShadowDebug(debug);
    }, { mode, quality: QUALITY, debug: DEBUG[mode] ?? 0 });
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
      // Frame time over FRAMES frames (the first 10 dropped), then the screenshot and the state it shows.
      const frameMs = await page.evaluate(({ frames, moving }) => new Promise(resolveFrames => {
        const clip = window.cap.getRenderer().getBodyMesh('Moon').terrainManager?.solarShadow;
        const times = [];
        let prev = performance.now(), n = 0;
        const tick = (now) => {
          times.push(now - prev); prev = now;
          if (moving) clip?.setQuality(clip.quality); // marks the horizon maps stale
          if (++n < frames) requestAnimationFrame(tick); else resolveFrames(times.slice(10));
        };
        requestAnimationFrame(tick);
      }), { frames: FRAMES, moving: mode === 'on-rehorizon' });
      const mean = frameMs.reduce((a, b) => a + b, 0) / frameMs.length;
      const sorted = [...frameMs].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)], p95 = sorted[Math.floor(sorted.length * 0.95)];
      const { metrics, shadow } = await state();
      const geometry = await page.evaluate(({ site }) => window.cap.getRenderer().solarGeometryAt('Moon', site[0], site[1]), { site: view.site });
      const file = `${viewName}-${mode}${QUALITY === 'high' ? '' : '-' + QUALITY}${THROTTLE > 1 ? '-throttle' + THROTTLE : ''}${GPU ? '-gpu' : ''}${RES_TAG}.png`;
      if (SCREENSHOTS) await page.screenshot({ path: join(OUT, file), type: 'png' });
      results.push({ view: viewName, mode, file, epochEt: epoch.et, sun: geometry, frameMeanMs: +mean.toFixed(2), frameP50Ms: +p50.toFixed(2), frameP95Ms: +p95.toFixed(2), frameMaxMs: +Math.max(...frameMs).toFixed(1),
        shadow, tiles: metrics.tiles, pose: { eye: view.eye, target: view.target, fov: view.fov }, settleMs });
      console.log(`${file}: frame mean ${mean.toFixed(1)} / p50 ${p50.toFixed(1)} / p95 ${p95.toFixed(1)} ms (${GPU ? 'hardware GPU' : 'software WebGL'}), clipmap ${shadow?.state}, `
        + `unknown ${shadow?.levels.map(l => (l.unknownFraction * 100).toFixed(0) + '%').join('/')}, build ${shadow?.levels.map(l => l.lastBuildMs.toFixed(0) + ' ms').join('/')}`);
    }
    if (args.sequence) results.push({ view: viewName, sequences: await sequences(page, viewName, view, epoch, pose, applyMode) });
    if (args.playback) results.push({ view: viewName, playback: await playback(page, view, epoch, pose, applyMode) });
    results.push({ view: viewName, errors });
    await page.close();
  }
} finally {
  await browser.close();
}
/**
 * Real playback at `--playback <rate>` (default 86400: one day per second): every animation frame, each level's
 * horizon-map Sun lag (the angle between the Sun its map was rendered for and the drawn Sun) and the frame interval;
 * then seeks of ±1 h to ±5 days, each followed by the lag in the first drawn frame.
 */
async function playback(page, view, epoch, pose, applyMode) {
  const out = {};
  for (const mode of ['off', 'on']) out[mode] = await playbackRun(page, view, epoch, pose, applyMode, mode);
  if (args['playback-video']) out.video = await playbackVideo(page, view, epoch, pose, applyMode);
  return out;
}
/**
 * A real-time screen recording (CDP screencast) of `--playback-video <seconds>` of playback, from the same epoch, as the
 * Sun fraction (debug view 1) and shadows on, side by side.
 */
async function playbackVideo(page, view, epoch, pose, applyMode) {
  const { execFileSync } = await import('node:child_process');
  const seconds = args['playback-video'] === true ? 8 : Number(args['playback-video']);
  const rate = args.playback === true ? 86400 : Number(args.playback);
  const name = `${Object.keys(VIEWS).find(k => VIEWS[k] === view)}-playback`;
  const parts = [];
  for (const mode of ['visibility', 'on']) {
    await applyMode(mode); await pose(view, epoch.et); await page.waitForTimeout(1000);
    const dir = join(OUT, `${name}-frames`, mode);
    mkdirSync(dir, { recursive: true });
    const cdp = await page.context().newCDPSession(page);
    const frames = [];
    cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
      frames.push({ data, t: metadata.timestamp });
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
    await page.evaluate(({ rate, ms, view }) => new Promise(done => {
      const r = window.cap.getRenderer(), bm = r.getBodyMesh('Moon'), THREE = r.camera.position.constructor;
      const place = () => {
        const centre = new THREE(); bm.getWorldPosition(centre);
        const toWorld = ([x, y, z]) => new THREE(x, z, -y).applyQuaternion(bm.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
        const eye = toWorld(view.eye), target = toWorld(view.target);
        r.camera.position.copy(eye); r.camera.up.copy(eye.clone().sub(centre).normalize());
        r.cameraController.controls.target.copy(target); r.camera.lookAt(target); r.camera.updateMatrixWorld(true);
      };
      r.timeController.setRate(rate); window.cap.setPlaying(true);
      const end = performance.now() + ms;
      const tick = (now) => { place(); if (now < end) requestAnimationFrame(tick); else { window.cap.setPlaying(false); done(); } };
      requestAnimationFrame(tick);
    }), { rate, ms: seconds * 1000, view });
    await cdp.send('Page.stopScreencast');
    await cdp.detach();
    // Frames at their capture times: a concat list with each frame's duration.
    let list = '';
    frames.forEach((f, i) => {
      const file = join(dir, `${String(i).padStart(4, '0')}.jpg`);
      writeFileSync(file, Buffer.from(f.data, 'base64'));
      list += `file '${file}'\nduration ${((frames[i + 1]?.t ?? f.t + 1 / 30) - f.t).toFixed(4)}\n`;
    });
    writeFileSync(join(dir, 'list.txt'), list);
    parts.push({ list: join(dir, 'list.txt'), frames: frames.length });
  }
  const mp4 = join(OUT, `${name}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...parts.flatMap(p => ['-f', 'concat', '-safe', '0', '-i', p.list]),
    '-filter_complex', '[0]fps=30,scale=640:-2[a];[1]fps=30,scale=640:-2[b];[a][b]hstack=shortest=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', mp4]);
  console.log(`playback video: ${parts.map(p => p.frames).join(' / ')} frames in ${seconds} s -> ${mp4}`);
  return { file: mp4, seconds, rate, frames: parts.map(p => p.frames) };
}

async function playbackRun(page, view, epoch, pose, applyMode, mode) {
  await applyMode(mode); await pose(view, epoch.et); await page.waitForTimeout(1000);
  const rate = args.playback === true ? 86400 : Number(args.playback);
  const res = await page.evaluate(({ rate, frames, view }) => new Promise(done => {
    const r = window.cap.getRenderer(), bm = r.getBodyMesh('Moon');
    const lag = () => bm.solarShadowStatus.levels.map(l => l.horizonSunLagDeg);
    // Keep the camera at its body-fixed pose as the Moon turns (as a surface view tracking the Moon does).
    const THREE = r.camera.position.constructor;
    const place = () => {
      const centre = new THREE(); bm.getWorldPosition(centre);
      const toWorld = ([x, y, z]) => new THREE(x, z, -y).applyQuaternion(bm.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
      const eye = toWorld(view.eye), target = toWorld(view.target);
      r.camera.position.copy(eye); r.camera.up.copy(eye.clone().sub(centre).normalize());
      r.cameraController.controls.target.copy(target); r.camera.lookAt(target); r.camera.updateMatrixWorld(true);
    };
    const renders0 = bm.solarShadowStatus.horizonRenders;
    r.timeController.setRate(rate); window.cap.setPlaying(true);
    const rows = [];
    let prev = performance.now(), et0 = r.timeController.et;
    const tick = (now) => {
      rows.push({ dtMs: +(now - prev).toFixed(2), state: bm.solarShadowStatus.state, lagDeg: lag() }); prev = now;
      place();
      if (rows.length < frames) { requestAnimationFrame(tick); return; }
      window.cap.setPlaying(false);
      const simS = r.timeController.et - et0, renders = bm.solarShadowStatus.horizonRenders - renders0;
      const seeks = [];
      const deltas = [3600, -3600, 6 * 3600, 86400, -86400, 5 * 86400];
      const seek = (k) => {
        if (k >= deltas.length) { done({ rows: rows.slice(10), simS, renders, seeks }); return; }
        r.timeController.setTime(r.timeController.et + deltas[k]);
        // The first frame after a seek draws the camera where the Moon was (a harness artefact: a tracking camera
        // turns with it), so wait for the clipmap to be drawn again and report the lag in that first drawn frame.
        let n = 0;
        const wait = () => {
          place();
          const st = bm.solarShadowStatus.state;
          if (n++ > 0 && (st === 'ready' || st === 'partial') || n > 600) { seeks.push({ deltaS: deltas[k], framesUntilDrawn: n, state: st, lagDeg: lag() }); seek(k + 1); return; }
          requestAnimationFrame(wait);
        };
        requestAnimationFrame(wait);
      };
      seek(0);
    };
    requestAnimationFrame(tick);
  }), { rate, frames: Number(args['playback-frames'] ?? 300), view });
  const drawn = res.rows.filter(r => r.state === 'ready' || r.state === 'partial');
  const maxLag = Math.max(...drawn.flatMap(r => r.lagDeg.filter(v => v !== null)));
  const dts = res.rows.map(r => r.dtMs).sort((a, b) => a - b);
  const out = { rate, frames: res.rows.length, framesDrawn: drawn.length, states: [...new Set(res.rows.map(r => r.state))], simSeconds: +res.simS.toFixed(0), horizonRenders: res.renders,
    maxHorizonSunLagDeg: +maxLag.toFixed(4), frameP50Ms: dts[dts.length >> 1], frameP95Ms: dts[Math.floor(dts.length * 0.95)],
    seeks: res.seeks };
  console.log(`playback ${mode} ${rate}x: ${out.frames} frames, ${out.simSeconds} s simulated, ${out.horizonRenders} level renders, max lag ${out.maxHorizonSunLagDeg} deg, `
    + `frame p50/p95 ${out.frameP50Ms}/${out.frameP95Ms} ms, seeks ${JSON.stringify(res.seeks.map(s => Math.max(...s.lagDeg)))}`);
  return out;
}

/** Body-fixed pose moved from `view`: target panned `panKm` east, eye yawed `yawDeg` about the target's up, distance × `zoom`. */
function movedPose(view, panKm, yawDeg, zoom) {
  const n = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
  const up = n(view.target), east = n([-up[1], up[0], 0]);
  const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
  const target = view.target.map((x, i) => x + east[i] * panKm);
  const rel = view.eye.map((x, i) => x - view.target[i]);
  const [e, nn, u] = [0, 1, 2].map(k => rel.reduce((a, x, i) => a + x * [east, north, up][k][i], 0));
  const y = yawDeg * Math.PI / 180, e2 = e * Math.cos(y) - nn * Math.sin(y), n2 = e * Math.sin(y) + nn * Math.cos(y);
  const eye = target.map((x, i) => x + zoom * (e2 * east[i] + n2 * north[i] + u * up[i]));
  return { ...view, eye, target };
}

/** Mean |a-b| (0–255) and fraction of pixels differing by more than 8 levels, over two PNG screenshots. */
async function diff(page, a, b) {
  return page.evaluate(async ([a, b]) => {
    const px = async (b64) => {
      const bm = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext('2d');
      g.drawImage(bm, 0, 0);
      return g.getImageData(0, 0, bm.width, bm.height).data;
    };
    const [x, y] = await Promise.all([px(a), px(b)]);
    let sum = 0, big = 0;
    for (let i = 0; i < x.length; i += 4) {
      const d = (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2])) / 3;
      sum += d; if (d > 8) big++;
    }
    return { meanAbs: +(sum / (x.length / 4)).toFixed(3), fractionOver8: +(big / (x.length / 4)).toFixed(5) };
  }, [a.toString('base64'), b.toString('base64')]);
}

async function sequences(page, viewName, view, epoch, pose, applyMode) {
  const { execFileSync } = await import('node:child_process');
  const modes = ['bypass', 'visibility', 'neutral', 'on'];
  const clip = { x: 56, y: 0, width: 1216, height: 672 };
  const trace = () => page.evaluate(() => {
    const s = window.cap.getRenderer().getBodyMesh('Moon').solarShadowStatus;
    return s && { state: s.state, anchorResets: s.anchorResets, levels: s.levels.map(l => ({ offsetKm: l.offsetKm?.map(v => +v.toFixed(2)),
      builds: l.builds, lastReason: l.lastReason, lastSampledTexels: l.lastSampledTexels, unknown: +l.unknownFraction.toFixed(4),
      horizonSunLagDeg: l.horizonSunLagDeg })) };
  });
  const frames = () => page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
  const out = {};
  const N = Number(args['sequence-frames'] ?? 48);
  const plans = {
    camera: Array.from({ length: 2 * N + 1 }, (_, i) => { const s = i <= N ? i / N : (2 * N - i) / N; return { p: movedPose(view, 20 * s, 12 * s, 1 - 0.2 * s), et: epoch.et }; }),
    time: Array.from({ length: 2 * N }, (_, i) => ({ p: view, et: epoch.et + 120 * i })),
    // One day of simulation per second at 60 frames per second.
    fast: Array.from({ length: 2 * N }, (_, i) => ({ p: view, et: epoch.et + 1440 * i })),
  };
  const wanted = String(args.sequence === true ? 'camera,time' : args.sequence).split(',');
  for (const [name, plan] of Object.entries(plans).filter(([n]) => wanted.includes(n))) {
    const dir = join(OUT, `${viewName}-${name}-frames`);
    mkdirSync(dir, { recursive: true });
    const rows = [], shots = { on: [], visibility: [] };
    for (let i = 0; i < plan.length; i++) {
      await pose(plan[i].p, plan[i].et);
      await frames();
      for (const m of modes) {
        await applyMode(m); await pose(plan[i].p, plan[i].et); await frames();
        const png = await page.screenshot({ clip, type: 'png' });
        writeFileSync(join(dir, `${m}-${String(i).padStart(3, '0')}.png`), png);
        if (shots[m]) shots[m].push(png);
      }
      rows.push({ frame: i, et: plan[i].et, ...await trace() });
    }
    const res = { frames: plan.length, trace: rows };
    if (name === 'camera') {
      // Same pose at the start and the end: shadows attached to the terrain look identical after the round trip.
      res.roundTrip = { visibility: await diff(page, shots.visibility[0], shots.visibility.at(-1)), on: await diff(page, shots.on[0], shots.on.at(-1)) };
    } else {
      const d = [];
      for (let i = 1; i < shots.visibility.length; i++) d.push((await diff(page, shots.visibility[i - 1], shots.visibility[i])).meanAbs);
      const sorted = [...d].sort((a, b) => a - b);
      res.consecutiveVisibility = { median: sorted[d.length >> 1], max: sorted.at(-1), maxOverMedian: +(sorted.at(-1) / Math.max(sorted[d.length >> 1], 1e-6)).toFixed(2), perFrame: d };
    }
    const mp4 = join(OUT, `${viewName}-${name}.mp4`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '12',
      ...modes.flatMap(m => ['-i', join(dir, `${m}-%03d.png`)]),
      '-filter_complex', modes.map((_, k) => `[${k}]scale=608:336[v${k}]`).join(';') + ';[v0][v1][v2][v3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', mp4]);
    res.video = mp4;
    out[name] = res;
    const levelsBuilt = rows.at(-1)?.levels.map(l => l.builds).join('/');
    console.log(`${viewName} ${name}: ${plan.length} frames, builds ${levelsBuilt}, anchor resets ${rows.at(-1)?.anchorResets}, states ${[...new Set(rows.map(r => r.state))].join(',')}`
      + (res.roundTrip ? `, round trip ${JSON.stringify(res.roundTrip)}` : '') + (res.consecutiveVisibility ? `, consecutive ${JSON.stringify({ ...res.consecutiveVisibility, perFrame: undefined })}` : ''));
  }
  return out;
}

const record = {
  generator: 'scripts/capture-terrain-solar-shadow.mjs', created: new Date().toISOString(), catalog: CATALOG, viewport: VIEWPORT,
  cpuThrottle: THROTTLE, quality: QUALITY, gpu: GPU,
  browser: { ...env, launch: GPU ? 'playwright, installed Chrome headless, --use-angle=metal, vsync and frame limit off (hardware GPU)' : 'playwright chromium headless, --use-angle=swiftshader (software WebGL; no GPU in this host)' },
  host: { platform: `${platform()} ${release()}`, cpus: cpus().length, cpuModel: cpus()[0]?.model, memoryGB: Math.round(totalmem() / 2 ** 30) },
  captures: results,
};
writeFileSync(join(OUT, `captures${QUALITY === 'high' ? '' : '-' + QUALITY}${THROTTLE > 1 ? `-throttle${THROTTLE}` : ''}${GPU ? '-gpu' : ''}${RES_TAG}.json`), JSON.stringify(record, null, 2) + '\n');
console.log(`wrote ${OUT}`);
