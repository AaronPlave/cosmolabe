/** Physical-GPU pointer traversal of adjacent countries, with fresh-highlight
 * CPU timing and disabled-layer resource checks. Uses the ordinary viewer. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = process.env.CL_OUTPUT ?? '/private/tmp/geographic-hover-closeout';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CL_CHROMIUM ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const errors = [], results = {};
const stats = values => {
  const a = values.slice().sort((a, b) => a - b);
  return { samples: a.length, median: a[Math.floor(a.length / 2)] ?? 0,
    p95: a[Math.floor(a.length * .95)] ?? 0, max: a.at(-1) ?? 0 };
};
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5188/'}?catalog=test-catalogs/geographic-vectors-earth-countries`);
  await page.waitForFunction(() => !!window.renderer, null, { timeout: 90000 });
  await page.evaluate(() => window.renderer.waitForInitialAssets());
  await page.evaluate(() => window.renderer.applyNamedViewpoint('Europe and Africa'));
  await page.waitForTimeout(1800);
  const targets = await page.evaluate(async root => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const { geodeticToBodyFixed } = await import(`/@fs/${root}/packages/core/src/index.ts`);
    const r = window.renderer, body = r.getBodyMesh('Earth'), layer = r.universe.geographicLayers.get('countries');
    const points = [ ['France', 2, 47], ['Germany', 10, 51], ['Poland', 19, 52],
      ['Czechia', 15, 49.8], ['Austria', 14, 47.5], ['Italy', 12, 43], ['Switzerland', 8, 46.8] ];
    return points.map(([name, lon, lat]) => {
      const p = geodeticToBodyFixed({ lonDeg: lon, latDeg: lat }, layer.datum);
      const v = new THREE.Vector3(p.xKm, p.yKm, p.zKm).multiplyScalar(r.scaleFactor)
        .applyQuaternion(body.bodyToWorldQuaternion(new THREE.Quaternion())).add(body.position).project(r.camera);
      const rect = r.renderer.domElement.getBoundingClientRect();
      const x = (v.x + 1) * rect.width / 2, y = (1 - v.y) * rect.height / 2;
      const hit = r.pickScene(x, y, 'select', { labelSlopPx: 0 });
      const feature = layer.features.find(f => f.id === hit?.featureId);
      return { name, actual: feature?.properties.NAME, x, y };
    });
  }, resolve('.'));
  for (const target of targets) assert.equal(target.actual, target.name);
  results.targets = targets;
  await page.evaluate(() => {
    const r = window.renderer, vectors = r.geographicVectors;
    window.__hoverTiming = { updates: [], frames: [], cpu: [], textures: [], last: null };
    const oldHover = vectors.setHovered, oldRender = r.renderFrame;
    vectors.setHovered = function (feature) {
      const t = performance.now(), result = oldHover.call(this, feature);
      window.__hoverTiming.updates.push({ featureId: feature?.featureId, ms: performance.now() - t });
      return result;
    };
    r.renderFrame = function (...args) {
      const t = performance.now(), result = oldRender.apply(this, args), m = window.__hoverTiming;
      m.cpu.push(performance.now() - t);
      if (m.last !== null) m.frames.push(t - m.last);
      m.last = t; m.textures.push(r.renderer.info.memory.textures);
      return result;
    };
    window.__restoreHoverTiming = () => { vectors.setHovered = oldHover; r.renderFrame = oldRender; };
  });
  // Each pointer event runs through normal hover routing, then lets the next
  // frame render. Returning to prior countries exercises allocation churn.
  for (const mode of ['same-country', 'adjacent-countries']) {
    await page.evaluate(() => { const m = window.__hoverTiming; m.updates = []; m.frames = []; m.cpu = []; m.textures = []; m.last = null; });
    for (let i = 0; i < 140; i++) {
      const target = targets[mode === 'same-country' ? 0 : i % targets.length];
      await page.mouse.move(target.x + (mode === 'same-country' ? i % 2 : 0), target.y);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    const sample = await page.evaluate(() => window.__hoverTiming);
    results[mode] = { frameMs: stats(sample.frames), renderCpuMs: stats(sample.cpu),
      highlightCpuMs: stats(sample.updates.map(u => u.ms)),
      identities: [...new Set(sample.updates.map(u => u.featureId))],
      textureRange: [Math.min(...sample.textures), Math.max(...sample.textures)], updates: sample.updates };
    assert.ok(sample.updates.length > 0);
    if (mode === 'adjacent-countries') assert.equal(results[mode].identities.length, targets.length);
  }
  await page.evaluate(() => window.__restoreHoverTiming());
  await page.screenshot({ path: `${output}/adjacent-country-hover.png` });
  results.disabled = await page.evaluate(async () => {
    const r = window.renderer, layer = r.geographicVectors;
    layer.setVisible('countries', false);
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
    const hit = r.pickScene(960, 540, 'select', { labelSlopPx: 0 });
    const gl = r.renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { ...layer.metrics, features: layer.featureCount, bodyHit: hit?.kind,
      gpu: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
      resolution: [gl.drawingBufferWidth, gl.drawingBufferHeight], diagnostics: layer.diagnostics };
  });
  assert.equal(results.disabled.features, 0);
  assert.equal(results.disabled.drawCalls, 0);
  assert.equal(results.disabled.textureBytes, 0);
  assert.equal(results.disabled.surfaceMeshes, 0);
  assert.equal(results.disabled.bodyHit, 'entity');
  assert.doesNotMatch(results.disabled.gpu, /swiftshader|software|llvmpipe/i);
  assert.deepEqual(results.disabled.resolution, [3840, 2160]);
  assert.deepEqual(results.disabled.diagnostics, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await writeFile(`${output}/metrics.json`, JSON.stringify({ results, errors }, null, 2) + '\n');
  await browser.close();
}
