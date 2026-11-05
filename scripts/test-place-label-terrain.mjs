/** Actual terrain label anchoring, including cameras below the source ellipsoid. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const base=process.env.CL_VIEWER_URL??'http://127.0.0.1:5194/',out=process.env.CL_OUTPUT??'/tmp/place-label-terrain';await mkdir(out,{recursive:true});
const hardware=process.env.CL_GPU==='hardware';
const browser=await chromium.launch({executablePath:hardware?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined,args:hardware?['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1280,height:900},...(process.env.CL_RECORD?{recordVideo:{dir:out,size:{width:1280,height:900}}}:{})});page.setDefaultTimeout(60000);
let gpu=null;
const errors=[],results=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{window.__placeModule=path=>import(performance.getEntriesByType('resource').map(e=>e.name).filter(url=>new URL(url).pathname===path).at(-1)??path);});
try {
 await page.goto(`${base}?catalog=test-catalogs/ingenuity-jezero`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.renderer?.placeNames?.index.places.length>2000);
 gpu=await page.evaluate(()=>{const gl=window.renderer.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return{vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};});
 await page.evaluate(async()=>{
  window.p=await window.__placeModule('/src/lib/places.ts');window.s=await window.__placeModule('/src/lib/viewer-state.svelte.ts');window.sh=await window.__placeModule('/src/lib/shell.svelte.ts');window.nv=await window.__placeModule('/src/lib/navigation-view.svelte.ts');
  window.cosmo.setPlaying(false);window.site=window.p.searchPlaces('Sakarya Vallis')[0];window.nv.navigationView.preset='overhead';window.nv.navigationView.rangeText='20';window.nv.navigationView.framing='custom';
  if(!window.p.navigateToPlace(window.site,'jump'))throw new Error('Sakarya navigation failed');
  window.sh.closeTool('navigate');
 });
 await page.waitForFunction(()=>document.querySelector('.cl-place-name[data-anchor="rendered-surface"]'));
 await page.waitForTimeout(1500);
 for(const {km,acrossKm=0} of (process.env.CL_OBLIQUE_ONLY ? [{km:.1,acrossKm:.5}] : [{km:20},{km:1},{km:.1},{km:.02},{km:.1,acrossKm:.5}])) {
  // Release navigation and look at the actual terrain anchor. The source
  // ellipsoid is kilometres above the ground here; it cannot frame this test.
  const result=await page.evaluate(async({km,acrossKm})=>{
   const r=window.renderer,n=r.placeNames,bm=r.getBodyMesh('Mars'),cc=r.cameraController,site=window.site;
   const seed=n.visibility.get(site.ref)?.anchor;if(!seed)throw new Error('No sampled label anchor');
   window.s.releaseSurfaceTarget();window.p.selectPlace(null);window.sh.closeTool('navigate');
   n.setBodyVisible('Mars',false);for(let i=0;i<3;i++)await new Promise(requestAnimationFrame);
   let anchor=r._renderedPlaceAnchor(bm,seed)??seed;
   const times=[],frames=[];let last=performance.now();
   for(let i=0;i<120;i++) {
    anchor=r._renderedPlaceAnchor(bm,anchor)??anchor;
    const target=anchor.offsetKm.clone().multiplyScalar(r.scaleFactor),up=target.clone().normalize();
    const cameraUp=r.camera.up.clone().applyQuaternion(bm.mesh.quaternion.clone().invert()),side=up.clone().cross(cameraUp).normalize();
    cc.jumpToSurface(bm,{target,position:target.clone().addScaledVector(up,km*r.scaleFactor).addScaledVector(side,acrossKm*r.scaleFactor),up:acrossKm?up:cameraUp});
    r.camera.updateMatrixWorld(true);
    n.setBodyVisible('Mars',true);await new Promise(requestAnimationFrame);
    times.push(n.metrics.cpuMs);const now=performance.now();frames.push(now-last);last=now;
   }
   const cached=n.visibility.get(site.ref),el=[...document.querySelectorAll('.cl-place-name')].find(e=>e.dataset.placeRef===site.ref),hit=r.pickSurface(0,0);
   const actual=hit?.point?.bodyFixedPositionKm,offset=cached?.anchor.offsetKm;
   const errorKm=actual&&offset?Math.hypot(offset.x-actual[0],-offset.z-actual[1],offset.y-actual[2]):null;
   const sorted=times.sort((a,b)=>a-b),rect=el?.getBoundingClientRect(),canvas=r.renderer.domElement.getBoundingClientRect();
   const picked=rect?n.pick(rect.x+rect.width/2-canvas.x,rect.y+rect.height/2-canvas.y):null;
   return{km,acrossKm,hidden:cached?.hidden,screen:cached?.point.clone().project(r.camera),hitRangeKm:hit?.cameraDistanceKm,source:el?.dataset.anchor,accepted:el?.dataset.accepted,opacity:el?.style.opacity,picked:picked?.featureId,featureId:site.feature.id,errorKm,referenceSeparationKm:n.anchors.get(site.ref).offset.length()-anchor.offsetKm.length(),cameraRadiusKm:r.camera.position.distanceTo(bm.position)/r.scaleFactor,anchorRadiusKm:anchor.offsetKm.length(),p95CpuMs:sorted[Math.floor(sorted.length*.95)],meanFrameMs:frames.reduce((a,b)=>a+b,0)/frames.length,metrics:n.metrics};
  },{km,acrossKm});
  console.log(JSON.stringify(result));
  assert.equal(result.source,'rendered-surface');assert.equal(result.accepted,'true');assert.ok(Number(result.opacity)>.5);assert.equal(result.picked,result.featureId);assert.notEqual(result.errorKm,null);assert.ok(result.errorKm<.01,JSON.stringify(result));
  results.push(result);await page.screenshot({path:`${out}/sakarya-${km}km${acrossKm?'-oblique':''}.png`});
 }
 assert.deepEqual(errors,[]);
} catch(error){await page.screenshot({path:`${out}/failure.png`});throw error;}
finally{await writeFile(`${out}/results.json`,JSON.stringify({hardware,gpu,results,errors},null,2));await browser.close();}
