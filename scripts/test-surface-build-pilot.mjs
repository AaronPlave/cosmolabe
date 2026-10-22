// Render a completed local real pilot without modifying deployment catalogs.
// Usage: CL_VIEWER_URL=http://127.0.0.1:5187/ node scripts/test-surface-build-pilot.mjs REPORT.json OUT_DIR
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
import { geodeticToBodyFixed } from '../packages/three/dist/TerrainSampler.js';

const [reportFile,outArg] = process.argv.slice(2);
assert(reportFile && outArg, 'Usage: test-surface-build-pilot.mjs REPORT.json OUT_DIR');
const report=JSON.parse(await readFile(resolve(reportFile)));const out=resolve(outArg);await mkdir(out,{recursive:true});
const terrain=report.products.find(p=>p.kind==='cube-terrain');const imagery=report.products.filter(p=>p.kind==='cube-imagery');
assert(terrain&&imagery.length,'completed terrain and imagery required');
const products=new Map(report.products.map(p=>[p.id,resolve(report.directory,p.id)]));
const catalog=JSON.parse(await readFile('apps/viewer/test-catalogs/experiments/mars-terrain-cube-jezero.json'));
const globe=catalog.items.find(i=>i.name==='Mars').geometry;
globe.terrain.url=`/__surface-pilot/${terrain.id}/tileset-measured.json`;
globe.terrain.cubeSphere.cpuGrids=`/__surface-pilot/${terrain.id}/cpu-grids.json`;
globe.terrain.cubeSphere.imagery={maxScreenTexelError:1};
globe.imagery=imagery.map(p=>({type:'cube',id:p.id,name:p.sourceIds[0],url:`/__surface-pilot/${p.id}/imagery.json`,visible:p.visible,opacity:p.opacity,
  resolutionMeters:p.nativeFidelity[0].nativeGsdM}));
assert(imagery.length>=2,'context base and optional native image layer required');
const nativeLayer=imagery.at(-1);
const cp=terrain.controls[0];const ground=geodeticToBodyFixed({latDeg:cp.lat,lonDeg:cp.lon,heightKm:cp.heightM/1000},terrain.datum);
const target=[ground.xKm,ground.yKm,ground.zKm];
const la=cp.lat*Math.PI/180,lo=cp.lon*Math.PI/180;
const normal=[Math.cos(la)*Math.cos(lo),Math.cos(la)*Math.sin(lo),Math.sin(la)];
const north=[-Math.sin(la)*Math.cos(lo),-Math.sin(la)*Math.sin(lo),Math.cos(la)];
const browser=await chromium.launch({headless:true,args:[process.platform==='darwin'?'--use-angle=metal':'--use-angle=swiftshader','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--no-sandbox']});
const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(r.url().includes('/__surface-pilot/')&&!r.ok())errors.push(`${r.status()} ${r.url()}`);});
await page.route('**/test-catalogs/experiments/mars-terrain-cube-jezero.json',r=>r.fulfill({json:catalog}));
await page.route('**/__surface-pilot/**',async route=>{
  const parts=new URL(route.request().url()).pathname.split('/').filter(Boolean);const root=products.get(parts[1]);
  assert(root,'unknown pilot product');const file=resolve(root,...parts.slice(2));assert(file.startsWith(root+sep),'invalid product path');
  try { await route.fulfill({body:await readFile(file),contentType:({'.json':'application/json','.glb':'model/gltf-binary','.png':'image/png','.f32':'application/octet-stream'})[extname(file)]??'application/octet-stream'}); }
  catch(e){errors.push(e.message);await route.fulfill({status:404,body:'Missing pinned product file'});}
});
try {
  await page.goto(new URL('?catalog=test-catalogs/experiments/mars-terrain-cube-jezero&test=1',process.env.CL_VIEWER_URL??'http://127.0.0.1:5187/').href,{waitUntil:'domcontentloaded',timeout:180000});
  await page.waitForFunction(()=>window.__cosmolabe?.assetsReady===true,null,{timeout:180000});
  await page.evaluate(async()=>{const source=await(await fetch('/src/lib/commands.ts')).text();const url=source.match(/from ["']([^"']*viewer-state\.svelte[^"']*)["']/)?.[1];window.pilot=await import(url??'/src/lib/viewer-state.svelte.ts');});
  const environment=await page.evaluate(()=>{const gl=document.createElement('canvas').getContext('webgl2');const ext=gl.getExtension('WEBGL_debug_renderer_info');return {renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),userAgent:navigator.userAgent};});
  const pose=(height,mode='imagery-unlit')=>page.evaluate(({target,normal,north,height,mode})=>{
    const r=window.pilot.getRenderer(),bm=r.getBodyMesh('Mars');window.cosmo.setPlaying(false);window.cosmo.untrack();r.setTerrainDebugMode(mode,'Mars');
    const V=r.camera.position.constructor,centre=new V();bm.getWorldPosition(centre);
    const world=p=>new V(p[0],p[2],-p[1]).applyQuaternion(bm.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
    const eye=world(target.map((v,i)=>v+normal[i]*height)),t=world(target),up=world(north).sub(centre).normalize();
    r.cameraController.controls.enableDamping=false;r.cameraController.controls.target.copy(t);r.camera.position.copy(eye);r.camera.up.copy(up);r.camera.fov=45;r.camera.updateProjectionMatrix();r.camera.lookAt(t);r.camera.updateMatrixWorld(true);
  },{target,normal,north,height,mode});
  const snapshot=()=>page.evaluate(()=>{const r=window.pilot.getRenderer(),bm=r.getBodyMesh('Mars'),tm=bm.terrainManager;const ids=[],levels={};
    tm.tiles.visibleTiles.forEach(t=>{const uri=t.content?.uri??'';const m=/\/(\d+)\/\d+\/\d+\.glb$/.exec(uri);if(m)levels[m[1]]=(levels[m[1]]??0)+1;t.engineData?.scene?.traverse(o=>{if(o.isMesh&&!o.name.startsWith('cube-imagery-block'))ids.push(o.uuid);});});
    const p=r.pickSurface(0,0);return {levels,geometryIds:ids.sort(),metrics:bm.terrainMetrics,imagery:tm.cubeImageryStats,pick:p&&{latDeg:p.latDeg,lonDeg:p.lonDeg,altKm:p.altKm,physical:p.physical},layers:tm.imageryLayers};});
  const settle=async(height,mode)=>{let stable=0,last='';const start=Date.now();for(let i=0;i<180;i++){await pose(height,mode);await page.waitForTimeout(250);const s=await snapshot();const key=JSON.stringify([s.levels,s.imagery?.displayedLevels]);const busy=s.metrics.network.queued+s.metrics.network.downloading+s.metrics.network.parsing+(s.imagery?.inFlight??0)+(s.imagery?.queued??0);stable=busy===0&&key===last&&s.metrics.tiles.visible>0?stable+1:0;last=key;if(stable>=6)return {...s,settleMs:Date.now()-start};}throw new Error('pilot scene did not settle');};
  const results=[];
  for(const [name,height] of [['regional',1],['native-detail',.05],['zoom-out',5],['restored-native',.05]]){
    const state=await settle(height,'imagery-unlit');await page.screenshot({path:join(out,name+'.png')});results.push({name,heightKm:height,...state});
  }
  const near=results.find(r=>r.name==='native-detail');assert(near.imagery.maxDisplayedLevel>Math.max(...Object.keys(near.levels).map(Number)),'native image detail must refine beyond terrain');
  assert.equal(near.imagery.failedTiles,0);assert(near.pick?.physical?.kind==='hit','physical CPU pick must remain available');
  const before=await snapshot();
  assert(await page.evaluate(id=>window.pilot.getRenderer().getBodyMesh('Mars').terrainManager.setImageryLayerOpacity(id,.35),nativeLayer.id),'native layer opacity control must succeed');
  const faded=await settle(.05,'imagery-unlit');assert.equal(faded.layers.find(l=>l.id===nativeLayer.id).opacity,.35);await page.screenshot({path:join(out,'opacity.png')});assert.deepEqual(faded.geometryIds,before.geometryIds,'opacity changed physical terrain geometry');
  assert(await page.evaluate(id=>window.pilot.getRenderer().getBodyMesh('Mars').terrainManager.setImageryLayerVisible(id,false),nativeLayer.id),'optional native layer visibility control must succeed');
  const hidden=await settle(.05,'imagery-unlit');await page.screenshot({path:join(out,'hidden.png')});assert.deepEqual(hidden.geometryIds,before.geometryIds,'visibility changed physical terrain geometry');
  assert.equal(hidden.layers.find(l=>l.id===nativeLayer.id).visible,false);
  assert(hidden.imagery.maxDisplayedLevel<near.imagery.maxDisplayedLevel,'hiding native detail must reveal the coarser context');
  await page.evaluate(id=>{const tm=window.pilot.getRenderer().getBodyMesh('Mars').terrainManager;tm.setImageryLayerVisible(id,true);tm.setImageryLayerOpacity(id,1);},nativeLayer.id);
  const restored=await settle(.05,'imagery-unlit');assert.equal(restored.layers.find(l=>l.id===nativeLayer.id).visible,true);assert.equal(restored.layers.find(l=>l.id===nativeLayer.id).opacity,1);assert.deepEqual(restored.geometryIds,before.geometryIds);await page.screenshot({path:join(out,'restored.png')});
  const shaded=await settle(.05,'none');await page.screenshot({path:join(out,'shaded.png')});
  assert.deepEqual(errors,[]);
  const evidence={buildId:report.buildId,environment,physicalGpu:!(/swiftshader|llvmpipe/i.test(environment.renderer)),results,opacity:faded,hidden,restored,shaded,errors,
    limits:['Desktop browser only; no real mobile hardware acceptance.','Shared-provenance source registration is not independent absolute geolocation certification.','No production catalog or mission placement was changed.']};
  await writeFile(join(out,'browser.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({buildId:report.buildId,environment,nearImageLevel:near.imagery.maxDisplayedLevel,nearTerrainLevels:near.levels,errors}));
} finally {await browser.close();}
