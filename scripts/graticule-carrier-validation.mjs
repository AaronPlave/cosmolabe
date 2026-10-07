#!/usr/bin/env node
/** Matching-camera old-grid reference and ordered carrier comparisons. */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(root, process.env.GRID_CAPTURE_DIR ?? 'docs/validation/graticule/carrier-rulers/comparison');
const fixture = resolve(root, 'apps/viewer/graticule-validation.html'), baseline = resolve(root, 'packages/three/src/BodyMeshBefore.ts');
mkdirSync(out, { recursive: true });
writeFileSync(fixture, readFileSync(resolve(root, 'scripts/graticule-validation/fixture.html')));
writeFileSync(baseline, execFileSync('git', ['show', '8d685f73f94cab63bca54d4d16c6eee909a2a89a:packages/three/src/BodyMesh.ts'], { cwd: root }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const lat = 18.44 * Math.PI / 180, lon = 77.45 * Math.PI / 180;
const radii = [3396.19, 3396.19, 3376.2], e2 = 1 - (radii[2] / radii[0]) ** 2;
const n = radii[0] / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
const target = [n * Math.cos(lat) * Math.cos(lon), n * Math.cos(lat) * Math.sin(lon), n * (1 - e2) * Math.sin(lat)];
const up = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
const region = { name: 'Mars', radii, target, up, eye: target.map((v, i) => v + 80 * [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)][i]) };
const errors = [], results = [];
const angle = 0.54, radial = [Math.cos(angle), Math.sin(angle), 0], side = [-Math.sin(angle), Math.cos(angle), 0];
const tangentEye = radial.map(v => v * 100.25);
const tangent = { radii: [100, 100, 100], eye: tangentEye, up: radial,
  target: tangentEye.map((v, i) => v - radial[i] * 0.03 + side[i] * 0.97), terrain: true, relief: true, lighting: true };
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${process.env.GRID_VIEWER_URL ?? 'http://localhost:5173'}/graticule-validation.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ready);
  for (const [name, options] of [
    ['old-globe', { before: true, radii: [100, 100, 100], eye: [300, 0, 60] }],
    ['new-globe', { radii: [100, 100, 100], eye: [300, 0, 60], manual: process.env.GRID_PROTOTYPE === '1', step: 30 }],
    ['old-regional', { ...region, before: true }],
    ['new-regional', { ...region, manual: process.env.GRID_PROTOTYPE === '1', step: 0.2 }],
    ['new-oblique', { ...region, up: [0.2, 0.7, 0.6] }],
    ['synthetic-ground-tangent', tangent],
  ]) {
    await page.evaluate(options => window.setup(options), { controls: true, imagery: true, ...options });
    if (name === 'synthetic-ground-tangent') await page.evaluate(() => window.loadImagery('/textures/moon-2k.jpg'));
    for (let i = 0; i < 24; i++) { await page.evaluate(() => window.frame()); await page.waitForTimeout(20); }
    const capture = await page.evaluate(() => window.capture());
    writeFileSync(resolve(out, `${name}.png`), Buffer.from(capture.split(',')[1], 'base64'));
    results.push({ name, options, ...await page.evaluate(() => window.frame()) });
  }
  // Pixel coverage is diagnostic evidence for local horizon suppression, not
  // a substitute for live terrain acceptance. Measure the shader with captions off.
  await page.evaluate(() => window.gridLines(true));
  for (let i = 0; i < 12; i++) { await page.evaluate(() => window.frame()); await page.waitForTimeout(20); }
  const lit = await page.evaluate(() => {
    const canvas = document.querySelector('canvas'), helper = document.createElement('canvas'); helper.width = canvas.width; helper.height = canvas.height;
    const context = helper.getContext('2d'); context.drawImage(canvas, 0, 0);
    return { pixels: Array.from(context.getImageData(0, 0, helper.width, helper.height).data), width: helper.width, height: helper.height, image: canvas.toDataURL() };
  });
  await page.evaluate(() => window.gridLines(false)); await page.evaluate(() => window.frame());
  const unlit = await page.evaluate(() => {
    const canvas = document.querySelector('canvas'), helper = document.createElement('canvas'); helper.width = canvas.width; helper.height = canvas.height;
    const context = helper.getContext('2d'); context.drawImage(canvas, 0, 0);
    return { pixels: Array.from(context.getImageData(0, 0, helper.width, helper.height).data), image: canvas.toDataURL() };
  });
  const coverage = (y0, y1) => {
    let changed = 0, count = 0, skyPixels = 0;
    for (let y = y0; y < y1; y++) for (let x = 80; x < lit.width - 80; x++) {
      const i = (y * lit.width + x) * 4;
      // Exclude the fixture sky so the horizon band measures actual surface.
      if ([5, 8, 17].reduce((sum, v, c) => sum + Math.abs(unlit.pixels[i + c] - v), 0) <= 12) { skyPixels++; continue; }
      count++;
      if ([0, 1, 2].reduce((sum, c) => sum + Math.abs(lit.pixels[i + c] - unlit.pixels[i + c]), 0) > 8) changed++;
    }
    return { changed, count, skyPixels, fraction: count ? changed / count : 0 };
  };
  const tangentCoverage = { distantBand: coverage(420, 500), foreground: coverage(600, 750) };
  writeFileSync(resolve(out, 'tangent-grid.png'), Buffer.from(lit.image.split(',')[1], 'base64'));
  writeFileSync(resolve(out, 'tangent-surface.png'), Buffer.from(unlit.image.split(',')[1], 'base64'));
  writeFileSync(resolve(out, 'tangent-coverage.json'), JSON.stringify(tangentCoverage, null, 2) + '\n');
  writeFileSync(resolve(out, 'metrics.json'), JSON.stringify({ pass: errors.length === 0, tangentCoverage, results, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ output: out, pass: errors.length === 0, tangentCoverage, labels: results.map(r => [r.name, r.metrics?.labels]), errors }));
  if (errors.length) process.exitCode = 1;
} finally { await browser.close(); rmSync(fixture, { force: true }); rmSync(baseline, { force: true }); }
