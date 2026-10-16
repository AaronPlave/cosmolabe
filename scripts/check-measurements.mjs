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
page.setDefaultTimeout(20000);
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
  await page.getByRole('button', { name: 'Geometry', exact: true }).click();
  await page.getByLabel('Source entity', { exact: true }).selectOption('Earth');
  await page.getByLabel('Target entity', { exact: true }).selectOption('Moon');
  await page.getByRole('button', { name: 'Add distance', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).count(), 0);
  await page.evaluate(() => { window.firstId = window.m.measurements.items[0].id; window.renderer.stop(); window.__cosmolabe.capture('Lunar Orbit'); });
  await page.getByRole('button', { name: 'Sage geometry color', exact: true }).click();
  assert.equal(await page.evaluate(() => window.m.measurements.items[0].color), '#9ab58d');
  await page.getByLabel('Target entity', { exact: true }).selectOption('');
  await page.getByText('Incomplete endpoints', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => { window.renderer.renderFrame(); return window.renderer.spatialRelationships.visuals.has(window.firstId); }), false);
  assert.equal(await page.evaluate(() => window.m.measurements.items[0].target), null);
  await page.getByLabel('Target entity', { exact: true }).selectOption('Moon');
  await chooseType('direction');
  await page.getByRole('checkbox', { name:'Show distance', exact: true }).check();
  await page.getByLabel('Full-length connection', { exact: true }).check();
  assert(await page.evaluate(() => { const item=window.m.measurements.items[0];return item.kind==='direction'&&item.showDistance&&item.fullLength; }));
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Source entity', { exact: true }).selectOption('Sun');
  const row = page.getByRole('button', { name: 'Select direction geometry', exact: true });
  const beforeHeight = (await row.boundingBox()).height;
  await row.click();
  assert.equal((await row.boundingBox()).height, beforeHeight);
  assert.equal(await page.getByLabel('Source entity', { exact: true }).inputValue(), 'Earth');
  await page.getByLabel('Geometry type', { exact: true }).focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByLabel('Source entity', { exact: true }).inputValue(), 'Sun');
  assert.equal(await page.evaluate(() => window.m.measurements.items[0].kind), 'direction');
  await row.click();
  await chooseType('distance');
  await page.getByLabel('Custom geometry color', { exact: true }).evaluate(input => { input.value = '#aabbcc'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.evaluate(() => window.m.measurements.items[0].color), '#aabbcc');
  await page.getByRole('button', { name: 'Hide distance', exact: true }).click();
  assert.equal(await page.evaluate(() => { window.renderer.renderFrame(); return window.renderer.spatialRelationships.visuals.get(window.firstId).group.visible; }), false);
  await page.getByRole('button', { name: 'Show distance', exact: true }).click();
  await capture('editor-presets-actual.png');
  const swatch = await page.getByLabel('Custom geometry color', { exact: true }).boundingBox();
  assert.equal(swatch.width,36);assert.equal(swatch.height,24);
  const preset = await page.getByRole('button', { name: 'Sage geometry color', exact: true }).boundingBox();
  assert.equal(preset.width,24);assert.equal(preset.height,24);
  assert.equal(await page.getByText('Selected measurement', { exact:true }).count(), 0);
  assert.equal(await page.getByText('New measurement', { exact:true }).count(), 0);
  assert.equal(await page.getByLabel('Custom geometry color', { exact:true }).evaluate(el=>getComputedStyle(el).padding), '0px');
  assert.equal(await page.getByRole('button', {name:'Pick source object',exact:true}).evaluate(el=>getComputedStyle(el).cursor),'pointer');
  await chooseType('distance');
  const typeSelect = page.getByLabel('Geometry type', { exact: true });
  assert.equal((await typeSelect.textContent()).trim(), 'Distance');
  // Keyboard: open the type list, move to the next type, choose it.
  await typeSelect.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: /^Distance/ }).waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.getByRole('listbox').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(()=>window.m.measurements.items[0].kind),'angle');
  await page.getByLabel('At entity',{exact:true}).selectOption('Sun');
  await chooseType('distance');
  await chooseType('angle');
  assert.equal(await page.getByLabel('At entity',{exact:true}).inputValue(),'Sun');
  await chooseType('distance');
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
  await page.getByRole('button', { name: 'New', exact: true }).click();

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
  // Orbit drags, including one returning to its starting pixel, must not
  // commit the pending point. The next deliberate click still selects it.
  for (const returnToStart of [false, true]) {
    await page.mouse.move(earth.x, earth.y);
    await page.mouse.down();
    await page.mouse.move(earth.x + 40, earth.y + 20, { steps: 5 });
    if (returnToStart) await page.mouse.move(earth.x, earth.y, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.m.measurements.pendingPickSlot), 'source');
    assert.equal(await page.evaluate(() => window.m.measurements.draft.source.kind), 'entity');
    await page.evaluate(() => window.__cosmolabe.capture('Earth Close'));
  }
  await page.mouse.move(earth.x + 1, earth.y);
  await page.evaluate(() => window.renderer.renderFrame());
  assert.equal(await page.evaluate(() => window.renderer._probe.hovered?.bodyName), 'Earth');
  assert.equal(await page.evaluate(() => window.renderer.renderer.domElement.style.cursor), 'none');
  assert.equal(await page.evaluate(() => window.renderer._probe.reticle.visible), true);
  const stationary = await page.evaluate(() => {
    const r=window.renderer;
    const before=JSON.stringify(r._probe.hovered);r._lastHoverPickMs=0;
    r.camera.position.x+=0.001;r.cameraController.controls.target.x+=0.001;r.cameraController.controls.update();r.renderFrame();
    return {before,after:JSON.stringify(r._probe.hovered)};
  });
  assert.notEqual(stationary.before,stationary.after);
  await capture('surface-pick-preview-actual.png');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.renderer._probe.hovered), null);
  assert.equal(await page.evaluate(() => window.renderer.probePin), null);
  assert.equal(await page.evaluate(() => window.renderer.spatialRelationships.previewEndpoint), null);
  await page.getByRole('button', { name: 'Pick source surface point', exact: true }).click();
  const surfaceEarth=await earthPixel();
  await page.mouse.click(surfaceEarth.x, surfaceEarth.y);
  assert.equal(await page.evaluate(() => window.m.measurements.draft.source.kind), 'surface-point');
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
  await page.getByRole('button', { name: 'Close Reference Geometry', exact: true }).click();
  assert.equal(await page.evaluate(() => window.m.measurements.pendingPickSlot), null);
  await page.getByRole('button', { name: 'Geometry', exact: true }).click();
  assert.equal(await page.evaluate(() => window.m.measurements.draft.source.kind), 'surface-point');

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
  await chooseType('angle');
  await page.getByRole('button', { name: 'Pick vertex object', exact: true }).click();
  await page.getByText('Choose the angle’s center · Esc to cancel', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByLabel('Custom geometry color', { exact: true }).scrollIntoViewIfNeeded();
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
  for (const id of ['distance','angle','direction']) {
    const label=page.locator(`.cosmolabe-measurement-value[data-measurement-id="${id}"]`);
    const before=await label.evaluate(el=>({text:el.textContent,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));
    await label.hover();await page.evaluate(()=>window.renderer.renderFrame());
    assert.equal(await label.getAttribute('data-hovered'),'true');
    assert.deepEqual(await label.evaluate(el=>({text:el.textContent,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})),before);
    await label.focus();await page.evaluate(()=>window.renderer.renderFrame());
    assert.equal(await page.evaluate(()=>window.m.measurements.hoveredId),id);
    const panelRow=page.locator(`[data-measurement-row="${id}"]`);
    assert(await panelRow.evaluate(el=>el.parentElement.classList.contains('hovered')));
    await panelRow.hover();await page.evaluate(()=>window.renderer.renderFrame());
    assert.equal(await label.textContent(),before.text);
  }
  assert.equal(await page.locator('.cosmolabe-measurement-value[data-measurement-id=direction] svg.lucide-crosshair').count(),1);
  console.log('All compact labels retain complete text and size across scene/list hover and focus');
  const edgeLabel=await page.evaluate(async()=>{
    const layer=window.renderer.spatialRelationships, visual=layer.visuals.get('distance');
    let reads=0;
    for(const key of ['offsetWidth','offsetHeight']) {
      const getter=Object.getOwnPropertyDescriptor(HTMLElement.prototype,key).get;
      Object.defineProperty(visual.label,key,{configurable:true,get(){reads++;return getter.call(this);}});
    }
    const text='149,597,870 km', obstacles={rects:[],path:[],discs:[]};
    layer.placeCompactLabel(visual,{x:383,y:200},text,'#82aabd',obstacles,390,844,[],[]);
    await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
    for(let i=0;i<120;i++)layer.placeCompactLabel(visual,{x:383,y:200},text,'#82aabd',obstacles,390,844,[],[]);
    const box=visual.label.getBoundingClientRect();
    const result={text:visual.label.textContent,contained:box.left>=6&&box.right<=384,unclipped:visual.labelValue.scrollWidth<=visual.labelValue.clientWidth+1,reads};
    for(const key of ['offsetWidth','offsetHeight'])delete visual.label[key];
    window.renderer.renderFrame();return result;
  });
  assert.equal(edgeLabel.text,'149,597,870 km');assert(edgeLabel.contained&&edgeLabel.unclipped);assert.equal(edgeLabel.reads,0);
  console.log('Viewport-edge numeric label retains its unit and cached dimensions without per-frame layout reads');

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
  const openEditor=page.getByRole('button',{name:'Open in Reference Geometry',exact:true});
  await page.getByRole('button',{name:'Close Reference Geometry',exact:true}).click();
  await openEditor.click();
  assert.equal(await page.evaluate(()=>window.m.measurements.selectedId),'distance');
  await page.getByLabel('Source entity',{exact:true}).waitFor();
  await page.evaluate(()=>window.sh.minimizePanel('measure'));
  await openEditor.click();
  assert.equal(await page.evaluate(()=>window.sh.shell.panels.measure.minimized),false);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{window.sh.closeTool('measure');window.renderer.renderFrame();});
  // The render loop is stopped, and the closing sheet still occludes the card for a
  // moment; render until a frame places it, as the running loop would.
  await page.waitForFunction(()=>{window.renderer.renderFrame();return document.querySelector('.cosmolabe-event-callout[data-measurement-id="distance"]')?.style.display==='block';});
  await openEditor.click();
  assert.equal(await page.evaluate(()=>window.sh.shell.activeSheet),'measure');
  assert.equal(await page.evaluate(()=>window.m.measurements.selectedId),'distance');
  await capture('card-editor-compact-actual.png');
  await page.setViewportSize({width:1440,height:1000});
  await capture('selected-measurements-wide-actual.png');
  assert.equal(await page.evaluate(() => window.renderer.spatialRelationships.visuals.get('distance').marks.geometry.drawRange.count), 2);
  await page.getByRole('button', { name:'New',exact:true }).click();
  await page.evaluate(() => window.renderer.renderFrame());
  assert.equal(await page.evaluate(() => window.renderer.spatialRelationships.visuals.get('distance').marks.geometry.drawRange.count), 0);
  await page.evaluate(()=>{window.m.selectMeasurement('distance');window.renderer.renderFrame();});
  await page.waitForTimeout(350);
  const snapshot=await page.evaluate(()=>({time:window.renderer.timeController.et,position:window.renderer.camera.position.toArray(),count:window.m.measurements.items.length,color:window.m.measurements.items[0].color}));
  const clear=page.getByRole('button',{name:'Clear measurement selection',exact:true});
  await clear.focus();await page.keyboard.press('Enter');await page.evaluate(()=>window.renderer.renderFrame());
  assert.equal(await page.evaluate(()=>window.m.measurements.selectedId),null);
  assert.deepEqual(await page.evaluate(()=>({time:window.renderer.timeController.et,position:window.renderer.camera.position.toArray(),count:window.m.measurements.items.length,color:window.m.measurements.items[0].color})),snapshot);
  assert.equal(await page.locator('.cosmolabe-event-callout[data-measurement-id]:visible').count(),0);
  assert.equal(await compactLabel.isVisible(),true);
  await page.waitForFunction(()=>document.activeElement.matches('.cosmolabe-measurement-value,[data-measurement-row]'),null,{timeout:5000});
  await checkSharedMeasurements();
  console.log('Compact labels, one selected detail, live playback and single distance endpoint treatments passed');

  await checkSpacecraftPass();
  assert.deepEqual(errors, []);
  console.log('All browser measurement checks passed');
} finally { await browser.close(); }

/** Choose a geometry type from the full-width type select. */
async function chooseType(type) {
  await page.getByLabel('Geometry type', { exact: true }).click();
  await page.getByRole('option', { name: new RegExp(`^${type}`, 'i') }).click();
  await page.getByRole('listbox').waitFor({ state: 'detached' });
}

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
  await page.getByRole('button',{name:'Select direction geometry',exact:true}).first().click();
  await capture('cassini-selected-arrow-actual.png');
  console.log('Actual close-up spacecraft model and dedicated measurement pass order passed',JSON.stringify(passes));
}

async function checkSharedMeasurements() {
  const shared=await page.evaluate(async()=>{
    window.m.measurements.items[0].source={kind:'body-fixed',bodyName:'Earth',positionKm:[6378.137,0.123456789,0]};
    window.m.measurements.items[0].visible=false;window.m.measurements.items[0].color='#abcdef';
    window.m.selectMeasurement('direction');window.m.measurements.draftShowDistance=true;window.m.measurements.draftFullLength=true;window.m.syncMeasurements();
    const resource=file=>performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/'+file)).name;
    const link=await import(resource('view-link.ts')), urls=await import(resource('view-state-url.ts'));
    const state=link.captureViewState(), url=urls.viewLink(state,location.href);
    return {url,measurements:state.measurements};
  });
  const restored=await browser.newPage({viewport:{width:1440,height:1000}});
  try {
    await restored.goto(shared.url,{waitUntil:'domcontentloaded',timeout:120000});
    await restored.waitForFunction(()=>['viewer-state.svelte.ts','spatial-measurements.svelte.ts'].every(file=>performance.getEntriesByType('resource').some(e=>new URL(e.name).pathname.endsWith('/'+file))),null,{timeout:120000});
    await restored.evaluate(async()=>{
      const resource=file=>performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/'+file)).name;
      window.vstate=await import(resource('viewer-state.svelte.ts'));
      window.m=await import(resource('spatial-measurements.svelte.ts'));
    });
    await restored.waitForFunction(()=>window.vstate.vs.assetsReady&&!window.vstate.vs.showLoading&&window.m.measurements.items.length===3&&window.m.measurements.selectedId==='direction',null,{timeout:120000});
    assert.deepEqual(await restored.evaluate(async()=>{
      const file=performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/view-link.ts'));
      const link=await import(file.name);return link.captureViewState().measurements;
    }),shared.measurements);
    await restored.getByRole('button',{name:'Geometry',exact:true}).click();
    await restored.getByRole('checkbox', { name:'Show distance',exact:true}).waitFor();
    assert.equal(await restored.getByRole('checkbox', { name:'Show distance',exact:true}).isChecked(),true);
    assert.equal(await restored.getByLabel('Full-length connection',{exact:true}).isChecked(),true);
    await restored.screenshot({path:new URL('shared-measurements-restored-actual.png',out).pathname,timeout:120000});
  } finally {await restored.close();}
  console.log('Shared URL survives a fresh catalog load with exact surfaces, colors, hidden items, direction options and selection');
}
