#!/usr/bin/env node
/** Review acceptance fixtures: layouts, pose history, free look and a resident depression. */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(root, process.env.GRID_CAPTURE_DIR ?? 'docs/validation/graticule/selection-contrast/layout');
const fixture = resolve(root, 'apps/viewer/graticule-validation.html');
const baseline = resolve(root, 'packages/three/src/BodyMeshBefore.ts');
mkdirSync(out, { recursive: true });
writeFileSync(fixture, readFileSync(resolve(root, 'scripts/graticule-validation/fixture.html')));
writeFileSync(baseline, execFileSync('git', ['show', '8d685f73f94cab63bca54d4d16c6eee909a2a89a:packages/three/src/BodyMesh.ts'], { cwd: root }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], results = [];
const finalPose = { eye: [4500, 3000, 2500] };
const mars = { name: 'Mars', radii: [3396.19, 3396.19, 3376.2] };
// Derive the regional pose from the same geodetic coordinate used by the main harness.
const lat = 18.44 * Math.PI / 180, lon = 77.45 * Math.PI / 180;
const e2 = 1 - (mars.radii[2] / mars.radii[0]) ** 2, n = mars.radii[0] / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
mars.target = [n * Math.cos(lat) * Math.cos(lon), n * Math.cos(lat) * Math.sin(lon), n * (1 - e2) * Math.sin(lat)];
mars.eye = mars.target.map((v, i) => v + 80 * [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)][i]);
mars.up = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
const scenes = [
  { name: 'small-globe-night-side', setup: { eye: [8000, 0, 2000], lighting: true, sunPosition: [0, -5000, 1000], imagery: true, controls: true } },
  { name: 'regional-repeated-latitude', setup: { radii: [100, 100, 100], eye: [101, 0, 0], target: [100, 0, 0], controls: true } },

  { name: 'oblique-polar', setup: { eye: [2000, -3100, 5400] } },
  { name: 'south-pole', setup: { eye: [0, 0, -6000], up: [1, 0, 0] } },
  { name: 'regional-mars', setup: mars },
  { name: 'depression-ground', setup: { name: 'Depression', radii: [100, 100, 100], terrain: true, depression: true, eye: [99.5, 0, 0], target: [99, 0, 0] } },
  { name: 'transition-regional', setup: {}, path: [{ eye: [1740, 0, 0], target: [1737.4, 0, 0] }] },
  { name: 'same-pose-path-a', setup: { manual: true, step: 20 }, path: [{ eye: [5500, 0, 2200] }, finalPose] },
  { name: 'same-pose-path-b', setup: { manual: true, step: 20, eye: [1745, 0, 0] }, path: [{ eye: [0, 0, 6000], up: [1, 0, 0] }, finalPose] },
  { name: 'free-look', setup: {}, drag: [25, 12] },
];
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${process.env.GRID_VIEWER_URL ?? 'http://localhost:5173'}/graticule-validation.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ready);
  let requests = 0; page.on('request', () => requests++);
  const settle = async () => {
    for (let i = 0; i < 18; i++) { await page.evaluate(() => window.frame()); await page.waitForTimeout(20); }
  };
  for (const scene of scenes) {
    const startRequests = requests;
    await page.evaluate(options => window.setup(options), scene.setup);
    await settle();
    for (const pose of scene.path ?? []) { await page.evaluate(options => window.pose(options), pose); await settle(); }
    const controller = scene.drag ? await page.evaluate(([x, y]) => window.freeLook(x, y), scene.drag) : null;
    if (scene.drag) await settle();
    const metric = await page.evaluate(() => window.frame());
    const image = await page.evaluate(() => window.capture());
    writeFileSync(resolve(out, `${scene.name}.png`), Buffer.from(image.split(',')[1], 'base64'));
    results.push({ name: scene.name, gridRequests: requests - startRequests, controller, ...metric });
  }
  const annotations = name => results.find(r => r.name === name).metrics.anchors.filter(a => a.tier === '15:15').toSorted((a, b) => a.id.localeCompare(b.id));
  const eligibleAnchorsIndependent = JSON.stringify(annotations('same-pose-path-a')) === JSON.stringify(annotations('same-pose-path-b'));
  const depression = results.find(r => r.name === 'depression-ground').metrics;
  const freeLook = results.find(r => r.name === 'free-look');
  const duplicateLines = results.flatMap(r => {
    const seen = new Set();
    return r.metrics.annotations.filter(a => { const key = `${a.axis}:${a.angle}`; const duplicate = seen.has(key); seen.add(key); return duplicate; });
  }).length;
  const regionalAxes = [...new Set(results.find(r => r.name === 'regional-repeated-latitude').metrics.annotations.map(a => a.axis))];
  const pass = duplicateLines === 0 && regionalAxes.length === 2 && errors.length === 0 && results.every(r => r.gridRequests === 0) && eligibleAnchorsIndependent
    && depression.candidates > 0 && depression.labels > 0 && depression.latitudeStep < 0.1 && depression.longitudeStep < 0.1
    && freeLook.controller.tracked === null && freeLook.controller.origin === 'Moon' && freeLook.metrics.labels > 0;
  writeFileSync(resolve(out, 'metrics.json'), JSON.stringify({ renderer: 'Chromium SwiftShader; synthetic resident terrain', pass, duplicateLines, regionalAxes, eligibleAnchorsIndependent, results, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ output: out, pass, duplicateLines, regionalAxes, eligibleAnchorsIndependent, depression: {
    candidates: depression.candidates, labels: depression.labels, latitudeStep: depression.latitudeStep, longitudeStep: depression.longitudeStep,
  }, freeLook: freeLook.controller, errors }, null, 2));
  if (!pass) process.exitCode = 1;
} finally {
  await browser.close(); rmSync(fixture, { force: true }); rmSync(baseline, { force: true });
}
