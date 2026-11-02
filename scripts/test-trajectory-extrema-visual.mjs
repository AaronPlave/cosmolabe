/** Loaded-app acceptance for #329. No model provider calls.
 * node scripts/test-trajectory-extrema-visual.mjs [URL] [OUT]
 */
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const base=process.argv[2] ?? 'http://127.0.0.1:5198/';
const out=process.argv[3] ?? 'work/issue-329';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),args:['--enable-gpu','--ignore-gpu-blocklist',...(process.platform==='darwin'?['--use-angle=metal']:[])]});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const report={passed:false,errors:[]};
page.on('pageerror',e=>report.errors.push(e.message));
try {
  await page.goto(`${base}?catalog=test-catalogs/moonfall-shackleton`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.cosmo?.listActivities?.().length===24,null,{timeout:120000});
  await page.evaluate(async()=>{await window.renderer.waitForInitialAssets();window.cosmo.setPlaying(false);});
  report.results=await page.evaluate(async()=>{
    const bm=window.renderer.getBodyMesh('Moon');
    const q={objects:['Polaris-A','Polaris-B','Polaris-C','Polaris-D'],body:'Moon',frame:'MOON_ME_DE421',metric:'heightAbovePhysicalTerrain',extremum:'maximum',reference:{kind:'sphere',radiusKm:1737.4},scope:{kind:'activities',activityKind:'hop'},stepSeconds:.1,timeToleranceSeconds:.005,terrain:{id:bm.terrainSourceId,revision:bm.terrainSourceRevision}};
    const all=await window.cosmo.findTrajectoryExtrema(q);
    window.analysisQuery=q;
    const gl=window.renderer.renderer.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info');
    return {all,gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,terrain:bm.terrainFrameAvailability};
  });
  assert.equal(report.results.all.status,'complete',JSON.stringify(report.results.all.faults));
  assert.equal(report.results.all.results.length,12);
  assert.equal(report.results.all.results[0].object,'Polaris-D');
  assert.ok(Math.abs(report.results.all.results[0].value*1000-310.91)<.5);
  const peak=report.results.all.results[0];
  assert.equal(await page.evaluate(id=>window.cosmo.navigateToAnalysisResult(id),peak.id),true);
  await page.waitForTimeout(100);
  report.navigation=await page.evaluate(()=>({et:window.cosmo.getTime(),selected:window.cosmo.getSelected(),activity:window.cosmo.getSelectedActivity()?.id,tracked:window.cosmo.getTracked(),playing:window.cosmo.isPlaying()}));
  assert.ok(Math.abs(report.navigation.et-peak.et)<.001);
  assert.equal(report.navigation.selected,peak.object);
  assert.equal(report.navigation.activity,peak.activityId);
  assert.equal(report.navigation.tracked,peak.object);
  assert.equal(report.navigation.playing,false);
  report.radial=await page.evaluate(async()=>window.cosmo.findTrajectoryExtrema({...window.analysisQuery,metric:'radialHeightAboveReferenceSphere',terrain:undefined}));
  assert.equal(report.radial.status,'complete'); assert.equal(report.radial.results.length,12);
  assert.equal(report.radial.results[0].metric,'radialHeightAboveReferenceSphere');
  assert.equal(report.radial.results[0].activityName,'Connector hop to de Gerlache');
  assert.ok(Math.abs(report.radial.results[0].value*1000-2049.40)<.5);
  // Returned values are detached from stored event/navigation identity.
  assert.equal(await page.evaluate(async id=>{
    const c=await window.cosmo.findTrajectoryExtrema({...window.analysisQuery,objects:['Polaris-C']});
    window.cResults=structuredClone(c);
    if(c.status!=='complete'||c.results.length!==3) return false;
    const first=c.results[0],original=first.et; first.et=0; first.object='Polaris-A';
    return !window.cosmo.navigateToAnalysisResult(id)&&window.cosmo.navigateToAnalysisResult(first.id)&&Math.abs(window.cosmo.getTime()-original)<.001&&window.cosmo.getSelected()==='Polaris-C';
  },peak.id),true);
  report.c=await page.evaluate(()=>window.cResults);
  // The registered kind uses the standard form and results controls.
  await page.getByRole('button',{name:'Events',exact:true}).click();
  await page.locator('[data-slot="select-trigger"]').filter({hasText:'Closest approach'}).click();
  await page.getByText('Altitude / terrain clearance',{exact:true}).last().click();
  assert.equal(await page.locator('details summary').filter({hasText:'Trajectory height extrema'}).count(),0);
  const bodyPickers=page.locator('select').filter({has:page.locator('option[value="Moon"]')});
  await bodyPickers.nth(0).selectOption('Moon');
  assert.equal(await page.locator('#event-param-scope').inputValue(),'window');
  assert.equal(await page.locator('#event-param-frame').isVisible(),false);
  await page.locator('#event-param-scope').selectOption('activities');
  await page.locator('#event-param-activityKind').selectOption('hop');
  await page.getByRole('button',{name:'Find events',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('button.event-result').length===12,null,{timeout:120000});
  report.native={allRows:await page.locator('button.event-result').allTextContents()};
  assert.equal(report.native.allRows.length,12);
  assert.ok(report.native.allRows[0].includes('Polaris-D — Long traverse to Sverdrup'));
  assert.ok(report.native.allRows[0].includes('Physical terrain clearance'));
  assert.ok(report.native.allRows[0].includes('sampled coverage'));
  // Same form, now one vehicle. Only the normal result list is rendered.
  await bodyPickers.nth(1).selectOption('Polaris-C');
  await page.getByRole('button',{name:'Find events',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('button.event-result').length===3,null,{timeout:120000});
  report.native.cRows=await page.locator('button.event-result').allTextContents();
  assert.ok(report.native.cRows[0].includes('Polaris-C — Crater inner-wall transect'));
  await page.screenshot({path:`${out}/trajectory-form.png`});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:`${out}/trajectory-form-compact.png`});
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#event-param-extremum').selectOption('minimum');
  await page.getByRole('button',{name:'Find events',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('button.event-result').length===3,null,{timeout:120000});
  const minimumOrder=await page.evaluate(()=>{
    const c=window.cosmo,q=c.listEventQueries().find(q=>q.query.kind==='trajectory-extremum'&&q.query.params.extremum==='minimum');
    return c.listEventResults(q.id,{limit:100}).items.sort((a,b)=>a.trajectoryAnalysis.value-b.trajectoryAnalysis.value).map(e=>e.label);
  });
  assert.deepEqual(await page.locator('button.event-result').evaluateAll(rows=>rows.map(row=>row.title)),minimumOrder);
  report.native.minimumOrder=minimumOrder;
  await page.locator('#event-param-extremum').selectOption('maximum');
  await page.getByRole('button',{name:'Find events',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('button.event-result').length===3,null,{timeout:120000});
  await page.locator('button.event-result[title="Polaris-C: Crater inner-wall transect"]').click();
  report.native.selected=await page.evaluate(()=>({object:window.cosmo.getSelected(),activity:window.cosmo.getSelectedActivity()?.name,et:window.cosmo.getTime(),tracked:window.cosmo.getTracked()}));
  assert.equal(report.native.selected.object,'Polaris-C');
  assert.equal(report.native.selected.activity,'Crater inner-wall transect');
  assert.equal(report.native.selected.tracked,'Polaris-C');
  assert.ok(Math.abs(report.native.selected.et-report.c.results[0].et)<.01);
  await page.screenshot({path:`${out}/trajectory-extrema.png`});
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(base).origin});
  await page.getByRole('button',{name:'Copy view link',exact:true}).click();
  const link=await page.evaluate(()=>navigator.clipboard.readText());
  assert.ok(link.includes('view='),link.slice(0,100));
  report.share={urlLength:link.length};
  await page.goto(link,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.cosmo?.getSelectedActivity?.()?.name==='Crater inner-wall transect',null,{timeout:120000});
  report.share.restored=await page.evaluate(()=>({object:window.cosmo.getSelected(),tracked:window.cosmo.getTracked(),et:window.cosmo.getTime(),activity:window.cosmo.getSelectedActivity()?.name}));
  assert.equal(report.share.restored.object,'Polaris-C');
  assert.equal(report.share.restored.tracked,'Polaris-C');
  assert.ok(Math.abs(report.share.restored.et-report.native.selected.et)<.001);
  report.cancellation=await page.evaluate(async q=>{
    const signal={aborted:false};
    const pending=window.cosmo.findTrajectoryExtrema({...q,metric:'radialHeightAboveReferenceSphere',stepSeconds:.02},{signal});
    signal.aborted=true;
    return await pending;
  },{objects:['Polaris-A','Polaris-B','Polaris-C','Polaris-D'],body:'Moon',frame:'MOON_ME_DE421',metric:'radialHeightAboveReferenceSphere',extremum:'maximum',reference:{kind:'sphere',radiusKm:1737.4},scope:{kind:'activities',activityKind:'hop'},stepSeconds:.1,timeToleranceSeconds:.005});
  assert.equal(report.cancellation.status,'cancelled'); assert.equal(report.cancellation.results.length,0);
  report.agent=await page.evaluate(async controlModule=>{
    const {createAgentTools}=await import(controlModule);
    const {builtInAgentMetadata}=await import('/src/lib/ask/public-metadata.ts');
    const tools=createAgentTools(window.cosmo,{metadata:builtInAgentMetadata});
    try {
      const surface=await tools.call('getSurfaceData',{object:'Moon'});
      if(!surface.ok) return {surface};
      const data=surface.data,terrain=data.terrain;
      const query={objects:['Polaris-C'],body:'Moon',frame:terrain.frame,metric:'heightAbovePhysicalTerrain',extremum:'maximum',reference:terrain.datum.referenceShape,scope:{kind:'activities',activityKind:'hop'},stepSeconds:.1,timeToleranceSeconds:.005,terrain:{id:terrain.source.id,revision:terrain.source.revision}};
      const computed=await tools.call('findTrajectoryExtrema',query);
      const first=computed.ok?computed.data.results[0]:null;
      const navigation=first?await tools.call('navigateToAnalysisResult',{resultId:first.id}):null;
      return {surfaceReference:query.reference,computed,navigation};
    } finally {tools.dispose();}
  },'/@fs'+new URL('../packages/control/src/index.ts',import.meta.url).pathname);
  assert.equal(report.agent.computed.ok,true,JSON.stringify(report.agent));
  assert.equal(report.agent.computed.data.status,'complete');
  assert.equal(report.agent.computed.data.results.length,3);
  assert.equal(report.agent.navigation.ok,true,JSON.stringify(report.agent.navigation));
  assert.equal(report.agent.navigation.data.verified,true);
  report.modern=await page.evaluate(async controlModule=>{
    const {parse,execute,quote,createCapabilityTools}=await import(controlModule);
    const {builtInAgentMetadata}=await import('/src/lib/ask/public-metadata.ts');
    const c=window.cosmo,id='review:height',activities=c.listActivities().filter(a=>a.kind==='hop');
    const definition={id,label:'Highest physical clearance by hop',enabled:true,visible:true,query:{id,kind:'trajectory-extremum',bodies:{center:'Moon'},window:{start:Math.min(...activities.map(a=>a.start)),end:Math.max(...activities.map(a=>a.end))},step:.1,abcorr:'NONE',params:{scope:'activities',activityKind:'hop',metric:'heightAbovePhysicalTerrain',extremum:'maximum',timeToleranceSeconds:.005}}};
    const source=`upsertEventQuery ${quote(JSON.stringify(definition))}\nrunEventQuery ${quote(id)} 120000`;
    await execute(parse(source),c);
    const page=c.getEventResultPage(id,{limit:100}),info=c.getEventQueryInfo(id);
    const capabilities=createCapabilityTools(c,{metadata:builtInAgentMetadata}),task=capabilities.begin();
    try {
      const discovered=capabilities.listCapabilities({domain:'events',query:'EventResult',limit:12});
      await task.call('describeCapabilities',{ids:['events.getEventResultPage','events.focusEventResult','events.getEventVisualization']});
      const transport=await task.call('getEventResultPage',{query:id,limit:1});
      if(!transport.ok) return {transport};
      const first=transport.data.items[0];
      const focus=await task.call('focusEventResult',{reference:JSON.stringify(first.reference),anchor:'start'});
      await execute(parse(`waitUntilReady ${quote(JSON.stringify({kind:'event',reference:first.reference,et:first.et,policy:'timeline'}))} 30`),c);
      const visual=await task.call('getEventVisualization',{});
      const fresh=c.getEventResultPage(id,{limit:1}).items[0].reference;
      const nativeReadiness=c.getReadiness({kind:'event',reference:fresh,et:first.et,policy:'native-draw'});
      await c.runEventQuery(id);
      const stale=c.focusEventResult(fresh,'start');
      return {source,discovered:discovered.items.map(item=>item.id),count:page.total,info,transport,focus,visual,nativeReadiness,stale:stale.status};
    } finally {capabilities.dispose();}
  },'/@fs'+new URL('../packages/control/src/index.ts',import.meta.url).pathname);
  assert.equal(report.modern.count,12,JSON.stringify(report.modern));
  assert.equal(report.modern.info.provenance.source,'authoritative-trajectories');
  assert.equal(report.modern.transport.ok,true);
  assert.equal(report.modern.transport.data.items[0].trajectoryAnalysis.metric,'heightAbovePhysicalTerrain');
  assert.ok(report.modern.transport.data.items[0].metrics.some(m=>m.key==='heightAbovePhysicalTerrain'));
  assert.equal(report.modern.focus.ok,true);
  assert.ok(['observed','partial'].includes(report.modern.visual.data.status));
  assert.equal(report.modern.visual.data.timeline.selectedInVisibleLane,true);
  assert.equal(report.modern.visual.data.renderer.observedEt,report.modern.transport.data.items[0].et);
  if(report.modern.visual.data.renderer.visibleGlyphs===0) assert.equal(report.modern.nativeReadiness.status,'partial');
  assert.equal(report.modern.stale,'stale-result');
  report.partial=await page.evaluate(async()=>{
    const c=window.cosmo,bm=window.renderer.getBodyMesh('Moon');
    const q={objects:['Polaris-C'],body:'Moon',frame:'MOON_ME_DE421',metric:'heightAbovePhysicalTerrain',extremum:'maximum',reference:{kind:'sphere',radiusKm:1737.4},scope:{kind:'activities',activityKind:'hop'},stepSeconds:.1,timeToleranceSeconds:.005,maxEvaluations:20,terrain:{id:bm.terrainSourceId,revision:bm.terrainSourceRevision}};
    const response=await c.findTrajectoryExtrema(q);
    const item=c.listEventQueries().find(item=>item.query.trajectoryAnalysis?.maxEvaluations===20);
    c.openEventQuery(item.id);
    return {status:response.status,count:response.results.length};
  });
  assert.equal(report.partial.status,'partial');
  if(!await page.getByRole('button',{name:'Find events',exact:true}).isVisible()) await page.getByRole('button',{name:'Events',exact:true}).click();
  await page.getByText('Incomplete search — candidates only; no overall winner established.',{exact:true}).waitFor();
  await page.screenshot({path:`${out}/trajectory-partial.png`});
  assert.equal(report.errors.length,0,report.errors.join('\n'));
  report.passed=true;
} finally {
  if(!report.passed) await page.screenshot({path:`${out}/failure.png`}).catch(()=>{});
  await writeFile(`${out}/trajectory-extrema.json`,JSON.stringify(report,null,2));
  await browser.close();
}
console.log(JSON.stringify({passed:report.passed,gpu:report.results?.gpu,global:report.results?.all.results[0],navigation:report.navigation},null,2));
