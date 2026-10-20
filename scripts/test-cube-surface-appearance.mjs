/** Real cube product acceptance; uses existing built terrain + imagery, no test mode.
 * Start this checkout's viewer, then:
 * CUBE_STYLE_URL=http://127.0.0.1:5196 node scripts/test-cube-surface-appearance.mjs
 * CUBE_STYLE_CATALOGS=test-catalogs/moonfall-shackleton (optional single catalog).
 * CUBE_STYLE_BASELINE_ONLY=1 captures ordinary imagery on main or the PR.
 * CUBE_STYLE_LEGACY_CONTROL=1 also compares the old normal blend with a fixed cache (PR only).
 * CUBE_STYLE_CPU_RATE=4 adds DevTools CPU throttling to activation only (not a physical device).
 * CUBE_STYLE_ACTIVATION_ONLY=1 profiles first-use CPU/GPU frames; CUBE_STYLE_NAV_ONLY=1 checks camera history.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
const base = process.env.CUBE_STYLE_URL ?? 'http://127.0.0.1:5196';
const out = process.env.CUBE_STYLE_OUT ?? 'work/cube-surface-appearance';
const catalogs = (process.env.CUBE_STYLE_CATALOGS ?? 'test-catalogs/experiments/moon-terrain-cube-imagery-nac,test-catalogs/moonfall-shackleton').split(',');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'vulkan'}`, '--ignore-gpu-blocklist', '--enable-gpu'] });
const results = [];
const at = (lat, lon, height) => { const a = lat * Math.PI / 180, b = lon * Math.PI / 180, r = 1737.4 + height; return [r * Math.cos(a) * Math.cos(b), r * Math.cos(a) * Math.sin(b), r * Math.sin(a)]; };
const poses = {
  close: { eye: at(-89.07, 129.78, 6), target: at(-89.67, 129.78, -2.5), fov: 60 },
  far: { eye: at(-80, 20, 450), target: at(-90, 0, 0), fov: 50 },
};
async function pose(page, view) {
  await page.evaluate(view => {
    const r = window.renderer, bm = r.getBodyMesh('Moon'), V = r.camera.position.constructor;
    window.cosmo.setPlaying(false); window.cosmo.untrack();
    const centre = new V(); bm.getWorldPosition(centre);
    const toWorld = ([x, y, z]) => new V(x, z, -y).applyQuaternion(bm.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
    const eye = toWorld(view.eye), target = toWorld(view.target), c = r.camera, controls = r.cameraController.controls;
    controls.enableDamping = false; c.fov = view.fov; c.updateProjectionMatrix();
    c.position.copy(eye); c.up.copy(eye.clone().sub(centre).normalize()); controls.target.copy(target); c.lookAt(target); c.updateMatrixWorld(true);
  }, view);
}
async function settle(page) {
  await page.waitForFunction(() => {
    const tm = window.renderer.getBodyMesh('Moon').terrainManager, n = tm.metrics.network, i = tm.cubeImageryStats;
    return tm.tiles.visibleTiles.size > 0 && n.queued + n.downloading + n.parsing === 0 && i?.queued === 0 && i?.inFlight === 0;
  }, null, { timeout: 120000 });
  await page.waitForTimeout(1200);
}
async function snapshot(page) {
  return page.evaluate(() => {
    const r = window.renderer, bm = r.getBodyMesh('Moon'), tm = bm.terrainManager;
    const ids = [...tm.tiles.visibleTiles].map(t => t.content?.uri).sort();
    let sourceVertices = 0, sampled = 0, maxHeightErrorKm = 0, styled = 0;
    for (const [mesh, entry] of tm.surfaceStyle.meshes) {
      if (entry.derived) continue;
      sourceVertices += mesh.geometry.getAttribute('position').count;
      const h = mesh.geometry.getAttribute('surfaceHeightKm');
      if (!h) continue; styled++;
      const p = mesh.geometry.getAttribute('position'), v = r.camera.position.clone();
      for (let i = 0; i < p.count; i += Math.max(1, Math.floor(p.count / 11))) {
        v.fromBufferAttribute(p, i).applyMatrix4(entry.matrix);
        maxHeightErrorKm = Math.max(maxHeightErrorKm, Math.abs(h.getX(i) - (v.length() * 0.001 - 1737.4))); sampled++;
      }
    }
    return { ids, sourceVertices, sampled, styled, maxHeightErrorKm, terrain: tm.metrics, imagery: tm.cubeImageryStats, grids: tm.cubeStats, styleMeshes: tm.surfaceStyle.meshes.size };
  });
}
async function timing(page) {
  return page.evaluate(async () => {
    const r = window.renderer, gl = r.getContext().webglRenderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const frame = r.renderFrame, queries = [], cpu = [], styleCpu = [], style = r.getBodyMesh('Moon').terrainManager.surfaceStyle, update = style.update;
    style.update = function (...args) { const result = update.apply(this, args); styleCpu.push(result.elapsedMs); return result; };
    r.renderFrame = function (...args) {
      const q = ext ? gl.createQuery() : null, start = performance.now();
      if(q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      frame.apply(this, args);
      if(q) { gl.endQuery(ext.TIME_ELAPSED_EXT); queries.push(q); }
      cpu.push(performance.now() - start);
    };
    try { for(let i = 0; i < 60; i++) await new Promise(requestAnimationFrame); }
    finally { r.renderFrame = frame; style.update = update; }
    const gpu = [];
    for(let tries = 0; queries.length && tries < 100; tries++) {
      await new Promise(requestAnimationFrame);
      while(queries.length && gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)) { gpu.push(gl.getQueryParameter(queries[0], gl.QUERY_RESULT) / 1e6); gl.deleteQuery(queries.shift()); }
    }
    queries.forEach(q => gl.deleteQuery(q));
    const stats = xs => { const s = xs.sort((a,b) => a-b); return { n:s.length, median:s[s.length>>1] ?? null, p95:s[Math.floor(s.length * .95)] ?? null }; };
    return { cpuMs:stats(cpu), styleCpuMs:stats(styleCpu), gpuMs: ext && !gl.getParameter(ext.GPU_DISJOINT_EXT) ? stats(gpu) : null, gpuTimerAvailable:!!ext };
  });
}
async function activationTiming(page) {
  return page.evaluate(async () => {
    const r = window.renderer, bm = r.getBodyMesh('Moon'), style = bm.terrainManager.surfaceStyle;
    const gl = r.getContext().webglRenderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    r.stop(); r.timeController.pause();
    const update = style.update, imagery = bm.terrainManager.cubeImagery, imageryUpdate = imagery.update;
    const webgl = r.getContext().webglRenderer, render = webgl.render;
    let imageryMs = 0, renderMs = 0;
    imagery.update = function(...args) { const start = performance.now(); try { return imageryUpdate.apply(this,args); } finally { imageryMs += performance.now()-start; } };
    webgl.render = function(...args) { const start = performance.now(); try { return render.apply(this,args); } finally { renderMs += performance.now()-start; } };
    let preparation = null;
    style.update = function(...args) { preparation = update.apply(this,args); return preparation; };
    const frame = async () => {
      preparation = null; imageryMs = 0; renderMs = 0;
      const q = ext ? gl.createQuery() : null, start = performance.now();
      if(q) gl.beginQuery(ext.TIME_ELAPSED_EXT,q);
      r.renderFrame();
      if(q) gl.endQuery(ext.TIME_ELAPSED_EXT);
      const cpuMs = performance.now()-start;
      gl.finish();
      let gpuMs = null;
      if(q) {
        for(let i = 0; i < 100 && !gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE); i++) await new Promise(resolve => setTimeout(resolve,1));
        if(gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) gpuMs = gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6;
        gl.deleteQuery(q);
      }
      return {cpuMs,gpuMs,preparation,imageryMs,renderMs};
    };
    try {
      const normal = []; for(let i = 0; i < 30; i++) normal.push(await frame());
      const settings = style.current, activation = [];
      style.set({...settings,baseColor:'elevation',hillshade:true,imageryAmount:0});
      for(let i = 0; i < 160; i++) { const sample = await frame(); activation.push(sample); if(!sample.preparation?.meshes) break; }
      const active = []; for(let i = 0; i < 30; i++) active.push(await frame());
      style.set(settings);
      const disabled = []; for(let i = 0; i < 30; i++) disabled.push(await frame());
      return {normal,activation,active,disabled,gpuTimerAvailable:!!ext};
    } finally { style.update = update; imagery.update = imageryUpdate; webgl.render = render; r.start(); r.timeController.pause(); }
  });
}
async function canvas(page) {
  const data = await page.evaluate(() => { const r = window.renderer; r.renderFrame(); return r.getContext().webglRenderer.domElement.toDataURL(); });
  return PNG.sync.read(Buffer.from(data.split(',')[1], 'base64'));
}
try {
  for(const catalog of catalogs) {
    const name = catalog.includes('moonfall') ? 'moonfall' : 'nac';
    const page = await browser.newPage({ viewport:{width:1440,height:1000} });
    const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
    page.on('console', m => { if(m.type() === 'error') { errors.push(m.text()); console.error(m.text()); } });
    console.log(name,'loading',base);
    await page.goto(`${base}/?catalog=${catalog}`, {waitUntil:'domcontentloaded',timeout:120000});
    await page.waitForFunction(() => window.renderer, null, {timeout:120000});
    console.log(name,'renderer ready');
    const assets = await page.evaluate(() => window.renderer.waitForInitialAssets()); assert.equal(assets.failed,0); console.log(name,'assets ready');
    await page.evaluate(() => { window.cosmo.setPlaying(false); window.cosmo.select('Moon'); });
    if(!process.env.CUBE_STYLE_BASELINE_ONLY) await page.waitForFunction(() => window.renderer.getBodyMesh('Moon').surfaceAppearance !== null);
    if(name === 'nac') await page.evaluate(() => { window.renderer.getBodyMesh('Moon').terrainManager.tiles.maxDepth = 5; });
    const gpu = await page.evaluate(() => { const gl = window.renderer.getContext().webglRenderer.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER); });
    assert.ok(!/swiftshader|software/i.test(gpu));
    const row = {name,catalog,gpu,assets,views:{},errors}; results.push(row);
    if(process.env.CUBE_STYLE_BASELINE_ONLY) {
      // Both catalogs declare this epoch. Reset real-time drift before comparing
      // independent checkouts; use the actual physical Sun and ordinary imagery.
      assert.ok(await page.evaluate(() => window.cosmo.setTime({kind:'calendar',text:'2028-12-15T10:04:00Z'})));
      await page.evaluate(() => window.renderer.renderFrame());
      const sunLongitude = await page.evaluate(() => {
        const r = window.renderer, bm = r.getBodyMesh('Moon');
        const direction = r.sunLight.position.clone().sub(bm.getWorldPosition(r.camera.position.clone())).normalize().applyQuaternion(bm.mesh.quaternion.clone().invert());
        return Math.atan2(-direction.z,direction.x)*180/Math.PI;
      });
      const lit = {eye:at(-88.7,sunLongitude,12),target:at(-89.4,sunLongitude,-2.5),fov:60};
      row.sunLongitude = sunLongitude;
      for(const [view,position] of Object.entries({...poses,lit})) {
        await pose(page,position); await settle(page);
        const metadata = await page.evaluate(() => {
          const r = window.renderer, tm = r.getBodyMesh('Moon').terrainManager;
          const angles = [], centre = r.getBodyMesh('Moon').getWorldPosition(r.camera.position.clone());
          const point = centre.clone(), normal = centre.clone();
          for(const tile of tm.tiles.visibleTiles) tile.engineData?.scene?.traverse(mesh => {
            if(!mesh.isMesh || mesh.name.startsWith('cube-imagery-block ')) return;
            const p = mesh.geometry.getAttribute('position'), n = mesh.geometry.getAttribute('normal');
            if(!p || !n) return;
            const count = mesh.geometry.userData.surfaceTriangles*3 || mesh.geometry.index?.count || p.count;
            for(let i=0;i<count;i+=Math.max(1,Math.floor(count/64))) {
              const j=mesh.geometry.index?.getX(i)??i;
              point.fromBufferAttribute(p,j).applyMatrix4(mesh.matrixWorld).sub(centre).normalize();
              normal.fromBufferAttribute(n,j).transformDirection(mesh.matrixWorld);
              angles.push(Math.acos(Math.max(-1,Math.min(1,point.dot(normal))))*180/Math.PI);
            }
          });
          return {ids:[...tm.tiles.visibleTiles].map(t=>t.content?.uri).sort(),imagery:tm.cubeImageryStats,camera:[...r.camera.matrixWorld.elements],sunIntensity:r.sunLight.intensity,
            styleActive:tm.surfaceStyle?.active??false,et:r.timeController.et,sourceModules:performance.getEntriesByType('resource').map(x=>x.name).filter(x=>x.includes('/TerrainManager.ts')),
            normalSlopeDegrees:{samples:angles.length,mean:angles.reduce((s,x)=>s+x,0)/angles.length,max:Math.max(...angles)}};
        });
        assert.equal(metadata.styleActive,false); assert.equal(metadata.sunIntensity,2);
        row.views[view] = metadata;
        if(process.env.CUBE_STYLE_LEGACY_CONTROL) await page.evaluate(() => { window.baselineEpoch = window.renderer.timeController.et; window.renderer.stop(); });
        const png = await canvas(page); await writeFile(`${out}/${name}-${view}.png`,PNG.sync.write(png));
        if(process.env.CUBE_STYLE_LEGACY_CONTROL) {
          const cacheBefore = await page.evaluate(() => {
            const r = window.renderer, tm = r.getBodyMesh('Moon').terrainManager;
            window.baselineNormals = [...tm.cubeImagery.tiles.values()].flatMap(record => record.meshes.map(m => ({mesh:m.mesh,normals:m.mesh.geometry.getAttribute('normal').array.slice()})));
            for(const {mesh} of window.baselineNormals) tm.blendSphereNormals(mesh,0.6);
            tm.cubeImagery.invalidateBlocks();
            return {requests:tm.cubeImageryStats.requests,levels:tm.cubeImageryStats.displayedLevels};
          });
          const legacy = await canvas(page);
          await writeFile(`${out}/${name}-${view}-legacy-control.png`,PNG.sync.write(legacy));
          await page.evaluate(() => {
            const tm = window.renderer.getBodyMesh('Moon').terrainManager;
            for(const {mesh,normals} of window.baselineNormals) {
              mesh.geometry.getAttribute('normal').array.set(normals); mesh.geometry.getAttribute('normal').needsUpdate = true;
            }
            tm.cubeImagery.invalidateBlocks(); delete window.baselineNormals;
          });
          const restored = await canvas(page), diff = new PNG({width:png.width,height:png.height});
          metadata.legacyControl = {
            changedPixels:pixelmatch(legacy.data,png.data,diff.data,png.width,png.height,{threshold:.01}),
            restoredPixels:pixelmatch(restored.data,png.data,null,png.width,png.height,{threshold:.01}),
            cacheBefore,cacheAfter:await page.evaluate(() => { const tm = window.renderer.getBodyMesh('Moon').terrainManager; return {requests:tm.cubeImageryStats.requests,levels:tm.cubeImageryStats.displayedLevels}; }),
          };
          assert.deepEqual(metadata.legacyControl.cacheAfter,cacheBefore,'normal comparison holds imagery cache fixed');
          assert.equal(metadata.legacyControl.restoredPixels,0,'normal restoration returns identical pixels');
          await writeFile(`${out}/${name}-${view}-normal-diff.png`,PNG.sync.write(diff));
          await page.evaluate(() => { const r = window.renderer; r.start(); r.timeController.pause(); r.timeController.setTime(window.baselineEpoch); r.renderFrame(); });
        }
      }
      assert.deepEqual(errors,[]); await page.close(); continue;
    }
    if(process.env.CUBE_STYLE_ACTIVATION_ONLY) {
      await pose(page,poses.close); await settle(page);
      row.cpuThrottleRate = Number(process.env.CUBE_STYLE_CPU_RATE ?? 1);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate',{rate:row.cpuThrottleRate});
      row.activationProfile = await activationTiming(page);
      await cdp.detach();
      assert.deepEqual(errors,[]);
      console.log(name,'activation frames',row.activationProfile.activation.length);
      await page.close(); continue;
    }
    for(const [view, position] of (process.env.CUBE_STYLE_NAV_ONLY ? [] : Object.entries(poses))) {
      await pose(page,position); await settle(page);
      await page.getByLabel('Surface base color',{exact:true}).selectOption('imagery');
      await page.getByLabel('Hillshade effect',{exact:true}).uncheck();
      await page.waitForTimeout(300);
      const before = await snapshot(page); row.views[view] = {before, normal:await timing(page)};
      await page.evaluate(() => {
        const tm = window.renderer.getBodyMesh('Moon').terrainManager;
        window.cubePhysical = [...tm.surfaceStyle.meshes].filter(([,e]) => !e.derived).map(([mesh]) => ({mesh,positions:mesh.geometry.getAttribute('position').array.slice(),normals:mesh.geometry.getAttribute('normal').array.slice(),index:mesh.geometry.index.array.slice()}));
        window.cubeActivation = []; const update = window.cubeOriginalStyleUpdate ?? tm.surfaceStyle.update; window.cubeOriginalStyleUpdate = update;
        tm.surfaceStyle.update = function(...args) { const result = update.apply(this,args); if(result.meshes) window.cubeActivation.push(result); return result; };
      });
      const normalCanvas = await canvas(page);
      await page.screenshot({path:`${out}/${name}-${view}-imagery.png`});
      await page.getByLabel('Surface base color',{exact:true}).selectOption('neutral');
      await page.getByLabel('Hillshade effect',{exact:true}).check();
      await page.getByLabel('Light elevation',{exact:true}).fill('20');
      await page.getByLabel('Light azimuth',{exact:true}).fill('315');
      await page.getByLabel('Imagery amount',{exact:true}).fill('0');
      await page.waitForTimeout(1500);
      row.views[view].hillshade = await timing(page);
      await page.screenshot({path:`${out}/${name}-${view}-hillshade.png`});
      const shade = await canvas(page);
      await page.getByLabel('Light azimuth',{exact:true}).fill('90'); await page.waitForTimeout(250);
      const changedShade = await canvas(page);
      row.views[view].lightChangedPixels = pixelmatch(shade.data,changedShade.data,null,shade.width,shade.height,{threshold:.05});
      assert.ok(row.views[view].lightChangedPixels > 100);
      await page.getByLabel('Surface base color',{exact:true}).selectOption('elevation');
      await page.getByLabel('Elevation palette',{exact:true}).selectOption('blue-gold');
      await page.getByText('Fixed elevation range',{exact:true}).click();
      for(const [label,value] of [['Minimum elevation km','-5'],['Maximum elevation km','5']]) { const input = page.getByLabel(label); await input.fill(value); await input.press('Tab'); }
      await page.waitForTimeout(800);
      row.views[view].elevation = await timing(page);
      const after = await snapshot(page); row.views[view].after = after;
      assert.deepEqual(after.ids,before.ids,'styles keep selected source tiles');
      assert.equal(after.terrain.network.requests,before.terrain.network.requests,'no terrain requests for styling');
      assert.equal(after.grids.requests,before.grids.requests,'no CPU grid requests for styling');
      assert.equal(after.imagery.requests,before.imagery.requests,'no extra imagery requests for styling');
      assert.ok(after.sampled > 0 && after.maxHeightErrorKm < 0.000002);
      await page.screenshot({path:`${out}/${name}-${view}-elevation.png`});
      if(view === 'close') {
        const pick = await page.evaluate(() => { const r = window.renderer; for(let y = 350; y < 800; y += 50) for(let x = 200; x < 950; x += 50) { const p = r.pickSurfaceTintHeight(x,y); if(Number.isFinite(p?.heightKm)) return {x,y,height:p.heightKm}; } return null; });
        assert.ok(pick,'visible styled terrain pick, including split imagery'); row.pick = pick;
        await page.getByRole('button',{name:'Pick minimum on surface',exact:true}).click();
        await page.mouse.move(pick.x,pick.y); await page.mouse.click(pick.x,pick.y);
        const min = await page.evaluate(() => window.renderer.getBodyMesh('Moon').surfaceAppearance.minKm);
        assert.ok(Math.abs(min - pick.height) < 1e-6);
        assert.equal((await snapshot(page)).grids.requests,before.grids.requests,'hover and range pick do not request CPU grids');
        await page.getByRole('button',{name:'Pick maximum on surface',exact:true}).click(); await page.keyboard.press('Escape');
        assert.equal(await page.getByRole('button',{name:'Pick maximum on surface',exact:true}).getAttribute('aria-pressed'),'false');
        // Skirt/block invalidation keeps fields and controls active.
        await page.evaluate(() => window.renderer.getBodyMesh('Moon').terrainManager.setCubeSkirts(false)); await page.waitForTimeout(200);
        await page.evaluate(() => window.renderer.getBodyMesh('Moon').terrainManager.setCubeSkirts(true)); await page.waitForTimeout(200);
        assert.ok((await snapshot(page)).styled > 0);
      }
      const styledCanvas = await canvas(page);
      for (const mode of ['lod', 'imagery-level', 'imagery-unlit', 'none']) {
        await page.evaluate(mode => window.renderer.setTerrainDebugMode(mode, 'Moon'), mode);
        await page.waitForTimeout(250);
      }
      const debugRestored = await canvas(page);
      row.views[view].debugRestorePixels = pixelmatch(styledCanvas.data,debugRestored.data,null,styledCanvas.width,styledCanvas.height,{threshold:.01});
      assert.equal(row.views[view].debugRestorePixels,0,'debug round trip restores styled materials');
      await page.getByLabel('Hillshade effect',{exact:true}).uncheck();
      await page.getByLabel('Surface base color',{exact:true}).selectOption('imagery'); await page.waitForTimeout(500);
      const restored = await canvas(page);
      row.views[view].restoredPixelDifference = pixelmatch(normalCanvas.data,restored.data,null,restored.width,restored.height,{threshold:.01});
      assert.equal(row.views[view].restoredPixelDifference,0,'disabled styles restore the same imagery pixels');
      row.views[view].restored = await timing(page);
      row.views[view].physicalUnchanged = await page.evaluate(() => window.cubePhysical.every(({mesh,positions,normals,index}) => [positions,normals,index].every((a,i) => { const b = i === 2 ? mesh.geometry.index.array : mesh.geometry.getAttribute(i === 0 ? 'position':'normal').array; return a.length === b.length && a.every((v,j) => v === b[j]); })));
      assert.ok(row.views[view].physicalUnchanged);
      assert.equal((await snapshot(page)).styled,0);
      row.views[view].activation = await page.evaluate(() => window.cubeActivation);
      console.log(name,view,{tiles:before.ids.length,split:after.imagery.splitTiles,lightChangedPixels:row.views[view].lightChangedPixels,restorationPixels:row.views[view].restoredPixelDifference,physicalUnchanged:true});
    }
    await page.getByLabel('Surface base color',{exact:true}).selectOption('elevation'); await page.getByLabel('Hillshade effect',{exact:true}).check();
    // Hold imagery contribution at zero so independent texture refinement
    // cannot masquerade as a relief-normal history change.
    await page.getByLabel('Surface base color',{exact:true}).selectOption('neutral');
    await page.getByLabel('Imagery amount',{exact:true}).fill('0');
    await pose(page,poses.close); await settle(page);
    const navigationBefore = await snapshot(page), navigationCanvas = await canvas(page);
    await writeFile(`${out}/${name}-navigation-before.png`,PNG.sync.write(navigationCanvas));
    await page.evaluate(() => {
      const r = window.renderer, style = r.getBodyMesh('Moon').terrainManager.surfaceStyle;
      window.navCamera = [...r.camera.matrixWorld.elements];
      window.navNormals = new Map([...style.meshes].filter(([,e]) => !e.derived && e.normalsActive).map(([m,e]) => [e.matrix.elements.join(','), m.geometry.getAttribute('surfaceReliefNormal').array.slice()]));
    });
    await pose(page,poses.far); await settle(page);
    await pose(page,poses.close); await settle(page);
    const navigationAfter = await snapshot(page), returnedCanvas = await canvas(page);
    await writeFile(`${out}/${name}-navigation-after.png`,PNG.sync.write(returnedCanvas));
    const diagnostics = await page.evaluate(() => {
      const r = window.renderer, style = r.getBodyMesh('Moon').terrainManager.surfaceStyle;
      let maxNormalDifference = 0, missing = 0, active = 0;
      for(const [m,e] of style.meshes) if(!e.derived && e.normalsActive) {
        active++; const before = window.navNormals.get(e.matrix.elements.join(','));
        if(!before) {missing++;continue;}
        const now = m.geometry.getAttribute('surfaceReliefNormal').array;
        for(let i = 0; i < now.length; i++) maxNormalDifference = Math.max(maxNormalDifference, Math.abs(now[i] - before[i]));
      }
      return {maxNormalDifference,missing,active,beforeActive:window.navNormals.size,cameraDifference:Math.max(...r.camera.matrixWorld.elements.map((v,i) => Math.abs(v - window.navCamera[i])))};
    });
    row.navigation = {diagnostics, imageryBefore:navigationBefore.imagery, imageryAfter:navigationAfter.imagery, sameTiles:JSON.stringify(navigationBefore.ids) === JSON.stringify(navigationAfter.ids),
      changedPixels:pixelmatch(navigationCanvas.data,returnedCanvas.data,null,navigationCanvas.width,navigationCanvas.height,{threshold:.01}) };
    console.log(name,'navigation',{sameTiles:row.navigation.sameTiles,changedPixels:row.navigation.changedPixels,...diagnostics});
    assert.ok(row.navigation.sameTiles); assert.equal(row.navigation.changedPixels,0,'camera history keeps the same visible shading');
    await page.getByLabel('Surface base color',{exact:true}).selectOption('elevation');
    await page.setViewportSize({width:390,height:844}); await page.waitForTimeout(800);
    await page.getByLabel('Elevation palette',{exact:true}).scrollIntoViewIfNeeded();
    row.mobile = await page.evaluate(() => { const section = document.querySelector('[aria-label="Surface appearance"]'), r = section.getBoundingClientRect(); return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,sectionWidth:r.width,sectionLeft:r.left,
      panelScroll:section.closest('.instrument')?.querySelector('.instrument-body')?.scrollTop ?? null,
      dockScroll:section.closest('.instrument')?.parentElement?.scrollTop ?? null}; });
    assert.ok(row.mobile.documentWidth <= 390 && row.mobile.sectionWidth < 390);
    const scrolling = await page.evaluate(() => {
      const section = document.querySelector('[aria-label="Surface appearance"]');
      const body = section.closest('.instrument').querySelector('.instrument-body'), dock = section.closest('.instrument').parentElement;
      const initial = body.scrollTop; body.scrollTop = body.scrollHeight; dock.scrollTop = 20;
      const result = {bodyScroll:body.scrollTop,dockScroll:dock.scrollTop}; body.scrollTop = initial; return result;
    });
    row.mobile.scrolling = scrolling;
    assert.ok(scrolling.bodyScroll > 0); assert.equal(scrolling.dockScroll,0);
    await page.screenshot({path:`${out}/${name}-mobile.png`});
    assert.deepEqual(errors,[]); await page.close();
    await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));
  }
} finally { await browser.close(); await writeFile(`${out}/results.json`,JSON.stringify(results,null,2)); }
