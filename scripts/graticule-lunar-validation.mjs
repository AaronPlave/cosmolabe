/** Real lunar presets, including the polar MoonFall terrain and Apollo imagery.
 * GRID_OUTPUT=/tmp/grid-lunar node scripts/graticule-lunar-validation.mjs
 * GRID_EXPECT_POLAR=1 requires readable polar captions after the fix.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const out = resolve(process.env.GRID_OUTPUT ?? '/tmp/grid-lunar');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: process.platform === 'darwin' ? 'chrome' : undefined, headless: true,
  args: process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript(() => { window.gridImport = path => import(performance.getEntriesByType('resource').map(e => e.name)
  .filter(url => new URL(url).pathname === path).at(-1) ?? path); });
const report = { passed: false, views: [], errors: [] };
page.on('pageerror', error => report.errors.push(error.message));
page.on('console', message => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(message.text())) report.errors.push(message.text()); });
try {
  for (const [catalog, names] of [
    ['moonfall-shackleton', ['Shackleton Overview', 'PSR Floor View']],
    ['moon-imagery-apollo15', ['Hadley regional', 'Hadley Rille', 'Apollo 15 landing site']],
  ]) {
    await page.goto(`${process.env.GRID_VIEWER_URL ?? 'http://127.0.0.1:5188'}/?catalog=test-catalogs/${catalog}&test=1`);
    await page.waitForFunction(() => window.renderer?.getBodyMesh('Moon') && window.__cosmolabe?.assetsReady, undefined, { timeout: 60000 });
    for (const name of names) {
      await page.evaluate(async name => {
        const state = await window.gridImport('/src/lib/viewer-state.svelte.ts'), c = window.cosmo;
        if (state.getRenderer() !== window.renderer) throw new Error('Different viewer session');
        c.setPlaying(false); c.setLayer('grid', true); c.setGridScope('bodies', 'Moon'); c.setGridLabels(true); c.setGridDensity('auto');
        c.setGridCoordinateFrame(false);
        if (!state.applyViewpoint(name, { animate: false })) throw new Error(`Unknown viewpoint: ${name}`);
      }, name);
      await page.waitForTimeout(3000);
      for (const coordinateFrame of [false, true]) {
        await page.evaluate(value => window.cosmo.setGridCoordinateFrame(value), coordinateFrame);
        await page.waitForTimeout(2000);
        const view = await page.evaluate(async () => {
          const r = window.renderer, bm = r.getBodyMesh('Moon'), frames = [], costs = [], update = bm.updateGrid;
          bm.updateGrid = function(...args) { const start = performance.now(); const result = update.apply(this, args); costs.push(performance.now() - start); return result; };
          try { for (let i = 0; i < 45; i++) { await new Promise(requestAnimationFrame); const m = bm.gridMetrics;
            frames.push({ labels: m.labels, ticks: m.frameTicks.length, queries: m.frameQueries,
              axes: [...new Set(m.annotations.map(a => a.axis))],
              error: Math.max(0, ...m.frameTicks.map(t => t.alignmentPx ?? 0)) });
          } } finally { bm.updateGrid = update; }
          const m = bm.gridMetrics, gl = r.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
          costs.sort((a,b) => a-b);
          return { frame: bm.bodyFixedFrame, available: bm.attitudeAvailable, steps: [m.latitudeStep, m.longitudeStep], candidates: m.candidates,
            annotations: m.annotations, minLabels: Math.min(...frames.map(f => f.labels)), maxLabels: Math.max(...frames.map(f => f.labels)),
            minTicks: Math.min(...frames.map(f => f.ticks)), maxTicks: Math.max(...frames.map(f => f.ticks)),
            maxQueries: Math.max(...frames.map(f => f.queries)), maxAlignmentPx: Math.max(...frames.map(f => f.error)),
            bothSurfaceAxesFrames: frames.filter(f => f.axes.length === 2).length, updateP95Ms: costs[Math.floor(costs.length * .95)],
            visibleTiles: bm.terrainManager?.tiles.visibleTiles.size ?? 0, imagery: bm.terrainManager?.cubeImageryStats?.ready ?? null,
            gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
            cameraSceneUnits: r.camera.position.toArray(), fov: r.camera.fov };
        });
        report.views.push({ catalog, name, coordinateFrame, ...view });
        console.log(JSON.stringify(report.views.at(-1)));
        await page.screenshot({ path: `${out}/${name.toLowerCase().replaceAll(' ', '-')}-${coordinateFrame ? 'frame' : 'surface'}.png` });
        assert.ok(view.maxQueries <= 8); assert.ok(view.maxAlignmentPx <= .2);
        if (process.env.GRID_EXPECT_POLAR === '1' && catalog === 'moonfall-shackleton' && !coordinateFrame) {
          assert.ok(view.minLabels > 0, `Polar captions missing in ${name}`);
          assert.ok(view.visibleTiles > 0, 'No real Shackleton terrain loaded');
          assert.equal(view.bothSurfaceAxesFrames, 45, `Missing polar ruler axis in ${name}`);
        }
      }
    }
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
