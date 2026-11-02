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
      c.saveBookmark('destination-preserved');
      const bookmarksBefore = c.listBookmarks();
      const terrainReady = await c.waitUntilReady({ kind: 'terrain', body: 'Mars' }, { scene, timeoutMs: 60000 });
      const portable = await c.getViewState();
      let wrongCatalogRefused = false, invalidAnalysisRefused = false;
      try { await c.restoreViewState({ ...portable, catalog: { catalog: 'wrong' } }, { scene }); } catch { wrongCatalogRefused = true; }
      try { await c.restoreViewState({ ...portable, events: { version: 99 } }, { scene }); } catch { invalidAnalysisRefused = true; }
      await c.restoreViewState(portable, { scene });
      const snapshot = c.snapshot();
      c.moveImageryLayer('Mars', 'jezero-hirise', 1, { scene });
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
        measurement, placeBefore, before, after, ready, terrainReady, wrongCatalogRefused, invalidAnalysisRefused, bookmarksBefore, bookmarksAfter: c.listBookmarks(), restoredReady, imageryReady, unavailable, captureRefused, captureRefusalReason, snapshot,
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
    assert.equal(result.terrainReady.status, 'ready');
    assert.equal(result.wrongCatalogRefused, true); assert.equal(result.invalidAnalysisRefused, true);
    assert.deepEqual(result.bookmarksAfter, result.bookmarksBefore);
    assert.equal(result.restoredReady.status, 'ready'); assert.equal(result.ready.status, 'ready');
    assert.ok(result.ready.limitations.some(line => line.includes('Missing geometry')));
    assert.ok(result.page.total >= 2); assert.equal(result.page.features.length, 1);
    assert.equal(result.geographic.find(l => l.id === 'mars:usgs:places:001').visible, true);
    assert.deepEqual(errors, []);
    const name = harness ? 'test-harness' : 'ordinary';
    await page.screenshot({ path: `${out}/${name}.png` });
    await writeFile(`${out}/${name}.cosmo`, result.snapshot);
    // Opening the editor for a script-selected definition must settle even
    // when optional fields (notably frame) are absent. Exercise edits and
    // deletion through Open in Reference Geometry and the native editor.
    await page.getByRole('button', { name: 'Open in Reference Geometry', exact: true }).click();
    await page.getByRole('button', { name: 'Select distance geometry', exact: true }).click();
    await page.getByLabel('Target entity', { exact: true }).selectOption('');
    await page.getByText('Incomplete endpoints', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Actions for distance', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.cosmo.listMeasurements()), []);
    assert.equal(await page.evaluate(() => window.cosmo.getSelectedMeasurement()), null);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mode: name, gpu: result.gpu, readiness: result.ready.status, snapshot: 'round-trip passed' }));
    await context.close();
  }
  // A second real catalog exercises the existing SPICE search and sensor feed.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    await page.goto(new URL('?catalog=test-catalogs/cassini-soi', base).href, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 240000 });
    const result = await page.evaluate(async () => {
      const c = window.cosmo, id = 'acceptance:approach', scene = c.getScene().id;
      c.setPlaying(false);
      c.upsertEventQuery({ id, label: 'Closest approach', enabled: true, visible: true,
        query: { id, kind: 'closest-approach', bodies: { observer: 'Cassini', target: 'Saturn' },
          window: { start: 141912064.184, end: 141955264.184 }, step: 60, abcorr: 'LT+S' } }, { scene });
      const search = await c.runEventQuery(id, { scene, timeoutMs: 120000 });
      const results = c.listEventResults(id, { scene });
      if (results.items.length !== 1) throw new Error('Unexpected Cassini result count');
      c.selectEventResult(id, results.items[0].id, 'start', { scene });
      const names = c.listInstruments();
      const selected = c.selectInstrument('ISS NAC', { scene });
      return { mode: 'cassini', search, total: results.total, selectedResult: c.getEventSearch().selected, names, selected };
    });
    assert.equal(result.search.status, 'complete'); assert.equal(result.total, 1); assert.equal(result.selected, true);
    await page.waitForFunction(() => window.cosmo.getInstrument()?.observedEt === window.cosmo.getTime(), null, { timeout: 30000 });
    result.instrument = await page.evaluate(() => window.cosmo.getInstrument());
    assert.equal(result.instrument.sensor, 'ISS NAC'); assert.equal(result.instrument.observation, 'synthetic-scene-view');
    assert.ok(['spice', 'attitude', 'unavailable', 'target', 'none'].includes(result.instrument.pointing));
    const stale = await page.evaluate(() => { const c = window.cosmo; c.setTime({ kind: 'et', et: c.getTime() + 1 }); return c.getInstrument(); });
    assert.equal(stale.pointing, 'unavailable');
    result.terminalOutcomes = await page.evaluate(async () => {
      const c = window.cosmo, id = 'acceptance:approach', abort = new AbortController();
      const off = c.on('events', () => { if (c.getEventSearch().status === 'running') abort.abort(); });
      const cancelled = await c.runEventQuery(id, { signal: abort.signal }); off();
      const afterCancel = c.getEventSearch();
      const timed = await c.runEventQuery(id, { timeoutMs: 0 });
      const afterTimeout = c.getEventSearch();
      const first = c.runEventQuery(id), second = c.runEventQuery(id);
      const [superseded, replacement] = await Promise.all([first, second]);
      return { cancelled, afterCancel, timed, afterTimeout, superseded, replacement, current: c.getEventSearch() };
    });
    assert.equal(result.terminalOutcomes.cancelled.status, 'cancelled');
    assert.equal(result.terminalOutcomes.afterCancel.status, 'cancelled');
    assert.equal(result.terminalOutcomes.timed.status, 'timed-out');
    assert.equal(result.terminalOutcomes.afterTimeout.status, 'timed-out');
    assert.equal(result.terminalOutcomes.superseded.status, 'cancelled');
    assert.equal(result.terminalOutcomes.replacement.status, 'complete');
    assert.equal(result.terminalOutcomes.current.status, 'complete');
    report.scenarios.push(result);
    console.log(JSON.stringify({ mode: 'cassini', search: result.search.status, sensor: result.instrument.sensor, pointing: result.instrument.pointing }));
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
