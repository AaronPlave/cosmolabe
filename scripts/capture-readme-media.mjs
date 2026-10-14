/** Ordinary-rendering, full-viewport README captures. See docs/readme-media.md. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const recipes = JSON.parse(readFileSync(new URL('../docs/readme-captures.json', import.meta.url), 'utf8'));
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5199/';
const output = resolve(process.env.CL_CAPTURE_DIR ?? 'docs/img');
const requested = process.argv.slice(2);
const scenes = recipes.scenes.filter(scene => !requested.length || requested.includes(scene.id));
for (const id of requested) assert.ok(scenes.some(scene => scene.id === id), `Unknown scene: ${id}`);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=' + (process.env.CL_ANGLE ?? (process.platform === 'darwin' ? 'metal' : 'gl')),
    '--ignore-gpu-blocklist', '--enable-gpu'] });
mkdirSync(output, { recursive: true });
try {
  for (const scene of scenes) {
    const page = await browser.newPage({ viewport: recipes.viewport, deviceScaleFactor: 1 });
    const errors = [];
    const pending = new Set();
    let lastNetworkChange = Date.now();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { pending.add(request); lastNetworkChange = Date.now(); });
    page.on('requestfinished', request => { pending.delete(request); lastNetworkChange = Date.now(); });
    page.on('requestfailed', request => {
      pending.delete(request); lastNetworkChange = Date.now();
      errors.push(`${request.url()}: ${request.failure()?.errorText}`);
    });
    page.on('response', response => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    if (scene.omitImageryHosts) {
      await page.route('**/test-catalogs/' + scene.catalog + '.json', async route => {
        const response = await route.fetch();
        const catalog = await response.json();
        for (const body of catalog.items) {
          const imagery = body.geometry?.terrain?.imagery;
          if (Array.isArray(imagery)) body.geometry.terrain.imagery = imagery.filter(layer => !scene.omitImageryHosts.includes(new URL(layer.url).hostname));
        }
        await route.fulfill({ response, json: catalog });
      });
    }
    const url = new URL(base);
    assert.ok(!url.searchParams.has('test'), 'Showcase capture must not use test mode');
    url.searchParams.set('catalog', `test-catalogs/${scene.catalog}`);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.cosmo && window.renderer?.initialAssetsSummary,
      null, { timeout: 240000 });
    const initial = await page.evaluate(() => window.renderer.initialAssetsSummary);
    assert.equal(initial.failed, 0, `${scene.id}: failed initial assets: ${JSON.stringify(initial)}`);
    assert.equal(initial.timedOut, false, `${scene.id}: initial asset timeout`);
    await page.evaluate(async scene => {
      const c = window.cosmo, r = window.renderer;
      const state = await import('/src/lib/viewer-state.svelte.ts');
      const shell = await import('/src/lib/shell.svelte.ts');
      c.setPlaying(false);
      c.setTime({ kind: 'et', et: scene.et });
      c.gotoObject(scene.tracked);
      if (scene.viewpoint) c.viewpoint(scene.viewpoint);
      if (scene.frame) c.setFrame(scene.frame, scene.tracked);
      if (scene.surfaceCamera) {
        const u = r.getContext().universe;
        const a = u.absolutePositionOf(scene.tracked, scene.et), b = u.absolutePositionOf(scene.terrain, scene.et);
        const d = a.map((v, i) => v - b[i]), length = Math.hypot(...d), n = d.map(v => v / length);
        const t = [1 - n[0]*n[0], -n[0]*n[1], -n[0]*n[2]], tl = Math.hypot(...t);
        c.setCamera(n.map((v,i) => v * scene.surfaceCamera.height + t[i] / tl * scene.surfaceCamera.offset), [0,0,0], n);
      }
      if (scene.camera) {
        c.setCamera(scene.camera.position, scene.camera.target, scene.camera.up);
        c.setFov(scene.camera.fov);
      }
      c.setLayer('labels', true);
      c.setLayer('grid', false); c.setLayer('axes', false);
      c.setLayer('trajectories', !!scene.trajectory);
      c.setLayer('sensors', !!scene.sensor); c.setLayer('sensorLabels', false);
      for (const name of r.trajectoryLines.keys()) c.showTrajectory(name, name === scene.trajectory);
      for (const name of r.getSensorNames()) c.setObjectVisible(name, name === scene.sensor);
      for (const name of r.bodyMeshes.keys()) {
        c.showLabel(name, [scene.tracked, scene.selected, scene.trajectory, 'Europa', 'Jupiter'].includes(name));
      }
      if (scene.search) {
        const e = await import('/src/lib/event-finder.svelte.ts');
        e.setKind(scene.search.kind);
        e.setRole('observer', scene.search.observer); e.setRole('target', scene.search.target);
        e.setWindow(scene.search.start, scene.search.end); e.setStep(scene.search.step);
        await e.runSearch();
        if (e.ef.fault || e.ef.events.length !== 1) throw new Error(`Unexpected search: ${JSON.stringify(e.ef.fault ?? e.ef.events)}`);
        e.selectEvent(e.ef.events[0]);
        if (Math.abs(c.getTime() - scene.et) > 0.001) throw new Error('Selected event changed epoch');
      }
      if (scene.measurement) {
        const m = await import('/src/lib/spatial-measurements.svelte.ts');
        m.addMeasurement(scene.measurement);
      }
      if (scene.selected) c.select(scene.selected); else c.deselect();
      if (scene.panel) shell.openTool(scene.panel);
      if (scene.timeline) {
        shell.setTimelineDepth('expanded');
        state.vs.scrubMin = scene.timeline[0]; state.vs.scrubMax = scene.timeline[1];
      }
    }, scene);
    if (scene.panel === 'script') {
      const source = await (await page.request.get(new URL('test-catalogs/earth-moon-tour.cosmo', base).href)).text();
      await page.locator('.cm-content').waitFor();
      const excerpt = '# Stationary stop from the Earth–Moon tour\nsetPlaying off\nsetTime 2015-10-31T23:50:00Z\ngotoObject Moon\n' + source.slice(source.indexOf('setFrame body-fixed Moon'), source.indexOf('wait 1', source.indexOf('setFrame body-fixed Moon')));
      await page.locator('.cm-content').fill(excerpt);
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await page.getByLabel('Script status').filter({ hasText: /Done|Completed|complete/i }).waitFor();
    }
    if (scene.terrain) {
      await page.waitForFunction(name => {
        const m = window.renderer.getBodyMesh(name)?.terrainManager?.metrics;
        return m && m.tiles.visible > 0 && !m.network.downloading && !m.network.parsing && !m.network.queued;
      }, scene.terrain, { timeout: 180000 });
    }
    // Drain actual fetches, including imagery that begins after terrain refinement.
    const deadline = Date.now() + 180000;
    while (pending.size || Date.now() - lastNetworkChange < 1000) {
      assert.ok(Date.now() < deadline, `${scene.id}: streaming did not settle (${pending.size} requests)`);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity)
        .map(a => a.finished.catch(() => {})));
    });
    assert.deepEqual(errors, [], `${scene.id}: browser/network errors`);
    if (scene.panel === 'events') await page.locator('.event-result.selected').waitFor();
    const metadata = await page.evaluate(scene => ({
      et: cosmo.getTime(), camera: cosmo.getCamera(), snapshot: cosmo.snapshot(),
      initialAssets: renderer.initialAssetsSummary,
      terrain: scene.terrain ? renderer.getBodyMesh(scene.terrain).terrainManager.metrics : null,
      gpu: (() => {
        const gl = renderer.renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
        return gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
      })(),
    }), scene);
    if (metadata.terrain) assert.equal(metadata.terrain.network.failed, 0, `${scene.id}: failed terrain tiles`);
    await page.screenshot({ path: resolve(output, scene.output),
      ...(scene.output.endsWith('.jpg') ? { type: 'jpeg', quality: 90 } : {}) });
    writeFileSync(resolve(output, `mission-${scene.id}.capture.json`), JSON.stringify({ scene, viewport: recipes.viewport, ...metadata }, null, 2) + '\n');
    console.log(`${scene.id}: ${scene.output}; ${initial.loaded} initial assets; ET ${metadata.et}`);
    await page.close();
  }
} finally { await browser.close(); }
