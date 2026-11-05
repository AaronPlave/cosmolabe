/** Loaded public discovery and unmodified ?entry= tour, in dev or preview. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5208/';
const output = process.env.CL_CAPTURE_DIR ?? '/tmp/cosmolabe-catalog-curation';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=' + (process.env.CL_ANGLE ?? (process.platform === 'darwin' ? 'metal' : 'gl')), '--ignore-gpu-blocklist', '--enable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.getByRole('button', { name: 'Browse examples', exact: true }).waitFor();
  assert.equal(await page.locator('.start-row').count(), 6);
  await page.screenshot({ path: `${output}/home.png` });
  await page.getByRole('button', { name: 'Browse examples', exact: true }).click();
  await page.locator('.catalog-list .row').first().waitFor();
  assert.equal(await page.locator('.catalog-list .row').count(), 12);
  assert.deepEqual(await page.locator('.group-heading').allTextContents(), ['Explore', 'Missions', 'Guided / Scripting']);
  assert.ok(!(await page.locator('.catalog-list').innerText()).includes('Sensor Frustums'));
  await page.screenshot({ path: `${output}/browser.png` });
  await page.locator('.catalog-list .row').filter({ hasText: 'ISS (TLE)' }).click();
  await page.waitForFunction(() => window.cosmo?.listObjects().includes('ISS'), null, { timeout: 120000 });
  assert.ok(new URL(page.url()).searchParams.get('catalog').endsWith('test-catalogs/iss'));
  const gpu = await page.evaluate(() => {
    const gl = window.renderer.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  });
  console.log(`Public home, grouped browser and ISS selection passed; GPU: ${gpu}`);
  await page.goto(new URL('?entry=examples/earth-moon-tour', base).href);
  const status = page.getByRole('status', { name: 'Script status', exact: true });
  await status.waitFor({ timeout: 180000 });
  await page.waitForFunction(() => !!window.cosmo, null, { timeout: 120000 });
  const observations = [];
  let capturedMoon = false;
  // Observe actual state while the ordinary Script panel runs the source.
  const deadline = Date.now() + 160000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const c = window.cosmo;
      return { frame: window.renderer.cameraController.mode, tracked: c.getTracked(), rate: c.getRate(), camera: c.getCamera(), playing: c.isPlaying(),
        status: document.querySelector('[aria-label="Script status"]')?.textContent };
    });
    observations.push(state);
    assert.ok(!state.status?.includes('Failed'), state.status);
    if (state.frame === 'body-fixed' && !capturedMoon) {
      capturedMoon = true;
      await page.screenshot({ path: `${output}/moon.png` });
    }
    if (state.status?.includes('Completed')) break;
    await page.waitForTimeout(1000);
  }
  assert.ok(observations.at(-1).status?.includes('Completed'), observations.at(-1).status);
  assert.ok(observations.some(s => s.tracked === 'Moon'), 'Moon tracking');
  assert.ok(capturedMoon, 'lunar body-fixed viewpoint');
  assert.ok(observations.some(s => s.rate === 86400 && s.playing), 'accelerated clock');
  assert.ok(new Set(observations.map(s => JSON.stringify(s.camera.position))).size > 10, 'camera visibly changes');
  assert.equal(observations.at(-1).playing, false);
  assert.equal(observations.at(-1).rate, 1);
  assert.equal(new URL(page.url()).searchParams.get('entry'), 'examples/earth-moon-tour');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${output}/complete.png` });
  console.log(`Tour completed through ?entry=: ${observations.length} observations; camera motion, lunar tracking and accelerated time verified`);
} finally { await browser.close(); }
