/** Actual default mission trajectory visibility and physical occlusion.
 * Deliberately below-surface poses bypass only the camera clamp, explicitly;
 * ordinary poses retain it. Continuous video and exact-canvas toggle A/B.
 */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import sharp from 'sharp';
const base=process.argv[2]??'http://localhost:5173/',out=process.argv[3]??'work/ingenuity-246/review-followup/trajectory-visual';await mkdir(out,{recursive:true});
const fading=process.argv.includes('--fading'),events=process.argv.includes('--events');
const index=JSON.parse(await readFile('apps/viewer/test-catalogs/data/ingenuity/flights_index.json','utf8'));
const browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),args:['--enable-gpu','--ignore-gpu-blocklist',process.platform==='darwin'?'--use-angle=metal':'--use-angle=swiftshader']});
const context=await browser.newContext({viewport:{width:1440,height:900},recordVideo:{dir:out,size:{width:1440,height:900}}}),page=await context.newPage(),report={estimated:true,passed:false,phases:[],errors:[]};
page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(/GL_INVALID|INVALID_OPERATION|Shader Error/.test(m.text()))report.errors.push(m.text());});
try{
 await page.goto(`${base}?catalog=test-catalogs/ingenuity-jezero`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.renderer?.getBodyMesh('Mars')?.terrainManager?.cubeImageryStats?.version,null,{timeout:120000});
 await page.evaluate(async()=>{await window.renderer.waitForInitialAssets();window.cosmo.setPlaying(false);window.cosmo.untrack();window.savedTrajectoryClamp=window.renderer.clampCameraAboveSurfaces;});
 for(const flight of fading||events?[12]:[1,12,72])for(const fraction of fading||events?[.5]:[.02,.5,.98,2]){
  const entry=index[flight-1],et=fraction===2?entry.etEnd+600:entry.etStart+(entry.etEnd-entry.etStart)*fraction;
  for(const below of fraction===.5?[false,true]:[false]){
   const key=`f${flight}-${fraction}-${below?'below':'above'}`;
   await page.evaluate(async({flight,et,below})=>{
    const r=window.renderer;r.clampCameraAboveSurfaces=window.savedTrajectoryClamp;r.timeController.setTime(et);r.renderFrame();
    const b=r.getBodyMesh('Mars'),t=b.terrainManager,arc=r.universe.getBody('Ingenuity').trajectory.arcs[flight-1],p=arc.trajectory.stateAt(et).position,d=p.map(v=>v/Math.hypot(...p)),la=Math.atan2(d[2],Math.hypot(d[0],d[1])),lo=Math.atan2(d[1],d[0]),outer=t.bodyRadiusKm+50;
    const ray={origin:{xKm:d[0]*outer,yKm:d[1]*outer,zKm:d[2]*outer},direction:d.map(v=>-v),nearKm:0,farKm:150};
    await t.cube.surface.ensureRayCoverage(ray,{maxMeshErrorKm:0},AbortSignal.timeout(30000));const hit=b.intersectTerrainRay(ray,{maxMeshErrorKm:0});if(hit.kind!=='hit')throw Error('No physical ground');
    const V=r.camera.position.constructor,centre=new V();b.getWorldPosition(centre);const world=([x,y,z])=>new V(x,z,-y).applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
    const target=world(p),ground=world([hit.position.xKm,hit.position.yKm,hit.position.zKm]),up=world(d).sub(centre).normalize(),north=world([-Math.sin(la)*Math.cos(lo),-Math.sin(la)*Math.sin(lo),Math.cos(la)]).sub(centre).normalize();
    if(below)r.clampCameraAboveSurfaces=()=>false;
    r.cameraController.controls.staticMoving=true;r.cameraController.controls.target.copy(target);r.camera.position.copy(ground).addScaledVector(up,(below?-.02:.05)*r.scaleFactor).addScaledVector(north,-.1*r.scaleFactor);r.camera.up.copy(up);r.camera.fov=60;r.camera.updateProjectionMatrix();r.camera.lookAt(target);r.camera.updateMatrixWorld(true);
   },{flight,et,below});
   await page.waitForFunction(()=>{const t=window.renderer.getBodyMesh('Mars').terrainManager,n=t.metrics.network,i=t.cubeImageryStats;return n.queued+n.downloading+n.parsing+i.queued+i.inFlight===0||i.budgetLimited;},null,{timeout:45000}).catch(async error=>{report.settleFailure=await page.evaluate(()=>{const r=window.renderer,t=r.getBodyMesh('Mars').terrainManager;return{network:t.metrics.network,imagery:t.cubeImageryStats,camera:r.camera.position.toArray(),et:r.timeController.et,entries:[...t.cubeImageryLayer.entries].map(([k,e])=>({k,state:e.state,refs:e.refs,protected:e.protected,lastUsed:e.lastUsed})),};});throw error;});await page.waitForTimeout(500);
   if(events)await page.evaluate(et=>{const event={id:'plot-test',queryId:'plot-query',kind:'distance-range',temporality:'interval',start:et-2,end:et,bodies:{observer:'Ingenuity'},label:'Estimated flight context (test)'};window.renderer.setEventResults([event],event);},et);
   if(fading)await page.evaluate(()=>{const t=window.renderer.getBodyMesh('Mars').terrainTileGroup;t.traverse(o=>{if(o.isMesh){const original=o.onBeforeRender;o.onBeforeRender=function(...args){original.apply(this,args);for(const m of Array.isArray(o.material)?o.material:[o.material]){m.depthWrite=false;m.transparent=true;m.opacity=.3;}};}});});
   const capture=async visible=>{
    await page.evaluate(visible=>window.renderer.setTrajectoryVisible('Ingenuity',visible),visible);await page.waitForTimeout(350);
    return page.evaluate(()=>{const r=window.renderer;r.renderFrame();const gl=r.getContext().webglRenderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return{eventGroups:r.eventMarkerGroups.size,eventAnchorErrors:[...r.eventMarkerGroups.values()].map(({markers,line})=>{const et=r.timeController.et-1,p=line.positionAt(et);const expected=line.localToWorld(new r.camera.position.constructor(...p).multiplyScalar(r.scaleFactor)),anchor=markers.anchorAt('plot-test','plot-query',et);return anchor?anchor.distanceTo(expected)/r.scaleFactor*1000:null;}),fadingDepthMeshes:r.overlaySurfaceDepth.scene.children.length,image:r.getContext().webglRenderer.domElement.toDataURL(),gpu:gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER),glError:gl.getError(),visibleArcs:[...r.trajectoryLines].filter(([id,l])=>id.startsWith('Ingenuity')&&l.visible&&l.drawnPath().some(run=>run.count>1)).map(([id,l])=>({id,trailDurationS:l.trailDuration,drawnVertices:l.drawnTrail().count,headWorld:l.localToWorld(new r.camera.position.constructor(...l.positionAt(r.timeController.et)).multiplyScalar(r.scaleFactor)).toArray(),bodyWorld:r.getBodyMesh('Ingenuity').position.toArray(),material:{opacity:l.trailLine.material.opacity,depthTest:l.trailLine.material.depthTest},drawnHead:Array.from(l.drawnTrail().positions.slice(Math.max(0,l.drawnTrail().count-1)*3,l.drawnTrail().count*3))})),imagery:r.getBodyMesh('Mars').terrainManager.cubeImageryStats,clampCorrectionKm:r.cameraClampCorrectionKm};});
   };
   const on=await capture(true);await page.screenshot({path:`${out}/${key}-on.png`});const off=await capture(false);await page.screenshot({path:`${out}/${key}-off.png`});
   const pixels=async s=>sharp(Buffer.from(s.split(',')[1],'base64')).removeAlpha().raw().toBuffer(),a=await pixels(on.image),b=await pixels(off.image);let changed=0,maximum=0,nonBlack=0;for(let j=0;j<a.length;j+=3){const difference=Math.max(Math.abs(a[j]-b[j]),Math.abs(a[j+1]-b[j+1]),Math.abs(a[j+2]-b[j+2]));if(a[j]+a[j+1]+a[j+2]>15)nonBlack++;if(difference>2)changed++;maximum=Math.max(maximum,difference);}
   assert.ok(nonBlack>a.length/30,'Canvas capture is empty/discarded');delete on.image;delete off.image;const row={flight,fraction,et,below,deliberateClampBypass:below,fadingFixture:fading,changedPixels:changed,maximumChannelDifference:maximum,on,off};report.phases.push(row);await writeFile(`${out}/metrics.json`,JSON.stringify(report,null,2));
   assert.ok(on.visibleArcs.length<=1,'Unrelated historical arcs remain visible');assert.equal(off.visibleArcs.length,0);assert.equal(on.glError,0);assert.equal(off.glError,0);assert.doesNotMatch(on.gpu,/SwiftShader|llvmpipe/i);
   if(fraction===2)assert.equal(on.visibleArcs.length,0,'Parked interval retains a historical trail');
   if(events){assert.equal(on.eventGroups,1);assert.ok(on.eventAnchorErrors.every(e=>e!=null&&e<.05),'Event span is detached from its transformed plot');}
   if(fading)assert.ok(on.fadingDepthMeshes>0,'Fading fixture did not exercise the physical depth pass');
   if(below)assert.equal(changed,0,'Estimated flight path leaks through the actual physical surface');
   if(!below&&fraction===.5)assert.ok(changed>0,'Above-ground flight path is not readable');
   console.log(key,changed,on.visibleArcs);
  }
 }
 assert.deepEqual(report.errors,[]);report.passed=true;
}finally{await writeFile(`${out}/metrics.json`,JSON.stringify(report,null,2));await context.close();await browser.close();}
