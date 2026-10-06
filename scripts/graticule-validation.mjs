#!/usr/bin/env node
/** Bounded, asset-free shader/line comparison. Run against a local viewer Vite server. */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(root, process.env.GRID_CAPTURE_DIR ?? 'docs/validation/graticule');
const baseline = process.env.GRID_BASELINE_REF ?? '8d685f73f94cab63bca54d4d16c6eee909a2a89a';
const beforePath = resolve(root, 'packages/three/src/BodyMeshBefore.ts');
mkdirSync(out, { recursive: true });
const fixturePath = resolve(root, 'apps/viewer/graticule-validation.html');
writeFileSync(fixturePath, readFileSync(resolve(root, 'scripts/graticule-validation/fixture.html')));
writeFileSync(beforePath, execFileSync('git', ['show', `${baseline}:packages/three/src/BodyMesh.ts`], { cwd: root }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [], errors = [];
const surfaceView = (lat, lon, radii, altitude) => {
  const phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180;
  const a = radii[0], c = radii[2], e2 = 1 - c * c / (a * a), n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const target = [n * Math.cos(phi) * Math.cos(lambda), n * Math.cos(phi) * Math.sin(lambda), n * (1 - e2) * Math.sin(phi)];
  const up = [-Math.sin(phi) * Math.cos(lambda), -Math.sin(phi) * Math.sin(lambda), Math.cos(phi)];
  const normal = [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
  return { target, up, eye: target.map((v, i) => v + normal[i] * altitude), radii, lat, lon };
};
const mars = [3396.19, 3396.19, 3376.2];
const scenes = [
  { name: 'whole-moon', options: {} },
  { name: 'whole-earth', options: { name: 'Earth', radii: [6378.137, 6378.137, 6356.752], eye: [22000, 0, 0] } },
  { name: 'oblique-moon', options: { eye: [4500, 3000, 2500] } },
  { name: 'away-from-prime', options: { eye: [-3200, 4800, 2300] } },
  { name: 'south-pole', options: { eye: [0, 0, -6000], up: [1, 0, 0] } },
  { name: 'antimeridian', options: { eye: [-6000, 1, 0] } },
  { name: 'regional-mars', options: { name: 'Mars', ...surfaceView(18.44, 77.45, mars, 80) } },
  { name: 'bright-surface', options: { color: '#eeeeee' } },
  { name: 'dark-surface', options: { color: '#080b10' } },
  { name: 'mobile-dpr2', viewport: { width: 390, height: 844 }, dpr: 2, options: {} },
  { name: 'synthetic-terrain-shader', options: { name: 'Mars', ...surfaceView(18.44, 77.45, mars, 250), terrain: true } },
  { name: 'synthetic-terrain-shader-lines', onlyAfter: true, options: { name: 'Mars', ...surfaceView(18.44, 77.45, mars, 250), terrain: true, labels: false, manual: true, step: 0.5 } },
  { name: 'synthetic-terrain-draped', onlyAfter: true, options: { name: 'Mars', ...surfaceView(18.44, 77.45, mars, 250), terrain: true, draped: true, step: 0.5 } },
];
try {
  for (const scene of scenes) {
    const page = await browser.newPage({ viewport: scene.viewport ?? { width: 1024, height: 768 }, deviceScaleFactor: scene.dpr ?? 1 });
    let requests = 0;
    page.on('request', () => requests++);
    page.on('pageerror', e => errors.push({ scene: scene.name, error: e.message }));
    page.on('console', m => { if (m.type() === 'error') errors.push({ scene: scene.name, error: m.text() }); });
    await page.goto(`${process.env.GRID_VIEWER_URL ?? 'http://localhost:5173'}/graticule-validation.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.ready);
    for (const before of scene.onlyAfter ? [false] : [true, false]) {
      const requestsBefore = requests;
      await page.evaluate(options => window.setup(options), { ...scene.options, before });
      // Let the density transition settle; no network data is involved.
      for (let i = 0; i < 12; i++) { await page.evaluate(() => window.frame()); await page.waitForTimeout(20); }
      const times = [];
      for (let i = 0; i < 20; i++) times.push(await page.evaluate(() => window.frame()));
      const median = key => times.map(t => t[key]).sort((a, b) => a - b)[Math.floor(times.length / 2)];
      const image = await page.evaluate(() => window.capture());
      const name = `${scene.name}-${before ? 'before' : 'after'}`;
      writeFileSync(resolve(out, `${name}.png`), Buffer.from(image.split(',')[1], 'base64'));
      results.push({ name, gridRequests: requests - requestsBefore, ...times.at(-1), medianUpdateMs: median('updateMs'), medianFrameMs: median('frameMs') });
    }
    await page.close();
  }
  writeFileSync(resolve(out, 'metrics.json'), JSON.stringify({ baseline, renderer: 'Chromium SwiftShader; gl.finish frame timings; synthetic asset-free reference surfaces', results, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ output: out, scenes: results.length, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify(errors));
  throw error;
} finally {
  await browser.close();
  rmSync(beforePath, { force: true });
  rmSync(fixturePath, { force: true });
}
