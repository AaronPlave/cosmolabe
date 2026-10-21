/** Continuous cartographic acceptance. CL_GPU=hardware CL_RECORD=1 records
 * Chrome/Metal; CI uses SwiftShader and still gates churn/identity/picking. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve('.'), base=process.env.CL_VIEWER_URL??'http://127.0.0.1:5189/';
const output=process.env.CL_OUTPUT??'/tmp/planetary-places-motion';
await mkdir(output,{recursive:true});
const hardware=process.env.CL_GPU==='hardware';
// CI's software renderer needs fewer samples of the same complete camera path.
// Physical recording retains the full temporal sequence.
const orbitFrames=process.env.CL_SMOKE==='1'?90:240;
const sweepFrames=process.env.CL_SMOKE==='1'?60:180;
const fovFrames=process.env.CL_SMOKE==='1'?6:20;
const browser=await chromium.launch({executablePath:hardware?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined,
  args:hardware?['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const context=await browser.newContext({viewport:{width:1440,height:900},...(process.env.CL_RECORD?{recordVideo:{dir:output,size:{width:1440,height:900}}}:{})});
const page=await context.newPage(),errors=[],results=[];
page.on('pageerror',e=>errors.push(e.message));
try {
  await page.addInitScript(() => {
    // Vite HMR query strings denote module identity. Drive the live module,
    // including its version, rather than constructing another state singleton.
    window.__placeModule = path => import(performance.getEntriesByType('resource').map(e=>e.name)
      .filter(url=>new URL(url).pathname===path).at(-1) ?? path);
  });
  await page.goto(`${base}?catalog=test-catalogs/planetary-places`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.renderer?.placeNames?.index.places.length===11139);
  await page.evaluate(()=>window.renderer.waitForInitialAssets());
  await page.evaluate(async root=>{
    const {selectPlace,showPlaceBody}=await window.__placeModule('/src/lib/places.ts');
    selectPlace(null);showPlaceBody('Mars',true);showPlaceBody('Moon',true);
    window.renderer.setLightingMode('natural');
  },root);
  for(const [body,query] of [['Mars','Jezero'],['Moon','Shackleton']]) {
    await page.evaluate(async({root,body})=>{
      const {frameBody}=await window.__placeModule('/src/lib/viewer-state.svelte.ts');frameBody(body);
      window.renderer.applyNamedViewpoint(`${body} places orbit`);
    },{root,body});
    await page.waitForTimeout(500);
    await page.screenshot({path:`${output}/${body.toLowerCase()}-global.png`});
    // A continuously moving camera, then stop/start and minuscule movement.
    const motion=await page.evaluate(async ({body,orbitFrames})=>{
      const r=window.renderer,cc=r.cameraController,bm=r.getBodyMesh(body),cpu=[],frames=[],samples=[];
      const oldNodes=new Map();let identityChanges=0,pickChecks=0,last=performance.now();
      const initial={enters:r.placeNames.metrics.enters,exits:r.placeNames.metrics.exits};
      const relative=r.camera.position.clone().sub(bm.position);
      const axis=r.camera.up.clone().normalize();
      for(let i=0;i<orbitFrames;i++) {
        await new Promise(requestAnimationFrame);
        const now=performance.now();frames.push(now-last);last=now;
        const fraction=i/orbitFrames;
        const angle=(fraction<100/240 ? .0007 : fraction<140/240 ? 0 : .000003)*240/orbitFrames;
        relative.applyAxisAngle(axis,angle);r.camera.position.copy(relative).add(bm.position);cc.controls.target.copy(bm.position);
        r.camera.lookAt(cc.controls.target);r.camera.updateMatrixWorld(true);
        const m=r.placeNames.metrics;cpu.push(m.cpuMs);
        for(const el of document.querySelectorAll('.cl-place-name')) {
          const id=el.dataset.placeRef;if(oldNodes.has(id)&&oldNodes.get(id)!==el)identityChanges++;
          oldNodes.set(id,el);
          const rect=el.getBoundingClientRect(),canvas=r.renderer.domElement.getBoundingClientRect();
          if(Number(el.style.opacity)>.2){
            const hit=r.placeNames.pick(rect.x+rect.width/2-canvas.x,rect.y+rect.height/2-canvas.y);
            if(!hit || r.placeNames.index.byRef.get(id)?.feature.id!==hit.featureId)throw new Error('Moving name pick drift');
            pickChecks++;
          }
        }
        samples.push({drawn:m.drawn,enters:m.enters,exits:m.exits,deferred:m.losDeferred});
      }
      const stats=a=>{a.sort((x,y)=>x-y);return{median:a[Math.floor(a.length/2)],p95:a[Math.floor(a.length*.95)]};};
      return {body,phase:'slow orbit, stop/start, tiny motion',frames:stats(frames),cpu:stats(cpu),identityChanges,pickChecks,
        enters:r.placeNames.metrics.enters-initial.enters,exits:r.placeNames.metrics.exits-initial.exits,samples};
    },{body,orbitFrames});
    assert.equal(motion.identityChanges,0,'a continuously retained label keeps its DOM identity');
    assert.ok(motion.enters<20&&motion.exits<20,'slow orbit must not churn the whole label set');
    results.push(motion);
    await page.evaluate(async fovFrames=>{
      const r=window.renderer;
      for(const fov of [45,75,60]){r.camera.fov=fov;r.camera.updateProjectionMatrix();for(let i=0;i<fovFrames;i++)await new Promise(requestAnimationFrame);}
    },fovFrames);
    // Traverse all apparent-size tiers with the actual shared surface pivot.
    await page.evaluate(async({root,body,query})=>{
      const {goToCoordinates}=await window.__placeModule('/src/lib/viewer-state.svelte.ts');
      const r=window.renderer,p=r.placeNames.index.search(query,{body})[0],pos=p.feature.geometry.coordinates;
      const result=goToCoordinates({bodyName:body,latDeg:pos.latDeg,lonDeg:pos.lonDeg,latitude:'planetographic',longitudeDirection:'east'},{animate:false,rangeKm:r.getBodyMesh(body).displayRadius*2});
      if(!result.ok)throw new Error(result.error);
    },{root,body,query});
    const sweep=async(from,to,phase)=>page.evaluate(async({from,to,phase,body,sweepFrames})=>{
      const r=window.renderer,cc=r.cameraController,bm=r.getBodyMesh(body),target=cc.controls.target.clone();
      const ray=r.camera.position.clone().sub(target).normalize(),start=performance.now(),samples=[];
      for(let i=0;i<sweepFrames;i++){
        await new Promise(requestAnimationFrame);
        const t=i/(sweepFrames-1),range=Math.exp(Math.log(from)*(1-t)+Math.log(to)*t)*r.scaleFactor;
        r.camera.position.copy(target).addScaledVector(ray,range);
        // Small pan changes the line of sight throughout the zoom.
        r.camera.position.addScaledVector(r.camera.up,Math.sin(t*Math.PI*2)*range*.015);
        r.camera.lookAt(target);r.camera.updateMatrixWorld(true);
        samples.push({...r.placeNames.metrics});
      }
      return{body,phase,elapsedMs:performance.now()-start,samples};
    },{from,to,phase,body,sweepFrames});
    const radius=await page.evaluate(body=>window.renderer.getBodyMesh(body).displayRadius,body);
    results.push(await sweep(radius*2,radius*.15,'zoom global to regional'));
    await page.waitForTimeout(300);await page.screenshot({path:`${output}/${body.toLowerCase()}-regional.png`});
    results.push(await sweep(radius*.15,body==='Mars'?40:8,'zoom regional to surface'));
    await page.waitForTimeout(300);await page.screenshot({path:`${output}/${body.toLowerCase()}-surface.png`});
    results.push(await sweep(body==='Mars'?40:8,radius*2,'zoom out through all tiers'));
    // Real selection is retained on the current body, cleared on body change.
    await page.evaluate(async({root,query,body})=>{
      const {navigateToPlace}=await window.__placeModule('/src/lib/places.ts');
      navigateToPlace(window.renderer.placeNames.index.search(query,{body})[0],'jump');
    },{root,query,body});
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(()=>!!window.renderer.placeNames.selectedRef));
    await page.evaluate(async({root,body})=>{const {frameBody}=await window.__placeModule('/src/lib/viewer-state.svelte.ts');frameBody(body==='Moon'?'Mars':'Moon');},{root,body});
    assert.equal(await page.evaluate(()=>window.renderer.placeNames.selectedRef),null);
  }
  if(process.env.CL_TERRAIN) {
    for(const [body,catalog,query] of [['Moon','geographic-vectors-shackleton-terrain.json','Shackleton'],['Mars','geographic-vectors-jezero-terrain.json','Jezero']]) {
      const url=`${base}motion-terrain-${body}.json`;
      await page.route(url,async route=>{
        const scene=JSON.parse(await readFile(`${root}/apps/viewer/test-catalogs/${catalog}`,'utf8'));
        scene.require=[`${base}test-catalogs/places/${body.toLowerCase()}.json`];scene.geographicLayers=[];
        for(const item of scene.items)if(item.geometry?.terrain){
          item.geometry.terrain.url=`${base}test-catalogs/${item.geometry.terrain.url}`;
          if(item.geometry.terrain.cubeSphere)item.geometry.terrain.cubeSphere.cpuGrids=`${base}test-catalogs/${item.geometry.terrain.cubeSphere.cpuGrids}`;
        }
        await route.fulfill({json:scene});
      });
      await page.evaluate(async({url,body,query})=>{
        const {loadCatalogUrl}=await window.__placeModule('/src/lib/loader.ts');
        const {showPlaceBody,navigateToPlace}=await window.__placeModule('/src/lib/places.ts');
        await loadCatalogUrl(document.querySelector('canvas'),url);
        const r=window.renderer;r.setLightingMode('natural');showPlaceBody(body,true);
        navigateToPlace(r.placeNames.index.search(query,{body})[0],'jump');
      },{url,body,query});
      const refinement=await page.evaluate(async body=>{
        const r=window.renderer,bm=r.getBodyMesh(body),cc=r.cameraController,states=[];
        const eye=r.camera.position.clone().sub(cc.controls.target).normalize();
        for(let i=0;i<360;i++) {
          await new Promise(requestAnimationFrame);
          const target=cc.controls.target.clone(),range=(body==='Moon'?8:40)*(1+.6*Math.sin(i/360*Math.PI*2));
          r.camera.position.copy(target).addScaledVector(eye,range*r.scaleFactor);r.camera.lookAt(target);
          states.push({...r.placeNames.metrics,terrain:bm.terrainMetrics});
        }
        const probe=r.pickScene(r.renderer.domElement.clientWidth/2,r.renderer.domElement.clientHeight/2,'probe');
        return{body,phase:'terrain loading/refinement and surface zoom',hasTerrain:bm.hasTerrain,probeSource:probe?.kind==='surface'?probe.point.source:null,samples:states};
      },body);
      assert.equal(refinement.hasTerrain,true);assert.equal(refinement.probeSource,'terrain');results.push(refinement);
      await page.screenshot({path:`${output}/${body.toLowerCase()}-terrain-refinement.png`});
    }
  }
  assert.deepEqual(errors,[]);
}finally{
  await writeFile(`${output}/motion-metrics.json`,JSON.stringify({sampling:{orbitFrames,sweepFrames,fovFrames},results,errors},null,2)+'\n');
  await context.close();await browser.close();
}
console.log(JSON.stringify({phases:results.map(({samples,...r})=>r),errors},null,2));
