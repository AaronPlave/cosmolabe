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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(`${base}/?catalog=test-catalogs/earth-moon&test=1`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => window.__cosmolabe?.ready, null, { timeout: 120000 });
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
    let layoutReads = 0;
    const box = callout.box;
    for (const property of ['offsetWidth', 'offsetHeight']) {
      const getter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property).get;
      Object.defineProperty(box, property, { get() { layoutReads++; return getter.call(this); } });
    }
    const content = { lines: ['Two long surface endpoint names that need wrapping within a narrow viewport', '123 km'], color: '#82aabd', tone: 'preview', feature: 'point' };
    callout.setLiveContent(content);
    callout.update({ x: 140, y: 160 }, { width: 320, height: 300 }, { rects: [], path: [], discs: [] });
    const node = host.querySelector('.cosmolabe-event-callout');
    const row = node.children[1];
    for (let i = 0; i < 120; i++) {
      callout.setLiveContent({ ...content, lines: [content.lines[0], `${123 + i} km`] });
      callout.update({ x: 140, y: 160 }, { width: 320, height: 300 }, { rects: [], path: [], discs: [] });
    }
    const result = { layoutReads, copies: host.querySelectorAll('.cosmolabe-event-callout').length, sameRow: row === node.children[1], text: row.textContent, width: node.getBoundingClientRect().width };
    host.style.width = '220px';
    callout.update({ x: 100, y: 160 }, { width: 220, height: 300 }, { rects: [], path: [], discs: [] });
    const resizeReads = layoutReads;
    callout.setLiveContent({ ...content, lines: [content.lines[0], 'A much longer live value that changes the number of wrapped lines'] });
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    callout.update({ x: 100, y: 160 }, { width: 220, height: 300 }, { rects: [], path: [], discs: [] });
    result.responsive = node.getBoundingClientRect().width <= 204;
    result.observerCached = Math.abs(callout.size.height - node.getBoundingClientRect().height) < 1 && layoutReads === resizeReads;
    callout.dispose(); host.remove();
    return result;
  }, '/@fs' + fileURLToPath(new URL('../packages/three/src/EventCallout.ts', import.meta.url)));
  console.log('Live content checked', live);
  assert(live.responsive); assert(live.observerCached); assert.equal(live.layoutReads, 2); assert.equal(live.copies, 1); assert.equal(live.sameRow, true); assert.equal(live.text, '242 km'); assert(live.width <= 304);

  await page.getByRole('button', { name: 'Measurements', exact: true }).click();
  await page.getByLabel('Source entity', { exact: true }).selectOption('Earth');
  await page.getByLabel('Target entity', { exact: true }).selectOption('Moon');
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
    await loadDemo(document.querySelector('canvas'), 'test-catalogs/earth-moon');
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
    await loadDemo(document.querySelector('canvas'), 'test-catalogs/inner-planets-keplerian');
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
  await checkInteractions();
  console.log(JSON.stringify({ live, playback, lifecycle, reload, mobileMinimized, mobileSwitched, repeatSheet, surface }, null, 2));
} finally { await browser.close(); }

async function checkInteractions() {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async () => {
    const m = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    const r = window.renderer;
    r.stop();
    m.resetMeasurementsForScene();
    m.addMeasurement({ id: 'edit-test', kind: 'distance', source: { kind: 'entity', bodyName: 'Earth' }, target: { kind: 'entity', bodyName: 'Moon' } });
    m.measurements.draft.source = { kind: 'entity', bodyName: 'Mars' };
    window.__cosmolabe.capture('Earth Closeup');
  });
  await page.locator('summary[aria-label="Actions for distance"]').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'direction', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const canceled = await page.evaluate(async () => {
    const { measurements: m } = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    return { kind: m.items[0].kind, draft: m.draft.source.bodyName };
  });
  assert.deepEqual(canceled, { kind: 'distance', draft: 'Mars' });
  await page.locator('summary[aria-label="Actions for distance"]').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'direction', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.evaluate(() => window.__cosmolabe.capture());
  const edited = await page.evaluate(async () => {
    const { measurements: m } = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    const v = window.renderer.spatialRelationships.visuals.get('edit-test');
    return { id: m.items[0].id, kind: m.items[0].kind, visualKind: v.kind, arrow: !!v.arrow, showDistance: m.items[0].showDistance, draft: m.draft.source.bodyName };
  });
  assert.deepEqual(edited, { id: 'edit-test', kind: 'direction', visualKind: 'direction', arrow: true, showDistance: false, draft: 'Mars' });
  await page.locator('summary[aria-label="Actions for direction"]').click();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await page.getByLabel('Target entity', { exact: true }).selectOption('Sun');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const duplicate = await page.evaluate(async () => {
    const { measurements: m } = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    return { ids: m.items.map(i => i.id), targets: m.items.map(i => i.target.bodyName), draft: m.draft.source.bodyName };
  });
  assert.equal(new Set(duplicate.ids).size, 2); assert.deepEqual(duplicate.targets, ['Moon', 'Sun']); assert.equal(duplicate.draft, 'Mars');

  // Real mouse/touch input must be consumed before body/event handlers and App's Surface pick path.
  const surfacePixel = await page.evaluate(async () => {
    const m = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    m.startMeasurementPick('source', 'surface');
    const r = window.renderer;
    window.sceneEvents = 0;
    r.events.on('body:click', () => window.sceneEvents++);
    r.events.on('event:click', () => window.sceneEvents++);
    const p = r.bodyMeshes.get('Earth').position.clone().project(r.camera);
    return { x: (p.x + 1) * 720, y: (1 - p.y) * 500 };
  });
  await page.mouse.click(surfacePixel.x, surfacePixel.y);
  const surfacePick = await page.evaluate(async () => {
    const { measurements: m } = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    return { kind: m.draft.source.kind, pending: m.pendingPickSlot, events: window.sceneEvents, panel: document.body.innerText.includes('Surface pick') };
  });
  assert.deepEqual(surfacePick, { kind: 'body-fixed', pending: null, events: 0, panel: false });
  const labelPixel = await page.evaluate(async () => {
    const m = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    m.startMeasurementPick('target', 'object');
    const r = window.renderer;
    r.renderFrame();
    const label = r.labelManager.getScreenRects().find(rect => rect.name === 'Earth');
    if (!label) throw new Error('Earth label not visible');
    return { x: (label.x0 + label.x1) / 2, y: (label.y0 + label.y1) / 2 };
  });
  await page.touchscreen.tap(labelPixel.x, labelPixel.y);
  const objectPick = await page.evaluate(async () => {
    const { measurements: m } = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    return { endpoint: m.draft.target, pending: m.pendingPickSlot, events: window.sceneEvents, panel: document.body.innerText.includes('Surface pick') };
  });
  assert.deepEqual(objectPick, { endpoint: { kind: 'entity', bodyName: 'Earth' }, pending: null, events: 0, panel: false });

  // One shared selection, with no camera/time or draft changes. Cards precede strokes.
  await page.evaluate(async () => {
    const m = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    m.selectMeasurement(null);
    window.renderer.renderFrame();
  });
  await page.waitForTimeout(300);
  const card = page.locator('.cosmolabe-event-callout[data-measurement-id="edit-test"]');
  await card.click();
  const selected = await page.evaluate(async () => {
    const { measurements: m } = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    return { id: m.selectedId, draft: m.draft.source.kind };
  });
  assert.deepEqual(selected, { id: 'edit-test', draft: 'body-fixed' });
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(async () => (await import(window.measurementModules['spatial-measurements.svelte.ts'])).measurements.selectedId), null);
  const geometryPixel = await page.evaluate(() => {
    const r = window.renderer, layer = r.spatialRelationships;
    r.renderFrame();
    window.selectionSnapshot = { camera: r.camera.position.toArray(), et: r.timeController.et };
    const blockers = [...document.querySelectorAll('[data-scene-occluder], .cosmolabe-event-callout[data-measurement-id]')].filter(n => n.style.display !== 'none').map(n => n.getBoundingClientRect());
    for (const visual of layer.visuals.values()) for (let i = 0; i < visual.hitSegments.length; i += 2) for (const t of [0.25, 0.5, 0.75]) {
      const p = visual.hitSegments[i].clone().lerp(visual.hitSegments[i + 1], t).project(r.camera);
      const x = (p.x + 1) * 720, y = (1 - p.y) * 500;
      if (x < 40 || x > 1400 || y < 40 || y > 930 || blockers.some(b => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)) continue;
      const id = layer.pick(x, y);
      if (id) return { x, y, id };
    }
    throw new Error('No unobscured measurement geometry to test');
  });
  await page.mouse.move(geometryPixel.x, geometryPixel.y);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(async () => (await import(window.measurementModules['spatial-measurements.svelte.ts'])).measurements.hoveredId), geometryPixel.id);
  await page.mouse.click(geometryPixel.x, geometryPixel.y);
  const geometrySelection = await page.evaluate(async () => {
    const { measurements: m } = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    return { id: m.selectedId, camera: window.renderer.camera.position.toArray(), et: window.renderer.timeController.et, before: window.selectionSnapshot, events: window.sceneEvents };
  });
  assert.equal(geometrySelection.id, geometryPixel.id); assert.deepEqual(geometrySelection.camera, geometrySelection.before.camera); assert.equal(geometrySelection.et, geometrySelection.before.et); assert.equal(geometrySelection.events, 0);
  await page.touchscreen.tap(geometryPixel.x, geometryPixel.y);
  assert.equal(await page.evaluate(async () => (await import(window.measurementModules['spatial-measurements.svelte.ts'])).measurements.selectedId), null);
  console.log('Editing, duplication, surface mouse picking, object-label touch picking, shared card/geometry selection and hover passed');
}
