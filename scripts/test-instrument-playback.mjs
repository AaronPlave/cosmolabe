/** #334 independent-clock regression: ordinary real-catalog instrument playback. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5797';
const output = process.env.CL_OUTPUT ?? '/tmp/297-instrument-playback';
mkdirSync(output, { recursive: true });
const hardware = process.platform === 'darwin' && process.env.CL_GPU !== 'software';
const browser = await chromium.launch({ ...(hardware ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  args: hardware ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { scenarios: [], passed: false };
try {
  for (const [catalog, sensor, alternate, et] of [
    ['cassini-soi', 'ISS NAC', 'ISS WAC', 152077771.2473141],
    ['europa-clipper', 'EIS NAC', 'EIS WAC', null],
  ]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/?catalog=test-catalogs/${catalog}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 180000 });
    await page.evaluate(async ({ sensor, et, catalog }) => {
      const resource = suffix => performance.getEntriesByType('resource').map(e => e.name).find(u => new URL(u).pathname.endsWith(suffix));
      window.__ir = (await import(resource('/src/lib/viewer-state.svelte.ts'))).getRenderer();
      window.cosmo.setPlaying(false);
      if (et !== null) window.cosmo.setTime({ kind: 'et', et });
      if (catalog === 'cassini-soi') { window.cosmo.track('Cassini'); window.cosmo.pointAtObject('Titan'); }
      (await import(resource('/src/lib/shell.svelte.ts'))).openTool('instrument');
      window.cosmo.selectInstrument(sensor);
    }, { sensor, et, catalog });
    await page.waitForFunction(sensor => window.cosmo.getInstrument()?.sensor === sensor && window.cosmo.getInstrument()?.fresh, sensor);
    const result = { catalog, sensor, initial: await page.evaluate(() => window.cosmo.getInstrument()), playback: [] };
    assert.notEqual(result.initial.pointing, 'unavailable');
    for (const rate of [1, 30]) {
      const samples = await page.evaluate(async rate => {
        const c = window.cosmo, samples = [];
        const read = source => {
          const i = c.getInstrument();
          samples.push({ source, et: c.getTime(), observedEt: i.observedEt, fresh: i.fresh, pointing: i.pointing,
            reason: i.pointingUnavailable, renderError: i.renderError,
            overlay: document.querySelector('.feed .opaque')?.textContent ?? null });
        };
        const off = c.on('time', () => read('clock'));
        const timer = setInterval(() => read('panel'), 25);
        try { c.setTimeRate(rate); c.setPlaying(true); await new Promise(r => setTimeout(r, 4000)); }
        finally { c.setPlaying(false); off(); clearInterval(timer); }
        return samples;
      }, rate);
      assert.ok(samples.length > 20);
      assert.ok(samples.some(s => s.observedEt !== s.et), 'must sample the clock/render gap');
      assert.ok(samples.at(-1).observedEt > samples[0].observedEt, 'feed must actually advance while playing');
      assert.ok(samples.every(s => s.pointing !== 'unavailable' && !s.reason && !s.renderError && !s.overlay), 'covered playback must not black out');
      result.playback.push({ rate, samples: samples.length, staleSamples: samples.filter(s => s.observedEt !== s.et).length,
        observedStart: samples[0].observedEt, observedEnd: samples.at(-1).observedEt });
      // Seek and immediate read must retain truthful previous-epoch pointing.
      const seek = await page.evaluate(() => {
        const c = window.cosmo, before = c.getInstrument();
        c.setTime({ kind: 'et', et: c.getTime() + 10 });
        return { before, after: c.getInstrument(), et: c.getTime() };
      });
      assert.equal(seek.after.pointing, seek.before.pointing);
      assert.equal(seek.after.observedEt, seek.before.observedEt);
      assert.equal(seek.after.fresh, false);
      await page.waitForFunction(() => window.cosmo.getInstrument()?.fresh);
      await page.getByLabel('Instrument', { exact: true }).selectOption(alternate);
      await page.waitForFunction(alternate => window.cosmo.getInstrument()?.sensor === alternate && window.cosmo.getInstrument()?.fresh, alternate);
      assert.notEqual((await page.evaluate(() => window.cosmo.getInstrument())).pointing, 'unavailable');
      await page.getByLabel('Instrument', { exact: true }).selectOption(sensor);
      await page.waitForFunction(sensor => window.cosmo.getInstrument()?.sensor === sensor && window.cosmo.getInstrument()?.fresh, sensor);
    }
    await page.screenshot({ path: `${output}/${catalog}.png` });
    // Controlled missing-attitude source exercises the real unavailable path;
    // this is a fixture, not a claim about the mission's actual CK coverage.
    await page.evaluate(async () => {
      const resource = performance.getEntriesByType('resource').map(e => e.name).find(u => new URL(u).pathname.endsWith('/mission-state.ts'));
      const { MissionStateRotation, MissionStateManager } = await import(resource);
      const sf = window.__ir.sensorFrustums.get(window.cosmo.getInstrument().sensor);
      window.__missingAttitude = { sf, rotation: sf.body.rotation, mounting: sf.mounting };
      sf.body.setRotation(new MissionStateRotation(new MissionStateManager(), 'missing-attitude-fixture'));
      sf.mounting = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      window.cosmo.setTime({ kind: 'et', et: window.cosmo.getTime() + 1 });
      window.__ir.renderFrame();
    });
    await page.waitForFunction(() => window.cosmo.getInstrument()?.pointing === 'unavailable' && window.cosmo.getInstrument()?.fresh);
    result.missingAttitudeFixture = await page.evaluate(() => window.cosmo.getInstrument());
    assert.match(result.missingAttitudeFixture.pointingUnavailable, /attitude is unavailable/);
    await page.locator('.feed .opaque').waitFor();
    await page.screenshot({ path: `${output}/${catalog}-missing-attitude.png` });
    await page.evaluate(() => { const f = window.__missingAttitude; f.sf.body.setRotation(f.rotation); f.sf.mounting = f.mounting;
      window.cosmo.setTime({ kind: 'et', et: window.cosmo.getTime() + 1 }); window.__ir.renderFrame(); });
    await page.waitForFunction(() => window.cosmo.getInstrument()?.pointing !== 'unavailable' && window.cosmo.getInstrument()?.fresh);
    assert.deepEqual(errors, []);
    result.errors = errors; report.scenarios.push(result);
    console.log(JSON.stringify({ catalog, playback: result.playback, missingAttitude: 'observed and recovered' }));
    await page.close();
  }
  report.passed = true;
} finally {
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
