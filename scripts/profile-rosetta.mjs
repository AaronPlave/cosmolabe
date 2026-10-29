#!/usr/bin/env node
// No FPS assertions: compare reports on the same browser/hardware.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
const graphicsArgs = process.env.SOFTWARE_GL ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : os.platform() === 'darwin' ? ['--use-angle=metal'] : [];
const browser = await chromium.launch({ headless: process.env.HEADED !== '1', args: [...graphicsArgs, '--enable-precise-memory-info'] });
try {
  const constrained = process.env.CONSTRAINED === '1';
  const context = await browser.newContext({ viewport: constrained ? { width: 390, height: 844 } : { width: 1400, height: 900 }, deviceScaleFactor: constrained ? 2 : 1 });
  const page = await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  const testMode=process.env.LOAD_ONLY !== '1';
  const cdp = await context.newCDPSession(page);
  if (constrained) await cdp.send('Emulation.setCPUThrottlingRate', {rate:4});
  let responseBodyBytes = 0;
  const requests = [];
  context.on('requestfinished', request => { requests.push(request.sizes().then(s => {responseBodyBytes += s.responseBodySize;}).catch(()=>{})); });
  const start = performance.now();
  await page.goto(`${process.env.CL_VIEWER_URL ?? 'http://localhost:5180'}/?catalog=test-catalogs/rosetta${testMode ? '&test=1' : ''}`, {waitUntil:'domcontentloaded', timeout:120000});
  if(testMode) await page.waitForFunction(() => window.__cosmolabe?.assetsReady, null, { timeout: 240000 });
  else {
    await page.waitForFunction(() => window.renderer, null, {timeout:240000});
    await page.evaluate(()=>window.renderer.waitForInitialAssets());
  }
  const loadMs = performance.now() - start;
  console.error(`Assets ready in ${loadMs.toFixed(0)} ms`);
  if(!testMode) {
    const memory=await page.evaluate(()=>({heap:performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null,renderer:window.renderer.renderer.info.memory}));
    await Promise.all(requests);
    assert.deepEqual(errors,[]);
    const result={loadMs,constrained,responseBodyBytes,errors,...memory,cpu:os.cpus()[0].model,browser:browser.version(),mode:'normal viewer, fresh browser context, local server'};
    writeFileSync(process.env.PROFILE_OUTPUT ?? '/tmp/rosetta-load.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
    await browser.close();
    process.exit(0);
  }
  const report = await page.evaluate(async (native) => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const r = window.renderer;
    const gl = r.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    const stats = values => { const a = [...values].sort((a,b)=>a-b); return { max:a[a.length-1], mean: a.reduce((x,y)=>x+y,0)/a.length, median:a[Math.floor(a.length*.5)], p95:a[Math.min(a.length-1,Math.floor(a.length*.95))] }; };
    const original = r.bodyMeshes.get('67P/Churyumov-Gerasimenko').dskOccludes;
    const body = r.bodyMeshes.get('67P/Churyumov-Gerasimenko');
    if (native) for (const mesh of body.getDskMeshes()) mesh.raycast = T.Mesh.prototype.raycast;
    let cost=0, count=0;
    body.dskOccludes = function(...args) { const t=performance.now(); const value=original.apply(this,args); cost+=performance.now()-t; count++; return value; };
    const cases=[];
    for (const view of ['Impact at Sais (2016-09-30)', 'Philae final site, Abydos (2014-11-12)']) {
      window.__cosmolabe.capture(view);
      const vp=r.cameraController.getViewpoint(view);
      for (const factor of [1, .1]) {
        r.cameraController.applyViewpoint({...vp,position:vp.position.clone().multiplyScalar(factor)});
        window.__cosmolabe.capture();
        const origin=r.camera.position.clone(), target=body.position.clone();
        const cast=[];
        for(let i=0;i<40;i++) { const p=origin.clone().lerp(target, 0.8+i/80); const t=performance.now(); body.dskOccludes(origin,p); cast.push(performance.now()-t); }
        // Event-anchor stress uses the actual event occlusion path; synthetic test
        // anchors only, never injected into mission/event data.
        const event=[];
        for(let i=0;i<5;i++) { const t=performance.now(); for(let j=0;j<20;j++) r.eventAnchorOpacity(origin.clone().lerp(target,.8+j/40)); event.push(performance.now()-t); }
        cost=0;count=0;
        const frame=[]; let last=performance.now();
        for(let i=0;i<60;i++) { await new Promise(requestAnimationFrame); const now=performance.now();frame.push(now-last);last=now; }
        cases.push({view,factor,rayMs:stats(cast),twentyEventAnchorsMs:stats(event),frameMs:stats(frame),occlusionCalls:count,occlusionMs:cost,rotateSpeed:r.cameraController.controls.rotateSpeed,zoomSpeed:r.cameraController.controls.zoomSpeed});
      }
    }
    const ab = [];
    const frameCpu = [], gpuMs = [], pending = [];
    const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const frameOriginal = r.renderFrame;
    r.renderFrame = function(...args) {
      const q = timer ? gl.createQuery() : null;
      if(q) gl.beginQuery(timer.TIME_ELAPSED_EXT,q);
      const t=performance.now();
      const value=frameOriginal.apply(this,args);
      frameCpu.push(performance.now()-t);
      if(q) {gl.endQuery(timer.TIME_ELAPSED_EXT);pending.push(q);}
      for(let i=pending.length-1;i>=0;i--) if(gl.getQueryParameter(pending[i],gl.QUERY_RESULT_AVAILABLE)) {
        if(!gl.getParameter(timer.GPU_DISJOINT_EXT)) gpuMs.push(gl.getQueryParameter(pending[i],gl.QUERY_RESULT)/1e6);
        gl.deleteQuery(pending[i]);pending.splice(i,1);
      }
      return value;
    };
    const near='Philae final site, Abydos (2014-11-12)';
    window.__cosmolabe.capture(near);
    const fixtures=Array.from({length:20},(_,i)=>({id:`benchmark-${i}`,queryId:'benchmark-only',kind:'distance-range',temporality:'instant',et:r.timeController.et-60*(i+1),bodies:{observer:'Rosetta'},label:'Profiling fixture'}));
    for(const mode of ['normal','playing','labels-off','events-20','probe-hover','shape-hidden']) {
      r.timeController.pause();
      r.setLabelsVisible(mode!=='labels-off');
      r.setEventResults(mode==='events-20'?fixtures:[]);
      r.setPointProbeActive(mode==='probe-hover');
      body.userVisible=mode!=='shape-hidden';
      if(mode==='playing') r.timeController.play();
      frameCpu.length=0;gpuMs.length=0;cost=0;count=0;
      const frame=[];let last=performance.now();
      for(let i=0;i<40;i++) {
        if(mode==='probe-hover') r.renderer.domElement.dispatchEvent(new PointerEvent('pointermove',{clientX:innerWidth/2+i,clientY:innerHeight/2,pointerType:'mouse',bubbles:true}));
        await new Promise(requestAnimationFrame);const now=performance.now();frame.push(now-last);last=now;
      }
      ab.push({mode,frameMs:stats(frame),cpuMs:stats(frameCpu),gpuMs:gpuMs.length?stats(gpuMs):null,occlusionCalls:count,occlusionMs:cost,eventGroups:r.eventMarkerGroups.size});
    }
    body.userVisible=true;r.setLabelsVisible(true);r.setEventResults([]);r.setPointProbeActive(false);r.timeController.pause();
    r.renderFrame=frameOriginal;
    for(const q of pending) gl.deleteQuery(q);
    window.__navigationLatency=[];
    const measureInput = ()=>{
      const before=r.camera.matrixWorld.clone(), t=performance.now();
      const check=()=>{ if(!before.equals(r.camera.matrixWorld)) window.__navigationLatency.push(performance.now()-t); };
      requestAnimationFrame(check);
    };
    r.renderer.domElement.addEventListener('pointermove',measureInput);
    r.renderer.domElement.addEventListener('wheel',measureInput);
    return { cases, ab, gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,assets:window.__cosmolabe.assetSummary,heap:performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null,resources:performance.getEntriesByType('resource').reduce((s,e)=>s+e.transferSize,0) };
  }, process.env.NATIVE_DSK_RAYCAST === '1');
  const navigation=[];
  for (const gesture of ['orbit','pan','zoom']) {
    await page.mouse.move(constrained?195:700,450);
    const before=await page.evaluate(()=>{window.__navigationLatency=[];return window.renderer.camera.position.toArray();});
    if(gesture==='zoom') { for(let i=0;i<8;i++) {await page.mouse.wheel(0,-20);await page.waitForTimeout(20);} }
    else {await page.mouse.down({button:gesture==='pan'?'right':'left'});for(let i=0;i<12;i++) await page.mouse.move((constrained?195:700)+i*5,450+i*2,{steps:2});await page.mouse.up({button:gesture==='pan'?'right':'left'});}
    const after=await page.evaluate(()=>({position:window.renderer.camera.position.toArray(),latencyMs:window.__navigationLatency}));
    assert.notDeepEqual(after.position,before,`${gesture} must move the camera`);
    navigation.push({gesture,before,...after});
  }
  await Promise.all(requests);
  assert.deepEqual(errors,[]);
  if(process.env.PROFILE_SCREENSHOT) await page.screenshot({path:process.env.PROFILE_SCREENSHOT});
  const result={errors,constrained,responseBodyBytes,navigation,loadMs,cpu:os.cpus()[0].model,platform:os.platform(),browser:browser.version(),...report};
  writeFileSync(process.env.PROFILE_OUTPUT ?? '/tmp/rosetta-profile.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally { await browser.close(); }
