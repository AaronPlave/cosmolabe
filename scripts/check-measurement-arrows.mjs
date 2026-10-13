/** Browser regressions for measurements. Run against `npm run dev --workspace apps/viewer`.
 * Usage: node scripts/check-measurements.mjs [http://localhost:5173]
 * Start a fresh dev server before running so source imports share the app's module instances.
 * Uses Vite's source imports to inspect state and exercise live DOM updates.
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, rename } from 'node:fs/promises';
const base = process.argv[2] ?? 'http://localhost:5173';
const out = new URL('../apps/viewer/test-screenshots/measurements/',import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: {width:1280,height:900}, recordVideo:{dir:new URL('arrow-orbits/',out).pathname,size:{width:1280,height:900}} });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',message=>{if(message.type()==='error'&&/Shader Error|VALIDATE_STATUS/.test(message.text()))errors.push(message.text());});
try {
  await page.goto(`${base}/?catalog=test-catalogs/earth-moon&test=1`, {waitUntil:'domcontentloaded',timeout:120000});
  await page.waitForFunction(()=>window.__cosmolabe?.assetsReady,null,{timeout:120000});
  await page.evaluate(async()=>{
    const resource=file=>performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/'+file)).name;
    window.m=await import(resource('spatial-measurements.svelte.ts'));
    window.ld=await import(resource('loader.ts'));window.sh=await import(resource('shell.svelte.ts'));
    window.renderer=window.ld.getCurrentRenderer();window.renderer.stop();window.__cosmolabe.capture('Lunar Orbit');
    const source={kind:'entity',bodyName:'Earth'},target={kind:'entity',bodyName:'Moon'};
    window.m.addMeasurement({id:'distance',kind:'distance',source,target});
    window.m.addMeasurement({id:'direction',kind:'direction',source,target});
    window.m.addMeasurement({id:'angle',kind:'angle',source:{kind:'entity',bodyName:'Sun'},vertex:source,target});
    window.m.newMeasurement();window.renderer.renderFrame();
  });
  if(!process.argv.includes('--full-only'))await checkSurfaceContinuation();
  await checkSpacecraftPass();
  await checkOrbits();
  assert.deepEqual(errors,[]);
} finally {await context.close();const video=new URL(process.argv.includes('--full-only')?'arrow-orbits/full-length-arrow-orbit.webm':'arrow-orbits/continuous-arrow-orbit.webm',out).pathname;await rename(await page.video().path(),video);console.log('Orbit video',video);await browser.close();}
async function capture(name) {
  await page.evaluate(() => window.renderer.renderFrame());
  await page.waitForTimeout(650);
  await page.screenshot({ path: new URL(name, out).pathname, timeout: 120000 });
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


async function checkSurfaceContinuation() {
  const url=await page.evaluate(async()=>{
    const m=window.m;m.resetMeasurementsForScene();
    m.addMeasurement({id:'restored-points',kind:'distance',source:{kind:'body-fixed',bodyName:'Earth',positionKm:[1,2,3],label:'Earth point 1 (1.00, 2.00, 3.00 km)'},target:{kind:'body-fixed',bodyName:'Earth',positionKm:[4,5,6],label:'Earth point 2'}});
    m.duplicateMeasurement('restored-points');m.newMeasurement();
    const resource=file=>performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/'+file)).name;
    const link=await import(resource('view-link.ts')),urls=await import(resource('view-state-url.ts'));
    return urls.viewLink(link.captureViewState(),location.href);
  });
  let shared=url;
  for(const [count,number] of [[2,3],[3,4]]) {
    const restored=await browser.newPage({viewport:{width:1280,height:900}});
    try {
      await restored.goto(shared,{waitUntil:'domcontentloaded',timeout:120000});
      await restored.waitForFunction(()=>performance.getEntriesByType('resource').some(e=>new URL(e.name).pathname.endsWith('/spatial-measurements.svelte.ts')),null,{timeout:120000});
      await restored.evaluate(async()=>{
        const resource=file=>performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/'+file)).name;
        window.m=await import(resource('spatial-measurements.svelte.ts'));window.v=await import(resource('viewer-state.svelte.ts'));
      });
      await restored.waitForFunction(count=>window.v.vs.assetsReady&&!window.v.vs.showLoading&&window.m.measurements.items.length===count,count,{timeout:120000});
      const result=await restored.evaluate(async()=>{
        const m=window.m;m.newMeasurement();m.startMeasurementPick('source','surface');m.captureSurfaceEndpoint('Earth',[6378,1,2]);
        const label=m.measurements.draft.source.label;m.measurements.draft.target={kind:'entity',bodyName:'Moon'};m.createMeasurement();
        const resource=file=>performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname.endsWith('/'+file)).name;
        const link=await import(resource('view-link.ts')),urls=await import(resource('view-state-url.ts'));
        return {label,url:urls.viewLink(link.captureViewState(),location.href)};
      });
      assert.equal(result.label,`Earth point ${number} (6378.00, 1.00, 2.00 km)`);shared=result.url;
    } finally {await restored.close();}
  }
  console.log('Restore, duplicate endpoints, pick new surface points and re-share keep distinct names');
}

async function checkOrbits() {
  await page.evaluate(()=>{
    const r=window.renderer,m=window.m,u=window.ld.getUniverse();r.stop();m.resetMeasurementsForScene();window.sh.closeTool('measure');
    const source=u.absolutePositionOf('Cassini',r.timeController.et),target=u.absolutePositionOf('Saturn',r.timeController.et);
    const direction=r.camera.position.clone().set(target[0]-source[0],target[1]-source[1],target[2]-source[2]).normalize();
    const side=direction.clone().cross(r.camera.position.clone().set(0,0,1)).normalize();
    if(side.lengthSq()<0.1)side.copy(direction).cross(r.camera.position.clone().set(0,1,0)).normalize();
    const up=direction.clone().cross(side).normalize();
    window.orbit={source,direction,side,up};
    m.addMeasurement({id:'orbit',kind:'direction',source:{kind:'entity',bodyName:'Cassini'},target:{kind:'coordinate',frame:'ECLIPJ2000',positionKm:source.map((v,i)=>v+direction.getComponent(i)*5e11),label:'Far target'},color:'#9ab58d'});m.newMeasurement();
  });
  for(const [scale,distance] of (process.argv.includes('--full-only')?[]:[['spacecraft',2.5e-8],['astronomical',250]])) {
    for(const state of ['ordinary','hovered','selected']) {
      await page.evaluate(state=>{window.m.newMeasurement();window.m.hoverMeasurement(null);if(state==='selected')window.m.selectMeasurement('orbit');if(state==='hovered')window.m.hoverMeasurement('orbit');},state);
      const result=await page.evaluate(async({distance})=>{
        const r=window.renderer,o=window.orbit;let worst=0,visible=0,maxStep=0,last=null;
        for(let frame=0;frame<=72;frame++) {
          const angle=frame/72*Math.PI*2,center=r.bodyMeshes.get('Cassini').position;
          r.camera.position.copy(center).addScaledVector(o.direction,distance*Math.cos(angle)).addScaledVector(o.side,distance*Math.sin(angle));r.camera.up.copy(o.up);
          r.cameraController.controls.target.copy(center);r.cameraController.controls.update();r.renderFrame();
          const visual=r.spatialRelationships.visuals.get('orbit'),a=visual.arrow;
          if(visual.group.visible&&a.cone.visible)visible++;
          const axis=o.direction.clone().applyQuaternion(a.quaternion.clone().invert());
          worst=Math.max(worst,axis.distanceTo(axis.clone().set(0,1,0)));
          const ratio=a.cone.scale.x/a.cone.scale.y;
          if(!Number.isFinite(ratio)||Math.abs(ratio-0.65)>1e-7)throw new Error('Unstable head proportions');
          if(last!==null)maxStep=Math.max(maxStep,Math.abs(a.cone.scale.y/last-1));last=a.cone.scale.y;
          if(!visual.hitSegments.every(p=>p.toArray().every(Number.isFinite)))throw new Error('Nonfinite orbit geometry');
          await new Promise(resolve=>setTimeout(resolve,45));
        }
        return {worst,visible,maxStep};
      },{distance});
      assert(result.worst<1e-7);assert.equal(result.visible,73);assert(result.maxStep<0.08);
      console.log('Continuous orbit',scale,state,result);
      await page.evaluate(distance=>{const r=window.renderer,o=window.orbit,c=r.bodyMeshes.get('Cassini').position;r.camera.position.copy(c).addScaledVector(o.side,distance);r.camera.up.copy(o.up);r.cameraController.controls.target.copy(c);r.cameraController.controls.update();r.renderFrame();},distance);
      await capture(`arrow-head-${scale}-${state}-actual.png`);
    }

  }
  await page.evaluate(()=>{
    const r=window.renderer,o=window.orbit,m=window.m;m.newMeasurement();
    m.measurements.items[0].target={kind:'coordinate',frame:'ECLIPJ2000',positionKm:o.source.map((v,i)=>v+o.direction.getComponent(i)*3.75e-9/r.scaleFactor),label:'Nearby target'};
    m.measurements.items[0].fullLength=true;m.selectMeasurement('orbit');
  });
  const full=await page.evaluate(async()=>{
    const r=window.renderer,o=window.orbit;let junctionError=0;
    for(let frame=0;frame<=8;frame++) {
      const angle=frame/8*Math.PI*2,c=r.bodyMeshes.get('Cassini').position;
      r.camera.position.copy(c).addScaledVector(o.direction,2.5e-8*Math.cos(angle)).addScaledVector(o.side,2.5e-8*Math.sin(angle));r.camera.up.copy(o.up);
      r.cameraController.controls.target.copy(c);r.cameraController.controls.update();r.renderFrame();
      const v=r.spatialRelationships.visuals.get('orbit'),a=v.arrow;
      const data=v.stroke.line.geometry.getAttribute('instanceEnd').data.array;
      const base=o.direction.clone().set(0,a.cone.position.y-a.cone.scale.y,0).applyQuaternion(a.quaternion).add(a.position);
      junctionError=Math.max(junctionError,base.distanceTo(base.clone().fromArray(data,3)));
      if(!a.cone.visible||!v.group.visible)throw new Error('Full-length head is missing');
      await new Promise(resolve=>setTimeout(resolve,45));
    }
    return junctionError;
  });
  assert(full<2.5e-14);console.log('Full-length orbit preserves cone-base shaft junction',full);
  await capture('arrow-head-full-length-actual.png');


}
