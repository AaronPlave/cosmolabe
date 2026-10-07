#!/usr/bin/env node
/** Fixed-altitude optical zoom through the actual BodyMesh/updateGrid path. */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(root, process.env.GRID_CAPTURE_DIR ?? 'docs/validation/graticule/optical-zoom');
const fixture = resolve(root, 'apps/viewer/graticule-validation.html'), baseline = resolve(root, 'packages/three/src/BodyMeshBefore.ts');
mkdirSync(out, { recursive: true });
writeFileSync(fixture, readFileSync(resolve(root, 'scripts/graticule-validation/fixture.html')));
writeFileSync(baseline, execFileSync('git', ['show', '8d685f73f94cab63bca54d4d16c6eee909a2a89a:packages/three/src/BodyMesh.ts'], { cwd: root }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], results = [];
const pose = { eye: [300, 0, 0], target: [100, 0, 0] };
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${process.env.GRID_VIEWER_URL ?? 'http://localhost:5173'}/graticule-validation.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ready);
  await page.evaluate(options => window.setup(options), { radii: [100, 100, 100], controls: true, fov: 60, ...pose });
  await page.evaluate(() => window.loadImagery('/textures/moon-2k.jpg'));
  let requests = 0; page.on('request', () => requests++);
  for (const [name, fov] of [['wide-60', 60], ['region-10', 10], ['close-1', 1], ['return-10', 10], ['restored-60', 60]]) {
    await page.evaluate(options => window.pose(options), { ...pose, fov });
    for (let i = 0; i < 30; i++) { await page.evaluate(() => window.frame()); await page.waitForTimeout(20); }
    const frame = await page.evaluate(() => window.frame());
    const capture = await page.evaluate(() => window.capture());
    writeFileSync(resolve(out, `${name}.png`), Buffer.from(capture.split(',')[1], 'base64'));
    results.push({ name, fov, pose, ...frame });
  }
  const [wide, region, close, , restored] = results.map(r => r.metrics);
  const sites = m => m.anchors.map(a => [a.axis, a.angle, a.lat, a.lon]).sort();
  // Existing collision entry/exit hysteresis may change the visible subset.
  // The prescribed eligible ruler sites themselves must return unchanged.
  const restoresRulers = sites(wide).length > 0 && JSON.stringify(sites(wide)) === JSON.stringify(sites(restored));
  const pass = errors.length === 0 && requests === 0 && restoresRulers && wide.latitudeStep === 30 && wide.longitudeStep === 30
    && region.latitudeStep < 30 && region.longitudeStep < 30 && close.latitudeStep < 1 && close.longitudeStep < 1
    && restored.latitudeStep === 30 && restored.longitudeStep === 30 && results.every(r => r.metrics.candidates <= 96);
  const report = { pass, renderer: 'Chromium SwiftShader; real lunar imagery, reference sphere', restoresRulers, gridRequests: requests, results, errors };
  writeFileSync(resolve(out, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output: out, pass, restoresRulers, gridRequests: requests,
    steps: results.map(r => [r.fov, r.metrics.latitudeStep, r.metrics.longitudeStep]), errors }));
  if (!pass) process.exitCode = 1;
} finally { await browser.close(); rmSync(fixture, { force: true }); rmSync(baseline, { force: true }); }
