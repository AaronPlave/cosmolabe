import { etToDate } from '@cosmolabe/core';
/** Local native-solver/readback and rendered-answer acceptance. No provider calls. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { viewerBrowserOptions } from './lib/viewer-browser.mjs';
const output = process.env.ASK_382_OUTPUT ?? '/tmp/382-native'; mkdirSync(output, { recursive: true });
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5797/';
const browser = await chromium.launch(viewerBrowserOptions());
const report = { kind: 'local native operations with fixture transcript; no model/provider acceptance', cases: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  for (const catalog of (process.env.ASK_382_CATALOGS?.split(',') ?? ['cassini-soi', 'europa-clipper', 'ingenuity-jezero'])) {
    console.log(`Loading ${catalog}`);
    await page.goto(`${base}?catalog=test-catalogs/${catalog}`);
    await page.waitForFunction(object => window.cosmo?.getScene()?.ready && window.cosmo.listObjects().includes(object), catalog === 'cassini-soi' ? 'Cassini' : catalog === 'europa-clipper' ? 'Europa Clipper' : 'Ingenuity', { timeout: 120000 });
    await page.evaluate(async () => {
      const path = p => performance.getEntriesByType('resource').map(r => r.name).find(u => new URL(u).pathname === p);
      window.__ask382 = await import(path('/src/lib/ask/ask.svelte.ts'));
      window.__ask382.setHostAskTransport({ send: async () => { throw new Error('No provider in local acceptance'); } });
      const shell = await import(path('/src/lib/shell.svelte.ts')); shell.enableTool('ask'); shell.openTool('ask');
    });
    const data = { catalog };
    // Native results are retained independently from fixture presentation.
    const native = await page.evaluate(async catalog => {
      const c = window.cosmo; c.setTimeRate(0); c.setPlaying(false);
      if (catalog === 'ingenuity-jezero') {
        const places = c.searchPlaces('Belva', { body: 'Mars' });
        const p = places.find(p => p.name === 'Belva');
        if (!p) return { error: 'Belva not in loaded Places', places };
        return { place: p, distance: c.getPlaceDistance('Ingenuity', p.ref), et: c.getTime() };
      }
      const request = catalog === 'cassini-soi' ? { observer: 'Cassini', target: 'Saturn', windowMode: 'coverage', extremum: 'closest', present: false }
        : { observer: 'Europa Clipper', target: 'Jupiter', windowMode: 'interval', start: '2030-01-01', end: '2030-01-02', extremum: 'farthest' };
      const first = await c.findClosestApproach(request);
      let result = first;
      if (catalog === 'cassini-soi' && first.result) {
        const q = first.result.items[0].reference.query;
        const earliest = c.getEventResultPage(q, { order: 'chronological', limit: 1 }).items[0].event;
        result = await c.findClosestApproach({ ...request, extremum: 'farthest', windowMode: 'interval', start: earliest.et, end: first.windows.at(-1).end, present: true });
      }
      return { first, result, selected: c.getEventVisualization(), et: c.getTime() };
    }, catalog);
    if (catalog === 'ingenuity-jezero') {
      assert.equal(native.distance?.status, 'available', JSON.stringify(native));
      assert.equal(native.distance.frame, 'IAU_MARS'); assert.equal(native.distance.accuracyKm, null);
      assert.equal(native.distance.coverage, 'available-at-epoch'); assert.ok(native.distance.distanceKm > 0);
    } else {
      assert.ok(native.result.result, JSON.stringify(native.result));
      const event = native.result.result.items[0].event;
      assert.equal(native.et, event.et); assert.equal(native.selected.selected.id, event.id);
      if (catalog === 'europa-clipper') assert.equal(event.state, 'coverage-boundary');
    }
    native.utc = etToDate(native.et).toISOString();
    console.log(`${catalog}: native read complete`);
    writeFileSync(`${output}/${catalog}-native.json`, JSON.stringify(native, null, 2));
    await page.evaluate(({ catalog, native }) => {
      const event = native.result?.result?.items[0]; const d = native.distance;
      const facts = event ? [{ kind: 'event-result', query: event.reference.query, id: event.reference.id, extremum: 'maximum', rangeLocation: event.event.state === 'coverage-boundary' ? 'coverage-boundary' : 'interior', observer: event.event.bodies.observer, target: event.event.bodies.target,
        utc: native.utc, rangeKm: event.event.metrics.find(m => m.key === 'range').value, altitudeKm: null, encounter: null, criterion: null, criterionBody: null, thresholdKm: null }] : [{ kind: 'place-distance', object: d.object, place: d.place, placeName: d.placeName, km: d.distanceKm, utc: native.utc, frame: d.frame, body: d.body, datum: d.datum, sourceClassification: d.sourceClassification }];
      window.__ask382.ask.turns = [{ id: 1, prompt: `Local native acceptance: ${catalog}`, fresh: null, steps: [], reply: 'Native measurement is shown above. Full model interpretation is not part of this local fixture.', notes: [], status: 'done', error: null, errorCode: null, stats: null,
        result: { status: 'verified', report: { status: 'met', checks: event ? [{ slot: 'event', ok: true, detail: `result ${event.reference.id} selected`, soft: false }] : [] }, unobservable: [], changes: [], facts, answerIssues: [], intentStated: true, escalated: null } }];
    }, { catalog, native });
    await page.screenshot({ path: `${output}/${catalog}-before.png` });
    await page.locator('.ask-measurements').waitFor();
    const visibleAnswer = await page.locator('.ask-turn').last().innerText();
    assert.match(visibleAnswer, /km/); assert.match(visibleAnswer, /UTC/);
    assert.equal(await page.locator('.ask-explanation[open]').count(), 0);
    await page.screenshot({ path: `${output}/${catalog}.png` });
    const layout = [];
    for (const [width, zoom] of [[1280, 1], [1280, 1.25], [1280, 1.5], [420, 1]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(z => { document.body.style.zoom = String(z); }, zoom);
      const geometry = await page.locator('.ask-measurements').evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth, dockScrollTop: el.closest('.instrument')?.parentElement?.scrollTop ?? null }));
      assert.ok(geometry.scrollWidth <= geometry.width + 1, 'measurement readout fits the panel');
      assert.equal(geometry.dockScrollTop, 0, 'the shared dock remains anchored while the transcript scrolls');
      const composer = await page.getByRole('textbox', { name: 'Request', exact: true }).boundingBox();
      assert.ok(composer && composer.y >= 0 && composer.y + composer.height <= 900, 'composer remains in view');
      layout.push({ width, zoom, geometry });
    }
    await page.evaluate(() => { document.body.style.zoom = '1'; });
    await page.setViewportSize({ width: 1280, height: 900 });
    report.cases.push({ ...data, native, visibleAnswer, layout });
    writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2));
  }
} finally { await browser.close(); }
console.log(`Local native and rendered-answer checks passed: ${output}`);
