/** Earth from Orbit (`iss` catalog, #368): the public entry against the real GIBS
 * service, in dev or a hosted-style preview build.
 *
 *   node scripts/test-earth-from-orbit.mjs [viewer-url] [output-dir]
 *
 * Checks what a mock cannot. The NOAA-20 VIIRS layer is served to browsers as
 * JPEG tiles on two different days, and those tiles are what changes the globe:
 * with the clock and camera held still, hiding the layer, or swapping its day,
 * changes pixels in a crop of the globe disc (a full-page hash would also change
 * with sunlight or UI). It also checks that the acquisition date is named in the
 * Imagery section, a fixed day ignores the clock, a day before the product shows
 * nothing and requests nothing (Blue Marble stays), and the ISS is drawn only
 * near its TLE epoch. Needs network access to gibs.earthdata.nasa.gov. Software
 * GL is enough.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { viewerBrowserOptions } from './lib/viewer-browser.mjs';

const [base = process.env.CL_VIEWER_URL ?? 'http://localhost:5173/', out = process.env.CL_CAPTURE_DIR ?? '/tmp/cosmolabe-earth-from-orbit'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const VIIRS = /VIIRS_NOAA20_CorrectedReflectance_TrueColor\/default\/(\d{4}-\d{2}-\d{2})\//;
const DAY_A = '2026-11-04'; // the catalog's default day
const DAY_B = '2026-11-03';
const BEFORE_PRODUCT = '2021-12-31';
// Square inside the globe disc at the default viewpoint (1280x800), clear of the rail and panels.
const GLOBE_CROP = { left: 520, top: 260, width: 280, height: 280 };
const TLE_EPOCH = '2026-11-05T20:28:37Z';

const browser = await chromium.launch(viewerBrowserOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(120_000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  /** VIIRS tile responses by `day:status:content-type`. */
  const responses = new Map();
  page.on('response', r => {
    const day = VIIRS.exec(r.url())?.[1];
    if (!day) return;
    const key = `${day}:${r.status()}:${(r.headers()['content-type'] ?? '').split(';')[0]}`;
    responses.set(key, (responses.get(key) ?? 0) + 1);
  });
  const tilesFor = (day) => [...responses].filter(([k]) => k.startsWith(`${day}:`));
  const okTiles = (day) => tilesFor(day).filter(([k]) => k === `${day}:200:image/jpeg`).reduce((n, [, c]) => n + c, 0);

  await page.goto(`${base}?catalog=test-catalogs/iss`);
  await page.waitForFunction(() => window.renderer?.getBodyMesh('Earth')?.imageryLayers?.length === 2 && window.cosmo);
  await page.evaluate(() => window.renderer.waitForInitialAssets());
  await page.evaluate(() => window.cosmo.setPlaying(false));
  const settle = ms => page.evaluate(m => new Promise(r => setTimeout(r, m)), ms);
  const layer = () => page.evaluate(() => window.renderer.getBodyMesh('Earth').imageryLayers.find(l => l.id === 'viirs-daily'));
  const showing = (date) => page.waitForFunction(d => {
    const t = window.renderer.getBodyMesh('Earth').imageryLayers.find(l => l.id === 'viirs-daily').temporal;
    return t.date === d && !t.pendingDate;
  }, date);
  const sim = iso => page.evaluate(t => window.cosmo.setTime({ kind: 'calendar', text: t }), iso);
  const streamed = () => page.waitForFunction(() => window.renderer.getBodyMesh('Earth').surfaceTransitionState === 'streamed');
  const fixDay = (day) => page.evaluate(d => window.renderer.getBodyMesh('Earth').setImageryLayerTime('viirs-daily', { policy: 'fixed', date: d }), day);
  const follow = () => page.evaluate(() => window.renderer.getBodyMesh('Earth').setImageryLayerTime('viirs-daily', { policy: 'follow-simulation' }));
  const setVisible = (visible) => page.evaluate(v => window.cosmo.setImageryVisible('Earth', 'viirs-daily', v), visible);
  const stats = async name => {
    const shot = await page.screenshot({ path: `${out}/${name}.png` });
    return sharp(shot).extract(GLOBE_CROP).removeAlpha().raw().toBuffer();
  };
  /** Mean absolute RGB difference (0..255) between two crops. */
  const diff = (a, b) => {
    assert.equal(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  };

  // 1. First view: Blue Marble under a following VIIRS layer on the simulation day.
  await streamed();
  await settle(10_000);
  let t = (await layer()).temporal;
  assert.deepEqual([t.policy, t.date, t.state, t.cadence, t.illumination], ['follow-simulation', DAY_A, 'exact', 'day', 'baked']);
  assert.equal(t.range.start, '2022-01-14');
  assert.ok(okTiles(DAY_A) > 0, `no VIIRS JPEG tile answered 200 for ${DAY_A}: ${JSON.stringify(tilesFor(DAY_A))}`);

  // 2. The dated overlay is what is drawn. Same clock, same camera: only the layer changes.
  await fixDay(DAY_A);
  await showing(DAY_A);
  await settle(4000);
  const withA = await stats('1-orbit-day-a');
  const withAAgain = await stats('1-orbit-day-a-again');
  const stable = diff(withA, withAAgain);
  assert.ok(stable < 1, `an unchanged view should render the same twice (differs by ${stable.toFixed(2)})`);
  await setVisible(false);
  await settle(4000);
  const hidden = await stats('2-orbit-viirs-hidden');
  const overlayContribution = diff(withA, hidden);
  assert.ok(overlayContribution > 8, `hiding the VIIRS layer should change the globe (mean diff ${overlayContribution.toFixed(2)})`);
  await setVisible(true);
  await fixDay(DAY_B);
  await showing(DAY_B);
  await settle(8000);
  const withB = await stats('3-orbit-day-b');
  const dayChange = diff(withA, withB);
  assert.ok(okTiles(DAY_B) > 0, `no VIIRS JPEG tile answered 200 for ${DAY_B}: ${JSON.stringify(tilesFor(DAY_B))}`);
  assert.ok(dayChange > 4, `two days of VIIRS data should differ on the same globe view (mean diff ${dayChange.toFixed(2)})`);
  for (const day of [DAY_A, DAY_B]) assert.equal(tilesFor(day).filter(([k]) => !k.startsWith(`${day}:200:`)).length, 0, `unexpected ${day} tile responses: ${JSON.stringify(tilesFor(day))}`);
  await follow();
  await showing(DAY_A);

  // 3. The layer is discoverable and says which day it shows; the lighting caveat is stated.
  await page.getByRole('button', { name: 'Surface layers', exact: true }).click();
  await page.getByRole('button', { name: 'Earth imagery', exact: true }).click();
  await page.getByText(`Acquired ${DAY_A} · follows time`).waitFor();
  await page.getByRole('button', { name: 'VIIRS daily true colour details' }).click();
  await page.getByText(/acquisition date, not the simulation epoch/i).waitFor();
  await page.screenshot({ path: `${out}/4-imagery-section.png` });

  // 4. A fixed day ignores the clock; follow resumes it.
  assert.ok(await fixDay(DAY_B));
  await showing(DAY_B);
  await sim('2026-11-05T11:30:00Z');
  await settle(3000);
  t = (await layer()).temporal;
  assert.deepEqual([t.policy, t.date], ['fixed', DAY_B], 'a fixed day must not follow the clock');
  await follow();
  await showing('2026-11-05');

  // 5. Before the product's first day nothing is drawn; Blue Marble stays and nothing is fetched.
  const before = tilesFor(BEFORE_PRODUCT).length;
  await sim(`${BEFORE_PRODUCT}T11:00:00Z`);
  await page.waitForFunction(() => window.renderer.getBodyMesh('Earth').imageryLayers.find(l => l.id === 'viirs-daily').temporal.state === 'before-range', null, { timeout: 30_000 }).catch(async () => {
    throw new Error(`no 'before-range' state: ${JSON.stringify((await layer()).temporal)}`);
  });
  await settle(2000);
  t = (await layer()).temporal;
  assert.equal(t.date ?? null, null, 'no day is named while nothing is shown');
  assert.equal(tilesFor(BEFORE_PRODUCT).length, before, 'no tiles are requested for a day before the product');
  const layers = await page.evaluate(() => window.renderer.getBodyMesh('Earth').imageryLayers.map(x => ({ id: x.id, visible: x.visible })));
  assert.equal(layers.find(l => l.id === 'blue-marble').visible, true);
  await page.screenshot({ path: `${out}/5-before-product.png` });

  // 6. The ISS exists near its TLE epoch and is not extrapolated far from it.
  const present = async iso => {
    await sim(iso);
    await settle(1500); // the mesh follows the existence window on the next frames
    return page.evaluate(() => window.renderer.getBodyMesh('ISS')?.visible === true);
  };
  const dayOffset = (days) => new Date(Date.parse(TLE_EPOCH) + days * 86400_000).toISOString().replace('.000Z', 'Z');
  assert.equal(await present('2026-11-04T11:30:00Z'), true, 'ISS drawn at the default time');
  assert.equal(await present(dayOffset(2.9)), true, 'ISS drawn within 3 days of its TLE epoch');
  assert.equal(await present(dayOffset(3.1)), false, 'ISS not drawn beyond 3 days after its TLE epoch');
  assert.equal(await present(dayOffset(-3.1)), false, 'ISS not drawn beyond 3 days before its TLE epoch');
  assert.equal(await present('2026-03-31T11:00:00Z'), false, 'ISS not drawn months from its TLE epoch');
  assert.equal(await present('2011-02-11T09:45:00Z'), false, 'the old 2011 position is not reproduced');

  assert.deepEqual(errors, []);
  console.log(`Earth from Orbit passed. Globe crop mean diff: overlay ${overlayContribution.toFixed(1)}, day ${dayChange.toFixed(1)}, repeat ${stable.toFixed(2)}. VIIRS responses: ${JSON.stringify(Object.fromEntries(responses))}. Screenshots in ${out}.`);
} finally {
  await browser.close();
}
