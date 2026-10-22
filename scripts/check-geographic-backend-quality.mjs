/** Capture known upstream limitations without asserting that the alternative must pass them. */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const output=process.env.CL_OUTPUT??'/private/tmp/geographic-backend-quality';await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CL_CHROMIUM??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
const results=[],errors=[];
try{
 const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:2});
 page.on('pageerror',e=>errors.push(e.message));
 for(const backend of ['vector','raster']){
  await page.goto(`http://127.0.0.1:5188/?catalog=test-catalogs/geographic-vectors-earth-overlay-comparison&geographic-comparison=${backend}`);
  await page.waitForFunction(()=>!!window.geographicComparison,null,{timeout:90000});
  await page.evaluate(()=>window.renderer.waitForInitialAssets());
  await page.evaluate(()=>window.renderer.setLightingMode('flood'));await page.waitForTimeout(3000);
  await page.evaluate(async root=>{
   const {geodeticToBodyFixed}=await import(`/@fs/${root}/packages/core/src/index.ts`),THREE=await import('/node_modules/.vite/deps/three.js');
   window.comparisonPoint=(lon,lat)=>{
    const r=window.renderer,b=r.getBodyMesh('Earth'),layer=r.universe.geographicLayers.get('countries'),p=geodeticToBodyFixed({lonDeg:lon,latDeg:lat},layer.datum);
    const q=new THREE.Vector3(p.xKm,p.yKm,p.zKm).multiplyScalar(r.scaleFactor).applyQuaternion(b.bodyToWorldQuaternion(new THREE.Quaternion())).add(b.position).project(r.camera),rect=r.renderer.domElement.getBoundingClientRect();
    return{x:(q.x+1)*rect.width/2,y:(1-q.y)*rect.height/2};
   };
   window.comparisonPixel=(lon,lat)=>{const r=window.renderer;r.renderFrame();const gl=r.renderer.getContext(),point=window.comparisonPoint(lon,lat),pixel=new Uint8Array(4),rect=r.renderer.domElement.getBoundingClientRect();gl.readPixels(Math.floor(point.x/rect.width*gl.drawingBufferWidth),gl.drawingBufferHeight-1-Math.floor(point.y/rect.height*gl.drawingBufferHeight),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return [...pixel];};
  },resolve('.'));
  const records=[];
  for(const [view,points] of [['Earth orbit',[[2,47,'France'],[-0.9,-16.2,'ocean / seam artifact probe']]],['Antarctica',[[0,-89,'Antarctic interior']]],['Southern Africa holes',[[28.5,-29.5,'Lesotho hole'],[27,-29,'South African fill']]]]){
   await page.evaluate(view=>window.renderer.applyNamedViewpoint(view),view);await page.waitForTimeout(2500);
   const samples=[];
   for(const [lon,lat,label] of points){
    await page.evaluate(()=>window.geographicComparison.setVisible(false));await page.waitForTimeout(300);const off=await page.evaluate(([lon,lat])=>window.comparisonPixel(lon,lat),[lon,lat]);
    await page.evaluate(()=>window.geographicComparison.setVisible(true));await page.waitForTimeout(300);const on=await page.evaluate(([lon,lat])=>window.comparisonPixel(lon,lat),[lon,lat]);
    const hit=await page.evaluate(([lon,lat])=>{const p=window.comparisonPoint(lon,lat),r=window.renderer,hit=r.pickScene(p.x,p.y,'select',{labelSlopPx:0});return{kind:hit?.kind??null,featureId:hit?.featureId??null};},[lon,lat]);
    samples.push({lon,lat,label,off,on,rgbDifference:off.slice(0,3).reduce((n,v,i)=>n+Math.abs(v-on[i]),0),hit});
   }
   const style=await page.evaluate(()=>window.geographicComparison.highlight('South Africa'));
   await page.waitForTimeout(800);
   await page.waitForFunction(()=>!window.geographicComparison.metrics().pendingRedraws,null,{timeout:30000});
   if(view==='Southern Africa holes')for(const sample of samples){sample.highlighted=await page.evaluate(([lon,lat])=>window.comparisonPixel(lon,lat),[sample.lon,sample.lat]);sample.highlightDifference=sample.on.slice(0,3).reduce((n,v,i)=>n+Math.abs(v-sample.highlighted[i]),0);}
   records.push({view,samples,style});await page.screenshot({path:`${output}/${backend}-${view.replaceAll(' ','-').toLowerCase()}.png`});
   await page.evaluate(()=>window.geographicComparison.highlight(null));
  }
  results.push({backend,records,metrics:await page.evaluate(()=>window.geographicComparison.metrics())});
 }
 // A screenshot pair uses the actual normal viewer on each side; timing above is independent.
 await page.setViewportSize({width:1920,height:1080});
 await page.goto('http://127.0.0.1:5188/geographic-compare.html');
 await page.waitForFunction(()=>!!window.comparisonViewers,null,{timeout:90000});
 await page.evaluate(()=>window.comparisonViewers.forEach(r=>r.setLightingMode('flood')));await page.waitForTimeout(5000);
 for(const view of ['Earth orbit','Europe and Africa','Pacific dateline','Antarctica','Rhine close']){
  await page.selectOption('#view',view);await page.waitForTimeout(3000);await page.screenshot({path:`${output}/pair-${view.replaceAll(' ','-').toLowerCase()}.png`});
 }
 assert.deepEqual(errors,[]);
}finally{await writeFile(`${output}/quality.json`,JSON.stringify({results,errors},null,2)+'\n');await browser.close();}
