/** Geographic fills and strokes stay solid at very close range: the real
 * viewer on streamed Mars terrain (marshub mars_v14, network), dollying down
 * to a few tens of metres over the Gale floor and over a region's vertex.
 *
 * Absolute body-fixed float32 coordinates step by ~0.25 m at Mars radius, so
 * a shader that derives latitude/longitude from them turns close fills into
 * speckle; and a GPU compiler that reorders float sums rounds anchor-relative
 * differences back to that step, a staircase along every edge. Each step
 * renders the frame with vectors on and off and marks the pixels the fill
 * covers. It counts coverage flips between horizontal neighbours (a clean
 * frame flips only along outlines) and, where an outline crosses the view,
 * the largest row-to-row jump of the edge beyond the typical one.
 *
 * Env: CL_VIEWER_URL (default http://127.0.0.1:5188/), CL_CHROMIUM,
 * CL_GPU=hardware (Chrome with Metal), CL_OUTPUT (default
 * work/geographic/close-precision). */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5188/';
const output = process.env.CL_OUTPUT ?? 'work/geographic/close-precision';
const hardware = process.env.CL_GPU === 'hardware';
const FILL = [0x56, 0xb4, 0xe9], OPACITY = 0.4;
const browser = await chromium.launch({
  executablePath: process.env.CL_CHROMIUM ?? (hardware ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium'),
  args: hardware ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = { steps: [] };
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.setDefaultTimeout(180_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?test=1&catalog=test-catalogs/geographic-vectors-mars-streamed`);
  await page.waitForFunction(() => window.renderer?.geographicVectors.featureCount > 0);

  /** Coverage of a fill-only style: flips between horizontal neighbours, per covered pixel. */
  const measure = (label) => page.evaluate(({ FILL, OPACITY, label }) => {
    const r = window.renderer, gl = r.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const read = () => { const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
    r.geographicVectors.setStyle('gale-regions', { version: 1, polygon: { fillColor: '#56b4e9', fillOpacity: OPACITY, outlineOpacity: 0 }, line: { opacity: 0 } });
    r.renderFrame();
    const on = read();
    r.geographicVectors.setVisible('gale-regions', false);
    r.renderFrame();
    const off = read();
    r.geographicVectors.setVisible('gale-regions', true);
    r.geographicVectors.setStyle('gale-regions', null);
    r.renderFrame();
    const image = r.renderer.domElement.toDataURL('image/png');
    const state = new Int8Array(w * h); // -1 unknown, 0 uncovered, 1 covered
    let covered = 0, known = 0, flips = 0;
    for (let i = 0, k = 0; i < on.length; i += 4, k++) {
      const d = [FILL[0] - off[i], FILL[1] - off[i + 1], FILL[2] - off[i + 2]];
      const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      if (len2 < 60 * 60) { state[k] = -1; continue; } // base too close to the fill colour to tell
      const a = ((on[i] - off[i]) * d[0] + (on[i + 1] - off[i + 1]) * d[1] + (on[i + 2] - off[i + 2]) * d[2]) / len2;
      state[k] = a > OPACITY / 2 ? 1 : 0;
      known++; covered += state[k];
    }
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) {
      const a = state[y * w + x - 1], b = state[y * w + x];
      if (a >= 0 && b >= 0 && a !== b) flips++;
    }
    // Where each row's coverage first changes: a straight edge moves steadily
    // from row to row, a quantized one jumps (a staircase).
    const edge = [];
    for (let y = 0; y < h; y++) {
      let x = -1;
      for (let i = 1; i < w && x < 0; i++) { const a = state[y * w + i - 1], b = state[y * w + i]; if (a >= 0 && b >= 0 && a !== b) x = i; }
      edge.push(x);
    }
    const steps = [];
    for (let y = 1; y < h; y++) if (edge[y] >= 0 && edge[y - 1] >= 0) steps.push(Math.abs(edge[y] - edge[y - 1]));
    steps.sort((a, b) => a - b);
    const jagPx = steps.length > h / 4 ? steps[steps.length - 1] - steps[steps.length >> 1] : null;
    const hit = r.pickScene(r.renderer.domElement.clientWidth / 2, r.renderer.domElement.clientHeight / 2, 'probe', { renderedOnly: true, bodyMeshes: false });
    return { label, rangeKm: hit?.cameraRangeKm ?? null, coveredShare: +(covered / Math.max(1, known)).toFixed(3), flipShare: +(flips / Math.max(1, covered)).toFixed(4), jagPx, image };
  }, { FILL, OPACITY, label });

  for (const view of ['Gale floor edge very close', 'Gale region vertex very close']) {
    await page.evaluate((name) => window.renderer.applyNamedViewpoint(name), view);
    await page.waitForTimeout(10_000);
    let last = null;
    for (let i = 0; i < 8; i++) {
      // Each step closes 60% of the distance to the surface under the centre of the view.
      if (i) await page.evaluate((d) => { const r = window.renderer; r.cameraController.dolly(-d * 0.6 * r.scaleFactor, 0); }, last.rangeKm);
      await page.waitForTimeout(i ? 3000 : 0);
      const m = await measure(`${view} · ${i}`);
      const name = `${view.toLowerCase().replace(/[^a-z]+/g, '-')}-${i}`;
      if (i === 7) await writeFile(`${output}/${name}.png`, Buffer.from(m.image.split(',')[1], 'base64'));
      delete m.image;
      results.steps.push(m);
      console.log(JSON.stringify(m));
      last = m;
      if (!(m.rangeKm > 0)) break;
    }
  }
  results.errors = errors;
  await writeFile(`${output}/close-precision.json`, JSON.stringify(results, null, 2) + '\n');
  const close = results.steps.filter((s) => s.rangeKm < 0.2 && s.coveredShare > 0.1);
  assert.ok(close.length >= 4, `enough steps within 200 m with the fill in view (${close.length})`);
  for (const s of close) assert.ok(s.flipShare < 0.01, `${s.label}: coverage flips on ${(s.flipShare * 100).toFixed(1)}% of covered pixels (speckle)`);
  const edges = close.filter((s) => s.jagPx !== null);
  assert.ok(edges.length >= 3, `enough close steps with an outline across the view (${edges.length})`);
  for (const s of edges) assert.ok(s.jagPx <= 6, `${s.label}: the fill edge jumps ${s.jagPx} px between rows (a staircase)`);
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
