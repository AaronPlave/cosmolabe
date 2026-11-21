/** Real MoonFall Surface Flight input/frame pacing; run before and after changes. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import ts from 'typescript';

const base = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'work/moonfall-jank/pacing';
const baselineIndex = process.argv.indexOf('--baseline');
const baseline = baselineIndex >= 0 ? process.argv[baselineIndex + 1] : null;
const imageryOnly = process.argv.includes('--imagery-only');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  args: ['--enable-gpu', '--ignore-gpu-blocklist', process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const result = { baseline, imageryOnly, errors: [], scenarios: [], passed: false };
page.on('pageerror', e => result.errors.push(e.message));
page.on('console', m => { if (/GL_INVALID|INVALID_OPERATION|Shader Error/.test(m.text())) result.errors.push(m.text()); });
try {
  if (baseline) for (const path of imageryOnly ? ['CubeImageryLayer'] : ['CubeImageryLayer', 'controls/modes/SurfaceMode']) {
    await page.route(`**/packages/three/src/${path}.ts*`, async route => {
      const current = await route.fetch(), code = await current.text();
      const three = /from\s+["']([^"']*three[^"']*\.js[^"']*)["']/.exec(code)?.[1];
      assert.ok(three);
      let source = ts.transpileModule(await readFile(resolve(baseline, path + '.ts'), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
      source = source.replace(/from ['"]three['"]/g, `from ${JSON.stringify(three)}`)
        .replace(/from ['"](\.\.?\/[^'"]+)\.js['"]/g, (_, relative) =>
          `from ${JSON.stringify('/@fs/' + resolve('packages/three/src', dirname(path), relative + '.ts'))}`);
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: source });
    });
  }
  await page.goto(`${base}?catalog=test-catalogs/moonfall-shackleton`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.renderer?.getBodyMesh('Moon')?.terrainManager?.cubeImageryStats?.version, null, { timeout: 120000 });
  await page.evaluate(async () => {
    const r = window.renderer;
    await r.waitForInitialAssets();
    window.cosmo.setPlaying(false);
    const t = r.getBodyMesh('Moon').terrainManager;
    await t.cube.source.ready; await t.cubeImageryLayer.ready;
    const la = -89.67 * Math.PI / 180, lo = 129.78 * Math.PI / 180;
    const d = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const outer = t.bodyRadiusKm + 50;
    await t.cube.surface.ensureRayCoverage({ origin: { xKm: d[0] * outer, yKm: d[1] * outer, zKm: d[2] * outer }, direction: d.map(v => -v), nearKm: 0, farKm: 150 }, { maxMeshErrorKm: 0 }, AbortSignal.timeout(30000));
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  for (const stressed of [false, true]) {
    await page.evaluate(async () => {
      const cc = window.renderer.cameraController;
      cc.setMode('free-orbit');
      cc.setMode('surface', { bodyName: 'Moon', latDeg: -89.67, lonDeg: 129.78, altKm: 5, headingDeg: 180, pitchDeg: -5 });
      // Direct controller setup bypasses the viewer action's HUD synchronization.
      const { vs } = await import('/src/lib/viewer-state.svelte.ts');
      vs.cameraMode = cc.mode;
    });
    await page.waitForTimeout(3000);
    await page.evaluate(stressed => {
      const r = window.renderer, b = r.getBodyMesh('Moon'), mode = r.cameraController._activeMode;
      window.pacing = [];
      const original = mode.update;
      window.restorePacing = () => { mode.update = original; };
      let last;
      mode.update = function(ctx) {
        const before = r.camera.position.clone(), start = performance.now();
        original.call(this, ctx);
        const stepKm = before.distanceTo(r.camera.position) / r.scaleFactor;
        window.pacing.push({ moving: this.keys.has('KeyD'), dt: ctx.dt, intervalMs: last == null ? null : start - last,
          speedKmPerSec: this.speedKmPerSec, altitudeKm: this.altitudeKm,
          stepKm, actualKmPerSec: stepKm / ctx.dt, imageryMs: b.terrainManager.cubeImageryStats.updateMs,
          baseUncovered: b.terrainManager.cubeImageryStats.baseUncoveredBlocks });
        last = start;
        // Deliberate alternating long frames, below the controller's 100ms pause cap.
        if (stressed && window.pacing.length % 5 === 0) {
          const until = performance.now() + 35; while (performance.now() < until) { /* deterministic CPU load */ }
        }
      };
    }, stressed);
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(5000);
    await page.keyboard.up('KeyD');
    const row = await page.evaluate(() => {
      const r = window.renderer, gl = r.getContext().webglRenderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      window.restorePacing();
      return { mode: r.cameraController.mode, gpu: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER), samples: window.pacing };
    });
    row.stressed = stressed;
    const stats = values => { const a = values.sort((a,b) => a-b); return { min: a[0], p50: a[Math.floor(a.length * .5)], p95: a[Math.floor(a.length * .95)], max: a.at(-1) }; };
    row.frameMs = stats(row.samples.slice(2).map(s => s.intervalMs));
    row.imageryMs = stats(row.samples.slice(2).map(s => s.imageryMs));
    const moving = row.samples.filter(s => s.moving);
    row.speed = stats(moving.map(s => s.actualKmPerSec));
    row.commandedSpeed = stats(moving.map(s => s.speedKmPerSec));
    row.elapsedSeconds = moving.reduce((sum, s) => sum + s.dt, 0);
    row.distanceKm = moving.reduce((sum, s) => sum + s.stepKm, 0);
    row.speedRelativeSpread = (row.speed.max - row.speed.min) / row.speed.p50;
    result.scenarios.push(row);
    assert.ok(!/SwiftShader|llvmpipe/i.test(row.gpu), 'Physical GPU required');
    assert.equal(row.mode, 'surface');
    if (!baseline || imageryOnly) assert.ok(row.speedRelativeSpread < .001, 'Terrain/variable frame time changed cruise speed');
    assert.ok(moving.every(s => s.baseUncovered === 0), 'Movement lost mandatory imagery coverage');
    await page.screenshot({ path: `${out}/${stressed ? 'stressed' : 'normal'}.png` });
  }
  if (!baseline || imageryOnly) {
    const clearance = () => page.evaluate(() => window.renderer.cameraController._activeMode.altitudeKm);
    const before = await clearance();
    await page.mouse.move(720, 450); await page.mouse.wheel(0, 120);
    await page.waitForTimeout(150);
    const after = await clearance();
    result.wheel = { beforeKm: before, afterKm: after };
    assert.ok(Math.abs(after / before - 1.15) < .001, 'Native wheel did not change physical clearance');
  }
  const { profile } = await cdp.send('Profiler.stop');
  await writeFile(`${out}/cpu-profile.json`, JSON.stringify(profile));
  assert.deepEqual(result.errors, []);
  result.passed = true;
} finally {
  await writeFile(`${out}/metrics.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result.scenarios.map(({ samples, ...row }) => row), null, 2));
  await browser.close();
}
