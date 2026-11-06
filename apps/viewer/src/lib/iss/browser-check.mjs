/**
 * Real-browser check of the ISS articulation plugin against the `iss` catalog.
 * Start `npm --prefix apps/viewer run dev` first, then:
 *   node apps/viewer/src/lib/iss/browser-check.mjs [outDir]
 * The plugin is registered from the page (no viewer wiring), the arrays are
 * read back from the loaded glTF nodes, and orbital and close-up captures are
 * written to outDir.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173/';
const outDir = process.argv[2] ?? 'work/iss-articulation';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || /ISS articulation/.test(m.text())) console.log('[page]', m.type(), m.text()); });
  await page.goto(new URL('?catalog=test-catalogs/iss&test=1', base).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.renderer?.getBodyMesh?.('ISS') && window.__cosmolabe?.assetsReady, null, { timeout: 120000 });

  await page.evaluate(async () => {
    const { IssArticulationPlugin } = await import('/src/lib/iss/plugin.ts');
    window.issPlugin = new IssArticulationPlugin();
    window.renderer.use(window.issPlugin);
  });
  await page.waitForFunction(() => window.renderer.getBodyMesh('ISS').modelContainer, null, { timeout: 120000 });

  const read = () => page.evaluate(() => {
    const r = window.renderer, mesh = r.getBodyMesh('ISS');
    const node = (n) => mesh.modelContainer.getObjectByName(n);
    const angle = (o, axis) => 2 * Math.atan2(o.quaternion[axis], o.quaternion.w);
    return {
      status: window.issPlugin.status('ISS'),
      visible: mesh.isModelVisible,
      s4Truss: angle(node('23_S4_Truss'), 'x'), p4Truss: angle(node('20_P4_Truss'), 'x'),
      s4Array: angle(node('23_S4_Truss_01'), 'z'), p6Array: angle(node('08_P6_Truss_02'), 'z'),
      et: r.timeController.currentTime ?? null,
    };
  });

  // Close up: frame the whole station.
  await page.evaluate(() => { const r = window.renderer; r.cameraController.frame(r.getBodyMesh('ISS'), { scaleFactor: r.scaleFactor }); });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.renderer.getContext().renderFrame());
  const closeA = await read();
  console.log('close-up A', JSON.stringify(closeA));
  assert.equal(closeA.status?.mode, 'approximate-sun-tracking', 'plugin must attach to the loaded ISS model');
  await page.screenshot({ path: `${outDir}/close-up.png` });

  // Seek half an orbit later; the arrays track the moved Sun/attitude, with no history.
  // No SPICE in this catalog, so seek through the time controller with core's UTC-to-ET.
  const seek = (iso) => page.evaluate(async (t) => {
    const { etFromDate } = await import('/@fs/home/user/cosmolabe/packages/core/src/index.ts');
    window.renderer.timeController.setTime(etFromDate(new Date(t)));
    return true;
  }, iso);
  const t0 = new Date('2026-11-04T11:30:00Z').getTime();
  const poses = [];
  for (const dtMin of [0, 23, 47, 0]) {
    assert.ok(await seek(new Date(t0 + dtMin * 60000).toISOString()), 'seek');
    await page.waitForTimeout(400);
    await page.evaluate(() => window.renderer.getContext().renderFrame());
    poses.push({ dtMin, ...(await read()) });
  }
  console.log(JSON.stringify(poses.map((p) => ({ dtMin: p.dtMin, s4Truss: +p.s4Truss.toFixed(4), s4Array: +p.s4Array.toFixed(4), mode: p.status?.mode }))));
  assert.ok(Math.abs(poses[0].s4Truss - poses[1].s4Truss) > 0.05 || Math.abs(poses[0].s4Array - poses[1].s4Array) > 0.05, 'arrays move with time');
  assert.ok(Math.abs(poses[0].s4Truss - poses[3].s4Truss) < 1e-6 && Math.abs(poses[0].s4Array - poses[3].s4Array) < 1e-6, 'returning to a time gives the same pose (no history dependence)');

  // Orbital view: the catalog's own Earth-from-orbit viewpoint.
  await page.evaluate(() => window.renderer.applyNamedViewpoint('Earth from orbit'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/orbital.png` });

  // Scene disposal restores the authored pose.
  const restored = await page.evaluate(() => { window.issPlugin.dispose(); const m = window.renderer.getBodyMesh('ISS').modelContainer; return 2 * Math.atan2(m.getObjectByName('23_S4_Truss').quaternion.x, m.getObjectByName('23_S4_Truss').quaternion.w); });
  assert.ok(Math.abs(restored - Math.PI / 3) < 1e-4, 'dispose restores the authored 60 degree rest pose');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('OK');
} finally {
  await browser.close();
}
