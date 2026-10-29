#!/usr/bin/env node
/** Loaded-app #238 regression. Local viewer, immutable hosted cube products.
 * CL_VIEWER_URL=http://127.0.0.1:5186/ CHROMIUM_PATH=... node scripts/test-lunar-frame-alignment.mjs
 * Screenshots/metrics go to work/issue-238-browser (or OUT). */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const out = process.env.OUT ?? 'work/issue-238-browser'; await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const report = { errors: [], phases: [], hostedRequests: 0, hostedManifests: [], networkErrors: [] };
page.on('pageerror', error => report.errors.push(error.stack ?? error.message));
// Load actual immutable hosted payloads through the local catalog URL. The
// original manifests remain byte-for-byte unchanged; the runtime applies its
// revision-specific erratum. No published objects are edited.
// Test-only reference: add the bundled real LRO reconstruction to the scene.
// This does not migrate the production LRO catalog or change terrain metadata.
await page.route('**/test-catalogs/moonfall-shackleton.json', async route => {
  const response = await route.fetch(); const catalog = await response.json();
  catalog.spiceKernels = [...(catalog.spiceKernels ?? []), 'kernels/lro/lrorg_2024350_2025074_v01.bsp.gz'];
  catalog.items.find(item => item.name === 'Moon').items.push({ name: 'LRO validation reference', class: 'spacecraft',
    trajectoryFrame: 'MOON_ME_DE421', trajectory: { type: 'Spice', target: 'LRO', center: 'MOON' },
    geometry: { type: 'Globe', radius: 0.001 }, label: { visible: false }, trajectoryPlot: { visible: false } });
  await route.fulfill({ json: catalog });
});
await page.route('**/test-catalogs/data/moon-*/**', async route => {
  if (process.env.HOSTED === '0') return route.continue();
  const path = new URL(route.request().url()).pathname;
  const matches = path.match(/\/data\/(moon-terrain-cube|moon-imagery-cube-wac-nac)\/(.*)$/);
  if (!matches) return route.continue();
  const terrain = matches[1] === 'moon-terrain-cube';
  const url = `https://data.aaronplave.com/${terrain ? 'cube-terrain' : 'cube-imagery'}/${matches[1]}/${terrain ? 'cube-fused-79895697c6b6-g3-m12-b6747ec9d' : 'cube-imagery-composite-3f34a19541af7710'}/${matches[2]}`;
  report.hostedRequests++;
  let response;
  try { response = await route.fetch({ url, timeout: 60000, maxRetries: 3 }); } catch (error) {
    report.networkErrors.push({ url, error: String(error) });await route.abort();return;
  }
  if (['cpu-grids.json','imagery.json','tileset.json'].includes(matches[2])) {
    const bytes = await response.body(); const json = JSON.parse(bytes.toString());
    report.hostedManifests.push({ url, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, source: json.source, registration: json.registration, coordinates: json.coordinates });
  }
  await route.fulfill({ response });
});
try {
  await page.goto(`${process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5186/'}?catalog=test-catalogs/moonfall-shackleton&test=1`);
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, null, { timeout: 120000 });
  await page.evaluate(() => { window.lunarLoader = { getCurrentRenderer: () => window.renderer, getUniverse: () => window.renderer.universe }; window.cosmo.setPlaying(false); });
  await page.waitForFunction(() => {
    const bm = window.lunarLoader.getCurrentRenderer().getBodyMesh('Moon');
    return bm.terrainManager?.frameAvailability.kind === 'available' && bm.terrainCubeStats?.residentTiles > 0 && bm.terrainCubeImageryStats?.ready;
  }, null, { timeout: 120000 });
  for (const [name, lat, lon, altitude] of [['shackleton', -89.67, 129.78, 25], ['pole', -90, 0, 30], ['equator', 0, 0, 2500]]) {
    await page.evaluate(({lat,lon,altitude,name}) => {
      const r = window.lunarLoader.getCurrentRenderer(), bm = r.getBodyMesh('Moon');
      window.cosmo.untrack(); r.cameraController.setOriginBody(bm); r.renderFrame();
      const V = r.camera.position.constructor, phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180;
      const direction = new V(Math.cos(phi)*Math.cos(lambda), Math.cos(phi)*Math.sin(lambda), Math.sin(phi));
      const q = bm.bodyToWorldQuaternion(bm.mesh.quaternion.clone());
      const target = direction.clone().multiplyScalar(1737.4*r.scaleFactor).applyQuaternion(q).add(bm.position);
      const eyeDirection = name === 'pole' ? new V(Math.cos(-89.6*Math.PI/180)*Math.cos(-50*Math.PI/180), Math.cos(-89.6*Math.PI/180)*Math.sin(-50*Math.PI/180), Math.sin(-89.6*Math.PI/180)) : direction;
      const eye = eyeDirection.clone().multiplyScalar((1737.4+altitude)*r.scaleFactor).applyQuaternion(q).add(bm.position);
      r.cameraController.controls.enableDamping = false;
      r.cameraController.controls.target.copy(target); r.camera.position.copy(eye);
      r.camera.up.set(0,1,0).applyQuaternion(q); if(lat===0)r.camera.up.set(0,0,1).applyQuaternion(q);
      r.camera.lookAt(target);r.camera.updateMatrixWorld(true);
    }, {lat,lon,altitude,name});
    const pose = await page.evaluate(() => { const r = window.lunarLoader.getCurrentRenderer(); return { eye: r.camera.position.toArray(), up: r.camera.up.toArray(), target: r.cameraController.controls.target.toArray() }; });
    for (let i = 0; i < 12; i++) {
      await page.evaluate(pose => { const r = window.lunarLoader.getCurrentRenderer(); r.camera.position.fromArray(pose.eye);r.camera.up.fromArray(pose.up);r.cameraController.controls.target.fromArray(pose.target);r.camera.lookAt(r.cameraController.controls.target);r.camera.updateMatrixWorld(true); }, pose);
      await page.waitForTimeout(500);
    }
    const metrics = await page.evaluate(({lat,lon}) => {
      const r = window.lunarLoader.getCurrentRenderer(), u = window.lunarLoader.getUniverse(), bm = r.getBodyMesh('Moon'), et = r.timeController.et;
      const gl = r.getContext().webglRenderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      const V = r.camera.position.constructor;
      const rotation = u.frames.rotation('MOON_ME_DE421', 'ECLIPJ2000', et);
      const expected = [rotation[0], rotation[3], rotation[6]], rendered = new V(1,0,0).applyQuaternion(bm.bodyToWorldQuaternion(bm.mesh.quaternion.clone())).toArray();
      const sample = bm.sampleTerrain(lat, lon);
      const pick = r.pickSurface(0,0);
      return { gpu: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER), glError: gl.getError(), frame: bm.bodyFixedFrame,
        rotationResidual: Math.hypot(...expected.map((v,i)=>v-rendered[i])), sample, pick: pick?.point ?? null,
        camera: r.camera.position.toArray(), bodyCenter: bm.position.toArray(), cameraTarget: r.cameraController.controls.target.toArray(), visible: bm.visible, frameAvailability: bm.terrainManager.frameAvailability, imagery: bm.terrainCubeImageryStats,
        absoluteHopperKm: u.getBody('Polaris-A').stateAt(et).position, terrainRevision: bm.terrainSourceRevision };
    }, {lat,lon});
    report.phases.push({name,...metrics});
    await page.screenshot({ path: `${out}/${name}.png` });
    assert.equal(metrics.frame,'MOON_ME_DE421'); assert.equal(metrics.visible,true);assert.ok(metrics.rotationResidual<1e-12);assert.equal(metrics.glError,0);
    assert.doesNotMatch(metrics.gpu,/SwiftShader|llvmpipe/i);
    assert.ok(metrics.pick, 'Center surface pick is unavailable');assert.equal(metrics.pick.frame,'MOON_ME_DE421');
  }
  report.realSpacecraft = await page.evaluate(() => {
    const r = window.renderer, u = r.universe, before = r.timeController.et;
    window.__cosmolabe.seek('2025-01-15T00:03:00'); r.renderFrame();
    const et = r.timeController.et, actual = r.getBodyMesh('LRO validation reference').position.clone().sub(r.getBodyMesh('Moon').position).divideScalar(r.scaleFactor).toArray();
    const expected = u.spiceInstance.spkpos('LRO', et, 'ECLIPJ2000', 'NONE', 'MOON').position;
    const reference = { et, frame: u.frameOf('LRO validation reference', et), renderedOffsetKm: actual, expectedOffsetKm: expected,
      residualM: Math.hypot(...actual.map((v,i)=>v-expected[i]))*1000 };
    r.timeController.setTime(before); r.renderFrame(); return reference;
  });
  assert.equal(report.realSpacecraft.frame,'MOON_ME_DE421'); assert.ok(report.realSpacecraft.residualM<0.001);
  await page.evaluate(() => window.cosmo.select('Polaris-A'));
  await page.getByText(/Absolute positions.*MOON_ME_DE421/).waitFor();
  const suppliedBefore = await page.evaluate(() => {
    const r = window.renderer, b = r.universe.getBody('Polaris-A');
    window.originalLunarRevision = b.surfaceTrajectory.terrainRevision;
    const position = b.stateAt(r.timeController.et).position;
    b.surfaceTrajectory.terrainRevision = 'audit-mismatch'; return position;
  });
  await page.getByText(/Planned on audit-mismatch/).waitFor();
  const suppliedAfter = await page.evaluate(() => window.renderer.universe.getBody('Polaris-A').stateAt(window.renderer.timeController.et).position);
  assert.deepEqual(suppliedAfter, suppliedBefore); report.revisionDisagreementPreservesPosition = true;
  await page.evaluate(() => { window.renderer.universe.getBody('Polaris-A').surfaceTrajectory.terrainRevision = window.originalLunarRevision; });
  report.orientationRecovery = await page.evaluate(() => {
    const r = window.renderer, bm = r.getBodyMesh('Moon'), rotation = bm.body.rotation;
    const original = rotation.rotationAt, frameRotation = r.universe.frames.rotation;
    try {
      rotation.rotationAt = () => { throw Error('Simulated orientation coverage gap'); };
      r.universe.frames.rotation = function(from,to,et) {
        if (/^MOON_(ME|PA)/i.test(from) || /^MOON_(ME|PA)/i.test(to)) throw Error('Simulated missing lunar transform');
        return frameRotation.call(this,from,to,et);
      };
      r.renderFrame();
    } finally { rotation.rotationAt = original; r.universe.frames.rotation = frameRotation; }
    const hidden = !bm.visible;
    const visibleSurfaceTrailsDuringGap = [...r.trajectoryLines.values()].filter(t => t.body.parentName === 'Moon' && t.body.surfaceTrajectory && t.visible).length;
    r.renderFrame();return { hiddenDuringGap: hidden, visibleAfterRecovery: bm.visible, visibleSurfaceTrailsDuringGap };
  });
  assert.deepEqual(report.orientationRecovery, { hiddenDuringGap: true, visibleAfterRecovery: true, visibleSurfaceTrailsDuringGap: 0 });
  report.provenanceRecovery = await page.evaluate(() => {
    const r = window.renderer, u = r.universe, b = u.getBody('Polaris-A'), et = r.timeController.et;
    const original = b.surfaceTrajectory.frame, supplied = b.stateAt(et).position;
    const event = { id: 'frame-audit', queryId: 'frame-audit', kind: 'distance-range', temporality: 'interval',
      start: et - 20, end: et + 20, bodies: { observer: b.name }, label: 'Provenance regression' };
    r.setEventResults([event], event); r.renderFrame();
    const lines = [...r.trajectoryLines.values()].filter(line => line.body === b);
    const groups = [...r.eventMarkerGroups.values()].filter(group => group.line.body === b);
    const before = { trails: lines.filter(line => line.visible).length, groups: groups.length,
      anchors: groups.filter(({ markers }) => markers.anchorAt(event.id, event.queryId, et)).length };
    const bothResolvable = u.frames.isResolvable(original, et) && u.frames.isResolvable('IAU_MOON', et);
    let withheld;
    try {
      b.surfaceTrajectory.frame = 'IAU_MOON'; r.renderFrame();
      withheld = { marker: !r.getBodyMesh(b.name).present,
        trails: lines.every(line => !line.visible && line.drawnPath().length === 0),
        events: groups.every(({ markers }) => !markers.visible && !markers.spanEmphasis.visible && !markers.spanPreview.visible),
        unchanged: JSON.stringify(b.stateAt(et).position) === JSON.stringify(supplied) };
    } finally { b.surfaceTrajectory.frame = original; r.renderFrame(); }
    const recovered = r.getBodyMesh(b.name).present && lines.some(line => line.visible) &&
      groups.some(({ markers }) => markers.visible && markers.anchorAt(event.id, event.queryId, et));
    r.setEventResults([]);
    return { bothResolvable, before, withheld, recovered: !!recovered };
  });
  assert.equal(report.provenanceRecovery.bothResolvable, true);
  assert.ok(report.provenanceRecovery.before.trails > 0);
  assert.ok(report.provenanceRecovery.before.anchors > 0);
  assert.deepEqual(report.provenanceRecovery.withheld, { marker: true, trails: true, events: true, unchanged: true });
  assert.equal(report.provenanceRecovery.recovered, true);

  await page.getByRole('button', { name: 'Navigate', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Navigate mode' }).getByText('places', { exact: true }).click();
  await page.getByPlaceholder('Name or alias…').fill('Shackleton');
  await page.locator('[aria-label="Named places"] button').filter({ has: page.getByText('Shackleton', { exact: true }) }).click();
  assert.equal(await page.getByRole('button', { name: 'Jump to', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Fly to', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Jump to', exact: true }).click();
  await page.waitForTimeout(1200);
  const placePose = () => page.evaluate(() => ({ target: window.renderer.cameraController.controls.target.toArray(),
    position: window.renderer.camera.position.toArray(), selectedRef: window.renderer.placeNames.selectedRef }));
  const jumped = await placePose();
  assert.equal(jumped.selectedRef, 'moon:usgs:places/gazetteer:5450');
  await page.getByRole('button', { name: 'Back to places', exact: true }).click();
  await page.getByPlaceholder('Name or alias…').fill('Tycho');
  await page.locator('[aria-label="Named places"] button').filter({ has: page.getByText('Tycho', { exact: true }) }).click();
  await page.getByRole('button', { name: 'Jump to', exact: true }).click();
  const away = await placePose();
  assert.ok(Math.hypot(...away.target.map((v, i) => v - jumped.target[i])) > 1e-6);
  await page.getByRole('button', { name: 'Back to places', exact: true }).click();
  await page.getByPlaceholder('Name or alias…').fill('Shackleton');
  await page.locator('[aria-label="Named places"] button').filter({ has: page.getByText('Shackleton', { exact: true }) }).click();
  await page.getByRole('button', { name: 'Fly to', exact: true }).click();
  await page.waitForFunction(() => !window.renderer.cameraController.animating, null, { timeout: 20000 });
  const flown = await placePose();
  assert.ok(Math.hypot(...flown.target.map((v, i) => v - jumped.target[i])) < 1e-8);
  report.placeNavigation = { frame: 'MOON_ME_DE421', jumped, flown };
  await page.screenshot({ path: `${out}/gazetteer-place.png` });
  await page.getByRole('button', { name: 'Navigate', exact: true }).click();
  await page.evaluate(() => window.cosmo.select('Polaris-A'));
  await page.setViewportSize({width:390,height:844}); await page.screenshot({path:`${out}/compact.png`});
  if(process.env.HOSTED !== '0')assert.ok(report.hostedRequests>0);assert.deepEqual(report.errors,[]);report.passed=true;
} finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); await writeFile(`${out}/metrics.json`,JSON.stringify(report,null,2));await context.close();await browser.close(); }
