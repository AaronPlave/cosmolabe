/** Reference captures from the running viewer app, including its UI.
 * Start npm --prefix apps/viewer run dev first, then:
 * CHROMIUM_PATH=/usr/bin/chromium node scripts/capture-sun-viewer.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173/';
// A 10 km observer with the Sun's center on the spherical horizon.
const observerRadiusKm = 6381;
const horizonDip = Math.acos(6371 / observerRadiusKm);
const solarXKm = observerRadiusKm - 149597870 * Math.tan(horizonDip);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/sun-reference.json', route => route.fulfill({ json: {
    name: 'Sun rendering reference', items: [
      { name: 'Earth', class: 'planet', trajectory: { type: 'FixedPoint', position: [0,0,0] },
        geometry: { type: 'Globe', radius: 6371, atmosphere: 'Earth' } },
      { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: [solarXKm,0,149597870] },
        geometry: { type: 'Globe', radius: 695000 } },
    ] } }));
  await page.goto(new URL('?catalog=sun-reference&test=1', base).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(async () => {
    const { getRenderer } = await import('/src/lib/viewer-state.svelte.ts');
    return getRenderer()?.getBodyMesh('Sun')?.sunVisual != null;
  }, null, { timeout: 60000 });
  mkdirSync('work/sun-rendering', { recursive: true });
  const references = [];
  for (const size of [150,35,5,'sunrise']) {
    const info = await page.evaluate(async size => {
      const { getRenderer, setDisplayOption } = await import('/src/lib/viewer-state.svelte.ts');
      const r = getRenderer(), sun = r.getBodyMesh('Sun'), c = r.camera;
      r.setBloom({ enabled: true });
      window.cosmo.setPlaying(false); window.cosmo.untrack();
      setDisplayOption('labels', false, { persist: false }); setDisplayOption('trajectories', false, { persist: false });
      r.cameraController.controls.enableDamping = false;
      c.fov = size === 'sunrise' ? 8 : 60; c.updateProjectionMatrix();
      const height = r.renderer.domElement.height;
      const radius = sun.displayRadius * r.scaleFactor;
      const z = sun.position.z;
      if (size === 'sunrise') {
        // A denser physical globe keeps polygon facets from dominating this
        // reference horizon; it changes tessellation, not the catalog radius.
        const earth = r.getBodyMesh('Earth');
        const SphereGeometry = earth.mesh.geometry.constructor;
        earth.mesh.geometry.dispose();
        earth.mesh.geometry = new SphereGeometry(earth.displayRadius,1024,512);
        const x = (earth.displayRadius + 10) * r.scaleFactor;
        c.position.set(x,0,0); c.up.set(1,0,0);
        r.cameraController.controls.target.copy(sun.position);
      } else {
        const d = Math.sqrt(radius**2+(radius*height/(size*Math.tan(c.fov*Math.PI/360)))**2);
        c.position.set(sun.position.x,0,z-d); c.up.set(0,1,0);
        r.cameraController.controls.target.copy(sun.position);
      }
      c.lookAt(r.cameraController.controls.target); c.updateMatrixWorld(true); r.renderFrame();
      await new Promise(requestAnimationFrame);
      r.renderFrame();
      return { size, diameterPixels: sun.sunVisual.diameterPixels, camera: window.cosmo.getCamera(),
        drawingBuffer: [r.renderer.domElement.width,r.renderer.domElement.height] };
    }, size);
    if (typeof size === 'number') assert.ok(Math.abs(info.diameterPixels-size)<0.2, JSON.stringify(info));
    references.push(info);
    await page.screenshot({ path: `work/sun-rendering/app-${size === 'sunrise' ? size : `space-${size}px`}.png` });
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  writeFileSync('work/sun-rendering/app-reference-poses.json', JSON.stringify(references,null,2)+'\n');
  console.log(JSON.stringify(references,null,2));
} finally { await browser.close(); }
