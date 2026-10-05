#!/usr/bin/env node
// Reproduce sun-facing textured-planet review captures from the solar-system catalog.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5174';
const output = process.env.ATMOSPHERE_CAPTURE_DIR ?? 'apps/viewer/test-screenshots';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/?catalog=solar-system&test=1`);
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, { timeout: 180000 });
  const assets = await page.evaluate(() => window.__cosmolabe.assetSummary);
  assert.equal(assets.failed, 0, JSON.stringify(assets));
  assert.equal(assets.timedOut, false);
  await page.evaluate(() => window.__cosmolabe.runScript('setPlaying off\nsetTime 2024-07-04T12:00:00Z'));
  for (const body of ['Earth', 'Mars', 'Jupiter', 'Saturn']) {
    await page.evaluate(body => window.__cosmolabe.runScript(`gotoObject ${body}`), body);
    // Let tracking establish its floating origin before setting a relative camera.
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__cosmolabe.capture());
    await page.evaluate(body => {
      const r = window.renderer;
      const bm = r.getBodyMesh(body);
      const sun = r.getBodyMesh('Sun');
      const direction = sun.position.clone().sub(bm.position).normalize();
      const target = bm.position.clone().divideScalar(r.scaleFactor);
      const eye = target.clone().addScaledVector(direction, bm.displayRadius * 2.3);
      window.cosmo.setCamera(eye.toArray(), target.toArray(), [0, 0, 1]);
    }, body);
    await page.waitForTimeout(1000);
    const data = await page.evaluate(() => window.__cosmolabe.capture());
    const buffer = Buffer.from(data.split(',')[1], 'base64');
    const png = PNG.sync.read(buffer);
    let ink = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if (Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) > 24) ink++;
    }
    assert.ok(ink / (png.width * png.height) > 0.1, `${body}: empty or badly framed capture`);
    const file = join(output, `solar-system-${body.toLowerCase()}.png`);
    writeFileSync(file, buffer);
    console.log(`${file}: ${(100 * ink / (png.width * png.height)).toFixed(1)}% ink`);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
