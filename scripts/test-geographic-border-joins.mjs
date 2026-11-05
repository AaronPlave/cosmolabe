/** Real-viewer round joins and shared-border selection, including reversed source order. */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const output=process.env.CL_OUTPUT??'/private/tmp/geographic-border-joins';await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CL_CHROMIUM??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']});
const errors=[],results=[];
try{
 const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:2});page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5188/?catalog=test-catalogs/geographic-vectors-earth-countries');
 await page.waitForFunction(()=>!!window.renderer,null,{timeout:90000});await page.evaluate(()=>window.renderer.waitForInitialAssets());await page.waitForTimeout(1500);
 await page.evaluate(async root=>{
  const THREE=await import('/node_modules/.vite/deps/three.js'),{geodeticToBodyFixed}=await import(`/@fs/${root}/packages/core/src/index.ts`);
  const r=window.renderer;r.stop();r.timeController.pause();r.setLightingMode('flood');r.cameraController.controls.staticMoving=true;
  const b=r.getBodyMesh('Earth'),layer=r.universe.geographicLayers.get('countries');
  const world=(lon,lat,heightKm=0)=>{const p=geodeticToBodyFixed({lonDeg:lon,latDeg:lat,heightKm},layer.datum);return new THREE.Vector3(p.xKm,p.yKm,p.zKm).multiplyScalar(r.scaleFactor).applyQuaternion(b.bodyToWorldQuaternion(new THREE.Quaternion())).add(b.position);};
  window.borderCheck=(name,lon,lat,height,hover=false)=>{
   r.cameraController.applyViewpoint({name:'border regression',position:world(lon,lat,height),target:world(lon,lat),up:new THREE.Vector3(0,0,1)});
   const f=layer.features.find(f=>f.properties.NAME===name),ref={layerId:layer.id,featureId:f.id,bodyName:layer.body};r.geographicVectors.setSelected(hover?null:ref);r.geographicVectors.setHovered(hover?ref:null);r.renderFrame();
   const rings=f.geometry.type==='Polygon'?f.geometry.coordinates:f.geometry.coordinates.flat();const gl=r.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight,pixels=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
   let sampled=0,missing=[];
   for(const ring of rings)for(let i=1;i<ring.length;i++)for(const t of [0,.25,.5,.75]){
    const a=ring[i-1],end=ring[i];const lon=a.lonDeg+(end.lonDeg-a.lonDeg)*t,lat=a.latDeg+(end.latDeg-a.latDeg)*t;
    // Project the same geographic position onto the actual reference-globe
    // triangles along its geodetic normal, rather than assuming an analytic
    // ellipsoid and its tessellated surface have identical screen positions.
    const surface=world(lon,lat),above=world(lon,lat,50);
    const hit=new THREE.Raycaster(above, surface.clone().sub(above).normalize()).intersectObject(b.mesh,true)[0];
    const q=(hit?.point??surface).project(r.camera);
    const x=Math.floor((q.x+1)*w/2),y=Math.floor((q.y+1)*h/2);if(x<8||y<8||x>w-8||y>h-8||q.z>1)continue;
    sampled++;let found=false;for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){const k=((y+dy)*w+x+dx)*4;const red=pixels[k],green=pixels[k+1],blue=pixels[k+2];if(hover?red>230&&green>230&&blue>230:red>230&&green>175&&blue<160)found=true;}
    if(!found)missing.push({i,t,x,y});
   }
   return{name,hover,sampled,missing,draws:r.geographicVectors.metrics.drawCalls,diagnostics:r.geographicVectors.diagnostics};
  };
 },resolve('.'));
 for(const [name,lon,lat,height] of [['Chad',19,15,1900],['Germany',10,51,1200],['France',7.6,48,120]])for(const hover of [false,true]){
  const result=await page.evaluate(args=>window.borderCheck(...args),[name,lon,lat,height,hover]);results.push(result);console.log(JSON.stringify(result));await page.screenshot({path:`${output}/${name.toLowerCase()}-${hover?'hover':'selected'}.png`});assert.ok(result.sampled>0);assert.deepEqual(result.missing,[]);assert.deepEqual(result.diagnostics,[]);
 }
 assert.deepEqual(errors,[]);
}finally{await writeFile(`${output}/metrics.json`,JSON.stringify({results,errors},null,2)+'\n');await browser.close();}
