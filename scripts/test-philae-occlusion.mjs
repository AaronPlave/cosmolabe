#!/usr/bin/env node
// Real textured Philae against the authoritative DSK. Never move the lander.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
const output=process.env.ROSETTA_CAPTURE_DIR ?? '/tmp/philae-occlusion';
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:1400,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(`${process.env.CL_VIEWER_URL ?? 'http://localhost:5180'}/?catalog=test-catalogs/rosetta&test=1`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__cosmolabe?.assetsReady,null,{timeout:180000});
 const views=await page.evaluate(async()=>{
  const T=await import('/node_modules/.vite/deps/three.js');
  window.__cosmolabe.capture('Philae final site, Abydos (2014-11-12)');
  const r=window.renderer, bm=r.bodyMeshes.get('Philae'), comet=r.bodyMeshes.get('67P/Churyumov-Gerasimenko');
  const vp=r.cameraController.getViewpoint('Philae final site, Abydos (2014-11-12)');
  r.setLabelsVisible(false); // isolate model pixels from temporal label fades
  const p=bm.position.clone();
  const caster=new T.Raycaster();caster.layers.enableAll();
  const bounds=new T.Box3().setFromObject(bm.modelContainer);
  const corners=[];
  for(const x of [bounds.min.x,bounds.max.x]) for(const y of [bounds.min.y,bounds.max.y]) for(const z of [bounds.min.z,bounds.max.z]) corners.push(new T.Vector3(x,y,z));
  const result=[];
  // Search physical camera positions from 40m to 9km around the archived lander. Keep
  // one unoccluded view and one with a real foreground plate intersection.
  for(const radius of [.04,.4,4,9]) for(let i=0;i<120 && result.length<2;i++) {
    const y=1-2*(i+.5)/120, phi=i*2.399963229728653;
    const dir=new T.Vector3(Math.sqrt(1-y*y)*Math.cos(phi),y,Math.sqrt(1-y*y)*Math.sin(phi));
    const camera=p.clone().addScaledVector(dir,radius*r.scaleFactor);
    caster.set(camera,p.clone().sub(camera).normalize());
    const first=caster.intersectObjects(comet.getDskMeshes(),false)[0];
    const hidden=!!first && first.distance<camera.distanceTo(p)*.95;
    if(hidden && !corners.every(point=>comet.dskOccludes(camera,point))) continue;
    if(result.some(x=>x.hidden===hidden)) continue;
    result.push({hidden,radiusKm:radius,position:camera.clone().sub(p).divideScalar(r.scaleFactor).toArray(),plateDistanceKm:first?first.distance/r.scaleFactor:null});
  }
  if(result.length!==2) throw new Error('Could not find foreground and behind-plate views');
  window.__philaeView=vp;
  return result;
 });
 mkdirSync(output,{recursive:true});
 for(const view of views) {
  view.withoutSurfaceDepth=process.env.NO_MODEL_SURFACE_DEPTH === '1';
  const images=await page.evaluate(view=>{
    const r=window.renderer,bm=r.bodyMeshes.get('Philae'),vp=window.__philaeView;
    if(view.withoutSurfaceDepth) r.modelSurfaceDepth.scene.visible=false;
    r.camera.fov=view.hidden?5:45; // optical zoom makes the occluded spacecraft a meaningful pixel test
    r.camera.updateProjectionMatrix();
    r.cameraController.applyViewpoint({...vp,position:vp.position.clone().fromArray(view.position).multiplyScalar(r.scaleFactor).add(bm.position)});
    window.__cosmolabe.capture(); // settle camera/body transforms
    const visible=window.__cosmolabe.capture();
    const materials=new Set();
    bm.modelContainer.traverse(object=>{if(object.isMesh) for(const material of Array.isArray(object.material)?object.material:[object.material]) materials.add(material);});
    for(const material of materials) material.visible=false;
    const absent=window.__cosmolabe.capture();
    for(const material of materials) material.visible=true;
    return {visible,absent};
  },view);
  const png=Buffer.from(images.visible.split(',')[1],'base64');
  const a=await sharp(png).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const b=await sharp(Buffer.from(images.absent.split(',')[1],'base64')).removeAlpha().raw().toBuffer();
  let changed=0;
  // Philae is tracked at screen center. Compare only the model's neighborhood,
  // preserving independent labels, terrain and trajectory state in both images.
  for(let y=350;y<550;y++) for(let x=600;x<800;x++) {
    const p=(y*a.info.width+x)*3;
    if(Math.max(Math.abs(a.data[p]-b[p]),Math.abs(a.data[p+1]-b[p+1]),Math.abs(a.data[p+2]-b[p+2]))>8) changed++;
  }
  view.changedPixels=changed;
  writeFileSync(`${output}/${view.hidden?'occluded':'visible'}.png`,png);

  if(view.hidden) assert.equal(changed,0,'Philae behind foreground DSK must contribute no visible pixels');
  else assert.ok(changed>10,'unoccluded textured Philae must remain visible');
 }
 assert.deepEqual(errors,[]);
 writeFileSync(`${output}/report.json`,JSON.stringify({views,errors},null,2));
 console.log(JSON.stringify({views,errors},null,2));
} finally {await browser.close();}
