#!/usr/bin/env node
/** Same-path surface/frame prototypes using the viewer's built package entry. */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
const root = process.cwd(), out = resolve('docs/validation/graticule/coordinate-frame');
const fixture = resolve('apps/viewer/graticule-validation.html'), baseline = resolve('packages/three/src/BodyMeshBefore.ts');
mkdirSync(out, { recursive: true });
writeFileSync(fixture, readFileSync('scripts/graticule-validation/fixture.html'));
writeFileSync(baseline, execFileSync('git', ['show', '8d685f73f94cab63bca54d4d16c6eee909a2a89a:packages/three/src/BodyMesh.ts']));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], loaded = new Set(), results = [], paths = [], silhouetteChecks = [];
const fingerprint = Object.fromEntries(['AdaptiveGraticule', 'GraticuleFrame', 'GraticuleShader'].flatMap(name => ['src/' + name + '.ts', 'dist/' + name + '.js'])
  .map(path => [path, createHash('sha256').update(readFileSync('packages/three/' + path)).digest('hex')]));
const angle = 0.5, radial = [Math.cos(angle), Math.sin(angle), 0], side = [-Math.sin(angle), Math.cos(angle), 0];
const pose = (i, count) => {
  const t = i / (count - 1), smooth = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  const d = 300 * Math.pow(101 / 300, smooth(t / 0.6));
  const pan = 0.003 * Math.sin(t * Math.PI), r = [Math.cos(angle + pan), Math.sin(angle + pan), 0];
  const eye = r.map(v => v * d), target = r.map(v => v * 100), roll = 0.25 * Math.sin(t * Math.PI);
  let up = [-radial[1] * Math.sin(roll), radial[0] * Math.sin(roll), Math.cos(roll)];
  if (t > 0.7) { const tilt = smooth((t - 0.7) / 0.3); for (let j = 0; j < 3; j++) target[j] = eye[j] - r[j] * (1 - 0.94 * tilt) + side[j] * 0.94 * tilt;
    up = up.map((v, j) => v * (1 - tilt) + r[j] * tilt); }
  return { eye, target, up };
};
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => { if (r.url().includes('/packages/three/')) loaded.add(r.url().split('/packages/three/')[1].split('?')[0]); });
  await page.goto(`${process.env.GRID_VIEWER_URL ?? 'http://localhost:5173'}/graticule-validation.html`); await page.waitForFunction(() => window.ready);
  for (const coordinateFrame of [false, true]) {
    const mode = coordinateFrame ? 'frame' : 'surface', frames = [], dir = mkdtempSync(resolve(tmpdir(), 'grid-frame-'));
    await page.evaluate(options => window.setup(options), { radii: [100, 100, 100], coordinateFrame, controls: true, ...pose(0, 97) });
    await page.evaluate(() => window.loadImagery('/textures/moon-2k.jpg'));
    await page.evaluate(() => { window.validationTime = performance.now(); Object.defineProperty(performance, 'now', { configurable: true, value: () => window.validationTime }); });
    for (let i = 0; i < 97; i++) {
      const p = pose(i, 97);
      const frame = await page.evaluate(p => { window.validationTime += 125; window.pose(p); return window.frame(); }, p);
      const png = await page.evaluate(() => window.capture());
      writeFileSync(resolve(dir, `frame-${String(i).padStart(4, '0')}.png`), Buffer.from(png.split(',')[1], 'base64'));
      frames.push({ index: i, pose: p, ...frame });
      if ([0, 48, 64, 80, 96].includes(i)) writeFileSync(resolve(out, `${mode}-${i}.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '8', '-i', resolve(dir, 'frame-%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', resolve(out, `${mode}.mp4`)]);
    rmSync(dir, { recursive: true, force: true }); paths.push({ mode, frames });
  }
  for (const coordinateFrame of [false, true]) for (const deviceScaleFactor of [1, 2]) {
    await page.setViewportSize({ width: 800, height: 800 });
    // Separate browser contexts exercise actual device pixel ratios.
    const context = await browser.newContext({ viewport: { width: 800, height: 800 }, deviceScaleFactor }); const p = await context.newPage();
    p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(`${process.env.GRID_VIEWER_URL ?? 'http://localhost:5173'}/graticule-validation.html`); await p.waitForFunction(() => window.ready);
    for (const [name, options] of [['bright', { color: '#eeeece' }], ['dark', { color: '#10151b' }], ['small-globe', { eye: [800, 0, 0], target: [0, 0, 0] }], ['terrain', { terrain: true, relief: true }]]) {
      await p.evaluate(options => window.setup(options), { radii: [100, 100, 100], eye: [101, 0, 0], target: [100, 0, 0], coordinateFrame, ...options });
      for (let i = 0; i < 12; i++) { await p.evaluate(() => window.frame()); await p.waitForTimeout(20); }
      const frame = await p.evaluate(() => window.frame()); results.push({ mode: coordinateFrame ? 'frame' : 'surface', name, deviceScaleFactor, ...frame });
      const png = await p.evaluate(() => window.capture()); writeFileSync(resolve(out, `${coordinateFrame ? 'frame' : 'surface'}-${name}-${deviceScaleFactor}.png`), Buffer.from(png.split(',')[1], 'base64'));
      if (name === 'small-globe') {
        await p.evaluate(() => { window.gridLines(false); window.frame(); });
        const plain = await p.evaluate(() => window.capture());
        const { data: off, info } = await sharp(Buffer.from(plain.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const on = await sharp(Buffer.from(png.split(',')[1], 'base64')).removeAlpha().raw().toBuffer();
        const mask = new Uint8Array(info.width * info.height);
        for (let j = 0; j < mask.length; j++) mask[j] = Math.abs(off[j * 3] - 5) + Math.abs(off[j * 3 + 1] - 8) + Math.abs(off[j * 3 + 2] - 17) > 8 ? 1 : 0;
        let changed = 0, outside = 0;
        // Permit one physical pixel of silhouette antialiasing, independent of DPR.
        for (let j = 0; j < mask.length; j++) {
          if (Math.abs(on[j * 3] - off[j * 3]) + Math.abs(on[j * 3 + 1] - off[j * 3 + 1]) + Math.abs(on[j * 3 + 2] - off[j * 3 + 2]) <= 8) continue;
          changed++; const x = j % info.width, y = Math.floor(j / info.width); let inside = false;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && x + dx < info.width && y + dy >= 0 && y + dy < info.height && mask[(y + dy) * info.width + x + dx]) inside = true;
          if (!inside) outside++;
        }
        silhouetteChecks.push({ mode: coordinateFrame ? 'frame' : 'surface', deviceScaleFactor, changedPixels: changed, outsideSilhouettePixels: outside, antialiasAllowancePhysicalPixels: 1 });
      }
    }
    await context.close();
  }
  const all = [...paths.flatMap(p => p.frames), ...results];
  const pass = errors.length === 0 && [...loaded].some(v => v.endsWith('/GraticuleFrame.js') || v.endsWith('/GraticuleFrame.ts')) && [...loaded].some(v => v.endsWith('/BodyMesh.js') || v.endsWith('/BodyMesh.ts')) && all.every(f => f.runtime.graticuleInstances === 1 && f.runtime.visibleGridSprites === f.metrics.labels)
    && paths[1].frames.some(f => new Set(f.metrics.frameTicks.map(t => t.axis)).size === 2) && results.every(f => f.metrics.frameTicks.length <= 8)
    && silhouetteChecks.every(c => c.changedPixels > 0 && c.outsideSilhouettePixels === 0);
  const report = { pass, fingerprint, loadedModules: [...loaded].sort(), errors, paths, results, silhouetteChecks };
  writeFileSync(resolve(out, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ pass, loaded: [...loaded], errors, frames: paths.map(p => p.frames.length), frameAxes: [...new Set(paths[1].frames.flatMap(f => f.metrics.frameTicks.map(t => t.axis)))] }));
  if (!pass) process.exitCode = 1;
} finally { await browser.close(); rmSync(fixture, { force: true }); rmSync(baseline, { force: true }); }
