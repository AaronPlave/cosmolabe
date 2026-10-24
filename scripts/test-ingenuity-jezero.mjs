/** Actual #246 mission, independent products, near-surface loading and GPU acceptance.
 * DEV_DATA_MODE=local npm --prefix apps/viewer run dev -- --port 5198
 * node scripts/test-ingenuity-jezero.mjs [VIEWER_URL] [OUT_DIR]
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
const base=process.argv[2]??'http://127.0.0.1:5198/';
const out=process.argv[3]??'work/ingenuity-246/browser';await mkdir(out,{recursive:true});
const catalog=JSON.parse(await readFile('apps/viewer/test-catalogs/ingenuity-jezero.json','utf8'));
const mars=catalog.items.find(x=>x.name==='Mars');
const sourcePaths=mars.geometry.imagery.map(x=>new URL(x.url,new URL('test-catalogs/ingenuity-jezero.json',base)).pathname.replace(/imagery.json$/,'tiles/'));
const browser=await chromium.launch({headless:true,
  ...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),
  args:[process.platform==='darwin'?'--use-angle=metal':'--use-angle=swiftshader','--enable-gpu','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[],requests=[],result={catalog:'ingenuity-jezero',views:[],loading:[],errors};
let sourceFault=false,baseFault=false;
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(/\.(glb|f32|png)(\?|$)/.test(r.url()))requests.push(r.url());});
page.on('response',r=>{if(r.status()>=400&&!sourceFault&&!baseFault&&!r.url().endsWith('favicon.ico'))errors.push(`${r.status()} ${r.url()}`);});
page.setDefaultTimeout(120000);
const save=()=>writeFile(`${out}/metrics.json`,JSON.stringify(result,null,2)+'\n');
async function ready(){
  await page.waitForFunction(()=>window.renderer?.getBodyMesh('Mars')?.terrainManager?.cubeStats?.version);
  await page.evaluate(async()=>{await window.renderer.waitForInitialAssets();window.cosmo.setPlaying(false);window.cosmo.untrack();const t=window.renderer.getBodyMesh('Mars').terrainManager;await t.cube.source.ready;await t.cubeImageryLayer.ready;});
}
async function settle(budget=false){
  await page.waitForFunction(budget=>{
    const t=window.renderer.getBodyMesh('Mars').terrainManager,n=t.metrics.network,i=t.cubeImageryStats;
    return t.tiles.visibleTiles.size>0&&n.queued+n.downloading+n.parsing===0&&t.cubeStats.inFlight===0&&i.inFlight===0&&(i.queued===0||(budget&&i.budgetLimited));
  },budget,{timeout:180000});
  await page.waitForTimeout(250);
}
async function pose(lat,lon,altitudeKm=.05){
  return page.evaluate(async({lat,lon,altitudeKm})=>{
    const r=window.renderer,b=r.getBodyMesh('Mars'),t=b.terrainManager,V=r.camera.position.constructor;
    window.cosmo.setPlaying(false);window.cosmo.untrack();
    const la=lat*Math.PI/180,lo=lon*Math.PI/180,d=[Math.cos(la)*Math.cos(lo),Math.cos(la)*Math.sin(lo),Math.sin(la)];
    const ray={origin:{xKm:d[0]*3500,yKm:d[1]*3500,zKm:d[2]*3500},direction:d.map(x=>-x),nearKm:0,farKm:300};
    await t.cube.surface.ensureRayCoverage(ray,{maxMeshErrorKm:0},new AbortController().signal);
    const hit=b.intersectTerrainRay(ray,{maxMeshErrorKm:0});if(hit?.kind!=='hit')throw new Error('No mission CPU surface');
    window.ingenuityTestRay=ray;window.ingenuityTestPoint=hit.position;
    const target=[hit.position.xKm,hit.position.yKm,hit.position.zKm],centre=new V();b.getWorldPosition(centre);
    const toWorld=([x,y,z])=>new V(x,z,-y).applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
    const c=r.camera,controls=r.cameraController.controls;controls.enableDamping=false;
    controls.target.copy(toWorld(target));c.position.copy(toWorld(target.map((x,i)=>x+d[i]*altitudeKm)));
    c.fov=45;c.updateProjectionMatrix();
    c.up.copy(toWorld([-Math.sin(la)*Math.cos(lo),-Math.sin(la)*Math.sin(lo),Math.cos(la)]).sub(centre).normalize());
    c.lookAt(controls.target);c.updateMatrixWorld(true);return hit;
  },{lat,lon,altitudeKm});
}
async function snapshot(){
  return page.evaluate(()=>{
    const r=window.renderer,b=r.getBodyMesh('Mars'),t=b.terrainManager,webgl=r.getContext().webglRenderer;
    const V=r.camera.position.constructor,centre=new V();b.getWorldPosition(centre);
    const local=r.camera.position.clone().sub(centre).divideScalar(r.scaleFactor).applyQuaternion(b.mesh.quaternion.clone().invert());
    const point={xKm:local.x,yKm:-local.z,zKm:local.y},nav=t.navigationSurface(point);
    const gl=webgl.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
    return {gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
      nav,clearanceM:nav?.radiusKm==null?null:(local.length()-nav.radiusKm)*1000,
      imagery:t.cubeImageryStats,network:t.metrics.network,cpu:t.cubeStats,
      geometry:[...t.tiles.visibleTiles].map(x=>x.content?.uri).sort(),
      cpuHit:b.intersectTerrainRay(window.ingenuityTestRay,{maxMeshErrorKm:0}),
      staticVisible:b.mesh.visible,readyToShow:t.isReadyToShow(),surface:b.surfaceTransitionState};
  });
}
try{
  await page.goto(`${base}?catalog=test-catalogs/ingenuity-jezero`,{waitUntil:'domcontentloaded',timeout:120000});await ready();
  // Paired policy comparison on the same scientific product and CPU grids.
  await page.evaluate(()=>{const t=window.renderer.getBodyMesh('Mars').terrainManager;t.tiles.errorTarget=1e6;t.nearSurfacePolicy.maxErrorM=1e12;});
  await pose(18.44486301,77.45101915);await settle();result.coarsePolicyBaseline=await snapshot();await page.locator('canvas').first().screenshot({path:`${out}/coarse-policy.png`});await save();
  await page.evaluate(()=>{window.renderer.getBodyMesh('Mars').terrainManager.nearSurfacePolicy.maxErrorM=.5;});
  for(let i=0;i<20;i++){await page.waitForTimeout(100);result.loading.push(await snapshot());}
  await settle();await pose(18.44486301,77.45101915);await settle();
  result.refinedPolicy=await snapshot();
  await page.locator('canvas').first().screenshot({path:`${out}/refined-policy.png`});
  assert.doesNotMatch(result.refinedPolicy.gpu,/swiftshader|llvmpipe|software/i,'acceptance requires physical GPU');
  assert.ok(result.refinedPolicy.nav?.settled,JSON.stringify(result.refinedPolicy.nav));
  assert.ok(result.refinedPolicy.clearanceM>=1.9);
  assert.ok(result.loading.every(x=>x.clearanceM==null||x.clearanceM>=1.9),'camera crossed currently drawn or physical ground during refinement');
  await page.evaluate(()=>{window.renderer.getBodyMesh('Mars').terrainManager.tiles.errorTarget=3;});
  for(const [name,lat,lon] of [['wright',18.44486301,77.45101915],['delta',18.455,77.405],['last-airfield',18.4980,77.3273]]){
    await pose(lat,lon);await settle();const state=await snapshot();
    assert.ok(state.nav?.settled,`${name}: ${JSON.stringify(state.nav)}`);assert.ok(state.clearanceM>=1.9);
    assert.equal(state.imagery.baseUncoveredBlocks,0);assert.ok(state.imagery.textureBytes<=state.imagery.maxTextureBytes);
    result.views.push({name,lat,lon,...state});await page.locator('canvas').first().screenshot({path:`${out}/${name}.png`});await save();
  }
  // Real rendered picks become persistent measurement endpoints; imagery cannot
  // change their physical positions or the measured straight-line distance.
  await pose(18.44486301,77.45101915,.1);await settle();
  result.measurement=await page.evaluate(async root=>{
    const r=window.renderer;
    const core=await import(`/@fs/${root}/packages/core/src/index.ts`);
    const state=await import('/src/lib/spatial-measurements.svelte.ts');
    const loader=await import('/src/lib/loader.ts');
    const a=r.pickSurface(0,0),b=r.pickSurface(.2,0);
    if(a?.physical?.kind!=='hit'||b?.physical?.kind!=='hit'||a.renderedSkirt||b.renderedSkirt)throw new Error('Measurement did not pick physical mission terrain');
    const relationship={id:'ingenuity-acceptance',kind:'distance',source:core.surfacePointEndpoint(a.point),target:core.surfacePointEndpoint(b.point)};
    state.addMeasurement(relationship);
    const before=core.resolveSpatialRelationship(loader.getUniverse(),relationship,r.timeController.et);
    r.getBodyMesh('Mars').setImageryLayerVisible('jezero-hirise',false);
    const after=core.resolveSpatialRelationship(loader.getUniverse(),relationship,r.timeController.et);
    r.getBodyMesh('Mars').setImageryLayerVisible('jezero-hirise',true);
    window.ingenuityMeasurementState=state;
    return {a,b,beforeKm:before?.distanceKm,afterKm:after?.distanceKm,count:state.measurements.items.length};
  },resolve('.'));
  assert.ok(result.measurement.beforeKm>0);assert.equal(result.measurement.beforeKm,result.measurement.afterKm);
  assert.equal(result.measurement.count,1);
  await page.evaluate(()=>window.ingenuityMeasurementState.removeMeasurement('ingenuity-acceptance'));
  await page.mouse.click(720,450,{button:'right'});
  await page.getByRole('button',{name:'Fly to here',exact:true}).click();
  await page.waitForFunction(()=>!window.renderer.cameraController.flight);await settle();
  result.flyTo=await snapshot();assert.ok(result.flyTo.clearanceM>=1.9);
  await page.locator('canvas').first().screenshot({path:`${out}/fly-to.png`});await save();
  // Sample the catalog-loaded interpolator/model, including the first hover,
  // a traverse and final landing. This checks playback of the explicit estimate,
  // not an independent observation of helicopter altitude.
  const flights=JSON.parse(await readFile('apps/viewer/test-catalogs/data/ingenuity/flights_index.json','utf8'));
  result.playback=[];
  for(const number of [1,12,72]){
    const flight=flights[number-1];
    for(const fraction of [0,.02,.5,.98,1]){
      const et=flight.etStart+(flight.etEnd-flight.etStart)*fraction;
      const point=await page.evaluate(et=>{
        const r=window.renderer;r.timeController.setTime(et);r.renderFrame();
        const s=r.universe.getBody('Ingenuity').stateAt(et),[x,y,z]=s.position;
        return {position:s.position,velocity:s.velocity,lat:Math.atan2(z,Math.hypot(x,y))*180/Math.PI,lon:Math.atan2(y,x)*180/Math.PI};
      },et);
      await pose(point.lat,point.lon,.05);await settle();
      const sample=await page.evaluate(position=>{
        const r=window.renderer,b=r.getBodyMesh('Mars'),t=b.terrainManager;
        const nav=t.navigationSurface({xKm:position[0],yKm:position[1],zKm:position[2]});
        const V=r.camera.position.constructor,centre=new V();b.getWorldPosition(centre);
        const expected=new V(position[0],position[2],-position[1]).applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
        const model=new V();r.getBodyMesh('Ingenuity').getWorldPosition(model);
        return {nav,estimatedClearanceM:nav?.physicalRadiusKm==null?null:(Math.hypot(...position)-nav.physicalRadiusKm)*1000,modelPositionErrorM:model.distanceTo(expected)/r.scaleFactor*1000};
      },point.position);
      assert.ok(point.position.every(Number.isFinite));assert.ok(point.velocity.every(Number.isFinite));
      assert.ok(sample.nav?.settled,`flight ${number} fraction ${fraction}: ${JSON.stringify(sample.nav)}`);
      assert.ok(sample.estimatedClearanceM>=-.5,`estimated flight below physical representation: ${JSON.stringify(sample)}`);
      assert.ok(sample.modelPositionErrorM<.001,'displayed model is not at its catalog-derived position');
      result.playback.push({flight:number,fraction,et,...point,...sample});
      if(fraction===.5)await page.locator('canvas').first().screenshot({path:`${out}/flight-${number}-estimated.png`});
      await save();
    }
  }
  // Sharper imagery without any change in physical geometry/CPU queries.
  await pose(18.44486301,77.45101915,.5);await settle();
  await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.setOptions({maxLevel:8}));await settle();const coarse=await snapshot();
  await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.setOptions({maxLevel:undefined}));await settle();const fine=await snapshot();
  assert.deepEqual(fine.geometry,coarse.geometry);assert.deepEqual(fine.cpuHit,coarse.cpuHit);
  assert.ok(fine.imagery.maxDisplayedLevel>coarse.imagery.maxDisplayedLevel);result.independentImagery={coarse,fine};
  const image=await page.locator('canvas').first().screenshot();
  await page.evaluate(()=>{const b=window.renderer.getBodyMesh('Mars');b.moveImageryLayer('jezero-hirise',1);b.setImageryLayerOpacity('jezero-ctx',.5);});await settle();
  assert.notDeepEqual(await page.locator('canvas').first().screenshot(),image);
  await page.evaluate(()=>{const b=window.renderer.getBodyMesh('Mars');b.moveImageryLayer('jezero-hirise',3);b.setImageryLayerOpacity('jezero-ctx',1);});await settle();
  result.controlsRestored=await snapshot();assert.deepEqual(result.controlsRestored.cpuHit,fine.cpuHit);
  await page.evaluate(()=>{const b=window.renderer.getBodyMesh('Mars');['ctx-global','jezero-ctx','jezero-hirise'].forEach(id=>b.setImageryLayerVisible(id,false));});await settle();result.baseOnly=await snapshot();
  assert.equal(result.baseOnly.imagery.baseUncoveredBlocks,0);
  await page.evaluate(()=>{const b=window.renderer.getBodyMesh('Mars');['ctx-global','jezero-ctx','jezero-hirise'].forEach(id=>b.setImageryLayerVisible(id,true));b.terrainManager.cubeImageryLayer.setOptions({maxTextureBytes:24*2**20});});
  for(const [lat,lon] of [[18.455,77.405],[18.498,77.3273],[18.44486301,77.45101915]]){await pose(lat,lon,.5);await settle(true);}
  result.eviction=await snapshot();assert.ok(result.eviction.imagery.evicted>0);assert.ok(result.eviction.imagery.textureBytes<=24*2**20);
  await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.setOptions({maxTextureBytes:128*2**20}));await settle();
  // A cold optional-source outage must retain mandatory base coverage, stop
  // retrying automatically, and recover through the explicit recovery port.
  await page.route('**/*',route=>sourceFault&&new URL(route.request().url()).pathname.startsWith(sourcePaths[3])?route.fulfill({status:404,body:'test optional-source outage'}):route.continue());
  sourceFault=true;await page.reload({waitUntil:'domcontentloaded'});await ready();await pose(18.44486301,77.45101915,.5);await settle();
  result.outage=await snapshot();assert.ok(result.outage.imagery.failures>0);assert.equal(result.outage.imagery.baseUncoveredBlocks,0);
  const count=result.outage.imagery.requests;await page.waitForTimeout(1000);assert.equal((await snapshot()).imagery.requests,count);
  sourceFault=false;await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.retryFailed());await settle();result.recovery=await snapshot();
  assert.equal(result.recovery.imagery.failedTiles,0);
  const transparentPng=await sharp({create:{width:1028,height:1028,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
  await page.route('**/*',route=>{
    const path=new URL(route.request().url()).pathname;
    if(!baseFault||!sourcePaths.some(prefix=>path.startsWith(prefix)))return route.fallback();
    return path.startsWith(sourcePaths[0])?route.fulfill({status:404,body:'test mandatory-base outage'}):route.fulfill({status:200,contentType:'image/png',body:transparentPng});
  });
  baseFault=true;await page.reload({waitUntil:'domcontentloaded'});await ready();await pose(18.44486301,77.45101915,.5);await settle();
  result.baseOutage=await snapshot();assert.ok(result.baseOutage.imagery.baseUncoveredBlocks>0);
  assert.equal(result.baseOutage.readyToShow,false);assert.equal(result.baseOutage.staticVisible,true);
  baseFault=false;await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.retryFailed());await settle();
  result.baseRecovery=await snapshot();assert.equal(result.baseRecovery.imagery.baseUncoveredBlocks,0);assert.equal(result.baseRecovery.readyToShow,true);
  await page.reload({waitUntil:'domcontentloaded'});await ready();await pose(18.44486301,77.45101915,.5);await settle();
  // Actual pointer drag/zoom on the mission, then a compact control capture.
  const before=await page.evaluate(()=>window.renderer.camera.position.toArray());
  await page.mouse.move(720,450);await page.mouse.down();await page.mouse.move(850,490,{steps:12});await page.mouse.up();await page.mouse.wheel(0,-120);await settle();
  assert.notDeepEqual(await page.evaluate(()=>window.renderer.camera.position.toArray()),before);
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(500);await page.screenshot({path:`${out}/compact.png`});
  result.compact=await snapshot();assert.ok(result.compact.clearanceM>=1.9);
  assert.equal(errors.length,0,errors.join('\n'));result.passed=true;await save();
  console.log(JSON.stringify({passed:true,gpu:result.refinedPolicy.gpu,maxSettledDiscrepancyM:Math.max(...result.views.map(x=>Math.abs(x.nav.discrepancyM))),views:result.views.length},null,2));
}catch(error){result.failure=String(error.stack??error);await save();throw error;}
finally{await browser.close();}
