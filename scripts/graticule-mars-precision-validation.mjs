/** Close-range Mars grid precision at the reported Ingenuity permalink.
 * GRID_BASELINE=/tmp/graticule-before.ts optionally captures the old shader too.
 */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
const out=resolve(process.env.GRID_OUTPUT??'/tmp/grid-mars-precision');await mkdir(out,{recursive:true});
const view={version:1,catalog:{catalog:'test-catalogs/ingenuity-jezero'},time:{kind:'fixed',source:'ET',et:678747698.6801088},view:{kind:'pose',version:1,frame:'ECLIPJ2000',origin:'Mars',camera:{position:[3171.7942747424036,-1113.641397423312,-452.71284260603625],target:[546.8073461939653,-2080.0283257269143,-2379.3870179228293],up:[0.9934642213089192,-0.026110669061718154,0.11111738810920814],fov:60}},navigation:{selected:'Mars',tracked:null,lookAt:null,mode:'free-orbit'},playback:{playing:false,rate:1},display:{trajectories:true,labels:true,grid:true,axes:false,sensors:true,sensorLabels:true}};
const browser=await chromium.launch({channel:process.platform==='darwin'?'chrome':undefined,headless:true,args:process.platform==='darwin'?['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist']:[]});
const report={passed:false,errors:[],captures:[]};
try {
for(const baseline of process.env.GRID_BASELINE?[true,false]:[false]){
 let baselineLoads=0;
 const page=await browser.newPage({viewport:{width:1718,height:1000},deviceScaleFactor:1});
 await page.addInitScript(()=>performance.setResourceTimingBufferSize(20000));
 page.on('response',r=>{if(r.status()>=400)console.log(r.status(),r.url());});
 page.on('pageerror',e=>report.errors.push(e.message));
 page.on('console',m=>{if(m.type()==='warning'||m.type()==='error')console.log(m.type(),m.text());});
 page.on('console',m=>{if(/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(m.text()))report.errors.push(m.text());});
 if(baseline){const source=await readFile(process.env.GRID_BASELINE,'utf8');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 await page.route(/\/GraticuleShader\.(?:js|ts)(?:\?|$)/,async route=>{baselineLoads++;const original=await (await route.fetch()).text();const three=original.match(/import \* as THREE from ["']([^"']+)["']/)?.[1];assert.ok(three);await route.fulfill({contentType:'application/javascript',body:js.replace("from 'three'",`from '${three}'`)});});}

 await page.goto(`${process.env.GRID_VIEWER_URL??'http://127.0.0.1:5188'}/?test=1&catalog=test-catalogs%2Fingenuity-jezero&view=${encodeURIComponent(JSON.stringify(view))}`);
 await page.waitForFunction(()=>window.__cosmolabe?.assetsReady&&window.renderer?.getBodyMesh('Mars'),undefined,{timeout:120000});
 await page.waitForFunction(()=>window.renderer.getBodyMesh('Mars').terrainManager.cubeStats?.version,undefined,{timeout:120000});
 await page.evaluate(async()=>{await window.renderer.waitForInitialAssets();const t=window.renderer.getBodyMesh('Mars').terrainManager;await t.cube.source.ready;await t.cubeImageryLayer.ready;});
 await page.waitForFunction(()=>{const t=window.renderer.getBodyMesh('Mars').terrainManager,n=t.metrics.network,i=t.cubeImageryStats;return t.tiles.visibleTiles.size>0&&n.queued+n.downloading+n.parsing===0&&t.cubeStats.inFlight===0&&i.inFlight===0&&(i.queued===0||i.budgetLimited);},undefined,{timeout:180000});
 await page.waitForTimeout(1000);
 await page.evaluate(camera=>{const r=window.renderer,b=r.getBodyMesh('Mars'),V=r.camera.position.constructor;r.cameraController.controls.enableDamping=false;r.camera.position.copy(new V(...camera.position).multiplyScalar(r.scaleFactor).add(b.position));r.cameraController.controls.target.copy(new V(...camera.target).multiplyScalar(r.scaleFactor).add(b.position));r.camera.up.set(...camera.up);r.camera.lookAt(r.cameraController.controls.target);r.camera.updateMatrixWorld(true);},view.view.camera);
 await page.waitForTimeout(3000);
 await page.evaluate(()=>{window.cosmo.setPlaying(false);window.cosmo.setGridOpacity(1);window.cosmo.setGridCoordinateFrame(false);});
 await page.waitForTimeout(2000);
 const capture=await page.evaluate(()=>{const r=window.renderer,b=r.getBodyMesh('Mars'),gl=r.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return {gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,metrics:{latitudeStep:b.gridMetrics.latitudeStep,longitudeStep:b.gridMetrics.longitudeStep,labels:b.gridMetrics.labels},network:b.terrainManager.metrics.network,imagery:b.terrainManager.cubeImageryStats,camera:r.camera.position.toArray(),visibleTiles:b.terrainManager?.tiles.visibleTiles.size,programs:r.renderer.info.programs.map(p=>({name:p.name,runnable:p.diagnostics?.runnable}))};});
 capture.shaderModules=await page.evaluate(()=>performance.getEntriesByType('resource').map(e=>e.name).filter(n=>n.includes('GraticuleShader')));capture.kind=baseline?'before':'after';if(baseline)assert.ok(baselineLoads>0,'Baseline shader was not loaded');report.captures.push(capture);console.log(JSON.stringify(capture));assert.equal(await page.getByText('Couldn’t restore view:',{exact:false}).count(),0);
 assert.ok(capture.visibleTiles>0);assert.ok(capture.metrics.latitudeStep>0);
 await page.screenshot({path:`${out}/${capture.kind}.png`});
 if(!baseline){
 report.gpuPrecision=await page.evaluate(async root=>{
  const shaderUrl=`/@fs/${root}/packages/three/src/GraticuleShader.ts`;
  const source=await(await fetch(shaderUrl)).text();
  const threeUrl=source.match(/import \* as THREE from ["']([^"']+)["']/)[1];
  const THREE=await import(threeUrl), grid=await import(shaderUrl),core=await import(`/@fs/${root}/packages/core/src/index.ts`);
  const gpu=new THREE.WebGLRenderer();gpu.setSize(64,64);const results=[];
  for(const [name,radii,lat,lon] of [['Mars',[3396.19,3396.19,3376.2],18.636,77.448],['Moon',[1737.4,1737.4,1737.4],-89.8,129.78],['Earth',[6378.137,6378.137,6356.752],16.67,179.999]]){
   const coords=core.bodySurfaceCoordinates({name,radii});const uniforms=grid.makeGraticuleUniforms(coords);uniforms.uGridVisible.value=1;uniforms.uGridStep.value.set(.001,.001);
   const point=h=>{const p=core.surfacePositionToBodyFixed({latDeg:lat,lonDeg:lon,heightKm:h},coords);return new THREE.Vector3(p.xKm,p.yKm,p.zKm);};
   const centre=point(0),normal=point(1).sub(centre).normalize();
   const camera=new THREE.PerspectiveCamera(.5,1,.001,1);camera.position.copy(centre).addScaledVector(normal,.1);camera.lookAt(centre);camera.updateMatrixWorld(true);
   const material=new THREE.ShaderMaterial({vertexShader:'void main(){vec3 transformed=position;\n#include <project_vertex>\n}',fragmentShader:'void main(){vec3 outgoingLight=vec3(0.0);\n#include <opaque_fragment>\ngl_FragColor=vec4(outgoingLight,1.0);}' });
   grid.applyGraticuleMaterial(material,uniforms,new THREE.Matrix4());const compile=material.onBeforeCompile.bind(material);
   material.onBeforeCompile=(shader,r)=>{compile(shader,r);shader.fragmentShader=shader.fragmentShader.replace('outgoingLight = mix(outgoingLight, grid.rgb, grid.a * horizon * uGridVisible * uGridOpacity);','outgoingLight=vec3(angles+uGridPhase,0.0);').replace('#include <opaque_fragment>','');};
   const mesh=new THREE.Mesh(new THREE.PlaneGeometry(.001,.001),material);mesh.position.copy(centre);mesh.quaternion.copy(camera.quaternion);const scene=new THREE.Scene();scene.add(mesh);
   const target=new THREE.WebGLRenderTarget(64,64,{type:THREE.FloatType});gpu.setRenderTarget(target);gpu.render(scene,camera);
   const pixels=new Float32Array(64*64*4);gpu.readRenderTargetPixels(target,0,0,64,64,pixels);
   const origin=core.bodyFixedToSurfacePosition({xKm:camera.position.x,yKm:camera.position.y,zKm:camera.position.z},coords);
   let maxErrorM=0;for(let y=0;y<64;y++)for(let x=0;x<64;x++){
    const half=.1*Math.tan(camera.fov*Math.PI/360);const p=new THREE.Vector3(((x+.5)/64*2-1)*half,((y+.5)/64*2-1)*half,0).applyQuaternion(mesh.quaternion).add(centre);
    const expected=core.bodyFixedToSurfacePosition({xKm:p.x,yKm:p.y,zKm:p.z},coords),i=(y*64+x)*4;
    const dlat=pixels[i]-(expected.latDeg-origin.latDeg+origin.latDeg%.001),dlon=pixels[i+1]-(expected.lonDeg-origin.lonDeg+origin.lonDeg%.001);
    maxErrorM=Math.max(maxErrorM,Math.hypot(dlat,dlon*Math.cos(lat*Math.PI/180))*Math.PI/180*radii[0]*1000);
   }
   results.push({name,samples:4096,maxErrorM});target.dispose();mesh.geometry.dispose();material.dispose();
  }
  gpu.dispose();return results;
 },process.cwd());
 console.log('GPU precision',JSON.stringify(report.gpuPrecision));assert.ok(report.gpuPrecision.every(r=>r.maxErrorM<.02),'Close-range GPU coordinates drifted more than 2 cm');
 }
 await page.close();
}
assert.deepEqual(report.errors,[]);report.passed=true;
}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2)+'\n');await browser.close();}
