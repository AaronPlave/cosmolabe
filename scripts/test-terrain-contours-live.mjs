/** Actual MoonFall terrain/imagery acceptance, with the physical GPU.
 * Start this checkout's viewer, then:
 * SURFACE_VIEWER_URL=http://localhost:5174 node scripts/test-terrain-contours-live.mjs
 * Requires locally built MoonFall cube terrain and WAC/NAC imagery.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const base = process.env.SURFACE_VIEWER_URL ?? 'http://localhost:5174';
const output = process.env.CONTOUR_OUTPUT ?? 'work/issue-183/live';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'vulkan'}`, '--ignore-gpu-blocklist', '--enable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], failures = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', message => {
  if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(message.text())) errors.push(message.text());
});
page.on('response', response => {
  if (response.status() >= 400) failures.push({ url: response.url(), status: response.status() });
});
function at(lat, lon, height) {
  const a = lat * Math.PI / 180, b = lon * Math.PI / 180, r = 1737.4 + height;
  return [r * Math.cos(a) * Math.cos(b), r * Math.cos(a) * Math.sin(b), r * Math.sin(a)];
}
const poses = {
  close: { eye: at(-89.07, 129.78, 6), target: at(-89.67, 129.78, -2.5), fov: 60 },
  far: { eye: at(-80, 20, 450), target: at(-90, 0, 0), fov: 50 },
  pole: { eye: at(-85, 20, 2300), target: [0, 0, 0], fov: 50 },
  globe: { eye: at(-55, 20, 3500), target: [0, 0, 0], fov: 50 },
};
const result = { views: {} };
try {
  await page.goto(`${base}/?catalog=test-catalogs/moonfall-shackleton`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.renderer, null, { timeout: 120000 });
  console.log('renderer ready');
  result.assets = await page.evaluate(() => window.renderer.waitForInitialAssets());
  console.log('assets', JSON.stringify(result.assets));
  await page.evaluate(() => {
    window.cosmo.setPlaying(false);
    window.cosmo.untrack();
    window.cosmo.select('Moon');
  });
  await page.waitForFunction(() => window.renderer.getBodyMesh('Moon').surfaceAppearance !== null, null, { timeout: 120000 });
  const contours = page.getByRole('checkbox', { name: 'Contours', exact: true });
  await contours.check();
  await page.getByLabel('Contour color', { exact: true }).fill('#ff0000');
  await page.getByLabel('Contour opacity', { exact: true }).fill('0.7');

  for (const [name, view] of Object.entries(poses)) {
    await page.evaluate(view => {
      const r = window.renderer, body = r.getBodyMesh('Moon'), V = r.camera.position.constructor;
      const center = body.getWorldPosition(new V());
      // ECEF Z-north kilometres to the viewer's Y-up, rotated body frame.
      const toWorld = ([x, y, z]) => new V(x, z, -y).applyQuaternion(body.mesh.quaternion).multiplyScalar(r.scaleFactor).add(center);
      const eye = toWorld(view.eye), target = toWorld(view.target);
      const camera = r.camera, controls = r.cameraController.controls;
      controls.enableDamping = false;
      camera.fov = view.fov;
      camera.updateProjectionMatrix();
      camera.position.copy(eye);
      camera.up.copy(eye.clone().sub(center).normalize());
      controls.target.copy(target);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
    }, view);
    await page.waitForFunction(() => {
      const tm = window.renderer.getBodyMesh('Moon').terrainManager;
      const network = tm.metrics.network, imagery = tm.cubeImageryStats;
      return tm.tiles.visibleTiles.size > 0 && network.queued + network.downloading + network.parsing === 0 &&
        imagery?.queued === 0 && imagery?.inFlight === 0;
    }, null, { timeout: 120000 });
    await page.waitForTimeout(1500);
    result.views[name] = await page.evaluate(() => {
      const r = window.renderer, tm = r.getBodyMesh('Moon').terrainManager;
      const gl = r.getContext().webglRenderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        gpu: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
        terrain: tm.metrics, imagery: tm.cubeImageryStats, visible: tm.tiles.visibleTiles.size,
      };
    });
    assert.ok(!/swiftshader|software/i.test(result.views[name].gpu), 'Live acceptance requires a physical GPU');
    await page.screenshot({ path: `${output}/${name}-contours.png` });
    await contours.uncheck();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${output}/${name}-off.png` });
    await contours.check();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${output}/${name}-restored.png` });
    console.log(name, result.views[name].gpu, result.views[name].visible, 'tiles');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Contour density', { exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await contours.isChecked());
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${output}/mobile.png` });
  result.errors = errors;
  result.failures = failures;
  await writeFile(`${output}/metrics.json`, JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  assert.equal(result.assets.failed, 0);
} finally {
  await browser.close();
}
