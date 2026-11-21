#!/usr/bin/env node
/** Maintained graticule browser checks against the loaded viewer. See --help. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import sharp from 'sharp';

const { values } = parseArgs({ options: {
  scenario: { type: 'string', multiple: true }, url: { type: 'string' }, output: { type: 'string' },
  dpr: { type: 'string', default: '1' }, catalogs: { type: 'string' }, help: { type: 'boolean' },
} });
const scenarios = { globe, lunar, controls, precision, integration };
if (values.help) {
  console.log('node scripts/graticule-validation.mjs --scenario=globe,lunar,controls,precision,integration|all\n'
    + '  --url=http://127.0.0.1:5188 --output=work/graticule --dpr=1|2\n'
    + '  --catalogs=earth-moon,moonfall-shackleton,ingenuity-jezero,msl-dingo-gap (integration only)\n'
    + 'Default: globe. All scenarios require a running viewer; terrain scenes require their catalog assets.');
  process.exit(0);
}
const selected = (values.scenario ?? ['globe']).flatMap(s => s === 'all' ? Object.keys(scenarios) : s.split(','));
for (const name of selected) assert.ok(Object.hasOwn(scenarios, name), `Unknown scenario: ${name}`);
const dpr = Number(values.dpr); assert.ok(dpr === 1 || dpr === 2, 'DPR must be 1 or 2');
const selectedCatalogs = values.catalogs?.split(',');
const base = values.url ?? process.env.GRID_VIEWER_URL ?? 'http://127.0.0.1:5188';
const out = resolve(values.output ?? process.env.GRID_OUTPUT ?? 'work/graticule');
const coreUrl = `/@fs/${process.cwd()}/packages/core/dist/index.js`;
const controlUrl = `/@fs/${process.cwd()}/packages/control/dist/index.js`;
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH }
    : process.platform === 'darwin' ? { channel: 'chrome' } : {}),
  args: process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : [],
});
const results = { passed: false, dpr, scenarios: {}, errors: [] };
try {
  for (const name of new Set(selected)) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true, deviceScaleFactor: dpr });
    await page.addInitScript(() => {
      performance.setResourceTimingBufferSize(20000);
      // Import the actual loaded Vite module, including its HMR timestamp.
      window.gridImport = path => import(performance.getEntriesByType('resource').map(e => e.name)
        .filter(url => new URL(url).pathname === path).at(-1) ?? path);
    });
    page.on('pageerror', e => results.errors.push(`${name}: ${e.message}`));
    page.on('console', m => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(m.text())) results.errors.push(`${name}: ${m.text()}`); });
    console.log(`Running ${name}`);
    try {
      results.scenarios[name] = await scenarios[name](page);
      results.scenarios[name].gpu = await page.evaluate(() => {
        const gl = window.renderer.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
        return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
      });
    } catch (error) {
      await page.screenshot({ path: `${out}/${name}-failure.png` }).catch(() => {});
      throw error;
    } finally { await page.close(); }
  }
  assert.deepEqual(results.errors, []);
  results.passed = true;
} catch (error) {
  results.errors.push(error.stack ?? String(error)); process.exitCode = 1;
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify(results, null, 2) + '\n');
  await browser.close();
}
console.log(JSON.stringify({ passed: results.passed, scenarios: Object.keys(results.scenarios), output: out, errors: results.errors }));

async function load(page, catalog, body, view) {
  const query = new URLSearchParams({ catalog: `test-catalogs/${catalog}`, test: '1' });
  if (view) query.set('view', JSON.stringify(view));
  await page.goto(`${base}/?${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(body => window.renderer?.getBodyMesh(body) && window.__cosmolabe?.assetsReady, body, { timeout: 120000 });
  await page.evaluate(() => window.renderer.waitForInitialAssets());
}

async function globe(page) {
  const report = { views: [] };
  await load(page, 'earth-moon', 'Earth');
for (const altitude of [30, 12, 5, 2, 12]) {
await page.evaluate(async({altitude,coreUrl})=>{
 const lat = altitude === 2 ? 16.6825 : 16.67, lon = altitude === 2 ? 0.1625 : 0.18;
 const r=window.renderer,bm=r.getBodyMesh('Earth'), c=window.cosmo;
 const state=await import(performance.getEntriesByType('resource').map(e=>e.name).filter(u=>new URL(u).pathname==='/src/lib/viewer-state.svelte.ts').at(-1));
 state.setLighting('flood');c.setPlaying(false);c.untrack();c.select(null);c.setLayer('grid',true);c.setGridScope('bodies','Earth');c.setGridDensity('auto');c.setGridLabels(true);c.setGridCoordinateFrame(false);
 const core=await import(coreUrl), V=r.camera.position.constructor;
 const pt=(lat,lon,h)=>{const p=core.surfacePositionToBodyFixed({latDeg:lat,lonDeg:lon,heightKm:h},bm.surfaceCoordinates);return new V(p.xKm,p.yKm,p.zKm).applyQuaternion(bm.bodyToWorldQuaternion(r.camera.quaternion.clone())).multiplyScalar(r.scaleFactor).add(bm.position);};
 const target=pt(lat,lon,0);r.cameraController.controls.enableDamping=false;r.camera.position.copy(pt(lat,lon,altitude));r.camera.up.copy(pt(lat+.01,lon,0).sub(target).normalize());r.cameraController.controls.target.copy(target);r.camera.lookAt(target);r.camera.updateMatrixWorld(true);
}, { altitude, coreUrl: coreUrl });
await page.waitForTimeout(2000);
const view = await page.evaluate(async coreUrl => {
  const core = await import(coreUrl), r = window.renderer, bm = r.getBodyMesh('Earth'), grid = bm.graticule;
  const V = r.camera.position.constructor, ray = new grid.raycaster.constructor();
  const world = grid.toWorld, errors = [];
  for (const annotation of bm.gridMetrics.annotations) {
    const value = annotation.axis === 'latitude' ? annotation.latDeg : annotation.lonDeg;
    if (Math.abs(parseFloat(annotation.text) - Math.abs(value)) > 1e-6) throw new Error(`Rounded caption ${annotation.text} for ${value}`);
    const p = core.surfacePositionToBodyFixed({ latDeg: annotation.latDeg, lonDeg: annotation.lonDeg }, bm.surfaceCoordinates);
    const q = core.surfacePositionToBodyFixed({ latDeg: annotation.latDeg, lonDeg: annotation.lonDeg, heightKm: 1 }, bm.surfaceCoordinates);
    const base = new V(p.xKm,p.yKm,p.zKm), normal = new V(q.xKm,q.yKm,q.zKm).sub(base).normalize();
    ray.set(base.addScaledVector(normal, 100).applyMatrix4(world), normal.negate().transformDirection(world));
    const hit = ray.intersectObject(bm.mesh)[0];
    if (!hit) throw new Error('Visible tick has no globe triangle');
    const actual = hit.point.project(r.camera), tick = grid.labels.get(annotation.id).sprite.getWorldPosition(new V()).project(r.camera);
    errors.push(Math.hypot((actual.x-tick.x)*innerWidth/2, (actual.y-tick.y)*innerHeight/2));
  }
  const gl = r.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  return { labels: errors.length, maxRegistrationErrorCssPx: Math.max(0,...errors), step: bm.gridMetrics.latitudeStep,
    gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null };
}, coreUrl);
assert.ok(view.labels > 0, `No labels at ${altitude} km`);
assert.ok(view.maxRegistrationErrorCssPx < 0.2, `Globe registration drift at ${altitude} km`);
report.views.push({ altitudeKm: altitude, latitudeDeg: altitude === 2 ? 16.6825 : 16.67, longitudeDeg: altitude === 2 ? 0.1625 : 0.18, ...view });
console.log(JSON.stringify(report.views.at(-1)));
await page.screenshot({ path: `${out}/earth-${altitude}km.png` });
}

// Retain the rendered silhouette regression at either physical DPR. Opacity
// changes isolate surface-line pixels; independent triangle rays certify them.
await page.evaluate(() => {
  const r=window.renderer,b=r.getBodyMesh('Earth'),c=window.cosmo;
  c.setGridLabels(true);c.setGridCoordinateFrame(false);
  const normal=r.camera.position.clone().sub(b.position).normalize();
  r.camera.position.copy(b.position).addScaledVector(normal,b.displayRadius*4*r.scaleFactor);
  r.cameraController.controls.target.copy(b.position);r.camera.lookAt(b.position);r.camera.updateMatrixWorld(true);
});
const pixels=async opacity=>{await page.evaluate(v=>window.cosmo.setGridOpacity(v),opacity);await page.waitForTimeout(400);return sharp(await page.screenshot()).removeAlpha().raw().toBuffer({resolveWithObject:true});};
const off=await pixels(0),on=await pixels(1),changed=[];
for(let y=40*dpr;y<(1000-100)*dpr;y++)for(let x=60*dpr;x<(1440-30)*dpr;x++){
  const i=(y*on.info.width+x)*3;
  if(Math.abs(on.data[i]-off.data[i])+Math.abs(on.data[i+1]-off.data[i+1])+Math.abs(on.data[i+2]-off.data[i+2])>8)changed.push([x,y]);
}
const outside=await page.evaluate(({changed,dpr})=>{
  const r=window.renderer,b=r.getBodyMesh('Earth'),ray=b.graticule.raycaster;
  let outside=0;
  for(const [x,y] of changed){let inside=false;
    for(let dy=-1;dy<=1&&!inside;dy++)for(let dx=-1;dx<=1&&!inside;dx++){
      ray.setFromCamera({x:(x+dx+.5)/dpr/innerWidth*2-1,y:1-(y+dy+.5)/dpr/innerHeight*2},r.camera);
      inside=ray.intersectObject(b.mesh).length>0;
    }
    if(!inside)outside++;
  }
  return outside;
},{changed,dpr});
const visibleLabels=await page.evaluate(()=>window.renderer.getBodyMesh('Earth').gridMetrics.labels);
assert.ok(visibleLabels>0,'No whole-globe captions in silhouette check');
assert.ok(changed.length>0,'No whole-globe grid pixels');assert.equal(outside,0,'Grid pixels escaped the rendered silhouette');
report.silhouette={visibleLabels,changedPixels:changed.length,outsideSilhouettePixels:outside,antialiasAllowancePhysicalPixels:1};
await page.screenshot({path:`${out}/globe-silhouette.png`});

  return report;
}

async function lunar(page) {
  const report = { views: [] };

  for (const [catalog, names] of [
    ['moonfall-shackleton', ['Shackleton Overview', 'PSR Floor View']],
    ['moon-imagery-apollo15', ['Hadley regional', 'Hadley Rille', 'Apollo 15 landing site']],
  ]) {
    await load(page, catalog, 'Moon');
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
        if (catalog === 'moonfall-shackleton' && !coordinateFrame) {
          assert.ok(view.minLabels > 0, `Polar captions missing in ${name}`);
          assert.ok(view.visibleTiles > 0, 'No real Shackleton terrain loaded');
          assert.equal(view.bothSurfaceAxesFrames, 45, `Missing polar ruler axis in ${name}`);
        }
      }
    }
  }

  await load(page, 'moonfall-shackleton', 'Moon');
  for (const pose of ['overview', 'oblique']) {
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
    }, { pose, coreUrl: coreUrl });
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

  return report;
}

async function controls(page) {
  const report = { controls: [] };
  await load(page, 'moonfall-shackleton', 'Moon');
  await page.evaluate(async()=>{ const c=window.cosmo; c.setPlaying(false); c.setLayer('grid',true); c.setGridScope('bodies','Moon'); c.setGridLabels(true); c.setGridDensity('auto'); c.setGridOpacity(1); const state=await window.gridImport('/src/lib/viewer-state.svelte.ts'); state.applyViewpoint('Shackleton Overview',{animate:false}); const shell=await window.gridImport('/src/lib/shell.svelte.ts'); shell.openTool('display'); });
  await page.waitForFunction(()=>{ const tm=window.renderer.getBodyMesh('Moon').terrainManager, n=tm.metrics.network;
    return tm.tiles.visibleTiles.size>0 && n.queued+n.downloading+n.parsing===0 && tm.cubeImageryStats?.ready && tm.cubeImageryStats.inFlight===0;
  },undefined,{timeout:60000});
  // Read pixels with captions disabled: uniform values alone cannot establish
  // that streamed terrain materials retained their grid hook after restoration.
  const pixels = async opacity => {
    await page.evaluate(value=>{window.cosmo.setGridLabels(false);window.cosmo.setGridOpacity(value);},opacity);
    await page.waitForTimeout(250);
    return sharp(await page.screenshot()).resize(1440, 1000).removeAlpha().raw().toBuffer({resolveWithObject:true});
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
    {script,url:controlUrl});
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

  return report;
}

async function precision(page) {
  const report = { captures: [] };
  await page.setViewportSize({ width: 1718, height: 1000 });
const view={version:1,catalog:{catalog:'test-catalogs/ingenuity-jezero'},time:{kind:'fixed',source:'ET',et:678747698.6801088},view:{kind:'pose',version:1,frame:'ECLIPJ2000',origin:'Mars',camera:{position:[3171.7942747424036,-1113.641397423312,-452.71284260603625],target:[546.8073461939653,-2080.0283257269143,-2379.3870179228293],up:[0.9934642213089192,-0.026110669061718154,0.11111738810920814],fov:60}},navigation:{selected:'Mars',tracked:null,lookAt:null,mode:'free-orbit'},playback:{playing:false,rate:1},display:{trajectories:true,labels:true,grid:true,axes:false,sensors:true,sensorLabels:true}};
 await load(page, 'ingenuity-jezero', 'Mars', view);
 await page.waitForFunction(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeStats?.version,undefined,{timeout:120000});
 await page.evaluate(async()=>{await window.renderer.waitForInitialAssets();const t=window.renderer.getBodyMesh('Mars').terrainManager;await t.cube.source.ready;await t.cubeImageryLayer.ready;});
 await page.waitForFunction(()=>{const t=window.renderer.getBodyMesh('Mars').terrainManager,n=t.metrics.network,i=t.cubeImageryStats;return t.tiles.visibleTiles.size>0&&n.queued+n.downloading+n.parsing===0&&t.cubeStats.inFlight===0&&i.inFlight===0&&(i.queued===0||i.budgetLimited);},undefined,{timeout:180000});
 await page.waitForTimeout(1000);
 await page.evaluate(camera=>{const r=window.renderer,b=r.getBodyMesh('Mars'),V=r.camera.position.constructor;r.cameraController.controls.enableDamping=false;r.camera.position.copy(new V(...camera.position).multiplyScalar(r.scaleFactor).add(b.position));r.cameraController.controls.target.copy(new V(...camera.target).multiplyScalar(r.scaleFactor).add(b.position));r.camera.up.set(...camera.up);r.camera.lookAt(r.cameraController.controls.target);r.camera.updateMatrixWorld(true);},view.view.camera);
 await page.waitForTimeout(3000);
 await page.evaluate(()=>{window.cosmo.setPlaying(false);window.cosmo.setGridOpacity(1);window.cosmo.setGridCoordinateFrame(false);});
 await page.waitForTimeout(2000);
 const capture=await page.evaluate(()=>{const r=window.renderer,b=r.getBodyMesh('Mars'),gl=r.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return {gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,metrics:{latitudeStep:b.gridMetrics.latitudeStep,longitudeStep:b.gridMetrics.longitudeStep,labels:b.gridMetrics.labels},network:b.terrainManager.metrics.network,imagery:b.terrainManager.cubeImageryStats,camera:r.camera.position.toArray(),visibleTiles:b.terrainManager?.tiles.visibleTiles.size};});
 report.captures.push(capture);console.log(JSON.stringify(capture));assert.equal(await page.getByText('Couldn’t restore view:',{exact:false}).count(),0);
 assert.ok(capture.visibleTiles>0);assert.ok(capture.metrics.latitudeStep>0);
 await page.screenshot({path:`${out}/mars-close.png`});
 report.gpuPrecision=await page.evaluate(async root=>{
  const shaderUrl=`/@fs/${root}/packages/three/src/GraticuleShader.ts`;
  const source=await(await fetch(shaderUrl)).text();
  const threeUrl=source.match(/import \* as THREE from ["']([^"']+)["']/)[1];
  const THREE=await import(threeUrl), grid=await import(shaderUrl),core=await import(`/@fs/${root}/packages/core/src/index.ts`);
  const gpu=new THREE.WebGLRenderer();gpu.setSize(64,64);const results=[];
  for(const [name,radii,lat,lon] of [['Mars',[3396.19,3396.19,3376.2],18.636,77.448],['Moon',[1737.4,1737.4,1737.4],-89.8,129.78],['Earth',[6378.137,6378.137,6356.752],16.67,179.999]]){
   const coords=core.bodySurfaceCoordinates({name,radii});const uniforms=grid.makeGraticuleUniforms(coords);uniforms.uGridVisible.value=1;uniforms.uGridStep.value.set(.001,.001);
   const point=h=>{const p=core.surfacePositionToBodyFixed({latDeg:lat,lonDeg:lon,heightKm:h},coords);return new THREE.Vector3(p.xKm,p.yKm,p.zKm);};
   const centre=point(0),normal=point(1).sub(centre).normalize();
   const camera=new THREE.PerspectiveCamera(.5,1,.001,1);camera.position.copy(centre).addScaledVector(normal,.1);camera.lookAt(centre);camera.updateMatrixWorld(true);
   const material=new THREE.ShaderMaterial({vertexShader:'void main(){vec3 transformed=position;\n#include <project_vertex>\n}',fragmentShader:'void main(){vec3 outgoingLight=vec3(0.0);\n#include <opaque_fragment>\ngl_FragColor=vec4(outgoingLight,1.0);}' });
   grid.applyGraticuleMaterial(material,uniforms,new THREE.Matrix4());const compile=material.onBeforeCompile.bind(material);
   material.onBeforeCompile=(shader,r)=>{compile(shader,r);shader.fragmentShader=shader.fragmentShader.replace('outgoingLight = mix(outgoingLight, grid.rgb, grid.a * horizon * uGridVisible * uGridOpacity);','outgoingLight=vec3(angles+uGridPhase,0.0);').replace('#include <opaque_fragment>','');};
   const mesh=new THREE.Mesh(new THREE.PlaneGeometry(.001,.001),material);mesh.position.copy(centre);mesh.quaternion.copy(camera.quaternion);const scene=new THREE.Scene();scene.add(mesh);
   const target=new THREE.WebGLRenderTarget(64,64,{type:THREE.FloatType});gpu.setRenderTarget(target);gpu.render(scene,camera);
   const pixels=new Float32Array(64*64*4);gpu.readRenderTargetPixels(target,0,0,64,64,pixels);
   const origin=core.bodyFixedToSurfacePosition({xKm:camera.position.x,yKm:camera.position.y,zKm:camera.position.z},coords);
   let maxErrorM=0;for(let y=0;y<64;y++)for(let x=0;x<64;x++){
    const half=.1*Math.tan(camera.fov*Math.PI/360);const p=new THREE.Vector3(((x+.5)/64*2-1)*half,((y+.5)/64*2-1)*half,0).applyQuaternion(mesh.quaternion).add(centre);
    const expected=core.bodyFixedToSurfacePosition({xKm:p.x,yKm:p.y,zKm:p.z},coords),i=(y*64+x)*4;
    const dlat=pixels[i]-(expected.latDeg-origin.latDeg+origin.latDeg%.001),dlon=pixels[i+1]-(expected.lonDeg-origin.lonDeg+origin.lonDeg%.001);
    maxErrorM=Math.max(maxErrorM,Math.hypot(dlat,dlon*Math.cos(lat*Math.PI/180))*Math.PI/180*radii[0]*1000);
   }
   results.push({name,samples:4096,maxErrorM});target.dispose();mesh.geometry.dispose();material.dispose();
  }
  gpu.dispose();return results;
 },process.cwd());
 console.log('GPU precision',JSON.stringify(report.gpuPrecision));assert.ok(report.gpuPrecision.every(r=>r.maxErrorM<.02),'Close-range GPU coordinates drifted more than 2 cm');

  return report;
}

async function integration(page) {
  const report = { views: [], missing: [], gpu: null };

  for (const [catalog, body, lat, lon, altitude] of [
    ['earth-moon', 'Earth', 17, 5, 1000],
    ['moonfall-shackleton', 'Moon', -89.67, 129.78, 25],
    ['ingenuity-jezero', 'Mars', 18.444, 77.45, 5],
    ['msl-dingo-gap', 'Mars', -4.63, 137.4, 5],
  ]) {
    if (selectedCatalogs && !selectedCatalogs.includes(catalog)) continue;
    console.log('Loading', catalog);
    await load(page, catalog, body);
    if (catalog === 'msl-dingo-gap') {
      for (const name of ['Dingo Gap Approach', 'Curiosity Surface', 'Curiosity Close-up']) {
        await page.evaluate(async name => {
          const state = await window.gridImport('/src/lib/viewer-state.svelte.ts');
          window.cosmo.setPlaying(false); state.setLighting('flood');
          if (state.getRenderer() !== window.renderer) throw new Error('Harness imported a different viewer session');
          if (!state.applyViewpoint(name, { animate: false })) throw new Error(`Unavailable catalog viewpoint: ${name}`);
          window.cosmo.setLayer('grid', true); window.cosmo.setGridScope('bodies', 'Mars'); window.cosmo.setGridDensity('auto');
        }, name);
        await page.waitForTimeout(3000);
        for (const coordinateFrame of [false, true]) {
          await page.evaluate(value => window.cosmo.setGridCoordinateFrame(value), coordinateFrame);
          await page.waitForTimeout(1500);
          const sample = await page.evaluate(() => {
            const r = window.renderer, bm = r.getBodyMesh('Mars'), m = bm.gridMetrics;
            return { frame: bm.bodyFixedFrame, available: bm.attitudeAvailable, camera: r.camera.position.toArray(),
              roverDistanceKm: r.camera.position.distanceTo(r.getBodyMesh('Curiosity').position) / r.scaleFactor,
              labels: m.labels, divisions: m.frameTicks.length, alignmentPx: Math.max(0, ...m.frameTicks.map(t => t.alignmentPx ?? 0)),
              local: bm.getSurfaceOverlays().map(o => ({ visible: o.group.visible, tiles: o.tiles.visibleTiles.size })),
              visibleTerrain: bm.terrainManager.tiles.visibleTiles.size, physicalRevision: bm.terrainRevision,
              places: r.placeNames.getScreenRects().length };
          });
          report.views.push({ catalog, namedView: name, coordinateFrame, ...sample });
          console.log(name, coordinateFrame, JSON.stringify(sample));
          await page.screenshot({ path: `${out}/${name.toLowerCase().replaceAll(' ', '-')}-${coordinateFrame ? 'frame' : 'surface'}.png` });
        }
      }
    }
    await page.evaluate(async ({ body, lat, lon, altitude, coreUrl }) => {
      const r = window.renderer, bm = r.getBodyMesh(body), c = window.cosmo;
      c.setPlaying(false); c.untrack(); c.select(null); c.setLayer('grid', true); c.setGridScope('bodies', body);
      c.setGridDensity('auto'); c.setGridLabels(true);
      c.setGridCoordinateFrame(false);
      r.placeNames.setBodyVisible(body, true);
      if (body === 'Earth' || body === 'Mars') { const state = await window.gridImport('/src/lib/viewer-state.svelte.ts'); state.setLighting('flood'); }
      const core = await import(coreUrl), V = r.camera.position.constructor;
      const coord = bm.surfaceCoordinates;
      const toWorld = (latDeg, lonDeg, heightKm) => {
        const p = core.surfacePositionToBodyFixed({ latDeg, lonDeg, heightKm }, coord);
        return new V(p.xKm, p.yKm, p.zKm).applyQuaternion(bm.bodyToWorldQuaternion(r.camera.quaternion.clone()))
          .multiplyScalar(r.scaleFactor).add(bm.position);
      };
      const h = bm.sampleResidentTerrain(lat, lon)?.elevationKm ?? 0;
      const eye = toWorld(lat, lon, h + altitude), target = toWorld(lat, lon, h);
      r.cameraController.controls.enableDamping = false;
      r.camera.position.copy(eye); r.camera.up.copy(toWorld(Math.min(89.99, lat + 0.01), lon, h).sub(target).normalize());
      r.cameraController.controls.target.copy(target); r.camera.lookAt(target); r.camera.updateMatrixWorld(true);
      if (bm.surfaceAppearance) bm.setSurfaceAppearance({ ...bm.surfaceAppearance, contours: true, contourLabels: true, hillshade: true });
      window.gridValidationPose = { eye: eye.toArray(), target: target.toArray(), up: r.camera.up.toArray() };
    }, { body, lat, lon, altitude, coreUrl: coreUrl });
    if (catalog !== 'earth-moon') {
      try { await page.waitForFunction(body => (() => { const t = window.renderer.getBodyMesh(body).terrainManager; const n = t?.metrics.network; return t?.tiles.visibleTiles.size > 0 && n.queued + n.downloading + n.parsing === 0 && (!t.cubeImageryStats || t.cubeImageryStats.inFlight === 0); })(), body, { timeout: 60000 }); }
      catch { report.missing.push({ catalog, reason: 'No streamed terrain became visible within 60 seconds' }); }
    }
    const context = await page.evaluate(async coreUrl => {
      const r = window.renderer, c = window.cosmo;
      const a = r.pickScene(250, 280, 'probe'), b = r.pickScene(420, 360, 'probe');
      if (a?.kind === 'surface') r.setProbePin(a.point);
      if (a?.kind === 'surface' && b?.kind === 'surface') {
        const core = await import(coreUrl);
        const measures = await window.gridImport('/src/lib/spatial-measurements.svelte.ts');
        measures.addMeasurement({ id: 'grid-validation-distance', kind: 'distance',
          source: core.surfacePointEndpoint(a.point, 'A'), target: core.surfacePointEndpoint(b.point, 'B') });
      }
      const activities = c.listActivities();
      const time = c.getTime();
      const activity = activities.reduce((best, item) => !best || Math.abs(item.start - time) < Math.abs(best.start - time) ? item : best, null);
      if (activity) {
        c.selectActivity(activity.id); c.showTrajectory(activity.vehicle, true);
        await new Promise(requestAnimationFrame);
        const module = await window.gridImport('/src/lib/mission-activities.ts');
        const event = module.activityEvent(activity);
        // Use the actual activity record through the host renderer's event API.
        r.setEventResults([event], event, `${event.label}\nCatalog activity`);
      }
      return { probe: a?.kind === 'surface', measurement: a?.kind === 'surface' && b?.kind === 'surface', activity: activity?.id ?? null };
    }, coreUrl);
    for (const coordinateFrame of [false, true]) {
      await page.evaluate(coordinateFrame => window.cosmo.setGridCoordinateFrame(coordinateFrame), coordinateFrame);
      await page.waitForTimeout(1500);
      const result = await page.evaluate(async ({ body, coordinateFrame }) => {
        const r = window.renderer, bm = r.getBodyMesh(body), tm = bm.terrainManager;
        const gl = r.renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
        const frames = [], costs = [], update = bm.updateGrid;
        const uploadsBefore = bm.gridMetrics.frameTextureUploads;
        bm.updateGrid = function(...args) { const start = performance.now(); const value = update.apply(this, args); costs.push(performance.now() - start); return value; };
        try {
          for (let i = 0; i < 90; i++) {
            // Slow roll, optical zoom and nearly stationary motion use the real frame loop.
            if (i === 20) { r.camera.fov *= 0.9; r.camera.updateProjectionMatrix(); }
            if (i > 30 && i < 50) r.camera.up.applyAxisAngle(r.camera.getWorldDirection(r.camera.position.clone()), 0.0005);
            await new Promise(requestAnimationFrame);
            const m = bm.gridMetrics;
            frames.push({ count: coordinateFrame ? m.frameTicks.length : m.labels,
              axes: [...new Set(coordinateFrame ? m.frameTicks.map(t => t.axis) : m.annotations.map(a => a.axis))],
              error: Math.max(0, ...m.frameTicks.map(t => t.alignmentPx ?? 0)) });
          }
        } finally { bm.updateGrid = update; }
        costs.sort((a,b) => a-b);
        const m = bm.gridMetrics, images = tm?.cubeImageryStats;
        return { coordinateFrame, density: r.gridSettings.density, frame: bm.bodyFixedFrame, available: bm.attitudeAvailable,
          gpu: gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
          pose: window.gridValidationPose, minDivisions: Math.min(...frames.map(f => f.count)), maxDivisions: Math.max(...frames.map(f => f.count)),
          bothAxesFrames: frames.filter(f => f.axes.length === 2).length, maxAlignmentPx: Math.max(...frames.map(f => f.error)),
          updateMedianMs: costs[Math.floor(costs.length / 2)], updateP95Ms: costs[Math.floor(costs.length * 0.95)],
          frameTextureBytes: m.frameTextureBytes, frameTextureUploads: m.frameTextureUploads, uploadsDuringMotion: m.frameTextureUploads - uploadsBefore,
          visibleTerrain: tm?.tiles.visibleTiles.size ?? 0, cpuRevision: bm.terrainRevision,
          imagery: images ? { ready: images.ready, requests: images.requests, failures: images.failedRequests, queued: images.queued, inFlight: images.inFlight, bytes: images.bytes } : null,
          obstacles: { measurements: r.spatialCalloutRects.length, probe: r.probeCalloutRects.length, event: !!r.eventCalloutRect, placeCandidates: r.placeNames.metrics.candidates, placeBodies: [...r.placeNames.bodies], indexedPlaces: r.placeNames.index.places.length, places: r.placeNames.getScreenRects().length, contours: tm?.contourLabels?.group.children.filter(s => s.visible).length ?? 0 },
          siteMeshes: bm.getSurfaceOverlays().map(o => ({ visible: o.group.visible, tiles: o.tiles.visibleTiles.size })),
          sceneCounts: { ...r.renderer.info.render }, initialAssets: r.initialAssetsSummary };
      }, { body, coordinateFrame });
      report.gpu = result.gpu;
      report.views.push({ catalog, context, ...result });
      console.log(catalog, coordinateFrame ? 'frame' : 'surface', JSON.stringify(result));
      await page.screenshot({ path: `${out}/${catalog}-${coordinateFrame ? 'frame' : 'surface'}.png` });
    }
    const lifecycle = await page.evaluate(async body => {
      const r = window.renderer, bm = r.getBodyMesh(body), c = window.cosmo;
      const wait = async n => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); };
      const before = { eye: r.camera.position.clone(), target: r.cameraController.controls.target.clone(), up: r.camera.up.clone(), fov: r.camera.fov };
      c.setLayer('grid', false); await wait(2);
      const disabled = { labels: bm.gridMetrics.labels, frameElements: bm.gridMetrics.frameElements };
      c.setLayer('grid', true); c.setGridCoordinateFrame(false);
      const radial = r.camera.position.clone().sub(bm.position).normalize();
      r.camera.position.copy(bm.position).addScaledVector(radial, bm.displayRadius * 4 * r.scaleFactor);
      r.cameraController.controls.target.copy(bm.position); r.camera.lookAt(bm.position); r.camera.updateMatrixWorld(true);
      await wait(60);
      const globe = { labels: bm.gridMetrics.labels, step: [bm.gridMetrics.latitudeStep, bm.gridMetrics.longitudeStep] };
      r.camera.position.copy(before.eye); r.camera.up.copy(before.up); r.camera.fov = before.fov; r.camera.updateProjectionMatrix();
      r.cameraController.controls.target.copy(before.target); r.camera.lookAt(before.target); r.camera.updateMatrixWorld(true);
      c.setGridCoordinateFrame(true); await wait(60);
      const uploads = bm.gridMetrics.frameTextureUploads; await wait(30);
      const restored = { divisions: bm.gridMetrics.frameTicks.length, stationaryUploads: bm.gridMetrics.frameTextureUploads - uploads, visibleTerrain: bm.terrainManager?.tiles.visibleTiles.size ?? 0 };
      c.setTimeRate(10); c.setPlaying(true); await wait(45); c.setPlaying(false);
      return { disabled, globe, restored, playback: { frame: bm.bodyFixedFrame, available: bm.attitudeAvailable, divisions: bm.gridMetrics.frameTicks.length } };
    }, body);
    report.views.push({ catalog, lifecycle });
    console.log(catalog, 'lifecycle', JSON.stringify(lifecycle));
    if (catalog === 'earth-moon') {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(async () => { const shell = await window.gridImport('/src/lib/shell.svelte.ts'); shell.openTool('display'); });
      await page.waitForTimeout(500);
      const frameToggle = page.getByRole('checkbox', { name: 'Labels at viewport border', exact: true });
      await frameToggle.uncheck(); await frameToggle.check();
      await page.getByRole('combobox', { name: 'Grid density', exact: true }).selectOption('manual');
      await page.getByLabel('Grid angular spacing', { exact: true }).selectOption('5');
      const compact = await page.evaluate(async () => {
        const state = await window.gridImport('/src/lib/viewer-state.svelte.ts');
        const bodies = [...document.querySelectorAll('.instrument-body')].filter(e => e.clientHeight > 0);
        return { grid: window.renderer.gridSettings, sameRenderer: state.getRenderer() === window.renderer,
          scroll: bodies.map(e => ({ scrollTop: e.scrollTop, clientHeight: e.clientHeight, scrollHeight: e.scrollHeight,
            parentScrollTop: e.closest('.instrument')?.parentElement?.scrollTop ?? 0 })) };
      });
      report.views.push({ catalog, compact });
      if (!compact.sameRenderer || compact.grid.spacingDeg !== 5 || !compact.grid.coordinateFrame) throw new Error('Compact grid controls did not reach the loaded renderer');
      await page.screenshot({ path: `${out}/compact-grid-controls.png` });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  }

  assert.deepEqual(report.missing, [], 'Streamed terrain was unavailable');
  return report;
}
