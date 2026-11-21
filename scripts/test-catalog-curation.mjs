/** Loaded public discovery and unmodified ?entry= tour, in dev or preview. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { viewerBrowserOptions } from './lib/viewer-browser.mjs';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5208/';
const output = process.env.CL_CAPTURE_DIR ?? '/tmp/cosmolabe-catalog-curation';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch(viewerBrowserOptions());
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.getByRole('button', { name: 'Browse examples', exact: true }).waitFor();
  assert.equal(await page.locator('.start-row').count(), 6);
  assert.ok((await page.locator('.start-row').allTextContents()).some(text => text.includes('Solar System')));
  await page.screenshot({ path: `${output}/home.png` });
  await page.getByRole('button', { name: 'Browse examples', exact: true }).click();
  await page.locator('.catalog-list .row').first().waitFor();
  assert.equal(await page.locator('.catalog-list .row').count(), 12);
  assert.deepEqual(await page.locator('.group-heading').allTextContents(), ['Explore', 'Missions', 'Tours']);
  assert.ok(!(await page.locator('.catalog-list').innerText()).includes('Sensor Frustums'));
  assert.ok(await page.locator('.browser .body').evaluate(body => body.scrollHeight <= body.clientHeight + 1), 'desktop entries fit without scrolling');
  assert.equal(await page.locator('.browser .context').count(), 0, 'single source needs no visible subtitle');
  await page.screenshot({ path: `${output}/browser.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.catalog-list .row').count(), 12);
  assert.ok(await page.locator('.browser').evaluate(modal => modal.scrollWidth <= modal.clientWidth), 'no horizontal overflow');
  await page.locator('.catalog-list .row').last().scrollIntoViewIfNeeded();
  assert.ok(await page.locator('.catalog-list .row').last().isVisible(), 'last tour is reachable on narrow screens');
  await page.locator('.browser .body').evaluate(body => { body.scrollTop = 0; });
  await page.screenshot({ path: `${output}/browser-narrow.png` });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('.catalog-list .row').filter({ hasText: 'Real daily satellite imagery of Earth (NASA VIIRS, 2026) with the ISS in orbit.' }).click();
  await page.waitForFunction(() => window.cosmo?.listObjects().includes('ISS'), null, { timeout: 120000 });
  assert.ok(new URL(page.url()).searchParams.get('catalog').endsWith('test-catalogs/iss'));
  const gpu = await page.evaluate(() => {
    const gl = window.renderer.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  });
  console.log(`Public home, grouped browser and ISS selection passed; GPU: ${gpu}`);
  await page.goto(new URL('?catalog=test-catalogs/base/solarsys', base).href);
  await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 180000 });
  await page.evaluate(() => { window.cosmo.setPlaying(false); window.cosmo.viewpoint('Earth–Moon System'); });
  await page.waitForTimeout(1000);
  const framing = await page.evaluate(() => {
    const r = window.renderer;
    const camera = r.camera.clone();
    camera.updateMatrixWorld(true);
    return ['Earth', 'Moon'].map(name => {
      const body = r.bodyMeshes.get(name);
      const ndc = body.position.clone().project(camera);
      const distance = r.camera.position.distanceTo(body.position);
      return { name, x: ndc.x, y: ndc.y, z: ndc.z, distance, visible: body.visible };
    });
  });
  for (const body of framing) {
    assert.ok(body.visible && Math.abs(body.x) < 0.9 && Math.abs(body.y) < 0.9 && body.z > -1 && body.z < 1, `${body.name} framing: ${JSON.stringify(body)}`);
  }
  assert.ok(Math.hypot(framing[0].x - framing[1].x, framing[0].y - framing[1].y) > 0.08, 'Earth and Moon are separated in the view');
  await page.screenshot({ path: `${output}/earth-moon-system.png` });
  console.log(`Earth–Moon System framing: ${JSON.stringify(framing)}`);
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
