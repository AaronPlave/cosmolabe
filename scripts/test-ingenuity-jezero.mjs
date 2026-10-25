/** Actual #246 mission, independent products, near-surface loading and GPU acceptance.
 * DEV_DATA_MODE=local npm --prefix apps/viewer run dev -- --port 5198
 * node scripts/test-ingenuity-jezero.mjs [VIEWER_URL] [OUT_DIR]
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
const base=process.argv[2]??'http://127.0.0.1:5198/';
const out=process.argv[3]??'work/ingenuity-246/browser';await mkdir(out,{recursive:true});
const catalog=JSON.parse(await readFile('apps/viewer/test-catalogs/ingenuity-jezero.json','utf8'));
const mars=catalog.items.find(x=>x.name==='Mars');
const sourcePaths=mars.geometry.imagery.map(x=>new URL(x.url,new URL('test-catalogs/ingenuity-jezero.json',base)).pathname.replace(/imagery.json$/,'tiles/'));
const browser=await chromium.launch({headless:true,
  ...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),
  args:[process.platform==='darwin'?'--use-angle=metal':'--use-angle=swiftshader','--enable-gpu','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1440,height:900}});
await page.addInitScript(()=>{
  performance.setResourceTimingBufferSize(10000);
  let renderer;
  Object.defineProperty(window,'renderer',{configurable:true,get:()=>renderer,set:value=>{
    renderer=value;
    if(!value||sessionStorage.getItem('ingenuity-baseline-done'))return;
    const t=value.getBodyMesh('Mars')?.terrainManager,plugin=t?.tiles.getPluginByName('COSMOLABE_NEAR_SURFACE');
    if(!plugin)return;
    // Disable before the first frame, so the paired baseline cannot inherit
    // already-refined visual tiles from an ordinary initial mission load.
    t.tiles.errorTarget=1e6;window.ingenuityNearPlugin=plugin;
    window.ingenuityNearCalculate=plugin.calculateTileViewError;
    plugin.calculateTileViewError=()=>false;
  }});
});
const errors=[],requests=[],result={catalog:'ingenuity-jezero',views:[],loading:[],errors};
let sourceFault=false,baseFault=false;
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(/\.(glb|f32|png)(\?|$)/.test(r.url()))requests.push(r.url());});
page.on('response',r=>{if(r.status()>=400&&!sourceFault&&!baseFault&&!r.url().endsWith('favicon.ico'))errors.push(`${r.status()} ${r.url()}`);});
page.setDefaultTimeout(120000);
const save=()=>writeFile(`${out}/metrics.json`,JSON.stringify(result,null,2)+'\n');
async function ready(){
  await page.waitForFunction(()=>window.renderer?.getBodyMesh('Mars')?.terrainManager?.cubeStats?.version);
  await page.evaluate(async()=>{
    // Import the live app module URL, including Vite's HMR timestamp. Importing
    // a second unqueried URL creates a separate store with no loaded universe.
    window.ingenuityImport=async name=>{
      const suffix='/src/lib/'+name;
      const url=performance.getEntriesByType('resource').map(r=>r.name).find(url=>new URL(url).pathname.endsWith(suffix));
      if(!url)throw new Error('Live app module not found: '+name);
      return import(url);
    };
    await window.renderer.waitForInitialAssets();window.cosmo.setPlaying(false);window.cosmo.untrack();const t=window.renderer.getBodyMesh('Mars').terrainManager;await t.cube.source.ready;await t.cubeImageryLayer.ready;
  });
}
async function settle(budget=true){
  await page.waitForFunction(budget=>{
    const t=window.renderer.getBodyMesh('Mars').terrainManager,n=t.metrics.network,i=t.cubeImageryStats;
    return t.tiles.visibleTiles.size>0&&n.queued+n.downloading+n.parsing===0&&t.cubeStats.inFlight===0&&i.inFlight===0&&(i.queued===0||(budget&&i.budgetLimited));
  },budget,{timeout:180000});
  await page.waitForTimeout(250);
}
async function groundReady(){
  await page.waitForFunction(()=>{
    const r=window.renderer,b=r.getBodyMesh('Mars'),V=r.camera.position.constructor,centre=new V();b.getWorldPosition(centre);
    const p=r.camera.position.clone().sub(centre).divideScalar(r.scaleFactor).applyQuaternion(b.mesh.quaternion.clone().invert());
    return b.terrainManager.navigationSurface({xKm:p.x,yKm:-p.z,zKm:p.y})?.settled;
  },null,{timeout:30000,polling:100});
  await page.waitForTimeout(250);
}
async function pose(lat,lon,altitudeKm=.05){
  return page.evaluate(async({lat,lon,altitudeKm})=>{
    const r=window.renderer,b=r.getBodyMesh('Mars'),t=b.terrainManager,V=r.camera.position.constructor;
    window.cosmo.setPlaying(false);window.cosmo.untrack();
    const la=lat*Math.PI/180,lo=lon*Math.PI/180,d=[Math.cos(la)*Math.cos(lo),Math.cos(la)*Math.sin(lo),Math.sin(la)];
    const ray={origin:{xKm:d[0]*3500,yKm:d[1]*3500,zKm:d[2]*3500},direction:d.map(x=>-x),nearKm:0,farKm:300};
    await t.cube.surface.ensureRayCoverage(ray,{maxMeshErrorKm:0},AbortSignal.timeout(30000));
    const hit=b.intersectTerrainRay(ray,{maxMeshErrorKm:0});if(hit?.kind!=='hit')throw new Error('No mission CPU surface');
    window.ingenuityTestRay=ray;window.ingenuityTestPoint=hit.position;
    const target=[hit.position.xKm,hit.position.yKm,hit.position.zKm],centre=new V();b.getWorldPosition(centre);
    const toWorld=([x,y,z])=>new V(x,z,-y).applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
    const c=r.camera,controls=r.cameraController.controls;controls.enableDamping=false;
    controls.target.copy(toWorld(target));c.position.copy(toWorld(target.map((x,i)=>x+d[i]*altitudeKm)));
    c.fov=45;c.updateProjectionMatrix();
    c.up.copy(toWorld([-Math.sin(la)*Math.cos(lo),-Math.sin(la)*Math.sin(lo),Math.cos(la)]).sub(centre).normalize());
    c.lookAt(controls.target);c.updateMatrixWorld(true);
    if(window.ingenuityFrameProbeArmed){window.ingenuityFrameSamples=[];window.ingenuityCaptureFrames=true;}
    return hit;
  },{lat,lon,altitudeKm});
}
async function snapshot(buffers=false){
  return page.evaluate(buffers=>{
    const r=window.renderer,b=r.getBodyMesh('Mars'),t=b.terrainManager,webgl=r.getContext().webglRenderer;
    const V=r.camera.position.constructor,centre=new V();b.getWorldPosition(centre);
    const local=r.camera.position.clone().sub(centre).divideScalar(r.scaleFactor).applyQuaternion(b.mesh.quaternion.clone().invert());
    const point={xKm:local.x,yKm:-local.z,zKm:local.y},nav=t.navigationSurface(point);
    const gl=webgl.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
    let physicalBufferHash=null;
    if(buffers){
      let hash=2166136261,bytes=0;
      const add=array=>{if(!array)return;const raw=new Uint8Array(array.buffer,array.byteOffset,array.byteLength);bytes+=raw.length;for(const byte of raw)hash=Math.imul(hash^byte,16777619)>>>0;};
      for(const tile of t.tiles.visibleTiles)tile.engineData?.scene?.traverse(mesh=>{
        if(!mesh.isMesh||mesh.name.startsWith('cube-imagery-block '))return;
        add(mesh.geometry.getAttribute('position')?.array);add(mesh.geometry.getAttribute('normal')?.array);add(mesh.geometry.index?.array);
      });
      physicalBufferHash={bytes,fnv1a32:hash.toString(16)};
    }
    return {gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
      physicalBufferHash,
      nav,clearanceM:nav?.radiusKm==null?null:(local.length()-nav.radiusKm)*1000,
      imagery:t.cubeImageryStats,network:t.metrics.network,cpu:t.cubeStats,
      geometry:[...t.tiles.visibleTiles].map(x=>x.content?.uri).sort(),
      cpuHit:b.intersectTerrainRay(window.ingenuityTestRay,{maxMeshErrorKm:0}),
      staticVisible:b.mesh.visible,readyToShow:t.isReadyToShow(),surface:b.surfaceTransitionState};
  },buffers);
}
async function imageryCenter(pixels=false,ndc=null){
  return page.evaluate(async ({root,pixels,ndc})=>{
    const {directionToTexel,parseImageryAddress,tileProjectiveBasis}=await import(`/@fs/${root}/packages/three/src/surface/CubeImagery.ts`);
    const r=window.renderer,l=r.getBodyMesh('Mars').terrainManager.cubeImageryLayer;
    const picked=ndc?r.pickSurface(ndc[0],ndc[1])?.bodyFixedHitKm:null;
    const p=ndc?(picked?{xKm:picked[0],yKm:picked[1],zKm:picked[2]}:null):window.ingenuityTestPoint;
    if(!p)return null;
    const address=directionToTexel([p.xKm,p.yKm,p.zKm],17,1024,2).address;
    const contains=a=>a.face===address.face&&a.level<=17&&Math.floor(address.x/2**(17-a.level))===a.x&&Math.floor(address.y/2**(17-a.level))===a.y;
    const records=[...l.tiles.values()].filter(t=>t.scene.parent&&t.scene.visible&&contains(t.address)).sort((a,b)=>b.address.level-a.address.level);
    const record=records[0];if(!record)return null;
    const m=record.meshes[0];
    const uniforms=m.mesh.visible?m.uniforms:[...m.blocks].find(([id,b])=>b.mesh.visible&&contains(parseImageryAddress(id)))?.[1].uniforms;
    if(!uniforms)return null;
    const basis=tileProjectiveBasis(record.address),dot=a=>p.xKm*a[0]+p.yKm*a[1]+p.zKm*a[2],st=[dot(basis.a)/dot(basis.n),dot(basis.b)/dot(basis.n)];
    return l.order.map((source,i)=>{
      const u=uniforms.layers[i],image=u.map.value?.image;
      let pixelRGBA=null;
      if(pixels&&u.enabled.value&&image){
        const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
        // ImageBitmap is already flipped at decode for t=0 at file bottom.
        const x=Math.min(image.width-1,Math.max(0,Math.floor((st[0]*u.transform.value.x+u.transform.value.z)*image.width)));
        const y=Math.min(image.height-1,Math.max(0,Math.floor((st[1]*u.transform.value.y+u.transform.value.w)*image.height)));
        pixelRGBA=[...ctx.getImageData(x,y,1,1).data];
      }
      return {id:source.info.id,enabled:u.enabled.value,level:u.level.value,pixelRGBA};
    });
  },{root:resolve('.'),pixels,ndc});
}
async function replayCorridors(){
  // Fresh application residency, then representative observed corridors. CPU
  // controls are loaded before placing the camera; visual GLBs still start
  // cold/coarse and refine normally. A smaller cache exercises return visits.
  await page.reload({waitUntil:'domcontentloaded'});await ready();
  await page.evaluate(()=>{const c=window.renderer.getBodyMesh('Mars').terrainManager.tiles.lruCache;window.corridorCache={minSize:c.minSize,maxSize:c.maxSize,minBytesSize:c.minBytesSize,maxBytesSize:c.maxBytesSize};c.minSize=0;c.minBytesSize=0;c.maxBytesSize=64*2**20;});
  await page.evaluate(() => {
    const r = window.renderer;
    window.ingenuityFrameProbeArmed = true; window.ingenuityCaptureFrames = false;
    r.use({name: 'ingenuity-rendered-frame-clearance', onAfterRender: () => {
      if (!window.ingenuityCaptureFrames) return;
      const b = r.getBodyMesh('Mars'), V = r.camera.position.constructor, centre = new V(); b.getWorldPosition(centre);
      const p = r.camera.position.clone().sub(centre).divideScalar(r.scaleFactor).applyQuaternion(b.mesh.quaternion.clone().invert());
      const nav = b.terrainManager.navigationSurface({xKm:p.x, yKm:-p.z, zKm:p.y});
      window.ingenuityFrameSamples.push({clearanceM:nav?.radiusKm == null ? null : (p.length()-nav.radiusKm)*1000,
        discrepancyM:nav?.discrepancyM ?? null, settled:nav?.settled ?? false, clampCorrectionM:r.cameraClampCorrectionKm*1000});
    }});
  });
  result.corridors=[];
  const corridorFlights=JSON.parse(await readFile('apps/viewer/test-catalogs/data/ingenuity/flights_index.json','utf8'));
  for(const flight of [1,12,72]){
    const rows=(await readFile(`apps/viewer/test-catalogs/${corridorFlights[flight-1].file}`,'utf8')).split('\n').filter(x=>x.trim()&&!x.startsWith('#')).map(x=>x.trim().split(/\s+/).map(Number));
    for(const fraction of [0,.25,.5,.75,1]){
      const row=rows[Math.round((rows.length-1)*fraction)],lat=Math.atan2(row[3],Math.hypot(row[1],row[2]))*180/Math.PI,lon=Math.atan2(row[2],row[1])*180/Math.PI;
      await pose(lat,lon,.05);
      const loading=[];
      for(let i=0;i<15;i++){await page.waitForTimeout(50);const state=await snapshot();loading.push({nav:state.nav,clearanceM:state.clearanceM,network:state.network,cpu:state.cpu});}
      result.lastCorridorProbe = {flight, fraction, lat, lon, loading}; await save();
      assert.ok(loading.every(x=>x.clearanceM==null||x.clearanceM>=1.9), `corridor camera crossed the conservative ground: ${JSON.stringify(result.lastCorridorProbe)}`);
      await settle();await groundReady();const final=await snapshot();
      assert.ok(final.nav?.settled&&Math.abs(final.nav.discrepancyM)<=.5,'corridor did not reach the operational geometry tolerance');
      const renderedFrames = await page.evaluate(() => { window.ingenuityCaptureFrames = false; return window.ingenuityFrameSamples; });
      result.lastCorridorProbe.renderedFrames = renderedFrames; await save();
      assert.ok(renderedFrames.length > 0 && renderedFrames.every(frame => frame.clearanceM != null && frame.clearanceM >= 1.9),
        `rendered frame crossed the ground: ${JSON.stringify(result.lastCorridorProbe)}`);
      result.corridors.push({flight,fraction,lat,lon,loading,renderedFrames,final:{nav:final.nav,clearanceM:final.clearanceM,network:final.network,cpu:final.cpu}});await save();
      await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.tiles.lruCache.unloadUnusedContent());
    }
  }
  await page.evaluate(() => { window.ingenuityFrameProbeArmed = false; window.ingenuityCaptureFrames = false; });
  // Return to a previously visited site after the distant final-flight sweep.
  await pose(18.44486301,77.45101915,.05);await settle();await groundReady();
  result.corridorReturn=await snapshot();assert.ok(result.corridorReturn.nav?.settled&&result.corridorReturn.clearanceM>=1.9);
  await page.evaluate(()=>Object.assign(window.renderer.getBodyMesh('Mars').terrainManager.tiles.lruCache,window.corridorCache));
}

try{
  await page.goto(`${base}?catalog=test-catalogs/ingenuity-jezero`,{waitUntil:'domcontentloaded',timeout:120000});console.log('catalog loaded');await ready();console.log('sources ready');
  result.loadedImageryProducts = await page.evaluate(() => window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.sources.map(source => ({
    id: source.info.id, url: source.baseUrl, productIdentity: source.manifest.provenance?.productIdentity,
  })));
  for (const [i, source] of mars.geometry.imagery.entries()) assert.equal(new URL(result.loadedImageryProducts[i].url).pathname,
    new URL(source.url, new URL('test-catalogs/ingenuity-jezero.json', base)).pathname, 'browser loaded a different imagery product');
  if(process.argv[4] === '--clearance-frames-only') {
    await page.evaluate(() => { sessionStorage.setItem('ingenuity-baseline-done', '1'); });
    await replayCorridors();
    result.passed = true; result.clearanceFramesOnly = true; await save();
    console.log(JSON.stringify({passed:true, corridors:result.corridors.length,
      renderedFrames:result.corridors.reduce((sum,c)=>sum+c.renderedFrames.length,0)},null,2));
  } else {
  // Paired policy comparison on the same scientific product and CPU grids.
  await page.evaluate(()=>{
    if(!window.ingenuityNearPlugin||!window.ingenuityNearCalculate)throw new Error('Cold policy baseline was not installed before rendering');
  });
  await pose(18.44486301,77.45101915);console.log('baseline posed');await settle();result.coarsePolicyBaseline=await snapshot();await page.locator('canvas').first().screenshot({path:`${out}/coarse-policy.png`});await save();console.log('coarse policy settled');
  await page.evaluate(()=>{window.ingenuityNearPlugin.calculateTileViewError=window.ingenuityNearCalculate;sessionStorage.setItem('ingenuity-baseline-done','1');});
  for(let i=0;i<20;i++){await page.waitForTimeout(100);result.loading.push(await snapshot());}
  await settle();await pose(18.44486301,77.45101915);await settle();await groundReady();
  result.refinedPolicy=await snapshot();
  await page.locator('canvas').first().screenshot({path:`${out}/refined-policy.png`});
  assert.doesNotMatch(result.refinedPolicy.gpu,/swiftshader|llvmpipe|software/i,'acceptance requires physical GPU');
  assert.ok(result.refinedPolicy.nav?.settled,JSON.stringify(result.refinedPolicy.nav));
  assert.ok(result.refinedPolicy.clearanceM>=1.9);
  assert.ok(result.loading.every(x=>x.clearanceM==null||x.clearanceM>=1.9),'camera crossed currently drawn or physical ground during refinement');
  await page.evaluate(()=>{window.renderer.getBodyMesh('Mars').terrainManager.tiles.errorTarget=3;});
  for(const [name,lat,lon] of [['wright',18.44486301,77.45101915],['delta',18.455,77.405],['last-airfield',18.4980,77.3273]]){
    await pose(lat,lon);await settle();await groundReady();const state=await snapshot();
    assert.ok(state.nav?.settled,`${name}: ${JSON.stringify(state.nav)}`);assert.ok(state.clearanceM>=1.9);
    assert.equal(state.imagery.baseUncoveredBlocks,0);assert.ok(state.imagery.textureBytes<=state.imagery.maxTextureBytes);
    const picks=await page.evaluate(()=>{
      const result=[];for(const y of [-.6,-.3,0,.3,.6])for(const x of [-.6,-.3,0,.3,.6]){
        const hit=window.renderer.pickSurface(x,y);
        result.push({x,y,kind:hit?.physical?.kind,offsetKm:hit?.physical?.renderedOffsetKm,skirt:!!hit?.renderedSkirt});
      }return result;
    });
    assert.ok(picks.every(p=>p.kind==='hit'&&!p.skirt&&Number.isFinite(p.offsetKm)&&Math.abs(p.offsetKm)<=.0005),`${name} operational ray tolerance: ${JSON.stringify(picks)}`);
    result.views.push({name,lat,lon,...state,picks});await page.locator('canvas').first().screenshot({path:`${out}/${name}.png`});await save();
  }
  // Recording regression: zoom through changing imagery LODs in both the
  // two-layer HiRISE/base configuration and the full stack, looking obliquely.
  // Maximum level anywhere is insufficient: inspect the actual centre sampler.
  result.imageryMotion=[];
  await page.evaluate(()=>{
    const l=window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer;
    const evict=l.evict.bind(l);window.imageryPrematureEvictions=0;
    l.evict=function(need,wanted,priority,incoming){
      const source=incoming?.split(':')[0],incomingLevel=incoming?Number(incoming.split(':')[1].split('/')[1]):-1;
      const drawn=[...this.entries.values()].filter(e=>e.state==='ready'&&e.lastUsed===this.frame&&source!==undefined&&e.id.startsWith(source+':')&&e.address.level<=incomingLevel);
      const freed=evict(need,wanted,priority,incoming);
      window.imageryPrematureEvictions+=drawn.filter(e=>!this.entries.has(e.id)).length;
      return freed;
    };
  });
  for(const fullStack of [false,true]){
    await page.evaluate(full=>{const b=window.renderer.getBodyMesh('Mars');b.setImageryLayerVisible('ctx-global',full);b.setImageryLayerVisible('jezero-ctx',full);},fullStack);
    for(const altitude of [5,1,.25,.05,.25,1,5]){
      await pose(18.44486301,77.45101915,altitude);
      await page.evaluate(()=>{
        const r=window.renderer,c=r.camera,target=r.cameraController.controls.target,offset=c.position.clone().sub(target);
        c.position.copy(target).addScaledVector(offset,Math.cos(1.1)).addScaledVector(c.up,offset.length()*Math.sin(1.1));c.lookAt(target);c.updateMatrixWorld(true);
      });
      const samples=[];
      for(let i=0;i<8;i++){await page.waitForTimeout(100);const state=await snapshot();samples.push({imagery:state.imagery,clearanceM:state.clearanceM,nav:state.nav,center:await imageryCenter()});}
      assert.ok(samples.every(s=>s.clearanceM===null||s.clearanceM>=1.9),'camera crossed ground during oblique imagery sweep');
      assert.ok(samples.every(s=>s.imagery.textureBytes<=s.imagery.maxTextureBytes),'imagery motion exceeded texture budget');
      await settle();const center=await imageryCenter();
      if(altitude===.05){
        const hirise=center?.find(x=>x.id==='jezero-hirise');
        assert.ok(hirise?.enabled===1&&hirise.level===14,`foreground detail starved: ${JSON.stringify(center)}`);
        await page.locator('canvas').first().screenshot({path:`${out}/imagery-motion-${fullStack?'stack':'hirise'}.png`});
        const viewport=[];
        for(const y of [-.8,-.55,-.3,-.05,.2,.45,.7])for(const x of [-.8,-.55,-.3,-.05,.2,.45,.7])viewport.push({x,y,layers:await imageryCenter(false,[x,y])});
        assert.ok(viewport.every(p=>p.layers?.some(s=>s.id==='jezero-hirise'&&s.enabled===1&&s.level>=13)),`incorrect whole-view imagery LOD: ${JSON.stringify(viewport)}`);
        result.imageryViewport??=[];result.imageryViewport.push({fullStack,budgetBytes:268435456,points:viewport});
        // A smaller budget may reduce detail, but must produce one coherent
        // foreground level instead of stranded, near-blank coarse rectangles.
        await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.setOptions({maxTextureBytes:128*2**20}));await settle();
        const reduced=[];
        for(const y of [-.8,-.55,-.3,-.05,.2,.45,.7])for(const x of [-.8,-.55,-.3,-.05,.2,.45,.7])reduced.push({x,y,layers:await imageryCenter(false,[x,y])});
        const cap=await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.sourceLevelCaps.get(3));
        assert.ok(reduced.every(p=>p.layers?.some(s=>s.id==='jezero-hirise'&&s.enabled===1&&s.level>=Math.min(13,cap))),`incoherent constrained-cache foreground: ${JSON.stringify({cap,reduced})}`);
        result.imageryViewport.push({fullStack,budgetBytes:134217728,cap,points:reduced});
        await page.locator('canvas').first().screenshot({path:`${out}/imagery-motion-${fullStack?'stack':'hirise'}-128.png`});
        await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.setOptions({maxTextureBytes:256*2**20}));await settle();
      }
      result.imageryMotion.push({fullStack,altitudeKm:altitude,samples,settledCenter:center});await save();
    }
  }
  assert.equal(await page.evaluate(()=>window.imageryPrematureEvictions),0,'disposed a drawn ancestor to reserve pending refinement');
  await replayCorridors();
  // Straight-down and tilted views must budget the actual visible cover.
  // The superseded beta service had repeated pixels and a corrupt L8 source
  // here. The independently pinned V01 responses must remain usable at both
  // angles, including the low-resolution global overviews.
  result.globalCtxAngles = [];
  for (const fullStack of [false, true]) {
    await page.evaluate(full => { const b = window.renderer.getBodyMesh('Mars');
      b.setImageryLayerVisible('ctx-global', true);
      b.setImageryLayerVisible('jezero-ctx', full); b.setImageryLayerVisible('jezero-hirise', full);
    }, fullStack);
    for (const altitudeKm of [5, 50, 500]) for (const tilt of [0, 1.1]) {
      await pose(18.44486301, 77.45101915, altitudeKm);
      if (tilt) await page.evaluate(tilt => {
        const r = window.renderer, c = r.camera, target = r.cameraController.controls.target, offset = c.position.clone().sub(target);
        c.position.copy(target).addScaledVector(offset, Math.cos(tilt)).addScaledVector(c.up, offset.length() * Math.sin(tilt));
        c.lookAt(target); c.updateMatrixWorld(true);
      }, tilt);
      await settle();
      const state = await snapshot(), center = await imageryCenter(true);
      const ctx = center?.find(s => s.id === 'ctx-global');
      const requiredExposedLevel = altitudeKm === 500 ? 2 : 7;
      assert.ok(ctx?.enabled === 1, `CTX cover missing: ${JSON.stringify({fullStack, altitudeKm, tilt, center})}`);
      if (ctx.level < requiredExposedLevel) {
        assert.ok(fullStack && state.imagery.budgetLimited && center.some(source => source.id === 'jezero-hirise'
          && source.enabled && source.level >= requiredExposedLevel && source.pixelRGBA?.[3] === 255),
        `exposed CTX detail starved: ${JSON.stringify({fullStack, altitudeKm, tilt, center, imagery:state.imagery})}`);
      }
      assert.equal(state.imagery.baseUncoveredBlocks, 0);
      assert.ok(state.imagery.textureBytes <= state.imagery.maxTextureBytes);
      assert.ok(ctx.pixelRGBA?.[3] > 0, 'available original V01 CTX response was lost');
      result.globalCtxAngles.push({fullStack, altitudeKm, tilt, center, imagery: state.imagery});
      if (fullStack && altitudeKm === 50) await page.locator('canvas').first().screenshot({path: `${out}/ctx-${tilt ? 'tilted' : 'nadir'}.png`});
      await save();
    }
  }
  await page.evaluate(() => { const b = window.renderer.getBodyMesh('Mars'); b.setImageryLayerVisible('jezero-ctx', true); b.setImageryLayerVisible('jezero-hirise', true); });
  // Reproduce the user's free-orbit view with actual tracking/playback and
  // pointer/wheel input. The old beta source repeats craters during this move;
  // decoded source identity is gated by the executor, and these captures verify
  // the complete V01 product in the loaded viewer rather than a centre-only pose.
  await pose(18.44486301, 77.45101915, 500); await settle();
  await page.evaluate(() => { window.cosmo.track('Mars'); window.cosmo.setPlaying(true); });
  result.nativeMarsOrbit = [];
  for (let step = 0; step < 4; step++) {
    await page.mouse.move(1100, 450); await page.mouse.down();
    await page.mouse.move(1100 + (step % 2 ? 90 : -90), 500, {steps: 8}); await page.mouse.up();
    if (step === 0) await page.mouse.wheel(0, -500);
    await page.waitForTimeout(200); await page.evaluate(() => window.cosmo.setPlaying(false)); await settle();
    const state = await snapshot(), samples = [];
    for (const y of [-.6, 0, .6]) for (const x of [-.6, 0, .6]) {
      const layers = await imageryCenter(true, [x, y]);
      assert.ok(layers?.some(source => source.id === 'viking' && source.enabled && source.pixelRGBA?.[3] === 255), 'native orbit lost mandatory base coverage');
      samples.push({x, y, layers});
    }
    assert.equal(state.imagery.baseUncoveredBlocks, 0);
    assert.ok(state.imagery.textureBytes <= state.imagery.maxTextureBytes);
    result.nativeMarsOrbit.push({step, samples, imagery: state.imagery});
    await page.locator('canvas').first().screenshot({path: `${out}/native-mars-orbit-${step}.png`}); await save();
    await page.evaluate(() => window.cosmo.setPlaying(true));
  }
  await page.evaluate(() => { window.cosmo.setPlaying(false); window.cosmo.untrack(); });
  // Real global coverage/fallback, including the centre of an original V01 CTX
  // response explicitly retained as unavailable (5/32/16). Read alpha
  // from the exact resident bitmap used by the centre's shader, not residency
  // counts. The generated hole must expose independent lower imagery products.
  result.globalImagery=[];
  for(const [name,lat,lon,altitude] of [
    ['jezero-overhead',18.44486301,77.45101915,500],
    ['distant-mars',0,-60,3000],
    ['ctx-original-unavailable',-2.8125,2.8125,500],
  ]){
    await pose(lat,lon,altitude);await settle();
    const state=await snapshot(),center=await imageryCenter(true);
    assert.equal(state.imagery.baseUncoveredBlocks,0,`${name}: missing base coverage`);
    assert.ok(center?.some(x=>x.id==='viking'&&x.enabled===1&&x.pixelRGBA?.[3]===255),`${name}: no opaque real Viking pixel`);
    if(name==='ctx-original-unavailable')assert.ok(center.some(x=>x.id==='ctx-global'&&x.pixelRGBA?.[3]===0),'original unavailable CTX response was replaced by invented pixels');
    if(name==='distant-mars')assert.ok(center.some(x=>x.id==='ctx-global'&&x.enabled&&x.pixelRGBA?.[3]>0),'V01 global overview must display available real CTX pixels');
    result.globalImagery.push({name,lat,lon,altitudeKm:altitude,center,imagery:state.imagery,staticVisible:state.staticVisible});
    await page.locator('canvas').first().screenshot({path:`${out}/${name}.png`});await save();
  }
  // Real rendered picks become persistent measurement endpoints; imagery cannot
  // change their physical positions or the measured straight-line distance.
  await pose(18.44486301,77.45101915,.1);await settle();
  result.measurement=await page.evaluate(async root=>{
    const r=window.renderer;
    const core=await import(`/@fs/${root}/packages/core/src/index.ts`);
    const state=await window.ingenuityImport('spatial-measurements.svelte.ts');
    const a=r.pickSurface(0,0),b=r.pickSurface(.2,0);
    if(a?.physical?.kind!=='hit'||b?.physical?.kind!=='hit'||a.renderedSkirt||b.renderedSkirt)throw new Error('Measurement did not pick physical mission terrain');
    const relationship={id:'ingenuity-acceptance',kind:'distance',source:core.surfacePointEndpoint(a.point),target:core.surfacePointEndpoint(b.point)};
    state.addMeasurement(relationship);
    const before=core.resolveSpatialRelationship(r.universe,relationship,r.timeController.et);
    r.getBodyMesh('Mars').setImageryLayerVisible('jezero-hirise',false);
    const after=core.resolveSpatialRelationship(r.universe,relationship,r.timeController.et);
    r.getBodyMesh('Mars').setImageryLayerVisible('jezero-hirise',true);
    window.ingenuityMeasurementState=state;
    return {a,b,beforeKm:before?.distanceKm,afterKm:after?.distanceKm,count:state.measurements.items.length};
  },resolve('.'));
  assert.ok(result.measurement.beforeKm>0);assert.equal(result.measurement.beforeKm,result.measurement.afterKm);
  assert.equal(result.measurement.count,1);
  await page.evaluate(()=>window.ingenuityMeasurementState.removeMeasurement('ingenuity-acceptance'));
  await page.mouse.click(720,450,{button:'right'});
  await page.getByRole('button',{name:'Fly to here',exact:true}).click();
  await page.waitForFunction(()=>!window.renderer.cameraController.flight);await settle();
  result.flyTo=await snapshot();assert.ok(result.flyTo.clearanceM>=1.9);
  await page.locator('canvas').first().screenshot({path:`${out}/fly-to.png`});await save();
  // Sample the catalog-loaded interpolator/model, including the first hover,
  // a traverse and final landing. This checks playback of the explicit estimate,
  // not an independent observation of helicopter altitude.
  const flights=JSON.parse(await readFile('apps/viewer/test-catalogs/data/ingenuity/flights_index.json','utf8'));
  await page.evaluate(async()=>{(await window.ingenuityImport('viewer-state.svelte.ts')).selectBody('Ingenuity');(await window.ingenuityImport('shell.svelte.ts')).restorePanel('info');});
  result.playback=[];
  for(const number of [1,12,72]){
    const flight=flights[number-1];
    for(const fraction of [0,.02,.5,.98,1]){
      const et=flight.etStart+(flight.etEnd-flight.etStart)*fraction;
      const point=await page.evaluate(et=>{
        const r=window.renderer;r.timeController.setTime(et);r.renderFrame();
        const s=r.universe.getBody('Ingenuity').stateAt(et),[x,y,z]=s.position;
        return {position:s.position,velocity:s.velocity,lat:Math.atan2(z,Math.hypot(x,y))*180/Math.PI,lon:Math.atan2(y,x)*180/Math.PI};
      },et);
      await pose(point.lat,point.lon,.05);await settle();await groundReady();
      const sample=await page.evaluate(position=>{
        const r=window.renderer,b=r.getBodyMesh('Mars'),t=b.terrainManager;
        const nav=t.navigationSurface({xKm:position[0],yKm:position[1],zKm:position[2]});
        const V=r.camera.position.constructor,centre=new V();b.getWorldPosition(centre);
        const expected=new V(position[0],position[2],-position[1]).applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
        const model=new V();r.getBodyMesh('Ingenuity').getWorldPosition(model);
        return {nav,estimatedClearanceM:nav?.physicalRadiusKm==null?null:(Math.hypot(...position)-nav.physicalRadiusKm)*1000,modelPositionErrorM:model.distanceTo(expected)/r.scaleFactor*1000};
      },point.position);
      assert.ok(point.position.every(Number.isFinite));assert.ok(point.velocity.every(Number.isFinite));
      assert.ok(sample.nav?.settled,`flight ${number} fraction ${fraction}: ${JSON.stringify(sample.nav)}`);
      assert.ok(sample.estimatedClearanceM>=-.5,`estimated flight below physical representation: ${JSON.stringify(sample)}`);
      assert.ok(sample.modelPositionErrorM<.001,'displayed model is not at its catalog-derived position');
      const readout=await page.locator('.ui-data-row').filter({hasText:'Above Mars terrain'}).locator('.ui-readout').innerText();
      assert.match(readout,/^-?\d+ m$/,'ground-level inspector must show metre units');
      assert.ok(Math.abs(parseFloat(readout)-sample.estimatedClearanceM)<=.6,`inspector mixes radial and normal height: ${readout} versus ${sample.estimatedClearanceM} m`);
      result.playback.push({flight:number,fraction,et,...point,...sample,inspectorClearance:readout});
      if(fraction===.5)await page.locator('canvas').first().screenshot({path:`${out}/flight-${number}-estimated.png`});
      await save();
    }
  }
  // Sharper imagery without any change in physical geometry/CPU queries.
  await pose(18.44486301,77.45101915,.5);await settle();
  await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.setOptions({maxLevel:8}));await settle();const coarse=await snapshot(true);
  await page.locator('canvas').first().screenshot({path:`${out}/imagery-coarse.png`});
  await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.setOptions({maxLevel:undefined}));
  await page.waitForFunction(level=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryStats.maxDisplayedLevel>level,coarse.imagery.maxDisplayedLevel,{timeout:30000});
  await settle();const fine=await snapshot(true);
  await page.locator('canvas').first().screenshot({path:`${out}/imagery-fine.png`});
  assert.deepEqual(fine.geometry,coarse.geometry);assert.deepEqual(fine.physicalBufferHash,coarse.physicalBufferHash);assert.deepEqual(fine.cpuHit,coarse.cpuHit);
  assert.ok(fine.imagery.maxDisplayedLevel>coarse.imagery.maxDisplayedLevel);result.independentImagery={coarse,fine};
  const image=await page.locator('canvas').first().screenshot();
  await page.evaluate(()=>{const b=window.renderer.getBodyMesh('Mars');b.moveImageryLayer('jezero-hirise',1);b.setImageryLayerOpacity('jezero-ctx',.5);});await settle();
  assert.notDeepEqual(await page.locator('canvas').first().screenshot(),image);
  await page.evaluate(()=>{const b=window.renderer.getBodyMesh('Mars');b.moveImageryLayer('jezero-hirise',3);b.setImageryLayerOpacity('jezero-ctx',1);});await settle();
  result.controlsRestored=await snapshot();assert.deepEqual(result.controlsRestored.cpuHit,fine.cpuHit);
  await page.evaluate(()=>{const b=window.renderer.getBodyMesh('Mars');['ctx-global','jezero-ctx','jezero-hirise'].forEach(id=>b.setImageryLayerVisible(id,false));});await settle();result.baseOnly=await snapshot();
  assert.equal(result.baseOnly.imagery.baseUncoveredBlocks,0);
  await page.evaluate(()=>{const b=window.renderer.getBodyMesh('Mars');['ctx-global','jezero-ctx','jezero-hirise'].forEach(id=>b.setImageryLayerVisible(id,true));b.terrainManager.cubeImageryLayer.setOptions({maxTextureBytes:48*2**20});});
  for(const [lat,lon] of [[18.455,77.405],[18.498,77.3273],[18.44486301,77.45101915]]){await pose(lat,lon,.5);await settle(true);}
  result.eviction=await snapshot();assert.ok(result.eviction.imagery.evicted>0);assert.ok(result.eviction.imagery.textureBytes<=48*2**20);
  await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.setOptions({maxTextureBytes:128*2**20}));await settle();
  // A cold optional-source outage must retain mandatory base coverage, stop
  // retrying automatically, and recover through the explicit recovery port.
  await page.route('**/*',route=>sourceFault&&new URL(route.request().url()).pathname.startsWith(sourcePaths[3])?route.fulfill({status:404,body:'test optional-source outage'}):route.continue());
  sourceFault=true;await page.reload({waitUntil:'domcontentloaded'});await ready();await pose(18.44486301,77.45101915,.5);await settle();
  result.outage=await snapshot();assert.ok(result.outage.imagery.failures>0);assert.equal(result.outage.imagery.baseUncoveredBlocks,0);
  const count=result.outage.imagery.requests;await page.waitForTimeout(1000);assert.equal((await snapshot()).imagery.requests,count);
  sourceFault=false;await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.retryFailed());await settle();result.recovery=await snapshot();
  assert.equal(result.recovery.imagery.failedTiles,0);
  const transparentPng=await sharp({create:{width:1028,height:1028,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
  await page.route('**/*',route=>{
    const path=new URL(route.request().url()).pathname;
    if(!baseFault||!sourcePaths.some(prefix=>path.startsWith(prefix)))return route.fallback();
    return path.startsWith(sourcePaths[0])?route.fulfill({status:404,body:'test mandatory-base outage'}):route.fulfill({status:200,contentType:'image/png',body:transparentPng});
  });
  baseFault=true;await page.reload({waitUntil:'domcontentloaded'});await ready();await pose(18.44486301,77.45101915,.5);await settle();
  result.baseOutage=await snapshot();assert.ok(result.baseOutage.imagery.baseUncoveredBlocks>0);
  assert.equal(result.baseOutage.readyToShow,false);assert.equal(result.baseOutage.staticVisible,true);
  baseFault=false;await page.evaluate(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryLayer.retryFailed());await settle();
  result.baseRecovery=await snapshot();assert.equal(result.baseRecovery.imagery.baseUncoveredBlocks,0);assert.equal(result.baseRecovery.readyToShow,true);
  await page.reload({waitUntil:'domcontentloaded'});await ready();await pose(18.44486301,77.45101915,.5);await settle();
  // Actual pointer drag/zoom on the mission, then a compact control capture.
  const before=await page.evaluate(()=>window.renderer.camera.position.toArray());
  await page.mouse.move(720,450);await page.mouse.down();await page.mouse.move(850,490,{steps:12});await page.mouse.up();await page.mouse.wheel(0,-120);await settle();
  assert.notDeepEqual(await page.evaluate(()=>window.renderer.camera.position.toArray()),before);
  await page.evaluate(async()=>{
    const viewer=await window.ingenuityImport('viewer-state.svelte.ts'),shell=await window.ingenuityImport('shell.svelte.ts');
    shell.closeAllTools();viewer.selectBody('Ingenuity');shell.restorePanel('info');
  });
  await page.getByText('Estimated flight reconstruction, not 3D telemetry.',{exact:false}).waitFor();
  const summary=page.locator('summary.imagery-summary');
  if(!(await summary.evaluate(el=>el.parentElement.open)))await summary.click();
  const toggle=page.getByRole('checkbox',{name:'Show Jezero · HiRISE',exact:true});
  await toggle.uncheck();await settle();await toggle.check();await settle();
  await page.getByRole('button',{name:'Jezero · HiRISE details',exact:true}).click();
  const slider=page.getByRole('slider',{name:'Jezero · HiRISE opacity',exact:true});
  await slider.focus();await slider.press('Home');await settle();await slider.press('End');await settle();
  await page.getByRole('button',{name:'Move Jezero · HiRISE down',exact:true}).click();await settle();
  await page.getByRole('button',{name:'Move Jezero · HiRISE up',exact:true}).click();await settle();
  result.visibleControls=await page.evaluate(()=>window.renderer.getBodyMesh('Mars').imageryLayers.map(({id,visible,opacity})=>({id,visible,opacity})));
  assert.ok(result.visibleControls.every(x=>x.visible&&x.opacity===1));
  await page.screenshot({path:`${out}/controls-desktop.png`});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(500);
  await page.evaluate(async()=>{(await window.ingenuityImport('shell.svelte.ts')).restorePanel('info');});
  await page.getByText('Estimated flight reconstruction, not 3D telemetry.',{exact:false}).waitFor();
  await page.screenshot({path:`${out}/compact.png`});
  result.compact=await snapshot();assert.ok(result.compact.clearanceM>=1.9);
  assert.equal(errors.length,0,errors.join('\n'));result.passed=true;await save();
  console.log(JSON.stringify({passed:true,gpu:result.refinedPolicy.gpu,maxSettledDiscrepancyM:Math.max(...result.views.map(x=>Math.abs(x.nav.discrepancyM))),views:result.views.length},null,2));
  }
}catch(error){result.failure=String(error.stack??error);result.lastState=await snapshot().catch(e=>({error:String(e)}));await page.screenshot({path:`${out}/failure.png`}).catch(()=>{});await save();throw error;}
finally{await browser.close();}
