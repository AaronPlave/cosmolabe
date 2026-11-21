#!/usr/bin/env node
/**
 * Body-label sharpness acceptance for issue #350, in the production renderer
 * (no `?test=1`: MSAA and bloom stay on).
 *
 *   node scripts/test-label-sharpness.mjs [VIEWER_URL] [OUT_DIR]
 * Add --typography to write an actual-size scene comparison instead of the
 * pixel-stability checks (previous heavy style, system-ui, production style).
 *
 * The reported failure: on one low-DPR display, resizing the window flips the
 * Ingenuity body label between crisp and blurry. The checks look at rendered
 * pixels, not at computed sprite sizes:
 *
 * - The label's glyph image is isolated by rendering one paused frame through
 *   the viewer's capture path with only the label's draw call, and again with
 *   none, and differencing the two. Terrain that refines between captures
 *   cannot pass for blur.
 * - That glyph image must be the same, up to a whole-pixel translation, across
 *   a viewport-width sweep in 1-CSS-pixel steps, sub-pixel camera pans, body
 *   motion, the selected state, and live DPR changes at 1, 1.25, 1.5 and 2.
 *   A minified or half-pixel-smeared label fails the similarity or edge test.
 * - The WebGL backing store must equal the canvas's device-pixel box, so the
 *   compositor never rescales the canvas (the fractional-DPR case), and the
 *   bloom targets must equal the backing store.
 * - Drawn pixels stay inside the collision/picking rect, hover picking hits the
 *   drawn text, and a slow pan steps the label one way on whole pixels.
 *
 * Writes each DPR's reference crop, and the glyph of any failing check, to
 * OUT_DIR for review (transient, not goldens). Uses the Ingenuity catalog
 * (needs the Ingenuity model, de440s and the Mars texture from LFS). Set CHROMIUM_PATH to use a browser other than
 * Playwright's own. Software GL renders about one frame per second, so every
 * check waits for rendered frames rather than wall-clock time.
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'work/issue-350';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--enable-gpu', '--ignore-gpu-blocklist', process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const HEIGHT = 800;
let failures = 0;
const check = (ok, what, detail) => {
  if (!ok) failures++;
  console.log(ok ? 'ok  ' : 'FAIL', what, detail === undefined ? '' : JSON.stringify(detail));
};

async function openScene(dpr, width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: HEIGHT }, deviceScaleFactor: dpr });
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(new URL('?catalog=test-catalogs/ingenuity-jezero', base).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.renderer?.getBodyMesh?.('Ingenuity'), null, { timeout: 180000 });
  await page.evaluate(async () => { await window.renderer.waitForInitialAssets?.(); window.cosmo.setPlaying(false); });
  page.cdp = await page.context().newCDPSession(page);
  // Let the label fade in and the layout settle.
  await page.waitForFunction(() => {
    const lm = window.renderer.labelManager;
    const sprite = lm.getSprites().find((x) => lm.resolveSprite(x) === 'Ingenuity');
    return sprite?.visible && sprite.material.opacity >= 0.8 && lm.getScreenRects().some((x) => x.name === 'Ingenuity');
  }, null, { timeout: 120000 });
  await waitFrames(page, 10);
  // __pan(px): shift camera and target sideways so Ingenuity's label moves
  // `px` CSS pixels from where it started, calibrated against the label itself.
  await page.evaluate(() => {
    const pose = window.cosmo.getCamera();
    const fwd = pose.target.map((t, i) => t - pose.position[i]);
    const u = pose.up;
    const right = [fwd[1] * u[2] - fwd[2] * u[1], fwd[2] * u[0] - fwd[0] * u[2], fwd[0] * u[1] - fwd[1] * u[0]];
    const n = Math.hypot(...right);
    const shift = (km) => {
      const move = (v) => v.map((x, i) => x + (right[i] / n) * km);
      window.cosmo.setCamera(move(pose.position), move(pose.target), pose.up);
      window.renderer.renderFrame();
      return window.renderer.labelManager.getScreenRects().find((x) => x.name === 'Ingenuity').x0;
    };
    const x0 = shift(0), kmPerPx = 0.1 / (shift(0.1) - x0);
    window.__pan = (px) => shift(px * kmPerPx);
    shift(0);
  });
  return page;
}

async function waitFrames(page, n = 3) {
  const f0 = await page.evaluate(() => window.renderer._renderDebugFrame);
  await page.waitForFunction((f) => window.renderer._renderDebugFrame >= f, f0 + n, { timeout: 120000 });
}

/** Live viewport/DPR change without a reload: a window resize, monitor move or zoom. */
async function setViewport(page, width, dpr) {
  await page.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: dpr, mobile: false });
  await waitFrames(page);
}

/**
 * Render one frame through the viewer's own capture path (render, then
 * toDataURL: the drawing buffer at device resolution) and, in the same task,
 * read the backing store, bloom targets and the label's CSS rect. Headless page
 * screenshots at fractional DPR come back resampled to CSS size, and a clip
 * scale resets the DPR, so they cannot be used here.
 *
 * `mask`: 'label' skips every draw call but the label's, 'all' skips the
 * label's too. Layout, collision, MSAA and bloom still run exactly as in
 * production, and the mask lasts only for this one synchronous frame.
 */
async function capture(page, mask = null) {
  await waitFrames(page, 2);
  const { url, ...probe } = await page.evaluate((mask) => {
    const r = window.renderer, c = r.renderer.domElement, lm = r.labelManager;
    const sprite = lm.getSprites().find((x) => lm.resolveSprite(x) === 'Ingenuity');
    // Skip every draw call but the label's (or all of them). Hooking the
    // renderer, not materials, also catches tiles created during this frame.
    const gl = r.renderer, draw = gl.renderBufferDirect;
    if (mask) gl.renderBufferDirect = function (cam, scene, geo, mat, obj, group) {
      if (mask === 'label' && obj === sprite) draw.call(this, cam, scene, geo, mat, obj, group);
    };
    try { r.renderFrame(); } finally { gl.renderBufferDirect = draw; }
    const url = c.toDataURL('image/png');
    const rect = lm.getScreenRects().find((x) => x.name === 'Ingenuity');
    const rt = r.getBloomEffect?.()?.bloomComposer?.renderTarget1;
    return {
      url,
      dpr: devicePixelRatio,
      backing: [c.width, c.height],
      // The device-pixel box of a canvas at the page origin. (Emulated DPRs
      // report devicePixelContentBoxSize in CSS pixels, so it is computed.)
      devicePixels: [Math.round(c.clientWidth * devicePixelRatio), Math.round(c.clientHeight * devicePixelRatio)],
      bloom: rt ? [rt.width, rt.height] : null,
      rect: rect && { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 },
    };
  }, mask);
  return { png: PNG.sync.read(Buffer.from(url.split(',')[1], 'base64')), probe };
}

/**
 * The label alone, in device pixels: the label-only frame minus the
 * fully-masked frame, as one channel (max over RGB). Isolating the label from
 * the terrain means a background that refines between captures cannot pass
 * for blur. Also returns the unmasked frame for visual review.
 */
async function glyph(page) {
  const scene = await capture(page);
  const { png: on, probe: p } = await capture(page, 'label');
  const { png: off } = await capture(page, 'all');
  if (!p.rect) return { probe: p, img: null };
  const pad = 3;
  const x0 = Math.max(0, Math.floor((p.rect.x0 - pad) * p.dpr)), y0 = Math.max(0, Math.floor((p.rect.y0 - pad) * p.dpr));
  const x1 = Math.min(on.width, Math.ceil((p.rect.x1 + pad) * p.dpr)), y1 = Math.min(on.height, Math.ceil((p.rect.y1 + pad) * p.dpr));
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0), data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((y0 + y) * on.width + x0 + x) * 4;
    data[y * w + x] = Math.max(...[0, 1, 2].map((k) => Math.abs(on.data[i + k] - off.data[i + k]))) / 255;
  }
  return { probe: p, img: w && h ? { w, h, data } : null, crop: { on: scene.png, x0, y0, w, h } };
}

/** Edge energy: mean squared gradient over mean value. A half-pixel smear roughly halves it. */
function sharpness({ w, h, data }) {
  let g = 0, s = 0;
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const v = data[y * w + x];
    g += (data[y * w + x + 1] - v) ** 2 + (data[(y + 1) * w + x] - v) ** 2;
    s += v;
  }
  return s > 0 ? g / s : 0;
}

/** Best whole-pixel alignment of b onto a: 1 − mean|a−b| / mean(a), over the overlap. */
function similarity(a, b) {
  let best = -Infinity;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    let diff = 0, sum = 0;
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
      const bx = x + dx, by = y + dy;
      const va = a.data[y * a.w + x];
      const vb = bx >= 0 && by >= 0 && bx < b.w && by < b.h ? b.data[by * b.w + bx] : 0;
      diff += Math.abs(va - vb); sum += va;
    }
    best = Math.max(best, 1 - diff / sum);
  }
  return best;
}

async function savePng(path, { on, x0, y0, w, h }, zoom) {
  const png = new PNG({ width: w * zoom, height: h * zoom });
  for (let y = 0; y < h * zoom; y++) for (let x = 0; x < w * zoom; x++) {
    const i = ((y0 + Math.floor(y / zoom)) * on.width + x0 + Math.floor(x / zoom)) * 4, o = (y * w * zoom + x) * 4;
    for (let k = 0; k < 4; k++) png.data[o + k] = on.data[i + k];
  }
  await writeFile(path, PNG.sync.write(png));
}

// Thresholds. A snapped label reproduces its reference exactly (similarity 1).
// On main, the 4×-minified label at another sub-pixel phase scores ~0.6.
const MIN_SIMILARITY = 0.9;
const MIN_SHARPNESS = 0.85;

/**
 * Strongest label pixel more than one CSS pixel outside the label's collision
 * and picking rect: snapping must never move the drawn text out of the box
 * that layout, collision and hover use.
 */
function outsideRect({ img, crop, probe: { rect, dpr } }) {
  let max = 0;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const cx = (crop.x0 + x + 0.5) / dpr, cy = (crop.y0 + y + 0.5) / dpr;
    if (cx < rect.x0 - 1 || cx > rect.x1 + 1 || cy < rect.y0 - 1 || cy > rect.y1 + 1) max = Math.max(max, img.data[y * img.w + x]);
  }
  return max;
}

async function saveGlyph(path, { w, h, data }) {
  const png = new PNG({ width: w * 4, height: h * 4 });
  for (let y = 0; y < h * 4; y++) for (let x = 0; x < w * 4; x++) {
    const v = Math.round(data[Math.floor(y / 4) * w + Math.floor(x / 4)] * 255), o = (y * w * 4 + x) * 4;
    png.data[o] = png.data[o + 1] = png.data[o + 2] = v; png.data[o + 3] = 255;
  }
  await writeFile(path, PNG.sync.write(png));
}

async function compare(label, ref, g) {
  if (!g.img) return check(false, `${label}: no Ingenuity label`);
  const backingOk = g.probe.backing[0] === g.probe.devicePixels[0] && g.probe.backing[1] === g.probe.devicePixels[1];
  const bloomOk = !g.probe.bloom || (g.probe.bloom[0] === g.probe.backing[0] && g.probe.bloom[1] === g.probe.backing[1]);
  const sim = similarity(ref.img, g.img), sharp = sharpness(g.img) / sharpness(ref.img);
  const spill = outsideRect(g);
  const ok = backingOk && bloomOk && sim >= MIN_SIMILARITY && sharp >= MIN_SHARPNESS && spill < 0.05;
  check(ok, label, {
    similarity: +sim.toFixed(3), sharpness: +sharp.toFixed(3), spill: +spill.toFixed(3),
    phase: +((g.probe.rect.x0 * g.probe.dpr) % 1).toFixed(2),
    backing: g.probe.backing, devicePixels: g.probe.devicePixels, bloom: g.probe.bloom,
  });
  if (!ok) {
    const name = `${out}/fail-${label.replace(/\W+/g, '-')}`;
    await saveGlyph(`${name}-glyph.png`, g.img);
    await savePng(`${name}-scene.png`, g.crop, 4);
  }
}

if (process.argv.includes('--typography')) {
  const { default: sharp } = await import('sharp');
  const tiles = [];
  const styles = ['Previous: mono 600 + ring/halo', 'System-ui 400 + short shadow', 'Chosen: original mono + short shadow'];
  const tileW = 370, tileH = 240;
  const scenes = [1, 2].flatMap((dpr) => ['overview', 'terrain', 'space'].map((scene) => ({ dpr, scene })));
  for (const [row, { dpr, scene }] of scenes.entries()) {
    const page = await openScene(dpr);
    if (scene === 'space') {
      await page.evaluate(() => {
        window.cosmo.untrack(); window.cosmo.clearLookAt();
        window.cosmo.gotoObject('Earth'); window.cosmo.dolly(1000000);
      });
      await waitFrames(page, 30);
      await page.waitForFunction(() => window.renderer.labelManager.getScreenRects().some((r) => r.name === 'Earth'), null, { timeout: 30000 });
    } else if (scene === 'terrain') {
      await page.evaluate(() => {
        const r = window.renderer, V = r.camera.position.constructor;
        const body = r.getBodyMesh('Ingenuity').getWorldPosition(new V());
        const mars = r.getBodyMesh('Mars').getWorldPosition(new V());
        const radial = body.clone().sub(mars).normalize();
        window.cosmo.untrack(); window.cosmo.clearLookAt();
        const offset = radial.clone().multiplyScalar(15 * r.scaleFactor);
        r.cameraController.controls.enableDamping = false;
        r.cameraController.controls.target.copy(body);
        r.camera.position.copy(body).add(offset);
        r.camera.lookAt(body); r.camera.updateMatrixWorld(true);
      });
      await waitFrames(page, 45);
    }
    // Asset readiness alone does not establish drawn imagery. Wait for the
    // streamed view to settle before comparing terrain contrast.
    const idle = () => {
      const t = window.renderer.getBodyMesh('Mars').terrainManager;
      const n = t.metrics.network, i = t.cubeImageryStats;
      return t.tiles.visibleTiles.size > 0 && n.queued + n.downloading + n.parsing === 0
        && t.cubeStats.inFlight === 0 && i.inFlight === 0 && (i.queued === 0 || i.budgetLimited);
    };
    if (scene !== 'space') {
      await page.waitForFunction(idle, null, { timeout: 180000 });
      await page.waitForTimeout(1000);
      await page.waitForFunction(idle, null, { timeout: 180000 });
      console.log('Typography surface', scene, await page.evaluate(() => ({
        terrain: window.cosmo.getSurfaceData('Mars').terrain.runtime,
        imagery: window.cosmo.getImagery('Mars').layers.map(({ id, status, view }) => ({ id, status, view })),
      })));
    }
    console.log('Typography renderer', await page.evaluate(() => {
      const gl = window.renderer.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }));
    for (let col = 0; col < styles.length; col++) {
      const dimensions = await page.evaluate(({ style, label }) => {
        const lm = window.renderer.labelManager;
        // The chosen column uses production rasterization. Other columns only
        // replace the texture generator, leaving layout/rendering unchanged.
        window.__productionTextTexture ??= lm.createTextTexture;
        lm.createTextTexture = style === 2 ? window.__productionTextTexture : function (text, color, fontSize) {
          const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
          const px = this._pixelRatio, pad = Math.ceil(fontSize * 0.3);
          const setup = () => { ctx.font = style === 0
            ? `600 ${fontSize}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`
            : `400 ${fontSize}px system-ui, sans-serif`; ctx.textBaseline = 'top'; };
          setup(); canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2; canvas.height = fontSize + pad * 2; setup();
          const away = canvas.width + 64 * px;
          const shadow = (color, blur, dx, dy) => {
            ctx.shadowColor = color; ctx.shadowBlur = blur * px;
            ctx.shadowOffsetX = away + dx * px; ctx.shadowOffsetY = dy * px;
            ctx.fillText(text, pad - away, pad);
          };
          if (style === 0) {
            for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) shadow('#000000f2', 0.5, dx, dy);
            shadow('#000', 2, 0, 0);
          } else shadow('#000000b3', 1, 0, 1);
          ctx.shadowColor = 'transparent'; ctx.fillStyle = color; ctx.fillText(text, pad, pad);
          const sample = this.getSprites()[0].material.map;
          const texture = new sample.constructor(canvas);
          texture.minFilter = sample.minFilter; texture.magFilter = sample.magFilter;
          return texture;
        };
        for (const entry of lm.labels.values()) entry.texPixelRatio = -1;
        lm.refreshTextures(devicePixelRatio);
        window.renderer.renderFrame();
        return lm.getScreenRects().find((r) => r.name === label);
      }, { style: col, label: scene === 'space' ? 'Earth' : 'Ingenuity' });
      await waitFrames(page, 10);
      // Browser screenshot includes adjacent HTML place names. Integer DPRs
      // can be reduced to CSS dimensions to present each scene at actual size.
      const shot = await page.screenshot();
      const x = Math.max(0, Math.min(1280 - tileW, Math.round((dimensions.x0 + dimensions.x1) / 2 - tileW / 2)));
      const y = Math.max(0, Math.min(HEIGHT - tileH, Math.round(dimensions.y0 - tileH / 2)));
      const crop = await sharp(shot).extract({ left: x * dpr, top: y * dpr, width: tileW * dpr, height: tileH * dpr }).resize(tileW, tileH).png().toBuffer();
      tiles.push({ input: crop, left: col * tileW, top: row * (tileH + 32) + 32 });
      console.log(`DPR ${dpr} ${scene} ${styles[col]}: label box ${(dimensions.x1 - dimensions.x0).toFixed(1)} CSS px`);
    }
    await page.close();
  }
  const labels = scenes.flatMap(({ dpr, scene }, row) => styles.map((style, col) => `<text x="${col * tileW + 8}" y="${row * (tileH + 32) + 21}" fill="white" font-size="11">DPR ${dpr}, ${scene}: ${style}</text>`)).join('');
  tiles.push({ input: Buffer.from(`<svg width="${tileW * 3}" height="${(tileH + 32) * scenes.length}" xmlns="http://www.w3.org/2000/svg">${labels}</svg>`), left: 0, top: 0 });
  await sharp({ create: { width: tileW * 3, height: (tileH + 32) * scenes.length, channels: 4, background: '#16191e' } }).composite(tiles).png().toFile(`${out}/body-label-typography.png`);
  await browser.close();
  process.exit(0);
}

for (const dpr of [1, 1.25, 1.5, 2]) {
  const page = await openScene(dpr);
  const ref = await glyph(page);
  if (!ref.img) { check(false, `DPR ${dpr}: no Ingenuity label`); await page.close(); continue; }
  await savePng(`${out}/ingenuity-dpr${dpr}.png`, ref.crop, dpr < 2 ? 4 : 2);
  console.log(`DPR ${dpr}: reference sharpness ${sharpness(ref.img).toFixed(3)}, wrote ${out}/ingenuity-dpr${dpr}.png`);

  // 1. Fixed-DPR window resize, one CSS pixel at a time, then larger jumps.
  for (const width of [1281, 1282, 1283, 1284, 1285, 1111, 1367, 1280]) {
    await setViewport(page, width, dpr);
    await compare(`DPR ${dpr} width ${width}`, ref, await glyph(page));
  }

  // 2. Sub-pixel camera pans.
  for (const px of [0.25, 0.5, 0.75, 1.3]) {
    await page.evaluate((px) => window.__pan(px), px);
    await compare(`DPR ${dpr} camera pan ${px} px`, ref, await glyph(page));
  }
  await page.evaluate(() => window.__pan(0));

  // 3. Body motion: Mars rotates under the paused camera.
  const t0 = await page.evaluate(() => window.renderer.timeController.et);
  for (const dt of [0.5, 1, 2, 3.5]) {
    await page.evaluate((et) => window.renderer.timeController.setTime(et), t0 + dt);
    await waitFrames(page);
    await compare(`DPR ${dpr} time +${dt}s`, ref, await glyph(page));
  }
  await page.evaluate((et) => window.renderer.timeController.setTime(et), t0);
  await waitFrames(page);

  // 4. Hover picking (1 px slop) hits the drawn text: the centre and corners
  //    of the bright glyph pixels' bounding box in the captured frame.
  const now = await glyph(page);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let y = 0; y < now.img.h; y++) for (let x = 0; x < now.img.w; x++) {
    if (now.img.data[y * now.img.w + x] < 0.5) continue;
    bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
  }
  const css = (x, y) => [(now.crop.x0 + x + 0.5) / dpr, (now.crop.y0 + y + 0.5) / dpr];
  const pts = [css((bx0 + bx1) / 2, (by0 + by1) / 2), css(bx0, by0), css(bx1, by0), css(bx0, by1), css(bx1, by1)];
  const picks = await page.evaluate((pts) => pts.map(([x, y]) => window.renderer.pickBody(x, y, true, 1)), pts);
  check(picks.every((n) => n === 'Ingenuity'), `DPR ${dpr} hover picking over the drawn text`, picks);

  // 5. Selected (pinned) label: full opacity, stays crisp under sub-pixel pans.
  await page.evaluate(() => window.cosmo.select('Ingenuity'));
  await waitFrames(page, 30); // emphasis fade
  const selected = await glyph(page);
  for (const px of [0.3, 0.6]) {
    await page.evaluate((px) => window.__pan(px), px);
    await compare(`DPR ${dpr} selected, camera pan ${px} px`, selected, await glyph(page));
  }
  await page.evaluate(() => { window.cosmo.deselect(); window.__pan(0); });

  // 6. No jitter during slow motion: over a 4 px pan in 0.1 px steps the
  //    label's quad stays on whole device pixels and only ever steps one way.
  const track = await page.evaluate(() => {
    const r = window.renderer, lm = r.labelManager;
    const sprite = lm.getSprites().find((x) => lm.resolveSprite(x) === 'Ingenuity');
    const lefts = [];
    for (let i = 0; i <= 40; i++) {
      window.__pan(i * 0.1);
      const p = sprite.getWorldPosition(sprite.position.clone()).project(r.camera);
      lefts.push((p.x * 0.5 + 0.5) * r.renderer.domElement.width - sprite.center.x * sprite.material.map.image.width);
    }
    window.__pan(0);
    return lefts;
  });
  const steps = track.slice(1).map((v, i) => Math.round(v - track[i]));
  const onGrid = track.every((v) => Math.abs(v - Math.round(v)) < 0.02);
  const oneWay = steps.every((d) => d <= 0) || steps.every((d) => d >= 0);
  check(onGrid && oneWay && Math.abs(track.at(-1) - track[0]) > 2, `DPR ${dpr} slow pan: on-grid, monotonic`, { steps: steps.join(' ') });
  await page.close();
}

// 7. Live DPR transitions (monitor moves, browser zoom) combined with resizes.
//    The glyph after each change must match a scene opened at that DPR.
{
  const refs = {};
  for (const dpr of [1, 1.25, 1.5, 2]) {
    const page = await openScene(dpr);
    refs[dpr] = await glyph(page);
    await page.close();
  }
  const page = await openScene(1);
  for (const [width, dpr] of [[1280, 2], [1280, 1], [1111, 1.25], [1283, 1.5], [1280, 1], [1281, 2], [1280, 1]]) {
    await setViewport(page, width, dpr);
    await compare(`transition to DPR ${dpr} width ${width}`, refs[dpr], await glyph(page));
  }
  await page.close();
}

await browser.close();
if (failures) console.error(`${failures} check(s) failed`);
process.exit(failures ? 1 : 0);
