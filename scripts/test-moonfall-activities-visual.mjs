/** Actual MoonFall timeline selection against terrain-cleared flight arcs.
 * node scripts/test-moonfall-activities-visual.mjs [URL] [OUT]
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:5190/';
const out = process.argv[3] ?? 'work/issue-298/timeline';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const report = { passed: false, errors: [], flights: [] };
page.on('pageerror', error => report.errors.push(error.message));
try {
  await page.goto(`${base}?catalog=test-catalogs/moonfall-shackleton`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.cosmo?.listActivities?.().length === 24, null, { timeout: 120000 });
  await page.evaluate(async () => { await window.renderer.waitForInitialAssets(); window.cosmo.setPlaying(false); });
  await page.getByRole('button', { name: 'Expand timeline', exact: true }).first().click();
  const hops = await page.evaluate(() => window.cosmo.listActivities({ kind: 'hop' }));
  assert.equal(hops.length, 12);
  assert.equal(new Set(hops.map(a => a.vehicle)).size, 4);
  for (const activity of hops) {
    const navigation = page.getByRole('group', { name: `${activity.vehicle} hop navigation`, exact: true });
    await navigation.getByRole('button', { name: 'Choose hop', exact: true }).click();
    await page.getByRole('dialog', { name: 'Choose hop', exact: true }).locator(`[data-activity-id="${activity.id}"]`).click();
    const selected = await page.evaluate(() => ({ activity: window.cosmo.getSelectedActivity(), time: window.cosmo.getTime() }));
    assert.equal(selected.activity.id, activity.id);
    assert.equal(selected.activity.vehicle, activity.vehicle);
    assert.ok(Math.abs(selected.time - activity.start) < 1e-4);
    // The UI mark shares the semantic interval; click it as well as the picker.
    const mark = page.getByRole('button', { name: `Go to ${activity.name}`, exact: true });
    await mark.click();
    await page.evaluate(activity => {
      const r = window.renderer; r.timeController.setTime((activity.start + activity.end) / 2); r.renderFrame();
    }, activity);
    await page.waitForTimeout(100);
    assert.ok(await mark.evaluate(node => node.classList.contains('active')));
    const flight = await page.evaluate(activity => {
      const r = window.renderer, b = r.universe.getBody(activity.vehicle), et = r.timeController.et;
      const arc = b.trajectory.arcAt(et);
      return { start: arc.startTime, end: arc.trajectory.endTime, frame: b.arcFrame(arc),
        trails: [...r.trajectoryLines.values()].filter(line => line.body === b && line.drawnTrail().count > 1).length };
    }, activity);
    assert.ok(Math.abs(flight.start - activity.start) < 1e-4);
    assert.ok(Math.abs(flight.end - activity.end) < 1e-4);
    assert.equal(flight.frame, 'MOON_ME_DE421');
    assert.equal(flight.trails, 1);
    await page.evaluate(() => { window.cosmo.setTimeRate(10); window.cosmo.setPlaying(true); });
    await page.waitForFunction(start => window.cosmo.getTime() > start + .01, (activity.start + activity.end) / 2, { timeout: 10000 });
    await page.evaluate(() => window.cosmo.setPlaying(false));
    const playback = await page.evaluate(() => ({ time: window.cosmo.getTime(), selected: window.cosmo.getSelectedActivity()?.id }));
    assert.ok(playback.time > (activity.start + activity.end) / 2);
    assert.equal(playback.selected, activity.id);
    await page.evaluate(activity => { const r = window.renderer; r.timeController.setTime(activity.end + 1); r.renderFrame(); }, activity);
    await page.waitForTimeout(100);
    assert.equal(await mark.evaluate(node => node.classList.contains('active')), false);
    const parked = await page.evaluate(activity => {
      const r = window.renderer, b = r.universe.getBody(activity.vehicle), et = r.timeController.et;
      return { selected: window.cosmo.getSelectedActivity()?.id,
        activeHops: window.cosmo.listActivities({ vehicle: activity.vehicle, kind: 'hop' }).filter(a => a.start <= et && a.end >= et).length,
        trails: [...r.trajectoryLines.values()].filter(line => line.body === b && line.drawnTrail().count > 1).length };
    }, activity);
    assert.deepEqual(parked, { selected: activity.id, activeHops: 0, trails: 0 });
    report.flights.push({ id: activity.id, vehicle: activity.vehicle, name: activity.name, flight, playback, parked });
  }
  await page.screenshot({ path: `${out}/moonfall-timeline.png` });
  report.gpu = await page.evaluate(() => {
    const gl = window.renderer.getContext().webglRenderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER), error: gl.getError() };
  });
  assert.equal(report.gpu.error, 0); assert.doesNotMatch(report.gpu.renderer, /SwiftShader|llvmpipe/i);
  assert.deepEqual(report.errors, []); report.passed = true;
  console.log('PASS: all 12 MoonFall hops selected through picker and interval marks; playback and parked intervals agree.');
} finally {
  await writeFile(`${out}/metrics.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
