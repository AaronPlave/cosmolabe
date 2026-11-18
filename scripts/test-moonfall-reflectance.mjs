/** Loaded MoonFall comparison. Run against the viewer serving this checkout:
 * node scripts/test-moonfall-reflectance.mjs http://127.0.0.1:5296 work/moonfall-reflectance
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const base = process.argv[2] ?? 'http://127.0.0.1:5296';
const out = process.argv[3] ?? 'work/moonfall-reflectance';
const time = '2028-12-15T10:04:00Z';
const models = ['legacy', 'lambert', 'lunar-lambert', 'hapke'];
const comparisonId = 'wac-reflectance-shackleton';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.CHROMIUM_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROMIUM_PATH,
  args: process.platform === 'darwin' ? ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] : [],
});

function difference(a, b) {
  let sum = 0, changed = 0, darkened = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = b.data[i] - a.data[i];
    sum += Math.abs(delta);
    changed += Math.abs(delta) >= 3;
    darkened += delta <= -3;
  }
  const pixels = a.width * a.height;
  return { meanAbsoluteDn: sum / pixels, changedFraction: changed / pixels, darkenedFraction: darkened / pixels };
}

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 840 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => {
    if (msg.type() === 'error' && /shader|GL_INVALID|WebGLProgram/i.test(msg.text())) errors.push(msg.text());
  });
  const requests = [];
  page.on('request', request => {
    if (request.url().includes('/' + comparisonId + '/')) requests.push(request.url());
  });
  const url = new URL(base);
  url.search = '?catalog=test-catalogs/moonfall-shackleton&test=1&solarExposure=fixed';
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady === true, null, { timeout: 120_000 });
  await page.evaluate(time => {
    window.cosmo.setPlaying(false);
    if (!window.cosmo.setTime({ kind: 'calendar', text: time })) throw new Error('Unable to set the comparison epoch');
    window.renderer.setLabelsVisible(false);
    window.renderer.setTrajectoriesVisible(false);
  }, time);

  const settle = enabled => page.waitForFunction(({ enabled, comparisonId }) => {
    const moon = window.renderer.getBodyMesh('Moon');
    const manager = moon.terrainManager;
    const stats = manager.cubeImageryStats;
    const layer = moon.imageryLayers.find(layer => layer.id === comparisonId);
    const network = manager.metrics.network;
    return moon.surfaceTransitionState === 'streamed' && stats?.baseUncoveredBlocks === 0
      && !stats?.inFlight && !network.queued && !network.downloading && !network.parsing
      && layer.visible === enabled && (!enabled || (layer.view?.inCoverage && layer.view.zoomLevel >= 5));
  }, { enabled, comparisonId }, { timeout: 120_000 });

  const capture = async name => {
    const data = await page.evaluate(() => {
      const renderer = window.renderer;
      renderer.renderFrame();
      return renderer.getContext().webglRenderer.domElement.toDataURL().split(',')[1];
    });
    const bytes = Buffer.from(data, 'base64');
    await writeFile(join(out, name + '.png'), bytes);
    return PNG.sync.read(bytes);
  };

  await settle(false);
  assert.equal(requests.length, 0, 'comparison must not load in the original view');
  await page.getByRole('button', { name: 'Display', exact: true }).click();
  const modelSelect = page.getByLabel('Regolith reflectance');
  const shadowSelect = page.getByTestId('terrain-shadow-mode');
  const original = await capture('original');
  await modelSelect.selectOption('hapke');
  const originalDifference = difference(original, await capture('original-hapke'));
  assert.equal(originalDifference.changedFraction, 0, 'original detail should keep its existing shading');
  await page.getByRole('button', { name: 'Compare WAC reflectance' }).click();
  await settle(true);
  assert.ok(requests.some(url => url.endsWith('.png')), 'real WAC tiles must load');
  const captures = new Map();
  const changes = {};
  for (const model of models) {
    await modelSelect.selectOption(model);
    const image = await capture(model);
    for (const [previous, a] of captures) {
      const delta = difference(a, image);
      assert.ok(delta.changedFraction > .01, `${previous} vs ${model}: ${JSON.stringify(delta)}`);
      changes[previous + '/' + model] = delta;
    }
    captures.set(model, image);
  }
  await shadowSelect.selectOption('high');
  await page.waitForFunction(() => {
    const status = window.renderer.getBodyMesh('Moon').solarShadowStatus;
    return (status?.state === 'ready' || status?.state === 'partial') && status.siteFade >= .99;
  }, null, { timeout: 120_000 });
  const shadows = difference(captures.get('hapke'), await capture('hapke-shadows'));
  assert.ok(shadows.darkenedFraction > .001, JSON.stringify(shadows));
  const terrain = await page.evaluate(() => {
    const renderer = window.renderer, moon = renderer.getBodyMesh('Moon');
    const gl = renderer.getContext().webglRenderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      gpu: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
      shadow: renderer.terrainShadowSummary(),
      solar: renderer.solarGeometryAt('Moon', -89.67, 129.78),
      tiles: moon.terrainMetrics.tiles,
      imagery: moon.imageryLayers.map(({ id, visible, status, view }) => ({ id, visible, status, view })),
    };
  });
  await shadowSelect.selectOption('off');
  await modelSelect.selectOption('legacy');
  await page.getByRole('button', { name: 'Return to original imagery' }).click();
  await settle(false);
  const restored = difference(original, await capture('restored'));
  assert.equal(restored.changedFraction, 0, 'original imagery should be restored');
  await page.getByRole('button', { name: 'Compare WAC reflectance' }).click();
  await settle(true);
  const nearPose = await page.evaluate(() => {
    const r = window.renderer, moon = r.getBodyMesh('Moon'), camera = r.camera;
    const target = r.cameraController.controls.target;
    const centre = moon.getWorldPosition(camera.position.clone());
    const near = camera.position.toArray();
    window.cosmo.untrack();
    r.cameraController.controls.enableDamping = false;
    camera.position.sub(centre).setLength(40_000 * r.scaleFactor).add(centre);
    camera.lookAt(target);
    return { near, target: target.toArray(), up: camera.up.toArray() };
  });
  await page.waitForFunction(() => {
    const moon = window.renderer.getBodyMesh('Moon');
    return moon.mesh.visible && (moon.surfaceTransitionState === 'static' || moon.surfaceTransitionState === 'preloading');
  });
  await page.getByText('Move closer to Shackleton.', { exact: false }).waitFor();
  const orbit = await capture('orbit-legacy');
  await modelSelect.selectOption('hapke');
  const orbitDifference = difference(orbit, await capture('orbit-hapke'));
  assert.equal(orbitDifference.changedFraction, 0, 'undeclared orbital map should keep its existing shading');
  await page.evaluate(({ near, target, up }) => {
    const r = window.renderer;
    r.camera.position.fromArray(near);
    r.camera.up.fromArray(up);
    r.cameraController.controls.target.fromArray(target);
    r.camera.lookAt(r.cameraController.controls.target);
  }, nearPose);
  await settle(true);
  const returned = difference(captures.get('hapke'), await capture('streamed-again'));
  assert.ok(returned.changedFraction < .005, 'textured Hapke should return after zooming in');
  await page.setViewportSize({ width: 390, height: 780 });
  await page.getByRole('button', { name: 'Return to original imagery' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, 'compact-controls.png') });
  assert.deepEqual(errors, []);
  const report = { time, terrain, changes, shadows, originalDifference, restored, orbitDifference, returned };
  await writeFile(join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
