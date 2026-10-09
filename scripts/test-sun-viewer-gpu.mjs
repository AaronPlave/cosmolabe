#!/usr/bin/env node
/** Real UniverseRenderer + atmosphere + streamed surface-tile/model integration.
 * npm run build && CHROMIUM_PATH=/usr/bin/chromium node scripts/test-sun-viewer-gpu.mjs
 * Asset fixtures are self-contained; timings use software WebGL, not hardware estimates.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ stdin: { contents: `
  export * as THREE from 'three';
  export { Universe } from './packages/core/dist/Universe.js';
  export { UniverseRenderer } from './packages/three/dist/UniverseRenderer.js';
  export { TrajectoryLine } from './packages/three/dist/TrajectoryLine.js';
  export { SensorFrustum } from './packages/three/dist/SensorFrustum.js';
`, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'esm', platform: 'browser',
  external: ['@mapbox/vector-tile', 'pbf', 'pmtiles'] // Optional raster-format loaders, unused by GLTF fixtures.
});
function gltf(color, count, tile) {
  const positions = new Float32Array(tile ? [-6000,-800,0, -1500,-800,0, -1500,800,0, -6000,800,0]
    : [-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]);
  const indices = new Uint16Array([0,1,2,0,2,3]);
  const bytes = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  return { asset: { version: '2.0' }, extensionsUsed: ['KHR_materials_unlit'],
    buffers: [{ uri: `data:application/octet-stream;base64,${bytes.toString('base64')}`, byteLength: bytes.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3',
      min: tile ? [-6000,-800,0] : [-1,-1,0], max: tile ? [-1500,800,0] : [1,1,0] },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [...color,1] }, doubleSided: true, extensions: { KHR_materials_unlit: {} } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    nodes: Array.from({ length: count }, (_,i) => ({ mesh: 0, translation: tile ? [0,0,0] : [(i % 16)*2, Math.floor(i/16)*2, 0] })),
    scenes: [{ nodes: Array.from({ length: count }, (_,i) => i) }], scene: 0 };
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 768, height: 512 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.text().startsWith('[solar-test]')) console.log(m.text());
    if (m.type() === 'error' || /GL_INVALID_OPERATION|Feedback loop/i.test(m.text())) errors.push(m.text());
  });
  await page.route('http://solar-viewer.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
    if (path === '/site.json') return route.fulfill({ json: { asset: { version: '1.0', gltfUpAxis: 'Z' }, geometricError: 0,
      root: { boundingVolume: { box: [-3750,0,0, 2250,0,0, 0,800,0, 0,0,10] }, geometricError: 0,
        refine: 'ADD', content: { uri: '/tile.gltf' } } } });
    if (path === '/tile.gltf') return route.fulfill({ json: gltf([0,1,0], 1, true) });
    if (path === '/model.gltf') return route.fulfill({ json: gltf([1,0,0], 256, false) });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:0;background:black}canvas{width:768px;height:512px}</style><canvas></canvas>' });
  });
  await page.goto('http://solar-viewer.test/');
  const result = await page.evaluate(async () => {
    const { THREE, Universe, UniverseRenderer } = await import('/bundle.js');
    console.log('[solar-test] viewer modules loaded');
    const universe = new Universe();
    universe.loadCatalog({ name: 'solar integration', items: [
      { name: 'Earth', class: 'planet', trajectory: { type: 'FixedPoint', position: [0,0,0] },
        geometry: { type: 'Globe', radius: 6371, atmosphere: 'Earth',
          surfaceTiles: [{ name: 'regression-site', url: '/site.json', lat: 0, lon: 0 }] } },
      { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: [0,0,149597870] }, geometry: { type: 'Globe', radius: 695000 } },
      { name: 'Heavy model', class: 'spacecraft', trajectory: { type: 'FixedPoint', position: [6371.7,0,3] },
        geometry: { type: 'Mesh', source: '/model.gltf', size: 0.2 } },
    ] });
    const viewer = new UniverseRenderer(document.querySelector('canvas'), universe, {
      scaleFactor: 0.001, minBodyPixels: 0, showStars: false, showLabels: false, showTrajectories: false,
      bloom: { enabled: true }, modelResolver: name => name,
    });
    viewer.timeController.pause();
    const camera = viewer.camera;
    function pose() {
      camera.position.set(6.372,0,0); camera.up.set(1,0,0);
      viewer.cameraController.controls.target.set(6.372,0,10);
      camera.lookAt(6.372,0,10); camera.updateMatrixWorld(true);
    }
    viewer.cameraController.controls.enableDamping = false;
    const earth = viewer.getBodyMesh('Earth');
    const overlay = earth.getSurfaceOverlays()[0];
    for (let i = 0; i < 40; i++) {
      pose(); viewer.renderFrame();
      let count = 0; overlay.group.traverse(obj => { if (obj.isMesh) count++; });
      if (i % 10 === 0) console.log('[solar-test] loading frame', i, 'tiles', count, 'model', viewer.getBodyMesh('Heavy model').hasModel);
      if (count > 0 && viewer.getBodyMesh('Heavy model').hasModel) break;
      await new Promise(requestAnimationFrame);
    }
    let tileMeshes = 0; overlay.group.traverse(obj => { if (obj.isMesh) tileMeshes++; });
    // Observe the actual renderer calls: no imitation of the multi-pass sequence.
    const passes = [];
    const render = viewer.renderer.render.bind(viewer.renderer);
    viewer.renderer.render = (scene, camera) => {
      if (scene === viewer.scene || scene === viewer.tileScene) passes.push({
        scene: scene === viewer.tileScene ? 'tiles' : 'main', mask: camera.layers.mask });
      return render(scene, camera);
    };
    pose(); viewer.renderFrame();
    const gl = viewer.renderer.getContext();
    const pixels = new Uint8Array(768*512*4);
    gl.readPixels(0,0,768,512,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    let green = 0, blue = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i+1] > 180 && pixels[i] < 70 && pixels[i+2] < 70) green++;
      // Twilight sky need not be blue. Sample the unobstructed upper quarter.
      if (i/4 >= 768*384 && pixels[i]+pixels[i+1]+pixels[i+2] > 15) blue++;
    }
    const effect = viewer.sunGlareEffect;
    const sourceMeshes = effect.sourceScene.children.length;
    const sourceScissor = effect.target.scissor.toArray();
    const sourceArea = sourceScissor[2]*sourceScissor[3];
    let modelMeshes = 0;
    viewer.getBodyMesh('Heavy model').modelContainer.traverse(obj => { if (obj.isMesh) modelMeshes++; });
    const sourceTimes = [];
    const originalGlare = effect.render.bind(effect);
    effect.render = (...args) => {
      gl.finish(); const start = performance.now();
      originalGlare(...args); gl.finish(); sourceTimes.push(performance.now()-start);
    };
    const frameTimes = [];
    for (let i = 0; i < 8; i++) { pose(); const start = performance.now(); viewer.renderFrame(); gl.finish(); frameTimes.push(performance.now()-start); }
    const average = values => values.reduce((a,b)=>a+b,0)/values.length;
    const info = { passes: passes.slice(0,4), tileMeshes, modelMeshes, greenPixels: green, atmospherePixels: blue,
      sourceMeshes, sourceScissor, sourceAreaFraction: sourceArea/(768*512),
      softwareFrameMs: average(frameTimes.slice(2)), softwareSolarMs: average(sourceTimes.slice(2)),
      solarDiameter: viewer.getBodyMesh('Sun').sunVisual.diameterPixels };
    window.solarViewer = viewer;
    return info;
  });
  console.log(JSON.stringify(result, null, 2));
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.ok(result.tileMeshes > 0 && result.modelMeshes >= 256, 'real tile and model fixtures must load');
  assert.ok(result.greenPixels > 100, 'surface tile must contribute green pixels with the Sun present');
  assert.ok(result.atmospherePixels > 100, 'real atmosphere shell must contribute sky pixels');
  assert.ok(result.passes.some(p => p.scene === 'main' && p.mask === 16), 'solar display pass must run');
  assert.deepEqual(result.passes.map(p => p.mask), [1,16,4,1], 'bodies, Sun, overlays, then tiles must preserve depth and restore layers');
  assert.ok(result.passes.find(p => p.scene === 'tiles').mask & 1, 'solar pass must restore layer 0 before surface tiles');
  assert.ok(result.sourceMeshes <= 3, 'model-heavy scene must use a small explicit solar occluder set');
  assert.ok(result.sourceAreaFraction < 0.1, 'small solar source pass must be scissored');
  mkdirSync('work/sun-rendering', { recursive: true });
  await page.screenshot({ path: 'work/sun-rendering/viewer-atmosphere-tiles.png' });
  const overlays = await page.evaluate(async () => {
    const { THREE, TrajectoryLine, SensorFrustum } = await import('/bundle.js');
    const v = window.solarViewer, sun = v.getBodyMesh('Sun'), c = v.camera;
    const z = sun.position.z, radius = sun.displayRadius * 0.001;
    const distance = Math.sqrt(radius**2 + (radius*512/(150*Math.tan(c.fov*Math.PI/360)))**2);
    c.position.set(0,0,z-distance); c.up.set(0,1,0);
    v.cameraController.controls.target.set(0,0,z); c.lookAt(0,0,z); c.updateMatrixWorld(true);
    const gl = v.renderer.getContext();
    const read = () => { v.renderFrame(); const p = new Uint8Array(768*512*4); gl.readPixels(0,0,768,512,gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
    const baseline = read();
    const trajectory = new TrajectoryLine(sun.body, { maxPoints: 4, color: 0x0000ff, opacity: 1 });
    const line = trajectory.children.find(o => o.isLine);
    line.geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -radius*1.4,0,z-radius-1000, 0,0,z-radius-1000,
      0,0,z+radius+1000, radius*1.4,0,z+radius+1000],3));
    line.geometry.setAttribute('color', new THREE.Float32BufferAttribute([0,0,1, 0,0,1, 0,0,1, 0,0,1],3));
    line.geometry.setDrawRange(0,4);
    trajectory.traverse(o => o.layers.set(2)); v.scene.add(trajectory);
    const withLine = read();
    const changed = (image, left, right, bottom, top) => {
      let count = 0;
      for (let y=bottom;y<top;y++) for(let x=left;x<right;x++) {
        const i=(y*768+x)*4;
        if (image[i+2]-baseline[i+2] > 8) count++;
      }
      return count;
    };
    // Looking along +Z makes negative world X appear on the right of the canvas.
    const frontLine = changed(withLine,395,438,253,260), behindLine = changed(withLine,330,375,253,260);
    trajectory.visible = false;
    const cone = new SensorFrustum(sun.body, { color: 0x0000ff, opacity: 0.8 });
    cone.labelSprite.visible = false;
    const mesh = cone.children.find(o => o.isMesh);
    mesh.scale.set(250,400,250);
    cone.children.filter(o=>o.isLine).forEach(o=>o.visible=false);
    cone.rotation.x = -Math.PI/2; cone.position.set(0,300,z-radius-1000);
    cone.traverse(o=>o.layers.set(2)); v.scene.add(cone);
    const frontCone = changed(read(),345,423,265,310);
    cone.position.z = z+radius+1000;
    const behindCone = changed(read(),345,423,265,310);
    cone.position.z = z-radius-1000;
    trajectory.visible = true;
    read();
    return { frontLine, behindLine, frontCone, behindCone };
  });
  console.log('Overlay depth regression:', overlays);
  assert.ok(overlays.frontLine > 15, 'foreground trajectory must remain visible across the solar disk');
  assert.equal(overlays.behindLine, 0, 'trajectory behind the Sun must remain occluded');
  assert.ok(overlays.frontCone > 100, 'foreground sensor cone must remain visible across the solar disk');
  assert.equal(overlays.behindCone, 0, 'sensor cone behind the Sun must remain occluded');
  await page.screenshot({path:'work/sun-rendering/viewer-overlays.png'});
  const horizon = await page.evaluate(async () => {
    const { Universe, UniverseRenderer } = await import('/bundle.js');
    window.solarViewer.dispose();
    const u = new Universe();
    u.loadCatalog({ name: 'horizon depth regression', items: [
      { name: 'Earth', class: 'planet', trajectory: { type: 'FixedPoint', position: [0,0,0] },
        geometry: { type: 'Globe', radius: 6371, atmosphere: { mieCoeff: 0, mieScaleHeight: 8,
          miePhaseAsymmetry: 0, rayleighCoeff: [0,0,0], absorptionCoeff: [0,0,0], heightKm: 100 } } },
      { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: [0,0,149597870] },
        geometry: { type: 'Globe', radius: 695000 } },
    ] });
    const v = new UniverseRenderer(document.querySelector('canvas'),u,{ scaleFactor: 0.001,
      minBodyPixels: 0, showStars: false, showLabels: false, showTrajectories: false });
    v.timeController.pause(); v.cameraController.controls.enableDamping=false;
    const c=v.camera;
    c.position.set(6.371001,0,0); c.up.set(1,0,0); c.fov=8; c.updateProjectionMatrix();
    // Keep the actual coarse visible globe, including its facet horizon.
    const a = [...v.atmosphereMeshes.values()][0].atm;
    const gl=v.renderer.getContext();
    let compared=0;
    for (const pitch of [-0.002,0,0.002]) {
      v.cameraController.controls.target.set(c.position.x+pitch,0,10);
      c.lookAt(v.cameraController.controls.target); c.updateMatrixWorld(true);
      const read = visible => {
        a.visible=visible; v.renderFrame();
        const p=new Uint8Array(768*512*4); gl.readPixels(0,0,768,512,gl.RGBA,gl.UNSIGNED_BYTE,p); return p;
      };
      const reference=read(false), extinction=read(true);
      for (let y=220;y<292;y++) for(let x=360;x<408;x++) {
        const i=(y*768+x)*4;
        if (reference[i]>100) { compared++; if (Math.abs(reference[i]-extinction[i])>2)
          throw new Error(`Reference atmosphere clipped a rendered solar ray at ${x},${y}`); }
        else if (extinction[i]>100) throw new Error('Sun escaped the rendered planet depth');
      }
    }
    window.solarViewer=v;
    return { compared };
  });
  console.log('Rendered horizon regression:',horizon);
  assert.ok(horizon.compared>300,'horizon regression must sample visible photosphere rays');
  await page.screenshot({path:'work/sun-rendering/viewer-horizon-depth.png'});
  const titan = await page.evaluate(async () => {
    const { Universe, UniverseRenderer } = await import('/bundle.js');
    window.solarViewer.dispose();
    const results=[];
    for (const au of [1,9.5]) {
      const u=new Universe();
      u.loadCatalog({name:'Titan orbital haze',items:[
        {name:'Titan',class:'planet',trajectory:{type:'FixedPoint',position:[0,0,0]},
          geometry:{type:'Globe',radius:2575,atmosphere:'Titan'}},
        {name:'Sun',class:'star',trajectory:{type:'FixedPoint',position:[0,0,149597870*au]},
          geometry:{type:'Globe',radius:695000}},
      ]});
      const v=new UniverseRenderer(document.querySelector('canvas'),u,{scaleFactor:0.001,
        minBodyPixels:0,showStars:false,showLabels:false,showTrajectories:false});
      v.timeController.pause(); v.cameraController.controls.enableDamping=false;
      // Black surface isolates scattered haze from normalized surface lighting.
      v.getBodyMesh('Titan').mesh.material.color.set(0);
      const c=v.camera, gl=v.renderer.getContext();
      const views={};
      for(const side of ['front','back']) {
        c.position.set(0,0,7.725*(side==='front'?1:-1)); c.up.set(0,1,0);
        v.cameraController.controls.target.set(0,0,0); c.lookAt(0,0,0); c.updateMatrixWorld(true); v.renderFrame();
        const p=new Uint8Array(768*512*4); gl.readPixels(0,0,768,512,gl.RGBA,gl.UNSIGNED_BYTE,p);
        const sum=[0,0,0]; let count=0;
        for(let y=70;y<442;y++) for(let x=198;x<570;x++) {
          const radius=Math.hypot(x-384,y-256);
          if(side==='front' ? radius>70 : radius<156||radius>166) continue;
          const i=(y*768+x)*4; sum.forEach((_,j)=>sum[j]+=p[i+j]); count++;
        }
        views[side]=sum.map(v=>v/count);
      }
      const a=[...v.atmosphereMeshes.values()][0].atm;
      results.push({au,...views,irradiance:a.material.uniforms.lightColor.value.x,
        exposure:a.material.uniforms.uSolarExposure.value});
      v.dispose();
    }
    return results;
  });
  console.log('Titan orbital haze:',titan);
  assert.ok(titan[1].front[0]>15,'Titan front haze must remain visible at Saturn distance');
  assert.ok(titan[1].back[0]>8,'Titan backlit limb must remain visible at Saturn distance');
  for(const view of ['front','back']) titan[0][view].forEach((v,i)=>
    assert.ok(Math.abs(v-titan[1][view][i])<3,'shared exposure must preserve outer-system haze presentation'));
  assert.ok(titan[0].irradiance/titan[1].irradiance>80,'physical irradiance must still dim with distance');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Production solar/atmosphere/surface-tile GPU integration passed.');
} finally { await browser.close(); }
