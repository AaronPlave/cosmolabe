/** #297 P2: scripted request → native GF → observed timeline/3D → portable definitions. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5397/';
const out = process.env.CL_OUTPUT ?? '/tmp/event-visualization-integration';
const controlModule = `/@fs${fileURLToPath(new URL('../packages/control/src/index.ts', import.meta.url))}`;
await mkdir(out, { recursive: true });
const hardware = process.platform === 'darwin' && process.env.CL_GPU !== 'software';
const browser = await chromium.launch({ ...(hardware ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  args: hardware ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { passed: false, scenarios: [] };
let page;
try {
  for (const harness of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(new URL(`?catalog=test-catalogs/cassini-soi${harness ? '&test=1' : ''}`, base).href, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 240000 });
    const workflow = await page.evaluate(async ({ controlModule }) => {
      const { parse, execute, quote } = await import(controlModule);
      const c = window.cosmo, scene = c.getScene().id, id = 'p2:closest-approach';
      const definition = { id, label: 'Cassini Saturn closest approach', enabled: true, visible: true,
        query: { id, kind: 'closest-approach', bodies: { observer: 'Cassini', target: 'Saturn' }, window: { start: 141912064.184, end: 141955264.184 }, step: 60, abcorr: 'LT+S' } };
      const source = `setPlaying off\nupsertEventQuery ${quote(JSON.stringify(definition))}\nrunEventQuery ${quote(id)} 120000`;
      await execute(parse(source), c);
      const info = c.getEventQueryInfo(id), results = c.getEventResultPage(id, { limit: 1 });
      if (results.status !== 'ready' || results.total !== 1) throw new Error(JSON.stringify(results));
      const { reference, event } = results.items[0], before = { et: c.getTime(), camera: c.getCamera() };
      const inspection = c.focusEventResult(reference, 'inspect');
      const afterInspection = { et: c.getTime(), camera: c.getCamera() };
      await execute(parse(`focusEventResult ${quote(JSON.stringify(reference))} start`), c);
      // Camera framing and semantic measurements compose through existing APIs.
      c.gotoObject('Saturn'); c.frameObject('Saturn');
      c.setLayer('trajectories', true); c.showTrajectory('Cassini', true);
      c.upsertMeasurement({ id: 'p2:range', kind: 'distance', source: { kind: 'entity', bodyName: 'Cassini' }, target: { kind: 'entity', bodyName: 'Saturn' }, vertex: null, color: '#e69f00', visible: true });
      c.displayNote('Cassini closest approach · SPICE GF. Range is centre to centre; rendered event marker is explanatory.');
      const captureRequest = { kind: 'event', reference, et: event.et, policy: 'native-draw' };
      const captureSource = `waitUntilReady ${quote(JSON.stringify(captureRequest))} 60\nscreenshot p2-event-observed`;
      // The Script runner itself waits and captures, using the same public port as the Script panel.
      const capture = await execute(parse(captureSource), c);
      if (capture.images.length !== 1) throw new Error('Script did not produce its capture');
      const scriptedObservation = c.getEventVisualization();
      const snapshot = c.snapshot(), view = await c.getViewState();
      return { scene, id, definition, source, info, results, reference, event, before, afterInspection, inspection, snapshot, view, captureSource, capture: { ran: capture.ran, image: capture.images[0] }, scriptedObservation };
    }, { controlModule });
    // Exercise the real Script panel/editor/Run control, including its own cancellation/error propagation.
    await page.keyboard.press('`');
    await page.locator('.cm-content').fill(workflow.captureSource);
    const uiDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await (await uiDownload).saveAs(`${out}/${harness ? 'harness' : 'ordinary'}-panel-script.png`);
    await page.waitForFunction(() => /Completed/.test(document.querySelector('[aria-label="Script status"]')?.textContent ?? ''));
    workflow.panelStatus = await page.getByRole('status', { name: 'Script status' }).innerText();
    await page.keyboard.press('Escape');
    assert.deepEqual(workflow.before, workflow.afterInspection, 'inspection must preserve epoch and camera');
    assert.equal(workflow.info.status, 'available');
    assert.equal(workflow.info.provenance.source, 'loaded-spice-kernels');
    assert.equal(workflow.info.provenance.timeUnit, 'ET seconds past J2000');
    assert.equal(workflow.info.provenance.abcorr, 'LT+S');
    assert.ok(workflow.event.metrics.some(m => m.key === 'range' && m.unit === 'km'));
    assert.match(workflow.snapshot, /Computed event selection is not replayed/);
    const observed = workflow.scriptedObservation;
    assert.equal(observed.status, 'observed');
    assert.equal(workflow.capture.ran, 2);
    await writeFile(`${out}/${harness ? 'harness' : 'ordinary'}-script.png`, Buffer.from(workflow.capture.image.dataUrl.split(',')[1], 'base64'));
    delete workflow.capture.image.dataUrl;
    assert.equal(observed.et, workflow.event.et);
    assert.equal(observed.selected.query, workflow.id);
    assert.equal(observed.timeline.selectedInVisibleLane, true);
    assert.equal(observed.renderer.observedEt, observed.et);
    assert.ok(observed.renderer.visibleGlyphs > 0 || observed.renderer.visibleSpans > 0);
    await page.screenshot({ path: `${out}/${harness ? 'harness' : 'ordinary'}.png` });
    const adverse = await page.evaluate(async ({ workflow, controlModule }) => {
      const { parse, execute } = await import(controlModule), c = window.cosmo;
      // Snapshot preserves query/measurement definitions, never cached event arrays.
      await execute(parse(workflow.snapshot), c);
      const replay = { page: c.getEventResultPage(workflow.id), measurements: c.listMeasurements() };
      await c.runEventQuery(workflow.id);
      const fresh = c.getEventResultPage(workflow.id).items[0].reference;
      const old = c.focusEventResult(workflow.reference, 'start');
      const wrongScene = c.focusEventResult({ ...fresh, scene: -1 }, 'start');
      // Existing v1 sharing recomputes queries and matches event times; it never revives an old run reference.
      await c.restoreViewState(workflow.view, { scene: workflow.scene });
      const shared = c.getEventVisualization();
      const sharedOld = c.focusEventResult(fresh, 'start');
      const empty = { ...workflow.definition, id: 'p2:empty', query: { ...workflow.definition.query, id: 'p2:empty', params: { maxRangeKm: 1 } } };
      c.upsertEventQuery(empty); const emptyRun = await c.runEventQuery(empty.id); const emptyPage = c.getEventResultPage(empty.id);
      const missing = { ...workflow.definition, id: 'p2:missing-coverage', query: { ...workflow.definition.query, id: 'p2:missing-coverage', window: { start: -1e9, end: -1e9 + 3600 } } };
      c.upsertEventQuery(missing); const missingInfo = c.getEventQueryInfo(missing.id), missingRun = await c.runEventQuery(missing.id);
      const missingPage = c.getEventResultPage(missing.id);
      c.upsertEventQuery(workflow.definition);
      const abort = new AbortController(); let progressObserved = false;
      const manualEt = workflow.event.et + 123;
      const camera = c.getCamera(); camera.position[0] += 100;
      const off = c.on('events', () => {
        if (c.getEventSearch().status !== 'running') return;
        progressObserved = true; off();
        c.setTime({ kind: 'et', et: manualEt }); c.setCamera(camera.position, camera.target, camera.up);
        abort.abort();
      });
      const cancelled = await c.runEventQuery(workflow.id, { signal: abort.signal }); off();
      const afterCancel = { et: c.getTime(), camera: c.getCamera(), selection: c.getEventVisualization().selected };
      const next = await c.runEventQuery(workflow.id);
      const afterNext = { et: c.getTime(), camera: c.getCamera() };
      const gl = window.renderer.getContext().webglRenderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { replay, old, wrongScene, shared, sharedOld, emptyRun, emptyPage, missingInfo, missingRun, missingPage,
        progressObserved, cancelled, afterCancel, afterNext, next, manualEt, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown' };
    }, { workflow, controlModule });
    report.scenarios.push({ mode: harness ? 'harness' : 'ordinary', workflow, observed, adverse, errors });
    assert.equal(adverse.replay.page.status, 'not-searched');
    assert.ok(adverse.replay.measurements.some(m => m.id === 'p2:range'));
    assert.equal(adverse.old.status, 'stale-result'); assert.equal(adverse.wrongScene.status, 'scene-reloaded');
    assert.ok(adverse.shared.selected); assert.notEqual(adverse.shared.selected.revision, workflow.reference.revision);
    assert.ok(['missing-query', 'stale-result'].includes(adverse.sharedOld.status));
    assert.equal(adverse.emptyRun.status, 'complete'); assert.equal(adverse.emptyPage.status, 'no-results');
    assert.equal(adverse.missingInfo.status, 'unavailable'); assert.equal(adverse.missingRun.status, 'failed'); assert.equal(adverse.missingPage.status, 'failed');
    assert.equal(adverse.progressObserved, true); assert.equal(adverse.cancelled.status, 'cancelled');
    assert.equal(adverse.afterCancel.et, adverse.manualEt); assert.deepEqual(adverse.afterNext, { et: adverse.afterCancel.et, camera: adverse.afterCancel.camera });
    assert.equal(adverse.next.status, 'complete'); assert.deepEqual(errors, []);
    await writeFile(`${out}/${harness ? 'harness' : 'ordinary'}.cosmo`, workflow.snapshot);
    console.log(JSON.stringify({ mode: harness ? 'harness' : 'ordinary', gpu: adverse.gpu, status: observed.status, et: observed.et, missingCoverage: adverse.missingRun.status, cancellation: adverse.cancelled.status }));
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
