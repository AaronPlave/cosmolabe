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

  await page.evaluate(async () => {
    window.m = await import(window.measurementModules['spatial-measurements.svelte.ts']);
    window.sh = await import(window.measurementModules['shell.svelte.ts']);
    window.ld = await import(window.measurementModules['loader.ts']);
  });
  await page.getByRole('button', { name: 'Measurements', exact: true }).click();
  await page.getByLabel('Source entity', { exact: true }).selectOption('Earth');
  await page.getByLabel('Target entity', { exact: true }).selectOption('Moon');
  await page.getByRole('button', { name: 'Add distance', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).count(), 0);
  await page.evaluate(() => { window.firstId = window.m.measurements.items[0].id; window.renderer.stop(); window.__cosmolabe.capture('Lunar Orbit'); });
  await page.getByRole('button', { name: 'Sage measurement color', exact: true }).click();
  assert.equal(await page.evaluate(() => window.m.measurements.items[0].color), '#9ab58d');
  await page.getByLabel('Target entity', { exact: true }).selectOption('');
  await page.getByText('Incomplete endpoints', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => { window.renderer.renderFrame(); return window.renderer.spatialRelationships.visuals.has(window.firstId); }), false);
  assert.equal(await page.evaluate(() => window.m.measurements.items[0].target), null);
  await page.getByLabel('Target entity', { exact: true }).selectOption('Moon');
  await page.getByRole('button', { name: 'direction', exact: true }).click();
  await page.getByLabel('Show distance', { exact: true }).check();
  await page.getByLabel('Full-length connection', { exact: true }).check();
  assert(await page.evaluate(() => { const item=window.m.measurements.items[0];return item.kind==='direction'&&item.showDistance&&item.fullLength; }));
  await page.getByRole('button', { name: 'New measurement', exact: true }).click();
  await page.getByLabel('Source entity', { exact: true }).selectOption('Sun');
  const row = page.getByRole('button', { name: 'Select direction measurement', exact: true });
  const beforeHeight = (await row.boundingBox()).height;
  await row.click();
  assert.equal((await row.boundingBox()).height, beforeHeight);
  assert.equal(await page.getByLabel('Source entity', { exact: true }).inputValue(), 'Earth');
  await page.getByRole('button', { name: 'direction', exact: true }).focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByLabel('Source entity', { exact: true }).inputValue(), 'Sun');
  assert.equal(await page.evaluate(() => window.m.measurements.items[0].kind), 'direction');
  await row.click();
  await page.getByRole('button', { name: 'distance', exact: true }).click();
  await page.getByLabel('Custom measurement color', { exact: true }).evaluate(input => { input.value = '#aabbcc'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.evaluate(() => window.m.measurements.items[0].color), '#aabbcc');
  await page.getByRole('button', { name: 'Hide distance', exact: true }).click();
  assert.equal(await page.evaluate(() => { window.renderer.renderFrame(); return window.renderer.spatialRelationships.visuals.get(window.firstId).group.visible; }), false);
  await page.getByRole('button', { name: 'Show distance', exact: true }).click();
  await capture('editor-presets-actual.png');
  const swatch = await page.getByLabel('Custom measurement color', { exact: true }).boundingBox();
  assert(swatch.width >= 36 && swatch.height >= 24);
  const preset = await page.getByRole('button', { name: 'Sage measurement color', exact: true }).boundingBox();
  assert.equal(preset.width,24);assert.equal(preset.height,24);
  console.log('Immediate fields, incomplete definitions, type/options, Escape, stable rows, New and square presets passed');

  // Shared portal closes on action/Escape, contains one menu, and returns focus.
  await page.getByRole('button', { name: 'Actions for distance', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
  await page.getByLabel('Target entity', { exact: true }).selectOption('Sun');
  assert.equal(await page.evaluate(() => new Set(window.m.measurements.items.map(i => i.id)).size), 2);
  assert.deepEqual(await page.evaluate(() => window.m.measurements.items.map(i => i.target.bodyName)), ['Moon', 'Sun']);
  await page.getByRole('button', { name: 'Actions for distance', exact: true }).first().click();
  assert.equal(await page.getByRole('menu').count(), 1);
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('menu').count(), 0);
  assert(await page.getByRole('button', { name: 'Actions for distance', exact: true }).first().evaluate(node => node === document.activeElement));
  await page.getByRole('button', { name: 'New measurement', exact: true }).click();

  // Hover previews use real object and surface semantics, with no standalone pick marker.
  await page.evaluate(() => { window.__cosmolabe.capture('Earth Close'); window.sceneEvents = 0; window.renderer.events.on('body:click', () => window.sceneEvents++); });
  await page.getByRole('button', { name: 'Pick source object', exact: true }).click();
  const earth = await earthPixel();
  await page.mouse.move(earth.x, earth.y); await page.waitForTimeout(180);
  assert.equal(await page.evaluate(() => window.renderer._hoveredBody), 'Earth');
  await page.mouse.move(60, 900); await page.waitForTimeout(180);
  assert.equal(await page.evaluate(() => window.renderer.spatialRelationships.previewEndpoint), null);
  await page.mouse.move(earth.x, earth.y); await page.mouse.click(earth.x, earth.y);
  assert.equal(await page.evaluate(() => window.m.measurements.draft.source.kind), 'entity');
  assert.equal(await page.evaluate(() => window.renderer.spatialRelationships.previewEndpoint), null);
  await page.getByRole('button', { name: 'Pick source surface point', exact: true }).click();
  await page.mouse.move(earth.x + 1, earth.y); await page.waitForTimeout(180);
  assert.equal(await page.evaluate(() => window.renderer.spatialRelationships.previewEndpoint?.kind), 'body-fixed');
  assert((await page.evaluate(() => { window.renderer.renderFrame(); return window.renderer.spatialRelationships.feedback.geometry.drawRange.count; })) > 0);
  const stationary = await page.evaluate(() => {
    const r=window.renderer, layer=r.spatialRelationships;
    const before=JSON.stringify(layer.previewEndpoint);r._lastHoverPickMs=0;
    r.camera.position.x+=0.001;r.cameraController.controls.target.x+=0.001;r.cameraController.controls.update();r.renderFrame();
    return {before,after:JSON.stringify(layer.previewEndpoint)};
  });
  assert.notEqual(stationary.before,stationary.after);
  await capture('surface-pick-preview-actual.png');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.renderer.spatialRelationships.previewEndpoint), null);
  await page.getByRole('button', { name: 'Pick source surface point', exact: true }).click();
  const surfaceEarth=await earthPixel();
  await page.mouse.click(surfaceEarth.x, surfaceEarth.y);
  assert.equal(await page.evaluate(() => window.m.measurements.draft.source.kind), 'body-fixed');
  assert.equal(await page.evaluate(() => window.sceneEvents), 0);
  assert.equal(await page.getByText('Surface pick', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Pick target object', exact: true }).click();
  const label = await page.evaluate(() => { window.renderer.renderFrame(); const r = window.renderer.labelManager.getScreenRects().find(r => r.name === 'Earth'); return { x: (r.x0 + r.x1)/2, y: (r.y0 + r.y1)/2 }; });
  await page.touchscreen.tap(label.x, label.y);
  assert.equal(await page.evaluate(() => window.m.measurements.draft.target.kind), 'entity');
  assert.equal(await page.evaluate(() => window.renderer.spatialRelationships.draftEndpoints.length), 2);
  console.log('Object/surface hover, misses, cancel, mouse picks and touch endpoint confirmation passed');

  // Close/minimize/reopen retain unfinished definitions and cancel active picking.
  await page.getByRole('button', { name: 'Pick target surface point', exact: true }).click();
  await page.getByRole('button', { name: 'Close Measurements', exact: true }).click();
  assert.equal(await page.evaluate(() => window.m.measurements.pendingPickSlot), null);
  await page.getByRole('button', { name: 'Measurements', exact: true }).click();
  assert.equal(await page.evaluate(() => window.m.measurements.draft.source.kind), 'body-fixed');

  // Menus at the bottom of a scrolling panel, then floating and compact layouts.
  await page.evaluate(() => {
    for (let i=0;i<16;i++) window.m.measurements.items.push({ id: `overflow-${i}`, vertex:null, kind:'distance', source:{kind:'entity',bodyName:'Earth'}, target:{kind:'entity',bodyName:'Moon'} });
    window.m.syncMeasurements();
  });
  await page.getByRole('button', { name: 'Actions for distance', exact: true }).last().click();
  await checkMenu(); await capture('menu-scroll-actual.png');
  await page.mouse.click(500, 50); await page.getByRole('menu').waitFor({ state: 'hidden' }); assert.equal(await page.getByRole('menu').count(), 0);
  await page.evaluate(() => window.sh.setFloat('measure', { x: 760, y: 100, w: 360, h: 450 }, { width: innerWidth, height: innerHeight }));
  await page.getByRole('button', { name: 'Actions for distance', exact: true }).last().click();
  await checkMenu(); await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.sh.openTool('measure'));
  await page.getByRole('button', { name: 'Actions for distance', exact: true }).last().click();
  await checkMenu(); await capture('menu-compact-actual.png'); await page.keyboard.press('Escape');
  await page.evaluate(() => window.m.newMeasurement());
  await page.getByRole('button', { name: 'angle', exact: true }).click();
  await page.getByRole('button', { name: 'Pick vertex object', exact: true }).click();
  await page.getByText('Choose the angle’s center · Esc to cancel', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByLabel('Custom measurement color', { exact: true }).scrollIntoViewIfNeeded();
  await capture('presets-compact-actual.png');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.sh.dockPanel('measure'));
  console.log('Portaled menus in scrolling/floating/compact panels, focus, and natural pick instructions passed');

  // Compact labels for several relationships; only the selected one has details.
  await page.evaluate(() => {
    window.m.resetMeasurementsForScene(); window.renderer.stop(); window.__cosmolabe.capture('Lunar Orbit');
    const source={kind:'entity',bodyName:'Earth'},target={kind:'entity',bodyName:'Moon'};
    window.m.addMeasurement({ id:'distance',kind:'distance',source,target });
    window.m.addMeasurement({ id:'direction',kind:'direction',source,target,color:'#9ab58d' });
    window.m.addMeasurement({ id:'angle',kind:'angle',source:{kind:'entity',bodyName:'Sun'},vertex:source,target,color:'#c6a66b' });
    window.m.newMeasurement(); window.renderer.renderFrame();
  });
  await page.waitForTimeout(350);
  assert.equal(await page.locator('.cosmolabe-event-callout[data-measurement-id]:visible').count(), 0);
  assert((await page.locator('.cosmolabe-measurement-value:visible').count()) >= 2);
  assert.equal(await page.locator('.cosmolabe-measurement-value[data-measurement-id=direction]').textContent(), 'To Moon');
  assert.equal(await page.locator('.cosmolabe-measurement-value[data-measurement-id=direction] svg').count(), 1);
  await capture('compact-measurements-wide-actual.png');
  const compactLabel = page.locator('.cosmolabe-measurement-value[data-measurement-id="distance"]');
  await compactLabel.click();
  assert.equal(await page.evaluate(() => window.m.measurements.editingId), 'distance');
  await page.evaluate(() => window.renderer.renderFrame()); await page.waitForTimeout(350);
  assert.equal(await page.locator('.cosmolabe-event-callout[data-measurement-id]:visible').count(), 1);
  assert.equal(await page.locator('.cosmolabe-measurement-value[data-measurement-id="distance"]:visible').count(), 0);
  assert((await page.evaluate(()=>window.renderer.spatialRelationships.visuals.get('direction').stroke.material.opacity))>=0.75);
  const playback = await page.evaluate(async () => {
    const r=window.renderer, m=window.m;
    const before=m.measurements.items.map(i=>m.measurementValue(i,r.timeController.et));
    r.timeController.setRate(86400);r.timeController.play();
    for(let i=0;i<20;i++)await new Promise(requestAnimationFrame);
    r.stop();r.renderFrame();
    return { before, after:m.measurements.items.map(i=>m.measurementValue(i,r.timeController.et)), finite:[...r.spatialRelationships.visuals.values()].every(v=>v.hitSegments.every(p=>p.toArray().every(Number.isFinite))) };
  });
  assert(playback.finite);assert.notEqual(playback.before[0],playback.after[0]);assert.notEqual(playback.before[2],playback.after[2]);
  const openEditor=page.getByRole('button',{name:'Open in Measurements',exact:true});
  await page.getByRole('button',{name:'Close Measurements',exact:true}).click();
  await openEditor.click();
  assert.equal(await page.evaluate(()=>window.m.measurements.selectedId),'distance');
  await page.getByLabel('Source entity',{exact:true}).waitFor();
  await page.evaluate(()=>window.sh.minimizePanel('measure'));
  await openEditor.click();
  assert.equal(await page.evaluate(()=>window.sh.shell.panels.measure.minimized),false);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{window.sh.closeTool('measure');window.renderer.renderFrame();});
  await openEditor.click();
  assert.equal(await page.evaluate(()=>window.sh.shell.activeSheet),'measure');
  assert.equal(await page.evaluate(()=>window.m.measurements.selectedId),'distance');
  await capture('card-editor-compact-actual.png');
  await page.setViewportSize({width:1440,height:1000});
  await capture('selected-measurements-wide-actual.png');
  assert.equal(await page.evaluate(() => window.renderer.spatialRelationships.visuals.get('distance').marks.geometry.drawRange.count), 2);
  await page.getByRole('button', { name:'New measurement',exact:true }).click();
  await page.evaluate(() => window.renderer.renderFrame());
  assert.equal(await page.evaluate(() => window.renderer.spatialRelationships.visuals.get('distance').marks.geometry.drawRange.count), 0);
  console.log('Compact labels, one selected detail, live playback and single distance endpoint treatments passed');

  await checkSpacecraftPass();
  assert.deepEqual(errors, []);
  console.log('All browser measurement checks passed');
} finally { await browser.close(); }

async function capture(name) {
  await page.evaluate(() => window.renderer.renderFrame());
  await page.waitForTimeout(650);
  await page.screenshot({ path: new URL(name, out).pathname, timeout: 120000 });
}
async function earthPixel() {
  return page.evaluate(() => {
    const r=window.renderer; r.renderFrame();
    const p=r.bodyMeshes.get('Earth').position.clone().project(r.camera);
    return { x:(p.x+1)*innerWidth/2, y:(1-p.y)*innerHeight/2 };
  });
}
async function checkMenu() {
  const menu=page.getByRole('menu');await menu.waitFor();
  assert.equal(await menu.count(),1);
  const bounds=await menu.boundingBox();const size=page.viewportSize();
  assert(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=size.width&&bounds.y+bounds.height<=size.height);
  assert.equal(await menu.evaluate(node=>node.closest('[data-scene-occluder]')!==null),false);
}
async function checkSpacecraftPass() {
  // Local CK fixtures cover SOI, not the later dated mission viewpoints.
  // Keep the actual catalog, bodies, model and covered viewpoints for this check.
  await page.route('**/test-catalogs/cassini-soi.json', async route => {
    const response = await route.fetch();
    const catalog = await response.json();
    catalog.spiceKernels = catalog.spiceKernels.filter(kernel => typeof kernel === 'string' && !kernel.endsWith('.gz'));
    catalog.spiceKernels.push('kernels/cassini/040629AP_SCPSE_04179_04185.bsp');
    catalog.items = catalog.items.filter(item => item.type !== 'Viewpoint' || !item.time || item.time.startsWith('2004-07-01'));
    await route.fulfill({ response, json: catalog });
  });
  await page.evaluate(async()=>{
    await window.ld.loadDemo(document.querySelector('canvas'),'test-catalogs/cassini-soi');
    await window.__cosmolabe.whenAssetsReady();
    const r=window.renderer;r.stop();r.setSensorsVisible(false);r.setSensorLabelsVisible(false);window.sh.openTool('measure');
    const source={kind:'entity',bodyName:'Cassini'};
    window.m.addMeasurement({id:'cassini-direction',kind:'direction',source,target:{kind:'entity',bodyName:'Saturn'},color:'#9ab58d'});
    window.m.addMeasurement({id:'cassini-direction-2',kind:'direction',source,target:{kind:'entity',bodyName:'Titan'},color:'#c6a66b'});
    window.m.addMeasurement({id:'cassini-direction-3',kind:'direction',source,target:{kind:'entity',bodyName:'Sun'},color:'#b493ad'});
    window.m.newMeasurement();window.__cosmolabe.capture('Track Cassini');
    // Move close enough for the actual spacecraft mesh to occupy a substantial area.
    const center=r.bodyMeshes.get('Cassini').position;
    r.camera.position.sub(center).normalize().multiplyScalar(0.000000025).add(center);
    r.cameraController.controls.target.copy(center);r.cameraController.controls.update();r.camera.updateMatrixWorld();
  });
  const passes=await page.evaluate(()=>{
    const r=window.renderer, calls=[];
    const render=r.renderer.render.bind(r.renderer);
    r.renderer.render=(scene,camera)=>{ calls.push({scene:scene===r.spatialScene?'measurements':scene===r.scene?'main':'other',layers:camera.layers.mask});return render(scene,camera); };
    r.renderFrame();r.renderer.render=render;
    return { calls, modelVisible:r.bodyMeshes.get('Cassini').isModelVisible, mainContains:r.scene.getObjectById(r.spatialRelationships.root.id)!==undefined };
  });
  assert(passes.modelVisible);assert.equal(passes.mainContains,false);
  assert(await page.evaluate(() => [...window.renderer.spatialRelationships.visuals.values()].every(v => v.group.visible)));
  assert.equal(await page.getByText('Unavailable at current time', { exact: true }).count(), 0);
  const modelIndex=passes.calls.findIndex(c=>c.scene==='main'&&c.layers===2);
  const annotationIndex=passes.calls.findIndex(c=>c.scene==='measurements');
  assert(modelIndex>=0&&annotationIndex>modelIndex);
  await capture('cassini-compact-arrows-actual.png');
  await page.getByRole('button',{name:'Select direction measurement',exact:true}).first().click();
  await capture('cassini-selected-arrow-actual.png');
  console.log('Actual close-up spacecraft model and dedicated measurement pass order passed',JSON.stringify(passes));
}
