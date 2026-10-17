/** Real catalog performance, including measured terrain, normal rendering and pointer hover. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const frames = Number(process.env.CL_FRAMES ?? 100);
const output = process.env.CL_OUTPUT ?? '/private/tmp/geographic-viewer-performance';
await mkdir(output, {recursive:true});
const browser = await chromium.launch({executablePath:process.env.CL_CHROMIUM ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
try {
 const page = await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:2});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('console', m=>{if(/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(m.text())) errors.push(m.text());});
 const results=[];
 for(const catalog of ['geographic-vectors-jezero-terrain','geographic-vectors-jezero-dense']) {
  await page.goto(`${process.env.CL_VIEWER_URL??'http://127.0.0.1:5188/'}?catalog=test-catalogs/${catalog}`,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>!!window.renderer,null,{timeout:60000});
  await page.evaluate(()=>window.renderer.waitForInitialAssets());
  await page.waitForFunction(()=>window.renderer.getBodyMesh('Mars')?.terrainMetrics?.tiles.drawn>0,null,{timeout:60000});
  await page.waitForTimeout(3000);
  for(const visible of [false,true]) {
   await page.evaluate(visible=>window.renderer.geographicVectors.setVisible('registration',visible),visible);
   await page.mouse.move(960,540);
   const result=await page.evaluate(async frames=>{
    const r=window.renderer, samples=[], cpu=[], hover=[];
    const oldRender=r.renderFrame.bind(r),oldPick=r.geographicVectors.pick.bind(r.geographicVectors);
    r.renderFrame=(...args)=>{const t=performance.now();const out=oldRender(...args);cpu.push(performance.now()-t);return out;};
    r.geographicVectors.pick=(...args)=>{const t=performance.now();const out=oldPick(...args);hover.push(performance.now()-t);return out;};
    let last=await new Promise(requestAnimationFrame);
    for(let i=0;i<frames;i++){const now=await new Promise(requestAnimationFrame);if(i>=10)samples.push(now-last);last=now;}
    r.renderFrame=oldRender;r.geographicVectors.pick=oldPick;
    const stats=a=>{a.sort((x,y)=>x-y);return{samples:a.length,median:a[Math.floor(a.length/2)]??0,p95:a[Math.floor(a.length*.95)]??0,max:a.at(-1)??0};};
    const gl=r.renderer.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info');
    return{features:r.geographicVectors.featureCount,gpu:debug&&gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),frameMs:stats(samples),renderCpuMs:stats(cpu),pickCpuMs:stats(hover),vectorMetrics:r.geographicVectors.metrics,diagnostics:r.geographicVectors.diagnostics,resolution:[gl.drawingBufferWidth,gl.drawingBufferHeight],terrain:r.getBodyMesh('Mars').terrainMetrics};
   },frames);
   assert.deepEqual(errors,[]); assert.deepEqual(result.diagnostics,[]);
   assert.equal(result.features,visible?(catalog.endsWith('dense')?1601:15):0);
   assert.doesNotMatch(result.gpu,/swiftshader|llvmpipe|software/i);
   if(visible&&catalog.endsWith('dense')) {
    assert.ok(result.frameMs.p95<=Number(process.env.CL_MAX_FRAME_MS??50),`Dense 4K viewer p95 ${result.frameMs.p95} ms exceeds budget`);
    const cyanPixels = await page.evaluate(()=>{
      const r=window.renderer;r.renderFrame();const gl=r.renderer.getContext();
      const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
      gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      let cyan=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+1]>pixels[i]+25&&pixels[i+2]>pixels[i]+25)cyan++;
      return cyan;
    });
    assert.ok(cyanPixels>100000,`Dense fixture must actually draw, got ${cyanPixels} cyan pixels`);
    result.cyanPixels=cyanPixels;
    await page.screenshot({path:`${output}/dense-4k.png`});
    await page.mouse.down(); await page.mouse.move(1030,570,{steps:30}); await page.mouse.up();
    const moved = await page.evaluate(()=>({features:window.renderer.geographicVectors.featureCount,diagnostics:window.renderer.geographicVectors.diagnostics}));
    assert.equal(moved.features,1601);assert.deepEqual(moved.diagnostics,[]);
    result.zooms=[];
    for(const name of ['Jezero regional','Jezero orbit','Jezero close']) {
      await page.evaluate(name=>window.renderer.applyNamedViewpoint(name),name);
      await page.waitForTimeout(1500);
      const zoom = await page.evaluate(async()=>{
        const samples=[];let last=await new Promise(requestAnimationFrame);
        for(let i=0;i<50;i++){const now=await new Promise(requestAnimationFrame);if(i>=10)samples.push(now-last);last=now;}
        samples.sort((a,b)=>a-b);
        return {median:samples[Math.floor(samples.length/2)],p95:samples[Math.floor(samples.length*.95)],features:window.renderer.geographicVectors.featureCount,diagnostics:window.renderer.geographicVectors.diagnostics};
      });
      assert.equal(zoom.features,1601);assert.deepEqual(zoom.diagnostics,[]);
      assert.ok(zoom.p95<=Number(process.env.CL_MAX_FRAME_MS??50),`${name}: ${zoom.p95} ms p95 exceeds budget`);
      result.zooms.push({name,...zoom});
    }
   }
   results.push({catalog,visible,...result});console.log(JSON.stringify(results.at(-1)));
  }
 }
 assert.deepEqual(errors,[]);
 await writeFile(`${output}/metrics.json`,JSON.stringify({results,errors},null,2)+'\n');
}finally{await browser.close();}
