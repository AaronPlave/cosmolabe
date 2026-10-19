/** Normal-viewer global smoke and optional hardware benchmark. No injected scene.
 * CL_GPU=hardware uses Metal; otherwise use software WebGL for a CI smoke.
 * CL_FRAMES=60 CL_MAX_FRAME_MS=50 control the separate hardware timing gate. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const output=process.env.CL_OUTPUT??'/private/tmp/geographic-global';
await mkdir(output,{recursive:true});
const hardware=process.env.CL_GPU==='hardware';
const browser=await chromium.launch({executablePath:process.env.CL_CHROMIUM??(hardware?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':chromium.executablePath()),args:hardware?['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const results=[],errors=[];
try {
 const page=await browser.newPage({viewport:process.env.CL_SMOKE?{width:640,height:480}:{width:1920,height:1080},deviceScaleFactor:hardware?2:1});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(m.text()))errors.push(m.text());});
 await page.goto(`${process.env.CL_VIEWER_URL??'http://127.0.0.1:5188/'}?catalog=test-catalogs/geographic-vectors-earth-countries`,{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>!!window.renderer,null,{timeout:60000});
 await page.evaluate(()=>window.renderer.waitForInitialAssets());
 await page.waitForTimeout(1500);
 await page.evaluate(async root=>{
   const THREE=await import('/node_modules/.vite/deps/three.js');
   const {geodeticToBodyFixed}=await import(`/@fs/${root}/packages/core/src/index.ts`);

   window.__globalProject=(lon,lat)=>{
     const r=window.renderer,bm=r.getBodyMesh('Earth'),layer=window.renderer.universe.geographicLayers.get('countries');
     const p=geodeticToBodyFixed({lonDeg:lon,latDeg:lat},layer.datum);
     const world=new THREE.Vector3(p.xKm,p.yKm,p.zKm).multiplyScalar(r.scaleFactor).applyQuaternion(bm.bodyToWorldQuaternion(new THREE.Quaternion())).add(bm.position);
     const q=world.project(r.camera),rect=r.renderer.domElement.getBoundingClientRect();
     return{x:(q.x+1)/2*rect.width,y:(1-q.y)/2*rect.height};
   };
   window.__globalIdentity=hit=>window.renderer.universe.geographicLayers.get('countries').features.find(f=>f.id===hit?.featureId)?.properties.NAME??null;
 },resolve('.'));
 for(const name of process.env.CL_GEOMETRY_ONLY?[]:['Earth orbit','Europe and Africa','Pacific dateline','Antarctica','Rhine close']) {
  await page.evaluate(name=>window.renderer.applyNamedViewpoint(name),name);
  await page.waitForTimeout(800);
  for(const visible of [false,true]) {
   await page.evaluate(visible=>window.renderer.geographicVectors.setVisible('countries',visible),visible);
   await page.waitForTimeout(1200);
   await page.mouse.move(page.viewportSize().width/2,page.viewportSize().height/2);
   const result=await page.evaluate(async ({frames,warmup})=>{
    const r=window.renderer,cpu=[],picks=[],intervals=[];
    const gl=r.renderer.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2'),queries=[],gpuTimes=[];
    let disjoint=false;
    const poll=()=>{
      if(ext&&gl.getParameter(ext.GPU_DISJOINT_EXT))disjoint=true;
      for(let i=queries.length-1;i>=0;i--)if(gl.getQueryParameter(queries[i],gl.QUERY_RESULT_AVAILABLE)){
        gpuTimes.push(gl.getQueryParameter(queries[i],gl.QUERY_RESULT)/1e6);gl.deleteQuery(queries[i]);queries.splice(i,1);
      }
    };
    let submitted=0;
    const render=r.renderFrame.bind(r),pick=r.geographicVectors.pick.bind(r.geographicVectors);
    r.renderFrame=(...args)=>{
      poll();const query=ext&&submitted<20?gl.createQuery():null;
      if(query){gl.beginQuery(ext.TIME_ELAPSED_EXT,query);submitted++;}
      const t=performance.now();const v=render(...args);cpu.push(performance.now()-t);
      if(query){gl.endQuery(ext.TIME_ELAPSED_EXT);queries.push(query);}return v;
    };
    r.geographicVectors.pick=(...args)=>{const t=performance.now();const v=pick(...args);picks.push(performance.now()-t);return v;};
    let last=await new Promise(requestAnimationFrame);
    for(let i=0;i<frames+warmup;i++){const t=await new Promise(requestAnimationFrame);if(i>=warmup)intervals.push(t-last);last=t;}
    r.renderFrame=render;r.geographicVectors.pick=pick;
    const stats=a=>{a.sort((a,b)=>a-b);return{samples:a.length,median:a[Math.floor(a.length/2)]??0,p95:a[Math.floor(a.length*.95)]??0};};
    for(let i=0;i<20&&queries.length;i++){await new Promise(requestAnimationFrame);poll();}
    for(const query of queries)gl.deleteQuery(query);
    const debug=gl.getExtension('WEBGL_debug_renderer_info');
    return{features:r.geographicVectors.featureCount,diagnostics:r.geographicVectors.diagnostics,metrics:r.geographicVectors.metrics,
      indexes:r.geographicVectors.batches.map(b=>{const packed=b.index.pack();return{features:b.index.features.length,primitives:b.index.primitives.length,coarseReferences:b.index.cells.reduce((n,c)=>n+c.length,0),totalReferences:packed.references.length/4,detailLevels:packed.detail?.levels,pages:b.material.pages};}),
      frameMs:stats(intervals),renderCpuMs:stats(cpu),pickCpuMs:stats(picks),resolution:[gl.drawingBufferWidth,gl.drawingBufferHeight],gpu:debug&&gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),gpuFrameMs:ext&&!disjoint&&gpuTimes.length?stats(gpuTimes):null,gpuDisjoint:disjoint};
   },{frames:Number(process.env.CL_FRAMES??60),warmup:process.env.CL_SMOKE?0:10});
   results.push({name,visible,...result});console.log(JSON.stringify(results.at(-1)));
   assert.deepEqual(result.diagnostics,[]);assert.equal(result.features,visible?177:0);
   if(hardware){assert.doesNotMatch(result.gpu,/swiftshader|llvmpipe|software/i);assert.deepEqual(result.resolution,[3840,2160]);}
   const pixels=await page.evaluate(visible=>{
     const r=window.renderer;r.renderFrame();const gl=r.renderer.getContext();
     const bytes=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
     gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
     if(!visible){window.__globalBaselineBytes=bytes;return null;}
     let changed=0,cyan=0;
     for(let i=0;i<bytes.length;i+=4){
       if(Math.abs(bytes[i]-window.__globalBaselineBytes[i])+Math.abs(bytes[i+1]-window.__globalBaselineBytes[i+1])+Math.abs(bytes[i+2]-window.__globalBaselineBytes[i+2])>12)changed++;
       if(bytes[i+1]>bytes[i]+25&&bytes[i+2]>bytes[i]+25)cyan++;
     }
     window.__globalBaselineBytes=null;return{changed,cyan};
   },visible);
   if(visible){assert.ok(pixels.changed>1000,`${name}: no visible geometry`);results.at(-1).pixels=pixels;}
   if(visible)await page.screenshot({path:`${output}/${name.replaceAll(' ','-').toLowerCase()}.png`});
  }
  const target={ 'Earth orbit':[2,47,'France'], 'Europe and Africa':[20,10,'Chad'], 'Pacific dateline':[178,-17.8,'Fiji'], Antarctica:[0,-89,'Antarctica'], 'Rhine close':[7.2,48,'France'] }[name];
  const screen=await page.evaluate(([lon,lat])=>window.__globalProject(lon,lat),target);
  const hit=await page.evaluate(({x,y})=>{
    const hit=window.renderer.pickScene(x,y,'select',{labelSlopPx:0});
    return{hit,name:window.__globalIdentity(hit)};
  },screen);
  assert.equal(hit.name,target[2],`${name}: geographic pick`);
  await page.mouse.move(screen.x,screen.y);
  await page.waitForFunction(name=>window.__globalIdentity(window.renderer.geographicVectors.hovered)===name,target[2],{timeout:5000});
  const hover=await page.evaluate(()=>window.__globalIdentity(window.renderer.geographicVectors.hovered));
  assert.equal(hover,target[2],`${name}: actual hover`);
  await page.mouse.click(screen.x,screen.y);
  await page.waitForFunction(name=>window.__globalIdentity(window.renderer.geographicVectors.selected)===name,target[2],{timeout:5000});
  const selected=await page.evaluate(()=>window.__globalIdentity(window.renderer.geographicVectors.selected));
  assert.equal(selected,target[2],`${name}: actual selection`);
  results.at(-1).interaction={screen,hit:hover,selected};
  for(const returnToOrigin of [false,true]) {
    const center={x:page.viewportSize().width/2,y:page.viewportSize().height/2};
    const steps=process.env.CL_SMOKE?3:20;
    await page.mouse.move(center.x,center.y);await page.mouse.down();await page.mouse.move(center.x+80,center.y+25,{steps});
    if(returnToOrigin)await page.mouse.move(center.x,center.y,{steps});
    await page.mouse.up();
    assert.equal(await page.evaluate(()=>window.__globalIdentity(window.renderer.geographicVectors.selected)),target[2],`${name}: drag preserves selection (return=${returnToOrigin})`);
  }
  await page.evaluate(()=>window.renderer.geographicVectors.setSelected(null));
 }
 const geometryChecks=await page.evaluate(async root=>{
   const r=window.renderer;r.stop();r.timeController.pause();r.cameraController.controls.staticMoving=true;
   const THREE=await import('/node_modules/.vite/deps/three.js');
   const {FixedRotation}=await import(`/@fs/${root}/packages/core/src/index.ts`);
   const layer=r.universe.geographicLayers.get('countries'),all=layer.features;
   const load=features=>{layer.features=features;r.universe.events.emit('geographic:changed',{});r.renderFrame();};
   const read=()=>{r.renderFrame();const gl=r.renderer.getContext(),pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels;};
   const sample=(pixels,lon,lat)=>{const p=window.__globalProject(lon,lat),gl=r.renderer.getContext(),rect=r.renderer.domElement.getBoundingClientRect();const x=Math.floor(p.x/rect.width*gl.drawingBufferWidth),y=gl.drawingBufferHeight-1-Math.floor(p.y/rect.height*gl.drawingBufferHeight);return [...pixels.slice((y*gl.drawingBufferWidth+x)*4,(y*gl.drawingBufferWidth+x)*4+3)];};
   const difference=(a,b)=>a.reduce((n,v,i)=>n+Math.abs(v-b[i]),0);
   let hole,backside,rotation;
   try {
     r.geographicVectors.setHovered(null);r.geographicVectors.setSelected(null);
     r.applyNamedViewpoint('Southern Africa holes');r.renderFrame();
     load([]);const base=read();
     load(all.filter(f=>f.properties.NAME==='South Africa'));const country=read();
     const ref=r.geographicVectors.batches[0].index.features[0];
     r.geographicVectors.setSelected(ref);const selected=read();
     window.__globalHolePng=r.renderer.domElement.toDataURL();
     hole={unselected:difference(sample(base,28.5,-29.5),sample(country,28.5,-29.5)),selected:difference(sample(base,28.5,-29.5),sample(selected,28.5,-29.5)),fill:difference(sample(base,27,-29),sample(country,27,-29)),pick:window.__globalIdentity(r.pickScene(window.__globalProject(28.5,-29.5).x,window.__globalProject(28.5,-29.5).y,'select',{labelSlopPx:0}))};
     r.geographicVectors.setSelected(null);r.applyNamedViewpoint('Earth orbit');r.renderFrame();
     load([]);const unmarked=read();load(all.filter(f=>f.properties.NAME==='Australia'));const hidden=read();
     let changed=0,backgroundChanges=0;const differences=[];
     const gl=r.renderer.getContext(),rect=r.renderer.domElement.getBoundingClientRect();
     for(let i=0;i<hidden.length;i+=4)if(difference([...unmarked.slice(i,i+3)],[...hidden.slice(i,i+3)])>12){
       const pixel=i/4,x=pixel%gl.drawingBufferWidth,y=Math.floor(pixel/gl.drawingBufferWidth);
       const hit=r.pickScene(x/gl.drawingBufferWidth*rect.width,(gl.drawingBufferHeight-1-y)/gl.drawingBufferHeight*rect.height,'probe');
       if(hit?.kind==='surface'&&hit.point.bodyName==='Earth') {changed++;if(differences.length<10)differences.push({x,y,before:[...unmarked.slice(i,i+4)],after:[...hidden.slice(i,i+4)],lat:hit.point.latDeg,lon:hit.point.lonDeg});}else backgroundChanges++;
     }
     backside={changed,backgroundChanges,differences,features:r.geographicVectors.featureCount};
     load(all);
     const body=r.universe.getBody('Earth'),original=body.rotation;
     const before=r.getBodyMesh('Earth').bodyToWorldQuaternion(new THREE.Quaternion());
     const beforeScreen=window.__globalProject(2,47);
     const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),0.7);
     body.setRotation(new FixedRotation([q.w,q.x,q.y,q.z],'ECLIPJ2000'));
     r.renderFrame();
     const delta=r.getBodyMesh('Earth').bodyToWorldQuaternion(new THREE.Quaternion()).multiply(before.invert());
     r.camera.position.applyQuaternion(delta);r.camera.up.applyQuaternion(delta);r.cameraController.controls.target.applyQuaternion(delta);
     r.camera.lookAt(r.cameraController.controls.target);r.camera.updateMatrixWorld(true);r.renderFrame();
     const point=window.__globalProject(2,47),hit=r.pickScene(point.x,point.y,'select',{labelSlopPx:0});
     rotation={country:window.__globalIdentity(hit),pixelDrift:Math.hypot(point.x-beforeScreen.x,point.y-beforeScreen.y),quaternion:r.getBodyMesh('Earth').bodyToWorldQuaternion(new THREE.Quaternion()).toArray()};
     body.setRotation(original);
   } finally {load(all);}
   return{hole,backside,rotation,diagnostics:r.geographicVectors.diagnostics};
 },resolve('.'));
 await writeFile(`${output}/south-africa-hole.png`,Buffer.from((await page.evaluate(()=>window.__globalHolePng)).split(',')[1],'base64'));
 results.push({geometryChecks});
 assert.equal(geometryChecks.hole.unselected,0,'Lesotho hole stays unfilled');
 assert.equal(geometryChecks.hole.selected,0,'selection preserves hole');
 assert.ok(geometryChecks.hole.fill>5,'South African fill really draws');
 assert.equal(geometryChecks.hole.pick,null,'South Africa does not pick inside its Lesotho hole');
 assert.equal(geometryChecks.backside.features,1);assert.equal(geometryChecks.backside.changed,0,'backside Australia remains occluded');
 assert.equal(geometryChecks.rotation.country,'France');assert.ok(geometryChecks.rotation.pixelDrift<0.01,'body rotation preserves registered screen position');assert.deepEqual(geometryChecks.diagnostics,[]);
 assert.deepEqual(errors,[]);
}finally {
 await writeFile(`${output}/metrics.json`,JSON.stringify({results,errors},null,2)+'\n');
 await browser.close();
}
if(hardware&&process.env.CL_MAX_FRAME_MS)for(const r of results.filter(r=>r.frameMs))assert.ok(r.frameMs.p95<=Number(process.env.CL_MAX_FRAME_MS),`${r.name} visible=${r.visible}: ${r.frameMs.p95} ms`);
