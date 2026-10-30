/** Shackleton oblique readability plus the real desktop/compact grid controls.
 * GRID_OUTPUT=/tmp/grid-readability node scripts/graticule-readability-validation.mjs
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const out = resolve(process.env.GRID_OUTPUT ?? '/tmp/grid-readability');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: process.platform === 'darwin' ? 'chrome' : undefined, headless: true,
  args: process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
await page.addInitScript(() => { window.gridImport = path => import(performance.getEntriesByType('resource').map(e => e.name)
  .filter(url => new URL(url).pathname === path).at(-1) ?? path); });
const report = { passed: false, errors: [], views: [], controls: [] };
page.on('pageerror', error => report.errors.push(error.message));
page.on('console', message => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(message.text())) report.errors.push(message.text()); });
try {
  await page.goto(`${process.env.GRID_VIEWER_URL ?? 'http://127.0.0.1:5188'}/?catalog=test-catalogs/moonfall-shackleton&test=1`);
  await page.waitForFunction(() => window.renderer?.getBodyMesh('Moon') && window.__cosmolabe?.assetsReady, undefined, { timeout: 60000 });
  for (const pose of (process.env.GRID_CONTROLS_ONLY === '1' ? [] : ['overview', 'oblique'])) {
    await page.evaluate(async ({ pose, coreUrl }) => {
      const state = await window.gridImport('/src/lib/viewer-state.svelte.ts'), r = window.renderer, c = window.cosmo, bm = r.getBodyMesh('Moon');
      if (state.getRenderer() !== r) throw new Error('Different viewer session');
      c.setPlaying(false); c.setLayer('grid', true); c.setGridScope('bodies', 'Moon'); c.setGridLabels(true); c.setGridDensity('auto'); c.setGridCoordinateFrame(false); c.setGridOpacity(1);
      state.applyViewpoint('Shackleton Overview', { animate: false });
      if (pose === 'oblique') {
        const core = await import(coreUrl), V = r.camera.position.constructor, q = bm.bodyToWorldQuaternion(r.camera.quaternion.clone());
        const lat = -89.67, lon = 129.78, h = bm.sampleResidentTerrain(lat, lon)?.elevationKm ?? 0;
        const point = (latitude, height) => { const p = core.surfacePositionToBodyFixed({ latDeg: latitude, lonDeg: lon, heightKm: height }, bm.surfaceCoordinates);
          return new V(p.xKm,p.yKm,p.zKm).applyQuaternion(q).multiplyScalar(r.scaleFactor).add(bm.position); };
        const target = point(lat,h), up = point(lat,h+1).sub(target).normalize(), north = point(lat+.01,h).sub(target).normalize();
        r.cameraController.controls.enableDamping = false;
        r.camera.position.copy(target).addScaledVector(up,8*r.scaleFactor).addScaledVector(north,15*r.scaleFactor);
        r.camera.up.copy(up); r.cameraController.controls.target.copy(target); r.camera.lookAt(target); r.camera.updateMatrixWorld(true);
      }
    }, { pose, coreUrl: `/@fs/${process.cwd()}/packages/core/dist/index.js` });
    await page.waitForTimeout(3000);
    const view = await page.evaluate(async () => {
      const r = window.renderer, bm = r.getBodyMesh('Moon'), samples = [], ids = new Set();
      for (let i=0;i<60;i++) { await new Promise(requestAnimationFrame); const m=bm.gridMetrics;
        samples.push({ count:m.labels, axes:new Set(m.annotations.map(a=>a.axis)).size });
        for(const a of m.annotations) ids.add(a.id);
      }
      const grid=bm.graticule, positions=bm.gridMetrics.annotations.map(a=>{ const s=grid.labels.get(a.id).sprite, p=s.getWorldPosition(r.camera.position.clone()).project(r.camera);
        return { ...a, x:(p.x+1)*innerWidth/2, y:(1-p.y)*innerHeight/2 }; });
      const gl=r.renderer.getContext(), ext=gl.getExtension('WEBGL_debug_renderer_info');
      return { frame:bm.bodyFixedFrame, available:bm.attitudeAvailable, minLabels:Math.min(...samples.map(s=>s.count)),
        bothAxesFrames:samples.filter(s=>s.axes===2).length, distinctSites:ids.size, annotations:positions,
        visibleTiles:bm.terrainManager.tiles.visibleTiles.size, gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null };
    });
    report.views.push({pose,...view}); console.log(pose,JSON.stringify(view));
    assert.ok(view.minLabels>0); assert.ok(view.bothAxesFrames>0,`Missing coordinate axis in ${pose}`);
    await page.screenshot({ path:`${out}/shackleton-${pose}.png` });
  }
  await page.evaluate(async()=>{ const c=window.cosmo; c.setPlaying(false); c.setLayer('grid',true); c.setGridScope('bodies','Moon'); c.setGridLabels(true); c.setGridDensity('auto'); c.setGridOpacity(1); const state=await window.gridImport('/src/lib/viewer-state.svelte.ts'); state.applyViewpoint('Shackleton Overview',{animate:false}); const shell=await window.gridImport('/src/lib/shell.svelte.ts'); shell.openTool('display'); });
  await page.waitForFunction(()=>{ const tm=window.renderer.getBodyMesh('Moon').terrainManager, n=tm.metrics.network;
    return tm.tiles.visibleTiles.size>0 && n.queued+n.downloading+n.parsing===0 && tm.cubeImageryStats?.ready && tm.cubeImageryStats.inFlight===0;
  },undefined,{timeout:60000});
  // Read pixels with captions disabled: uniform values alone cannot establish
  // that streamed terrain materials retained their grid hook after restoration.
  const pixels = async opacity => {
    await page.evaluate(value=>{window.cosmo.setGridLabels(false);window.cosmo.setGridOpacity(value);},opacity);
    await page.waitForTimeout(250);
    return sharp(await page.screenshot()).removeAlpha().raw().toBuffer({resolveWithObject:true});
  };
  const off=await pixels(0), full=await pixels(1), half=await pixels(.4);
  const quadrants=[0,0,0,0];let fullDifference=0,halfDifference=0;
  for(let y=40;y<900;y++)for(let x=60;x<1000;x++){
    const i=(y*full.info.width+x)*3;
    const delta=Math.abs(full.data[i]-off.data[i])+Math.abs(full.data[i+1]-off.data[i+1])+Math.abs(full.data[i+2]-off.data[i+2]);
    fullDifference+=delta;
    halfDifference+=Math.abs(half.data[i]-off.data[i])+Math.abs(half.data[i+1]-off.data[i+1])+Math.abs(half.data[i+2]-off.data[i+2]);
    if(delta>8)quadrants[(x>=530?1:0)+(y>=470?2:0)]++;
  }
  assert.ok(quadrants.every(n=>n>100),`Missing restored grid pixels: ${quadrants}`);
  assert.ok(halfDifference>fullDifference*.05&&halfDifference<fullDifference*.9,'Grid pixels did not fade');
  report.pixelReadback={quadrants,fullDifference,halfDifference};
  await page.evaluate(()=>{window.cosmo.setGridLabels(true);window.cosmo.setGridOpacity(1);});
  const opacity = page.getByRole('slider',{name:'Grid opacity',exact:true});
  await opacity.scrollIntoViewIfNeeded(); await opacity.focus(); await opacity.press('Home');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.renderer.gridSettings.opacity),0);
  assert.equal(await page.evaluate(()=>window.renderer.getBodyMesh('Moon').gridMetrics.labels),0);
  await opacity.press('End');
  await opacity.click({position:{x:(await opacity.boundingBox()).width*.4,y:7}});
  await page.waitForTimeout(300);
  const selectedOpacity = await page.evaluate(()=>window.renderer.gridSettings.opacity);
  assert.ok(selectedOpacity>.3&&selectedOpacity<.5);
  const border=page.getByRole('checkbox',{name:'Labels at viewport border',exact:true});
  await border.check(); await page.waitForTimeout(1200);
  const frame = await page.evaluate(()=>{ const b=window.renderer.getBodyMesh('Moon'), g=b.graticule; return {
    opacity:window.renderer.gridSettings.opacity, materialGroups:(()=>{const groups={};b.terrainManager.group.traverseVisible(o=>{if(!o.isMesh||!o.visible)return;for(const m of (Array.isArray(o.material)?o.material:[o.material])){const u=window.renderer.renderer.properties.get(m).uniforms;const key=JSON.stringify([m.userData.graticule,u?.uGridVisible?.value,u?.uGridOpacity?.value]);groups[key]=(groups[key]??0)+1;}});return groups;})(), captionOpacities:g.frame.elements.filter(e=>e.sprite.visible).map(e=>e.sprite.material.opacity),
    uniform:g.uniforms.uGridOpacity.value, layout:b.gridMetrics.layout }; });
  assert.ok(Object.keys(frame.materialGroups).every(key=>{const values=JSON.parse(key);return values[0]===true&&values[2]===selectedOpacity;}),'A drawn terrain material lost its grid uniforms');
  assert.equal(frame.layout,'frame'); assert.ok(frame.captionOpacities.length>0); assert.ok(frame.captionOpacities.every(a=>a===selectedOpacity));
  report.controls.push({desktop:frame}); await page.screenshot({path:`${out}/desktop-opacity.png`});
  // Preferences survive reload; scripted changes and snapshot restore do not replace them.
  await page.reload(); await page.waitForFunction(()=>window.__cosmolabe?.assetsReady,undefined,{timeout:60000});
  assert.equal(await page.evaluate(()=>window.renderer.gridSettings.opacity),selectedOpacity);
  const script = await page.evaluate(()=>window.cosmo.snapshot());
  assert.ok(script.includes('setGridOpacity'));
  await page.evaluate(()=>window.cosmo.setGridOpacity(.8));
  await page.evaluate(async ({script,url})=>{ const control=await import(url); await control.execute(control.parse(script),window.cosmo); },
    {script,url:`/@fs/${process.cwd()}/packages/control/dist/index.js`});
  assert.equal(await page.evaluate(()=>window.renderer.gridSettings.opacity),selectedOpacity);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(async()=>{ const shell=await window.gridImport('/src/lib/shell.svelte.ts'); shell.openTool('display'); });
  await opacity.scrollIntoViewIfNeeded();
  const bounds=await opacity.boundingBox(); await page.touchscreen.tap(bounds.x+bounds.width*.6,bounds.y+bounds.height/2);
  await border.uncheck(); await border.check(); await page.waitForTimeout(500);
  const compact=await page.evaluate(()=>({opacity:window.renderer.gridSettings.opacity,border:window.renderer.gridSettings.coordinateFrame,
    overflow:document.documentElement.scrollWidth>innerWidth,scroll:[...document.querySelectorAll('.instrument-body')].filter(e=>e.clientHeight>0)
      .map(e=>({scrollTop:e.scrollTop,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,parentScrollTop:e.closest('.instrument')?.parentElement?.scrollTop??0}))}));
  assert.ok(compact.opacity>.5&&compact.opacity<.7); assert.ok(compact.border); assert.ok(!compact.overflow); assert.ok(compact.scroll.every(s=>s.parentScrollTop===0));
  report.controls.push({compact}); await page.screenshot({path:`${out}/compact-border-labels.png`});
  await opacity.scrollIntoViewIfNeeded(); await page.screenshot({path:`${out}/compact-grid-controls.png`});
  assert.deepEqual(report.errors,[]); report.passed=true;
} finally { await writeFile(`${out}/report.json`,JSON.stringify(report,null,2)+'\n'); await browser.close(); }
