/** Real mission acceptance for native raster density and hardware AA: no neighborhood postfilter.
 * CSS screenshots show the actual low-DPI presentation, not just large PNGs.
 * node scripts/test-render-density.mjs URL OUTPUT
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import sharp from 'sharp';
const base=process.argv[2]??'http://127.0.0.1:5174/';
const out=process.argv[3]??'work/ingenuity-246/review-followup/raster-density';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),args:['--enable-gpu','--ignore-gpu-blocklist',process.platform==='darwin'?'--use-angle=metal':'--use-angle=swiftshader']});
const result={passed:false,views:[],densityChanges:[],errors:[]};
try{
 for(const [mission,body,et,lat,lon,altitude] of [
  ['moonfall-shackleton','Moon',913759610.9,-89.6,0,180],
  ['ingenuity-jezero','Mars',722439881.1,18.44486301,77.45101915,2],
 ])for(const dpr of [1,2]){
  const page=await browser.newPage({viewport:{width:1000,height:800},deviceScaleFactor:dpr});
  page.on('pageerror',e=>result.errors.push(e.message));
  page.on('console',m=>{if(/GL_INVALID|INVALID_OPERATION|Shader Error/.test(m.text()))result.errors.push(m.text());});
  await page.goto(`${base}?catalog=test-catalogs/${mission}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(body=>window.renderer?.getBodyMesh(body)?.terrainManager?.cubeImageryStats?.version,body,{timeout:120000});
  await page.evaluate(async({body,et,lat,lon,altitude})=>{
   const r=window.renderer;await r.waitForInitialAssets();window.cosmo.setPlaying(false);window.cosmo.untrack();r.timeController.setTime(et);r.renderFrame();
   const b=r.getBodyMesh(body),V=r.camera.position.constructor,centre=new V();b.getWorldPosition(centre);
   const a=lat*Math.PI/180,o=lon*Math.PI/180,d=[Math.cos(a)*Math.cos(o),Math.cos(a)*Math.sin(o),Math.sin(a)],radius=b.terrainManager.bodyRadiusKm;
   const world=([x,y,z])=>new V(x,z,-y).applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
   r.cameraController.controls.staticMoving=true;r.cameraController.controls.target.copy(world(d.map(v=>v*radius)));r.camera.position.copy(world(d.map(v=>v*(radius+altitude))));
   r.camera.up.copy(world([-Math.sin(a)*Math.cos(o),-Math.sin(a)*Math.sin(o),Math.cos(a)]).sub(centre).normalize());
   r.camera.fov=60;r.camera.updateProjectionMatrix();r.camera.lookAt(r.cameraController.controls.target);r.camera.updateMatrixWorld(true);
   if(body==='Moon'){r.setLabelPinned('Polaris-C',true);r.setLabelPinned('Polaris-D',true);}
  },{body,et,lat,lon,altitude});
  await page.waitForFunction(body=>{
   const t=window.renderer.getBodyMesh(body).terrainManager,n=t.metrics.network,i=t.cubeImageryStats;
   return n.queued+n.downloading+n.parsing+i.queued+i.inFlight===0||i.budgetLimited;
  },body,{timeout:120000});await page.waitForTimeout(1200);
  const frame=await page.evaluate(body=>{
   const r=window.renderer,w=r.getContext().webglRenderer,g=w.getContext(),dbg=g.getExtension('WEBGL_debug_renderer_info');r.renderFrame();
   return{image:w.domElement.toDataURL(),gpu:g.getParameter(dbg?dbg.UNMASKED_RENDERER_WEBGL:g.RENDERER),glError:g.getError(),samples:g.getParameter(g.SAMPLES),
    dpr:window.devicePixelRatio,rasterDensity:w.getPixelRatio(),width:w.domElement.width,height:w.domElement.height,cssWidth:w.domElement.clientWidth,cssHeight:w.domElement.clientHeight,
    labels:[...r.labelManager.labels].filter(([,e])=>e.sprite.visible&&e.sprite.material.opacity>.05).map(([name,e])=>({name,layer:e.sprite.layers.mask,fontSize:e.texFontSize})),
    imagery:r.getBodyMesh(body).terrainManager.cubeImageryStats};
  },body);
  const key=`${mission}-dpr${dpr}`,bytes=Buffer.from(frame.image.split(',')[1],'base64');delete frame.image;
  await writeFile(`${out}/${key}-raster.png`,bytes);
  await page.locator('canvas').first().screenshot({path:`${out}/${key}-display.png`});
  const stats=await sharp(bytes).stats();assert.ok(stats.channels[0].stdev>3);
  assert.ok(frame.samples>0);assert.equal(frame.rasterDensity,dpr);assert.equal(frame.width,frame.cssWidth*dpr);assert.equal(frame.height,frame.cssHeight*dpr);
  assert.equal(frame.glError,0);assert.equal(frame.imagery.baseUncoveredBlocks,0);assert.equal(frame.imagery.extraDraws,0);
  assert.doesNotMatch(frame.gpu,/swiftshader|software|llvmpipe/i);assert.ok(frame.labels.length>0);assert.ok(frame.labels.every(l=>l.layer===1<<2));
  // Paired CPU + synchronized full-frame cost. Includes gl.finish overhead;
  // not an isolated GPU timer. No other test/browser runs concurrently.
  if(dpr===1){
   frame.timing=await page.evaluate(()=>{
    const r=window.renderer,w=r.getContext().webglRenderer,g=w.getContext(),rows=[];
    const summary=a=>{a.sort((x,y)=>x-y);return{n:a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],max:a.at(-1)};};
    for(const density of [1,2,1,2]){
     w.setPixelRatio(density);for(let n=0;n<3;n++){r.renderFrame();g.finish();}
     const cpu=[],total=[];
     for(let n=0;n<25;n++){const start=performance.now();r.renderFrame();cpu.push(performance.now()-start);g.finish();total.push(performance.now()-start);}
     rows.push({density,cpuMs:summary(cpu),cpuAndGpuSynchronizedMs:summary(total)});
    }
    return{method:'25 frames per alternating density; gl.finish after each',rows,glError:g.getError()};
   });assert.equal(frame.timing.glError,0);
   const cdp=await page.context().newCDPSession(page);
   for(const nextDpr of [2,1]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1000,height:800,deviceScaleFactor:nextDpr,mobile:false});
    // This Chrome CDP override changes matches/DPR but does not emit a native
    // MediaQueryList change event. Inject that event, not the renderer handler.
    await page.evaluate(()=>{const q=window.renderer._dprMediaQuery;q.dispatchEvent(new MediaQueryListEvent('change',{media:q.media,matches:q.matches}));});
    await page.waitForFunction(dpr=>window.devicePixelRatio===dpr&&window.renderer.getContext().webglRenderer.getPixelRatio()===dpr&&window.renderer._dprMediaQuery.matches,nextDpr);
    result.densityChanges.push({mission,event:'Injected MediaQueryList change after CDP DPR override',deviceDpr:nextDpr,rasterDensity:await page.evaluate(()=>window.renderer.getContext().webglRenderer.getPixelRatio())});
   }
  }
  result.views.push({mission,...frame});console.log({mission,dpr,density:frame.rasterDensity,labels:frame.labels});await page.close();
 }
 // antialias:false remains a genuine native-resolution opt-out.
 const page=await browser.newPage({viewport:{width:800,height:600},deviceScaleFactor:1});
 await page.goto(`${base}?catalog=test-catalogs/moonfall-shackleton&test=1`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.renderer?.getContext().webglRenderer.getPixelRatio()===1,null,{timeout:120000});
 result.optOut=await page.evaluate(()=>({density:window.renderer.getContext().webglRenderer.getPixelRatio(),samples:window.renderer.getContext().webglRenderer.getContext().getParameter(window.renderer.getContext().webglRenderer.getContext().SAMPLES)}));
 assert.equal(result.optOut.density,1);assert.equal(result.optOut.samples,0);await page.close();
 assert.deepEqual(result.errors,[]);result.passed=true;
}finally{await writeFile(`${out}/metrics.json`,JSON.stringify(result,null,2)+'\n');await browser.close();}
