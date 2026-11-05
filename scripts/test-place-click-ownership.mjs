/** One owner for a click on a named place (#191 Places, #198 Surface layers),
 * in the real viewer with the real Gazetteer. A scene click on a named point
 * selects it in Places alone: Navigate shows it, Surface layers keeps no
 * selection (no callout, no second inspector). Escape closes Navigate, then
 * lets go of the place. Browsing to the same point in Surface layers selects it
 * there and lets go of the place; a later scene click hands it back to Places.
 * A double-click still flies there through Places.
 *
 * Env: CL_VIEWER_URL (default http://127.0.0.1:5194/), CL_GPU=hardware. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5194/';
const hardware = process.env.CL_GPU === 'hardware';
const browser = await chromium.launch({ executablePath: hardware ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.env.CL_CHROMIUM,
  args: hardware ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const checks = [], errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(45000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { window.__module = (path) => import(performance.getEntriesByType('resource').map((e) => e.name).filter((url) => new URL(url).pathname === path).at(-1) ?? path); });
  await page.goto(`${base}?catalog=test-catalogs/planetary-places`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.renderer?.placeNames?.index.places.length > 0);
  await page.evaluate(async () => {
    await window.renderer.waitForInitialAssets(); window.cosmo.setPlaying(false);
    window.s = await window.__module('/src/lib/viewer-state.svelte.ts'); window.p = await window.__module('/src/lib/places.ts');
    window.sh = await window.__module('/src/lib/shell.svelte.ts'); window.g = await window.__module('/src/lib/geographic-layers.svelte.ts');
    window.arena = window.renderer.placeNames.index.search('Arena Colles', { body: 'Mars' }).find((p) => p.name === 'Arena Colles');
    window.arenaRef = { layerId: window.arena.layer.id, featureId: window.arena.feature.id, bodyName: 'Mars' };
    window.p.showPlaceBody('Mars', true);
    const pos = window.arena.feature.geometry.coordinates;
    window.s.goToCoordinates({ bodyName: 'Mars', latDeg: pos.latDeg, lonDeg: pos.lonDeg, latitude: 'planetographic', longitudeDirection: 'east' }, { animate: false, rangeKm: 200 });
    window.s.releaseSurfaceTarget(); window.p.selectPlace(null);
    for (const tool of window.sh.TOOL_IDS) window.sh.closeTool(tool);
  });
  const label = page.locator('.cl-place-name').filter({ hasText: /^Arena Colles$/ });
  await page.waitForFunction(() => [...document.querySelectorAll('.cl-place-name')].some((e) => e.textContent === 'Arena Colles' && Number(e.style.opacity) > 0.6));
  const state = () => page.evaluate(() => ({
    place: window.s.vs.selectedPlaceRef === window.arena.ref ? 'arena' : window.s.vs.selectedPlaceRef,
    surface: window.g.geo.selected?.featureId ?? null, highlight: window.renderer.geographicVectors.selectedFeature?.featureId ?? null,
    navigate: window.sh.isToolOpen('navigate'), layers: window.sh.isToolOpen('layers'), callouts: document.querySelectorAll('.callout').length,
  }));
  const click = async () => { const b = await label.boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(400); };

  await click();
  assert.deepEqual(await state(), { place: 'arena', surface: null, highlight: null, navigate: true, layers: false, callouts: 0 });
  checks.push('a scene click on a named place selects it in Places only: Navigate, no Surface layers selection or callout');
  await page.keyboard.press('Escape');
  assert.deepEqual(await state(), { place: 'arena', surface: null, highlight: null, navigate: false, layers: false, callouts: 0 });
  await page.keyboard.press('Escape');
  assert.equal((await state()).place, null);
  checks.push('Escape closes Navigate, then lets go of the place');

  await page.evaluate(() => window.p.selectPlace(window.arena));
  await page.evaluate(() => window.g.selectFeature(window.arenaRef));
  const browsed = await state();
  assert.equal(browsed.place, null); assert.equal(browsed.surface, await page.evaluate(() => window.arena.feature.id)); assert.equal(browsed.highlight, browsed.surface);
  await click();
  assert.deepEqual(await state(), { place: 'arena', surface: null, highlight: null, navigate: true, layers: false, callouts: 0 });
  checks.push('browsing to the place in Surface layers selects it there and lets go of Places; a scene click hands it back');

  await page.evaluate(() => { window.p.selectPlace(null); window.sh.closeTool('navigate'); });
  const b = await label.boundingBox();
  await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2, { delay: 60 });
  await page.waitForFunction(() => window.s.vs.surfaceTarget?.place?.name === 'Arena Colles');
  const flown = await state();
  assert.equal(flown.place, 'arena'); assert.equal(flown.surface, null); assert.equal(flown.callouts, 0);
  checks.push('a double-click flies there through Places, still with one selection');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
console.log(JSON.stringify({ checks, errors }, null, 2));
