/** Run against a normally built, hosted-catalog-rewritten viewer. No interception.
 * node scripts/test-hosted-lro.mjs VIEWER_URL OUTPUT_DIR
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { loadDatasets } from './data-hosting/lib/datasets.mjs';
import { rewriteCatalog } from './data-hosting/lib/hosted-catalogs.mjs';
const [base, out] = process.argv.slice(2);
assert.ok(base && out, 'VIEWER_URL OUTPUT_DIR required');
await mkdir(out, { recursive: true });
const source = JSON.parse(await readFile('apps/viewer/test-catalogs/lro-moon.json', 'utf8'));
const expected = rewriteCatalog(source, 'test-catalogs/lro-moon.json', loadDatasets().datasets, 'https://data.aaronplave.com').json;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const report = { passed: false, errors: [], views: [], hostedRequests: 0 };
page.on('pageerror', error => report.errors.push(error.message));
page.on('response', response => {
  if (response.url().startsWith('https://data.aaronplave.com/')) {
    if (response.ok()) report.hostedRequests++;
    else report.errors.push(`${response.status()} ${response.url()}`);
  }
});
try {
  const response = await page.goto(new URL('test-catalogs/lro-moon.json', base).href);
  assert.equal(response.status(), 200);
  assert.deepEqual(await response.json(), expected);
  for (let reload = 0; reload < 2; reload++) {
    await page.goto(`${base}?catalog=test-catalogs/lro-moon&test=1`);
    await page.waitForFunction(() => window.__cosmolabe?.assetsReady, null, { timeout: 180000 });
    await page.evaluate(() => window.cosmo.setPlaying(false));
    for (const view of ['Track LRO', 'Moon Overview', 'LRO Close-up', 'Lunar North Pole']) {
      assert.equal(await page.evaluate(view => window.cosmo.viewpoint(view), view), true);
      await page.waitForFunction(() => {
        const t = window.renderer?.getBodyMesh('Moon')?.terrainManager;
        return t?.frameAvailability.kind === 'available' && t.cubeStats?.residentTiles > 0 && t.cubeImageryStats?.ready;
      }, null, { timeout: 180000 });
      const state = await page.evaluate(() => {
        const r = window.renderer, b = r.getBodyMesh('Moon');
        const hit = r.pickSurface(0, 0);
        return { frame: b.terrainManager.frameAvailability, terrain: b.terrainManager.cubeStats,
          imagery: b.terrainManager.cubeImageryStats, pick: hit };
      });
      report.views.push({ reload, view, ...state });
      await page.screenshot({ path: `${out}/${reload}-${view.replaceAll(' ', '-')}.png` });
    }
  }
  assert.ok(report.hostedRequests > 0);
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await writeFile(`${out}/metrics.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
