/** Overlapping translucent fills, and a selected one, after one-pass
 * compositing and covered cells (#278 review): the real viewer on analytic
 * Mars relief. An imported layer holds two overlapping squares, red and blue
 * at fill opacity 0.5. Each frame is read back with the squares drawn and
 * hidden, so a sample's tint is the overlay alone.
 *
 * Each square tints its own part; where they overlap, the result differs from
 * either square drawn alone (neither fill is lost) and from the lower square
 * drawn twice (no duplicate fill), and is even across the overlap (no gaps or
 * seams). Selecting one square tints it the highlight colour, and the other
 * still shows under it in the overlap.
 *
 * Env: CL_VIEWER_URL (default http://127.0.0.1:5188/), CL_CHROMIUM,
 * CL_GPU=hardware, CL_OUTPUT (default docs/validation/geographic-overlap). */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5188/';
const output = process.env.CL_OUTPUT ?? 'docs/validation/geographic-overlap';
const hardware = process.env.CL_GPU === 'hardware';
const browser = await chromium.launch({
  executablePath: process.env.CL_CHROMIUM ?? (hardware ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium'),
  args: hardware ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const square = (id, lon, lat, size) => ({ type: 'Feature', id, properties: { name: id },
  geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]] } });
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.setDefaultTimeout(120_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { window.__module = (path) => import(performance.getEntriesByType('resource').map((e) => e.name).filter((url) => new URL(url).pathname === path).at(-1) ?? path); });
  await page.goto(`${base}?catalog=test-catalogs/geographic-vectors`);
  await page.waitForFunction(() => window.renderer?.geographicVectors.featureCount > 0);
  const text = JSON.stringify({ type: 'FeatureCollection', features: [square('a', 199, -41, 2), square('b', 200, -40.5, 2)] });
  const layerId = await page.evaluate(async (text) => {
    await window.renderer.waitForInitialAssets(); window.cosmo.setPlaying(false);
    const e = await window.__module('/src/lib/geographic-editing.svelte.ts');
    const s = await window.__module('/src/lib/geographic-styles.svelte.ts');
    const g = await window.__module('/src/lib/geographic-layers.svelte.ts');
    const id = e.importLayerText(text, { body: 'Mars', name: 'Overlap', coordinates: e.inferredCoordinates('Mars') });
    s.setLayerStyle(id, { version: 1, polygon: { fillColor: '#ff3030', fillOpacity: 0.5, outlineOpacity: 0 }, line: { opacity: 0 },
      features: { 'string:b': { color: '#3060ff' } } });
    g.goToFeature({ layerId: id, featureId: 'string:a', bodyName: 'Mars' }, { cut: true });
    window.__g = g;
    return id;
  }, text);
  await page.waitForTimeout(6000);
  const result = await page.evaluate(({ layerId }) => {
    const r = window.renderer, gl = r.renderer.getContext(), v = r.geographicVectors;
    const layer = r.universe.geographicLayers.get(layerId);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, ratio = w / r.renderer.domElement.clientWidth;
    const frame = () => { r.renderFrame(); const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
    const at = (px, lonDeg, latDeg) => {
      const [p] = r.projectGeographicPositions('Mars', [{ lonDeg, latDeg }], layer.datum, { sampleTerrain: true });
      const x = Math.round(p.x * ratio), y = h - 1 - Math.round(p.y * ratio), i = 4 * (y * w + x);
      return [px[i], px[i + 1], px[i + 2]];
    };
    const style = (features) => v.setStyle(layerId, { version: 1, polygon: { fillColor: '#ff3030', fillOpacity: 0.5, outlineOpacity: 0 }, line: { opacity: 0 }, features });
    const both = frame(); const image = r.renderer.domElement.toDataURL('image/png');
    v.setVisible(layerId, false); const off = frame(); v.setVisible(layerId, true);
    style({ 'string:b': { color: '#3060ff', opacity: 0 } }); const aOnly = frame();
    style({ 'string:a': { opacity: 0 }, 'string:b': { color: '#3060ff' } }); const bOnly = frame();
    // The lower square drawn twice: what a duplicate fill would look like.
    style({ 'string:a': { opacity: 0.75 }, 'string:b': { color: '#3060ff', opacity: 0 } }); const aTwice = frame();
    style({ 'string:b': { color: '#3060ff' } });
    const sub = (p, q) => p.map((c, k) => c - q[k]), dist = (p, q) => Math.hypot(...sub(p, q));
    // The squares' extents in the layer's own (stored) coordinates.
    const box = (id) => { const ring = layer.features.find((f) => f.id === id).geometry.coordinates[0], lon = ring.map((c) => c.lonDeg), lat = ring.map((c) => c.latDeg);
      return { w: Math.min(...lon), e: Math.max(...lon), s: Math.min(...lat), n: Math.max(...lat) }; };
    const A = box('string:a'), B = box('string:b'), mix = (p, q, t) => p + (q - p) * t;
    const overlap = [];
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) overlap.push([mix(B.w, A.e, 0.1 + 0.2 * i), mix(B.s, A.n, 0.1 + 0.2 * j)]);
    const samples = overlap.map(([lon, lat]) => ({ both: at(both, lon, lat), off: at(off, lon, lat), a: at(aOnly, lon, lat), b: at(bOnly, lon, lat), twice: at(aTwice, lon, lat) }));
    const tints = samples.map((s) => sub(s.both, s.off));
    const mean = tints[0].map((_, k) => tints.reduce((t, x) => t + x[k], 0) / tints.length);
    const spread = Math.max(...tints.map((t) => dist(t, mean)));
    const aOnlyAt = [mix(A.w, B.w, 0.5), mix(A.s, B.s, 0.5)], bOnlyAt = [mix(A.e, B.e, 0.5), mix(B.s, A.n, 0.5)];
    const aPart = sub(at(both, ...aOnlyAt), at(off, ...aOnlyAt)), bPart = sub(at(both, ...bOnlyAt), at(off, ...bOnlyAt));
    // Selecting the red square tints it; the blue fill under it in the overlap stays.
    v.setSelected({ layerId, featureId: 'string:a', bodyName: 'Mars' });
    const selected = frame(); const selectedImage = r.renderer.domElement.toDataURL('image/png');
    v.setSelected(null);
    const goldPart = at(selected, ...aOnlyAt), goldOverlap = at(selected, ...overlap[12]);
    return {
      aPart, bPart, overlapTint: mean.map(Math.round), overlapSpread: +spread.toFixed(1),
      fromAOnly: Math.min(...samples.map((s) => dist(s.both, s.a))), fromBOnly: Math.min(...samples.map((s) => dist(s.both, s.b))),
      fromATwice: Math.min(...samples.map((s) => dist(s.both, s.twice))),
      selectedPart: goldPart, selectedOverlap: goldOverlap, image, selectedImage,
    };
  }, { layerId });
  for (const name of ['image', 'selectedImage']) {
    await writeFile(`${output}/${name === 'image' ? 'overlap' : 'overlap-selected'}.png`, Buffer.from(result[name].split(',')[1], 'base64'));
    delete result[name];
  }
  console.log(JSON.stringify({ ...result, errors }));
  assert.ok(result.aPart[0] > 60 && result.aPart[0] > 3 * result.aPart[2], `the red square tints its part red (${result.aPart})`);
  assert.ok(result.bPart[2] > 60 && result.bPart[2] > 3 * result.bPart[0], `the blue square tints its part blue (${result.bPart})`);
  assert.ok(result.fromAOnly > 15 && result.fromBOnly > 15, 'neither fill is lost where they overlap');
  assert.ok(result.fromATwice > 15, 'the overlap is not one fill drawn twice');
  assert.ok(result.overlapSpread < 12, `the overlap is even, with no gaps or seams (spread ${result.overlapSpread})`);
  assert.ok(result.selectedPart[1] > result.aPart[1] + 40, `the selected square takes the highlight colour (${result.selectedPart})`);
  assert.ok(result.selectedOverlap[2] > result.selectedPart[2] + 30, `and the other square still shows under it in the overlap (${result.selectedOverlap})`);
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
