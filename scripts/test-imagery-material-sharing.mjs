/** Actual GPU page-binding isolation when separately addressed physical meshes
 * reuse a material, including removal/replacement of the conflicting tile. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import sharp from 'sharp';
const base=process.argv[2]??'http://localhost:5173/',out=process.argv[3]??'work/ingenuity-246/review-followup/material-sharing';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),args:['--enable-gpu','--ignore-gpu-blocklist',process.platform==='darwin'?'--use-angle=metal':'--use-angle=swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:900}}),report={passed:false,errors:[]};page.on('pageerror',e=>report.errors.push(e.message));
try{
 await page.goto(`${base}?catalog=test-catalogs/ingenuity-jezero`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.renderer?.getBodyMesh('Mars')?.terrainManager?.cubeImageryStats?.version,null,{timeout:120000});
 await page.evaluate(async()=>{await window.renderer.waitForInitialAssets();window.cosmo.setPlaying(false);});
 await page.waitForFunction(()=>{const t=window.renderer.getBodyMesh('Mars').terrainManager,n=t.metrics.network,i=t.cubeImageryStats;return n.queued+n.downloading+n.parsing+i.queued+i.inFlight===0;},null,{timeout:120000});
 const data=await page.evaluate(()=>{
  const r=window.renderer,t=r.getBodyMesh('Mars').terrainManager,l=t.cubeImageryLayer,wr=r.getContext().webglRenderer;
  r.cameraController.cancelAnimation();r.cameraController.controls.staticMoving=true;
  t.setDebugMode('imagery-level');r.renderFrame();
  // Compare the physical terrain pass before labels/marker animations. Read
  // synchronously while WebGL's non-preserved drawing buffer is valid.
  const capture=()=>{const original=wr.render;let image;wr.render=function(scene,camera){const answer=original.call(this,scene,camera);if(scene===r.scene&&camera.layers.mask===1)image=this.domElement.toDataURL();return answer;};try{r.renderFrame();}finally{wr.render=original;}if(!image)throw Error('No terrain pass');return image;};
  const records=[...l.tiles].filter(([,v])=>v.scene.parent&&v.scene.visible&&v.meshes.length===1);
  if(records.length<2)throw Error('Need two visible terrain addresses');
  const [,first]=records[0],[secondKey,second]=records.find(([,v])=>v.address.face!==first.address.face||v.address.x!==first.address.x||v.address.y!==first.address.y||v.address.level!==first.address.level)??[];
  if(!second)throw Error('No separately addressed tile');const material=first.meshes[0].mesh.material,mesh=second.meshes[0].mesh;
  // Normalize non-imagery material properties before the A/B: assigning a
  // shared input must not also change the original tile's fade/style values.
  const independent=material.clone(),hooks=l.materialHooks.get(material);
  independent.onBeforeCompile=hooks.baseCompile;
  independent.customProgramCacheKey=()=>material.customProgramCacheKey()+'_independent_fixture';
  l.removeTile(secondKey);mesh.material=independent;l.addTile(secondKey,second.scene,second.address);
  const before=capture(),control=capture();
  l.removeTile(secondKey);mesh.material=material;l.addTile(secondKey,second.scene,second.address);const shared=capture(),isolated=mesh.material!==material,sameProgram=mesh.material.customProgramCacheKey()===material.customProgramCacheKey();
  l.removeTile(secondKey);const restored=mesh.material===material;l.addTile(secondKey,second.scene,second.address);const replaced=capture();
  const gl=wr.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return{before,control,shared,replaced,isolated,sameProgram,restored,first:first.address,second:second.address,stats:t.cubeImageryStats,gpu:gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER),glError:gl.getError()};
 });
 for(const key of ['before','control','shared','replaced'])await writeFile(`${out}/${key}.png`,Buffer.from(data[key].split(',')[1],'base64'));
 const pixels=async v=>sharp(Buffer.from(v.split(',')[1],'base64')).removeAlpha().raw().toBuffer(),a=await pixels(data.before);assert.ok(a.some(v=>v>20),'Empty canvas capture');
 report.comparisons=[];for(const key of ['control','shared','replaced']){const b=await pixels(data[key]);let changed=0;const locations=[];for(let i=0;i<a.length;i+=3)if(Math.max(...[0,1,2].map(c=>Math.abs(a[i+c]-b[i+c])))>2){changed++;locations.push([i/3%1440,Math.floor(i/3/1440)]);}report.comparisons.push({key,changedPixels:changed,locations});assert.equal(changed,0,`${key} changed physical GPU page lookup`);}
 for(const key of ['before','control','shared','replaced']){await writeFile(`${out}/${key}.png`,Buffer.from(data[key].split(',')[1],'base64'));delete data[key];}
 Object.assign(report,data);assert.ok(data.isolated&&data.sameProgram&&data.restored);assert.equal(data.stats.extraDraws,0);assert.equal(data.glError,0);assert.doesNotMatch(data.gpu,/SwiftShader|llvmpipe/i);assert.deepEqual(report.errors,[]);report.passed=true;
}finally{await writeFile(`${out}/metrics.json`,JSON.stringify(report,null,2));await browser.close();}
