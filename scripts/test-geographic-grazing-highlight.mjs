/** A selected outline at a grazing view lights only the outline: the real
 * viewer on streamed Mars terrain (marshub mars_v14, network), 120 m above the
 * Gale floor, 4 km from a region's vertex and looking past it along the floor.
 *
 * Screen derivatives over a 2×2 quad that straddles a silhouette (a ridge and
 * the ground far behind it) are far larger than a pixel's footprint, and a
 * stroke tested with them lit scattered pixels nowhere near it. On ground seen
 * nearly edge-on, a stroke a few pixels wide also reached kilometres in depth,
 * onto ground behind a ridge it is drawn in front of. The frame is
 * rendered with the region selected and not; changed pixels with almost no
 * changed neighbours (isolated specks, not the outline) are counted.
 *
 * Env: CL_VIEWER_URL (default http://127.0.0.1:5188/), CL_CHROMIUM,
 * CL_GPU=hardware (Chrome with Metal), CL_OUTPUT (default
 * work/geographic/grazing-highlight). */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5188/';
const output = process.env.CL_OUTPUT ?? 'work/geographic/grazing-highlight';
const hardware = process.env.CL_GPU === 'hardware';
const browser = await chromium.launch({
  executablePath: process.env.CL_CHROMIUM ?? (hardware ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium'),
  args: hardware ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.setDefaultTimeout(180_000);
  await page.goto(`${base}?test=1&catalog=test-catalogs/geographic-vectors-mars-streamed`);
  await page.waitForFunction(() => window.renderer?.geographicVectors.featureCount > 0);
  await page.evaluate(() => window.renderer.applyNamedViewpoint('Gale floor edge very close'));
  await page.waitForTimeout(8000);
  await page.evaluate(() => {
    const r = window.renderer, V = r.camera.position.constructor, bm = r.getBodyMesh('Mars');
    const hit = r.pickScene(600, 400, 'probe', { renderedOnly: true, bodyMeshes: false });
    const p = new V(...hit.point.bodyFixedPositionKm);
    const layer = r.universe.geographicLayers.get('gale-regions');
    const dir = (c) => { const la = c.latDeg * Math.PI / 180, lo = c.lonDeg * Math.PI / 180; return new V(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)); };
    // The region vertex nearest the floor point, at its height; look along the floor past it.
    let vertex = null;
    for (const f of layer.features) if (f.geometry.type === 'Polygon') for (const c of f.geometry.coordinates[0]) if (!vertex || dir(c).distanceTo(p.clone().normalize()) < dir(vertex).distanceTo(p.clone().normalize())) vertex = c;
    const target = dir(vertex).multiplyScalar(p.length()), up = target.clone().normalize();
    const along = target.clone().sub(p); along.sub(up.clone().multiplyScalar(along.dot(up))).normalize();
    const eye = target.clone().sub(along.clone().multiplyScalar(4)).add(up.clone().multiplyScalar(0.12));
    const local = bm.bodyToWorldQuaternion(new r.camera.quaternion.constructor()).premultiply(bm.mesh.quaternion.clone().invert());
    const L = (v) => v.clone().applyQuaternion(local);
    r.cameraController.jumpToSurface(bm, { position: L(eye).multiplyScalar(r.scaleFactor), target: L(target.clone().add(along.clone().multiplyScalar(8))).multiplyScalar(r.scaleFactor), up: L(up) });
  });
  await page.waitForTimeout(12000);
  const result = await page.evaluate(() => {
    const r = window.renderer, gl = r.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const frame = (selected) => {
      r.geographicVectors.setSelected(selected);
      r.renderFrame();
      const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px;
    };
    const off = frame(null), on = frame({ layerId: 'gale-regions', featureId: 'string:region-1', bodyName: 'Mars' });
    const image = r.renderer.domElement.toDataURL('image/png');
    const changed = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) changed[i] = Math.max(Math.abs(on[4 * i] - off[4 * i]), Math.abs(on[4 * i + 1] - off[4 * i + 1]), Math.abs(on[4 * i + 2] - off[4 * i + 2])) > 40 ? 1 : 0;
    let outline = 0, isolated = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!changed[y * w + x]) continue;
      let near = 0;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) if (changed[(y + dy) * w + x + dx]) near++;
      if (near <= 6) isolated++; else outline++;
    }
    return { outline, isolated, image };
  });
  await writeFile(`${output}/selected.png`, Buffer.from(result.image.split(',')[1], 'base64'));
  delete result.image;
  await writeFile(`${output}/grazing-highlight.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  assert.ok(result.outline > 1000, 'the selected outline is in view (otherwise this run tested nothing)');
  // Distant stretches of the outline break up legitimately at this angle. 86
  // before both guards, 29 with the silhouette guard alone, 12 with both.
  assert.ok(result.isolated < 20, `${result.isolated} isolated highlight pixels`);
} finally { await browser.close(); }
