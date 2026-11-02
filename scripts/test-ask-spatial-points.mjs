/** #297 additional review: actual default Ask point/projection workflows.
 * Public fixtures only; paid inference and test-owned UI approvals require opt-in.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createProxy, anthropicProvider } from '../examples/ask-proxy/server.mjs';
assert.equal(process.env.ASK_MISSION_LIVE, '1', 'Explicit paid-inference opt-in required');
assert.ok(process.env.ANTHROPIC_API_KEY);
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5797/';
const output = process.env.ASK_SPATIAL_OUTPUT ?? '/tmp/297-ask-spatial'; mkdirSync(output,{recursive:true});
const usage = [], model = process.env.ASK_MODEL ?? anthropicProvider.defaultModel;
const proxy = createProxy({ apiKey: process.env.ANTHROPIC_API_KEY, origins:[new URL(base).origin],provider:anthropicProvider,model,
  maxTokens:1536,perMinute:100,tokenBudget:750000,costBudgetUsd:1,cache:true,onUsage:r=>usage.push(r) });
await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(8798,'127.0.0.1',resolve);});
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
const report={model,runs:[]};
async function send(page,prompt,approvals) {
  const before = await page.evaluate(()=>window.__askSpatial.turns.length);
  await page.getByRole('textbox',{name:'Request',exact:true}).fill(prompt);
  await page.getByRole('button',{name:'Send request',exact:true}).click();
  for(let i=0;i<480;i++) {
    if(await page.getByRole('button',{name:'Approve once',exact:true}).isVisible()) {
      const pending=await page.evaluate(()=>import(performance.getEntriesByType('resource').map(e=>e.name).find(u=>new URL(u).pathname==='/src/lib/ask/ask.svelte.ts')).then(m=>m.askApproval.pending));
      approvals.push(pending); await page.getByRole('button',{name:'Approve once',exact:true}).click();
    }
    if(await page.evaluate(n=>window.__askSpatial.turns.length>n&&window.__askSpatial.turns.at(-1).status!=='running',before)) break;
    await page.waitForTimeout(500);
  }
  const turn=await page.evaluate(()=>{const t=window.__askSpatial.turns.at(-1);return {prompt:t.prompt,status:t.status,reply:t.reply,error:t.error,
    steps:t.steps.map(s=>({id:s.id,name:s.name==='invokeCapability'?s.input.id:s.name,input:s.input,ok:s.result?.ok,data:s.result?.ok?s.result.data:undefined,error:s.result&&!s.result.ok?s.result.error:null}))};});
  console.log(JSON.stringify({prompt,status:turn.status,reply:turn.reply})); assert.equal(turn.status,'done'); return turn;
}
async function inspect(page,body) {
  return page.evaluate(async body=>{
    const c=window.cosmo, context=c.getSpatialContext(body), selected=c.getSelectedGeographicFeature();
    const url=performance.getEntriesByType('resource').map(e=>e.name).find(u=>new URL(u).pathname==='/src/lib/loader.ts');
    const u=(await import(url)).getUniverse();
    const layer=selected?u.geographicLayers.get(selected.layer):null;
    const feature=layer?.features.find(f=>f.id===selected.feature);
    return {context,selected,feature:feature?{type:feature.geometry.type,coordinates:feature.geometry.coordinates}:null,probe:c.getProbePoint(),
      playing:c.isPlaying(),rate:c.getRate(),tracked:c.getTracked(),cameraReference:c.getCameraReference(),camera:c.getCamera(),et:c.getTime()};
  },body);
}
try {
  for(const scenario of [
    {id:'saturn-point',catalog:'cassini-soi',body:'Saturn',prompt:'place a point on the top of saturn'},
    {id:'ground-pin',catalog:'ingenuity-jezero',body:'Mars',prompt:'place a pick marker on the ground where ingenuity currently is'},
  ].filter(s=>!process.env.ASK_SPATIAL_CASE||s.id===process.env.ASK_SPATIAL_CASE)) {
    const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),approvals=[],payloads=[],requests=[],errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.url().startsWith('http://127.0.0.1:8798')&&r.method()==='POST') {const req=r.postDataJSON();requests.push({schemas:req.tools.map(t=>t.name),bytes:Buffer.byteLength(JSON.stringify(req.tools))});payloads.push(...req.messages.flatMap(m=>m.content.filter(b=>b.type==='tool_result').map(b=>({id:b.toolUseId,content:b.content}))));}});
    const started=performance.now(),usageStart=usage.length,run={scenario:scenario.id,prompt:scenario.prompt,turns:[],approvals,errors};report.runs.push(run);
    try {
      await page.goto(`${base}?catalog=test-catalogs/${scenario.catalog}`,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>window.cosmo?.getScene()?.ready,null,{timeout:120000});
      await page.evaluate(async()=>{const resource=p=>performance.getEntriesByType('resource').map(e=>e.name).find(u=>new URL(u).pathname===p);(await import(resource('/src/lib/shell.svelte.ts'))).openTool('ask');window.__askSpatial=(await import(resource('/src/lib/ask/ask.svelte.ts'))).ask;});
      run.before=await inspect(page,scenario.body);
      run.turns.push(await send(page,scenario.prompt,approvals));
      if(scenario.id==='saturn-point') {
        assert.equal(approvals.length,0,'ambiguous top must be clarified before persistent writes');
        assert.match(run.turns[0].reply,/north|disc|pole|visible/i);
        run.turns.push(await send(page,'I mean the north pole. Add and select a saved point annotation on Saturn’s reference ellipsoid.',approvals));
      } else {
        assert.equal(approvals.length,0,'a transient Point Probe marker must not require authored definitions');
        await page.waitForFunction(()=>window.cosmo.getProbePoint()?.observedEt!=null,null,{timeout:30000});
        run.transient=await inspect(page,'Mars');
        const probe=run.transient.probe;assert.ok(probe);assert.equal(probe.point.bodyName,'Mars');assert.equal(probe.point.frame,'IAU_MARS');
        const source=await page.evaluate(p=>window.cosmo.getObjectState('Ingenuity',{time:{kind:'et',et:p.placedEt},frame:p.point.frame,center:'Mars'}),probe);
        assert.ok(source.positionAvailability.available);
        const a=probe.point.bodyFixedPositionKm,b=source.position,la=Math.hypot(...a),lb=Math.hypot(...b);
        assert.ok(a.reduce((n,x,i)=>n+x*b[i],0)/(la*lb)>1-1e-8,'pin is under actual vehicle state at placement epoch, not a named site/camera pick');
        run.turns.push(await send(page,'can you place a point then',approvals));
        run.turns.push(await send(page,'Save the existing pinned location as a geographic point annotation and select it. Use the pin’s supplied annotation coordinates and request approval.',approvals));
      }
      await page.waitForFunction(body=>{const c=window.cosmo.getSpatialContext(body);return c.selectedFeature&&c.drawing.some(d=>d.layers.includes(c.selectedFeature.layer)&&d.features>0);},scenario.body,{timeout:30000});
      run.after=await inspect(page,scenario.body);
      assert.ok(run.after.selected&&run.after.feature);
      assert.equal(run.after.feature.type,'Point');
      if(scenario.id==='saturn-point') assert.ok(Math.abs(run.after.feature.coordinates.latDeg-90)<1e-6,'actual selected geometry is the north pole');
      assert.ok(approvals.some(a=>a.kind==='authoring'));
      assert.equal(run.after.playing,run.before.playing);assert.equal(run.after.rate,run.before.rate);
      assert.equal(run.after.tracked,run.before.tracked);assert.equal(run.after.cameraReference,run.before.cameraReference);
      const operations=run.turns.flatMap(t=>t.steps);
      assert.ok(!operations.some(s=>s.ok&&/\.(setTime|setPlaying|setFrame|frameObject|gotoObject|flyTo|viewpoint)$/.test(s.name)),'point placement preserves clock/camera ownership');
      for(const step of operations.filter(s=>s.ok&&/getSpatialContext|getProbePoint|projectGroundPoint|getObjectState/.test(s.name))) {
        const wire=payloads.find(p=>p.id===step.id);assert.ok(wire&&!/result-too-large/.test(wire.content),'targeted spatial result reaches the provider');
      }
      assert.deepEqual(errors,[]);
      const rows=usage.slice(usageStart);Object.assign(run,{latencyMs:Math.round(performance.now()-started),requests,usage:rows,
        rawTokens:rows.reduce((n,r)=>n+r.inputTokens+r.cacheReadTokens+r.cacheWriteTokens+r.outputTokens,0),estimatedUsd:rows.some(r=>r.estimatedUsd===null)?null:rows.reduce((n,r)=>n+r.estimatedUsd,0),status:'passed'});
      await page.screenshot({path:`${output}/${scenario.id}-panel.png`});
    } finally {writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2)+'\n');await context.close();}
  }
} finally {writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2)+'\n');await browser.close();await new Promise(resolve=>proxy.close(resolve));}
