#!/usr/bin/env node
// Same-camera comparison of incident solar extinction, keeping view AP active.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import sharp from 'sharp';

const output = process.env.ATMOSPHERE_CAPTURE_DIR ?? 'apps/viewer/test-screenshots/atmosphere-surface';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('THREE.WebGLProgram')) errors.push(message.text());
  });
  const comparisons = [];
  const terminatorCrops = [];
  for (const [catalog, body, viewpoint] of [
    ['atmosphere-earth-textured', 'Earth', 'Whole disc'],
    ['atmosphere-earth-twilight', 'Earth', 'Terminator disc'],
    ['atmosphere-mars-textured', 'Mars', 'Whole disc'],
    ['atmosphere-saturn-shadow', 'Saturn', 'Clouds and shadows'],
  ]) {
    if (process.env.ATMOSPHERE_CAPTURE_SCENES && !process.env.ATMOSPHERE_CAPTURE_SCENES.split(',').includes(catalog)) continue;
    await page.goto(`${process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5174'}/?catalog=${catalog}&test=1`);
    await page.waitForFunction(() => window.__cosmolabe?.assetsReady, { timeout: 120000 });
    assert.equal((await page.evaluate(() => window.__cosmolabe.assetSummary)).failed, 0, `${catalog}: missing assets`);
    await page.evaluate(() => window.renderer.setLabelsVisible(false));
    const row = comparisons.length / 3;
    comparisons.push({ input: Buffer.from(`<svg width="1024" height="28"><rect width="1024" height="28" fill="#222"/>
      <text x="12" y="20" fill="white" font-family="sans-serif" font-size="14">${body}: ${viewpoint} — prior sunlight (left), RGB solar extinction (right)</text></svg>`),
      left: 0, top: row * 412 });
    for (const enabled of [false, true]) {
      await page.evaluate(({ body, enabled }) => {
        const mat = window.renderer.getBodyMesh(body).mesh.material;
        window.surfaceOriginalOBC ??= mat.onBeforeCompile.bind(mat);
        mat.onBeforeCompile = (shader, renderer) => {
          window.surfaceOriginalOBC(shader, renderer);
          if (!enabled) shader.fragmentShader = shader.fragmentShader.replace(
            'directLight.color *= computeSurfaceSunTransmittance(vAPWorldPos);', '');
        };
        mat.customProgramCacheKey = () => `surface-sun-${enabled}`;
        mat.needsUpdate = true;
      }, { body, enabled });
      const png = await page.evaluate(view => window.__cosmolabe.capture(view), viewpoint);
      const file = `${output}/${catalog}-${enabled ? 'solar-extinction' : 'prior-sunlight'}.png`;
      writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
      if (catalog === 'atmosphere-earth-twilight') {
        // Same pixel rectangle, 3x nearest-neighbor enlargement. No exposure
        // adjustment or interpolation that could hide the measured change.
        const label = enabled ? 'RGB solar extinction enabled' : 'Prior sunlight';
        terminatorCrops.push({ input: Buffer.from(`<svg width="768" height="40"><rect width="768" height="40" fill="#222"/>
          <text x="16" y="27" fill="white" font-family="sans-serif" font-size="20">${label}</text></svg>`),
          left: enabled ? 768 : 0, top: 0 });
        terminatorCrops.push({ input: await sharp(Buffer.from(png.split(',')[1], 'base64'))
          .extract({ left: 384, top: 304, width: 256, height: 144 })
          .resize(768, 432, { kernel: 'nearest' }).png().toBuffer(), left: enabled ? 768 : 0, top: 40 });
      }
      comparisons.push({ input: await sharp(Buffer.from(png.split(',')[1], 'base64')).resize(512, 384).png().toBuffer(),
        left: enabled ? 512 : 0, top: row * 412 + 28 });
      console.log(file);
    }
  }
  assert.deepEqual(errors, [], 'Shader compilation/page errors');
  assert.ok(comparisons.length > 0, 'No capture scenes selected');
  await sharp({ create: { width: 1024, height: comparisons.length / 3 * 412, channels: 3, background: '#000' } })
    .composite(comparisons).png().toFile(`${output}/solar-extinction-comparison.png`);
  if (terminatorCrops.length) await sharp({ create: { width: 1536, height: 472, channels: 3, background: '#000' } })
    .composite(terminatorCrops).png().toFile(`${output}/earth-terminator-crops.png`);
} finally { await browser.close(); }
