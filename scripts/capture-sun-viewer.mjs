/** Reference captures from the running viewer app, including its UI.
 * Start npm --prefix apps/viewer run dev first, then:
 * CHROMIUM_PATH=/usr/bin/chromium node scripts/capture-sun-viewer.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173/';
const preset = process.env.SOLAR_REFERENCE_PRESET ?? 'Earth';
const parameters = { Earth: [6371,10], Venus: [6052,50], Mars: [3390,10], Titan: [2575,200] };
assert.ok(parameters[preset], `Unknown reference preset ${preset}`);
const [planetRadiusKm, altitudeKm] = parameters[preset];
const observerRadiusKm = planetRadiusKm + altitudeKm;
const horizonDip = Math.acos(planetRadiusKm / observerRadiusKm);
const solarXKm = observerRadiusKm - 149597870 * Math.tan(horizonDip);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/sun-reference.json', route => route.fulfill({ json: {
    name: 'Sun rendering reference', items: [
      { name: preset, class: 'planet', trajectory: { type: 'FixedPoint', position: [0,0,0] },
        geometry: { type: 'Globe', radius: planetRadiusKm, atmosphere: preset } },
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
  for (const size of preset === 'Earth' ? [150,35,5,'sunrise'] : ['sunrise']) {
    const info = await page.evaluate(async ({ size, preset, altitudeKm }) => {
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
        const earth = r.getBodyMesh(preset);
        const SphereGeometry = earth.mesh.geometry.constructor;
        earth.mesh.geometry.dispose();
        earth.mesh.geometry = new SphereGeometry(earth.displayRadius,1024,512);
        const x = (earth.displayRadius + altitudeKm) * r.scaleFactor;
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
      const gl=r.renderer.getContext();
      const sample = (x,y) => { const p=new Uint8Array(4); gl.readPixels(Math.round(x),Math.round(y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return [...p].slice(0,3); };
      const diameter=sun.sunVisual.diameterPixels;
      const y=height/2+diameter*0.2, x=r.renderer.domElement.width/2;
      return { size, preset, altitudeKm, sunRGB: sample(x,y), skyRGB: sample(x+diameter,y),
        diameterPixels: diameter, camera: window.cosmo.getCamera(),
        drawingBuffer: [r.renderer.domElement.width,r.renderer.domElement.height] };
    }, { size, preset, altitudeKm });
    if (typeof size === 'number') assert.ok(Math.abs(info.diameterPixels-size)<0.2, JSON.stringify(info));
    references.push(info);
    if (size === 'sunrise') {
      const luminance = rgb => 0.2126*rgb[0]+0.7152*rgb[1]+0.0722*rgb[2];
      assert.ok(luminance(info.sunRGB)>luminance(info.skyRGB)*1.5, `Direct Sun must exceed adjacent sky: ${JSON.stringify(info)}`);
      if (preset !== 'Mars') assert.ok(info.sunRGB[0]>=info.sunRGB[2], `${preset} must not produce a blue Sun`);
    }
    const suffix = preset === 'Earth' ? '' : `${preset.toLowerCase()}-`;
    await page.screenshot({ path: `work/sun-rendering/app-${size === 'sunrise' ? `${suffix}sunrise` : `space-${size}px`}.png` });
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  writeFileSync(`work/sun-rendering/app-${preset.toLowerCase()}-reference-poses.json`, JSON.stringify(references,null,2)+'\n');
  console.log(JSON.stringify(references,null,2));
} finally { await browser.close(); }
