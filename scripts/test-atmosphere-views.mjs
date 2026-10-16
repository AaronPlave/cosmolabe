#!/usr/bin/env node
// Real-view regression: moving observer, instrument observer, and DDS minification.
// Requires built packages and a local viewer. Cassini assets must be available.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5182';
const output = process.env.RENDER_CAPTURE_DIR ?? 'apps/viewer/test-screenshots/atmosphere-views';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${base}/?catalog=test-catalogs/cassini-soi&test=1`);
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, { timeout: 180000 });
  const assets = await page.evaluate(() => window.__cosmolabe.assetSummary);
  assert.equal(assets.failed, 0, JSON.stringify(assets));
  assert.equal(assets.timedOut, false);
  await page.evaluate(() => window.__cosmolabe.runScript('setPlaying off\nsetTime 2005-07-14T12:58:36Z\ngotoObject Cassini'));
  await page.waitForTimeout(1000);
  const views = await page.evaluate(() => {
    const r = window.renderer;
    r.stop();
    r.setInstrumentView('ISS NAC');
    r.cameraController.flyTo(r.getBodyMesh('Titan'), { duration: 1 });
    let movedFrames = 0;
    const draws = [];
    const render = r.renderer.render;
    r.renderer.render = function(scene, camera) {
      if (scene === r.scene) {
        const kind = camera === r.camera ? 'main' : camera === r.instrumentView.camera ? 'instrument' : 'other';
        if (kind !== 'other') {
          for (const [name, uniforms] of r.aerialPerspectiveUniforms) {
            const atm = r.atmosphereMeshes.get(name).atm;
            const eye = camera.position.clone().applyMatrix4(atm.matrixWorld.clone().invert());
            draws.push({ kind, name, et: r.timeController.et,
              cameraError: uniforms.uAPCameraWorldPos.value.distanceTo(camera.position),
              shellEyeError: atm._camLocal.distanceTo(eye),
              inside: atm.material.uniforms.uCameraInsideShell.value,
              expectedInside: eye.length() < 1 ? 1 : 0 });
          }
        }
      }
      return render.call(this, scene, camera);
    };
    try {
      // Several hours per frame exercise tracking and the refreshed shadow cache.
      for (const step of [0, 3600, 7200, -10800]) {
        r.timeController.step(step);
        const before = r.camera.position.clone();
        r.renderFrame();
        if (before.distanceTo(r.camera.position) > 1e-12) movedFrames++;
      }
      return { draws, movedFrames, restored: [...r.aerialPerspectiveUniforms.values()].every(
        u => u.uAPCameraWorldPos.value.distanceTo(r.camera.position) < 1e-12) };
    } finally { r.renderer.render = render; }
  });
  for (const draw of views.draws) {
    assert.ok(draw.cameraError < 1e-12, `stale ${draw.kind} surface observer: ${JSON.stringify(draw)}`);
    assert.ok(draw.shellEyeError < 1e-10, `stale ${draw.kind} shell observer: ${JSON.stringify(draw)}`);
    assert.equal(draw.inside, draw.expectedInside);
  }
  assert.ok(views.draws.some(d => d.kind === 'main'));
  assert.ok(views.draws.some(d => d.kind === 'instrument'));
  assert.ok(views.movedFrames > 0, 'exercise camera movement during the frame');
  assert.ok(views.restored, 'main observer must be restored after PiP');
  await page.screenshot({ path: `${output}/cassini-instrument.png` });
  await page.evaluate(() => {
    const r = window.renderer;
    r.setInstrumentView(null);
    r.cameraController.cancelAnimation();
    for (const sensor of r.sensorFrustums.values()) sensor.visible = false;
    window.__cosmolabe.runScript('gotoObject Enceladus');
  });
  // gotoObject animates independently of the stopped render loop.
  await page.waitForTimeout(1000);
  const textures = await page.evaluate(() => {
    const r = window.renderer;
    r.renderFrame();
    const bm = r.getBodyMesh('Enceladus');
    const direction = r.getBodyMesh('Sun').position.clone().sub(bm.position).normalize();
    const target = bm.position.clone().divideScalar(r.scaleFactor);
    const eye = target.clone().addScaledVector(direction, bm.displayRadius * 12);
    window.cosmo.setCamera(eye.toArray(), target.toArray(), [0, 0, 1]);
    const map = bm.mesh.material.map;
    const levels = map.mipmaps;
    const filter = map.minFilter;
    r.renderFrame();
    const filtered = window.__cosmolabe.capture();
    // Reproduce the old loader's single-level texture at identical framing.
    map.mipmaps = [levels[0]];
    map.minFilter = map.magFilter;
    map.needsUpdate = true;
    const unfiltered = window.__cosmolabe.capture();
    map.mipmaps = levels;
    map.minFilter = filter;
    map.needsUpdate = true;
    return { levels: levels.map(m => [m.width, m.height]), filtered, unfiltered };
  });
  assert.equal(textures.levels.length, 13);
  assert.deepEqual(textures.levels.at(-1), [1, 1]);
  for (const name of ['filtered', 'unfiltered']) {
    writeFileSync(`${output}/enceladus-${name}.png`, Buffer.from(textures[name].split(',')[1], 'base64'));
  }
  assert.ok(textures.filtered !== textures.unfiltered, 'minification must use the mip chain');
  await page.goto(`${base}/?catalog=test-catalogs/atmosphere-earth&test=1`);
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, { timeout: 120000 });
  const ground = await page.evaluate(() => {
    const r = window.renderer;
    r.stop();
    const earth = r.getBodyMesh('Earth');
    const atm = r.atmosphereMeshes.get('Earth').atm;
    r.cameraController.cancelAnimation();
    // Surface clamping changes the camera during renderFrame. The sky lookup
    // must be regenerated at the clamped observer, even with stars disabled.
    r.camera.position.copy(earth.position);
    r.camera.position.x += (earth.displayRadius + 0.001) * r.scaleFactor;
    r.cameraController.controls.target.copy(r.camera.position);
    r.cameraController.controls.target.z += 0.001;
    r.camera.up.set(1, 0, 0);
    r.camera.lookAt(r.cameraController.controls.target);
    const before = r.camera.position.clone();
    r.renderFrame();
    const expected = r.camera.position.clone().applyMatrix4(atm.matrixWorld.clone().invert());
    return { moved: before.distanceTo(r.camera.position),
      surfaceError: r.aerialPerspectiveUniforms.get('Earth').uAPCameraWorldPos.value.distanceTo(r.camera.position),
      lookupEyeError: atm._skyView.material.uniforms.uSkyEye.value.distanceTo(expected),
      inside: atm.material.uniforms.uCameraInsideShell.value };
  });
  assert.ok(ground.moved > 0, 'exercise final surface clamp');
  assert.equal(ground.inside, 1, JSON.stringify(ground));
  assert.ok(ground.surfaceError < 1e-12);
  assert.ok(ground.lookupEyeError < 1e-10);
  await page.screenshot({ path: `${output}/earth-clamped-sky.png` });
  assert.deepEqual(errors, []);
  console.log(`Passed ${views.draws.length} atmosphere draw checks across moving main/instrument views; 13 DDS levels retained. Captures: ${output}`);
} finally { await browser.close(); }
