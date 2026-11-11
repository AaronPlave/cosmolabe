/** Same real 72-flight request through the routine used by Ask, native UI, and stored rerun.
 * No inference. Fresh browser context per cell; OS/network caches remain uncontrolled. */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
const base=process.env.CL_VIEWER_URL??'http://127.0.0.1:5202/';
const output=process.env.TRAJECTORY_PARITY_REPORT??'/tmp/trajectory-path-parity.json';
const browser=await chromium.launch({headless:true,args:[`--use-angle=${process.platform==='darwin'?'metal':'swiftshader'}`,'--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const reports=[];
try {
  for(const metric of ['terrain-clearance','reference-ellipsoid-height'])for(const path of ['ui','ask-operation','stored-rerun']) {
    if(process.env.TRAJECTORY_PARITY_CELLS&&!process.env.TRAJECTORY_PARITY_CELLS.split(',').includes(`${metric}:${path}`))continue;
    console.log('starting',metric,path);
    const context=await browser.newContext({viewport:{width:1400,height:900}}),page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(new URL('?catalog=test-catalogs/ingenuity-jezero',base).href);
    await page.waitForFunction(()=>window.cosmo?.getScene()?.ready,null,{timeout:600000});
    console.log('scene ready');
    await page.evaluate(async()=>{
      const resource=path=>performance.getEntriesByType('resource').map(e=>e.name).find(u=>new URL(u).pathname===path);
      window.__parity={};
      for(const [key,path]of Object.entries({state:'viewer-state.svelte',task:'trajectory-analysis.svelte',analysis:'analysis.svelte',finder:'event-finder.svelte',shell:'shell.svelte'}))window.__parity[key]=await import(resource(`/src/lib/${path}.ts`));
      window.cosmo.setPlaying(false);
    });
    await page.waitForTimeout(30000);
    // Resolve the same request without doing numerical work. The UI form uses
    // identical source, windows, metric, frame and adaptive settings.
    await page.evaluate(async({metric,path})=>{
      const p=window.__parity,universe=p.state.getSceneUniverse(),mesh=p.state.getRenderer().getBodyMesh('Mars');
      const acts=universe.activities.list().filter(a=>a.enabled!==false&&a.vehicle==='Ingenuity'&&a.kind==='flight');
      p.request={objects:['Ingenuity'],metric,extremum:'maximum',scope:{kind:'activities',activityKind:'flight'}};
      p.query={objects:['Ingenuity'],body:'Mars',frame:universe.frames.bodyFixedFrameFor('Mars'),metric:metric==='terrain-clearance'?'heightAbovePhysicalTerrain':'heightAboveReferenceEllipsoid',extremum:'maximum',reference:metric==='terrain-clearance'?mesh.terrainDatum.referenceShape:{kind:'ellipsoid',radiiKm:universe.getBody('Mars').radii},scope:{...p.request.scope,ids:acts.map(a=>a.id)},stepSeconds:.1,timeToleranceSeconds:.005,sampling:'adaptive',maxEvaluations:200000,...(metric==='terrain-clearance'?{terrain:{id:mesh.terrainSourceId,revision:mesh.terrainSourceRevision}}:{})};
      p.activities=acts.map(a=>({id:a.id,start:a.start,end:a.end}));
      if(path!=='ask-operation'){
        const item=p.analysis.createConfiguredEventQuery({kind:'trajectory-extremum',bodies:{center:'Mars',observer:'Ingenuity'},window:{start:Math.min(...acts.map(a=>a.start)),end:Math.max(...acts.map(a=>a.end))},step:.1,abcorr:'NONE',params:{metric:p.query.metric,extremum:'maximum',scope:'selected-activities',activityIds:acts.map(a=>a.id),activityKind:'flight',timeToleranceSeconds:.005,sampling:'adaptive',frame:p.query.frame}},'72 flight parity','explicit');
        if(path==='stored-rerun')item.query.trajectoryAnalysis=p.query;
        p.finder.openConfiguredQuery(item.id);p.shell.openTool('events');
      }
      const gl=document.querySelector('canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');
      p.renderer=gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      p.calls=0;p.locations=new Set();p.progress=[];p.tasks=[];p.beats=[];
      const original=mesh.requestTerrainAnalysisSample;
      mesh.requestTerrainAnalysisSample=async function(...args){p.firstTerrain??=performance.now();p.calls++;p.locations.add(`${args[0]},${args[1]}`);try{return await original.apply(this,args)}finally{p.lastTerrain=performance.now()}};
      p.observer=new PerformanceObserver(l=>p.tasks.push(...l.getEntries().map(e=>e.duration)));p.observer.observe({type:'longtask'});
      let last=performance.now();p.timer=setInterval(()=>{const now=performance.now();p.beats.push(now-last);last=now},20);
      p.start=performance.now();
      if(path==='ask-operation')p.work=p.task.analyzeTrajectoryExtrema(p.request,{onProgress:f=>p.progress.push(f)}).then(r=>{p.result=r;p.done=true;p.end=performance.now()});
    },{metric,path});
    if(path!=='ask-operation'){
      await page.getByRole('button',{name:'Find maximum',exact:true}).click();
      await page.waitForFunction(()=>!window.__parity.finder.ef.running,null,{timeout:900000});
      await page.evaluate(()=>{window.__parity.end=performance.now();window.__parity.done=true});
    }else await page.waitForFunction(()=>window.__parity.done,null,{timeout:900000});
    const report=await page.evaluate(({metric,path})=>{
      const p=window.__parity;clearInterval(p.timer);p.observer.disconnect();
      const results=Object.values(p.analysis.analysis.eventResults).flat().filter(e=>e.trajectoryAnalysis).map(e=>e.trajectoryAnalysis);
      return{metric,path,renderer:p.renderer,query:p.query,activities:p.activities,wallMs:p.end-p.start,terrainMs:p.lastTerrain-p.firstTerrain,terrainCalls:p.calls,uniqueLocations:p.locations.size,maxTaskMs:Math.max(0,...p.tasks),maxHeartbeatMs:Math.max(0,...p.beats),progress:p.progress,result:p.result,fault:p.finder.ef.fault,hint:p.finder.ef.hint,storedDefinition:p.analysis.analysis.items.find(i=>i.type==='event-query')?.query,results};
    },{metric,path});
    assert.deepEqual(errors,[]);assert.equal(report.fault,null);
    if(path==='stored-rerun'&&process.env.TRAJECTORY_PARITY_ASSERT==='1')assert.deepEqual(report.storedDefinition.trajectoryAnalysis,report.query);
    assert.equal(report.activities.length,72);
    if(process.env.TRAJECTORY_PARITY_ASSERT==='1'){
      assert.equal(report.results.length,72);
      assert.ok(report.activities.every(a=>report.results.some(r=>r.activityId===a.id)));
    }
    report.summary={metric,path,wallMs:report.wallMs,terrainCalls:report.terrainCalls,candidates:report.results.length,evaluations:report.results.reduce((n,r)=>n+r.method.evaluations,0),temporal:report.results.filter(r=>r.completeness?.temporal==='complete').length,numerical:report.results.filter(r=>r.completeness?.numerical==='complete').length,best:report.results.reduce((a,b)=>b.value>a.value?b:a),maxTaskMs:report.maxTaskMs,maxHeartbeatMs:report.maxHeartbeatMs};
    // Selecting the best row uses the same native navigation in each case.
    if(path==='ask-operation')assert.equal(await page.evaluate(id=>window.__parity.task.navigateToAnalysisResult(id),report.summary.best.id),true);
    else await page.locator('.event-result').filter({has:page.locator('.height-context',{hasText:`${report.summary.best.activityName} ·`})}).click();
    report.viewer=await page.evaluate(()=>({et:window.cosmo.getTime(),tracked:window.cosmo.getTracked(),selected:window.cosmo.getSelected(),playing:window.cosmo.isPlaying()}));
    assert.equal(report.viewer.et,report.summary.best.et);assert.equal(report.viewer.tracked,'Ingenuity');assert.equal(report.viewer.playing,false);
    if(path!=='ask-operation')report.rendered=await page.locator('.event-result').count();
    reports.push(report);writeFileSync(output,JSON.stringify(reports,null,2));console.log(JSON.stringify({...report.summary,best:{flight:report.summary.best.activityName,valueKm:report.summary.best.value,et:report.summary.best.et}}));
    await context.close();
  }
  if(process.env.TRAJECTORY_PARITY_ASSERT==='1')for(const metric of ['terrain-clearance','reference-ellipsoid-height']){
    const cells=reports.filter(r=>r.metric===metric),canonical=r=>r.results.map(({id,...r})=>r).sort((a,b)=>a.activityId.localeCompare(b.activityId));
    for(const cell of cells.slice(1))assert.deepEqual(canonical(cell),canonical(cells[0]));
  }
} finally {await browser.close()}
