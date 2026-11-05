/** Actual MoonFall horizon coverage across the streaming camera depth slab.
 * --depth-baseline removes only the depth-plane repair from the loaded module. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'work/moonfall-jank/horizon';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  args: ['--enable-gpu', '--ignore-gpu-blocklist', process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader'],
});
const result = { errors: [] };
const page = await browser.newPage(process.argv.includes('--hidpi') ? { viewport: { width: 1876, height: 1080 }, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } });
page.on('pageerror', e => result.errors.push(e.message));
page.on('console', m => { if (/GL_INVALID|INVALID_OPERATION|Shader Error/.test(m.text())) result.errors.push(m.text()); });
const baseline = process.argv.includes('--depth-baseline');
const report = { baseline, errors: result.errors, views: [], passed: false };
try {
if (baseline) await page.route('**/packages/three/src/CubeImageryLayer.ts*', async route => {
  const response = await route.fetch(), source = await response.text();
  const body = source.replace(/    for \(const frustum of \[_frustum, _bodyFrustum\]\) \{\s*frustum\.planes\[4\]\.constant = Infinity;\s*frustum\.planes\[5\]\.constant = Infinity;\s*\}/, '');
  assert.ok(body !== source, 'Depth baseline must remove only the new culling repair');
  await route.fulfill({ response, body });
});
const body='Moon';
    await page.goto(`${base}?catalog=test-catalogs/moonfall-shackleton`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(body => window.renderer?.getBodyMesh(body)?.terrainManager?.cubeImageryStats?.version, body, { timeout: 120000 });
    await page.evaluate(async () => { await window.renderer.waitForInitialAssets(); window.cosmo.setPlaying(false); window.cosmo.untrack(); });

for (const height of [2,5,10,5,2]) {
await page.evaluate(({height})=>{
 const r=window.renderer,b=r.getBodyMesh('Moon'),V=r.camera.position.constructor,centre=new V();b.getWorldPosition(centre);
 const world=([x,y,z])=>new V(x,z,-y).applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
 const at=(lat,lon,radius)=>{const a=lat*Math.PI/180,o=lon*Math.PI/180;return [radius*Math.cos(a)*Math.cos(o),radius*Math.cos(a)*Math.sin(o),radius*Math.sin(a)];};
 const radius=b.terrainManager.bodyRadiusKm, p=at(-89.7,129,radius+height), target=world(at(-86,0,radius));
 const cc=r.cameraController;cc.controls.staticMoving=true;cc.controls.target.copy(target);r.camera.position.copy(world(p));r.camera.up.copy(world(at(-89.7,129,1)).sub(centre).normalize());r.camera.fov=60;r.camera.updateProjectionMatrix();r.camera.lookAt(target);r.camera.updateMatrixWorld(true);
}, {height});
await page.evaluate(async () => {
 const t=window.renderer.getBodyMesh('Moon').terrainManager, deadline=performance.now()+60000;
 let quiet=0; while(quiet<30){await new Promise(requestAnimationFrame);const n=t.metrics.network,i=t.cubeImageryStats;
 quiet=n.queued+n.downloading+n.parsing===0&&i.queued===0&&i.inFlight===0&&i.waitingGroups===0&&!i.budgetLimited?quiet+1:0;
 if(performance.now()>deadline)throw Error('Horizon refinement did not settle');}
});
const key=`${report.views.length}-h${height}`;
for(const mode of ['none','imagery-unlit','imagery-level']){
await page.evaluate(mode=>{window.renderer.getBodyMesh('Moon').terrainManager.setDebugMode(mode);window.renderer.renderFrame();},mode);
await page.waitForTimeout(300);await page.screenshot({path:`${out}/${key}-${mode}.png`});
}
const state=await page.evaluate(async root=>{
 const {directionToTexel}=await import(`/@fs/${root}/packages/three/src/surface/CubeImagery.ts`);
 const r=window.renderer,t=r.getBodyMesh('Moon').terrainManager,l=t.cubeImageryLayer,wr=r.getContext().webglRenderer,gl=wr.getContext();
 const inv=t.tiles.group.matrixWorld.clone().invert(),eye=r.camera.position.clone().applyMatrix4(inv).multiplyScalar(.001);
 const points=[];t.setDebugMode('imagery-level');r.renderFrame();
 for(let y=-.8;y<.17;y+=.02)for(let x=-.8;x<=.8;x+=.2){
  const px=Math.floor((x+1)*gl.drawingBufferWidth/2),py=Math.floor((y+1)*gl.drawingBufferHeight/2);
  const h=r._discoverSurface(2*(px+.5)/gl.drawingBufferWidth-1,2*(py+.5)/gl.drawingBufferHeight-1,false);
  if(h?.point.bodyName!=='Moon')continue;
  const p=h.point.bodyFixedPositionKm,address=directionToTexel(p,30,1,0).address;
  const contains=a=>a.face===address.face&&Math.floor(address.x/2**(30-a.level))===a.x&&Math.floor(address.y/2**(30-a.level))===a.y;
  const wanted=(l.selectionCache.get(0)??[]).filter(contains).sort((a,b)=>b.level-a.level)[0]??null;
  const pixel=new Uint8Array(4);gl.readPixels(px,py,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
  const norm=a=>{const length=Math.hypot(...a);return a.map(v=>v/(length||1));},rgb=norm([...pixel].slice(0,3));
  const palette=Array.from({length:14},(_,level)=>{const c=norm([0,2,4].map(v=>.5+.5*Math.cos(2*Math.PI*(level*.137+v/3))));return {level,error:Math.hypot(...c.map((v,k)=>v-rgb[k]))};}).sort((a,b)=>a.error-b.error);
  points.push({x,y,lat:h.point.latDeg,lon:h.point.lonDeg,distanceKm:Math.hypot(p[0]-eye.x,p[1]-eye.y,p[2]-eye.z),wanted,pixel:[...pixel],images:l.sampleAt(p).map(({texture,...a})=>a),gpuLevel:palette[0]});
 }
 const before=l.stats,intervals=[];let previous;
 for(let n=0;n<60;n++){await new Promise(requestAnimationFrame);const now=performance.now();if(previous)intervals.push(now-previous);previous=now;}
 const after=l.stats,ext=gl.getExtension('WEBGL_debug_renderer_info');
 return {points,stats:after,gpu:gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER),glError:gl.getError(),intervals,
 churn:{requests:after.requests-before.requests,evicted:after.evicted-before.evicted,aborted:after.aborted-before.aborted}};
},resolve('.'));
report.views.push({key,heightAboveReferenceSphereKm:height,...state});
await writeFile(`${out}/metrics.json`,JSON.stringify(report,null,2));
const distant=state.points.filter(p=>p.distanceKm>50);
assert.ok(distant.length>=3,'Need actual physical horizon samples beyond the streaming slab');
assert.doesNotMatch(state.gpu,/SwiftShader|llvmpipe/i);assert.equal(state.glError,0);
if(!baseline){
 for(const p of distant){assert.ok(p.wanted,'Drawn distant surface omitted from demand');assert.ok(p.images[0].level>=p.wanted.level,'Distant image left coarse');if(p.gpuLevel.error<.04)assert.equal(p.gpuLevel.level,p.images[0].level,'GPU disagrees with committed image');}
 // Multisampled silhouettes/LOD edges can blend debug hues. Retain those
 // pixels in evidence, but require at least 95% unambiguous distant decodes.
 assert.ok(distant.filter(p=>p.gpuLevel.error<.04).length>=distant.length*.95,'Insufficient unambiguous GPU samples');
 assert.deepEqual(state.churn,{requests:0,evicted:0,aborted:0});
}
console.log(key,JSON.stringify({distant:distant.length,rootFallbacks:distant.filter(p=>p.images[0].level===0).length,stats:state.stats}));
}
assert.deepEqual(report.errors,[]); report.passed=true;
} finally { await writeFile(`${out}/metrics.json`,JSON.stringify(report,null,2)); await browser.close(); }
