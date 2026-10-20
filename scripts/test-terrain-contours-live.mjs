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
const labels = process.env.CONTOUR_LABELS === '1';
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
  dense: { eye: at(-88.6, 129.78, 22), target: at(-89.67, 129.78, -2.5), fov: 60 },
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
  await page.getByLabel('Contour color', { exact: true }).fill('#ffc438');
  await page.getByLabel('Contour opacity', { exact: true }).fill('0.7');
  if (labels) {
    await page.getByRole('checkbox', { name: 'Contour elevation labels', exact: true }).check();
    assert.equal(await page.getByLabel('Contour interval', { exact: true }).inputValue(), '0');
  }

  for (const [name, view] of Object.entries(poses)) {
    if (labels) await page.getByLabel('Contour interval', { exact: true }).selectOption(name === 'dense' ? '0.01' : '0');
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
    if (labels) {
      await page.waitForFunction(() => window.renderer.getBodyMesh('Moon').terrainManager.contourLabels.settled, null, { timeout: 120000 });
      await page.waitForTimeout(500);
    }
    result.views[name] = await page.evaluate(() => {
      const r = window.renderer, tm = r.getBodyMesh('Moon').terrainManager;
      const gl = r.getContext().webglRenderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        gpu: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
        intervalKm: tm.surfaceStyle.contourIntervalKm, paths: tm.contourLabels.paths.length, segments: [...tm.contourLabels.caches.values()].reduce((n, c) => n + c.segments.length, 0), terrain: tm.metrics, imagery: tm.cubeImageryStats, visible: tm.tiles.visibleTiles.size,
        labels: tm.contourLabels.group.children.filter(s => s.visible).map(s => ({ text: s.userData.text, position: s.position.toArray(), rotation: s.material.rotation })),
      };
    });
    if (labels) {
      assert.ok(result.views[name].labels.length > 0, `${name}: missing elevation labels`);
      assert.ok(result.views[name].labels.every(l => Math.abs(l.rotation) <= Math.PI / 2));
      const before = result.views[name].labels;
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => window.renderer.getBodyMesh('Moon').terrainManager.contourLabels.group.children
        .filter(s => s.visible).map(s => ({ text: s.userData.text, position: s.position.toArray(), rotation: s.material.rotation })));
      if (JSON.stringify(after.map(v => JSON.stringify(v)).sort()) !== JSON.stringify(before.map(v => JSON.stringify(v)).sort())) {
        const diagnostic = await page.evaluate(async () => {
          const r = window.renderer, manager = r.getBodyMesh('Moon').terrainManager.contourLabels;
          const frames = [];
          for (let i = 0; i < 30; i++) {
            await new Promise(requestAnimationFrame);
            frames.push({ visible: manager.group.children.filter(s => s.visible).length,
              placements: manager.placements.length, revision: manager.sourceRevision, settled: manager.settled,
              eye: r.camera.position.toArray(), hidden: manager.placements.filter(p => manager.occlusion.get(p)?.hidden).length });
          }
          return frames;
        });
        await writeFile(`${output}/${name}-unstable.json`, JSON.stringify({ before, after, diagnostic }, null, 2));
      }
      assert.deepEqual(after.map(v => JSON.stringify(v)).sort(), before.map(v => JSON.stringify(v)).sort(), `${name}: settled labels moved`);
      {
        const timing = await page.evaluate(async () => {
          const manager = window.renderer.getBodyMesh('Moon').terrainManager.contourLabels;
          const original = manager.update, times = [];
          manager.update = function (...args) {
            const start = performance.now(); const value = original.apply(this, args);
            times.push(performance.now() - start); return value;
          };
          try {
            for (let i = 0; i < 120; i++) await new Promise(requestAnimationFrame);
          } finally { manager.update = original; }
          times.sort((a, b) => a - b);
          return { samples: times.length, medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.floor(times.length * 0.95)], maxMs: times.at(-1) };
        });
        result.views[name].labelUpdateTiming = timing;
        if (name === 'far') result.labelUpdateTiming = timing;
      }
    }
    assert.ok(!/swiftshader|software/i.test(result.views[name].gpu), 'Live acceptance requires a physical GPU');
    await page.evaluate(() => window.cosmo.select('Moon'));
    assert.equal(await page.getByLabel('Surface base color', { exact: true }).inputValue(), 'imagery');
    await page.screenshot({ path: `${output}/${name}-contours.png` });
    await contours.uncheck();
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => !window.renderer.getBodyMesh('Moon').terrainManager.contourLabels.group.visible));
    await page.screenshot({ path: `${output}/${name}-off.png` });
    await contours.check();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${output}/${name}-restored.png` });
    if (labels && name === 'close') {
      await page.waitForFunction(() => window.renderer.getBodyMesh('Moon').terrainManager.contourLabels.settled, null, { timeout: 120000 });
      await page.waitForTimeout(300);
      result.visibilityMotion = await page.evaluate(async () => {
        const r = window.renderer, camera = r.camera, controls = r.cameraController.controls;
        const manager = r.getBodyMesh('Moon').terrainManager.contourLabels;
        const initial = camera.position.clone(), target = controls.target.clone();
        const right = initial.clone().setFromMatrixColumn(camera.matrixWorld, 0);
        const pixel = initial.distanceTo(target) * 2 / camera.projectionMatrix.elements[5] / 1000;
        const key = sprite => [sprite.userData.text, ...sprite.position.toArray().map(v => v.toFixed(4))].join(':');
        const baseline = new Set(manager.group.children.filter(s => s.visible).map(key));
        const sample = () => {
          const visible = new Set(manager.group.children.filter(s => s.visible).map(key));
          return [...baseline].filter(k => visible.has(k)).length / baseline.size;
        };
        const jitter = [], running = [];
        for (let frame = 0; frame < 120; frame++) {
          camera.position.copy(initial).addScaledVector(right, pixel * 2 * Math.sin(frame / 12));
          camera.lookAt(target); camera.updateMatrixWorld(true);
          await new Promise(requestAnimationFrame); jitter.push(sample());
        }
        camera.position.copy(initial); camera.lookAt(target); camera.updateMatrixWorld(true);
        window.cosmo.setTimeRate(1); window.cosmo.setPlaying(true);
        try {
          for (let frame = 0; frame < 120; frame++) { await new Promise(requestAnimationFrame); running.push(sample()); }
        } finally { window.cosmo.setPlaying(false); }
        const metrics = values => ({ minimumRetained: Math.min(...values), meanRetained: values.reduce((a, b) => a + b, 0) / values.length, samples: values });
        return { baseline: baseline.size, jitter: metrics(jitter), running: metrics(running) };
      });
      await writeFile(`${output}/visibility-motion.json`, JSON.stringify(result.visibilityMotion, null, 2));
      assert.ok(result.visibilityMotion.baseline >= 15, 'motion test must start with a populated label view');
      assert.ok(result.visibilityMotion.jitter.minimumRetained > 0.65, 'small motions blanked the label layer');
      assert.ok(result.visibilityMotion.jitter.meanRetained > 0.85, 'small camera motions caused sustained label loss');
      assert.ok(result.visibilityMotion.running.meanRetained > 0.75, 'running time caused sustained label loss');
    }
    if (labels && name === 'close') {
      result.motion = await page.evaluate(async () => {
        const r = window.renderer, camera = r.camera, controls = r.cameraController.controls;
        const initial = camera.position.clone(), direction = initial.clone().setFromMatrixColumn(camera.matrixWorld, 0);
        const amplitude = initial.distanceTo(controls.target) * 0.06;
        const samples = [];
        for (let i = 0; i <= 24; i++) {
          camera.position.copy(initial).addScaledVector(direction, amplitude * Math.sin(i / 24 * Math.PI * 2));
          camera.lookAt(controls.target); camera.updateMatrixWorld(true);
          await new Promise(requestAnimationFrame);
          const group = r.getBodyMesh('Moon').terrainManager.contourLabels.group;
          samples.push(group.children.filter(s => s.visible).length);
        }
        return { samples, maximum: Math.max(...samples) };
      });
      assert.ok(result.motion.maximum > 0);
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `${output}/close-after-motion.png` });
    }
    if (labels && name === 'close') {
      result.lookDirection = await page.evaluate(async () => {
        const r = window.renderer, camera = r.camera, controls = r.cameraController.controls;
        const tm = r.getBodyMesh('Moon').terrainManager;
        const initial = camera.position.clone(), target = controls.target.clone();
        const outward = camera.up.clone().normalize(), distance = initial.distanceTo(target);
        const intervals = [tm.surfaceStyle.contourIntervalKm];
        const eyeDrift = [];
        // Preserve eye position and change only the look target, as with
        // looking above the horizon then returning to the same ground.
        for (const look of [initial.clone().addScaledVector(outward, distance), target]) {
          camera.position.copy(initial); controls.target.copy(look); camera.lookAt(look); camera.updateMatrixWorld(true);
          const start = performance.now();
          while (performance.now() - start < 1500) await new Promise(requestAnimationFrame);
          intervals.push(tm.surfaceStyle.contourIntervalKm); eyeDrift.push(camera.position.distanceTo(initial));
        }
        return { intervals, eyeDrift };
      });
      assert.ok(result.lookDirection.intervals.every(v => v === result.lookDirection.intervals[0]), 'looking up and back changed the automatic interval');
      assert.ok(result.lookDirection.eyeDrift.every(v => v < 1e-9), 'look-direction test moved the camera');
    }
    console.log(name, result.views[name].gpu, result.views[name].visible, 'tiles');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // The responsive shell moves/recreates the body panel after the resize.
  await page.waitForTimeout(400);
  await page.getByLabel(labels ? 'Contour interval' : 'Contour density', { exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await contours.isChecked());
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${output}/mobile.png` });
  if (labels) {
    await page.getByRole('checkbox', { name: 'Contour elevation labels', exact: true }).uncheck();
    assert.ok(await contours.isChecked());
    assert.equal(await page.getByLabel('Contour interval', { exact: true }).inputValue(), '0');
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => !window.renderer.getBodyMesh('Moon').terrainManager.contourLabels.group.visible));
    await page.getByRole('checkbox', { name: 'Contour elevation labels', exact: true }).check();
    await page.getByLabel('Contour interval', { exact: true }).selectOption('0');
    assert.ok(await page.getByRole('checkbox', { name: 'Contour elevation labels', exact: true }).isChecked());
  }
  result.errors = errors;
  result.failures = failures;
  await writeFile(`${output}/metrics.json`, JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  assert.equal(result.assets.failed, 0);
} finally {
  await browser.close();
}
