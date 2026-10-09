/** Reference captures from the running viewer app, including its UI.
 * Start npm --prefix apps/viewer run dev first, then:
 * CHROMIUM_PATH=/usr/bin/chromium node scripts/capture-sun-viewer.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173/';
const preset = process.env.SOLAR_REFERENCE_PRESET ?? 'Earth';
const parameters = { Earth: [6371,10], Venus: [6052,50], Mars: [3390,10], Titan: [2575,200] };
assert.ok(parameters[preset], `Unknown reference preset ${preset}`);
const [planetRadiusKm, altitudeKm] = parameters[preset];
const solarDistanceAU = Number(process.env.SOLAR_REFERENCE_AU ?? ({Earth:1,Venus:0.72,Mars:1.52,Titan:9.5})[preset]);
assert.ok(solarDistanceAU>0);
const solarDistanceKm = solarDistanceAU*149597870;
const observerRadiusKm = planetRadiusKm + altitudeKm;
const horizonDip = Math.acos(planetRadiusKm / observerRadiusKm);
const solarXKm = observerRadiusKm - solarDistanceKm * Math.sin(horizonDip);
const solarZKm = solarDistanceKm * Math.cos(horizonDip);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (preset === 'Titan') await page.route('**/titan.dds', route => route.fulfill({
    contentType: 'application/octet-stream', body: readFileSync(new URL('../apps/viewer/test-catalogs/textures/titan.dds',import.meta.url)) }));
  await page.route('**/sun-reference.json', route => route.fulfill({ json: {
    name: 'Sun rendering reference', items: [
      { name: preset, class: 'planet', trajectory: { type: 'FixedPoint', position: [0,0,0] },
        geometry: { type: 'Globe', radius: planetRadiusKm, atmosphere: preset,
          ...(preset === 'Titan' ? {baseMap:'titan.dds'} : {}) } },
      { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: [solarXKm,0,solarZKm] },
        geometry: { type: 'Globe', radius: 695000 } },
    ] } }));
  await page.goto(new URL('?catalog=sun-reference&test=1', base).href, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    // Use the app's canonical Vite dependency URL, including any HMR timestamp.
    // Importing the bare URL after a rebuild creates an unbound second state.
    const source=await (await fetch('/src/lib/commands.ts')).text();
    const stateURL=source.match(/from ["']([^"']*viewer-state\.svelte[^"']*)["']/)?.[1];
    window.solarReferenceState=await import(stateURL ?? '/src/lib/viewer-state.svelte.ts');
  });
  await page.waitForFunction(preset => {
    const { getRenderer, vs } = window.solarReferenceState;
    const r=getRenderer();
    // The landing-page hero also has a Sun; wait for this two-body catalog,
    // rather than capturing while the app unmounts its temporary renderer.
    return vs.sceneLoaded && vs.assetsReady && r?.bodyMeshes.size===2 && r.getBodyMesh(preset)!=null && r.getBodyMesh('Sun')?.sunVisual!=null;
  }, preset, { timeout: 20000 }).catch(async error => {
    const state=await page.evaluate(() => {
      const {getRenderer,vs}=window.solarReferenceState;
      return {bodies:getRenderer() ? [...getRenderer().bodyMeshes.keys()] : null,
        sceneLoaded:vs.sceneLoaded,assetsReady:vs.assetsReady,catalog:vs.catalogName,loading:vs.loadingLabel};
    });
    throw new Error(`${error.message}; ${JSON.stringify(state)}; ${errors.join('\n')}`);
  });
  if (preset === 'Titan') await page.waitForFunction(() => {
    const {getRenderer} = window.solarReferenceState;
    return getRenderer()?.getBodyMesh('Titan')?.mesh.material.map != null;
  },null,{timeout:60000});
  mkdirSync('work/sun-rendering', { recursive: true });
  const references = [];
  for (const size of preset === 'Earth' ? [150,35,5,'sunrise'] : preset === 'Titan' ? ['front','back','sunrise'] : ['sunrise']) {
    console.log('Capturing',preset,size);
    const info = await page.evaluate(async ({ size, preset, altitudeKm }) => {
      const { getRenderer, setDisplayOption } = window.solarReferenceState;
      const r = getRenderer(), sun = r.getBodyMesh('Sun'), c = r.camera;
      r.setBloom({ enabled: true });
      window.cosmo.setPlaying(false); window.cosmo.untrack();
      setDisplayOption('labels', false, { persist: false }); setDisplayOption('trajectories', false, { persist: false });
      r.cameraController.controls.enableDamping = false;
      c.fov = size === 'sunrise' ? 8 : 60; c.updateProjectionMatrix();
      const height = r.renderer.domElement.height;
      const radius = sun.displayRadius * r.scaleFactor;
      const z = sun.position.z;
      if (size === 'front' || size === 'back') {
        c.position.copy(sun.position).normalize().multiplyScalar(r.getBodyMesh(preset).displayRadius*r.scaleFactor*3*(size==='front'?1:-1));
        c.up.set(0,1,0); r.cameraController.controls.target.set(0,0,0);
      } else if (size === 'sunrise') {
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
    info.solarDistanceAU=solarDistanceAU;
    if (typeof size === 'number') assert.ok(Math.abs(info.diameterPixels-size)<0.2, JSON.stringify(info));
    references.push(info);
    if (size === 'sunrise') {
      const luminance = rgb => 0.2126*rgb[0]+0.7152*rgb[1]+0.0722*rgb[2];
      assert.ok(luminance(info.sunRGB)>luminance(info.skyRGB)*1.5, `Direct Sun must exceed adjacent sky: ${JSON.stringify(info)}`);
      if (preset !== 'Mars') assert.ok(info.sunRGB[0]>=info.sunRGB[2], `${preset} must not produce a blue Sun`);
    }
    const suffix = preset === 'Earth' ? '' : `${preset.toLowerCase()}-`;
    await page.screenshot({ path: `work/sun-rendering/app-${typeof size==='number' ? `space-${size}px` : `${suffix}${size}`}.png` });
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  writeFileSync(`work/sun-rendering/app-${preset.toLowerCase()}-reference-poses.json`, JSON.stringify(references,null,2)+'\n');
  console.log(JSON.stringify(references,null,2));
} finally { await browser.close(); }
