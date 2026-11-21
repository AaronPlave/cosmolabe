/** Physical GPU motion, delayed imagery and residency acceptance for #257.
 * node scripts/test-imagery-refinement.mjs URL OUT [--baseline PATH]
 * A baseline TypeScript module can be intercepted without changing the worktree.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import sharp from 'sharp';
import { chromium } from 'playwright';
const base=process.argv[2]??'http://localhost:5173/',out=process.argv[3]??'work/imagery-refinement-257';
const baselineIndex=process.argv.indexOf('--baseline'), baselinePath=baselineIndex>=0?process.argv[baselineIndex+1]:null;
await mkdir(out,{recursive:true});
const result={baseline:baselinePath,missions:[],errors:[],passed:false};
const browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),args:['--enable-gpu','--ignore-gpu-blocklist',process.platform==='darwin'?'--use-angle=metal':'--use-angle=swiftshader']});
const save=()=>writeFile(`${out}/metrics.json`,JSON.stringify(result,null,2)+'\n');
async function pose(page,body,lat,lon,altitudeKm=.5,angle=.9){
  return page.evaluate(async({body,lat,lon,altitudeKm,angle})=>{
    const r=window.renderer,b=r.getBodyMesh(body),t=b.terrainManager,V=r.camera.position.constructor;
    window.cosmo.setPlaying(false);window.cosmo.untrack();r.cameraController.controls.enableDamping=false;
    const la=lat*Math.PI/180,lo=lon*Math.PI/180,d=[Math.cos(la)*Math.cos(lo),Math.cos(la)*Math.sin(lo),Math.sin(la)];
    const outer=t.bodyRadiusKm+50,ray={origin:{xKm:d[0]*outer,yKm:d[1]*outer,zKm:d[2]*outer},direction:d.map(x=>-x),nearKm:0,farKm:150};
    await t.cube.surface.ensureRayCoverage(ray,{maxMeshErrorKm:0},AbortSignal.timeout(30000));
    const hit=b.intersectTerrainRay(ray,{maxMeshErrorKm:0});if(hit?.kind!=='hit')throw Error('No physical surface');
    const p=[hit.position.xKm,hit.position.yKm,hit.position.zKm],centre=new V();b.getWorldPosition(centre);
    const world=([x,y,z])=>new V(x,z,-y).applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
    const up=world([-Math.sin(la)*Math.cos(lo),-Math.sin(la)*Math.sin(lo),Math.cos(la)]).sub(centre).normalize();
    const target=world(p),c=r.camera,offset=world(p.map((v,i)=>v+d[i]*altitudeKm)).sub(target);
    r.cameraController.controls.target.copy(target);c.up.copy(up);c.position.copy(target).addScaledVector(offset,Math.cos(angle)).addScaledVector(up,offset.length()*Math.sin(angle));
    c.fov=50;c.updateProjectionMatrix();c.lookAt(target);c.updateMatrixWorld(true);window.imageryAnchor=p;
    t.setDebugMode('imagery-unlit');return p;
  },{body,lat,lon,altitudeKm,angle});
}
async function settle(page,body){
  await page.waitForFunction(body=>{const t=window.renderer.getBodyMesh(body).terrainManager,n=t.metrics.network,i=t.cubeImageryStats;return t.tiles.visibleTiles.size>0&&n.queued+n.downloading+n.parsing===0&&i.inFlight===0&&(i.queued===0||i.budgetLimited);},body,{timeout:180000});
  await page.waitForTimeout(600);
}
async function snapshot(page,body,frames=1){
  return page.evaluate(async({body,frames,root})=>{
    const cubeMath=await import(`/@fs/${root}/packages/three/src/surface/CubeImagery.ts`);
    const r=window.renderer,t=r.getBodyMesh(body).terrainManager,l=t.cubeImageryLayer;
    const sample=()=>{
      const p=window.imageryAnchor;
      if(l.sampleAt)return l.sampleAt(p).map(s=>({id:s.id,enabled:s.enabled,level:s.level}));
      const {directionToTexel,parseImageryAddress}=cubeMath;
      const address=directionToTexel(p,30,1,0).address;
      const contains=a=>a.face===address.face&&a.level<=30&&Math.floor(address.x/2**(30-a.level))===a.x&&Math.floor(address.y/2**(30-a.level))===a.y;
      const rec=[...l.tiles.values()].filter(t=>t.scene.parent&&t.scene.visible&&contains(t.address)).sort((a,b)=>b.address.level-a.address.level)[0];
      if(!rec)return [];
      const m=rec.meshes[0],draw=m.mesh.visible?m:[...m.blocks].find(([id,b])=>b.mesh.visible&&contains(parseImageryAddress(id)))?.[1];
      return draw?draw.uniforms.layers.map((u,i)=>({id:l.order[i].info.id,enabled:u.enabled.value,level:u.level.value})):[];
    };
    const samples=[],intervals=[];let previous;
    for(let n=0;n<frames;n++){
      await new Promise(requestAnimationFrame);const now=performance.now();if(previous)intervals.push(now-previous);previous=now;
      samples.push({imagery:t.cubeImageryStats,anchor:sample(),draws:r.getContext().webglRenderer.info.render.calls,et:r.timeController.et,camera:r.camera.position.toArray()});
    }
    const gl=r.getContext().webglRenderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
    return {gpu:gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER),samples,intervals};
  },{body,frames,root:resolve('.')});
}
try{
  for(const [mission,body,lat,lon,vehicle] of [
    ['ingenuity-jezero','Mars',18.44486301,77.45101915,'Ingenuity'],
    ['moonfall-shackleton','Moon',-89.98,120,'Polaris-A'],
  ]){
    const page=await browser.newPage({viewport:{width:1440,height:900}}),row={mission,phases:[],faults:{delayed:0,failed:0,missingParents:0},errors:[]};result.missions.push(row);
    page.on('pageerror',e=>{row.errors.push(e.message);result.errors.push(e.message);});
    page.on('console',m=>{if(/Shader Error|VALIDATE_STATUS|INVALID_OPERATION|GL_INVALID/.test(m.text())){row.errors.push(m.text());result.errors.push(m.text());}});
    if(baselinePath){
      await page.route('**/packages/three/src/CubeImageryLayer.ts*',async route=>{
        const current=await route.fetch(),body=await current.text();
        const three=/from\s+["']([^"']*three[^"']*\.js[^"']*)["']/.exec(body)?.[1];assert.ok(three,'Vite three module URL missing');
        let source=ts.transpileModule(await readFile(baselinePath,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
        source=source.replace(/from ['"]three['"]/g,`from ${JSON.stringify(three)}`).replace(/from ['"]\.\/([^'"]+)\.js['"]/g,(_,path)=>`from ${JSON.stringify('/@fs/'+resolve('packages/three/src',path+'.ts'))}`);
        await route.fulfill({status:200,contentType:'application/javascript',body:source});
      });
    }
    let faulty=false;const attempts=new Map();
    await page.route(/\/tiles\/.*\.(png|jpe?g)(\?|$)/,async route=>{
      if(!faulty)return route.continue();
      const path=new URL(route.request().url()).pathname,level=Number(/\/(?:px|nx|py|ny|pz|nz)\/(\d+)\//.exec(path)?.[1]??0);
      const count=attempts.get(path)??0;attempts.set(path,count+1);
      const hash=[...path].reduce((a,c)=>(a*31+c.charCodeAt(0))>>>0,0);
      if(level>=5&&level<=11&&hash%13===0){row.faults.missingParents++;return route.fulfill({status:404,body:'deterministic missing intermediate image'});}
      if(level>=4&&count===0&&hash%11===0){row.faults.failed++;return route.fulfill({status:503,body:'deterministic transient image failure'});}
      if(level>=3&&count===0){row.faults.delayed++;await new Promise(r=>setTimeout(r,[40,180,500,1100][hash%4]));}
      try{await route.continue();}catch{/* page may close after an obsolete download */}
    });
    await page.goto(`${base}?catalog=test-catalogs/${mission}`,{waitUntil:'domcontentloaded',timeout:120000});
    await page.waitForFunction(body=>window.renderer?.getBodyMesh(body)?.terrainManager?.cubeImageryStats?.version,body,{timeout:120000});
    await page.evaluate(async body=>{const r=window.renderer;await r.waitForInitialAssets();const t=r.getBodyMesh(body).terrainManager;await t.cube.source.ready;await t.cubeImageryLayer.ready;},body);
    const firstPoseStarted=performance.now();
    await pose(page,body,lat,lon,body==='Moon'?1.5:.5,body==='Moon'?.6:.9);await settle(page,body);
    row.firstPoseToSettledMs=performance.now()-firstPoseStarted;
    const warm=await snapshot(page,body,120);assert.doesNotMatch(warm.gpu,/software|swiftshader|llvmpipe/i);row.phases.push({name:'warm',...warm});
    const visibleCapture=await page.locator('canvas').first().screenshot({path:`${out}/${mission}-before-motion.png`});
    const imageStats=await sharp(visibleCapture).extract({left:400,top:100,width:800,height:600}).stats();
    row.visibleImage={mean:imageStats.channels[0].mean,stdev:imageStats.channels[0].stdev};
    assert.ok(row.visibleImage.mean>15&&row.visibleImage.stdev>3,`${mission}: motion view has insufficient visible imagery`);
    if(!baselinePath){
      await page.evaluate(body=>{
        const r=window.renderer,t=r.getBodyMesh(body).terrainManager,l=t.cubeImageryLayer,w=r.getContext().webglRenderer;
        window.imageGpuInit=w.initTexture;window.imageGpuArray=l.pages.array;window.imageGpuTarget=l.stats.maxTextureBytes;
        w.initTexture=function(texture){if(texture.isDataArrayTexture&&texture!==window.imageGpuArray)throw Error('injected GPU allocation failure');return window.imageGpuInit.call(this,texture);};
        l.setOptions({maxTextureBytes:window.imageGpuTarget+64*2**20});
      },body);
      const retained={name:'allocation-failure',...await snapshot(page,body,30)};row.phases.push(retained);
      assert.ok(retained.samples.every(s=>s.imagery.gpuError&&s.imagery.baseUncoveredBlocks===0));
      await page.evaluate(body=>{const w=window.renderer.getContext().webglRenderer,l=window.renderer.getBodyMesh(body).terrainManager.cubeImageryLayer;w.initTexture=window.imageGpuInit;l.setOptions({maxTextureBytes:window.imageGpuTarget});l.retryFailed();},body);
      await settle(page,body);
    }
    const prior=await snapshot(page,body),initial=prior.samples[0].anchor;
    for(const dx of [25,25,-25,-25,-25,-25,25,25]){
      await page.mouse.move(720,450);await page.mouse.down();await page.mouse.move(720+dx,450,{steps:12});await page.mouse.up();
      row.phases.push({name:`drag-${row.phases.length}`,dx,...await snapshot(page,body,12)});
    }
    await settle(page,body);await page.locator('canvas').first().screenshot({path:`${out}/${mission}-after-motion.png`});
    if(!baselinePath){
      const initialTop=[...initial].reverse().find(s=>s.enabled);
      for(const phase of row.phases.filter(p=>p.name.startsWith('drag')))for(const frame of phase.samples){
        const top=[...frame.anchor].reverse().find(s=>s.enabled);
        assert.ok(top&&top.id===initialTop.id&&top.level>=initialTop.level-1,`${mission}: committed anchor detail regressed`);
        assert.equal(frame.imagery.extraDraws,0);assert.equal(frame.imagery.blockGeometryBytes,0);assert.equal(frame.imagery.baseUncoveredBlocks,0);
      }
    }
    // New territory: inject delayed/out-of-order responses and transient errors.
    faulty=true;await pose(page,body,body==='Mars'?18.49:-89.9,body==='Mars'?77.34:300,.3,1.1);
    const loading=snapshot(page,body,180);
    await page.waitForTimeout(500);
    await page.locator('canvas').first().screenshot({path:`${out}/${mission}-faults-loading.png`});
    await page.waitForTimeout(700);
    await page.locator('canvas').first().screenshot({path:`${out}/${mission}-faults-loading-late.png`});
    row.phases.push({name:'faulty-loading',...await loading});await settle(page,body);
    row.phases.push({name:'faulty-settled',...await snapshot(page,body,30)});faulty=false;await page.evaluate(body=>window.renderer.getBodyMesh(body).terrainManager.cubeImageryLayer.retryFailed(),body);
    await page.locator('canvas').first().screenshot({path:`${out}/${mission}-faults-settled.png`});
    // Mission-follow playback at one simulated day per second, plus a revisit.
    await page.evaluate(vehicle=>{window.cosmo.track(vehicle);window.renderer.timeController.setRate(86400);window.cosmo.setPlaying(true);},vehicle);
    const accelerated={name:'accelerated-follow',...await snapshot(page,body,180)};
    assert.ok(accelerated.samples.at(-1).et-accelerated.samples[0].et>1000,'accelerated playback did not advance');
    row.phases.push(accelerated);
    await page.evaluate(()=>{window.cosmo.setPlaying(false);window.renderer.timeController.setRate(1);});
    await pose(page,body,lat,lon,body==='Moon'?1.5:.5,body==='Moon'?.6:.9);await settle(page,body);row.phases.push({name:'revisit',...await snapshot(page,body,120)});
    await page.locator('canvas').first().screenshot({path:`${out}/${mission}-revisit.png`});
    if(!baselinePath&&body==='Moon'){
      for(const [name,lat,lon] of [['edge-a',-45.1,-.1],['edge-b',-44.9,.1],['corner-a',-35.4,44.9],['corner-b',-35.1,45.1]]){
        await pose(page,body,lat,lon,12,.1);await settle(page,body);
        const phase={name,...await snapshot(page,body,12)};row.phases.push(phase);
        assert.ok(phase.samples.every(s=>s.imagery.baseUncoveredBlocks===0));
        await page.locator('canvas').first().screenshot({path:`${out}/${mission}-${name}.png`});
      }
    }
    if(!baselinePath){
      await page.evaluate(()=>{const gl=window.renderer.getContext().webglRenderer.getContext();window.testLoss=gl.getExtension('WEBGL_lose_context');if(!window.testLoss)throw Error('No context-loss test extension');window.testLoss.loseContext();});
      await page.waitForTimeout(250);await page.evaluate(()=>window.testLoss.restoreContext());await page.waitForTimeout(500);
      await settle(page,body);const recovered={name:'context-restored',...await snapshot(page,body,60)};row.phases.push(recovered);
      assert.ok(recovered.samples.every(s=>s.imagery.baseUncoveredBlocks===0));
      await page.locator('canvas').first().screenshot({path:`${out}/${mission}-context-restored.png`});
    }
    const summary=values=>{const a=values.toSorted((a,b)=>a-b);return {n:a.length,p50:a[Math.floor(a.length*.5)]??null,p95:a[Math.floor(a.length*.95)]??null,max:a.at(-1)??null};};
    row.summary={frameIntervalMs:summary(row.phases.flatMap(p=>p.intervals)),imageUpdateMs:summary(row.phases.flatMap(p=>p.samples.map(s=>s.imagery.updateMs))),
      maxImageBytes:Math.max(...row.phases.flatMap(p=>p.samples.map(s=>s.imagery.textureBytes))),
      maxAllocatedBytes:Math.max(...row.phases.flatMap(p=>p.samples.map(s=>s.imagery.gpuAllocatedBytes??s.imagery.textureBytes))),
      last:row.phases.at(-1).samples.at(-1).imagery};
    assert.deepEqual(row.errors,[]);await save();await page.close();
  }
  result.passed=true;await save();console.log(JSON.stringify({passed:true,missions:result.missions.map(m=>({mission:m.mission,summary:m.summary,faults:m.faults}))},null,2));
}catch(e){result.failure=String(e);await save();throw e;}finally{await browser.close();}
