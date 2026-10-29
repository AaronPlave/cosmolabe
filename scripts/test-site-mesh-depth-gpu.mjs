#!/usr/bin/env node
// Actual viewer: visual-only site, a closer planetary ridge, and an art model.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const out = process.argv[2] ?? 'work/curiosity-247/review-occlusion';
await mkdir(out, { recursive: true });
const bundle = await build({ stdin: { contents: `export * as THREE from 'three';
export { Universe } from './packages/core/dist/Universe.js';
export { UniverseRenderer } from './packages/three/dist/UniverseRenderer.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'browser', external: ['@mapbox/vector-tile','pbf','pmtiles'] });
function gltf(site) {
  const p = new Float32Array(site ? [-200,0,-200, 200,0,-200, 200,0,200, -200,0,200]
    : [-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]);
  const indices = new Uint16Array([0,1,2,0,2,3]);
  const bytes = Buffer.concat([Buffer.from(p.buffer),Buffer.from(indices.buffer)]);
  return { asset:{version:'2.0'}, extensionsUsed:['KHR_materials_unlit'],
    buffers:[{uri:`data:application/octet-stream;base64,${bytes.toString('base64')}`,byteLength:bytes.length}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:p.byteLength},{buffer:0,byteOffset:p.byteLength,byteLength:indices.byteLength}],
    accessors:[{bufferView:0,componentType:5126,count:4,type:'VEC3',min:site?[-200,0,-200]:[-1,-1,0],max:site?[200,0,200]:[1,1,0]},
      {bufferView:1,componentType:5123,count:6,type:'SCALAR'}],
    materials:[{doubleSided:true,pbrMetallicRoughness:{baseColorFactor:site?[0,1,0,1]:[1,0,0,1]},extensions:{KHR_materials_unlit:{}}}],
    meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0 };
}
const browser = await chromium.launch({ headless:true,
  ...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),
  args:['--enable-gpu','--ignore-gpu-blocklist',process.platform==='darwin'?'--use-angle=metal':'--use-angle=swiftshader'] });
try {
  const page = await browser.newPage({viewport:{width:768,height:512}}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://site-depth.test/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/bundle.js') return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});
    if(path==='/site.json') return route.fulfill({json:{asset:{version:'1.0',gltfUpAxis:'Z'},geometricError:0,
      root:{boundingVolume:{box:[0,0,0,200,0,0,0,5,0,0,0,200]},geometricError:0,content:{uri:'/site.gltf'}}}});
    if(path.endsWith('.gltf')) return route.fulfill({json:gltf(path==='/site.gltf')});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><style>body{margin:0}canvas{width:768px;height:512px}</style><canvas></canvas>'});
  });
  await page.goto('http://site-depth.test/');
  const result=await page.evaluate(async()=>{
    const {THREE,Universe,UniverseRenderer}=await import('/bundle.js');
    const u=new Universe(); u.loadCatalog({items:[{name:'Test planet',class:'planet',
      trajectory:{type:'FixedPoint',position:[0,0,0]},rotationModel:{type:'Fixed',quaternion:[Math.SQRT1_2,Math.SQRT1_2,0,0],inertialFrame:'ECLIPJ2000',bodyFixedFrame:'SYNTHETIC'},
      geometry:{type:'Globe',radius:1,surfaceTiles:[{name:'square',url:'/site.json',sourceVersion:'synthetic-v1',
        registration:{version:'v1',bodyFixedFrame:'SYNTHETIC',bodyFixedKmFromLocalMeters:[.001,0,0,0,0,.001,0,0,0,0,.001,0,0,0,1,1],
          status:'controlled',provenance:'Synthetic oblique/ridge fixture',uncertaintyKm:0},
        coverage:{min:[-200,-5,-200],max:[200,5,200]},physicalQueryPolicy:'visual-only',overlapPolicy:'composite'}]}},
      {name:'Model',class:'spacecraft',trajectory:{type:'FixedPoint',position:[0,1,-.05]},geometry:{type:'Mesh',source:'/model.gltf',size:.1}}]});
    const v=new UniverseRenderer(document.querySelector('canvas'),u,{scaleFactor:.001,minBodyPixels:0,showStars:false,showLabels:false,showTrajectories:false,modelResolver:x=>x,bloom:{enabled:false}});
    v.timeController.pause();v.cameraController.controls.enableDamping=false;
    const b=v.getBodyMesh('Test planet'),o=b.getSurfaceOverlays()[0],c=v.camera;
    const pose=(x=0,y=1.2)=>{c.fov=20;c.position.set(x*.001,y*.001,.004);c.up.set(0,1,0);v.cameraController.controls.target.set(0,.001,0);c.lookAt(0,.001,0);c.updateProjectionMatrix();c.updateMatrixWorld(true);};
    for(let i=0;i<300;i++){pose();v.renderFrame();if(o.tiles.visibleTiles.size&&v.getBodyMesh('Model').hasModel)break;await new Promise(requestAnimationFrame);}
    if(!o.tiles.visibleTiles.size)throw new Error('site failed to load');
    const ridge=new THREE.Mesh(new THREE.PlaneGeometry(.2,.8),new THREE.MeshBasicMaterial({color:0x0000ff,side:THREE.DoubleSide}));
    ridge.position.set(-.1,1.1,2);b.mesh.add(ridge);
    const gl=v.renderer.getContext(),pixels=new Uint8Array(768*512*4);
    const read=()=>{v.renderFrame();gl.readPixels(0,0,768,512,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const counts={green:0,blue:0,red:0};for(let i=0;i<pixels.length;i+=4){if(pixels[i+1]>180&&pixels[i]<60&&pixels[i+2]<60)counts.green++;if(pixels[i+2]>180&&pixels[i]<60&&pixels[i+1]<60)counts.blue++;if(pixels[i]>180&&pixels[i+1]<60&&pixels[i+2]<60)counts.red++;}return counts;};
    const rows=[];
    for(const [x,y] of [[0,1.2],[.15,1.05]]){
      pose(x,y);ridge.visible=false;const clear=read();ridge.visible=true;const covered=read();
      // Use the actual shared viewer discovery path, independent of visual tiles.
      const pick=v._discoverSurface(0,0,false);
      const overlays=b.surfaceOverlays.splice(0);o.group.visible=false;const withoutSite=read();
      const underlying=v._discoverSurface(0,0,false);
      b.surfaceOverlays.push(...overlays);read();
      rows.push({x,y,clear,covered,withoutSite,source:pick?.ray.source ?? null, underlyingSource:underlying?.ray.source ?? null,
        pickDifference:!pick&&!underlying?0:pick?.ray.worldPoint.distanceTo(underlying?.ray.worldPoint)});
    }
    const ext=gl.getExtension('WEBGL_debug_renderer_info');
    window.depthViewer=v;
    return {gpu:gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER),rows};
  });
  console.log(JSON.stringify(result));
  await page.screenshot({path:`${out}/foreground-relief.png`});
  assert.deepEqual(errors,[]);
  for(const row of result.rows){
    assert.ok(row.clear.green>100,'reconstruction actually renders');
    assert.ok(row.covered.blue>100&&row.covered.green<row.clear.green*.9,'foreground relief hides distant site pixels');
    assert.equal(row.covered.red,0,'site occludes the model');
    assert.ok(row.withoutSite.red>20,'model exists behind the site');
    assert.equal(row.source,row.underlyingSource);assert.equal(row.pickDifference,0,'physical discovery ignores visual-only site');
  }
  assert.equal(result.rows[0].source,'ellipsoid');
  assert.equal(result.rows[1].source,null,'a visible visual-only triangle cannot create a physical hit above the horizon');
  await writeFile(`${out}/acceptance.json`,JSON.stringify({...result,passed:true},null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{await browser.close();}
