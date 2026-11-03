/** Loaded Ingenuity #329 acceptance. Uses the pinned real CPU grids and the
 * catalog's estimated flight reconstruction; no provider calls or fake terrain.
 * node scripts/test-ingenuity-extrema-visual.mjs [URL] [OUT]
 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const base=process.argv[2]??'http://127.0.0.1:5198/';
const out=process.argv[3]??'/tmp/ingenuity-extrema';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),args:['--enable-gpu','--ignore-gpu-blocklist',...(process.platform==='darwin'?['--use-angle=metal']:[])]});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const report={passed:false,errors:[]};
page.on('pageerror',e=>report.errors.push(e.message));
try {
  await page.goto(`${base}?catalog=test-catalogs/ingenuity-jezero`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.cosmo?.listActivities?.().length===72&&window.renderer?.getBodyMesh('Mars')?.terrainFrameAvailability?.kind==='available',null,{timeout:180000});
  console.log('scene ready');
  await page.evaluate(async()=>{await Promise.race([window.renderer.waitForInitialAssets(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Initial assets timeout')),120000))]);window.cosmo.setPlaying(false);});
  console.log('assets ready');
  await page.evaluate(()=>{window.extremaImport=async name=>{const url=performance.getEntriesByType('resource').map(e=>e.name).find(url=>new URL(url).pathname.endsWith('/src/lib/'+name));if(!url)throw new Error('Live module not found: '+name);return import(url);};});
  report.sources=await page.evaluate(async()=>{
    const r=window.renderer,b=r.getBodyMesh('Mars'),t=b.terrainManager;
    const gl=r.getContext().webglRenderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
    return {frame:b.terrainFrameAvailability,datum:b.terrainDatum,id:b.terrainSourceId,revision:b.terrainSourceRevision,
      gridFrame:t.cube.source.manifest.coordinates.frame,gridRevision:t.cube.source.manifest.source.version,
      geometryRevision:(await (await fetch('/test-catalogs/data/ingenuity-cube/terrain-3846907d293e9e5d0b0243ce/tileset-measured.json')).json()).asset.tilesetVersion,
      trajectoryFrame:r.universe.frames.bodyFixedFrameFor('Mars'),arcFrame:r.universe.getBody('Ingenuity').arcFrame(r.universe.getBody('Ingenuity').trajectory.arcs[11]),
      gpu:gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER)};
  });
  assert.equal(report.sources.frame.frame,'IAU_MARS');
  assert.equal(report.sources.gridFrame,'IAU_MARS');
  assert.equal(report.sources.trajectoryFrame,'IAU_MARS');
  assert.equal(report.sources.arcFrame,'BODY_FIXED');
  assert.equal(report.sources.gridRevision,report.sources.geometryRevision);
  assert.equal(report.sources.datum.verticalDatum,'ellipsoid');
  assert.equal(report.sources.datum.heightConvention,'geodetic-normal');
  assert.doesNotMatch(report.sources.gpu,/swiftshader|llvmpipe/i);
  await page.getByRole('button',{name:'Events',exact:true}).click();
  await page.locator('[data-slot="select-trigger"]').filter({hasText:'Closest approach'}).click();
  await page.getByText('Altitude / terrain clearance',{exact:true}).last().click();
  await page.locator('#event-body-center').selectOption('Mars');
  await page.locator('#event-body-observer').selectOption('Ingenuity');
  assert.equal(await page.locator('#event-height-question option[value="heightAbovePhysicalTerrain:maximum"]').isDisabled(),false);
  await page.locator('#event-window').selectOption('source');
  await page.getByText('More options',{exact:true}).click();
  await page.locator('#event-param-scope').selectOption('selected-activities');
  const flight=await page.evaluate(()=>window.cosmo.listActivities().find(a=>a.vehicle==='Ingenuity'&&/Flight 12\b/i.test(a.name)));
  assert.ok(flight,'Catalog must supply Flight 12 explicitly');
  report.activity=flight;
  await page.locator('#event-param-activityIds').selectOption(flight.id);
  await page.getByText('More options',{exact:true}).click();
  const run=page.getByRole('button',{name:'Find maximum',exact:true});
  assert.equal(await run.isEnabled(),true);
  console.log('running native Flight 12 query');
  await run.click();
  for(let attempt=0;attempt<36;attempt++) {
    const state=await page.evaluate(()=>window.cosmo.getEventSearch());
    console.log('search progress',JSON.stringify(state));
    if(['complete','failed','cancelled','timed-out','stale'].includes(state.status)) break;
    await page.waitForTimeout(5000);
  }
  report.searchState=await page.evaluate(async()=>{const {ef}=await window.extremaImport('event-finder.svelte.ts');return {running:ef.running,fault:ef.fault,hint:ef.hint,eventCount:ef.events.length,form:ef.form};});
  
  assert.equal(await page.locator('button.event-result').count(),1,JSON.stringify(report.searchState));
  report.nativeRow=await page.locator('button.event-result').innerText();
  report.result=await page.evaluate(async()=>{
    const a=await window.extremaImport('analysis.svelte.ts');
    return Object.values(a.analysis.eventResults).flat().find(e=>e.trajectoryAnalysis)?.trajectoryAnalysis;
  });
  const result=report.result;
  assert.equal(result.metric,'heightAbovePhysicalTerrain');
  assert.equal(result.frame,'IAU_MARS');
  assert.equal(result.activityId,flight.id);
  assert.ok(result.et>=flight.start&&result.et<=flight.end);
  assert.ok(Number.isFinite(result.value));
  assert.ok(result.value>0&&result.value<.1,'Flight clearance should be physically plausible, below 100 m');
  assert.equal(result.terrain.id,report.sources.id);
  assert.equal(result.terrain.revision,report.sources.revision);
  assert.match(result.source.description,/Estimated flight reconstruction, not 3D telemetry/);
  assert.notEqual(result.source.classification,'source-observed');
  assert.equal(result.terrain.sourceUncertaintyKm,null);
  assert.equal(result.method.heightErrorBoundKm,null);
  if(result.coverage==='partial') assert.match(await page.locator('.height-caution').innerText(),/candidate|partial|incomplete/i);
  await page.locator('button.event-result').click();
  // Clicking the native result performs the shared selection/navigation action.
  report.navigation=await page.evaluate(()=>({et:window.cosmo.getTime(),selected:window.cosmo.getSelected(),tracked:window.cosmo.getTracked(),activity:window.cosmo.getSelectedActivity()?.id}));
  assert.ok(Math.abs(report.navigation.et-result.et)<.001);
  assert.equal(report.navigation.selected,'Ingenuity');
  assert.equal(report.navigation.tracked,'Ingenuity');
  assert.equal(report.navigation.activity,flight.id);
  await page.locator('.measurement-details > summary').click();
  await page.getByText('Calculation & sources',{exact:true}).click();
  assert.match(await page.locator('.measurement-details').innerText(),/Estimated flight reconstruction, not 3D telemetry/);
  await page.screenshot({path:`${out}/ingenuity-flight12.png`});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:`${out}/ingenuity-flight12-compact.png`});
  assert.deepEqual(report.errors,[]);
  report.passed=true;
  console.log(JSON.stringify({passed:true,valueM:result.value*1000,coverage:result.coverage,gpu:report.sources.gpu}));
} catch(error) {
  report.failure=error.stack;
  await page.screenshot({path:`${out}/failure.png`}).catch(()=>{});
  throw error;
} finally {
  await writeFile(`${out}/acceptance.json`,JSON.stringify(report,null,2));
  await browser.close();
}
