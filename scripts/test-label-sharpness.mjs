#!/usr/bin/env node
/**
 * Body-label sharpness acceptance for issue #350, in the production renderer
 * (no `?test=1`: MSAA and bloom stay on).
 *
 *   node scripts/test-label-sharpness.mjs [VIEWER_URL] [OUT_DIR]
 *
 * 1. Live DPR transitions. CDP changes devicePixelRatio without a reload, as
 *    dragging the window between an external display and a built-in Retina
 *    panel (or browser zoom) does. After each change the WebGL backing store
 *    must match the new DPR, and the Ingenuity label sprite must cover its
 *    canvas texture exactly — one texel per device pixel — at a fixed
 *    CSS-pixel size.
 * 2. Same-scene crops of the Ingenuity body label (WebGL sprite) and the
 *    "Neretva Vallis" place name (HTML) at DPR 1 and 2 over several instants,
 *    so the label lands on different sub-pixel offsets. Written to OUT_DIR for
 *    review; these are transient outputs, not goldens.
 *
 * Uses the Ingenuity catalog (needs the Ingenuity model, de440s and the Mars
 * texture from LFS). Set CHROMIUM_PATH to use a browser other than
 * Playwright's own. Software GL renders about one frame per second, so every
 * check waits for rendered frames rather than wall-clock time.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'work/issue-350';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--enable-gpu', '--ignore-gpu-blocklist', process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

async function openScene(dpr) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr });
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(new URL('?catalog=test-catalogs/ingenuity-jezero', base).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.renderer?.getBodyMesh?.('Ingenuity'), null, { timeout: 180000 });
  await page.evaluate(async () => { await window.renderer.waitForInitialAssets?.(); window.cosmo.setPlaying(false); });
  return page;
}

async function waitFrames(page, n = 2) {
  const f0 = await page.evaluate(() => window.renderer._renderDebugFrame);
  await page.waitForFunction((f) => window.renderer._renderDebugFrame >= f, f0 + n, { timeout: 120000 });
}

let failures = 0;

// 1. DPR transitions.
{
  const page = await openScene(1);
  const cdp = await page.context().newCDPSession(page);
  const sequence = [1, 2, 1, 2, 1.25, 1.5, 1, 2, 3, 1];
  for (const [i, dpr] of sequence.entries()) {
    const width = i === 4 ? 1111 : 1280; // one transition combined with a resize
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: dpr, mobile: false });
    await waitFrames(page);
    const s = await page.evaluate(() => {
      const r = window.renderer, c = r.renderer.domElement, lm = r.labelManager;
      const sprite = lm.getSprites().find((x) => lm.resolveSprite(x) === 'Ingenuity');
      const img = sprite.material.map.image, rect = lm.getScreenRects().find((x) => x.name === 'Ingenuity');
      const P = r.camera.projectionMatrix.elements;
      return {
        dpr: devicePixelRatio, rendererPr: r.renderer.getPixelRatio(), backing: c.width / c.clientWidth,
        texture: [img.width, img.height], quadPx: [sprite.scale.x * P[0] * c.width / 2, sprite.scale.y * P[5] * c.height / 2],
        cssBox: rect ? [+(rect.x1 - rect.x0).toFixed(2), +(rect.y1 - rect.y0).toFixed(2)] : null,
      };
    });
    const ok = s.rendererPr === dpr && Math.abs(s.backing - dpr) < 0.01
      && Math.abs(s.quadPx[0] - s.texture[0]) < 1e-3 && Math.abs(s.quadPx[1] - s.texture[1]) < 1e-3
      && (!s.cssBox || Math.abs(s.cssBox[1] - 20) < 1);
    if (!ok) failures++;
    console.log(ok ? 'ok  ' : 'FAIL', 'transition', JSON.stringify(s));
  }
  await page.close();
}

// 2. Same-scene crops, body + geographic labels.
for (const dpr of [1, 2]) {
  const page = await openScene(dpr);
  const t0 = await page.evaluate(() => window.renderer.timeController.et);
  for (const [i, dt] of [0, 7, 13, 29].entries()) {
    await page.evaluate((et) => window.renderer.timeController.setTime(et), t0 + dt);
    await waitFrames(page);
    const rect = await page.evaluate(() => window.renderer.labelManager.getScreenRects().find((x) => x.name === 'Ingenuity'));
    if (!rect) { failures++; console.log('FAIL', `no Ingenuity label at DPR ${dpr}, t${i}`); continue; }
    const clip = { x: Math.max(0, Math.round(rect.x0) - 110), y: Math.max(0, Math.round(rect.y0) - 14), width: 240, height: 110 };
    const path = `${out}/ingenuity-dpr${dpr}-t${i}.png`;
    await page.screenshot({ path, clip, timeout: 180000 });
    console.log('wrote', path);
  }
  await page.close();
}

await browser.close();
if (failures) console.error(`${failures} check(s) failed`);
process.exit(failures ? 1 : 0);
