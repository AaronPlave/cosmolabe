/** #345 live composition check on the real renderer, no model involved.
 * Start `npm --prefix apps/viewer run dev` first; CL_VIEWER_URL selects another server.
 *
 * Psyche close-up at the paused 2026 Mars flyby with Mars out of frame, then
 * the shared `composeView` operation. Judged by this script's own projection of
 * the render camera, not by the viewer's getViewComposition under test.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173/';
const shot = process.env.ASK_COMPOSITION_SCREENSHOT;
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(new URL('?catalog=test-catalogs/psyche&test=1', base).href, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 120000 });
  await page.evaluate(() => {
    const c = window.cosmo;
    c.setTimeRate(0); c.setPlaying(false);
    c.setTime({ kind: 'calendar', text: '2026-05-15T19:28:00' });
    c.frameObject('Psyche');
  });
  await page.waitForFunction(() => window.cosmo.getFlight() === null, null, { timeout: 60000 });

  const probe = () => page.evaluate(async () => {
    const loaded = path => performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === path);
    const { getRenderer } = await import(loaded('/src/lib/viewer-state.svelte.ts'));
    const r = getRenderer(), cam = r.camera, s = r.scaleFactor;
    await new Promise(requestAnimationFrame);
    cam.updateMatrixWorld();
    const at = name => { const bm = r.getBodyMesh(name), w = bm.getWorldPosition(cam.position.clone()), p = w.clone().project(cam);
      return { rangeKm: w.distanceTo(cam.position) / s, inView: w.clone().applyMatrix4(cam.matrixWorldInverse).z < 0 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 }; };
    return { psyche: at('Psyche'), mars: at('Mars'), et: window.cosmo.getTime(), playing: window.cosmo.isPlaying(), tracked: window.cosmo.getTracked(), selected: window.cosmo.getSelected() };
  });

  // Turn away from Mars, as the reported close-up had it: Mars out of frame.
  if ((await probe()).mars.inView) await page.evaluate(() => window.cosmo.circleCenter('right', 180));
  const before = await probe();
  console.log('close-up', JSON.stringify(before));
  assert.equal(before.tracked, 'Psyche');
  assert.equal(before.mars.inView, false, 'starts with Mars out of frame');

  // The verb a script or Ask runs — through the same capability dispatcher Ask uses.
  const outcome = await page.evaluate(async () => {
    const loaded = path => performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname.endsWith(path));
    const control = await import(loaded('/packages/control/src/index.ts'));
    const tools = control.createCapabilityTools(window.cosmo, { surface: 'fixed' });
    const result = await tools.call('composeView', { anchor: 'Psyche', target: 'Mars' });
    tools.dispose();
    return { ok: result.ok, summary: result.ok ? result.summary : result.error, receipt: result.receipt?.status };
  });
  console.log('composeView', JSON.stringify(outcome));
  const after = await probe();
  console.log('composed', JSON.stringify(after));
  if (shot) await page.screenshot({ path: shot });

  assert.ok(outcome.ok, outcome.summary);
  assert.equal(outcome.receipt, 'completed');
  assert.ok(after.mars.inView, 'Mars centre in the render camera viewport');
  assert.ok(after.psyche.inView, 'Psyche still in view');
  assert.ok(Math.abs(after.psyche.rangeKm - before.psyche.rangeKm) <= before.psyche.rangeKm * 1e-3, 'close-up distance kept');
  assert.equal(after.et, before.et, 'clock unchanged');
  assert.equal(after.playing, false);
  assert.deepEqual([after.tracked, after.selected], [before.tracked, before.selected]);
  console.log('PASS: Psyche close-up kept, Mars brought into frame, time and selection unchanged');
} finally {
  await browser.close();
}
