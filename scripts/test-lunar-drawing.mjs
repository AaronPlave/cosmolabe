/** Lunar drawing regression: saved IAU annotations and the New layer form.
 * node scripts/test-lunar-drawing.mjs VIEWER_URL OUTPUT_DIR
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const [base, out] = process.argv.slice(2);
assert.ok(base && out, 'VIEWER_URL OUTPUT_DIR required');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH,
  channel: process.env.CHROMIUM_PATH ? undefined : 'chrome',
  args: ['--enable-gpu', '--ignore-gpu-blocklist', process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const old = { id: 'user:moon:my-annotations-moon', name: 'My annotations · Moon', body: 'Moon',
  coordinates: { latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180', referenceShape: { kind: 'sphere', radiusKm: 1737.4 } },
  features: [{ id: 'user-1', properties: { name: 'Existing note' }, geometry: { type: 'Point', coordinates: [10, 20] } }], nextId: 2 };
const report = { passed: false, errors: [] };
page.on('pageerror', error => report.errors.push(error.message));
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('cosmolabe-geographic-edits')).layers);
const drawPoint = async () => {
  const bar = page.getByRole('toolbar', { name: 'Drawing', exact: true });
  await bar.getByRole('button', { name: 'Point', exact: true }).click();
  const hit = await page.evaluate(() => window.renderer.pickScene(850, 450, 'probe', { renderedOnly: true }));
  assert.equal(hit?.point?.bodyName, 'Moon');
  assert.equal(hit.point.frame, 'MOON_ME_DE421');
  await page.mouse.click(850, 450);
  await page.getByRole('toolbar', { name: 'Editing shape', exact: true }).waitFor();
};
try {
  await page.addInitScript(old => {
    if (!localStorage.getItem('cosmolabe-geographic-edits')) localStorage.setItem('cosmolabe-geographic-edits', JSON.stringify({ format: 'cosmolabe-geographic-edits', version: 1, layers: [old] }));
  }, old);
  await page.goto(`${base}?catalog=test-catalogs/lro-moon&test=1`);
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, null, { timeout: 120000 });
  await page.evaluate(() => { window.cosmo.setPlaying(false); window.cosmo.viewpoint('Moon Overview'); });
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: 'Surface layers', exact: true }).click();
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await drawPoint();
  const layers = await stored();
  assert.deepEqual(layers.find(l => l.id === old.id), old, 'saved coordinates remain unchanged');
  const annotations = layers.find(l => l.id !== old.id);
  assert.equal(annotations.coordinates.frame, 'MOON_ME_DE421');
  assert.equal(annotations.features.length, 1);
  await page.screenshot({ path: `${out}/saved-layer.png` });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  for (let n = 0; n < 3 && !(await page.getByRole('button', { name: 'More layer actions' }).count()); n++) await page.locator('nav button').first().click();
  await page.getByRole('button', { name: 'More layer actions' }).click();
  await page.getByRole('menuitem', { name: 'New layer…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Lunar drawing regression');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Draw in this layer', exact: true }).click();
  await drawPoint();
  let final = await stored();
  const created = final.find(l => l.name === 'Lunar drawing regression');
  assert.equal(created.coordinates.frame, 'MOON_ME_DE421');
  assert.equal(created.features.length, 1, 'the point goes into the layer created with the form');
  assert.equal(await page.evaluate(() => window.renderer.geographicVectors.selectedFeature.layerId), created.id);
  await page.screenshot({ path: `${out}/new-layer.png` });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Draw in this layer', exact: true }).click();
  await page.getByLabel('Draw into', { exact: true }).click();
  await page.getByRole('option', { name: annotations.name, exact: true }).click();
  await drawPoint();
  final = await stored();
  assert.equal(final.find(l => l.id === annotations.id).features.length, 2, 'explicit dropdown target receives the point');
  assert.equal(final.find(l => l.id === created.id).features.length, 1, 'open layer does not override the target');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  for (const frame of ['MOON_ME_DE421', 'IAU_MOON']) {
    for (let n = 0; n < 3 && !(await page.getByRole('button', { name: 'More layer actions' }).count()); n++) await page.locator('nav button').first().click();
    await page.locator('input[type="file"]').setInputFiles({ name: `${frame}.geojson`, mimeType: 'application/geo+json',
      buffer: Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [10, 20] } },
      ] })) });
    const form = page.getByRole('region', { name: 'Import GeoJSON', exact: true });
    await form.waitFor();
    assert.equal(await form.getByRole('button', { name: 'Import', exact: true }).isDisabled(), true, 'source frame must be declared');
    await form.getByLabel('Coordinate frame', { exact: true }).selectOption(frame);
    await form.getByRole('button', { name: 'Import', exact: true }).click();
    const imported = (await stored()).find(l => l.name === frame);
    assert.equal(imported.coordinates.frame, frame);
    assert.deepEqual(imported.features[0].geometry.coordinates, [10, 20], 'import does not transform source values');
  }
  final = await stored();
  await page.screenshot({ path: `${out}/import-frame.png` });

  await page.reload();
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, null, { timeout: 120000 });
  assert.deepEqual(await stored(), final, 'all layers survive reload');
  report.layers = final;
  report.gpu = await page.evaluate(() => { const gl = window.renderer.renderer.getContext(); const ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); });
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await writeFile(`${out}/metrics.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
