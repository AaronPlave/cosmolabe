/** Polygon labels at close range (#277 review): the real viewer on streamed
 * Mars terrain (marshub mars_v14, network), labels on for the Gale regions.
 *
 * The camera steps orbit → regional → close → very close, over the inside of
 * the large "Gale crater floor" area and over its edge, zooming in by small
 * dolly steps between the viewpoints while tiles stream. At every step the
 * floor's label must be on screen whenever the floor covers the centre of the
 * view (read from the rendered frame: vectors on against off), and must not
 * drop out between consecutive steps while it does. Also checks the Labels
 * menu offers one "Name" choice, and at every step that each label sits on the
 * surface as drawn now (a pick at its anchor pixel lands on its anchor, within
 * 1% of the range), while tiles refine. Saves a screenshot per viewpoint.
 *
 * Env: CL_VIEWER_URL (default http://127.0.0.1:5188/), CL_CHROMIUM,
 * CL_OUTPUT (default docs/validation/geographic-close-zoom). */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5188/';
const output = process.env.CL_OUTPUT ?? 'docs/validation/geographic-close-zoom';
const FLOOR = 'gale-regions/string:region-1';

const browser = await chromium.launch({ executablePath: process.env.CL_CHROMIUM ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = { steps: [] };
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  page.setDefaultTimeout(180_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?test=1&catalog=test-catalogs/geographic-vectors-mars-streamed`);
  await page.waitForFunction(() => window.renderer?.geographicVectors.featureCount > 0);
  await page.evaluate(async (root) => { window.__core = await import('/@fs' + root + '/packages/core/src/index.ts'); }, resolve('.'));
  await page.getByRole('button', { name: 'Surface layers', exact: true }).waitFor();

  // Labels on through the Style tab; one Name choice in "Label with".
  await page.getByRole('button', { name: 'Surface layers', exact: true }).click();
  // A scene with one layer opens straight into it.
  await page.waitForTimeout(500);
  const open = page.getByRole('button', { name: 'Open Gale regions' });
  if (await open.count()) await open.click();
  await page.getByRole('radio', { name: 'style' }).click();
  const editor = page.locator('[aria-label="Style of Gale regions"]');
  await editor.getByLabel('Labels', { exact: true }).check();
  await editor.getByLabel('Label text').click();
  const options = await page.getByRole('option').allInnerTexts();
  results.labelOptions = options.map((o) => o.trim());
  assert.equal(results.labelOptions.filter((o) => /^name$/i.test(o)).length, 1, `one Name choice (${results.labelOptions.join(', ')})`);
  await page.keyboard.press('Escape');

    const step = (label, save) => page.evaluate(async ({ label, FLOOR, save }) => {
    const r = window.renderer;
    // Labels follow the scene each frame: measure once they have followed the surface just drawn.
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    // Even–odd containment over every ring (so a hole is outside); its own, not the viewer's.
    const areaContains = (g, p) => {
      let inside = false;
      for (const ring of g.coordinates) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi, xj, yj] = [ring[i].lonDeg, ring[i].latDeg, ring[j].lonDeg, ring[j].latDeg];
        if ((yi > p.latDeg) !== (yj > p.latDeg) && p.lonDeg < xi + (p.latDeg - yi) * (xj - xi) / (yj - yi)) inside = !inside;
      }
      return inside;
    };
    // Is the surface under the centre of the view inside the floor (not in its hole)?
    const rect = r.renderer.domElement.getBoundingClientRect();
    const hit = r.pickScene(rect.width / 2, rect.height / 2, 'probe', { renderedOnly: true, bodyMeshes: false });
    const floor = r.universe.geographicLayers.get('gale-regions').features.find((f) => `gale-regions/${f.id}` === FLOOR);
    const centre = hit?.kind === 'surface' ? { latDeg: hit.point.latDeg, lonDeg: hit.point.lonDeg } : null;
    const floorUnderCentre = !!centre && areaContains(floor.geometry, centre);
    const el = document.querySelector(`.geo-label[data-key="${FLOOR}"]`);
    const box = el?.getBoundingClientRect();
    const labelOnScreen = !!box && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight;
    // Registration while tiles refine: the drawn surface at each label's anchor pixel is its anchor.
    const datum = r.universe.geographicLayers.get('gale-regions').datum;
    let worstKm = 0, worstRatio = 0, worst = null;
    for (const l of document.querySelectorAll('.geo-label')) {
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(l.style.transform);
      if (!m) continue;
      const at = r.pickScene(Number(m[1]), Number(m[2]), 'probe', { renderedOnly: true, bodyMeshes: false });
      if (at?.kind !== 'surface') continue;
      const [xKm, yKm, zKm] = at.point.bodyFixedPositionKm;
      const g = window.__core.bodyFixedToGeodetic({ xKm, yKm, zKm }, datum);
      const lat = Number(l.dataset.lat), lon = Number(l.dataset.lon);
      const km = Math.hypot((g.lonDeg - lon) * Math.cos(lat * Math.PI / 180), g.latDeg - lat) * Math.PI / 180 * 3390;
      if (km / Math.max(at.cameraRangeKm, 1e-3) > worstRatio) worst = { key: l.dataset.key, x: +m[1], y: +m[2], lat, lon, hitLat: g.latDeg, hitLon: g.lonDeg, rangeKm: at.cameraRangeKm };
      worstKm = Math.max(worstKm, km); worstRatio = Math.max(worstRatio, km / Math.max(at.cameraRangeKm, 1e-3));
    }
    return { label, floorUnderCentre, centre, labelOnScreen, registration: { worstKm: +worstKm.toFixed(3), worstRatio: +worstRatio.toFixed(4), worst },
      fadingTiles: (() => { let n = 0; r.getBodyMesh('Mars')?.terrainTileGroup?.traverseVisible((o) => { if (o.isMesh && o.material?.defines?.FEATURE_FADE === 1) n++; }); return n; })(), labels: document.querySelectorAll('.geo-label').length,
      altitudeKm: +(r.camera.position.length() / r.scaleFactor - 3396.19).toFixed(2), image: save };
  }, { label, FLOOR, save });

  const settle = async (ms) => { await page.waitForTimeout(ms); };
  const views = ['Mars disk', 'Gale regional', 'Gale floor close', 'Gale floor very close', 'Gale floor edge very close'];
  for (const name of views) {
    await page.evaluate((name) => window.renderer.applyNamedViewpoint(name), name);
    await settle(name === 'Mars disk' ? 4000 : 8000);
    for (let i = 0; i < 6; i++) {
      // Small dolly steps in, while tiles keep streaming; labels are laid out a few times a second.
      if (i) await page.evaluate(() => { const r = window.renderer; r.cameraController.dolly(-(r.camera.position.length() - 3396.19 * r.scaleFactor) * 0.15, 0); });
      await settle(700);
      const s = await step(`${name} · ${i}`, i === 5);
      // The page, not the canvas: labels are DOM over the scene.
      if (s.image) await page.screenshot({ path: `${output}/${name.toLowerCase().replace(/[^a-z]+/g, '-')}.png` });
      delete s.image;
      results.steps.push(s);
      console.log(JSON.stringify(s));
    }
  }
  const relevant = results.steps.filter((s) => s.floorUnderCentre);
  results.floorInViewSteps = relevant.length;
  results.missing = relevant.filter((s) => !s.labelOnScreen).map((s) => s.label);
  results.errors = errors;
  await writeFile(`${output}/close-zoom.json`, JSON.stringify(results, null, 2) + '\n');
  assert.ok(relevant.length >= 6, `the floor covered the view centre in enough steps (${relevant.length})`);
  assert.deepEqual(results.missing, [], 'the floor is labelled whenever it fills the view');
  // Labels sit on the surface as drawn now, through refinement: within 1% of the range (or 50 m).
  results.misregistered = results.steps.filter((s) => s.registration.worstRatio > 0.01 && s.registration.worstKm > 0.05).map((s) => s.label);
  await writeFile(`${output}/close-zoom.json`, JSON.stringify(results, null, 2) + '\n');
  assert.deepEqual(results.misregistered, [], 'labels on the drawn surface while tiles refine');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
