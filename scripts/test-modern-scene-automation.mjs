/** Real mission automation: ordinary index script and test harness, using the public port. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5297/';
const out = process.env.CL_OUTPUT ?? '/tmp/modern-scene-automation';
const hardware = process.env.CL_GPU !== 'software' && process.platform === 'darwin';
const source = await readFile(new URL('../apps/viewer/test-catalogs/ingenuity-analysis-tour.cosmo', import.meta.url), 'utf8');
const controlModule = `/@fs${fileURLToPath(new URL('../packages/control/src/index.ts', import.meta.url))}`;
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ ...(hardware ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  args: hardware ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const report = { rendererRequested: hardware ? 'physical / Metal' : 'software / SwiftShader', scenarios: [], passed: false };
let page;
try {
  for (const harness of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    const url = new URL(harness ? '?catalog=test-catalogs/ingenuity-jezero&test=1' : '?entry=examples/ingenuity-analysis-tour', base);
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 120000 });
    if (harness) await page.evaluate(source => window.__cosmolabe.runScript(source, { forbidWait: true }), source);
    else {
      const status = page.getByRole('status', { name: 'Script status' });
      await page.waitForFunction(() => /Completed|Failed|nothing ran|Stopped/.test(document.querySelector('[aria-label="Script status"]')?.textContent ?? ''), null, { timeout: 120000 });
      assert.match(await status.innerText(), /Completed/);
      assert.equal(await page.evaluate(() => window.__cosmolabe), undefined, 'ordinary viewer must not need the test hook');
    }
    const result = await page.evaluate(async ({ controlModule }) => {
      const c = window.cosmo, scene = c.getScene().id;
      const ready = await c.waitUntilReady({ kind: 'cube-base', body: 'Mars' }, { scene, timeoutMs: 60000 });
      if (ready.status !== 'ready') throw new Error(JSON.stringify(ready));
      const measurement = c.listMeasurements().find(m => m.id === 'tour:mars-centre-distance');
      const placeBefore = c.getSelectedPlace()?.ref;
      const before = { camera: c.getCamera(), definitions: c.listMeasurements(), imagery: c.getImagery('Mars').layers.map(l => ({ id: l.id, visible: l.visible, opacity: l.opacity })), appearance: c.getSurfaceAppearance('Mars').settings };
      const snapshot = c.snapshot();
      c.showMeasurement(measurement.id, false, { scene });
      c.setImageryOpacity('Mars', 'jezero-hirise', 0.2, { scene });
      c.setSurfaceAppearance('Mars', { hillshade: false }, { scene });
      const { parse, execute } = await import(controlModule);
      await execute(parse(snapshot, { forbid: ['wait'] }), c);
      const after = { camera: c.getCamera(), definitions: c.listMeasurements(), imagery: c.getImagery('Mars').layers.map(l => ({ id: l.id, visible: l.visible, opacity: l.opacity })), appearance: c.getSurfaceAppearance('Mars').settings };
      const restoredReady = await c.waitUntilReady({ kind: 'cube-base', body: 'Mars' }, { scene, timeoutMs: 60000 });
      const imageryReady = await c.waitUntilReady({ kind: 'imagery', body: 'Mars', layer: 'jezero-hirise' }, { scene, timeoutMs: 60000 });
      const unavailable = c.getReadiness({ kind: 'imagery', body: 'Mars', layer: 'missing-source' }, { scene });
      let captureRefused = false, captureRefusalReason = '';
      try { await execute(parse('waitUntilReady "{\\"kind\\":\\"imagery\\",\\"body\\":\\"Mars\\",\\"layer\\":\\"missing-source\\"}" 0\ndisplayNote WRONG'), c); }
      catch (error) { captureRefused = true; captureRefusalReason = error.message; }
      const gl = window.renderer.getContext().webglRenderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { scene: c.getScene(), activity: c.getSelectedActivity()?.id, place: c.getSelectedPlace()?.ref, selectedMeasurement: c.getSelectedMeasurement(),
        measurement, placeBefore, before, after, ready, restoredReady, imageryReady, unavailable, captureRefused, captureRefusalReason, snapshot,
        gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown',
        drawingDiagnostics: window.renderer.geographicVectors.diagnostics,
        geographic: c.listGeographicLayers(), page: c.listGeographicFeatures('mission:ingenuity-sites', { limit: 1 }),
      };
    }, { controlModule });
    report.scenarios.push({ mode: harness ? 'test-harness' : 'ordinary', ...result, errors });
    assert.equal(result.activity, 'ingenuity:flight:5');
    assert.equal(result.place, 'mars:mission:ingenuity-sites/airfield-5');
    assert.equal(result.selectedMeasurement, 'tour:mars-centre-distance');
    assert.equal(result.measurement.visible, true);
    assert.deepEqual(result.after.definitions, result.before.definitions);
    assert.deepEqual(result.after.imagery, result.before.imagery);
    assert.deepEqual(result.after.appearance, result.before.appearance);
    for (const key of ['position', 'target', 'up']) for (let i = 0; i < 3; i++) assert.ok(Math.abs(result.before.camera[key][i] - result.after.camera[key][i]) < 1e-6, `camera ${key}[${i}]`);
    assert.equal(result.unavailable.status, 'unavailable'); assert.equal(result.captureRefused, true); assert.match(result.captureRefusalReason, /unavailable: No imagery layer/);
    assert.equal(result.imageryReady.status, 'ready');
    assert.equal(result.restoredReady.status, 'ready'); assert.equal(result.ready.status, 'ready');
    assert.ok(result.ready.limitations.some(line => line.includes('Missing geometry')));
    assert.ok(result.page.total >= 2); assert.equal(result.page.features.length, 1);
    assert.equal(result.geographic.find(l => l.id === 'mars:usgs:places:001').visible, true);
    assert.deepEqual(errors, []);
    const name = harness ? 'test-harness' : 'ordinary';
    await page.screenshot({ path: `${out}/${name}.png` });
    await writeFile(`${out}/${name}.cosmo`, result.snapshot);
    console.log(JSON.stringify({ mode: name, gpu: result.gpu, readiness: result.ready.status, snapshot: 'round-trip passed' }));
    await context.close();
  }
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  await page?.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
