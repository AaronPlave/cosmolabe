/** PR #270: real Moon cube terrain, repeated Navigate flights, controls and HUD.
 * Uses an existing viewer: SURFACE_NAV_URL=http://localhost:5173 node scripts/test-surface-navigation-live.mjs
 * Writes camera/terrain/clamp traces and screenshots to /tmp/cosmolabe-surface-navigation.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const out = process.env.SURFACE_NAV_OUT ?? '/tmp/cosmolabe-surface-navigation';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'vulkan'}`, '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
const cdp = await page.context().newCDPSession(page);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
try {
  await page.goto(`${process.env.SURFACE_NAV_URL ?? 'http://localhost:5173'}/?catalog=test-catalogs/experiments/moon-terrain-cube`);
  await page.waitForFunction(() => window.renderer, null, { timeout: 120000 });
  await page.evaluate(async () => {
    await window.renderer.waitForInitialAssets(); window.cosmo.setPlaying(false);

    window.navState = await import('/src/lib/viewer-state.svelte.ts');
    const r = window.renderer, cc = r.cameraController, bm = r.getBodyMesh('Moon');
    window.trace = []; window.flights = []; window.clamps = [];
    const localEye = () => r.camera.position.clone().sub(bm.position).applyQuaternion(bm.mesh.quaternion.clone().invert()).divideScalar(r.scaleFactor);
    window.navSample = () => {
      const v = localEye(), p = { xKm:v.x, yKm:-v.z, zKm:v.y };
      const geo = bm.terrainBodyFixedToGeodetic(p), s = bm.sampleTerrainBodyFixed(p);
      const f = cc._anim?.surface;
      return { eyeKm:v.toArray(), target:cc.controls.target.toArray(), elevationKm:s?.elevationKm, tileId:s?.tileId,
        clearanceKm:geo && s ? geo.heightKm-s.elevationKm : null, revision:bm.terrainRevision,
        nearKm:r.camera.near/r.scaleFactor, flying:!!cc.flight, riseKm:f ? f.rise/r.scaleFactor : null,
        rotate:cc.controls.rotateSpeed, zoom:cc.controls.zoomSpeed, keyboardKm:cc.keyboard.altitudeRefSceneUnits/r.scaleFactor,
        grid:bm.terrainManager.cubeStats, visible:bm.terrainManager.tiles.visibleTiles.size };
    };
    const fly = cc.flyToSurface;
    cc.flyToSurface = function(body, pose, opts) {
      const start = window.navSample(); fly.call(this,body,pose,opts);
      window.flights.push({start,end:pose.position.toArray(),target:pose.target.toArray(),after:window.navSample()});
    };
    const clamp = r.clampCameraAboveSurfaces;
    r.clampCameraAboveSurfaces = function() {
      const before = r.camera.position.clone(); clamp.call(this);
      const correctionKm = before.distanceTo(r.camera.position)/r.scaleFactor;
      if (correctionKm > 1e-8) window.clamps.push({correctionKm,...window.navSample()});
      if (window.trace.length < 4000) window.trace.push(window.navSample());
    };
  });
  console.log('Moon ready');
  await page.getByRole('button', {name:'Navigate',exact:true}).click();
  const pair = page.getByPlaceholder('18.4447, 77.4508');
  await pair.fill('-89.67, 129.78');
  await page.locator('[aria-label="View"] button').filter({hasText:'surface'}).click();
  await page.getByRole('button', { name:'Fly to', exact:true }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name:'Fly to', exact:true }).click();
  await page.waitForFunction(() => !window.renderer.cameraController.flight, null, { timeout:30000 });
  await page.waitForTimeout(10000);
  const rendered = await page.evaluate(()=>{
    const r=window.renderer,bm=r.getBodyMesh('Moon'),caster=r._surfaceRaycaster;
    const radial=r.camera.position.clone().sub(bm.position).normalize();
    caster.ray.origin.copy(r.camera.position).addScaledVector(radial,r.scaleFactor);
    caster.ray.direction.copy(radial).negate();caster.near=0;caster.far=2*r.scaleFactor;
    const hit=r._castSurfaces();
    return {sample:window.navSample(),renderedClearanceKm:hit ? hit.distance/r.scaleFactor-1 : null,source:hit?.source};
  });
  console.log('landed',rendered);
  assert.ok(rendered.renderedClearanceKm >= 0.0019, 'eye is under the visible terrain');
  assert.ok(rendered.sample.nearKm < rendered.renderedClearanceKm / 10, 'terrain is near-clipped');
  await page.screenshot({ path:`${out}/landing.png` });
  // Repeated settled requests must leave the camera at the landing.
  const first = await page.evaluate(()=>window.navSample());
  for (let i=0;i<3;i++) {
    await page.getByRole('button', { name:'Fly to', exact:true }).click();
    assert.equal(await page.evaluate(()=>!!window.renderer.cameraController.flight),false,'settled identical Fly launched a flight');
  }
  await page.screenshot({ path:`${out}/repeated.png` });
  await page.getByRole('button',{name:'Surface source and datum'}).click();
  await page.locator('[data-slot="popover-content"]').filter({hasText:'On the terrain'}).waitFor();
  await page.keyboard.press('Escape');
  // Real pointer and wheel input at a surface target and after clearing it.
  for (const released of [false,true]) {
    await page.getByRole('button',{name:'Jump to',exact:true}).click();
    if (released) {
      const before = await page.evaluate(()=>window.renderer.camera.position.toArray());
      await page.getByRole('button',{name:'Clear surface target',exact:true}).click();
      const after = await page.evaluate(()=>window.renderer.camera.position.toArray());
      assert.ok(Math.hypot(...after.map((v,i)=>v-before[i])) < 1e-10, 'clearing Target moved the eye');
      const cleared = await page.evaluate(()=>{
        const r=window.renderer,cc=r.cameraController,bm=r.getBodyMesh('Moon');
        return {range:cc.controls.target.distanceTo(bm.position),surface:cc.surfaceNavigating,tracking:cc.trackedBody?.body.name};
      });
      assert.ok(cleared.range < 1e-12, 'clearing Target retained the old ground orbit point');
      assert.equal(cleared.surface,false);
      assert.equal(cleared.tracking,'Moon');
    }
    const at = await page.evaluate(()=>window.renderer.camera.position.toArray());
    await page.mouse.move(900,450); await page.mouse.down(); await page.mouse.move(970,470,{steps:12}); await page.mouse.up();
    await page.waitForTimeout(250);
    const after = await page.evaluate(()=>window.renderer.camera.position.toArray());
    assert.ok(Math.hypot(...after.map((v,i)=>v-at[i]))>1e-10,'drag did not move camera');
    const position = () => page.evaluate(()=>window.renderer.camera.position.toArray());
    const moved = (a,b) => Math.hypot(...b.map((v,i)=>v-a[i])) > 1e-11;
    const beforeWheel = await position();
    await page.mouse.wheel(0,100); await page.waitForTimeout(250);
    assert.ok(moved(beforeWheel,await position()), 'wheel did not move the eye');
    const beforePinch = await position();
    const points = (spread) => [{x:950-spread,y:450,id:1},{x:950+spread,y:450,id:2}];
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points(100)});
    for (let n=0;n<10;n++) {
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points(100-n*5)});
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.waitForTimeout(250);
    assert.ok(moved(beforePinch,await position()), 'pinch did not move the eye');
    const beforeKey = await position();
    await page.keyboard.down('KeyD'); await page.waitForTimeout(250); await page.keyboard.up('KeyD');
    assert.ok(moved(beforeKey,await position()), 'keyboard did not move the eye');
    const controls = await page.evaluate(()=>window.navSample());
    if (released) {
      assert.ok(controls.rotate > 0 && controls.zoom > 0, 'body-centred input stopped responding');
    } else {
      assert.ok(controls.rotate >= 1 && controls.zoom >= 1, 'local input became damped after manual movement');
    }
    assert.ok(controls.clearanceKm >= 0.0019, 'manual movement ended below terrain');
    console.log('controls',released,controls);
  }
  // Long precision is retained in the form; desktop and narrow HUD keep suffixes.
  await pair.fill('-15.123123000, 214.23423456789');
  await page.getByRole('button',{name:'Jump to',exact:true}).click();
  await page.screenshot({path:`${out}/hud-desktop.png`});
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(300);
  const hud = await page.locator('.target-coordinates').evaluate(el=>({text:el.innerText,width:el.clientWidth,scroll:el.scrollWidth,rect:el.getBoundingClientRect().toJSON()}));
  assert.match(hud.text,/15.12° S, 145.77° W/); assert.equal(hud.scroll,hud.width); assert.ok(hud.rect.right<390 && hud.rect.left>=8);
  const box = await page.locator('.view-context').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'HUD leaves the viewport');
  await page.screenshot({path:`${out}/hud-narrow.png`});
  const result = await page.evaluate(()=>({trace:window.trace,flights:window.flights,clamps:window.clamps,gpu:(()=>{const gl=window.renderer.getContext().webglRenderer.getContext(),e=gl.getExtension('WEBGL_debug_renderer_info');return gl.getParameter(e?e.UNMASKED_RENDERER_WEBGL:gl.RENDERER);})()}));
  assert.ok(result.trace.every(t=>t.clearanceKm === null || t.clearanceKm >= 0.0019), 'flight/clamp left eye below decoded ground');
  await writeFile(`${out}/trace.json`,JSON.stringify({requested:{lat:-89.67,lon:129.78,preset:"surface",eyeHeightKm:0.002},rendered,first,hud,errors,...result},null,2));
  console.log(JSON.stringify({gpu:result.gpu,frames:result.trace.length,flights:result.flights.length,clamps:result.clamps.length,errors},null,2));
} catch (error) {
  await page.screenshot({path:`${out}/failure.png`}).catch(()=>{});
  const trace = await page.evaluate(()=>({trace:window.trace,flights:window.flights,clamps:window.clamps})).catch(()=>null);
  await writeFile(`${out}/failure.json`,JSON.stringify({error:String(error),errors,...trace},null,2));
  throw error;
} finally { await browser.close(); }
