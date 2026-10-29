/** Loaded MoonFall scene: native hardware GPU, actual composite caches/markers,
 * normal/accelerated playback, days of scrubbing, rest and origin changes.
 * Start Vite, then node scripts/test-moonfall-flights-visual.mjs [URL] [OUT]. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';

const base = process.argv[2] ?? 'http://127.0.0.1:5178/';
const out = process.argv[3] ?? 'work/issue-298/browser';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const report = { passed: false, phases: [], errors: [] };
page.on('pageerror', e => report.errors.push(e.message));
try {
  await page.goto(`${base}?catalog=test-catalogs/moonfall-shackleton`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.renderer?.trajectoryLines?.has('Polaris-D__arc4'), null, { timeout: 120000 });
  await page.evaluate(async () => {
    await window.renderer.waitForInitialAssets();
    window.cosmo.setPlaying(false);
    window.cosmo.untrack();
  });
  const snapshot = async (key, close = false) => {
    await page.evaluate(close => {
      const r = window.renderer; r.renderFrame();
      const moon = r.getBodyMesh('Moon'), V = r.camera.position.constructor;
      const at = (lat, lon, alt) => {
        const la = lat * Math.PI / 180, lo = lon * Math.PI / 180, radius = 1737.4 + alt;
        return new V(radius * Math.cos(la) * Math.cos(lo), radius * Math.sin(la), -radius * Math.cos(la) * Math.sin(lo))
          .applyQuaternion(moon.mesh.quaternion).multiplyScalar(r.scaleFactor).add(moon.position);
      };
      let eye = at(-89.25, -45, 25), target = at(-89.6, -30, -1);
      if (close) {
        target = r.getBodyMesh('Polaris-D').position.clone();
        const up = target.clone().sub(moon.position).normalize();
        const east = at(-89.25, 45, 25).sub(eye).normalize();
        eye = target.clone().addScaledVector(up, 1.5 * r.scaleFactor).addScaledVector(east, 2.5 * r.scaleFactor);
      }
      r.cameraController.controls.staticMoving = true;
      r.cameraController.controls.target.copy(target); r.camera.position.copy(eye);
      r.camera.up.copy(eye.clone().sub(moon.position).normalize());
      r.camera.fov = 60; r.camera.updateProjectionMatrix(); r.camera.lookAt(target); r.camera.updateMatrixWorld(true);
      r.renderFrame();
    }, close);
    await page.waitForTimeout(1000);
    const phase = await page.evaluate(() => {
      const r = window.renderer; r.renderFrame();
      const gl = r.getContext().webglRenderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      const et = r.timeController.et;
      return { et, image: r.getContext().webglRenderer.domElement.toDataURL(), gpu: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER), glError: gl.getError(),
        origin: r.cameraController.originBody?.body.name,
        terrain: r.getBodyMesh('Moon').terrainMetrics,
        lines: [...r.trajectoryLines].filter(([id]) => id.startsWith('Polaris-')).map(([id, line]) => {
          const plot = r.trajectoryPlotFrames.get(line), local = line.positionAt(et);
          const head = local ? line.localToWorld(new r.camera.position.constructor(...local).multiplyScalar(r.scaleFactor)) : null;
          return { id, visible: line.visible, vertices: line.drawnTrail().count, cachePoints: line.cache?.count,
            frame: plot?.frame, markerErrorM: head && line.visible ? head.distanceTo(r.getBodyMesh(line.body.name).position) / r.scaleFactor * 1000 : null };
        }) };
    });
    const bytes = Buffer.from(phase.image.split(',')[1], 'base64'); delete phase.image;
    await writeFile(`${out}/${key}-canvas.png`, bytes);
    const pixels = await sharp(bytes).removeAlpha().raw().toBuffer();
    let lit = 0; for (let i = 0; i < pixels.length; i += 3) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) lit++;
    phase.litPixels = lit;
    report.phases.push({ key, ...phase });
    assert.ok(lit > 1000, 'Scene capture is empty');
    assert.doesNotMatch(phase.gpu, /SwiftShader|llvmpipe|software/i);
    assert.equal(phase.glError, 0);
    assert.equal(phase.lines.length, 12, 'Rest arcs must allocate no lines/caches');
    for (const line of phase.lines) {
      assert.equal(line.frame, 'IAU_MOON');
      if (line.markerErrorM !== null) assert.ok(line.markerErrorM < 1, `${line.id} detached: ${line.markerErrorM}m`);
    }
    await page.screenshot({ path: `${out}/${key}.png` });
    return phase;
  };
  for (const index of [0, 2, 4]) {
    await page.evaluate(index => {
      const r = window.renderer, arc = r.universe.getBody('Polaris-D').trajectory.arcs[index];
      r.timeController.setTime((arc.startTime + arc.endTime) / 2);
      r.cameraController.setOriginBody(r.getBodyMesh('Moon'));
    }, index);
    await page.waitForTimeout(1500);
    const active = await snapshot(`flight-${index / 2 + 1}`);
    assert.ok(active.lines.some(l => l.visible && l.vertices > 100), 'Short hop has insufficient curve detail');
    // Exercise a different floating origin, then return to the overview.
    await page.evaluate(() => { const r = window.renderer; r.cameraController.setOriginBody(r.getBodyMesh('Polaris-D')); });
    await page.waitForTimeout(200);
    await snapshot(`hopper-origin-${index}`);
    await snapshot(`close-flight-${index}`, true);
  }
  await page.evaluate(() => {
    const r = window.renderer, a = r.universe.getBody('Polaris-D').trajectory.arcs[1];
    r.timeController.setTime((a.startTime + a.endTime) / 2);
    r.cameraController.setOriginBody(r.getBodyMesh('Moon'));
  });
  await page.waitForTimeout(500);
  const parked = await snapshot('parked');
  assert.equal(parked.lines.filter(l => l.visible).length, 0);
  for (const rate of [1, 1000]) {
    await page.evaluate(rate => {
      const r = window.renderer, a = r.universe.getBody('Polaris-D').trajectory.arcs[0];
      r.timeController.setTime(a.startTime + 150);
      window.cosmo.setTimeRate(rate); window.cosmo.setPlaying(true);
    }, rate);
    await page.waitForTimeout(rate === 1 ? 1200 : 250);
    await page.evaluate(() => window.cosmo.setPlaying(false));
    await snapshot(`playback-${rate}`);
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await writeFile(`${out}/metrics.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
