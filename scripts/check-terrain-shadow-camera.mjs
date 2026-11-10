#!/usr/bin/env node
/**
 * Terrain shadows under camera navigation at a fixed epoch (#205 review): is the shadow at a fixed ground point the same
 * whatever the camera does?
 *
 *   node scripts/check-terrain-shadow-camera.mjs --viewer http://127.0.0.1:5290/ --out work/terrain-shadow-camera
 *   node scripts/check-terrain-shadow-camera.mjs --path drag --view-url '<shared viewer link>' --epoch 2028-12-27T18:15:07Z
 *
 * `--path drag` restores a shared view and orbits it with real mouse drags (the viewer's own controls); `--path user`
 * orbits low around Shackleton's rim; the default path is described below.
 *
 * MoonFall Shackleton, time frozen at 2029-02-05 16:08:55 UTC, terrain shadows High. One camera path (zoom out past the
 * 320 km cut-off and back, a full orbit, a 120 km pan and back, low grazing views, the same with the orbit target left
 * 300 km away on coarse terrain), driven frame by frame without
 * waiting for anything, four times: shadows Off, On, Sun fraction (debug 1) and unknown/too coarse (debug 2). Every frame
 * is saved; the pinned ground points are read from the Sun-fraction pass and the Off pass, with the clipmap level that
 * holds each point, the camera altitude and the clipmap state. Writes camera.json and camera.mp4 (off | on / fraction |
 * unknown).
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? true : all[i + 1]]);
  return acc;
}, []));
const BASE = args.viewer ?? 'http://127.0.0.1:5290/';
const OUT = resolve(args.out ?? join(ROOT, 'work/terrain-shadow-camera'));
const STEPS = Number(args.steps ?? 12);
const EPOCH = args.epoch ?? '2029-02-05T16:08:55Z';
// --path user: the review's screen recording (2028-12-27 18:15:07 UTC): orbiting low around Shackleton's rim.
const USER_PATH = args.path === 'user';
// --path drag --view-url '<viewer link>': start from that shared view and orbit with real mouse drags (the viewer's own
// orbit controls, whatever their pivot), 15 px per frame: right, back left past the start, right to the start, up, down.
const DRAG = args.path === 'drag';
const DRAGS = [...Array(16).fill([15, 0]), ...Array(32).fill([-15, 0]), ...Array(16).fill([15, 0]), ...Array(8).fill([0, -10]), ...Array(8).fill([0, 10])];
mkdirSync(OUT, { recursive: true });

// Camera keyposes: target (lat, lon), range from it (km), tilt from vertical, heading the camera looks along.
const SHACK = [-89.67, 129.2];
const key = (target, range, tilt, heading, far = false) => ({ lat: target[0], lon: target[1], range, tilt, heading, far });
const RIM = (az) => { const d = 10.5 / 1737.4, la = SHACK[0] * Math.PI / 180, a = az * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(a));
  return [la2 * 180 / Math.PI, SHACK[1] + Math.atan2(Math.sin(a) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2)) * 180 / Math.PI]; };
const PATH = USER_PATH ? [
  // Orbit the crater at 30 km, 65° tilt; dip to 12 km and back; walk the target round the rim; back to the start.
  ...[0, 45, 90, 135, 180, 225, 270, 315, 360].map(h => key(SHACK, 30, 65, h)),
  ...[12, 30].map(r => key(SHACK, r, 65, 360)),
  ...[0, 60, 120, 180, 240, 300, 360].map(az => key(RIM(az), 20, 70, az + 90)),
  key(SHACK, 30, 65, 360),
] : [
  ...[20, 40, 80, 160, 300, 500, 300, 160, 80, 40, 20].map(r => key(SHACK, r, 50, 0)),
  ...[45, 90, 135, 180, 225, 270, 315, 360].map(h => key(SHACK, 40, 50, h)),
  // Pan toward Malapert (and back) at 60 km.
  ...[0, 0.25, 0.5, 0.75, 1, 0.5, 0].map(f => key([SHACK[0] + f * 3.4, SHACK[1] + f * (0 - SHACK[1])], 60, 40, 0)),
  ...[0, 90, 180, 270].map(h => key(SHACK, 15, 78, h)),
  // Same grazing views with the orbit target left on the far horizon (300 km beyond; coarse terrain), as after free look.
  ...[270, 180, 90, 0].map(h => key(SHACK, 15, 78, h, true)),
];
// Interpolated per-frame poses (heading unwrapped).
const FRAMES = DRAG ? [{ key: 0, drag: null }, ...DRAGS.map((d, i) => ({ key: i === 63 || i === 79 ? i + 1 : null, drag: d }))] : [];
for (let k = 0; !DRAG && k < PATH.length - 1; k++) {
  const a = PATH[k], b = PATH[k + 1];
  for (let s = 0; s < STEPS; s++) {
    const f = s / STEPS, lerp = (x, y) => x + (y - x) * f;
    FRAMES.push({ key: s === 0 ? k : null, far: a.far && b.far, lat: lerp(a.lat, b.lat), lon: lerp(a.lon, b.lon), range: Math.exp(lerp(Math.log(a.range), Math.log(b.range))),
      tilt: lerp(a.tilt, b.tilt), heading: lerp(a.heading, b.heading) });
  }
}
if (!DRAG) FRAMES.push({ ...PATH[PATH.length - 1], key: PATH.length - 1 });

// Pinned ground points: rings around Shackleton (3–140 km, inside the polar detail) and two at 220 km (too coarse).
const POINTS = [];
for (const [dist, n] of USER_PATH || DRAG ? [[3, 8], [6, 12], [9, 12], [12, 12], [16, 12], [22, 12], [30, 12]] : [[3, 4], [10, 6], [25, 8], [50, 8], [90, 8], [140, 8], [220, 2]]) {
  for (let i = 0; i < n; i++) POINTS.push({ id: `${dist}km-${i}`, distKm: dist, azDeg: (360 * i) / n });
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const VIEWPORT = { width: 1280, height: 720 };
const passes = {};
let pinned = null, epochInfo = null;
const errors = [];
try {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push(e.message));
  const start = args['view-url'] ? new URL(String(args['view-url'])) : null;
  if (start) start.searchParams.set('test', '1');
  await page.goto(start ? new URL(start.search, BASE).href : new URL('?catalog=test-catalogs/moonfall-shackleton&test=1', BASE).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady === true, null, { timeout: 180_000 });
  const et = (Date.parse(EPOCH) - Date.parse('2000-01-01T12:00:00Z')) / 1000 + 69.184;
  epochInfo = await page.evaluate(async ({ et, SHACK, POINTS }) => {
    const source = await (await fetch('/src/lib/commands.ts')).text();
    const stateURL = source.match(/from ["']([^"']*viewer-state\.svelte[^"']*)["']/)?.[1];
    window.cap = await import(stateURL ?? '/src/lib/viewer-state.svelte.ts');
    const r = window.cap.getRenderer();
    window.cap.setPlaying(false); if (!new URLSearchParams(location.search).has('view')) window.cosmo.untrack();
    r.setLightingMode('natural'); r.setTerrainShadowMode('high');
    r.timeController.setTime(et);
    const DEG = Math.PI / 180, R = 1737.4;
    const moon = r.getBodyMesh('Moon'), THREE = r.camera.position.constructor;
    const centre = () => moon.getWorldPosition(new THREE());
    const toWorld = ([x, y, z]) => new THREE(x, z, -y).applyQuaternion(moon.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre());
    const bf = (lat, lon, h) => [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG)].map(v => v * (R + h));
    const frameAt = (lat, lon) => {
      const up = bf(lat, lon, 1 - R), east = [-Math.sin(lon * DEG), Math.cos(lon * DEG), 0];
      const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
      return { up, east, north };
    };
    // Point `distKm` from (lat, lon) along azimuth `azDeg` (great circle).
    const offset = (lat, lon, distKm, azDeg) => {
      const d = distKm / R, la = lat * DEG, az = azDeg * DEG;
      const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(az));
      const lo2 = lon * DEG + Math.atan2(Math.sin(az) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
      return [la2 / DEG, lo2 / DEG];
    };
    const frames = (n = 2) => new Promise(res => { const f = () => (--n <= 0 ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    const pts = POINTS.map(p => { const [lat, lon] = offset(SHACK[0], SHACK[1], p.distKm, p.azDeg); return { ...p, lat, lon }; });
    const clip = () => moon.terrainManager?.solarShadow;
    const home = { position: r.camera.position.clone(), up: r.camera.up.clone(), target: r.cameraController.controls.target.clone(), fov: r.camera.fov };
    window.probe = {
      frames, pts,
      pose(f) {
        r.timeController.setTime(et);
        if (f.drag !== undefined) {
          const controls = r.cameraController.controls;
          controls.enableDamping = false;
          if (f.drag === null) { r.camera.position.copy(home.position); r.camera.up.copy(home.up); r.camera.fov = home.fov; r.camera.updateProjectionMatrix(); controls.target.copy(home.target); r.camera.lookAt(home.target); controls.update(); }
          return;
        }
        const ground = moon.sampleTerrain(f.lat, f.lon)?.elevationKm ?? 0;
        const t = bf(f.lat, f.lon, ground), { up, east, north } = frameAt(f.lat, f.lon);
        const h = f.heading * DEG, s = Math.sin(f.tilt * DEG), c = Math.cos(f.tilt * DEG);
        const eye = t.map((v, i) => v + f.range * (c * up[i] - s * (Math.sin(h) * east[i] + Math.cos(h) * north[i])));
        const cam = r.camera, controls = r.cameraController.controls;
        controls.enableDamping = false;
        cam.fov = 55; cam.updateProjectionMatrix();
        cam.position.copy(toWorld(eye)); cam.up.copy(toWorld(eye).sub(centre()).normalize());
        controls.target.copy(toWorld(t)); cam.lookAt(controls.target);
        if (f.far) { const [la, lo] = offset(f.lat, f.lon, 300, f.heading); controls.target.copy(toWorld(bf(la, lo, 0))); }
        cam.updateMatrixWorld(true);
      },
      /** Per point: pixel, whether that pixel shows the point, the clipmap level holding it, its source spacing. */
      state() {
        const cl = clip(), st = moon.solarShadowStatus, a = cl?.anchor, m = cl?.sceneToBody;
        const camBf = (() => { const v = r.camera.position.clone().sub(centre()).multiplyScalar(1 / r.scaleFactor).applyQuaternion(moon.mesh.quaternion.clone().invert()); return [v.x, -v.z, v.y]; })();
        const W = r.renderer?.domElement?.clientWidth ?? innerWidth, H = r.renderer?.domElement?.clientHeight ?? innerHeight;
        const points = pts.map(p => {
          const ground = moon.sampleTerrain(p.lat, p.lon)?.elevationKm ?? 0;
          const w = toWorld(bf(p.lat, p.lon, ground));
          const ndc = w.clone().project(r.camera);
          let visible = false, level = null;
          const px = Math.round((ndc.x + 1) / 2 * W), py = Math.round((1 - ndc.y) / 2 * H);
          // Clear of the viewer's chrome (side bar, time bar).
          if (px > 50 && px < W - 20 && py > 20 && py < H - 80 && ndc.z < 1) {
            const hit = r.pickSurface(ndc.x, ndc.y);
            if (hit) {
              const q = hit.bodyFixedHitKm, pb = bf(p.lat, p.lon, ground), range = Math.hypot(...camBf.map((v, i) => v - pb[i]));
              const u = pb.map(v => v / Math.hypot(...pb)), d = q.map((v, i) => v - pb[i]), along = d.reduce((s, v, i) => s + v * u[i], 0);
              visible = Math.hypot(...d.map((v, i) => v - along * u[i])) < Math.max(0.3, 0.004 * range);
            }
          }
          if (a && m) {
            const v = w.clone().sub(m.origin).multiplyScalar(1 / m.scale).applyQuaternion(m.q), f = a.frame, dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
            const pv = [v.x, v.y, v.z], upv = dot(pv, f.up);
            level = upv > 0 ? (cl.find([dot(pv, f.east) * a.rcKm / upv, dot(pv, f.north) * a.rcKm / upv])?.level ?? -1) : -1;
          }
          return { px, py, visible, level, tile: moon.sampleTerrain(p.lat, p.lon)?.tileId ?? null,
            cpu: cl ? +cl.sunFractionAt(toWorld(bf(p.lat, p.lon, ground - 5))).toFixed(3) : null };
        });
        return { altKm: +(Math.hypot(...camBf) - R).toFixed(2), state: st?.state ?? null, anchorResets: st?.anchorResets ?? null,
          sourceRevision: cl?.source?.revision ?? null, horizonRenders: st?.horizonRenders ?? null, offsetsKm: st?.levels.map(l => l.offsetKm),
          builds: st?.levels.map(l => l.builds), reasons: st?.levels.map(l => l.lastReason), lagDeg: st?.levels.map(l => l.horizonSunLagDeg && +l.horizonSunLagDeg.toFixed(3)), points };
      },
      cellKm: () => pts.map(p => clip()?.source?.cellKm?.(p.lat, p.lon) ?? null),
    };
    await frames(2);
    return r.solarGeometryAt('Moon', SHACK[0], SHACK[1]);
  }, { et, SHACK, POINTS });
  console.log(`epoch ${EPOCH}: Sun at Shackleton elevation ${epochInfo.elevationDeg.toFixed(2)} deg, azimuth ${epochInfo.azimuthDeg.toFixed(1)}`);

  const DEBUG = { off: 0, on: 0, fraction: 1, unknown: 2 };
  const applyMode = (mode) => page.evaluate(({ mode, debug }) => {
    const r = window.cap.getRenderer();
    r.setTerrainShadowMode(mode === 'off' ? 'off' : 'high'); r.setTerrainShadowDebug(debug);
  }, { mode, debug: DEBUG[mode] });
  // Settle at the first pose: tiles idle and every level built (so each pass starts the same).
  const settle = async () => {
    let stable = 0, last = '';
    for (let i = 0; i < 240 && stable < 6; i++) {
      await page.evaluate(async (f) => { window.probe.pose(f); await window.probe.frames(10); }, FRAMES[0]);
      const k = await page.evaluate(() => {
        const bm = window.cap.getRenderer().getBodyMesh('Moon'), m = bm.terrainMetrics, s = bm.solarShadowStatus;
        return { busy: m.network.queued + m.network.downloading + m.network.parsing + (bm.terrainCubeStats?.inFlight ?? 0), key: JSON.stringify([m.tiles.visible, s?.levels.map(l => [l.builds, l.valid])]) };
      });
      stable = k.busy === 0 && k.key === last ? stable + 1 : 0; last = k.key;
    }
  };

  for (const mode of ['fraction', 'off', 'on', 'unknown']) {
    await applyMode(mode === 'off' ? 'on' : mode);
    await settle();
    await applyMode(mode);
    const dir = join(OUT, `frames-${mode}`);
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const rows = [];
    for (let i = 0; i < FRAMES.length; i++) {
      if (FRAMES[i].drag) {
        const [dx, dy] = FRAMES[i].drag, x = VIEWPORT.width / 2, y = VIEWPORT.height / 2;
        await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 3 }); await page.mouse.up();
      }
      const s = await page.evaluate(async (f) => { window.probe.pose(f); await window.probe.frames(2); return window.probe.state(); }, FRAMES[i]);
      const buf = await page.screenshot({ type: 'png' });
      writeFileSync(join(dir, `${String(i).padStart(4, '0')}.png`), buf);
      if (mode !== 'unknown') {
        const png = PNG.sync.read(buf);
        for (const p of s.points) {
          if (!p.visible) { p.gray = null; continue; }
          const g = [];
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const x = Math.min(png.width - 1, Math.max(0, p.px + dx)), y = Math.min(png.height - 1, Math.max(0, p.py + dy)), o = (y * png.width + x) * 4;
            g.push((png.data[o] + png.data[o + 1] + png.data[o + 2]) / 3 / 255);
          }
          p.gray = +g.sort((a, b) => a - b)[4].toFixed(3);
        }
      }
      rows.push({ frame: i, key: FRAMES[i].key, rangeKm: FRAMES[i].range === undefined ? null : +FRAMES[i].range.toFixed(1), ...s });
    }
    passes[mode] = rows;
    console.log(`${mode}: ${rows.length} frames`);
  }
  pinned = await page.evaluate(() => window.probe.pts);
  const cells = await page.evaluate(() => window.probe.cellKm());
  pinned.forEach((p, i) => { p.sourceCellKm = cells[i]; });
} finally {
  await browser.close();
}

// Per point: the Sun-fraction pixel across the frames that show it; jumps between consecutive showing frames, with what
// changed (level holding the point, clipmap state, anchor resets, camera altitude), and the Off pixel's change there.
const JUMP = 0.25;
const report = pinned.map((p, j) => {
  // Frames that draw shadows (above 320 km they are off by design: counted apart).
  const all = passes.fraction.map((row, i) => ({ i, row, pt: row.points[j], off: passes.off[i]?.points[j], on: passes.on[i]?.points[j] })).filter(x => x.pt.visible && x.pt.gray !== null);
  const seen = all.filter(x => x.row.state === 'ready' || x.row.state === 'partial');
  const jumps = [];
  for (let k = 1; k < seen.length; k++) {
    const a = seen[k - 1], b = seen[k];
    if (Math.abs(b.pt.gray - a.pt.gray) < JUMP) continue;
    jumps.push({ from: a.i, to: b.i, gray: [a.pt.gray, b.pt.gray], cpu: [a.pt.cpu, b.pt.cpu], level: [a.pt.level, b.pt.level], state: [a.row.state, b.row.state],
      altKm: [a.row.altKm, b.row.altKm], anchorReset: a.row.anchorResets !== b.row.anchorResets,
      offGray: [a.off?.gray ?? null, b.off?.gray ?? null], onGray: [a.on?.gray ?? null, b.on?.gray ?? null] });
  }
  const g = seen.map(x => x.pt.gray), c = seen.map(x => x.pt.cpu).filter(v => v !== null);
  return { ...p, framesShown: seen.length, gray: g.length ? [Math.min(...g), Math.max(...g)] : null, cpu: c.length ? [Math.min(...c), Math.max(...c)] : null,
    levels: [...new Set(seen.map(x => x.pt.level))], framesOutOfRange: all.length - seen.length, jumps };
});
writeFileSync(join(OUT, 'camera.json'), JSON.stringify({ generator: 'scripts/check-terrain-shadow-camera.mjs', created: new Date().toISOString(), epoch: EPOCH,
  sunAtShackleton: epochInfo, path: PATH, framesPerSegment: STEPS, jumpThreshold: JUMP, points: report, errors, passes }, null, 1) + '\n');
for (const p of report) {
  console.log(`${p.id.padEnd(9)} cell ${p.sourceCellKm?.toFixed(2)} km  shown ${String(p.framesShown).padStart(3)}  fraction px ${p.gray?.join('..') ?? '-'}  cpu ${p.cpu?.join('..') ?? '-'}  levels ${p.levels.join(',')}  jumps ${p.jumps.length}`);
  for (const jmp of p.jumps) console.log(`    ${JSON.stringify(jmp)}`);
}
// Video: off | on over fraction | unknown.
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '12',
  ...['off', 'on', 'fraction', 'unknown'].flatMap(m => ['-i', join(OUT, `frames-${m}`, '%04d.png')]),
  '-filter_complex', '[0][1][2][3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0,scale=1920:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', join(OUT, 'camera.mp4')]);
console.log(`errors: ${errors.length}`);
