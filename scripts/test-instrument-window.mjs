#!/usr/bin/env node
// Browser regression for the Instrument View window (#192): composition and
// z-order, clean scene captures, resize/DPR, sensor and script/scene
// transitions, Escape over an expanded window, and the full-canvas camera mode.
// Requires a running viewer (CL_VIEWER_URL) with the Cassini, Clipper and LRO test catalogs.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5182';
const output = process.env.RENDER_CAPTURE_DIR ?? 'apps/viewer/test-screenshots/instrument-window';
mkdirSync(output, { recursive: true });
const headless = process.env.HEADED ? false : true;
const browser = await chromium.launch({ headless, args: headless ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [] });

/** Load a test catalog, paused, and return its page. */
async function open(catalog, deviceScaleFactor = 1) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?catalog=test-catalogs/${catalog}&test=1`);
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, null, { timeout: 180000 });
  return { page, errors };
}

// The instrument window is the one panel with an expand toggle, which it
// shows docked, floating, minimized or expanded.
const win = (page) => page.locator('section.instrument:has(> header button[aria-label^="Expand "]), section.instrument:has(> header button[aria-label$=" to its window"])');
const button = (page, label) => win(page).locator(`header button[aria-label^="${label}"]`);
const info = (page) => page.evaluate(() => window.renderer.getInstrumentViewInfo());

/** Box of the window's feed canvas, in CSS px. */
async function feedBox(page) {
  return win(page).locator('canvas').boundingBox();
}

/**
 * Render one frame the way a screenshot does (`captureFrameDataUrl`) and sum
 * the main canvas's pixels under `box`. Video (`captureStream`) records the
 * same presented buffer, so this guards both capture paths.
 */
function mainCanvasSum(page, box) {
  return page.evaluate((b) => {
    const r = window.renderer;
    r.renderFrame();
    const src = r.renderer.domElement;
    const pr = r.renderer.getPixelRatio();
    const c = document.createElement('canvas');
    c.width = Math.round(b.width * pr); c.height = Math.round(b.height * pr);
    const ctx = c.getContext('2d');
    ctx.drawImage(src, b.x * pr, b.y * pr, c.width, c.height, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height).data.reduce((a, v) => a + v, 0);
  }, box);
}

/** Sum of the window canvas's own pixels — non-zero once the feed is drawn. */
function feedSum(page) {
  return page.evaluate(() => {
    const c = [...document.querySelectorAll('section.instrument canvas')][0];
    const ctx = c.getContext('2d');
    return ctx.getImageData(0, 0, c.width, c.height).data.reduce((a, v, i) => (i % 4 === 3 ? a : a + v), 0);
  });
}

/** Instrument-camera draws in the next `frames` frames. */
function instrumentDraws(page, frames = 5) {
  return page.evaluate((n) => {
    const r = window.renderer;
    let draws = 0;
    const render = r.renderer.render;
    r.renderer.render = function (scene, camera) {
      if (camera === r.instrumentView?.camera) draws++;
      return render.apply(this, arguments);
    };
    try { for (let i = 0; i < n; i++) r.renderFrame(); } finally { r.renderer.render = render; }
    return draws;
  }, frames);
}

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

try {
  // ── Cassini, DPR 1 ──
  {
    const { page, errors } = await open('cassini-soi');
    await page.evaluate(() => window.__cosmolabe.runScript('setPlaying off\nsetTime 2005-07-14T12:58:36Z\ngotoObject Cassini'));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.renderer.stop());

    // `I` opens the window, then steps through sensors in it — never closes it.
    await page.keyboard.press('i');
    await win(page).waitFor();
    await page.evaluate(() => window.renderer.renderFrame());
    assert.equal((await info(page)).sensor, 'ISS NAC');
    await page.keyboard.press('i');
    await page.waitForFunction(() => window.renderer.getInstrumentViewInfo()?.sensor === 'ISS WAC');
    await win(page).locator('select[aria-label="Instrument"]').selectOption('ISS NAC');
    await page.evaluate(() => window.renderer.renderFrame());
    assert.equal((await info(page)).sensor, 'ISS NAC');
    assert.ok(await feedSum(page) > 0, 'feed drawn into the window canvas');

    // Clean captures: the main canvas under the window holds the scene, not
    // the feed — identical with the window open and minimized.
    let box = await feedBox(page);
    const withFeed = await mainCanvasSum(page, box);
    await button(page, 'Minimize').click();
    assert.equal(await instrumentDraws(page), 0, 'minimized window renders nothing');
    const withoutFeed = await mainCanvasSum(page, box);
    assert.equal(withFeed, withoutFeed, 'instrument pixels leaked into the main canvas');
    await button(page, 'Restore').click();

    // Float it, then overlap with Display in both stacking orders.
    let header = await win(page).locator('header').boundingBox();
    await drag(page, { x: header.x + 120, y: header.y + 17 }, { x: 760, y: 400 });
    await page.locator('button[aria-label^="Display"]').first().click();
    const display = page.locator('section.instrument', { hasText: 'Trajectories' });
    header = await display.locator('header').boundingBox();
    box = await feedBox(page);
    await drag(page, { x: header.x + 60, y: header.y + 17 }, { x: box.x + 60, y: box.y - 10 });
    const probe = { x: box.x + 90, y: box.y + 60 };
    const topAt = (p) => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('section')?.querySelector('h2')?.textContent, p);
    assert.equal(await topAt(probe), 'Display', 'Display raised over the window');
    await page.evaluate(() => window.renderer.renderFrame());
    await page.screenshot({ path: `${output}/display-over-instrument.png` });
    box = await feedBox(page);
    await page.mouse.click(box.x + box.width - 20, box.y + 60);
    assert.match(await topAt(probe), /ISS NAC/, 'window raised over Display');
    await page.evaluate(() => window.renderer.renderFrame());
    await page.screenshot({ path: `${output}/instrument-over-display.png` });

    // Resize: FOV and native aspect hold; the image is fitted, not stretched.
    const before = await info(page);
    box = await feedBox(page);
    const outer = await win(page).boundingBox();
    await drag(page, { x: outer.x + outer.width - 6, y: outer.y + outer.height - 6 }, { x: outer.x + outer.width + 180, y: outer.y + outer.height - 120 });
    await page.evaluate(() => window.renderer.renderFrame());
    const after = await info(page);
    assert.deepEqual(after.fov, before.fov, 'resize changed the FOV');
    const aspect = after.viewFov[0] / after.viewFov[1];
    assert.ok(Math.abs(after.imageRect.w / after.imageRect.h - aspect) < 0.01, 'image aspect is the instrument\'s');
    box = await feedBox(page);
    assert.ok(after.imageRect.w <= box.width + 0.5 && after.imageRect.h <= box.height + 0.5, 'image fits inside the window');
    assert.ok(Math.abs(after.imageRect.w - box.width) < 0.5 || Math.abs(after.imageRect.h - box.height) < 0.5, 'image fills one axis');

    // Partly off-screen: still clean underneath.
    header = await win(page).locator('header').boundingBox();
    await drag(page, { x: header.x + 120, y: header.y + 17 }, { x: 40, y: 600 });
    box = await feedBox(page);
    const clipped = { x: Math.max(0, box.x), y: box.y, width: Math.min(box.width, 1400 - Math.max(0, box.x)), height: Math.min(box.height, 900 - box.y) };
    const clippedOpen = await mainCanvasSum(page, clipped);
    await button(page, 'Minimize').click();
    assert.equal(await mainCanvasSum(page, clipped), clippedOpen, 'off-screen window leaked into the main canvas');
    await button(page, 'Restore').click();

    // Sensor switch: one feed, one draw per frame.
    await win(page).locator('select[aria-label="Instrument"]').selectOption('ISS WAC');
    assert.equal(await instrumentDraws(page, 4), 4);
    assert.equal((await info(page)).sensor, 'ISS WAC');

    // A script switching sensors updates the window and keeps the feed in it.
    await page.evaluate(() => window.renderer.setInstrumentView('VIMS-V'));
    await page.waitForFunction(() => document.querySelector('section.instrument select[aria-label="Instrument"]')?.value === 'VIMS-V');
    await page.evaluate(() => window.renderer.renderFrame());
    assert.ok(await feedSum(page) > 0);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('div')].some((d) => d.style.border?.includes('solid') && d.style.display === 'block' && d.querySelector('canvas'))), false, 'corner inset reappeared');
    // Clearing it from a script closes the window; choosing one reopens it.
    await page.evaluate(() => window.renderer.setInstrumentView(null));
    await win(page).waitFor({ state: 'detached' });
    await page.evaluate(() => window.renderer.setInstrumentView('ISS NAC'));
    await win(page).waitFor();

    // Full-canvas camera mode keeps the window's sensor and leaves it active.
    await page.evaluate(() => { window.renderer.cameraController.setMode('instrument', { sensorName: 'ISS WAC' }); window.renderer.renderFrame(); });
    assert.equal(await page.evaluate(() => window.renderer.activeInstrumentView), 'ISS NAC');
    await page.evaluate(() => { window.renderer.cameraController.resetToFreeOrbit(); window.renderer.renderFrame(); });
    assert.equal(await page.evaluate(() => window.renderer.activeInstrumentView), 'ISS NAC');

    // Escape over an expanded window collapses it, even with a panel touched since.
    await button(page, 'Expand').click();
    await page.locator('button[aria-label^="Geometry"]').first().click({ force: true });
    await page.keyboard.press('Escape');
    assert.equal(await button(page, 'Expand').count(), 1, 'Escape collapsed the expanded window');
    assert.equal(await page.locator('section.instrument h2', { hasText: 'Reference Geometry' }).count(), 1, 'Escape did not dismiss the panel behind it');

    // Closing ends the feed; with the window closed the camera mode activates
    // its own sensor and removes it again on exit.
    await button(page, 'Close').click();
    assert.equal(await page.evaluate(() => window.renderer.activeInstrumentView ?? null), null);
    await page.evaluate(() => { window.renderer.cameraController.setMode('instrument', { sensorName: 'ISS WAC' }); window.renderer.renderFrame(); });
    assert.equal(await page.evaluate(() => window.renderer.activeInstrumentView), 'ISS WAC');
    assert.equal(await win(page).count(), 0, 'full-canvas mode opened a second view');
    await page.evaluate(() => { window.renderer.cameraController.resetToFreeOrbit(); window.renderer.renderFrame(); });
    assert.equal(await page.evaluate(() => window.renderer.activeInstrumentView ?? null), null, 'camera mode left its sensor behind');

    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── DPR 2: backing store tracks CSS size × pixel ratio ──
  {
    const { page, errors } = await open('cassini-soi', 2);
    await page.keyboard.press('i');
    await win(page).waitFor();
    await page.evaluate(() => window.renderer.renderFrame());
    const dims = await page.evaluate(() => {
      const c = document.querySelector('section.instrument canvas');
      const r = c.getBoundingClientRect();
      return { css: [r.width, r.height], backing: [c.width, c.height], pr: window.renderer.renderer.getPixelRatio() };
    });
    assert.equal(dims.pr, 2);
    assert.equal(dims.backing[0], Math.round(dims.css[0] * 2));
    assert.equal(dims.backing[1], Math.round(dims.css[1] * 2));
    await page.screenshot({ path: `${output}/dpr2.png` });
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── Clipper: its sensors list; a scene switch keeps the window and starts
  //    from the new scene's first instrument ──
  {
    const { page, errors } = await open('europa-clipper');
    await page.keyboard.press('i');
    await win(page).waitFor();
    const options = await win(page).locator('select[aria-label="Instrument"] option').allTextContents();
    assert.deepEqual(options, ['EIS NAC', 'EIS WAC', 'MISE', 'E-THEMIS']);
    await page.evaluate(() => { history.pushState(null, '', '?catalog=test-catalogs/cassini-soi&test=1'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForFunction(() => window.renderer?.getSensorNames().includes('ISS NAC') && window.__cosmolabe.assetsReady, null, { timeout: 180000 });
    await page.waitForFunction(() => document.querySelector('section.instrument select[aria-label="Instrument"]')?.value === 'ISS NAC');
    await page.waitForFunction(() => window.renderer.getInstrumentViewInfo()?.sensor === 'ISS NAC');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── LRO: every sensor's FOV comes from its gzipped IK (LAMP's needs more
  //    than getfov's customary 20 corners), not the 10° fallback ──
  {
    const { page, errors } = await open('lro-moon');
    const fovs = await page.evaluate(() => {
      const r = window.renderer;
      return Object.fromEntries(['LAMP', 'Diviner', 'LEND', 'CRaTER'].map((n) => {
        r.setInstrumentView(n);
        return [n, r.getInstrumentViewInfo().fov.map((d) => +d.toFixed(2))];
      }));
    });
    assert.deepEqual(fovs, { LAMP: [0.39, 9.64], Diviner: [4.04, 0.35], LEND: [5.6, 5.6], CRaTER: [65.9, 65.9] });
    assert.deepEqual(errors, []);
    await page.close();
  }

  console.log(`Instrument window checks passed. Captures: ${output}`);
} finally { await browser.close(); }
