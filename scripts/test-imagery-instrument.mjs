/** Instrument coverage with a cold constrained imagery pool on real MoonFall.
 * The explicitly synthetic nadir sensor is a test fixture, not mission geometry.
 * node scripts/test-imagery-instrument.mjs URL OUTPUT
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';
const base=(process.argv[2]??'http://localhost:5173').replace(/\/$/,''),out=process.argv[3]??'work/imagery-instrument';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),
  args:['--enable-gpu','--ignore-gpu-blocklist',process.platform==='darwin'?'--use-angle=metal':'--use-angle=swiftshader']});
const result={passed:false,fixture:'Synthetic body-fixed nadir sensor at -89.98 degrees, 120 degrees, 25km reference altitude; original MoonFall products',targetBytes:48*2**20,switches:[],errors:[]};
const page=await browser.newPage({viewport:{width:1440,height:900}});
page.on('pageerror',e=>result.errors.push(e.message));
try{
  await page.route('**/test-catalogs/moonfall-shackleton.json*',async route=>{
    const response=await route.fetch(),json=await response.json(),moon=json.items.find(x=>x.name==='Moon');
    moon.geometry.terrain.cubeSphere.imagery.maxTextureBytes=result.targetBytes;
    const la=-89.98*Math.PI/180,lo=120*Math.PI/180,r=1737.4+25;
    moon.items.push({name:'Imagery Validation Sensor',class:'spacecraft',center:'Moon',trajectoryFrame:'BodyFixed',
      trajectory:{type:'FixedPoint',position:[r*Math.cos(la)*Math.cos(lo),r*Math.cos(la)*Math.sin(lo),r*Math.sin(la)]},
      geometry:{type:'Sensor',target:'Moon',shape:'rectangular',horizontalFov:12,verticalFov:12,range:'200',frustumOpacity:0}});
    await route.fulfill({response,json});
  });
  await page.goto(`${base}/?catalog=test-catalogs/moonfall-shackleton`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.renderer?.getBodyMesh('Moon')?.terrainManager?.cubeImageryStats?.version,null,{timeout:120000});
  await page.evaluate(async()=>{
    const r=window.renderer;await r.waitForInitialAssets();window.cosmo.setPlaying(false);window.cosmo.untrack();
    const b=r.getBodyMesh('Moon'),V=r.camera.position.constructor,centre=new V();b.getWorldPosition(centre);
    const at=(lat,lon,h)=>{const a=lat*Math.PI/180,o=lon*Math.PI/180,s=1737.4+h;return new V(s*Math.cos(a)*Math.cos(o),s*Math.sin(a),-s*Math.cos(a)*Math.sin(o)).applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);};
    const eye=at(-89.98,120,25),target=at(-87.5,120,0);
    r.cameraController.controls.enableDamping=false;r.cameraController.controls.target.copy(target);r.camera.position.copy(eye);r.camera.up.copy(eye.clone().sub(centre).normalize());r.camera.lookAt(target);r.camera.updateMatrixWorld(true);
    b.terrainManager.setDebugMode('imagery-unlit');
  });
  const settle=async()=>{await page.waitForFunction(()=>{
    const t=window.renderer.getBodyMesh('Moon').terrainManager,n=t.metrics.network,i=t.cubeImageryStats;
    return t.tiles.visibleTiles.size>0&&n.queued+n.downloading+n.parsing===0&&i.inFlight===0&&(i.queued===0||i.budgetLimited);
  },null,{timeout:120000});await page.waitForTimeout(600);};
  await settle();
  for(let k=0;k<3;k++){
    await page.evaluate(()=>{const r=window.renderer;r.setInstrumentView('Imagery Validation Sensor');if(!r.cameraController.setMode('instrument',{sensorName:'Imagery Validation Sensor'}))throw Error('Instrument mode unavailable');});await settle();
    const state=await page.evaluate(()=>{
      const r=window.renderer,t=r.getBodyMesh('Moon').terrainManager,l=t.cubeImageryLayer;r.renderFrame();
      const gl=r.getContext().webglRenderer.getContext(),e=gl.getExtension('WEBGL_debug_renderer_info');
      const meshes=[...l.tiles.values()].filter(t=>t.scene.parent).flatMap(t=>t.meshes);
      return {active:r.activeInstrumentView,mode:r.cameraController.mode,fullScreen:r.instrumentView.fullScreen,gpu:gl.getParameter(e?e.UNMASKED_RENDERER_WEBGL:gl.RENDERER),imagery:l.stats,
        meshes:meshes.length,withoutBase:meshes.filter(m=>m.uniforms.layers[0].enabled.value!==1).length,
        image:r.getContext().webglRenderer.domElement.toDataURL()};
    });
    assert.equal(state.active,'Imagery Validation Sensor');assert.equal(state.mode,'instrument');assert.equal(state.fullScreen,true);assert.doesNotMatch(state.gpu,/software|swiftshader|llvmpipe/i);
    assert.ok(state.meshes>0);assert.equal(state.withoutBase,0);assert.equal(state.imagery.baseUncoveredBlocks,0);
    assert.equal(state.imagery.extraDraws,0);assert.ok(state.imagery.textureBytes<=result.targetBytes+state.imagery.transitionTextureBytes);
    const image=Buffer.from(state.image.split(',')[1],'base64'),stats=await sharp(image).stats();delete state.image;
    state.contrast=stats.channels.map(c=>({mean:c.mean,stdev:c.stdev}));assert.ok(stats.channels[0].stdev>3,'instrument feed has no visible imagery');
    result.switches.push(state);if(k===0)await writeFile(`${out}/instrument.png`,image);
    await page.evaluate(()=>{window.renderer.cameraController.setMode('free-orbit');window.renderer.setInstrumentView(null);});await settle();
  }
  assert.deepEqual(result.errors,[]);result.passed=true;
}finally{await writeFile(`${out}/metrics.json`,JSON.stringify(result,null,2)+'\n');await browser.close();}
console.log(JSON.stringify({passed:result.passed,switches:result.switches.length}));
