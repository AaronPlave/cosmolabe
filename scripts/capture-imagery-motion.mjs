/** Continuous actual-mission GPU recordings: cold zoom/orbit/reversal and
 * repeat visit, normal + level-debug. MoonFall repeats at accelerated speed.
 * Camera poses are scripted continuously for comparable normal/debug movies;
 * native mouse/key navigation is covered by the separate motion regressions.
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const base=process.argv[2]??'http://localhost:5173/',out=process.argv[3]??'work/ingenuity-246/review-followup/motion';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),args:['--enable-gpu','--ignore-gpu-blocklist',process.platform==='darwin'?'--use-angle=metal':'--use-angle=swiftshader']});
const result={passed:false,method:'Continuous scripted camera path; default mission sources and opacity/order; recorded cold loading plus repeat; no artificial crossfade.',movies:[]};
try{
 for(const [mission,body,lat,lon,distances]of[
  ['ingenuity-jezero','Mars',18.44486301,77.45101915,[30,2,.5,2,30,2,.5,30]],
  ['moonfall-shackleton','Moon',-89.98,120,[200,20,2,20,200,20,2,200]],
 ])for(const debug of[false,true]){
  const key=`${mission}-${debug?'levels':'normal'}`,dir=`${out}/${key}`;await mkdir(dir,{recursive:true});
  const context=await browser.newContext({viewport:{width:1440,height:900},recordVideo:{dir,size:{width:1440,height:900}}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(/GL_INVALID|INVALID_OPERATION|Shader Error|WebGL:.*(?:error|warning)/i.test(m.text()))errors.push(m.text());});
  await page.goto(`${base}?catalog=test-catalogs/${mission}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(body=>window.renderer?.getBodyMesh(body)?.terrainManager?.cubeImageryStats?.version,body,{timeout:120000});
  const data=await page.evaluate(async({body,lat,lon,distances,debug})=>{
   const r=window.renderer;await r.waitForInitialAssets();window.cosmo.setPlaying(false);window.cosmo.untrack();
   const b=r.getBodyMesh(body),t=b.terrainManager,V=r.camera.position.constructor;
   const la=lat*Math.PI/180,lo=lon*Math.PI/180,d=[Math.cos(la)*Math.cos(lo),Math.cos(la)*Math.sin(lo),Math.sin(la)],outer=t.bodyRadiusKm+50;
   const ray={origin:{xKm:d[0]*outer,yKm:d[1]*outer,zKm:d[2]*outer},direction:d.map(v=>-v),nearKm:0,farKm:150};
   await t.cube.surface.ensureRayCoverage(ray,{maxMeshErrorKm:0},AbortSignal.timeout(30000));const hit=b.intersectTerrainRay(ray,{maxMeshErrorKm:0});if(hit.kind!=='hit')throw Error('No physical surface');
   const radius=Math.hypot(hit.position.xKm,hit.position.yKm,hit.position.zKm),saved=r.renderFrame,frames=[],start=performance.now(),cycleSeconds=14,total=body==='Moon'?21:28;
   t.setDebugMode(debug?'imagery-level':'none');r.cameraController.controls.staticMoving=true;
   let last=start;
   r.renderFrame=function(...args){
    const now=performance.now(),seconds=(now-start)/1000,repeat=seconds>=cycleSeconds;
    const progress=repeat?(seconds-cycleSeconds)*(body==='Moon'?2:1):seconds;
    const phase=Math.min(distances.length-2,Math.floor(progress/2)),f=Math.min(1,(progress-phase*2)/2),ease=f*f*(3-2*f);
    const distance=Math.exp(Math.log(distances[phase])*(1-ease)+Math.log(distances[phase+1])*ease),tilt=.2+1.1*Math.sin(Math.PI*Math.min(1,progress/14))**2;
    const a=la+Math.sin(progress*.5)*.00005,o=lo+Math.sin(progress*.7)*.00005,dir=[Math.cos(a)*Math.cos(o),Math.cos(a)*Math.sin(o),Math.sin(a)];
    const centre=new V();b.getWorldPosition(centre);const world=([x,y,z])=>new V(x,z,-y).applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
    const target=world(dir.map(v=>v*radius)),up=world([-Math.sin(a)*Math.cos(o),-Math.sin(a)*Math.sin(o),Math.cos(a)]).sub(centre).normalize(),normal=world(dir).sub(centre).normalize();
    r.cameraController.controls.target.copy(target);r.camera.position.copy(target).addScaledVector(normal,distance*r.scaleFactor*Math.cos(tilt)).addScaledVector(up,-distance*r.scaleFactor*Math.sin(tilt));r.camera.up.copy(up);r.camera.fov=60;r.camera.updateProjectionMatrix();r.camera.lookAt(target);r.camera.updateMatrixWorld(true);
    const answer=saved.apply(this,args);frames.push({seconds,repeat,distanceKm:distance,tiltRad:tilt,intervalMs:now-last,imagery:t.cubeImageryStats});last=now;return answer;
   };
   try{while(performance.now()-start<total*1000)await new Promise(requestAnimationFrame);}finally{r.renderFrame=saved;window.cosmo.setPlaying(false);}
   const gl=r.getContext().webglRenderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
   return{frames,gpu:gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER),glError:gl.getError(),layers:t.imageryLayers.map(l=>({id:l.id,visible:l.visible,opacity:l.opacity})),videoMotionStartMs:start};
  },{body,lat,lon,distances,debug});
  assert.doesNotMatch(data.gpu,/SwiftShader|llvmpipe/i);assert.equal(data.glError,0);assert.deepEqual(errors,[]);
  assert.ok(data.frames.length>300);assert.ok(data.frames.every(f=>f.imagery.extraDraws===0&&f.imagery.blockGeometryBytes===0));
  if(body==='Mars'){assert.equal(data.layers.length,4);assert.ok(data.layers.every(l=>l.visible&&l.opacity===1));}
  await page.screenshot({path:`${dir}/final.png`});const video=page.video();await context.close();
  await video.saveAs(`${out}/${key}.webm`);result.movies.push({mission,body,debug,errors,...data});
  await writeFile(`${out}/metrics.json`,JSON.stringify(result,null,2));console.log(key,data.frames.length);
 }
 result.passed=true;
}finally{await writeFile(`${out}/metrics.json`,JSON.stringify(result,null,2));await browser.close();}
