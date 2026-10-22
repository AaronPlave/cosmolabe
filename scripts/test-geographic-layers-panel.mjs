/** Surface layers panel smoke (#198): the real viewer, catalog loader and UI,
 * driven with pointer and keyboard input through the acceptance scenarios of
 * docs/design/surface-layers-ux.md, counting user actions. Locates and
 * inspects a Mars feature from the search and from the 3D scene, checks that
 * the views follow the selection, that hiding and filtering agree with the
 * scene, and captures desktop and phone layouts. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const output = process.env.CL_OUTPUT ?? 'docs/validation/geographic-layers-panel';
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5188/';
const browser = await chromium.launch({ executablePath: process.env.CL_CHROMIUM ?? '/opt/pw-browsers/chromium',
  args: process.env.CL_GPU === 'hardware'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = {};
try {
  await mkdir(output, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await page.goto(`${base}?catalog=test-catalogs/geographic-vectors`);
  await page.getByRole('button', { name: 'Surface layers' }).waitFor();
  await page.waitForFunction(() => window.renderer?.geographicVectors.featureCount > 0);
  const scene = () => page.evaluate(() => {
    const v = window.renderer.geographicVectors;
    return { selected: v.selectedFeature, features: v.featureCount, tracked: window.renderer.cameraController.focusBody?.body.name ?? null };
  });

  /** Counts what a user does: each click, key press or typed search is one action. */
  const counted = {};
  let scenario = null;
  const act = async (fn) => { counted[scenario] = (counted[scenario] ?? 0) + 1; await fn(); };
  const marsList = page.locator('[aria-label="Mars surface layers"]');
  const details = page.locator('[aria-label="Selected feature"]');

  // Scenario 1: show a hidden layer and open a named feature.
  // Set-up (not counted): the Jezero layer starts hidden.
  await page.getByRole('button', { name: 'Surface layers' }).click();
  await marsList.waitFor();
  assert.ok(await page.locator('[aria-label="Moon surface layers"]').count());
  results.marsLayer = (await marsList.locator('li.layer').first().innerText()).replace(/\s+/g, ' ');
  await marsList.getByRole('button', { name: 'Hide Jezero synthetic science' }).click();
  await page.getByRole('button', { name: 'Close Surface layers' }).click();
  scenario = 'showLayerAndOpenFeature';
  const before = await page.evaluate(() => window.renderer.camera.position.toArray());
  await act(() => page.getByRole('button', { name: 'Surface layers' }).click());
  await act(() => marsList.getByRole('button', { name: 'Show Jezero synthetic science' }).click());
  await act(() => page.getByRole('searchbox', { name: 'Search all features' }).fill('traverse'));
  const results1 = page.getByRole('list', { name: 'Search results' }).getByRole('button');
  results.searchRows = (await results1.allInnerTexts()).map(r => r.replace(/\s+/g, ' '));
  assert.ok(results.searchRows.length >= 1 && results.searchRows.every(row => /traverse/i.test(row)), 'search keeps only matching features');
  await act(() => results1.first().click());
  await details.waitFor();
  assert.deepEqual(await page.evaluate(() => window.renderer.camera.position.toArray()), before, 'opening a feature does not move the camera');
  let state = await scene();
  assert.equal(state.selected?.layerId, 'jezero-science');
  results.listDetails = (await details.innerText()).replace(/\s+/g, ' ');
  assert.match(results.listDetails, /traverse/);
  assert.equal(await marsList.count(), 0, 'the Feature view replaces the list');
  await page.screenshot({ path: `${output}/feature-view.png` });
  // Back lands on the layer, then the list.
  await page.getByRole('button', { name: /^Jezero synthetic science$/ }).first().click();
  await page.locator('[aria-label="Layer Jezero synthetic science"]').waitFor();
  assert.equal((await scene()).selected, null, 'back clears the selection');
  await page.locator('[aria-label="Layer Jezero synthetic science"] details', { hasText: 'About this layer' }).locator('summary').click();
  results.about = (await page.locator('[aria-label="Layer Jezero synthetic science"] details', { hasText: 'About this layer' }).innerText()).replace(/\s+/g, ' ');
  assert.match(results.about, /Planetocentric|Planetographic/);
  await page.screenshot({ path: `${output}/layer-view.png` });

  // Keyboard: arrows skim the list (highlighting in 3D), Enter opens.
  await page.getByRole('listbox', { name: 'Features' }).focus();
  await page.keyboard.press('ArrowDown');
  assert.equal((await scene()).selected, null, 'skimming does not select');
  assert.equal(await page.locator('[role="option"][aria-selected="true"]').count(), 1, 'the skimmed row is marked');
  await page.keyboard.press('Enter');
  await details.waitFor();
  results.keyboardSelected = (await scene()).selected;
  assert.ok(results.keyboardSelected);
  // Next steps through the layer without going back.
  await details.getByRole('button', { name: 'Next feature' }).click();
  assert.notEqual((await scene()).selected?.featureId, results.keyboardSelected.featureId);
  await details.getByRole('button', { name: 'Fly to' }).click();
  await page.waitForTimeout(2500);
  assert.equal((await scene()).tracked, 'Mars');
  await page.screenshot({ path: `${output}/list-select-fly.png` });
  await page.keyboard.press('Escape');

  // Scenario 2: select a shape in 3D, fly to it from its callout, open it.
  scenario = 'select3dFlyInspect';
  await page.getByRole('button', { name: 'Close Surface layers' }).click();
  const target = await page.evaluate(() => {
    const layer = window.renderer.universe.geographicLayers.get('jezero-science');
    const feature = layer.features.find(f => f.geometry.type === 'Point');
    const [p] = window.renderer.projectGeographicPositions('Mars', [feature.geometry.coordinates], layer.datum);
    return { id: feature.id, ...p };
  });
  assert.ok(target.facing && target.inFront, 'target is on the visible side after flying there');
  await act(() => page.mouse.click(target.x, target.y));
  await page.waitForTimeout(300);
  state = await scene();
  results.sceneClick = { target, selected: state.selected };
  assert.equal(state.selected?.featureId, target.id, '3D click selects the drawn feature');
  assert.equal(await page.locator('[aria-label="Mars surface layers"], [aria-label="Selected feature"]').count(), 0, 'a scene click opens nothing');
  const cameraBefore = await page.evaluate(() => window.renderer.camera.position.toArray());
  await act(() => page.getByRole('button', { name: /^Fly to / }).click());
  await page.waitForTimeout(2500);
  assert.notDeepEqual(await page.evaluate(() => window.renderer.camera.position.toArray()), cameraBefore, 'the callout flies');
  await page.screenshot({ path: `${output}/scene-select-callout.png` });
  await act(() => page.locator('.callout .label').click());
  await details.waitFor();
  assert.match(await details.innerText(), /science/i);

  // Back lands on the layer; hiding it takes its features out of the scene.
  await page.getByRole('button', { name: 'Jezero synthetic science', exact: true }).click();
  assert.equal((await scene()).selected, null);
  const drawnBefore = (await scene()).features;
  await page.getByRole('button', { name: 'Hide Jezero synthetic science' }).click();
  await page.waitForFunction((n) => window.renderer.geographicVectors.featureCount < n, drawnBefore);
  await page.getByRole('button', { name: 'Show Jezero synthetic science' }).click();
  await page.waitForFunction((n) => window.renderer.geographicVectors.featureCount === n, drawnBefore);

  // Filters wait behind "Filter"; hiding non-matching features in 3D.
  await page.getByRole('searchbox', { name: 'Search features' }).fill('science');
  await page.locator('summary', { hasText: 'Filter' }).click();
  await page.getByLabel('Hide non-matching features in 3D').check();
  await page.waitForFunction(() => window.renderer.geographicVectors.featureFilter('jezero-science') !== null);
  await page.waitForTimeout(1000);
  state = await scene();
  results.sceneFilter = { drawn: state.features, listed: await page.getByRole('option').count() };
  assert.equal(await page.evaluate(() => window.renderer.geographicVectors.featureFilter('jezero-science')?.size), results.sceneFilter.listed);
  await page.getByLabel('Hide non-matching features in 3D').uncheck();
  await page.getByRole('searchbox', { name: 'Search features' }).fill('');

  results.actions = counted;
  assert.ok(counted.showLayerAndOpenFeature <= 4, `scenario 1 in ${counted.showLayerAndOpenFeature} actions`);
  assert.ok(counted.select3dFlyInspect <= 3, `scenario 2 in ${counted.select3dFlyInspect} actions`);

  // Phone layout: the panel is the one sheet.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${output}/compact.png` });

  // The dense catalog drapes on the local measured Mars pyramid, which is not
  // in Git. Without it the terrain requests fail; the vectors and panel do not depend on it.
  const terrainMissing = !existsSync('apps/viewer/test-catalogs/data/mars-terrain-fused');
  const errorsBeforeDense = errors.length;
  // A dense layer: 1,601 features, a bounded number of rendered rows, and search that keeps up.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base}?catalog=test-catalogs/geographic-vectors-jezero-dense`);
  await page.getByRole('button', { name: 'Surface layers' }).waitFor();
  await page.waitForFunction(() => window.renderer?.geographicVectors.featureCount > 0);
  if (!(await page.locator('.feature-browser').count())) await page.getByRole('button', { name: 'Surface layers' }).click();
  // The only layer opens straight to its features.
  await page.locator('.feature-browser').waitFor();
  const denseCount = await page.locator('.layer-view .meta').innerText();
  const renderedRows = await page.getByRole('option').count();
  const listbox = page.getByRole('listbox', { name: 'Features' });
  await listbox.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(200);
  const lastRow = await page.getByRole('option').last().innerText();
  const started = Date.now();
  await page.getByRole('searchbox', { name: 'Search features' }).fill('target-1599');
  await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length <= 5);
  results.dense = { count: denseCount, renderedRows, lastRow: lastRow.split('\n')[0], searchMs: Date.now() - started };
  assert.match(denseCount, /1,601 features/);
  assert.ok(renderedRows < 40, 'only rows in view are rendered');
  await page.screenshot({ path: `${output}/dense-search.png` });

  if (terrainMissing) {
    const dense = errors.splice(errorsBeforeDense);
    results.denseTerrainMissing = dense;
    errors.push(...dense.filter(e => !/"Not found" is not valid JSON/.test(e)));
  }
  results.errors = errors;
  await writeFile(`${output}/panel.json`, JSON.stringify(results, null, 2) + '\n');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
