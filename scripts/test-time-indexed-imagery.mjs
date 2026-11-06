/** Time-indexed imagery browser test (#214): the real viewer, catalog loader, tile
 * compositor and Imagery section against the Earth GIBS daily pilot
 * (apps/viewer/test-catalogs/earth-gibs-daily.json).
 *
 * Default (mock) mode answers the GIBS host from the test: each UTC day is a
 * solid colour of its own, so the pixels on screen say which day was drawn,
 * and a mixture of days shows up as a mixture of colours. That makes the
 * date-switching, fallback and cancellation behaviour deterministic and
 * reproducible offline. It does NOT verify the real service.
 *
 *   node scripts/test-time-indexed-imagery.mjs [viewer-url] [output-dir]
 *   node scripts/test-time-indexed-imagery.mjs --live [viewer-url] [output-dir]
 *
 * `--live` talks to the real gibs.earthdata.nasa.gov and checks what mock mode
 * cannot: the endpoint answers browsers (CORS), the two chosen days exist and
 * differ, and a day before the product's start has no tiles. Run it before
 * relying on the catalog's product, date range or tile matrix.
 *
 * Needs a running viewer (npm --prefix apps/viewer run dev). Software GL is
 * enough: nothing here depends on GPU speed, and GPU/cache numbers are
 * reported (renderer.info and the tile cache) rather than timed.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const live = args.includes('--live');
const [base = process.env.CL_VIEWER_URL ?? 'http://localhost:5173/', out = 'work/time-indexed-imagery'] = args.filter((a) => !a.startsWith('--'));
await mkdir(out, { recursive: true });

const DAILY_RE = /\/MODIS_Terra_CorrectedReflectance_TrueColor\/default\/(\d{4}-\d{2}-\d{2})\//;
const FIRST_DAY = '2000-02-24';
// Distinct, saturated colours survive lighting and atmosphere as clear hue differences.
const COLOURS = { '2024-06-01': [255, 0, 0], '2024-06-02': [0, 255, 0], '2024-06-03': [0, 0, 255] };
const GAP_DAY = '2024-07-04'; // answered with 404, like an unpublished or missing day
const colourOf = (day) => COLOURS[day] ?? [255, 0, 255];
const png = new Map();
const solid = async (rgb) => {
  const key = rgb.join();
  if (!png.has(key)) png.set(key, await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer());
  return png.get(key);
};

const result = { mode: live ? 'live' : 'mock', passed: false, errors: [], checks: {}, measurements: {} };
const requestsByDay = new Map();
const browser = await chromium.launch({
  executablePath: process.env.CL_CHROMIUM ?? '/opt/pw-browsers/chromium',
  args: process.env.CL_GPU === 'hardware' ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  page.on('pageerror', (e) => result.errors.push(e.message));
  page.on('console', (m) => { if (/GL_INVALID|INVALID_OPERATION|Shader Error/.test(m.text())) result.errors.push(m.text()); });
  const statuses = new Map();
  page.on('response', (r) => { const d = DAILY_RE.exec(r.url())?.[1]; if (d) { const k = `${d}:${r.status()}`; statuses.set(k, (statuses.get(k) ?? 0) + 1); } });
  if (live) {
    page.on('request', (r) => { const m = DAILY_RE.exec(r.url()); if (m) requestsByDay.set(m[1], (requestsByDay.get(m[1]) ?? 0) + 1); });
  } else {
    await page.route(/gibs\.earthdata\.nasa\.gov\//, async (route) => {
      const url = route.request().url();
      const day = DAILY_RE.exec(url)?.[1];
      const cors = { 'access-control-allow-origin': '*' };
      if (!day) return route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: await solid([20, 40, 90]) }); // Blue Marble
      requestsByDay.set(day, (requestsByDay.get(day) ?? 0) + 1);
      if (day === GAP_DAY || day < FIRST_DAY) return route.fulfill({ status: 404, headers: cors, body: '' });
      return route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: await solid(colourOf(day)) });
    });
  }

  await page.goto(`${base}?catalog=test-catalogs/earth-gibs-daily`);
  await page.waitForFunction(() => window.renderer?.getBodyMesh('Earth')?.imageryLayers?.length === 2 && window.cosmo);
  // The ISS mesh is a Git LFS object; a checkout without it settles with one failed asset, which is not what is tested here.
  await page.evaluate(() => window.renderer.waitForInitialAssets());
  await page.evaluate(() => { window.__loadErrors = 0; window.renderer.getBodyMesh('Earth').terrainManager.tiles.addEventListener('load-error', () => { window.__loadErrors++; }); });
  const layer = () => page.evaluate(() => window.renderer.getBodyMesh('Earth').imageryLayers.find((l) => l.id === 'modis-daily'));
  const stats = () => page.evaluate(() => {
    const r = window.renderer, tm = r.getBodyMesh('Earth').terrainManager, info = r.getContext().webglRenderer.info;
    const plugin = tm.tiles.getPluginByName('IMAGE_OVERLAY_PLUGIN');
    return { overlays: plugin.overlays.length, textures: info.memory.textures, geometries: info.memory.geometries, cachedBytes: tm.tiles.lruCache.cachedBytes, requests: tm.imageryLayers.find((l) => l.id === 'modis-daily').requests };
  });
  const sim = (iso) => page.evaluate((t) => window.cosmo.setTime({ kind: 'calendar', text: t }), iso);
  const settle = async (ms) => { await page.evaluate((m) => new Promise((r) => setTimeout(r, m)), ms); };
  const until = (fn, arg, msg) => page.waitForFunction(fn, arg, { timeout: 60_000 }).catch(async (e) => {
    const state = await page.evaluate(() => { const bm = window.renderer.getBodyMesh('Earth'); const l = bm.imageryLayers.find((x) => x.id === 'modis-daily'); return { surface: bm.surfaceTransitionState, temporal: l.temporal, requests: l.requests, failedTiles: l.failedTiles, status: l.status, view: l.view, loadErrors: window.__loadErrors, overlays: bm.terrainManager.tiles.getPluginByName('IMAGE_OVERLAY_PLUGIN').overlays.length, active: [...bm.terrainManager.activeOverlays.keys()] }; });
    throw new Error(`${msg}: ${e.message}\n${JSON.stringify(state)}\nrequests by day: ${JSON.stringify(Object.fromEntries(requestsByDay))}\nresponses: ${JSON.stringify(Object.fromEntries(statuses))}`);
  });
  const showingDay = (day) => until((d) => { const l = window.renderer.getBodyMesh('Earth').imageryLayers.find((x) => x.id === 'modis-daily'); return l.temporal.date === d && !l.temporal.pendingDate; }, day, `layer never showed ${day}`);

  /** Share of globe pixels dominated by each colour, among the pixels that are not the dark backdrop or space. */
  const hues = async (file) => {
    const shot = await page.screenshot({ path: `${out}/${file}.png` });
    const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
    const n = { red: 0, green: 0, blue: 0, magenta: 0, other: 0 };
    for (let i = 0; i < data.length; i += info.channels) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (Math.max(r, g, b) < 40) continue;
      const hi = Math.max(r, g, b);
      if (r > 0.7 * hi && g < 0.35 * hi && b < 0.35 * hi) n.red++;
      else if (g > 0.7 * hi && r < 0.35 * hi && b < 0.35 * hi) n.green++;
      else if (b > 0.7 * hi && r < 0.35 * hi && g < 0.35 * hi) n.blue++;
      else if (r > 0.7 * hi && b > 0.7 * hi && g < 0.35 * hi) n.magenta++;
      else n.other++;
    }
    return n;
  };
  const dominant = (n, colour) => n[colour] > 2000 && Object.entries(n).filter(([k]) => k !== colour && k !== 'other').every(([, v]) => v < 0.02 * n[colour]);

  // 1. Orbit view, first day. The layer is time-following and shows the simulation day.
  await page.evaluate(() => window.cosmo.setPlaying(false));
  await page.evaluate(() => window.cosmo.viewpoint('Earth from orbit'));
  await sim('2024-06-01T18:00:00Z');
  await showingDay('2024-06-01');
  await until(() => window.renderer.getBodyMesh('Earth').surfaceTransitionState === 'streamed', null, 'surface never streamed');
  await settle(live ? 6000 : 2500);
  let t = (await layer()).temporal;
  assert.deepEqual([t.policy, t.date, t.state, t.cadence], ['follow-simulation', '2024-06-01', 'exact', 'day']);
  if (live) await page.screenshot({ path: `${out}/orbit-2024-06-01.png` });
  if (!live) {
    const a = await hues('orbit-2024-06-01');
    assert.ok(dominant(a, 'red'), `2024-06-01 should show only its own day: ${JSON.stringify(a)}`);
    result.checks.orbitDayOne = a;
  }

  // 2. One-day step: switches once, never a mixture, old day's overlay retired.
  const before = await stats();
  await sim('2024-06-02T18:00:00Z');
  await showingDay('2024-06-02');
  await settle(live ? 6000 : 2500);
  t = (await layer()).temporal;
  assert.equal(t.date, '2024-06-02');
  assert.equal((await stats()).overlays, 1, 'one overlay per layer after a date change');
  if (live) await page.screenshot({ path: `${out}/orbit-2024-06-02.png` });
  if (!live) {
    const b = await hues('orbit-2024-06-02');
    assert.ok(dominant(b, 'green'), `2024-06-02 should show only its own day: ${JSON.stringify(b)}`);
    result.checks.orbitDayTwo = b;
  }

  // 3. Regional close-up shows the same day, from the same layer.
  await page.evaluate(() => window.cosmo.viewpoint('Regional close-up'));
  await settle(live ? 8000 : 3000);
  assert.equal((await layer()).temporal.date, '2024-06-02');
  if (live) await page.screenshot({ path: `${out}/regional-2024-06-02.png` });
  if (!live) result.checks.regional = await hues('regional-2024-06-02');
  if (!live) assert.ok(dominant(result.checks.regional, 'green'), `regional view should be a single day: ${JSON.stringify(result.checks.regional)}`);

  // 4. Fixed date chosen from the Imagery section's API; the clock no longer moves it.
  const fixed = await page.evaluate(() => window.renderer.getBodyMesh('Earth').setImageryLayerTime('modis-daily', { date: '2024-06-03' }));
  assert.equal(fixed, true);
  await showingDay('2024-06-03');
  await sim('2024-06-01T18:00:00Z');
  await settle(4500);
  t = (await layer()).temporal;
  assert.deepEqual([t.policy, t.date], ['fixed', '2024-06-03']);
  if (!live) assert.ok(dominant(await hues('fixed-2024-06-03'), 'blue'), 'fixed date draws its own day only');
  await page.evaluate(() => window.renderer.getBodyMesh('Earth').setImageryLayerTime('modis-daily', { policy: 'follow-simulation' }));
  await showingDay('2024-06-01');

  // 5. Rapid scrubbing: bounded requests, bounded residency, and the day it stops on wins.
  await page.evaluate(() => window.cosmo.viewpoint('Earth from orbit'));
  await settle(1500);
  const start = await stats();
  const daysBefore = new Set(requestsByDay.keys());
  const scrub = await page.evaluate(async () => {
    const day0 = Date.parse('2024-06-01T18:00:00Z');
    const bm = window.renderer.getBodyMesh('Earth');
    let maxOverlays = 0, frames = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 4000) {
      // 40 UTC days per second of wall time, as a scrubbed timeline or a fast playback would.
      window.cosmo.setTime({ kind: 'calendar', text: new Date(day0 + ((performance.now() - t0) / 1000) * 40 * 86_400_000).toISOString() });
      await new Promise(requestAnimationFrame);
      frames++;
      maxOverlays = Math.max(maxOverlays, bm.terrainManager.tiles.getPluginByName('IMAGE_OVERLAY_PLUGIN').overlays.length);
    }
    return { frames, maxOverlays, switches: bm.imageryLayers.find((l) => l.id === 'modis-daily').temporal.switches };
  });
  await sim('2024-06-02T18:00:00Z');
  await showingDay('2024-06-02');
  await settle(live ? 6000 : 2500);
  const scrubbedDays = [...requestsByDay.keys()].filter((d) => !daysBefore.has(d));
  const end = await stats();
  result.measurements.scrub = { ...scrub, daysRequested: scrubbedDays.length, daysScrubbed: 160, before: start, after: end };
  assert.ok(scrub.maxOverlays <= 1, 'at most one overlay for the layer at any time');
  assert.ok(scrubbedDays.length <= 8, `scrubbing 160 days should request a handful of days, not ${scrubbedDays.length}`);
  assert.ok(end.textures <= start.textures + 40, `texture count should not grow across a scrub: ${start.textures} -> ${end.textures}`);
  assert.ok(end.cachedBytes <= Math.max(start.cachedBytes * 2, 64 * 1024 * 1024), 'tile cache stays bounded');
  if (!live) assert.ok(dominant(await hues('after-scrub'), 'green'), 'the day the scrub stopped on is the only one drawn');

  // 6. Repeated seeks between two days leak nothing.
  const seekStart = await stats();
  for (let i = 0; i < 12; i++) {
    await page.evaluate((d) => window.renderer.getBodyMesh('Earth').setImageryLayerTime('modis-daily', { date: d }), i % 2 ? '2024-06-01' : '2024-06-02');
    await settle(250);
    assert.equal((await stats()).overlays, 1);
  }
  await showingDay(await page.evaluate(() => window.renderer.getBodyMesh('Earth').imageryLayers.find((l) => l.id === 'modis-daily').temporal.date));
  await settle(2500);
  const seekEnd = await stats();
  result.measurements.seeks = { before: seekStart, after: seekEnd };
  assert.ok(seekEnd.textures <= seekStart.textures + 40, `repeated seeks must not grow GPU textures: ${seekStart.textures} -> ${seekEnd.textures}`);
  await page.evaluate(() => window.renderer.getBodyMesh('Earth').setImageryLayerTime('modis-daily', { policy: 'follow-simulation' }));

  // 7. A day before the product: nothing drawn, said so, lower layers stay.
  await sim('1999-12-31T12:00:00Z');
  await until(() => { const l = window.renderer.getBodyMesh('Earth').imageryLayers.find((x) => x.id === 'modis-daily'); return l.temporal.state === 'before-range' && !l.temporal.pendingDate; }, null, 'before-range never reported');
  await settle(2000);
  t = (await layer()).temporal;
  assert.deepEqual([t.date, t.state], [null, 'before-range']);
  assert.equal((await stats()).overlays, 0);
  if (!live) {
    const none = await hues('before-range');
    assert.ok(none.red + none.green + none.blue + none.magenta < 200, `no dated imagery should draw: ${JSON.stringify(none)}`);
    assert.ok(none.other > 2000, 'the layers beneath still draw the globe');
  }

  // 8. A day the service lacks (404 for every tile): no other day stands in, and the layers beneath still draw.
  if (!live) {
    await page.evaluate(() => window.cosmo.viewpoint('Regional close-up'));
    const otherDays = () => [...requestsByDay.entries()].filter(([d]) => d !== GAP_DAY).reduce((n, [, c]) => n + c, 0);
    await sim(`${GAP_DAY}T12:00:00Z`);
    await showingDay(GAP_DAY);
    const othersAtCommit = otherDays();
    await settle(8000);
    const gap = await layer();
    assert.equal(otherDays(), othersAtCommit, 'a missing day must not fetch any other day');
    assert.ok((requestsByDay.get(GAP_DAY) ?? 0) > 0, 'the missing day was asked for');
    assert.ok(![...statuses].some(([k]) => k.startsWith(`${GAP_DAY}:`) && !k.endsWith(':404')), 'the service answered 404 for the missing day');
    const g = await hues('gap-day');
    assert.ok(g.other > 2000 && g.red + g.green + g.blue + g.magenta < 200, `a missing day falls back to Blue Marble, not another day: ${JSON.stringify(g)}`);
    result.checks.gapDay = { status: gap.status, failedTiles: gap.failedTiles, requests: gap.requests, hues: g };
  }

  // 9. Layer toggles and the tour script run to completion.
  await sim('2024-06-01T18:00:00Z');
  await showingDay('2024-06-01');
  await page.evaluate(() => window.cosmo.setImageryVisible('Earth', 'modis-daily', false));
  assert.equal((await stats()).overlays, 0, 'hiding the layer removes its overlay');
  await page.evaluate(() => window.cosmo.setImageryVisible('Earth', 'modis-daily', true));
  await showingDay('2024-06-01');

  // 10. Imagery section: date, cadence and policy are visible behind the layer's details.
  await page.evaluate(() => window.cosmo.select('Earth'));
  await page.locator('summary', { hasText: 'Imagery' }).first().click();
  await page.getByRole('button', { name: 'MODIS daily true colour details' }).click();
  const section = await page.evaluate(() => document.body.innerText);
  result.checks.section = {
    acquiredLabel: /Acquired 2024-06-01/.test(section),
    dailyCadence: /Daily \(UTC\)/.test(section),
    notSimulationEpoch: /not the simulation epoch/.test(section),
    bakedLighting: /not relit to the simulated Sun/.test(section),
  };
  assert.ok(Object.values(result.checks.section).every(Boolean), `Imagery section should state the acquisition date, cadence and lighting: ${JSON.stringify(result.checks.section)}`);
  // Choosing a date from the section itself.
  await page.getByLabel('MODIS daily true colour date mode').selectOption('fixed');
  await page.getByLabel('MODIS daily true colour observation date, UTC').fill('2024-06-03');
  await showingDay('2024-06-03');
  await page.screenshot({ path: `${out}/imagery-section.png` });
  // Out of range: the section says why nothing is drawn.
  await page.getByLabel('MODIS daily true colour observation date, UTC').fill('1999-12-31');
  await until(() => window.renderer.getBodyMesh('Earth').imageryLayers.find((x) => x.id === 'modis-daily').temporal.state === 'before-range', null, 'section date change did not reach the layer');

  if (live) {
    // What only the real service can tell us.
    const probe = await page.evaluate(async () => {
      const get = async (day) => {
        const u = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${day}/GoogleMapsCompatible_Level9/3/3/2.jpeg`;
        try { const r = await fetch(u, { mode: 'cors' }); return { status: r.status, bytes: r.ok ? (await r.arrayBuffer()).byteLength : 0 }; } catch (e) { return { error: String(e) }; }
      };
      return { first: await get('2024-06-01'), second: await get('2024-06-02'), beforeStart: await get('1999-12-31') };
    });
    result.measurements.live = probe;
    assert.ok(probe.first.status === 200 && probe.second.status === 200, `GIBS must answer CORS tile requests for both days: ${JSON.stringify(probe)}`);
    assert.notEqual(probe.first.bytes, probe.second.bytes, 'two days should be two different images');
    assert.ok(probe.beforeStart.status !== 200, 'a day before the product starts should have no tiles');
  }

  assert.deepEqual(result.errors, [], 'no page or GL errors');
  result.measurements.requestsByDay = Object.fromEntries(requestsByDay);
  result.passed = true;
} finally {
  await writeFile(`${out}/result.json`, JSON.stringify(result, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ mode: result.mode, passed: result.passed, scrub: result.measurements.scrub, seeks: result.measurements.seeks }, null, 2));
