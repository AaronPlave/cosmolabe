/** Edit handles at close range (#278 review, P1): the real viewer on streamed
 * Mars terrain (marshub mars_v14, network). The "Aeolis Mons" area is copied
 * into annotations through the UI, so it is selected and editable; its ring
 * lies on the lower slopes of Mount Sharp, above the Gale floor.
 *
 * Views: regional, then low over the floor west of the mountain looking at it
 * (the ring higher than the camera, which a surface-normal "facing" test
 * rejected), then very close over the ring itself. In each, vertex handles
 * must show where ring vertices are in view, and no shown handle may be hidden
 * by the drawn surface: picking the surface at a handle's pixel must land on
 * its vertex (within 1% of the camera range), not on terrain in front of it.
 * Also, with the area filling the view, the move cross must be on screen.
 *
 * Env: CL_VIEWER_URL (default http://127.0.0.1:5188/), CL_CHROMIUM,
 * CL_OUTPUT (default docs/validation/geographic-close-handles). */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5188/';
const output = process.env.CL_OUTPUT ?? 'docs/validation/geographic-close-handles';

const browser = await chromium.launch({ executablePath: process.env.CL_CHROMIUM ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = { views: [] };
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  page.setDefaultTimeout(180_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?test=1&catalog=test-catalogs/geographic-vectors-mars-streamed`);
  await page.waitForFunction(() => window.renderer?.geographicVectors.featureCount > 0);
  await page.evaluate(async (root) => {
    window.__core = await import('/@fs' + root + '/packages/core/src/index.ts');
    window.renderer.applyNamedViewpoint('Gale regional');
  }, resolve('.'));
  await page.waitForTimeout(6000);

  // Copy the Aeolis Mons area into annotations: selected and editable at once.
  await page.getByRole('button', { name: 'Surface layers', exact: true }).click();
  await page.waitForTimeout(500);
  const open = page.getByRole('button', { name: 'Open Gale regions' });
  if (await open.count()) await open.click();
  await page.getByRole('option', { name: 'Aeolis Mons Area', exact: true }).click();
  await page.getByRole('button', { name: 'Edit a copy of this feature' }).click();
  await page.getByRole('toolbar', { name: 'Editing shape' }).waitFor();
  // Out of the way of the view: the panel minimized, the scene and the bar remain.
  await page.locator('[aria-label="Minimize"], button[title^="Minimize"]').first().click().catch(() => {});

  /** Put the camera `aboveKm` over the drawn surface at (lat, lon), looking at the surface at (tLat, tLon). */
  const pose = (lat, lon, aboveKm, tLat, tLon) => page.evaluate(({ lat, lon, aboveKm, tLat, tLon }) => {
    const r = window.renderer, core = window.__core, THREE = r.camera.position.constructor;
    const bm = r.getBodyMesh('Mars');
    const datum = { referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] } };
    const [hc, ht] = r.renderedSurfaceHeightsKm('Mars', [{ latDeg: lat, lonDeg: lon }, { latDeg: tLat, lonDeg: tLon }], datum);
    const toWorld = (p) => new THREE(p.xKm, p.yKm, p.zKm).multiplyScalar(r.scaleFactor).applyQuaternion(bm.bodyToWorldQuaternion(bm.mesh.quaternion.clone())).add(bm.position);
    const eye = toWorld(core.geodeticToBodyFixed({ latDeg: lat, lonDeg: lon, heightKm: (hc ?? 0) + aboveKm }, datum));
    const at = toWorld(core.geodeticToBodyFixed({ latDeg: tLat, lonDeg: tLon, heightKm: ht ?? 0 }, datum));
    const up = eye.clone().sub(bm.position).normalize();
    const inv = bm.mesh.quaternion.clone().invert();
    const local = (v) => v.clone().sub(bm.position).applyQuaternion(inv);
    r.cameraController.jumpToSurface(bm, { position: local(eye), target: local(at), up: up.applyQuaternion(inv) });
    return { cameraHeightKm: (hc ?? 0) + aboveKm, targetHeightKm: ht };
  }, { lat, lon, aboveKm, tLat, tLon });

  /** Handles on screen, each checked against a pick at its pixel. */
  const handles = () => page.evaluate(() => {
    const r = window.renderer, core = window.__core;
    const layer = r.universe.geographicLayers.layers.find((l) => l.name === 'My annotations · Mars');
    const ring = layer.features[0].geometry.coordinates[0];
    const canvas = r.renderer.domElement.getBoundingClientRect();
    const out = { vertices: 0, move: 0, hidden: [] };
    for (const el of document.querySelectorAll('.edit-overlay .handle')) {
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2 - canvas.left, y = box.top + box.height / 2 - canvas.top;
      if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) continue;
      if (el.classList.contains('move')) { out.move++; continue; }
      if (!el.classList.contains('vertex')) continue;
      out.vertices++;
      const index = Number(el.getAttribute('aria-label').replace('Vertex ', '')) - 1;
      const v = ring[index];
      const hit = r.pickScene(x, y, 'probe', { renderedOnly: true, bodyMeshes: false });
      if (hit?.kind !== 'surface') continue;
      const [xKm, yKm, zKm] = hit.point.bodyFixedPositionKm;
      const g = core.bodyFixedToGeodetic({ xKm, yKm, zKm }, layer.datum);
      // Ground distance between what is drawn at the handle and the vertex itself.
      const dKm = Math.hypot((g.lonDeg - v.lonDeg) * Math.cos(v.latDeg * Math.PI / 180), g.latDeg - v.latDeg) * Math.PI / 180 * 3390;
      if (dKm > Math.max(0.2, 0.01 * hit.cameraRangeKm)) out.hidden.push({ index, dKm: +dKm.toFixed(2), rangeKm: +hit.cameraRangeKm.toFixed(2) });
    }
    return out;
  });

  const views = [
    { name: 'regional', set: () => page.evaluate(() => window.renderer.applyNamedViewpoint('Gale regional')), expectVertices: true },
    // Low over the floor ~16 km west of the ring, looking east at the mountain: the ring is higher than the camera.
    { name: 'low-looking-at-mons', set: () => pose(-5.05, 136.95, 0.5, -5.05, 137.85), expectVertices: true },
    // Very close over the ring's western vertex, looking along it.
    { name: 'very-close-on-ring', set: () => pose(-5.12, 137.15, 1.2, -4.95, 137.35), expectVertices: true },
    // Inside the area, close: its anchor is out of view, the move cross must not be.
    { name: 'inside-close', set: () => pose(-5.05, 137.75, 2.0, -5.05, 137.95), expectMove: true },
  ];
  for (const view of views) {
    const poseInfo = await view.set();
    await page.waitForTimeout(12000);
    const h = await handles();
    await page.screenshot({ path: `${output}/${view.name}.png` });
    results.views.push({ name: view.name, pose: poseInfo, ...h });
    console.log(JSON.stringify(results.views.at(-1)));
  }
  results.errors = errors;
  await writeFile(`${output}/close-handles.json`, JSON.stringify(results, null, 2) + '\n');
  for (const [i, view] of views.entries()) {
    const r = results.views[i];
    if (view.expectVertices) assert.ok(r.vertices > 0, `${view.name}: vertex handles show where the ring is in view`);
    if (view.expectMove) assert.ok(r.move > 0, `${view.name}: the move cross shows inside the area`);
    assert.deepEqual(r.hidden, [], `${view.name}: no handle shows through the drawn surface`);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
