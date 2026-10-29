#!/usr/bin/env node
/** Production UniverseRenderer displaced-ridge disk/source/glare regression.
 * npm run build && CHROMIUM_PATH=/usr/bin/chromium node scripts/test-sun-terrain-gpu.mjs
 * Asset fixtures are self-contained; timings use software WebGL, not hardware estimates.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ stdin: { contents: `
  export * as THREE from 'three';
  export { Universe } from './packages/core/dist/Universe.js';
  export { UniverseRenderer } from './packages/three/dist/UniverseRenderer.js';
  export { wrapFadeMaterial } from './node_modules/3d-tiles-renderer/src/three/plugins/fade/wrapFadeMaterial.js';
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
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:0;background:black}canvas{width:768px;height:512px}</style><canvas></canvas>' });
  });
  await page.goto('http://solar-viewer.test/');
  const result = await page.evaluate(async () => {
    const { THREE, Universe, UniverseRenderer, wrapFadeMaterial } = await import('/bundle.js');
    const universe = new Universe();
    // Explicit synthetic ECLIPJ2000 -> body orientation, not mission SPICE.
    const site = { name: 'regression-site', url: '/site.json', sourceVersion: 'synthetic-v1',
      registration: { version: 'enu-v1', bodyFixedFrame: 'SYNTHETIC_FIXED', status: 'controlled',
        bodyFixedKmFromLocalMeters: [0,.001,0,0, 0,0,.001,0, .001,0,0,0, 1000,0,0,1],
        provenance: 'Synthetic ENU solar fixture only', uncertaintyKm: 0 },
      // Enclose the synthetic planet-scale ridge attached later in this fixture.
      coverage: { min: [-4000000,-4000000,-4000000], max: [4000000,4000000,4000000] },
      physicalQueryPolicy: 'visual-only', overlapPolicy: 'composite' };
    universe.loadCatalog({ name: 'displaced solar ridge', items: [
      { name: 'Moon', rotationModel: { type: 'Fixed', quaternion: [Math.SQRT1_2,Math.SQRT1_2,0,0], inertialFrame: 'ECLIPJ2000', bodyFixedFrame: 'SYNTHETIC_FIXED' }, class: 'moon', trajectory: { type: 'FixedPoint', position: [0,-2000,0] },
        geometry: { type: 'Globe', radius: 1000, surfaceTiles: [site] } },
      { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: [0,0,-100000] },
        geometry: { type: 'Globe', radius: 1000 } },
    ] });
    const viewer = new UniverseRenderer(document.querySelector('canvas'), universe, {
      scaleFactor: 0.001, minBodyPixels: 0, showStars: false, showLabels: false,
      showTrajectories: false, bloom: { enabled: true },
    });
    viewer.timeController.pause();
    viewer.cameraController.controls.enableDamping = false;
    // Two adjacent displaced tiles, sharing an edge at the solar center. The
    // globe lies below the ridge and cannot approximate its silhouette.
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: 0, side: THREE.DoubleSide });
    for (const x of [-1, 1]) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 4), material);
      mesh.position.set(x, -2, 0); group.add(mesh);
    }
    viewer.scene.add(group);
    const moon = viewer.getBodyMesh('Moon');
    const overlay = moon.getSurfaceOverlays()[0];
    let mode = 'main', height = 0;
    function pose(fov = 20) {
      const c = viewer.camera;
      c.position.set(0,0,10); c.up.set(0,1,0); c.fov = fov;
      viewer.cameraController.controls.target.set(0,0,-100);
      c.lookAt(0,0,-100); c.updateProjectionMatrix(); c.updateMatrixWorld(true);
      if(mode === 'camera-relative') {
        moon.updateSurfaceTileTransforms();
        // Author the ridge in world coordinates. The viewer applies/restores CRR.
        const desired = new THREE.Matrix4().makeTranslation(0,height,0);
        group.matrix.copy(overlay.group.matrixWorld).invert().multiply(desired);
      } else group.position.y = height;
    }
    const gl = viewer.renderer.getContext();
    const pixels = new Uint8Array(768*512*4);
    const energy = target => {
      const data = new Uint16Array(target.width*target.height*4);
      viewer.renderer.readRenderTargetPixels(target,0,0,target.width,target.height,data);
      let sum = 0, count = 0;
      for(let i=0;i<data.length;i+=4) {
        const value = THREE.DataUtils.fromHalfFloat(data[i]);
        sum += value; if(value>0) count++;
      }
      return {sum,count};
    };
    for(let i=0;i<80;i++) {
      viewer.camera.position.set(1.001,-2,0);
      viewer.camera.up.set(1,0,0);
      viewer.cameraController.controls.target.set(1.001,-2,10);
      viewer.camera.lookAt(1.001,-2,10); viewer.camera.updateMatrixWorld(true);
      viewer.renderFrame();
      await new Promise(requestAnimationFrame);
    }
    let loaded = 0;
    overlay.group.traverse(obj => {
      if(obj.isMesh) { loaded++; obj.geometry.setDrawRange(0,0); }
    });
    const captures = {};
    const rows = [];
    for (mode of ['main','camera-relative']) {
      if(mode === 'camera-relative') {
        overlay.group.add(group); group.matrixAutoUpdate = false;
      }
      for (const bloom of [false,true]) {
        viewer.bloomEffect.enabled = bloom;
        for (const fraction of [-2,-0.404,0,0.404,1,1.1,-2,1.1]) {
          height = fraction * 10/110;
          pose(); viewer.renderFrame();
          gl.readPixels(0,0,768,512,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
          let display = 0, leaked = 0;
          const boundary = 256 + height/10 / Math.tan(THREE.MathUtils.degToRad(10))*256;
          for(let y=0;y<512;y++) for(let x=0;x<768;x++) {
            const i=(y*768+x)*4;
            if(pixels[i]>100) { display++; if(y+1<boundary) leaked++; }
          }
          rows.push({mode,bloom,fraction,display,leaked,source:bloom?energy(viewer.sunGlareEffect.target):null});
          if(fraction === 0 || fraction === 1.1) captures[`${mode}-${bloom?'glare':'disk'}-${fraction===0?'half':'hidden'}`] = viewer.renderer.domElement.toDataURL();
        }
      }
    }
    // Equivalent coarse/fine residency and an entirely absent ridge: no proxy
    // may outlive the selected display geometry or reintroduce a fallback globe.
    const lod = [];
    mode = 'main'; viewer.scene.add(group); group.matrixAutoUpdate = true;
    height = 0;
    for(const fine of [true,false,true]) {
      group.children.forEach(child => child.visible = fine);
      const coarse = new THREE.Mesh(new THREE.PlaneGeometry(4,4),material);
      coarse.position.y = -2; coarse.visible = !fine; group.add(coarse);
      pose(); viewer.renderFrame(); lod.push(energy(viewer.sunGlareEffect.target).sum);
      group.remove(coarse); coarse.geometry.dispose();
    }
    group.children.forEach(child => child.visible = true);
    const fade = wrapFadeMaterial(material,material.onBeforeCompile);
    material.defines.FEATURE_FADE = 1; material.needsUpdate = true;
    height = 1.2 * 10/110;
    const fades = [];
    for(const value of [0,0.5,1,0,1]) {
      fade.fadeIn.value = value;
      pose(); viewer.renderFrame(); fades.push(energy(viewer.sunGlareEffect.target).sum);
    }
    material.defines.FEATURE_FADE = 0; material.needsUpdate = true;
    const residency = [];
    for(const visible of [false,true]) {
      group.visible = visible; pose(); viewer.renderFrame();
      residency.push(energy(viewer.sunGlareEffect.target).sum);
    }
    // Unresolved sources expand their optical footprint. A narrow blocker must
    // still cover the physical rays, including after a repeated FOV/time seek.
    mode = 'main'; viewer.scene.add(group); group.matrixAutoUpdate = true;
    const unresolved = [];
    for(const fov of [80,140,170,20,170]) {
      height = 1.2 * 10/110;
      pose(fov); viewer.timeController.setTime(viewer.timeController.et + 100);
      viewer.renderFrame();
      unresolved.push({fov,source:energy(viewer.sunGlareEffect.target), point:energy(viewer.sunGlareEffect.signalTarget)});
    }
    window.ridgeViewer=viewer;
    return {loaded,rows,lod,fades,residency,unresolved,captures};
  });
  mkdirSync('work/sun-rendering',{recursive:true});
  for(const [name,url] of Object.entries(result.captures)) writeFileSync(`work/sun-rendering/ridge-${name}.png`,Buffer.from(url.split(',')[1],'base64'));
  delete result.captures;
  console.log(JSON.stringify(result,null,2));
  assert.ok(result.loaded>0,'real surface tile fixture must load');
  assert.equal(errors.length,0,errors.join('\n'));
  for(const row of result.rows) {
    if(!row.bloom) assert.equal(row.leaked,0,'display disk must match the displaced ridge');
    if(row.fraction>1) {
      assert.equal(row.display,0,'hidden Sun must leave no display/glare pixels');
      if(row.source) assert.equal(row.source.sum,0,'hidden Sun must produce exactly zero HDR source');
    }
  }
  const sources=result.rows.filter(r=>r.bloom).slice(0,5).map(r=>r.source.sum);
  assert.ok(sources[0]>sources[1] && sources[1]>sources[2] && sources[2]>sources[3] && sources[3]>sources[4],
    'visible photospheric energy must fall smoothly through partial occultation');
  assert.ok(result.lod.every(v=>Math.abs(v-result.lod[0])<1),'equivalent LODs must preserve solar energy');
  assert.ok(result.fades[0]>100 && result.fades[1]>0 && result.fades[1]<result.fades[0],
    'the real tile fade shader must retain its discard mask in the optical pass');
  assert.equal(result.fades[2],0,'fully opaque ridge must block the Sun after fading');
  assert.equal(result.fades[4],0,'repeated fades must not leave stale source');
  assert.ok(result.residency[0]>100 && result.residency[1]===0,'hidden terrain must not leave an optical proxy');
  for(const row of result.unresolved) {
    assert.equal(row.source.sum,0,'FOV/time changes must not reveal occulted optical source');
    assert.equal(row.point.sum,0,'hidden unresolved Sun must contribute zero point energy');
  }
  mkdirSync('work/sun-rendering',{recursive:true});
  await page.screenshot({path:'work/sun-rendering/ridge-hidden.png'});
  const globes = await page.evaluate(async () => {
    const { THREE, Universe, UniverseRenderer } = await import('/bundle.js');
    window.ridgeViewer.dispose();
    const results = [];
    for (const test of [
      { name: 'outward', x: 650, scale: 400, bias: 0, texel: 255 },
      { name: 'grazing', x: 800, scale: 400, bias: 0, texel: 255 },
      { name: 'clear', x: 950, scale: 400, bias: 0, texel: 255 },
      { name: 'negative-scale', x: 650, scale: -400, bias: 400, texel: 0 },
      { name: 'negative-bias', x: 250, scale: 0, bias: -300, texel: 255 },
    ]) {
      const u = new Universe();
      u.loadCatalog({ name: test.name, items: [
        { name: 'Moon', class: 'moon', trajectory: { type: 'FixedPoint', position: [test.x,0,0] },
          geometry: { type: 'Globe', radius: 400 } },
        { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: [0,0,-100000] },
          geometry: { type: 'Globe', radius: 1000 } },
      ] });
      const v = new UniverseRenderer(document.querySelector('canvas'), u, {
        scaleFactor: 0.001, minBodyPixels: 0, showStars: false, showLabels: false,
        showTrajectories: false, bloom: { enabled: true },
      });
      v.timeController.pause(); v.cameraController.controls.enableDamping = false;
      const mesh = v.getBodyMesh('Moon').mesh, mat = mesh.material;
      // Actual production globe material, GPU vertex displacement and sphere
      // tessellation; no CPU displacement or geometry bound inflation in fixture.
      const texture = new THREE.DataTexture(new Uint8Array([test.texel,test.texel,test.texel,255]),1,1);
      texture.needsUpdate = true;
      mat.color.set(0); mat.displacementMap = texture;
      mat.displacementScale = test.scale; mat.displacementBias = test.bias; mat.needsUpdate = true;
      const read = () => {
        const target = v.sunGlareEffect.target;
        const p = new Uint16Array(target.width*target.height*4);
        v.renderer.readRenderTargetPixels(target,0,0,target.width,target.height,p);
        let total = 0;
        for(let i=0;i<p.length;i+=4) total += THREE.DataUtils.fromHalfFloat(p[i]);
        return total;
      };
      const render = (fov) => {
        const c = v.camera; c.position.set(0,0,10); c.up.set(0,1,0); c.fov = fov;
        v.cameraController.controls.target.set(0,0,-100); c.lookAt(0,0,-100);
        c.updateProjectionMatrix(); c.updateMatrixWorld(true); v.renderFrame();
      };
      const measurements = [];
      for(const fov of [20,170]) {
        mesh.visible = false; render(fov); const clear = read();
        mesh.visible = true; render(fov); const source = read();
        measurements.push({fov,clear,source,ratio:source/clear});
      }
      let live = null;
      if(test.name === 'outward') {
        mat.displacementScale = 0; // A uniform edit, without needsUpdate/version.
        render(20); live = read();
      }
      results.push({name:test.name,measurements,live});
      v.dispose();
    }
    return results;
  });
  console.log('Displacement-mapped globe regression:',JSON.stringify(globes,null,2));
  assert.equal(errors.length,0,errors.join('\n'));
  for(const row of globes) for(const m of row.measurements) {
    if(['outward','negative-scale'].includes(row.name)) assert.equal(m.source,0,'outward relief must occlude even outside nominal sphere bounds');
    if(['clear','negative-bias'].includes(row.name)) assert.ok(m.ratio>0.98,'nominal spherical horizon must not mask displaced valleys');
    if(row.name==='grazing' && m.fov===20) assert.ok(m.ratio>0.35 && m.ratio<0.65,'grazing relief must partially occlude the solar disk');
  }
  assert.ok(globes[0].live>0.98*globes[0].measurements[0].clear,'live displacement uniforms must update the cached optical material');
  console.log('Production displaced-ridge solar GPU regression passed.');
} finally { await browser.close(); }
