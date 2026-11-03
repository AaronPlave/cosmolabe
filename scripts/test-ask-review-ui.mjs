/** #334 catalog-unload regression in the ordinary loaded viewer; no provider. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const output = process.env.ASK_REVIEW_OUTPUT ?? '/tmp/297-final-usability-ui';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5797/'}?catalog=test-catalogs/cassini-soi`);
  await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 120000 });
  await page.evaluate(() => window.cosmo.select('Mimas'));
  await page.getByText('Mimas', { exact: true }).first().waitFor();
  await page.screenshot({ path: `${output}/before-switch.png` });
  const events = await page.evaluate(async () => {
    const resource = path => performance.getEntriesByType('resource').map(e => e.name).find(u => new URL(u).pathname === path);
    const loader = await import(resource('/src/lib/loader.ts')), state = await import(resource('/src/lib/viewer-state.svelte.ts'));
    window.__reviewSelections = [];
    window.cosmo.on('select', value => window.__reviewSelections.push(value));
    await loader.loadDemo(state.getRenderer().renderer.domElement, 'test-catalogs/ingenuity-jezero', 'Ingenuity review');
    return window.__reviewSelections;
  });
  await page.waitForFunction(() => window.cosmo?.getScene()?.ready && window.cosmo.listObjects().includes('Ingenuity'), null, { timeout: 120000 });
  assert.equal(await page.evaluate(() => window.cosmo.getSelected()), null);
  assert.ok(events.some(e => e.name === null));
  assert.equal(await page.getByText('Mimas', { exact: true }).count(), 0, 'previous body panel has gone');
  await page.screenshot({ path: `${output}/after-switch.png` });
  await page.evaluate(() => window.cosmo.select('Mars'));
  assert.equal(await page.evaluate(() => window.cosmo.getSelected()), 'Mars');
  await page.getByText('Mars', { exact: true }).first().waitFor();
  await page.screenshot({ path: `${output}/fresh-selection.png` });
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/catalog-switch.json`, JSON.stringify({ status: 'passed', from: 'cassini-soi', selectedBefore: 'Mimas', to: 'ingenuity-jezero', selectedAfter: null, freshSelection: 'Mars', events, errors }, null, 2) + '\n');
} finally { await browser.close(); }
