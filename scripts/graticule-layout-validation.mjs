#!/usr/bin/env node
/** Review acceptance fixtures: layouts, pose history, free look and a resident depression. */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(root, process.env.GRID_CAPTURE_DIR ?? 'docs/validation/graticule/coordinate-lattice/layout');
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
const regionalPose = (latitude, longitude, altitude) => {
  const lat = latitude * Math.PI / 180, lon = longitude * Math.PI / 180;
  const radial = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  return { radii: [100, 100, 100], eye: radial.map(v => v * (100 + altitude)), target: radial.map(v => v * 100),
    up: [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)], controls: true };
};
// Derive the regional pose from the same geodetic coordinate used by the main harness.
const lat = 18.44 * Math.PI / 180, lon = 77.45 * Math.PI / 180;
const e2 = 1 - (mars.radii[2] / mars.radii[0]) ** 2, n = mars.radii[0] / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
mars.target = [n * Math.cos(lat) * Math.cos(lon), n * Math.cos(lat) * Math.sin(lon), n * (1 - e2) * Math.sin(lat)];
mars.eye = mars.target.map((v, i) => v + 80 * [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)][i]);
mars.up = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
const scenes = [
  ...[300, 110, 102, 100.5, 100.1, 100.02].map((distance, index) => ({ name: `zoom-${index + 1}`, imagery: '/textures/moon-2k.jpg',
    setup: { radii: [100, 100, 100], eye: [distance, 0, 0], target: [100, 0, 0], controls: true } })),
  ...[145, 130, 115].map(distance => ({ name: `zoom-transition-${distance}`, setup: {
    radii: [100, 100, 100], eye: [distance, 0, 0], target: [100, 0, 0], controls: true } })),
  { name: 'small-globe-night-side', setup: { eye: [8000, 0, 2000], lighting: true, sunPosition: [0, -5000, 1000], imagery: true, controls: true } },
  { name: 'regional-carriers', setup: { radii: [100, 100, 100], eye: [101, 0, 0], target: [100, 0, 0], controls: true } },
  { name: 'regional-coordinate-lattice', setup: { ...regionalPose(55, 2, 10), manual: true, step: 1 } },
  { name: 'regional-distant-occluder', setup: { ...regionalPose(55, 2, 10), manual: true, step: 1, distantOccluder: true } },
  { name: 'close-coordinate-lattice', setup: { ...regionalPose(55, -120, 0.5), manual: true, step: 0.1 } },

  { name: 'oblique-polar', setup: { eye: [2000, -3100, 5400] } },
  { name: 'south-pole', setup: { eye: [0, 0, -6000], up: [1, 0, 0] } },
  { name: 'regional-mars', setup: mars },
  { name: 'depression-ground', setup: { name: 'Depression', radii: [100, 100, 100], terrain: true, depression: true, eye: [99.5, 0, 0], target: [99, 0, 0] } },
  { name: 'transition-regional', setup: {}, path: [{ eye: [1740, 0, 0], target: [1737.4, 0, 0] }] },
  { name: 'same-pose-path-a', setup: { manual: true, step: 15 }, path: [{ eye: [5500, 0, 2200] }, finalPose] },
  { name: 'same-pose-path-b', setup: { manual: true, step: 15, eye: [1745, 0, 0] }, path: [{ eye: [0, 0, 6000], up: [1, 0, 0] }, finalPose] },
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
    let startRequests = requests;
    await page.evaluate(options => window.setup(options), scene.setup);
    if (scene.imagery) { await page.evaluate(url => window.loadImagery(url), scene.imagery); startRequests = requests; }
    await settle();
    for (const pose of scene.path ?? []) { await page.evaluate(options => window.pose(options), pose); await settle(); }
    const controller = scene.drag ? await page.evaluate(([x, y]) => window.freeLook(x, y), scene.drag) : null;
    if (scene.drag) await settle();
    const metric = await page.evaluate(() => window.frame());
    const image = await page.evaluate(() => window.capture());
    writeFileSync(resolve(out, `${scene.name}.png`), Buffer.from(image.split(',')[1], 'base64'));
    results.push({ name: scene.name, gridRequests: requests - startRequests, controller, ...metric });
  }
  const wide = await browser.newPage({ viewport: { width: 2048, height: 1152 } });
  wide.on('pageerror', e => errors.push(e.message)); wide.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await wide.goto(`${process.env.GRID_VIEWER_URL ?? 'http://localhost:5173'}/graticule-validation.html`, { waitUntil: 'domcontentloaded' });
  await wide.waitForFunction(() => window.ready);
  let wideRequests = 0; wide.on('request', () => wideRequests++);
  await wide.evaluate(options => window.setup(options), { ...regionalPose(55, 2, 10), manual: true, step: 1, controls: false, distantOccluder: true });
  for (let i = 0; i < 18; i++) { await wide.evaluate(() => window.frame()); await wide.waitForTimeout(20); }
  const wideMetric = await wide.evaluate(() => window.frame());
  const wideImage = await wide.evaluate(() => window.capture());
  writeFileSync(resolve(out, 'wide-coordinate-lattice.png'), Buffer.from(wideImage.split(',')[1], 'base64'));
  results.push({ name: 'wide-coordinate-lattice', gridRequests: wideRequests, controller: null, ...wideMetric });
  await wide.evaluate(options => window.setup(options), { ...regionalPose(40, -15, 20), distantOccluder: true, controls: false });
  for (let i = 0; i < 18; i++) { await wide.evaluate(() => window.frame()); await wide.waitForTimeout(20); }
  const midZoomMetric = await wide.evaluate(() => window.frame());
  const midZoomImage = await wide.evaluate(() => window.capture());
  writeFileSync(resolve(out, 'mid-zoom-coordinate-lattice.png'), Buffer.from(midZoomImage.split(',')[1], 'base64'));
  results.push({ name: 'mid-zoom-coordinate-lattice', gridRequests: wideRequests, controller: null, ...midZoomMetric });
  await wide.setViewportSize({ width: 3456, height: 1988 });
  await wide.evaluate(options => window.setup(options), { ...regionalPose(40, -15, 0.02), controls: false });
  for (let i = 0; i < 18; i++) { await wide.evaluate(() => window.frame()); await wide.waitForTimeout(20); }
  const fineMetric = await wide.evaluate(() => window.frame());
  const fineImage = await wide.evaluate(() => window.capture());
  writeFileSync(resolve(out, 'wide-fine-line-labels.png'), Buffer.from(fineImage.split(',')[1], 'base64'));
  results.push({ name: 'wide-fine-line-labels', gridRequests: wideRequests, controller: null, ...fineMetric });
  await wide.setViewportSize({ width: 2048, height: 1152 });
  await wide.evaluate(options => window.setup(options), { ...regionalPose(71.5, -48, 1.5), manual: true, step: 0.2, controls: false, distantOccluder: true });
  for (let i = 0; i < 18; i++) { await wide.evaluate(() => window.frame()); await wide.waitForTimeout(20); }
  const highLatitudeMetric = await wide.evaluate(() => window.frame());
  const highLatitudeImage = await wide.evaluate(() => window.capture());
  writeFileSync(resolve(out, 'high-latitude-distant-occluder.png'), Buffer.from(highLatitudeImage.split(',')[1], 'base64'));
  results.push({ name: 'high-latitude-distant-occluder', gridRequests: wideRequests, controller: null, ...highLatitudeMetric });
  await wide.close();
  const annotations = name => {
    const metric = results.find(r => r.name === name).metrics;
    return metric.anchors.filter(a => a.tier === `${metric.latitudeStep}:${metric.longitudeStep}`).toSorted((a, b) => a.id.localeCompare(b.id));
  };
  const eligibleAnchorsIndependent = annotations('same-pose-path-a').length > 0 && JSON.stringify(annotations('same-pose-path-a')) === JSON.stringify(annotations('same-pose-path-b'));
  const depression = results.find(r => r.name === 'depression-ground').metrics;
  const freeLook = results.find(r => r.name === 'free-look');
  const duplicateSites = results.flatMap(r => {
    const seen = new Set();
    return r.metrics.annotations.filter(a => { const key = `${a.axis}:${a.latDeg}:${a.lonDeg}`; const duplicate = seen.has(key); seen.add(key); return duplicate; });
  }).length;
  const lineSites = ['regional-coordinate-lattice', 'regional-distant-occluder', 'close-coordinate-lattice', 'wide-coordinate-lattice', 'high-latitude-distant-occluder'].map(name => {
    const labels = results.find(r => r.name === name).metrics.annotations;
    return { name, count: labels.length, rows: new Set(labels.map(a => a.latDeg)).size,
      columns: new Set(labels.map(a => a.lonDeg)).size,
      complete: labels.every(a => (a.axis === 'latitude' && /[NS]$/.test(a.text) || a.axis === 'longitude' && /[EW]$/.test(a.text)) && !a.text.includes('·')) };
  });
  const gridAt = name => results.find(r => r.name === name).metrics;
  const restrainedZoom = gridAt('zoom-transition-145').latitudeStep === 30
    && gridAt('zoom-transition-130').latitudeStep === 10
    && gridAt('zoom-transition-115').latitudeStep === 5
    && gridAt('mid-zoom-coordinate-lattice').latitudeStep === 5
    && gridAt('mid-zoom-coordinate-lattice').labels > 0
    && gridAt('mid-zoom-coordinate-lattice').labels <= 12;
  const boundedBands = results.every(r => {
    const labels = r.metrics.annotations;
    return r.runtime.graticuleInstances === 1 && r.runtime.visibleGridSprites === labels.length && labels.length <= 24
      && new Set(labels.filter(a => a.axis === 'latitude').map(a => a.lonDeg)).size <= 1
      && new Set(labels.filter(a => a.axis === 'longitude').map(a => a.latDeg)).size <= 1;
  });
  const pass = duplicateSites === 0 && errors.length === 0 && results.every(r => r.gridRequests === 0) && eligibleAnchorsIndependent
    && depression.candidates > 0 && depression.latitudeStep <= 0.1 && depression.longitudeStep <= 0.1
    && freeLook.controller.tracked === null && freeLook.controller.origin === 'Moon'
    && lineSites.every(site => site.complete);
  const accepted = pass && restrainedZoom && boundedBands;
  writeFileSync(resolve(out, 'metrics.json'), JSON.stringify({ renderer: 'Chromium SwiftShader; synthetic resident terrain', pass: accepted, duplicateSites, lineSites, restrainedZoom, boundedBands, eligibleAnchorsIndependent, results, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ output: out, pass: accepted, duplicateSites, lineSites, restrainedZoom, boundedBands, eligibleAnchorsIndependent, depression: {
    candidates: depression.candidates, labels: depression.labels, latitudeStep: depression.latitudeStep, longitudeStep: depression.longitudeStep,
  }, freeLook: freeLook.controller, errors }, null, 2));
  if (!accepted) process.exitCode = 1;
} finally {
  await browser.close(); rmSync(fixture, { force: true }); rmSync(baseline, { force: true });
}
