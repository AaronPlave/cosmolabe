#!/usr/bin/env node
// Regression for Saturn's moving planet frame while tracking Tethys at 1 day/s.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173';
const output = process.env.RENDER_CAPTURE_DIR ?? 'apps/viewer/test-screenshots/atmosphere-views';
const view = {
  version: 1, catalog: { catalog: 'test-catalogs/cassini-soi' },
  time: { kind: 'fixed', source: 'ET', et: 144974061.96610013 },
  view: { kind: 'pose', version: 1, frame: 'ECLIPJ2000', origin: 'Tethys',
    camera: { position: [-10666.620616850221, 43566.36081308462, -9432.29882337869],
      target: [0, 0, 0], up: [-0.2750916791973551, -0.45388311140698473, 0.847534476712242], fov: 60 } },
  navigation: { selected: 'Tethys', tracked: 'Tethys', lookAt: 'Saturn', mode: 'free-orbit' },
  playback: { playing: true, rate: 86400 },
  display: { trajectories: true, labels: true, grid: false, axes: false, sensors: true, sensorLabels: true },
};
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/?catalog=test-catalogs%2Fcassini-soi&test=1&view=${encodeURIComponent(JSON.stringify(view))}`);
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, { timeout: 180000 });
  await page.waitForTimeout(1000);
  const result = await page.evaluate(async et => {
    const r = window.renderer;
    r.stop();
    r.cameraController.cancelAnimation();
    r.timeController.setTime(et);
    r.renderFrame();
    r.renderFrame();
    const saturn = r.getBodyMesh('Saturn');
    const ap = r.aerialPerspectiveUniforms.get('Saturn');
    const draws = [];
    const beforeRender = saturn.mesh.onBeforeRender;
    saturn.mesh.onBeforeRender = function(...args) {
      beforeRender.apply(this, args);
      const worldError = Math.max(...this.matrixWorld.elements.map((v, i) => Math.abs(v - ap.uAPPlanetToWorld.value.elements[i])));
      const localOrigin = this.position.clone().set(0, 0, 0).applyMatrix4(this.matrixWorld).applyMatrix4(ap.uAPWorldToPlanet.value);
      draws.push({ et: r.timeController.et, worldError, localOriginError: localOrigin.length() });
    };
    try {
      for (let i = 0; i < 12; i++) {
        r.timeController.step(4320); // 50 ms of playback at 86400 s/s.
        r.renderFrame();
      }
      const moving = r.renderer.domElement.toDataURL('image/png');
      r.renderFrame(); // Same epoch and camera: pausing must not repair the atmosphere.
      const settled = r.renderer.domElement.toDataURL('image/png');
      const steppedDraws = draws.length;
      r.timeController.setRate(86400);
      r.start();
      await new Promise(resolve => setTimeout(resolve, 1500));
      r.stop();
      return { draws, moving, settled, liveDraws: draws.length - steppedDraws, tracked: r.cameraController.trackedBody?.body.name,
        lookAt: r.cameraController.lookAtBody?.body.name };
    } finally { saturn.mesh.onBeforeRender = beforeRender; }
  }, view.time.et);
  for (const name of ['moving', 'settled']) writeFileSync(`${output}/saturn-playback-${name}.png`, Buffer.from(result[name].split(',')[1], 'base64'));
  console.log(JSON.stringify({ draws: result.draws.length, liveDraws: result.liveDraws,
    maxWorldError: Math.max(...result.draws.map(d => d.worldError)),
    maxLocalOriginError: Math.max(...result.draws.map(d => d.localOriginError)),
    tracked: result.tracked, lookAt: result.lookAt }));
  assert.ok(result.liveDraws >= 5, 'exercise live playback at 86400 s/s');
  assert.equal(result.tracked, 'Tethys');
  assert.equal(result.lookAt, 'Saturn');
  assert.ok(result.draws.length >= 12, 'Saturn must be drawn during playback');
  for (const draw of result.draws) {
    assert.ok(draw.worldError < 1e-12, `stale Saturn model frame: ${JSON.stringify(draw)}`);
    assert.ok(draw.localOriginError < 1e-8, `stale Saturn inverse frame: ${JSON.stringify(draw)}`);
  }
  assert.deepEqual(errors, []);
  console.log('Saturn atmosphere frame stays synchronized during Tethys playback.');
} finally { await browser.close(); }
