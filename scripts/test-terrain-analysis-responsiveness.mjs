/** #363 real 72-flight terrain workload. Native baseline by default; paid UI opt-in. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { checkAnswer } from '../packages/control/dist/answer-check.js';
import { chromium } from 'playwright';
const base=process.env.CL_VIEWER_URL??'http://127.0.0.1:5202/';
const output=process.env.TERRAIN_PERF_REPORT??'/tmp/terrain-analysis-perf.json';
const live=process.env.TERRAIN_PERF_LIVE==='1', complete=process.env.TERRAIN_PERF_COMPLETE==='1';
const prompt='show me the highest altitude (above terrain) that ingenuity got to and fly to ingenuity at that point in time.';
const usage=[];let proxy;
if(live) {
  assert.ok(process.env.ANTHROPIC_API_KEY);
  const {createProxy,anthropicProvider}=await import('../examples/ask-proxy/server.mjs');
  const model='claude-haiku-5-5';
  proxy=createProxy({apiKey:process.env.ANTHROPIC_API_KEY,origins:[new URL(base).origin],provider:anthropicProvider,model,escalationModel:model,fallback:false,maxTokens:1536,tokenBudget:1200000,costBudgetUsd:1,perMinute:100,
    fetchImpl:(url,options)=>{assert.equal(JSON.parse(options.body).model,model);return fetch(url,options);},
    onUsage:row=>{assert.equal(row.model,model);assert.equal(row.requestedModel,model);usage.push(row);console.log('Haiku round',usage.length);}});
  await new Promise(resolve=>proxy.listen(8797,'127.0.0.1',resolve));
}
const gpu=process.env.TERRAIN_PERF_GPU??(process.platform==='darwin'?'metal':'swiftshader');
const browser=await chromium.launch({headless:true,args:[`--use-angle=${gpu}`,...(gpu==='swiftshader'?['--enable-unsafe-swiftshader']:[]),'--disable-background-timer-throttling','--disable-renderer-backgrounding']});
try {
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  const errors=[],payloads=new Map();page.on('pageerror',e=>errors.push(e.message));
  if(live)page.on('request',request=>{if(request.url()==='http://127.0.0.1:8797/' && request.method()==='POST')for(const m of request.postDataJSON().messages)for(const b of m.content)if(b.type==='tool_result')payloads.set(b.toolUseId,b.content);});
  await page.goto(new URL('?catalog=test-catalogs/ingenuity-jezero',base).href);
  await page.waitForFunction(()=>window.cosmo?.getScene()?.ready,null,{timeout:600000});
  await page.evaluate(async()=>{
    window.cosmo.setPlaying(false);
    const resource=path=>performance.getEntriesByType('resource').map(e=>e.name).find(u=>new URL(u).pathname===path);
    window.__terrainState=await import(resource('/src/lib/viewer-state.svelte.ts'));
    window.__terrainTask=await import(resource('/src/lib/trajectory-analysis.svelte.ts'));
    window.__terrainAnalysis=await import(resource('/src/lib/analysis.svelte.ts'));
    window.__terrainShell=await import(resource('/src/lib/shell.svelte.ts'));
    window.__terrainAsk=await import(resource('/src/lib/ask/ask.svelte.ts'));
  });
  // Warm ordinary renderer/imagery activation in both baseline and changed runs.
  await new Promise(resolve=>setTimeout(resolve,30000));
  if(live)await page.evaluate(()=>window.__terrainShell.openTool('ask'));
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');await cdp.send('Profiler.start');
  await page.evaluate(()=>{
    const gl=document.querySelector('canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');
    const p=window.__terrainPerf={renderer:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),started:performance.now(),calls:0,tasks:[],beats:[],frames:[],progress:[],sampleMs:[],interactions:[],done:false};
    const body=window.__terrainState.getRenderer().getBodyMesh('Mars'),original=body.requestTerrainAnalysisSample;
    body.requestTerrainAnalysisSample=async function(...args){
      if(!p.calls)p.analysisStart=performance.now();p.calls++;const start=performance.now();
      try{return await original.apply(this,args)}finally{p.lastTerrainEnd=performance.now();p.maxSampleMs=Math.max(p.maxSampleMs??0,p.lastTerrainEnd-start)}
    };
    window.__terrainObserver=new PerformanceObserver(l=>p.tasks.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));
    window.__terrainObserver.observe({type:'longtask'});
    let last=performance.now();window.__terrainTimer=setInterval(()=>{const now=performance.now();p.beats.push({time:now,ms:now-last});last=now},20);
    let frame=performance.now();const raf=now=>{p.frames.push({time:now,ms:now-frame});frame=now;if(!p.done)requestAnimationFrame(raf)};requestAnimationFrame(raf);
  });
  if(live){
    await page.getByRole('textbox',{name:'Request',exact:true}).fill(prompt);
    await page.getByRole('button',{name:'Send request',exact:true}).click();
  } else await page.evaluate(()=>{
    window.__terrainAbort=new AbortController();
    window.__terrainWork=window.__terrainTask.analyzeTrajectoryExtrema({objects:['Ingenuity'],metric:'terrain-clearance',extremum:'maximum',scope:{kind:'activities',activityKind:'flight'}},
      {signal:window.__terrainAbort.signal,onProgress:f=>window.__terrainPerf.progress.push([performance.now(),f])})
      .then(r=>{window.__terrainPerf.result=r;window.__terrainPerf.done=true;window.__terrainPerf.finished=performance.now()});
  });
  try {
    await page.waitForFunction(live=>window.__terrainPerf.calls>100 || live && window.__terrainAsk.ask.turns.length && !window.__terrainAsk.ask.running,live,{timeout:180000});
    assert.ok(await page.evaluate(()=>window.__terrainPerf.calls>100),'Ask ended before terrain computation');
  }
  catch(error){
    const failure=await page.evaluate(()=>({perf:window.__terrainPerf,turn:window.__terrainAsk.ask.turns.at(-1)}));
    writeFileSync(output,JSON.stringify({failure,errors,usage},null,2));
    console.log(JSON.stringify({calls:failure.perf.calls,turn:failure.turn}));throw error;
  }
  console.log('terrain computation active');
  let stopMs=null;
  if(!complete){
    await new Promise(resolve=>setTimeout(resolve,10000));
    if(live){
      const before=await page.evaluate(()=>({et:window.cosmo.getTime(),camera:window.cosmo.getCamera()}));
      const time=Date.now();await page.getByRole('button',{name:'Step forward',exact:true}).click();
      const timelineMs=Date.now()-time;
      await page.mouse.move(400,350);await page.mouse.down();await page.mouse.move(420,360,{steps:4});await page.mouse.up();
      const camera=await page.evaluate(()=>window.cosmo.getCamera());
      const input=page.getByRole('textbox',{name:'Request',exact:true});await input.fill('Responsiveness check');
      assert.equal(await input.inputValue(),'Responsiveness check');
      assert.notDeepEqual(camera,before.camera);
      assert.notEqual(await page.evaluate(()=>window.cosmo.getTime()),before.et);
      await page.evaluate(ms=>window.__terrainPerf.interactions.push({timelineMs:ms,cameraChanged:true,textInput:true}),timelineMs);
    }
    const start=Date.now();
    if(live)await page.getByRole('button',{name:'Stop request',exact:true}).click();
    else await page.evaluate(()=>window.__terrainAbort.abort());
    await page.waitForFunction(live=>live?!window.__terrainAsk.ask.running:window.__terrainPerf.done,live,{timeout:60000});
    stopMs=Date.now()-start;
    const callsAtStop=await page.evaluate(()=>window.__terrainPerf.calls);
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(await page.evaluate(()=>window.__terrainPerf.calls),callsAtStop,'No terrain evaluations may continue after Stop');
  } else await page.waitForFunction(live=>live?!window.__terrainAsk.ask.running:window.__terrainPerf.done,live,{timeout:900000});
  const report=await page.evaluate(live=>{
    const p=window.__terrainPerf;p.done=true;p.finished??=performance.now();clearInterval(window.__terrainTimer);window.__terrainObserver.disconnect();
    if(live){const t=window.__terrainAsk.ask.turns.at(-1);p.turn={status:t.status,reply:t.reply,error:t.error,stats:t.stats,steps:t.steps,result:t.result};}
    p.results=Object.values(window.__terrainAnalysis.analysis.eventResults).flat().filter(e=>e.trajectoryAnalysis).map(e=>e.trajectoryAnalysis);
    p.activities=window.cosmo.listActivities().filter(a=>a.vehicle==='Ingenuity'&&a.kind==='flight'&&a.enabled!==false).map(a=>a.id);
    p.state={et:window.cosmo.getTime(),selected:window.cosmo.getSelected(),tracked:window.cosmo.getTracked(),playing:window.cosmo.isPlaying(),camera:window.cosmo.getCamera()};return p;
  },live);
  const {profile}=await cdp.send('Profiler.stop');writeFileSync(output+'.cpuprofile',JSON.stringify(profile));
  const hot=new Map();for(const n of profile.nodes)if(n.hitCount)hot.set(n.callFrame.functionName,(hot.get(n.callFrame.functionName)??0)+n.hitCount);
  report.hot=[...hot].sort((a,b)=>b[1]-a[1]).slice(0,16);report.stopMs=stopMs;report.errors=errors;report.usage=usage;
  const beats=report.beats.filter(b=>b.time>=report.analysisStart).map(b=>b.ms);
  const frames=report.frames.filter(b=>b.time>=report.analysisStart).map(b=>b.ms);
  report.summary={maxCalculationTaskMs:Math.max(0,...report.tasks.filter(t=>t.start>=report.analysisStart && t.start<=report.lastTerrainEnd).map(t=>t.duration)),maxCalculationHeartbeatMs:Math.max(0,...report.beats.filter(b=>b.time>=report.analysisStart && b.time<=report.lastTerrainEnd).map(b=>b.ms)),calculationMs:report.lastTerrainEnd-report.analysisStart,calls:report.calls,analysisMs:report.finished-report.analysisStart,maxTaskMs:Math.max(0,...report.tasks.filter(t=>t.start>=report.analysisStart).map(t=>t.duration)),maxHeartbeatMs:Math.max(0,...beats),p95FrameMs:frames.sort((a,b)=>a-b)[Math.floor(frames.length*.95)],stopMs,compared:report.results.length};
  writeFileSync(output,JSON.stringify(report,null,2));
  if(complete){
    assert.equal(report.activities.length,72);assert.equal(report.results.length,72);
    assert.ok(report.activities.every(id=>report.results.some(r=>r.activityId===id)));
    const best=report.results.reduce((a,b)=>b.value>a.value?b:a);report.best=best;
    assert.equal(best.metric,'heightAbovePhysicalTerrain');assert.ok(best.terrain?.id&&best.terrain?.revision);
    // Independent physical ray/control at the returned epoch, not another extrema call.
    report.control=await page.evaluate(async best=>{
      const s=window.cosmo.getObjectState(best.object,{center:best.body,frame:best.frame,time:{kind:'et',et:best.et}});
      const mesh=window.__terrainState.getRenderer().getBodyMesh('Mars');
      const resource=performance.getEntriesByType('resource').map(e=>e.name).find(u=>new URL(u).pathname.endsWith('/packages/three/src/TerrainSampler.ts'));
      const {bodyFixedToGeodetic,geodeticToBodyFixed}=await import(resource);
      const g=bodyFixedToGeodetic({xKm:s.position[0],yKm:s.position[1],zKm:s.position[2]},mesh.terrainDatum);
      const above=geodeticToBodyFixed({...g,heightKm:g.heightKm+1},mesh.terrainDatum);
      const below=geodeticToBodyFixed({...g,heightKm:g.heightKm-10},mesh.terrainDatum);
      const hit=mesh.intersectTerrainRay({origin:above,direction:[below.xKm-above.xKm,below.yKm-above.yKm,below.zKm-above.zKm],nearKm:0,farKm:10},{maxMeshErrorKm:0});
      return {hit,value:hit?.kind==='hit'?hit.distanceKm-1:null};
    },best);
    assert.ok(Math.abs(report.control.value-best.value)<1e-7);
    if(live){
      assert.deepEqual(checkAnswer(report.turn.reply,report.turn.result.facts),[]);
      assert.match(report.turn.reply,/72/);assert.match(report.turn.reply,/17/);assert.match(report.turn.reply,/gap|partial|incomplet/i);
      for(const step of report.turn.steps.filter(s=>s.result?.data)){assert.ok(payloads.has(step.id));assert.ok(!payloads.get(step.id).includes('result-too-large'));}
      assert.equal(report.turn.status,'done');assert.equal(report.state.et,best.et);assert.equal(report.state.tracked,'Ingenuity');assert.equal(report.state.playing,false);}
  }else if(live)assert.equal(report.turn.status,'cancelled');else assert.equal(report.result.status,'cancelled');
  writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report.summary));
  if(process.env.TERRAIN_PERF_ASSERT==='1'){assert.ok(report.summary.maxTaskMs<100);assert.ok(report.summary.maxCalculationTaskMs<100);assert.ok(report.summary.maxCalculationHeartbeatMs<100);assert.ok(report.summary.maxHeartbeatMs<200);if(stopMs!==null)assert.ok(stopMs<300);}
  assert.deepEqual(errors,[]);
  await page.screenshot({path:output+'.png'});
}finally{await browser.close();if(proxy)await new Promise(resolve=>proxy.close(resolve));}
