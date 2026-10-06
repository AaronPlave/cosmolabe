#!/usr/bin/env node
/** Continuous rendered orbit, zoom, pan and tangent motion, plus lighting captures. */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(root, process.env.GRID_CAPTURE_DIR ?? 'docs/validation/graticule/selection-contrast');
const fixture = resolve(root, 'apps/viewer/graticule-validation.html');
const baseline = resolve(root, 'packages/three/src/BodyMeshBefore.ts');
mkdirSync(out, { recursive: true });
writeFileSync(fixture, readFileSync(resolve(root, 'scripts/graticule-validation/fixture.html')));
writeFileSync(baseline, execFileSync('git', ['show', '8d685f73f94cab63bca54d4d16c6eee909a2a89a:packages/three/src/BodyMesh.ts'], { cwd: root }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const frameDir = mkdtempSync(resolve(tmpdir(), 'graticule-motion-'));
const frames = [];
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${process.env.GRID_VIEWER_URL ?? 'http://localhost:5173'}/graticule-validation.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ready);
  let requests = 0; page.on('request', () => requests++);
  await page.evaluate(() => window.setup({ radii: [100, 100, 100], eye: [300, 0, 50], controls: true, terrain: true, relief: true, lighting: true, color: '#c8c8c8' }));
  await page.evaluate(() => window.loadImagery('/textures/moon-2k.jpg'));
  requests = 0;
  await page.evaluate(() => {
    window.validationTime = performance.now();
    Object.defineProperty(performance, 'now', { configurable: true, value: () => window.validationTime });
  });
  // Fixed 30 Hz application time preserves frames between 150 ms plans even
  // when software rendering is slower than playback. Encode every rendered frame.
  for (let index = 0; index <= 600; index++) {
    const result = await page.evaluate(index => {
      const time = index / 30;
      window.validationTime += 1000 / 30;
      const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
      let eye, target, stage;
      const angle = 0.5;
      const radial = [Math.cos(angle), Math.sin(angle), 0];
      if (time < 4) { stage = 'rolled-orbit'; const a = 0.5 * smooth(time / 4); eye = [300 * Math.cos(a), 300 * Math.sin(a), 50 * (1 - smooth(time / 4))]; target = [0, 0, 0]; }
      else if (time < 8) { stage = 'zoom'; const d = 300 * Math.pow(101 / 300, smooth((time - 4) / 4)); eye = radial.map(x => x * d); target = radial.map(x => x * 100); }
      else if (time < 11) { stage = 'pan'; const a = angle + 0.04 * smooth((time - 8) / 3); eye = [101 * Math.cos(a), 101 * Math.sin(a), 0]; target = [100 * Math.cos(a), 100 * Math.sin(a), 0]; }
      else if (time < 13) { stage = 'near-ground'; const a = angle + 0.04, d = 101 - 0.75 * smooth((time - 11) / 2); eye = [d * Math.cos(a), d * Math.sin(a), 0]; target = [100 * Math.cos(a), 100 * Math.sin(a), 0]; }
      else if (time < 16) { stage = 'residual-damping'; const a = angle + 0.04 + 1e-7 * Math.sin(time * 4) * Math.exp(-(time - 13)); eye = [100.25 * Math.cos(a), 100.25 * Math.sin(a), 0]; target = [100 * Math.cos(a), 100 * Math.sin(a), 0]; }
      else { stage = 'tangent'; const a = angle + 0.04, t = smooth((time - 16) / 4); const r = [Math.cos(a), Math.sin(a), 0], side = [-Math.sin(a), Math.cos(a), 0]; eye = r.map(x => x * 100.25); target = r.map((x, i) => eye[i] - x * (1 - 0.97 * t) + side[i] * 0.97 * t); }
      const roll = time < 4 ? 0.12 * Math.sin(time) : 0.1;
      const up = [-Math.sin(angle) * Math.sin(roll), Math.cos(angle) * Math.sin(roll), Math.cos(roll)];
      window.pose({ eye, target, up }); const frame = window.frame();
      return { image: document.querySelector('canvas').toDataURL(), frame: { time, stage, distance: Math.hypot(...eye),
        updateMs: frame.updateMs, metrics: { ...frame.metrics, anchors: undefined }, points: window.diagnostics() } };
    }, index);
    frames.push(result.frame);
    writeFileSync(resolve(frameDir, `frame-${String(index).padStart(4, '0')}.png`), Buffer.from(result.image.split(',')[1], 'base64'));
    if (index % 90 === 0) console.log(`Rendered motion frame ${index}/600`);
  }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', resolve(frameDir, 'frame-%04d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', '-movflags', '+faststart', resolve(out, 'orbit-zoom-pan-tangent.mp4')]);
  await page.evaluate(() => { delete performance.now; });
  const captures = [];
  for (const [name, options] of [['day-night', { lighting: true, sunPosition: [0,-5000,1000], color: '#b0aaa0' }], ['bright-imagery', { imagery: true, color: '#eeeece' }], ['dark-imagery', { imagery: true, color: '#10151b' }]]) {
    await page.evaluate(options => window.setup({ radii: [100, 100, 100], eye: [300, 0, 50], controls: true, ...options }), options);
    for (let i = 0; i < 20; i++) { await page.evaluate(() => window.frame()); await page.waitForTimeout(16); }
    const image = await page.evaluate(() => window.capture());
    writeFileSync(resolve(out, `${name}.png`), Buffer.from(image.split(',')[1], 'base64'));
    captures.push({ name, ...await page.evaluate(() => window.frame()) });
  }
  const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;
  const identities = new Map(), lineErrors = [], attachmentErrors = [];
  let survivingFramePairs = 0;
  for (const f of frames) for (const p of f.points) {
    const annotation = f.metrics.annotations.find(a => a.id === p.id);
    if (!annotation) throw new Error('Visible sprite has no annotation identity');
    lineErrors.push(Math.abs(annotation.axis === 'latitude' ? p.lat - annotation.angle : wrap(p.lon - annotation.angle)));
    const original = identities.get(p.id);
    if (original) { attachmentErrors.push(Math.max(Math.abs(p.lat - original.lat), Math.abs(wrap(p.lon - original.lon)))); survivingFramePairs++; }
    else identities.set(p.id, p);
  }
  const held = frames.filter(f => f.stage === 'residual-damping' && f.time > 13.75);
  const heldIds = held.map(f => f.points.map(p => p.id).sort().join('|'));
  const stationaryToggles = heldIds.slice(1).filter((ids, i) => ids !== heldIds[i]).length;
  const maxAttachmentErrorDeg = Math.max(0, ...attachmentErrors);
  const controls = [{ x0: 8, y0: 80, x1: 56, y1: 550 }, { x0: 80, y0: 686, x1: 1016, y1: 760 }];
  const controlOverlaps = frames.flatMap(f => f.points).filter(p => controls.some(c => p.rect.x0 < c.x1
    && p.rect.x1 > c.x0 && p.rect.y0 < c.y1 && p.rect.y1 > c.y0)).length;
  const maxLineErrorDeg = Math.max(0, ...lineErrors);
  const duplicateLines = [...frames.map(f => f.metrics), ...captures.map(c => c.metrics)].reduce((count, metric) => {
    const lines = metric.annotations.map(a => `${a.axis}:${a.angle}`);
    return count + lines.length - new Set(lines).size;
  }, 0);
  const regionalAxes = [...new Set(frames.filter(f => f.stage === 'pan' || f.stage === 'near-ground').flatMap(f => f.metrics.annotations.map(a => a.axis)))];
  const pass = duplicateLines === 0 && regionalAxes.length === 2 && frames.length === 601 && survivingFramePairs > 100 && held.every(f => f.points.length > 0)
    && stationaryToggles === 0 && maxAttachmentErrorDeg < 1e-6 && controlOverlaps === 0 && errors.length === 0 && requests === 0
    && maxLineErrorDeg < 1e-6 && frames.every(f => f.metrics.labels <= 3 && f.metrics.candidates <= 96);
  const summary = { pass, renderer: 'Chromium SwiftShader; real lunar imagery, synthetic resident relief; fixed 30 Hz clock', durationSeconds: frames.at(-1).time,
    frames: frames.length, duplicateLines, regionalAxes, maxLineErrorDeg, maxAttachmentErrorDeg, survivingFramePairs, stationaryToggles, heldFrames: held.length,
    gridRequests: requests, controlOverlaps, maxUpdateMs: Math.max(...frames.map(f => f.updateMs)), errors, captures };
  writeFileSync(resolve(out, 'metrics.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(resolve(out, 'frames.json'), JSON.stringify(frames) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  if (!pass) process.exitCode = 1;
} finally { rmSync(frameDir, { recursive: true, force: true }); await browser.close(); rmSync(fixture, { force: true }); rmSync(baseline, { force: true }); }
