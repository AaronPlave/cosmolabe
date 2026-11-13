#!/usr/bin/env node
/**
 * Terrain shadows on vehicles (#205): MoonFall hoppers landed and flying at the south pole, on the GPU.
 *
 *   node scripts/check-terrain-shadow-vehicles.mjs --viewer http://127.0.0.1:5290/ --out work/terrain-shadow-vehicles
 *
 * For every hop in the catalog `moonfall-shackleton` (terrain shadows set to High), every 10 s along the arc: the Sun
 * fraction the renderer gives the vehicle (`uTerrainSunVisibility`) and an independent one from the CPU reference
 * (`TerrainSunVisibility.solarVisibility`: resident source terrain, marched from the vehicle along the Sun's azimuth).
 * Screenshots, shadows on and off, landed (before take-off) and at the highest point, for the hops whose vehicle is
 * both lit and shadowed along the way.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? true : all[i + 1]]);
  return acc;
}, []));
const BASE = args.viewer ?? 'http://127.0.0.1:5290/';
const OUT = resolve(args.out ?? join(ROOT, 'work/terrain-shadow-vehicles'));
mkdirSync(OUT, { recursive: true });
// Every hop (an arc with waypoints): vehicle, window and the time of its highest point.
const catalog = JSON.parse(readFileSync(join(ROOT, 'apps/viewer/test-catalogs/moonfall-shackleton.json'), 'utf8'));
const vehicles = [];
const walk = (o) => { if (o && typeof o === 'object') { if (o.arcs && o.name) vehicles.push(o); Object.values(o).forEach(walk); } };
walk(catalog.items);
const HOPS = vehicles.flatMap(v => v.arcs.filter(a => a.trajectory?.waypoints?.length > 2).map(a => {
  const w = a.trajectory.waypoints, top = w.reduce((b, x) => (parseFloat(x.alt) > parseFloat(b.alt) ? x : b));
  return { vehicle: v.name, start: a.startTime, end: a.endTime, topS: top.t };
}));

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(new URL('?catalog=test-catalogs/moonfall-shackleton&test=1', BASE).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady === true, null, { timeout: 180_000 });
  await page.evaluate(async (root) => {
    const source = await (await fetch('/src/lib/commands.ts')).text();
    const stateURL = source.match(/from ["']([^"']*viewer-state\.svelte[^"']*)["']/)?.[1];
    window.cap = await import(stateURL ?? '/src/lib/viewer-state.svelte.ts');
    window.ref = await import(`/@fs${root}/packages/three/src/TerrainSunVisibility.ts`);
    const r = window.cap.getRenderer();
    window.cap.setPlaying(false); window.cosmo.untrack();
    r.setLightingMode('natural'); r.setTerrainShadowMode('high');
    const DEG = Math.PI / 180;
    const moon = r.getBodyMesh('Moon'), THREE = r.camera.position.constructor;
    const centre = () => moon.getWorldPosition(new THREE());
    // Scene <-> body-fixed km (Z north), as the capture script's poses.
    const toBody = (p) => { const v = p.clone().sub(centre()).multiplyScalar(1 / r.scaleFactor).applyQuaternion(moon.mesh.quaternion.clone().invert()); return [v.x, -v.z, v.y]; };
    const toWorld = ([x, y, z]) => new THREE(x, z, -y).applyQuaternion(moon.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre());
    const frames = (n = 2) => new Promise(res => { const f = () => (--n <= 0 ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    window.vehicle = {
      frames,
      /** Vehicle state at et: renderer's Sun fraction and the CPU reference from source terrain. */
      async at(name, et, look = false) {
        r.timeController.setTime(et);
        await frames(2);
        const bm = r.getBodyMesh(name);
        const p = toBody(bm.position), R = Math.hypot(...p);
        const latDeg = Math.asin(p[2] / R) / DEG, lonDeg = Math.atan2(p[1], p[0]) / DEG;
        if (look) {
          // Camera 10 m from the vehicle on the side away from the Sun, 3 m up, looking at it.
          const g = r.solarGeometryAt('Moon', latDeg, lonDeg), up = p.map(v => v / R);
          const east = [-Math.sin(lonDeg * DEG), Math.cos(lonDeg * DEG), 0];
          const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
          const az = (g.azimuthDeg + 180) * DEG;
          const eye = p.map((v, i) => v + 0.01 * (Math.sin(az) * east[i] + Math.cos(az) * north[i]) + 0.003 * up[i]);
          const c = r.camera, controls = r.cameraController.controls;
          controls.enableDamping = false;
          c.position.copy(toWorld(eye)); c.up.copy(toWorld(eye).sub(centre()).normalize());
          controls.target.copy(bm.position); c.lookAt(bm.position); c.updateMatrixWorld(true);
          await frames(2);
        }
        // A camera move that moved the clipmap site fades the old answer out over 0.8 s: compare the settled one.
        for (let i = 0; i < 240 && (moon.solarShadowStatus?.siteFade ?? 1) < 1; i++) await frames(1);
        const fraction = bm.shadowUniforms.uTerrainSunVisibility.value;
        const g = r.solarGeometryAt('Moon', latDeg, lonDeg);
        const ground = moon.sampleTerrain(latDeg, lonDeg)?.elevationKm ?? null;
        // Reference: march resident source terrain from the vehicle along the Sun azimuth (tangent plane at the vehicle).
        const up = p.map(v => v / R), east = [-Math.sin(lonDeg * DEG), Math.cos(lonDeg * DEG), 0];
        const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
        const height = (e, n) => {
          const q = p.map((v, i) => v + e * east[i] + n * north[i]), Q = Math.hypot(...q);
          return moon.sampleTerrain(Math.asin(q[2] / Q) / DEG, Math.atan2(q[1], q[0]) / DEG)?.elevationKm ?? null;
        };
        const radiusKm = 1737.4;
        const reference = g && window.ref.solarVisibility(height, g.azimuthDeg, g.elevationDeg, R - radiusKm, radiusKm, 150, 0.03);
        return { et, latDeg, lonDeg, altAboveGroundKm: ground === null ? null : R - radiusKm - ground, sunElevationDeg: g?.elevationDeg,
          fraction, reference: reference && { state: reference.state, fraction: reference.fraction, horizonDeg: reference.horizonDeg } };
      },
    };
  }, ROOT);

  // TDB seconds past J2000 from UTC: 32.184 s + 37 leap seconds (to within ~2 ms).
  const etOf = (iso) => (Date.parse(iso) - Date.parse('2000-01-01T12:00:00Z')) / 1000 + 69.184;

  for (const hop of HOPS) {
    const [t0, t1] = [etOf(hop.start), etOf(hop.end)], top = t0 + hop.topS;
    // Settle the clipmap at the landed start (tiles and every level built).
    await page.evaluate(async ({ name, t0 }) => { for (let i = 0; i < 40; i++) await window.vehicle.at(name, t0, true); }, { name: hop.vehicle, t0 });
    const series = [];
    for (let t = t0; t <= t1; t += 10) series.push(await page.evaluate(({ name, t }) => window.vehicle.at(name, t, true), { name: hop.vehicle, t }));
    const known = series.filter(s => s.reference && s.reference.fraction !== null);
    const maxDiff = Math.max(...known.map(s => Math.abs(s.fraction - s.reference.fraction)));
    const shots = {};
    const varies = known.some(x => x.fraction > 0.5) && known.some(x => x.fraction < 0.5);
    for (const [label, t] of varies ? [['landed', t0 - 1], ['flying', top]] : []) {
      for (const mode of ['high', 'off']) {
        await page.evaluate(async ({ name, t, mode }) => {
          window.cap.getRenderer().setTerrainShadowMode(mode);
          for (let i = 0; i < 20; i++) await window.vehicle.at(name, t, true);
        }, { name: hop.vehicle, t, mode });
        const file = `${hop.vehicle}-${hop.start.slice(0, 10)}-${label}-${mode === 'off' ? 'off' : 'on'}.png`;
        await page.screenshot({ path: join(OUT, file) });
        shots[`${label}-${mode}`] = { file, ...(await page.evaluate(({ name, t }) => window.vehicle.at(name, t), { name: hop.vehicle, t })) };
      }
      await page.evaluate(() => window.cap.getRenderer().setTerrainShadowMode('high'));
    }
    results.push({ ...hop, samples: series.length, comparedSamples: known.length, maxAbsDiffVsReference: +maxDiff.toFixed(3), shots, series });
    const lit = known.filter(x => x.fraction > 0.5).length;
    console.log(`${hop.vehicle} ${hop.start}: ${series.length} samples (${lit} lit), Sun ${Math.min(...series.map(x => x.sunElevationDeg)).toFixed(2)}..`
      + `${Math.max(...series.map(x => x.sunElevationDeg)).toFixed(2)} deg, up to ${Math.max(...series.map(x => x.altAboveGroundKm ?? 0)).toFixed(2)} km above ground, `
      + `${known.length} with a known reference, max |renderer - reference| ${maxDiff.toFixed(3)}`);
  }
  results.push({ errors });
} finally {
  await browser.close();
}
writeFileSync(join(OUT, 'vehicles.json'), JSON.stringify({ generator: 'scripts/check-terrain-shadow-vehicles.mjs', created: new Date().toISOString(), results }, null, 2) + '\n');
