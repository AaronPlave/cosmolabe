/** Geographic styling smoke (#199): the real viewer, shader and UI on the Mars
 * mixed-geometry fixture, through the preset-first Style tab of the Layer view
 * (docs/design/surface-layers-ux.md). Picks a preset, adjusts the common
 * sliders, then shapes, dashes, hatching and a property rule under More
 * options; checks the program compiles, that edits restyle in place (no
 * rebuild, same textures), that labels declutter and sit on the drawn surface
 * close up, that one feature's own colour works from its Feature view, that
 * styles survive a reload and that Reset restores the catalog style. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const output = process.env.CL_OUTPUT ?? 'work/geographic/style-editor';
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5188/';
const browser = await chromium.launch({ executablePath: process.env.CL_CHROMIUM ?? '/opt/pw-browsers/chromium',
  args: process.env.CL_GPU === 'hardware'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = {};
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' || /Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(m.text())) errors.push(m.text()); });

  const open = async () => {
    await page.goto(`${base}?catalog=test-catalogs/geographic-vectors`);
    await page.getByRole('button', { name: 'Surface layers' }).waitFor();
    await page.waitForFunction(() => window.renderer?.geographicVectors.featureCount > 0);
    // Fly over Jezero so every geometry type is on screen.
    if (!(await page.locator('[aria-label="Mars surface layers"], .layer-view').count())) await page.getByRole('button', { name: 'Surface layers' }).click();
    if (await page.locator('[aria-label="Mars surface layers"]').count()) await page.getByRole('button', { name: 'Open Jezero synthetic science' }).click();
    await page.getByRole('radio', { name: 'features' }).click();
    await page.getByRole('option', { name: 'region Area', exact: true }).click();
    await page.getByRole('button', { name: 'Fly to', exact: true }).click();
    await page.waitForTimeout(2500);
    // Back to the layer: nothing selected, so the baseline has no highlight passes.
    await page.getByRole('button', { name: 'Jezero synthetic science', exact: true }).click();
  };
  /** Wait for the renderer to draw a frame after a change. */
  const frames = (n = 2) => page.evaluate(n => new Promise(resolve => {
    const r = window.renderer.geographicVectors, begin = r.begin.bind(r); let seen = 0;
    r.begin = () => { begin(); if (++seen >= n) { r.begin = begin; resolve(); } };
  }), n);
  const state = () => page.evaluate(() => {
    const v = window.renderer.geographicVectors;
    const batch = v.batches[0];
    return { metrics: v.metrics, style: v.getStyle('jezero-science'), recordsId: batch?.material.textures[0].uuid, program: batch?.material.uuid };
  });

  await open();
  await frames();
  await page.screenshot({ path: `${output}/defaults.png` });
  const before = await state();

  // Style tab: a preset, then the common adjustments.
  await page.getByRole('radio', { name: 'style' }).click();
  const editor = page.locator('[aria-label="Style of Jezero synthetic science"]');
  await editor.waitFor();
  await editor.getByRole('button', { name: 'Orange' }).click();
  await editor.getByLabel('Point size').fill('16');
  await editor.getByLabel('Line width').fill('5');
  await editor.getByLabel('Fill', { exact: true }).fill('0.4');
  // Expert options wait under More options.
  assert.equal(await editor.getByRole('group', { name: 'Points' }).isVisible(), false, 'shapes are not in the default view');
  await editor.locator('summary', { hasText: 'More options' }).click();
  await editor.getByRole('group', { name: 'Points' }).getByRole('radio', { name: 'diamond' }).click();
  await editor.getByRole('group', { name: 'Points' }).getByLabel('Halo').check();
  await editor.getByRole('group', { name: 'Lines' }).getByLabel('Dashed').check();
  await editor.getByRole('group', { name: 'Areas' }).getByLabel('Hatch').check();
  await page.waitForTimeout(300);
  await frames();
  const styled = await state();
  results.styled = styled;
  assert.deepEqual(styled.style.point, { color: '#e69f00', sizePx: 16, shape: 'diamond', halo: true });
  assert.deepEqual(styled.style.line, { color: '#e69f00', widthPx: 5, dashed: true });
  assert.equal(styled.style.polygon.outlineWidthPx, 5);
  assert.equal(styled.style.polygon.fillOpacity, 0.4);
  assert.equal(styled.metrics.batches, before.metrics.batches, 'no rebuild');
  assert.equal(styled.recordsId, before.recordsId, 'same record texture');
  assert.equal(styled.program, before.program, 'same material, no recompile');
  assert.ok(styled.metrics.restyles >= 1);
  assert.equal(styled.metrics.textureBytes, before.metrics.textureBytes, 'no new texture memory');
  await page.screenshot({ path: `${output}/styled.png` });

  // Colour by a property: a legend from actual values.
  await editor.getByRole('group', { name: 'Colour by' }).getByRole('radio', { name: 'category' }).click();
  await page.waitForTimeout(200);
  results.legend = await editor.getByRole('list', { name: 'Legend' }).innerText();
  assert.match(results.legend, /traverse/);
  await page.waitForTimeout(300);
  await frames();
  await page.screenshot({ path: `${output}/category.png` });
  // A preset returns to one colour.
  await editor.getByRole('button', { name: 'Sky' }).click();
  await page.waitForTimeout(200);
  assert.equal((await state()).style.rule, null);

  // Labels, decluttered and bounded.
  await editor.getByLabel('Labels', { exact: true }).check();
  await page.waitForTimeout(800);
  results.labels = await page.locator('.geo-label').allInnerTexts();
  assert.ok(results.labels.length > 0 && results.labels.length <= 40);
  await page.screenshot({ path: `${output}/labels.png` });

  // Close up, the drawn globe departs from the datum: a point label's anchor
  // must sit on the drawn point (its own, or one drawn at the same spot).
  await page.getByRole('radio', { name: 'features' }).click();
  await page.getByRole('option', { name: /^Jezero science target Point/ }).click();
  await page.getByRole('button', { name: 'Fly to', exact: true }).click();
  await page.waitForTimeout(3000);
  // The selection's callout names it; back on the layer, its label shows.
  await page.getByRole('button', { name: 'Jezero synthetic science', exact: true }).click();
  await page.waitForTimeout(800);
  results.closeUp = await page.evaluate(() => {
    const r = window.renderer, layer = r.universe.geographicLayers.get('jezero-science');
    return [...document.querySelectorAll('.geo-label')].flatMap(el => {
      const feature = layer.features.find(f => `${layer.id}/${f.id}` === el.dataset.key);
      if (!feature || !/Point/.test(feature.geometry.type)) return [];
      const [, x, y] = el.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/).map(Number);
      const hit = r.pickScene(x, y, 'select');
      return [{ label: feature.id, x, y, picked: hit?.kind === 'geographic-feature' ? hit.featureId : hit?.kind ?? null }];
    });
  });
  assert.ok(results.closeUp.length > 0, 'a point is labelled close up');
  for (const l of results.closeUp) assert.match(String(l.picked), /^string:(science|sites)$/, `label ${l.label} sits on a drawn point`);
  await page.screenshot({ path: `${output}/labels-close-up.png` });

  // One feature's own colour, from its Feature view; the layer is unchanged.
  await page.getByRole('option', { name: /^traverse Line/ }).click();
  const featureStyle = page.getByRole('group', { name: 'Feature style' });
  await page.locator('summary', { hasText: 'Appearance' }).click();
  await featureStyle.getByLabel('Give this feature its own colour').check();
  await page.waitForTimeout(200);
  results.ownColour = (await state()).style.features;
  assert.ok(results.ownColour?.['string:traverse'], 'the feature has its own colour');
  await featureStyle.getByLabel('Give this feature its own colour').uncheck();
  await page.waitForTimeout(200);
  assert.ok(!(await state()).style.features, 'the feature follows its layer again');
  await page.keyboard.press('Escape');

  // Styles survive a reload of the same catalog.
  const kept = (await state()).style;
  await open();
  await frames();
  results.reloaded = (await state()).style;
  // Absent and null/undefined parts mean the same style.
  const same = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === null ? undefined : v)));
  assert.deepEqual(same(results.reloaded), same(kept));

  // Reset returns to the catalog style.
  if (await page.locator('[aria-label="Mars surface layers"]').count()) await page.getByRole('button', { name: 'Open Jezero synthetic science' }).click();
  await page.getByRole('radio', { name: 'style' }).click();
  await editor.getByRole('button', { name: /Reset to catalog style/ }).click();
  await frames();
  assert.equal((await state()).style, null);
  assert.equal(await page.locator('.geo-label').count(), 0);

  // Narrow viewport: the Style tab in the phone sheet.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await editor.waitFor();
  await editor.evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `${output}/compact.png` });

  results.errors = errors;
  await writeFile(`${output}/editor.json`, JSON.stringify(results, null, 2) + '\n');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
