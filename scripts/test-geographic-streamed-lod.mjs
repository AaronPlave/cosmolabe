/** Filled geographic regions through active terrain LOD (#278 review): the
 * real viewer on streamed Mars terrain (marshub mars_v14, network), zooming
 * from a regional view to a close one while tiles refine and cross-fade.
 *
 * At each step the same frame is rendered twice in one task, vectors on and
 * then off: no tile can load in between, so the difference is the overlay
 * alone. With a constant fill colour F at opacity a over a base pixel B, a
 * single blend gives out = B + a·(F − B); a fill drawn twice gives an
 * effective opacity of 1 − (1 − a)². The script estimates each covered
 * pixel's opacity and reports the share that was blended twice, and how many
 * terrain tiles were mid cross-fade. A settled frame and a mid-zoom frame are
 * saved as PNGs.
 *
 * Env: CL_VIEWER_URL (default http://127.0.0.1:5188/), CL_CHROMIUM, CL_GPU=hardware (Chrome with Metal),
 * CL_OUTPUT (default docs/validation/geographic-streamed-lod), CL_STEPS,
 * CL_FADE_MS (the cross-fade, stretched for software rendering; default 6000). */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5188/';
const output = process.env.CL_OUTPUT ?? 'docs/validation/geographic-streamed-lod';
const steps = Number(process.env.CL_STEPS ?? 40);
const FILL = [0x56, 0xb4, 0xe9], OPACITY = 0.4;

const hardware = process.env.CL_GPU === 'hardware';
const browser = await chromium.launch({
  executablePath: process.env.CL_CHROMIUM ?? (hardware ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium'),
  args: hardware ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = { opacity: OPACITY, steps: [] };
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.setDefaultTimeout(180_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?test=1&catalog=test-catalogs/geographic-vectors-mars-streamed`);
  await page.waitForFunction(() => window.renderer?.geographicVectors.featureCount > 0);
  // A fill-only style, so every covered pixel is fill: no outlines or lines.
  await page.evaluate(({ opacity, fadeMs }) => {
    const r = window.renderer;
    r.geographicVectors.setStyle('gale-regions', { version: 1, polygon: { fillColor: '#56b4e9', fillOpacity: opacity, outlineOpacity: 0 }, line: { opacity: 0 } });
    // Software rendering takes far longer per frame than the 300 ms cross-fade, so the
    // fade is stretched to be observed; the mechanism (both LODs drawn, dithered) is unchanged.
    const fade = r.bodyMeshes.get('Mars')?.terrainManager?.tiles.getPluginByName('FADE_TILES_PLUGIN');
    if (fade) fade.fadeDuration = fadeMs;
    r.applyNamedViewpoint('Gale regional');
  }, { opacity: OPACITY, fadeMs: Number(process.env.CL_FADE_MS ?? 6000) });
  await page.waitForTimeout(8000);

  /** Render this frame twice (vectors on, off) and compare. */
  const measure = (label, save) => page.evaluate(({ FILL, OPACITY, label, save }) => {
    const r = window.renderer, gl = r.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const read = () => { const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
    r.renderFrame();
    const on = read();
    const image = save ? r.renderer.domElement.toDataURL('image/png') : null;
    r.geographicVectors.setVisible('gale-regions', false);
    r.renderFrame();
    const off = read();
    r.geographicVectors.setVisible('gale-regions', true);
    const single = OPACITY, double = 1 - (1 - OPACITY) ** 2, split = (single + double) / 2;
    let covered = 0, doubled = 0;
    const histogram = new Array(10).fill(0);
    for (let i = 0; i < on.length; i += 4) {
      const d = [FILL[0] - off[i], FILL[1] - off[i + 1], FILL[2] - off[i + 2]];
      const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      if (len2 < 60 * 60) continue; // base too close to the fill colour to tell
      const a = ((on[i] - off[i]) * d[0] + (on[i + 1] - off[i + 1]) * d[1] + (on[i + 2] - off[i + 2]) * d[2]) / len2;
      if (a < 0.15) continue;
      covered++;
      histogram[Math.min(9, Math.floor(a * 10))]++;
      if (a > split) doubled++;
    }
    let tiles = 0, fading = 0;
    r.bodyMeshes.get('Mars')?.terrainTileGroup?.traverseVisible((o) => {
      if (!o.isMesh) return;
      tiles++;
      if (o.material?.defines?.FEATURE_FADE === 1) fading++;
    });
    return { label, covered, doubled, doubledShare: covered ? +(doubled / covered).toFixed(4) : 0, histogram, tiles, fading,
      altitudeKm: +(r.camera.position.length() / 1e-6 - 3396.19).toFixed(1), image };
  }, { FILL, OPACITY, label, save });

  const savePng = async (name, dataUrl) => writeFile(`${output}/${name}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  const settledStart = await measure('settled regional', true);
  await savePng('settled-regional', settledStart.image); delete settledStart.image;
  results.steps.push(settledStart);
  // Zoom in steadily; measure while tiles refine and cross-fade.
  let worst = null;
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => {
      const r = window.renderer, altitude = r.camera.position.length() - 3396.19e-6;
      r.cameraController.dolly(-altitude * 0.06, 0);
    });
    await page.waitForTimeout(600);
    const m = await measure(`zoom step ${i + 1}`, true);
    if (!worst || m.doubled > worst.doubled) { worst = m; await savePng('mid-zoom-worst', m.image); }
    delete m.image;
    results.steps.push(m);
    console.log(JSON.stringify({ ...m, histogram: undefined }));
  }
  await page.waitForTimeout(10000);
  const settledEnd = await measure('settled close', true);
  await savePng('settled-close', settledEnd.image); delete settledEnd.image;
  results.steps.push(settledEnd);
  results.worst = worst && { ...worst, image: undefined };
  results.maxDoubledShare = Math.max(...results.steps.map((s) => s.doubledShare));
  results.fadingSteps = results.steps.filter((s) => s.fading > 0).length;
  results.errors = errors;
  await writeFile(`${output}/streamed-lod.json`, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ maxDoubledShare: results.maxDoubledShare, fadingSteps: results.fadingSteps, settledStart: settledStart.doubledShare, settledEnd: settledEnd.doubledShare }));
  if (process.env.CL_ASSERT !== '0') {
    assert.ok(results.fadingSteps > 0, 'tiles cross-faded during the zoom (otherwise this run tested nothing)');
    assert.ok(results.maxDoubledShare < 0.01, `fill blended twice on ${(results.maxDoubledShare * 100).toFixed(1)}% of covered pixels during LOD transitions`);
  }
} finally { await browser.close(); }
