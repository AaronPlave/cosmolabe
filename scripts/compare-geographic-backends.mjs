/** Profile each backend independently in the normal viewer. Side-by-side is visual evidence only. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const output=process.env.CL_OUTPUT??'/private/tmp/geographic-backend-comparison';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CL_CHROMIUM??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
const results=[],errors=[];
try{
 const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:2});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(m.text()))errors.push(m.text());});
 const catalogs=(process.env.CL_CATALOGS??'geographic-vectors-earth-overlay-comparison').split(',');
 for(const catalog of catalogs)for(const backend of (process.env.CL_BACKENDS??'vector,raster').split(',')){
  const query=new URLSearchParams({catalog:`test-catalogs/${catalog}`,'geographic-comparison':backend,overlayResolution:process.env.CL_OVERLAY_RESOLUTION??'256',overlaySplit:process.env.CL_OVERLAY_SPLIT??'1'});
  await page.goto(`${process.env.CL_VIEWER_URL??'http://127.0.0.1:5188/'}?${query}`,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>!!window.geographicComparison,null,{timeout:90000});
  await page.evaluate(()=>window.renderer.waitForInitialAssets());
  const views=process.env.CL_VIEWS?process.env.CL_VIEWS.split('|'):catalog.includes('earth')?['Earth orbit','Europe and Africa','Pacific dateline','Antarctica','Rhine close']:catalog.includes('shackleton')?['Shackleton orbit','Shackleton detail','Shackleton close']:['Jezero orbit','Jezero detail','Jezero close'];
  for(const view of views){
   await page.evaluate(view=>window.renderer.applyNamedViewpoint(view),view);
   await page.waitForTimeout(1500);
   await page.waitForFunction(()=>{const m=window.geographicComparison.metrics();return m.terrain.tiles.drawn>0&&m.pendingRasters===0&&m.terrain.network.queued===0&&m.terrain.network.downloading===0&&m.terrain.network.parsing===0;},null,{timeout:60000});
   for(const visible of backend==='none'?[true]:[false,true]){
    await page.evaluate(visible=>window.geographicComparison.setVisible(visible),visible);
    await page.waitForTimeout(800);
    await page.mouse.move(960,540);
    const metrics=await page.evaluate(async frames=>{
     const r=window.renderer,intervals=[],cpu=[],gl=r.renderer.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2'),queries=[],gpu=[];
     let disjoint=false,submitted=0;
     const poll=()=>{if(ext&&gl.getParameter(ext.GPU_DISJOINT_EXT))disjoint=true;for(let i=queries.length-1;i>=0;i--)if(gl.getQueryParameter(queries[i],gl.QUERY_RESULT_AVAILABLE)){gpu.push(gl.getQueryParameter(queries[i],gl.QUERY_RESULT)/1e6);gl.deleteQuery(queries[i]);queries.splice(i,1);}};
     const original=r.renderFrame.bind(r);
     r.renderFrame=(...args)=>{poll();const q=ext&&submitted<20?gl.createQuery():null;if(q){gl.beginQuery(ext.TIME_ELAPSED_EXT,q);submitted++;}const start=performance.now();const v=original(...args);cpu.push(performance.now()-start);if(q){gl.endQuery(ext.TIME_ELAPSED_EXT);queries.push(q);}return v;};
     let last=await new Promise(requestAnimationFrame);
     for(let i=0;i<frames+10;i++){const t=await new Promise(requestAnimationFrame);if(i>=10)intervals.push(t-last);last=t;}
     r.renderFrame=original;for(let i=0;i<20&&queries.length;i++){await new Promise(requestAnimationFrame);poll();}for(const q of queries)gl.deleteQuery(q);
     const stats=a=>{a.sort((a,b)=>a-b);return{samples:a.length,median:a[Math.floor(a.length/2)]??0,p95:a[Math.floor(a.length*.95)]??0};};
     const debug=gl.getExtension('WEBGL_debug_renderer_info');
     return{...window.geographicComparison.metrics(),frameMs:stats(intervals),renderCpuMs:stats(cpu),gpuFrameMs:ext&&!disjoint?stats(gpu):null,gpuDisjoint:disjoint,gpu:debug&&gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),resolution:[gl.drawingBufferWidth,gl.drawingBufferHeight],diagnostics:r.geographicVectors.diagnostics,drawCalls:r.renderer.info.render.calls,triangles:r.renderer.info.render.triangles,totalTextures:r.renderer.info.memory.textures};
    },Number(process.env.CL_FRAMES??60));
    assert.doesNotMatch(metrics.gpu,/swiftshader|software|llvmpipe/i);assert.deepEqual(errors,[]);assert.deepEqual(metrics.diagnostics,[]);
    results.push({catalog,view,visible,...metrics});console.log(JSON.stringify(results.at(-1)));
    if(visible)await page.screenshot({path:`${output}/${catalog}-${backend}-${view.replaceAll(' ','-').toLowerCase()}.png`});
   }
  }
 }
 assert.deepEqual(errors,[]);
}finally{await writeFile(`${output}/metrics.json`,JSON.stringify({results,errors},null,2)+'\n');await browser.close();}
