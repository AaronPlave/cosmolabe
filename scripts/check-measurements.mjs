/** Browser regressions for measurements. Run against `npm run dev --workspace apps/viewer`.
 * Usage: node scripts/check-measurements.mjs [http://localhost:5173]
 * Start a fresh dev server before running so source imports share the app's module instances.
 * Uses Vite's source imports to inspect state and exercise live DOM updates.
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
const base = process.argv[2] ?? 'http://localhost:5173';
const out = new URL('../apps/viewer/test-screenshots/measurements/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(`${base}/?catalog=earth-moon&test=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => window.__cosmolabe?.ready, { timeout: 120000 });
  console.log('Scene ready');
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady === true, null, { timeout: 120000 });
  console.log('Assets ready');
  await page.evaluate(() => {
    const resources = performance.getEntriesByType('resource');
    window.measurementModules = Object.fromEntries(['spatial-measurements.svelte.ts', 'shell.svelte.ts', 'loader.ts'].map(file => {
      const entry = resources.find(e => new URL(e.name).pathname.endsWith('/' + file));
      if (!entry) throw new Error(`Missing loaded module ${file}`);
      return [file, entry.name];
    }));
  });
  const live = await page.evaluate(async (moduleUrl) => {
    const { EventCallout } = await import(moduleUrl);
    const host = document.createElement('div');
    Object.assign(host.style, { position: 'absolute', width: '320px', height: '300px' });
    document.body.append(host);
    const callout = new EventCallout(host);
    const content = { lines: ['Two long surface endpoint names that need wrapping within a narrow viewport', '123 km'], color: '#82aabd', tone: 'preview', feature: 'point' };
    callout.setLiveContent(content);
    callout.update({ x: 140, y: 160 }, { width: 320, height: 300 }, { rects: [], path: [], discs: [] });
    const node = host.querySelector('.cosmolabe-event-callout');
    const row = node.children[1];
    for (let i = 0; i < 120; i++) {
      callout.setLiveContent({ ...content, lines: [content.lines[0], `${123 + i} km`] });
      callout.update({ x: 140, y: 160 }, { width: 320, height: 300 }, { rects: [], path: [], discs: [] });
    }
    const result = { copies: host.querySelectorAll('.cosmolabe-event-callout').length, sameRow: row === node.children[1], text: row.textContent, width: node.offsetWidth };
    callout.dispose(); host.remove();
    return result;
  }, '/@fs' + fileURLToPath(new URL('../packages/three/src/EventCallout.ts', import.meta.url)));
  console.log('Live content checked', live);
  assert.equal(live.copies, 1); assert.equal(live.sameRow, true); assert.equal(live.text, '242 km'); assert(live.width <= 304);

  await page.getByRole('button', { name: 'Measurements', exact: true }).click();
  await page.locator('[aria-label="Source entity"]').click();
  await page.getByRole('option', { name: 'Earth', exact: true }).click();
  await page.locator('[aria-label="Target entity"]').click();
  await page.getByRole('option', { name: 'Moon', exact: true }).click();
  await page.getByRole('button', { name: 'Add distance', exact: true }).click();
  await page.evaluate(() => window.__cosmolabe.capture('Lunar Orbit'));
  await page.waitForTimeout(600);
  await page.screenshot({ timeout: 120000, path: new URL('distance-wide-actual.png', out).pathname });

  // Observe actual playback, retaining the live detail node and watching for ghosts.
  const playback = await page.evaluate(async () => {
    const r = window.renderer;
    const { measurements } = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    const layer = r.spatialRelationships;
    const visual = layer.visuals.get(measurements.items[0].id);
    const box = visual.callout.box, row = box.children[1];
    const before = row.textContent;
    let maxCopies = 0;
    const timer = setInterval(() => maxCopies = Math.max(maxCopies, document.querySelectorAll('.cosmolabe-event-callout').length), 16);
    r.timeController.setRate(86400);
    r.timeController.play();
    for (let frame = 0; frame < 24; frame++) await new Promise(requestAnimationFrame);
    r.timeController.pause(); clearInterval(timer);
    return { before, after: row.textContent, sameRow: box.children[1] === row, maxCopies };
  });
  assert(playback.before !== playback.after, JSON.stringify(playback));
  assert(playback.sameRow); assert(playback.maxCopies <= 4, JSON.stringify(playback)); // A placement-side transition may leave one fading copy.
  console.log('Playback checked', playback);
  await page.screenshot({ timeout: 120000, path: new URL('distance-playback-actual.png', out).pathname });

  // Every actual close resets endpoints and pending picks; minimization preserves endpoints.
  const lifecycle = await page.evaluate(async () => {
    const { measurements } = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    const { closeTool, openTool, minimizePanel, shell } = await import(window.measurementModules['shell.svelte.ts']);
    const settle = () => new Promise(resolve => requestAnimationFrame(resolve));
    measurements.draft.source = { kind: 'entity', bodyName: 'Earth' };
    measurements.pendingPickSlot = 'target'; closeTool('measure'); await settle();
    const closed = !measurements.pendingPickSlot && !measurements.draft.source;
    openTool('measure'); await settle();
    measurements.draftKind = 'angle';
    measurements.draft.source = { kind: 'entity', bodyName: 'Earth' };
    measurements.pendingPickSlot = 'target'; minimizePanel('measure'); await settle();
    const minimized = !measurements.pendingPickSlot && !!measurements.draft.source && measurements.draftKind === 'angle';
    shell.panels.measure.minimized = false; measurements.draftKind = 'distance'; await settle();
    return { closed, minimized };
  });
  console.log('Lifecycle checked', lifecycle);
  assert(lifecycle.closed); assert(lifecycle.minimized);
  await page.getByRole('button', { name: 'Pick target surface point' }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByText('Pick target point in the scene · Esc to cancel').count(), 0);
  await page.getByRole('button', { name: 'Measurements', exact: true }).click();
  await page.getByRole('button', { name: 'Measurements', exact: true }).click();
  assert(await page.getByRole('button', { name: 'Add distance' }).isDisabled());
  const reload = await page.evaluate(async () => {
    const { loadDemo } = await import(window.measurementModules['loader.ts']);
    const { measurements } = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    const old = window.renderer;
    await loadDemo(document.querySelector('canvas'), 'earth-moon');
    return { changed: old !== window.renderer, items: measurements.items.length, pending: measurements.pendingPickSlot };
  });
  assert(reload.changed); assert.equal(reload.items, 0); assert.equal(reload.pending, null);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => { const { openTool } = await import(window.measurementModules['shell.svelte.ts']); openTool('measure'); });
  await page.getByRole('button', { name: 'angle', exact: true }).click();
  await page.getByRole('button', { name: 'Pick source surface point' }).click();
  await page.getByRole('button', { name: 'Measurements', exact: true }).click();
  const mobileMinimized = await page.evaluate(async () => {
    const { measurements: m } = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    return { kind: m.draftKind, pending: m.pendingPickSlot };
  });
  assert.equal(mobileMinimized.kind, 'angle'); assert.equal(mobileMinimized.pending, null);
  await page.getByRole('button', { name: 'Measurements', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'angle', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Pick vertex surface point' }).click();
  await page.getByRole('button', { name: 'Catalog', exact: true }).click();
  const mobileSwitched = await page.evaluate(async () => {
    const { measurements: m } = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    return { kind: m.draftKind, pending: m.pendingPickSlot };
  });
  assert.equal(mobileSwitched.kind, 'angle'); assert.equal(mobileSwitched.pending, null);
  await page.getByRole('button', { name: 'Measurements', exact: true }).click();
  await page.getByRole('button', { name: 'Close Measurements', exact: true }).click();
  await page.getByRole('button', { name: 'Measurements', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'distance', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.keyboard.down('b'); await page.keyboard.down('b'); await page.keyboard.up('b');
  const repeatSheet = await page.evaluate(async () => { const { shell } = await import(window.measurementModules['shell.svelte.ts']); return shell.activeSheet; });
  assert.equal(repeatSheet, 'catalog');
  await page.setViewportSize({ width: 1440, height: 1000 });

  const surface = await page.evaluate(async () => {
    const { loadDemo } = await import(window.measurementModules['loader.ts']);
    const { measurements, captureSurfaceEndpoint, addMeasurement } = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    const { openTool } = await import(window.measurementModules['shell.svelte.ts']);
    await loadDemo(document.querySelector('canvas'), 'inner-planets-keplerian');
    await window.__cosmolabe.whenAssetsReady();
    window.renderer.stop();
    openTool('measure');
    measurements.pendingPickSlot = 'source'; captureSurfaceEndpoint('Earth', [6378, 0, 0]);
    measurements.pendingPickSlot = 'target'; captureSurfaceEndpoint('Earth', [0, 6378, 0]);
    const source = measurements.draft.source, target = measurements.draft.target;
    addMeasurement({ id: 'surface-distance', kind: 'distance', source, target, color: '#82aabd' });
    addMeasurement({ id: 'surface-angle', kind: 'angle', source, target, vertex: { kind: 'entity', bodyName: 'Earth' }, color: '#c6a66b' });
    addMeasurement({ id: 'surface-direction', kind: 'direction', source: target, target: source, color: '#9ab58d' });
    await new Promise(requestAnimationFrame);
    window.__cosmolabe.capture('Earth Closeup');
    return { source: source.label, target: target.label };
  });
  assert(surface.source !== surface.target);
  await page.waitForTimeout(600);
  // The renderer caches host rectangles for 250ms. Re-project after UI layout settles.
  await page.evaluate(() => window.__cosmolabe.capture());
  await page.waitForTimeout(200);
  await page.screenshot({ timeout: 120000, path: new URL('surface-close-actual.png', out).pathname });
  const panelOverlaps = await page.evaluate(() => {
    const blockers = [...document.querySelectorAll('[data-scene-occluder]')].map(n => n.getBoundingClientRect());
    return [...document.querySelectorAll('.cosmolabe-event-callout')].filter(n => n.style.display !== 'none').some(n => {
      const c = n.getBoundingClientRect();
      return blockers.some(b => Math.min(c.right, b.right) > Math.max(c.left, b.left) && Math.min(c.bottom, b.bottom) > Math.max(c.top, b.top));
    });
  });
  assert.equal(panelOverlaps, false, 'Visible callouts must avoid the host panels');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ live, playback, lifecycle, reload, mobileMinimized, mobileSwitched, repeatSheet, surface }, null, 2));
} finally { await browser.close(); }
