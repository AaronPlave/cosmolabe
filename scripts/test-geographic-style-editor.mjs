/** Geographic style editor smoke (#199): the real viewer, shader and UI on the
 * Mars mixed-geometry fixture. Edits point, line and polygon styles and a
 * property rule through the controls, checks that the program compiles, that
 * edits restyle in place (no rebuild, same textures), that labels declutter,
 * that styles survive a reload and that Revert/Reset restore the defaults. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const output = process.env.CL_OUTPUT ?? 'docs/validation/geographic-style-editor';
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
    await page.getByRole('button', { name: 'Surface layers' }).click();
    await page.getByRole('button', { name: /List features of Jezero/ }).click();
    await page.getByRole('option', { name: 'region Polygon', exact: true }).dblclick();
    await page.waitForTimeout(2500);
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

  // Style tab, through the controls.
  await page.getByRole('button', { name: 'Style Jezero synthetic science' }).click();
  const editor = page.locator('[aria-label="Style and properties of Jezero synthetic science"]');
  await editor.waitFor();
  const points = editor.getByRole('group', { name: 'Points' });
  await points.getByLabel('Size').fill('16');
  await points.getByRole('radio', { name: 'diamond' }).click();
  await points.getByLabel('Halo').check();
  const lines = editor.getByRole('group', { name: 'Lines' });
  await lines.getByLabel('Width').fill('5');
  await lines.getByLabel('Dashed').check();
  const polygons = editor.getByRole('group', { name: 'Polygons' });
  await polygons.getByLabel('Fill opacity').fill('0.4');
  await polygons.getByLabel('Hatch').check();
  await polygons.getByLabel('Outline width').fill('4');
  await page.waitForTimeout(300);
  await frames();
  const styled = await state();
  results.styled = styled;
  assert.deepEqual(styled.style.point, { sizePx: 16, shape: 'diamond', halo: true });
  assert.deepEqual(styled.style.line, { widthPx: 5, dashed: true });
  assert.equal(styled.metrics.batches, before.metrics.batches, 'no rebuild');
  assert.equal(styled.recordsId, before.recordsId, 'same record texture');
  assert.equal(styled.program, before.program, 'same material, no recompile');
  assert.ok(styled.metrics.restyles >= 1);
  assert.equal(styled.metrics.textureBytes, before.metrics.textureBytes, 'no new texture memory');
  await page.screenshot({ path: `${output}/styled.png` });

  // Colour by a property: a legend from actual values.
  await editor.getByRole('radio', { name: 'category' }).click();
  await page.waitForTimeout(200);
  results.legend = await editor.getByRole('list', { name: 'Legend' }).innerText();
  assert.match(results.legend, /traverse/);
  await page.waitForTimeout(300);
  await frames();
  await page.screenshot({ path: `${output}/category.png` });

  // Labels, decluttered and bounded.
  await editor.getByRole('radio', { name: 'labels' }).click();
  await editor.getByLabel('Show labels').check();
  await page.waitForTimeout(800);
  results.labels = await page.locator('.geo-label').allInnerTexts();
  assert.ok(results.labels.length > 0 && results.labels.length <= 40);
  await page.screenshot({ path: `${output}/labels.png` });

  // Styles survive a reload of the same catalog.
  const kept = (await state()).style;
  await open();
  await frames();
  results.reloaded = (await state()).style;
  assert.deepEqual(results.reloaded, kept);

  // Revert undoes changes since the editor opened; Reset returns to catalog defaults.
  await page.getByRole('button', { name: 'Style Jezero synthetic science' }).click();
  await editor.getByRole('group', { name: 'Points' }).getByLabel('Size').fill('20');
  await page.waitForTimeout(200);
  await editor.getByRole('button', { name: /Revert/ }).click();
  assert.equal((await state()).style.point.sizePx, 16);
  await editor.getByRole('button', { name: /Reset/ }).click();
  await frames();
  assert.equal((await state()).style, null);
  assert.equal(await page.locator('.geo-label').count(), 0);

  // Narrow viewport: the editor (still open) in the phone sheet.
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
