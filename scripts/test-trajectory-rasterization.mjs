/** Compare native trajectory coverage with main at the user's frozen Cassini pose.
 * node scripts/test-trajectory-rasterization.mjs BRANCH_URL MAIN_URL OUTPUT
 * The regression fixture restores 6d71adf's single-sample/minimum-2 density.
 */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import sharp from 'sharp';
const base=process.argv[2]??'http://127.0.0.1:5175/';
const main=process.argv[3]??'http://localhost:5174/';
const out=process.argv[4]??'work/ingenuity-246/review-followup/cassini-native';
await mkdir(out,{recursive:true});
const view={version:1,catalog:{catalog:'test-catalogs/cassini-soi'},time:{kind:'fixed',source:'ET',et:141922255.9896023},view:{kind:'pose',version:1,frame:'ECLIPJ2000',origin:'Saturn',camera:{position:[133632.74594412823,290470.40696652024,762894.881539955],target:[0,0,0],up:[-0.051454908835326205,0.8464301215234609,-0.530007963840662],fov:60}},navigation:{selected:null,tracked:'Saturn',lookAt:null,mode:'free-orbit'},playback:{playing:false,rate:1},display:{trajectories:true,labels:true,grid:false,axes:false,sensors:false,sensorLabels:false}};
const browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),args:['--enable-gpu','--ignore-gpu-blocklist',process.platform==='darwin'?'--use-angle=metal':'--use-angle=swiftshader']});
const result={passed:false,views:[],comparisons:[],errors:[]};
try{
 for(const dpr of [1,2])for(const variant of ['main','regression','corrected']){
  const context=await browser.newContext({viewport:{width:1000,height:800},deviceScaleFactor:dpr});
  if(variant==='regression')await context.addInitScript(()=>{
   const original=HTMLCanvasElement.prototype.getContext;
   HTMLCanvasElement.prototype.getContext=function(kind,...args){if(kind==='webgl2')args[0]={...args[0],antialias:false};return original.call(this,kind,...args);};
  });
  const page=await context.newPage();page.on('pageerror',e=>result.errors.push({variant,dpr,error:e.message}));
  await page.goto(`${variant==='main'?main:base}?catalog=test-catalogs/cassini-soi&view=${encodeURIComponent(JSON.stringify(view))}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.renderer?.trajectoryLines?.size>=10,null,{timeout:120000});
  await page.evaluate(async variant=>{const r=window.renderer;await r.waitForInitialAssets();window.cosmo.setPlaying(false);r.timeController.setTime(141922255.9896023);if(variant==='regression')r.getContext().webglRenderer.setPixelRatio(Math.max(2,window.devicePixelRatio));},variant);
  await page.waitForFunction(()=>window.renderer.trajectoryLines.get('Cassini')?.cache?.count>0,null,{timeout:120000});
  await page.waitForTimeout(1000);
  const frame=await page.evaluate(()=>{
   const r=window.renderer;r.stop();const w=r.getContext().webglRenderer,g=w.getContext(),dbg=g.getExtension('WEBGL_debug_renderer_info');const initializationGlErrors=[];for(let i=0;i<20;i++){const e=g.getError();if(!e)break;initializationGlErrors.push(e);}r.renderFrame();
   return{et:r.timeController.et,playing:r.timeController.playing,initializationGlErrors,image:w.domElement.toDataURL(),density:w.getPixelRatio(),samples:g.getParameter(g.SAMPLES),gpu:g.getParameter(dbg?dbg.UNMASKED_RENDERER_WEBGL:g.RENDERER),camera:{position:r.camera.position.toArray(),quaternion:r.camera.quaternion.toArray(),fov:r.camera.fov},glError:g.getError()};
  });
  const key=`${variant}-dpr${dpr}`;
  await writeFile(`${out}/${key}.png`,Buffer.from(frame.image.split(',')[1],'base64'));delete frame.image;
  await page.locator('canvas').first().screenshot({path:`${out}/${key}-display.png`});
  // Isolate the same native line objects, preserving their authored materials,
  // draw ranges, transforms, vertex fades, and the final camera. This removes
  // labels/stars/rings from the brightness measurement, not from acceptance views.
  const isolated=await page.evaluate(()=>{
   const r=window.renderer,w=r.getContext().webglRenderer;let count=0;
   r.scene.traverse(o=>{if(o.material&&!o.isLine)o.visible=false;if(o.isLine&&o.layers.isEnabled(2)&&o.visible&&o.geometry.drawRange.count>0)count++;});
   r.camera.layers.set(2);w.autoClear=true;w.setClearColor(0,1);w.render(r.scene,r.camera);
   return{image:w.domElement.toDataURL(),count};
  });
  const bytes=Buffer.from(isolated.image.split(',')[1],'base64');await writeFile(`${out}/${key}-lines.png`,bytes);
  const pixels=await sharp(bytes).removeAlpha().raw().toBuffer();let energy=0,lit=0;
  for(let n=0;n<pixels.length;n+=3){energy+=pixels[n]+pixels[n+1]+pixels[n+2];if(pixels[n]+pixels[n+1]+pixels[n+2]>0)lit++;}
  result.views.push({variant,dpr,...frame,lines:isolated.count,cssNormalizedEnergy:energy/frame.density**2,cssNormalizedLitPixels:lit/frame.density**2});
  assert.equal(frame.glError,0);assert.doesNotMatch(frame.gpu,/software|swiftshader|llvmpipe/i);assert.equal(frame.density,variant==='regression'?Math.max(2,dpr):dpr);assert.equal(frame.samples>0,variant!=='regression');
  console.log(result.views.at(-1));await context.close();
 }
 for(const dpr of [1,2]){
  const rows=result.views.filter(v=>v.dpr===dpr),reference=rows.find(v=>v.variant==='main');
  for(const row of rows){assert.equal(row.et,view.time.et);assert.equal(row.playing,false);assert.equal(row.lines,reference.lines);assert.equal(row.camera.fov,reference.camera.fov);for(let i=0;i<3;i++)assert.ok(Math.abs(row.camera.position[i]-reference.camera.position[i])<1e-8);}
  const corrected=rows.find(v=>v.variant==='corrected'),regression=rows.find(v=>v.variant==='regression');
  const comparison={dpr,correctedEnergyRatio:corrected.cssNormalizedEnergy/reference.cssNormalizedEnergy,regressionEnergyRatio:regression.cssNormalizedEnergy/reference.cssNormalizedEnergy};
  result.comparisons.push(comparison);assert.ok(Math.abs(comparison.correctedEnergyRatio-1)<0.02,'Corrected line coverage must match main');
  if(dpr===1)assert.ok(comparison.regressionEnergyRatio<0.7,'Fixture must reproduce dimmer low-density trajectories');
 }
 assert.deepEqual(result.errors,[]);result.passed=true;
}finally{await writeFile(`${out}/metrics.json`,JSON.stringify(result,null,2)+'\n');await browser.close();}
