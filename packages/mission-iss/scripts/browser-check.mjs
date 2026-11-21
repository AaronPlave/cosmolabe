/**
 * Real-browser check of the ISS mission plugin through the ordinary viewer
 * (#370): the public `iss` (Earth from Orbit) catalog is loaded by URL, the
 * plugin is installed by the host's trusted registry (nothing is registered
 * from the page), and we check what a user gets.
 *
 * Start `npm --prefix apps/viewer run dev` first, then from the repo root:
 *   node packages/mission-iss/scripts/browser-check.mjs [outDir]
 * Env: CL_VIEWER_URL (default http://127.0.0.1:5173/), CHROMIUM_PATH, SWIFTSHADER=1 to force software GL, GPU=1 to ask for the real (Metal) GPU.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173/';
const root = process.cwd();
const outDir = process.argv[2] ?? 'work/iss-articulation';
mkdirSync(outDir, { recursive: true });
const APPROX = 'Approximate Sun tracking (not recorded ISS array positions)';

const args = process.env.SWIFTSHADER ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] : process.env.GPU ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox'] : ['--no-sandbox'];
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || /ISS articulation|mission plugin/.test(m.text())) console.log('[page]', m.type(), m.text()); });

  const ready = (catalog, body) => page.waitForFunction((b) => window.renderer?.getBodyMesh?.(b) && window.__cosmolabe?.assetsReady && (b !== 'ISS' || window.renderer.getBodyMesh(b).modelContainer), body, { timeout: 120000 });
  await page.goto(new URL('?catalog=test-catalogs/iss&test=1', base).href, { waitUntil: 'domcontentloaded' });
  await ready('iss', 'ISS');
  console.log('GL:', await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl?.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; }));

  // 1. The registry installed exactly one plugin, with no page-side registration.
  const pluginCount = () => page.evaluate(() => window.renderer.getPlugins().filter((p) => p.name === 'iss-articulation').length);
  assert.equal(await pluginCount(), 1, 'iss-articulation installed once by the host registry');

  // Close-up first, straight after load: frame the whole station and wait until the camera is within 1 km.
  await page.evaluate(() => { const r = window.renderer; r.cameraController.frame(r.getBodyMesh('ISS'), { scaleFactor: r.scaleFactor }); });
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.renderer.getContext().renderFrame());
  await page.screenshot({ path: path.join(outDir, 'close-up.png') });

  const pose = () => page.evaluate(() => {
    const node = (n) => window.renderer.getBodyMesh('ISS').modelContainer.getObjectByName(n);
    const angle = (o, axis) => 2 * Math.atan2(o.quaternion[axis], o.quaternion.w);
    return { s4Truss: angle(node('23_S4_Truss'), 'x'), p4Truss: angle(node('20_P4_Truss'), 'x'), s4Array: angle(node('23_S4_Truss_01'), 'z'), p6Array: angle(node('08_P6_Truss_02'), 'z') };
  });
  const seek = (iso) => page.evaluate(async ({ iso, root }) => {
    const { etFromDate } = await import('/@fs/' + root + '/packages/core/src/index.ts');
    window.renderer.timeController.setTime(etFromDate(new Date(iso)));
  }, { iso, root });
  const settle = async () => { await page.waitForTimeout(500); await page.evaluate(() => window.renderer.getContext().renderFrame()); };

  // 2. Contextual readout in the viewer's own info panel, saying approximate.
  await page.evaluate(async () => { const s = await import('/src/lib/viewer-state.svelte.ts'); s.selectBody('ISS'); });
  await page.getByText(APPROX).first().waitFor({ timeout: 15000 });
  console.log('readout present:', APPROX);

  // 3. Arrays move with time, and a time gives the same pose however it was reached (seek and reverse).
  const t0 = Date.parse('2026-11-04T11:30:00Z');
  const at = async (min) => { await seek(new Date(t0 + min * 60000).toISOString()); await settle(); return pose(); };
  const a = await at(0), b = await at(23), c = await at(47), a2 = await at(0), c2 = await at(47);
  console.log(JSON.stringify([a, b, c].map((p) => ({ truss: +p.s4Truss.toFixed(3), array: +p.s4Array.toFixed(3) }))));
  assert.ok(Math.abs(a.s4Truss - b.s4Truss) > 0.05 || Math.abs(a.s4Array - b.s4Array) > 0.05, 'arrays move with simulation time');
  for (const k of Object.keys(a)) { assert.ok(Math.abs(a[k] - a2[k]) < 1e-6, `${k}: reverse/seek to 0 reproduces the pose`); assert.ok(Math.abs(c[k] - c2[k]) < 1e-6, `${k}: seek to 47 min reproduces the pose`); }

  // 4. Body attitude is the scene's; only joint nodes move.
  const hullMoved = await page.evaluate(() => { const m = window.renderer.getBodyMesh('ISS').modelContainer; const h = m.getObjectByName('09_Destiny_Space_Laboratory'); return h ? h.quaternion.toArray() : null; });
  assert.deepEqual(hullMoved.map((v) => Math.abs(v) < 1e-9 ? 0 : v), [0, 0, 0, 1], 'hull module keeps its authored rotation');

  // Orbital view: the catalog's own Earth-from-orbit viewpoint.
  await page.evaluate(() => window.renderer.applyNamedViewpoint('Earth from orbit'));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(outDir, 'orbital.png') });

  // 6. Switch to an unrelated catalog and back: no plugin on the other scene, authored pose restored on the old
  //    model, exactly one plugin again after returning.
  // Import the loader under the exact URL the app loaded it from (Vite may add a ?t= timestamp); a second URL is a second module instance with no scene to tear down.
  const switchTo = (name) => page.evaluate(async (n) => {
    const url = performance.getEntriesByType('resource').map((e) => e.name).find((u) => /\/src\/lib\/loader\.ts/.test(u)) ?? '/src/lib/loader.ts';
    const { loadDemo } = await import(url);
    await loadDemo(document.querySelector('canvas'), n);
  }, name);
  const oldModel = await page.evaluateHandle(() => window.renderer.getBodyMesh('ISS').modelContainer);
  await switchTo('test-catalogs/earth-moon');
  await page.waitForFunction(() => window.renderer?.getBodyMesh?.('Moon') && !window.renderer.getBodyMesh('ISS'), null, { timeout: 120000 });
  assert.equal(await pluginCount(), 0, 'an unrelated catalog does not inherit the plugin');
  const restored = await page.evaluate((m) => { const q = m.getObjectByName('23_S4_Truss').quaternion; return 2 * Math.atan2(q.x, q.w); }, oldModel);
  assert.ok(Math.abs(restored - Math.PI / 3) < 1e-4, 'old scene teardown restored the authored 60 degree rest pose');
  await switchTo('test-catalogs/iss');
  await ready('iss', 'ISS');
  assert.equal(await pluginCount(), 1, 'returning installs exactly one plugin');
  await settle();
  assert.equal(await page.evaluate(() => window.renderer.getPlugins().find((p) => p.name === 'iss-articulation').status('ISS')?.mode), 'approximate-sun-tracking', 'articulating again after return');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('OK');
} finally {
  await browser.close();
}
