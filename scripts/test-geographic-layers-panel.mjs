/** Surface layers panel smoke (#198): the real viewer, catalog loader and UI,
 * driven with pointer and keyboard input. Locates and inspects a Mars feature
 * from the list and from the 3D scene, checks that list, scene highlight,
 * hiding and filtering agree, and captures desktop and phone layouts. */
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

  // Open the panel from the rail: both bodies, their layers, read-only provenance.
  await page.getByRole('button', { name: 'Surface layers' }).click();
  const panel = page.locator('[aria-label="Mars surface layers"]');
  await panel.waitFor();
  assert.ok(await page.locator('[aria-label="Moon surface layers"]').count());
  const marsRow = panel.locator('li.layer').first();
  results.marsLayer = (await marsRow.innerText()).replace(/\s+/g, ' ');
  assert.match(results.marsLayer, /read-only/);

  // Locate a feature from the list: search, select (no camera motion), then fly.
  await panel.getByRole('button', { name: /List features of/ }).first().click();
  const search = page.getByRole('searchbox', { name: 'Search features' });
  await search.fill('traverse');
  const options = page.getByRole('option');
  await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length >= 1);
  results.searchRows = await options.allInnerTexts();
  assert.ok(results.searchRows.every(row => /traverse/i.test(row)), 'search keeps only matching rows');
  const before = await page.evaluate(() => window.renderer.camera.position.toArray());
  await options.first().click();
  const afterSelect = await page.evaluate(() => window.renderer.camera.position.toArray());
  assert.deepEqual(afterSelect, before, 'selecting from the list does not move the camera');
  let state = await scene();
  assert.equal(state.selected?.layerId, 'jezero-science');
  const details = page.locator('[aria-label="Selected feature"]');
  results.listDetails = (await details.innerText()).replace(/\s+/g, ' ');
  assert.match(results.listDetails, /jezero-science \/ string:/);
  assert.match(results.listDetails, /Planetocentric|Planetographic/);
  await details.getByRole('button', { name: /Fly to/ }).click();
  await page.waitForTimeout(2500);
  state = await scene();
  assert.equal(state.tracked, 'Mars');
  await page.screenshot({ path: `${output}/list-select-fly.png` });

  // Select from the scene: click the science target where it is drawn.
  await search.fill('');
  // Escape typed into a text field stays with the field; from the scene it clears the selection.
  await search.press('Escape');
  assert.notEqual((await scene()).selected, null);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Escape');
  state = await scene();
  assert.equal(state.selected, null, 'Escape clears the feature selection');
  const target = await page.evaluate(() => {
    const layer = window.renderer.universe.geographicLayers.get('jezero-science');
    const feature = layer.features.find(f => f.geometry.type === 'Point');
    const [p] = window.renderer.projectGeographicPositions('Mars', [feature.geometry.coordinates], layer.datum);
    return { id: feature.id, ...p };
  });
  assert.ok(target.facing && target.inFront, 'target is on the visible side after flying there');
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(300);
  state = await scene();
  results.sceneClick = { target, selected: state.selected };
  assert.equal(state.selected?.featureId, target.id, '3D click selects the drawn feature');
  assert.match(await details.innerText(), new RegExp(target.id.replace(':', '\\:')));
  assert.equal(await page.locator('[role="option"][aria-selected="true"]').count(), 1, 'list highlights the scene selection');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${output}/scene-select-callout.png` });

  // Keyboard navigation in the list moves the shared selection.
  await page.getByRole('listbox', { name: 'Features' }).focus();
  await page.keyboard.press('ArrowDown');
  state = await scene();
  results.keyboardSelected = state.selected;
  assert.notEqual(state.selected?.featureId, target.id);

  // Hiding the layer removes its draws and pick targets and clears the selection.
  const featuresBefore = state.features;
  await marsRow.getByRole('checkbox').uncheck();
  // Applied on the renderer's next frame.
  await page.waitForFunction(() => window.renderer.geographicVectors.selectedFeature === null);
  state = await scene();
  assert.equal(state.selected, null);
  assert.ok(state.features < featuresBefore, 'hidden layer leaves the drawn set');
  results.hideNotice = await page.locator('.notice').innerText();
  assert.match(results.hideNotice, /hidden/);
  await marsRow.getByRole('checkbox').check();

  // A scene filter draws only the listed features.
  await search.fill('science');
  await page.getByLabel('Filter scene too').check();
  await page.waitForFunction(() => window.renderer.geographicVectors.featureFilter('jezero-science') !== null);
  await page.waitForTimeout(1000);
  state = await scene();
  results.sceneFilter = { drawn: state.features, listed: await options.count() };
  assert.equal(await page.evaluate(() => window.renderer.geographicVectors.featureFilter('jezero-science')?.size), results.sceneFilter.listed);
  await page.getByLabel('Filter scene too').uncheck();
  await search.fill('');

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
  if (!(await page.locator('[aria-label="Mars surface layers"]').count())) await page.getByRole('button', { name: 'Surface layers' }).click();
  await page.locator('[aria-label="Mars surface layers"]').waitFor();
  const denseCount = await page.locator('.feature-browser .count').innerText();
  const renderedRows = await page.getByRole('option').count();
  const listbox = page.getByRole('listbox', { name: 'Features' });
  await listbox.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(200);
  const lastRow = await page.getByRole('option').last().innerText();
  const started = Date.now();
  await page.getByRole('searchbox', { name: 'Search features' }).fill('target-1599');
  await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length <= 5);
  results.dense = { count: denseCount, renderedRows, lastRow: lastRow.split('\n')[0], searchMs: Date.now() - started };
  assert.match(denseCount, /1,601 of 1,601/);
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
