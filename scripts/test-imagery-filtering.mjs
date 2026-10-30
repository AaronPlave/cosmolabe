/** Physical-GPU, same-resident-page filtering comparison over actual missions. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'work/moonfall-jank/filtering';
const expectDefault = process.argv.includes('--expect-default');
const wide = process.argv.includes('--wide');
const history = process.argv.includes('--history');
const assertRecovery = process.argv.includes('--assert-recovery');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  args: ['--enable-gpu', '--ignore-gpu-blocklist', process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader'],
});
const result = { errors: [], views: [], passed: false };
const page = await browser.newPage(process.argv.includes('--hidpi') ? { viewport: { width: 1876, height: 1080 }, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } });
page.on('pageerror', e => result.errors.push(e.message));
page.on('console', m => { if (/GL_INVALID|INVALID_OPERATION|Shader Error/.test(m.text())) result.errors.push(m.text()); });
async function capture(body, anisotropy) {
  const frame = await page.evaluate(async ({ body, anisotropy }) => {
    const r = window.renderer, wr = r.getContext().webglRenderer, l = r.getBodyMesh(body).terrainManager.cubeImageryLayer;
    const gl = wr.getContext(), ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (!ext) throw Error('Anisotropy extension required for filtering acceptance');
    // A/B only: changing Texture.needsUpdate would allocate a new empty array.
    // Keep the same page storage and set only its sampler state on the GPU.
    wr.state.bindTexture(gl.TEXTURE_2D_ARRAY, wr.properties.get(l.pages.array).__webglTexture);
    const configured = gl.getTexParameter(gl.TEXTURE_2D_ARRAY, ext.TEXTURE_MAX_ANISOTROPY_EXT);
    gl.texParameterf(gl.TEXTURE_2D_ARRAY, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(anisotropy, wr.capabilities.getMaxAnisotropy()));
    const effective = gl.getTexParameter(gl.TEXTURE_2D_ARRAY, ext.TEXTURE_MAX_ANISOTROPY_EXT);
    wr.state.unbindTexture(); r.renderFrame();
    const frameIntervalsMs = []; let previous;
    for (let n = 0; n < 31; n++) {
      await new Promise(requestAnimationFrame); const now = performance.now();
      if (previous !== undefined) frameIntervalsMs.push(now - previous); previous = now;
    }
    frameIntervalsMs.sort((a,b) => a-b);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return { image: wr.domElement.toDataURL(), effective, configured, maximumAnisotropy: wr.capabilities.getMaxAnisotropy(), gpu: gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
      frameIntervalMs: { samples: frameIntervalsMs.length, p50: frameIntervalsMs[15], p95: frameIntervalsMs[28], maximum: frameIntervalsMs.at(-1) },
      stats: l.stats, sample: l.sampleAt(window.filteringPoint).map(({ texture, ...s }) => s), slots: [...l.pages.slots], error: gl.getError() };
  }, { body, anisotropy });
  const image = Buffer.from(frame.image.split(',')[1], 'base64'); delete frame.image;
  return { frame, image };
}
try {
  for (const [catalog, body, lat, lon, distances] of history ? [
    ['moonfall-shackleton', 'Moon', -90, 0, [2, 10, 2, 40, 2, 100, 2, 200, 60]],
  ] : wide ? [
    ['moonfall-shackleton', 'Moon', -90, 0, [200, 400]],
  ] : [
    ['moonfall-shackleton', 'Moon', -89.67, 129.78, [2, 20, 60]],
    ['ingenuity-jezero', 'Mars', 18.44486301, 77.45101915, [20]],
  ]) {
    await page.goto(`${base}?catalog=test-catalogs/${catalog}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(body => window.renderer?.getBodyMesh(body)?.terrainManager?.cubeImageryStats?.version, body, { timeout: 120000 });
    await page.evaluate(async () => { await window.renderer.waitForInitialAssets(); window.cosmo.setPlaying(false); window.cosmo.untrack(); });
    let viewIndex = 0;
    for (const distance of distances) for (const angle of history ? [0, 1.45] : wide ? [0, .6] : [0, 1.15]) {
      await page.evaluate(async ({ body, lat, lon, distance, angle }) => {
        if (body === 'Moon' && distance === 2) { lat = -89.98; lon = 120; }
        const r = window.renderer, b = r.getBodyMesh(body), t = b.terrainManager, V = r.camera.position.constructor;
        const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
        const d = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
        const outer = t.bodyRadiusKm + 50;
        const ray = { origin: { xKm: d[0] * outer, yKm: d[1] * outer, zKm: d[2] * outer }, direction: d.map(v => -v), nearKm: 0, farKm: 150 };
        await t.cube.surface.ensureRayCoverage(ray, { maxMeshErrorKm: 0 }, AbortSignal.timeout(30000));
        const hit = b.intersectTerrainRay(ray, { maxMeshErrorKm: 0 });
        if (hit?.kind !== 'hit') throw Error('No physical surface');
        const centre = new V(); b.getWorldPosition(centre);
        const world = ([x,y,z]) => new V(x,z,-y).applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
        const p = [hit.position.xKm,hit.position.yKm,hit.position.zKm], target = world(p);
        const up = world([-Math.sin(la)*Math.cos(lo),-Math.sin(la)*Math.sin(lo),Math.cos(la)]).sub(centre).normalize();
        const normal = world(d).sub(centre).normalize(), cc = r.cameraController;
        cc.controls.staticMoving = true; cc.controls.target.copy(target);
        r.camera.position.copy(target).addScaledVector(normal, distance*r.scaleFactor*Math.cos(angle)).addScaledVector(up,distance*r.scaleFactor*Math.sin(angle));
        r.camera.up.copy(up); r.camera.fov=50;r.camera.updateProjectionMatrix();r.camera.lookAt(target);r.camera.updateMatrixWorld(true);
        window.filteringPoint = p;t.setDebugMode('imagery-unlit');
      }, { body, lat, lon, distance, angle });
      try {
        await page.waitForFunction(body => {
          const t=window.renderer.getBodyMesh(body).terrainManager,n=t.metrics.network,i=t.cubeImageryStats;
          return t.tiles.visibleTiles.size>0&&n.queued+n.downloading+n.parsing===0&&i.inFlight===0&&(i.queued===0||i.budgetLimited);
        }, body, { timeout: history ? 30000 : 180000 });
        if (assertRecovery) await page.evaluate(async body => {
          const t=window.renderer.getBodyMesh(body).terrainManager,deadline=performance.now()+30000;
          let quiet=0;
          while(quiet<30){
            await new Promise(requestAnimationFrame);const n=t.metrics.network,i=t.cubeImageryStats;
            quiet=n.queued+n.downloading+n.parsing===0&&i.inFlight===0&&i.queued===0&&i.waitingGroups===0&&!i.budgetLimited?quiet+1:0;
            if(performance.now()>deadline)throw Error('Native imagery recovery did not become quiescent');
          }
        },body);
      } catch (error) {
        const state=await page.evaluate(body=>{const t=window.renderer.getBodyMesh(body).terrainManager,l=t.cubeImageryLayer;return {imagery:l.stats,network:t.metrics.network,reserved:[...l.reserved],entries:[...l.entries.values()].map(e=>({id:e.id,state:e.state,pinned:e.pinned})),covers:l.sources.map(s=>s.cover)};},body);
        await writeFile(`${out}/settle-failure.json`,JSON.stringify({body,distance,angle,...state},null,2));throw error;
      }
      await page.waitForTimeout(700);
      const before = await capture(body, history ? 8 : 1), after = history ? before : await capture(body, 8);
      const key = `${history ? `${viewIndex++}-` : ''}${body}-${distance}-${angle ? 'oblique' : 'nadir'}`;
      await writeFile(`${out}/${key}-1x.png`, before.image); await writeFile(`${out}/${key}-8x.png`, after.image);
      const crop = { left: 400, top: 100, width: 640, height: 240 };
      const pixels = async buffer => sharp(buffer).extract(crop).greyscale().raw().toBuffer();
      const a = await pixels(before.image), b = await pixels(after.image);
      const energy = p => { let sum=0;for(let y=1;y<crop.height-1;y++)for(let x=1;x<crop.width-1;x++){const k=y*crop.width+x;sum+=(p[k+1]-p[k-1])**2+(p[k+crop.width]-p[k-crop.width])**2;}return sum/((crop.width-2)*(crop.height-2)); };
      const row = { key, body, distanceKm: distance, angleRad: angle, before: before.frame, after: after.frame,
        crop, gradientEnergy: { before: energy(a), after: energy(b) }, meanAbsolutePixelDifference: a.reduce((sum,v,k)=>sum+Math.abs(v-b[k]),0)/a.length };
      if (wide || history) {
        row.viewport = await page.evaluate(async ({ root, body }) => {
          const { directionToTexel } = await import(`/@fs/${root}/packages/three/src/surface/CubeImagery.ts`);
          const r=window.renderer,t=r.getBodyMesh(body).terrainManager,l=t.cubeImageryLayer;
          t.setDebugMode('imagery-level');r.renderFrame();
          const gl=r.getContext().webglRenderer.getContext(),points=[];
          for(const y of [-.7,-.35,0,.35,.7])for(const x of [-.8,-.4,0,.4,.8]){
            const px=Math.floor((x+1)*gl.drawingBufferWidth/2),py=Math.floor((y+1)*gl.drawingBufferHeight/2);
            const hit=r._discoverSurface(2*(px+.5)/gl.drawingBufferWidth-1,2*(py+.5)/gl.drawingBufferHeight-1,false);if(!hit||hit.point.bodyName!==body)continue;
            const p=hit.point.bodyFixedPositionKm,address=directionToTexel(p,30,1,0).address;
            const contains=a=>a.face===address.face&&Math.floor(address.x/2**(30-a.level))===a.x&&Math.floor(address.y/2**(30-a.level))===a.y;
            const wanted=(l.selectionCache.get(0)??[]).filter(contains).sort((a,b)=>b.level-a.level)[0];
            const displayed=l.sampleAt(p).map(({texture,...s})=>s);
            const pixel=new Uint8Array(4);gl.readPixels(px,py,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
            const norm=a=>{const length=Math.hypot(...a);return a.map(v=>v/(length||1));},rgb=norm([...pixel].slice(0,3));
            const palette=Array.from({length:14},(_,level)=>{const c=norm([0,2,4].map(v=>.5+.5*Math.cos(2*Math.PI*(level*.137+v/3))));return {level,error:Math.hypot(...c.map((v,k)=>v-rgb[k]))};}).sort((a,b)=>a.error-b.error);
            points.push({x,y,lat:hit.point.latDeg,lon:hit.point.lonDeg,address,wanted,displayed,pixel:[...pixel],gpuLevel:palette[0]});
          }
          return points;
        }, { root: resolve('.'), body });
        await writeFile(`${out}/${key}-levels.png`,await page.locator('canvas').first().screenshot());
        if (assertRecovery) {
          assert.ok(row.viewport.length>=10,`${key}: insufficient visible terrain samples`);
          const gaps=row.viewport.filter(p=>p.wanted&&p.wanted.level>p.displayed[0].level+1);
          assert.deepEqual(gaps,[],`${key}: stuck coarse pages after camera history`);
          for(const p of row.viewport) assert.equal(p.gpuLevel.level,p.displayed[0].level,`${key}: GPU imagery level disagrees with committed cover`);
          assert.equal(after.frame.stats.budgetLimited,false,`${key}: default mission working set is undersized`);
          assert.equal(after.frame.stats.queued,0,`${key}: settled work remains queued`);
          row.quietChurn = await page.evaluate(async body=>{
            const l=window.renderer.getBodyMesh(body).terrainManager.cubeImageryLayer,a=l.stats;
            for(let n=0;n<60;n++)await new Promise(requestAnimationFrame);
            const b=l.stats;return {requests:b.requests-a.requests,evicted:b.evicted-a.evicted,aborted:b.aborted-a.aborted};
          },body);
          assert.deepEqual(row.quietChurn,{requests:0,evicted:0,aborted:0},`${key}: stationary recovery thrashes`);
        }
      }
      assert.deepEqual(before.frame.slots, after.frame.slots, 'Filtering changed resident pages');
      assert.equal(before.frame.stats.baseUncoveredBlocks, 0);assert.equal(after.frame.stats.baseUncoveredBlocks, 0);
      assert.equal(before.frame.error,0);assert.equal(after.frame.error,0);
      assert.doesNotMatch(after.frame.gpu,/SwiftShader|llvmpipe/i);
      if (expectDefault && distance === distances[0] && angle === 0) assert.equal(before.frame.configured, Math.min(8, before.frame.maximumAnisotropy), 'Production texture array lost anisotropic filtering');
      result.views.push(row);
      await writeFile(`${out}/metrics.json`,JSON.stringify(result,null,2)+'\n');
      console.log(key, JSON.stringify({sample:after.frame.sample,energy:row.gradientEnergy,difference:row.meanAbsolutePixelDifference}));
    }
  }
  result.analyticFixture = await page.evaluate(() => {
    // A known signal, not fabricated mission imagery: vertical four-texel
    // stripes, minified 2x horizontally and 16x vertically. Integrating each
    // pixel's footprint must preserve stripes; isotropic mip selection blurs
    // them even though they are constant along the long footprint axis.
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const gl = canvas.getContext('webgl2', { antialias: false });
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s,source); gl.compileShader(s); if (!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s)); return s; };
    const program = gl.createProgram();
    gl.attachShader(program,shader(gl.VERTEX_SHADER,`#version 300 es
      void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}`));
    gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`#version 300 es
      precision highp float;precision highp sampler2DArray;uniform sampler2DArray image;uniform float vertical;out vec4 color;
      void main(){vec2 uv=vec2(gl_FragCoord.x/128.0,fract(gl_FragCoord.y/vertical));color=textureGrad(image,vec3(uv,0.0),vec2(1.0/128.0,0.0),vec2(0.0,1.0/vertical));}`));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);
    const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D_ARRAY,texture);gl.texStorage3D(gl.TEXTURE_2D_ARRAY,9,gl.RGBA8,256,256,1);
    const data=new Uint8Array(256*256*4);for(let y=0;y<256;y++)for(let x=0;x<256;x++){const k=(y*256+x)*4,v=(Math.floor(x/4)%2)*255;data.set([v,v,v,255],k);}
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,0,256,256,1,gl.RGBA,gl.UNSIGNED_BYTE,data);gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    const render=(anisotropy,vertical)=>{gl.texParameterf(gl.TEXTURE_2D_ARRAY,ext.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(anisotropy,gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));gl.uniform1f(gl.getUniformLocation(program,'vertical'),vertical);gl.drawArrays(gl.TRIANGLES,0,3);const p=new Uint8Array(128*128*4);gl.readPixels(0,0,128,128,gl.RGBA,gl.UNSIGNED_BYTE,p);let error=0;for(let y=0;y<128;y++)for(let x=0;x<128;x++)error+=Math.abs(p[(y*128+x)*4]-(Math.floor(x/2)%2)*255);return error/(128*128);};
    const fixture={isotropicObliqueError:render(1,16),anisotropicObliqueError:render(8,16),isotropicNadirError:render(1,128),anisotropicNadirError:render(8,128),glError:gl.getError()};
    gl.deleteTexture(texture);gl.deleteProgram(program);return fixture;
  });
  assert.equal(result.analyticFixture.glError,0);
  assert.ok(result.analyticFixture.anisotropicObliqueError < result.analyticFixture.isotropicObliqueError * .25, 'Filtering does not preserve the known oblique signal');
  assert.ok(Math.abs(result.analyticFixture.isotropicNadirError-result.analyticFixture.anisotropicNadirError)<1, 'Filtering changed an isotropic control');
  assert.deepEqual(result.errors, []); result.passed = true;
} finally {
  await writeFile(`${out}/metrics.json`,JSON.stringify(result,null,2)+'\n');await browser.close();
}
