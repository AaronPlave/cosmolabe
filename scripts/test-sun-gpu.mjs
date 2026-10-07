#!/usr/bin/env node
/** Solar disk/source/PSF integration regression. No kernels or viewer build.
 * npm run build && node scripts/test-sun-gpu.mjs
 * Set CHROMIUM_PATH for a system Chromium; otherwise uses Playwright's browser.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 768, height: 512 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' || /GL_INVALID_OPERATION|Feedback loop/i.test(m.text())) errors.push(m.text()); });
  await page.route('http://sun.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><style>body{margin:0;background:black}</style><script type="importmap">{"imports":{"three":"/three.module.js"}}</script>' });
    const local = path.startsWith('/three.') ? `../node_modules/three/build${path}` : `../packages/three/dist${path}`;
    return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL(local, import.meta.url), 'utf8') });
  });
  await page.goto('http://sun.test/');
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { SunVisual, SOLAR_LAYER } = await import('/SunVisual.js');
    const { SunGlareEffect } = await import('/SunGlareEffect.js');
    const { AtmosphereMesh, getAtmospherePreset } = await import('/AtmosphereMesh.js');
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
    renderer.setSize(768, 512);
    renderer.autoClear = false;
    document.body.appendChild(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(40, 1.5, 0.01, 1e9);
    camera.position.z = 10;
    camera.updateMatrixWorld();
    const scene = new THREE.Scene();
    const solar = new SunVisual();
    const sun = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), solar.material);
    sun.layers.set(SOLAR_LAYER);
    const owner = new THREE.Object3D();
    owner.add(sun);
    scene.add(owner);
    const glare = new SunGlareEffect(renderer);
    const sources = new Map([[sun, solar]]);
    const blocker = new THREE.Mesh(new THREE.SphereGeometry(1.2, 64, 48), new THREE.MeshBasicMaterial({ color: 0 }));
    blocker.position.z = 5;
    blocker.visible = false;
    scene.add(blocker);
    const overlay = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, depthWrite: false }));
    overlay.position.set(-2, 0, 5);
    scene.add(overlay);
    function draw(useGlare = true) {
      sun.updateMatrixWorld(true);
      solar.update(camera, new THREE.Vector3(), 1, 512);
      renderer.setRenderTarget(null);
      renderer.clear();
      camera.layers.set(0);
      renderer.render(scene, camera);
      camera.layers.set(SOLAR_LAYER);
      renderer.render(scene, camera);
      camera.layers.enableAll();
      if (useGlare) glare.render(scene, camera, sources);
    }
    function pixel(x, y) {
      const data = new Uint8Array(4);
      renderer.getContext().readPixels(x, y, 1, 1, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, data);
      return [...data].slice(0, 3);
    }
    draw();
    const radius = solar.diameterPixels / 2;
    const center = pixel(384, 256), limb = pixel(Math.round(384 + radius * 0.98), 256);
    const halo = pixel(Math.round(384 + radius + 3), 256);
    const tail = pixel(Math.round(384 + radius + 50), 256);
    const savedMaterial = overlay.material;
    const stateRestored = overlay.visible && overlay.material === savedMaterial && !solar.uniforms.sourcePass.value && renderer.getRenderTarget() === null;
    blocker.visible = true;
    draw();
    const occulted = pixel(Math.round(384 + radius + 3), 256);
    const occultedDisk = pixel(384, 256);
    blocker.position.x = 0.8;
    draw();
    const partialHalo = pixel(Math.round(384 + radius + 3), 256);
    const partialVisibleHalo = pixel(Math.round(384 - radius - 3), 256);
    blocker.position.x = 0;
    blocker.visible = false;
    const sourceTarget = new THREE.WebGLRenderTarget(768, 512, { type: THREE.HalfFloatType });
    function sourcePixel() {
      solar.uniforms.sourcePass.value = true;
      renderer.setRenderTarget(sourceTarget);
      renderer.clear();
      renderer.render(scene, camera);
      const data = new Uint16Array(4);
      renderer.readRenderTargetPixels(sourceTarget, 384, 256, 1, 1, data);
      solar.uniforms.sourcePass.value = false;
      return [...data].slice(0, 3).map(THREE.DataUtils.fromHalfFloat);
    }
    const hdr = sourcePixel();
    const atm = new AtmosphereMesh(6371, getAtmospherePreset('Earth'));
    // Physical km are scaled to test-scene units. Camera is 1 km above Earth.
    const sf = 0.001;
    atm.scale.setScalar(atm.shellRadius * sf);
    atm.position.set(0, -(6371 + 1) * sf, 10);
    atm.updateMatrixWorld(true);
    solar.setAtmosphere(atm);
    const horizonHDR = sourcePixel();
    draw();
    const horizonDisk = pixel(384, 256);
    const horizonHalo = pixel(Math.round(384 + radius + 3), 256);
    const horizonHiddenHalo = pixel(384, Math.round(256 - radius - 3));
    const horizonVisibleHalo = pixel(384, Math.round(256 + radius + 3));
    const lutAtm = new AtmosphereMesh(6371, getAtmospherePreset('Earth'), renderer);
    lutAtm.scale.copy(atm.scale);
    lutAtm.position.copy(atm.position);
    lutAtm.updateMatrixWorld(true);
    solar.setAtmosphere(lutAtm);
    const horizonLUT = sourcePixel();
    solar.setAtmosphere(null);
    camera.position.z = 3.5;
    camera.updateMatrixWorld();
    draw();
    const closeRadius = solar.diameterPixels / 2;
    const closeProfile = [0, 0.5, 0.9, 0.98].map(r => pixel(Math.round(384 + closeRadius * r), 256)[0]);
    // Move farther away, crossing the 1–2px transition without resizing the sun.
    const transition = [];
    for (const diameter of [2.1, 2, 1.8, 1.5, 1.2, 1, 0.8, 0.4]) {
      camera.position.z = Math.sqrt(1 + (512 / (diameter * Math.tan(20 * Math.PI / 180))) ** 2);
      camera.updateMatrixWorld();
      draw();
      transition.push({ diameter, value: pixel(384, 256)[0], weight: solar.uniforms.resolvedWeight.value });
    }
    blocker.visible = true;
    draw();
    const unresolvedOcculted = pixel(384, 256);
    blocker.visible = false;
    // Only the Sun feeds glare; a bright red overlay cannot contaminate it.
    sun.visible = false;
    renderer.clear();
    glare.render(scene, camera, sources);
    const noSun = pixel(384, 256);
    sun.visible = true;
    camera.position.z = 10;
    camera.updateMatrixWorld();
    draw();
    window.solarTest = { camera, solar, sun, glare, scene, renderer, draw, blocker, atm, overlay };
    return { center, limb, halo, tail, occulted, occultedDisk, partialHalo, partialVisibleHalo, closeProfile, unresolvedOcculted, hdr, horizonHDR, horizonLUT, horizonDisk, horizonHalo, horizonHiddenHalo, horizonVisibleHalo, transition, noSun, stateRestored, physicalScale: sun.scale.toArray() };
  });
  console.log(JSON.stringify(result, null, 2));
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.ok(result.center[0] > result.limb[0] + 10, 'resolved limb must be darker than center');
  assert.ok(result.center[2] > result.center[0] * 0.95, 'neutral disk must be near white');
  assert.ok(result.hdr.every(c => c > 2), 'optical source must retain HDR radiance');
  assert.ok(result.halo[0] > 0 && result.tail[0] < result.halo[0] * 0.2, 'compact halo with restrained tail');
  assert.deepEqual(result.occultedDisk, [0, 0, 0], 'opaque foreground body must hide the disk');
  assert.ok(result.partialVisibleHalo[0] > 0, 'exposed crescent must retain local glare');
  assert.deepEqual(result.partialHalo, [0, 0, 0], 'hidden crescent must not retain a circular halo');
  assert.deepEqual(result.horizonHiddenHalo, [0, 0, 0], 'sunrise must not glow around the fully hidden lower limb');
  assert.ok(result.horizonVisibleHalo[0] > 0, 'sunrise must retain glare at the exposed upper limb');
  assert.ok(result.closeProfile[0] - result.closeProfile[3] > 30, 'close solar disk must show a visible center-to-limb gradient');
  assert.ok(result.closeProfile.every((v, i, a) => i === 0 || v <= a[i - 1]), 'close solar gradient must be monotonic');
  assert.deepEqual(result.unresolvedOcculted, [0, 0, 0], 'subpixel occultation must mask the optical footprint');
  assert.deepEqual(result.occulted, [0, 0, 0], 'complete occultation must hide all glare');
  assert.ok(result.horizonHDR[0] < result.hdr[0] * 0.6, 'grazing atmosphere must dim source');
  assert.ok(result.horizonHDR[2] / result.horizonHDR[0] < result.hdr[2] / result.hdr[0] * 0.5, 'grazing atmosphere must redden source');
  assert.ok(result.horizonDisk[0] > result.horizonDisk[2] * 2, 'display disk uses attenuated solar radiance');
  assert.ok(result.horizonHalo[0] < result.halo[0] && result.horizonHalo[2] < result.horizonHalo[0], 'glare follows atmospheric dimming/reddening');
  assert.ok(result.horizonLUT.every((v, i) => Math.abs(v - result.horizonHDR[i]) < 0.1), 'LUT and numerical profile paths agree');
  assert.ok(result.transition.every(t => t.value > 0), 'unresolved Sun remains visible');
  assert.ok(result.stateRestored, 'source pass restores renderer and scene state');
  assert.deepEqual(result.noSun, [0, 0, 0], 'overlays must not feed solar glare');
  assert.deepEqual(result.physicalScale, [1, 1, 1], 'physical radius stays unchanged');
  mkdirSync('work/sun-rendering', { recursive: true });
  await page.evaluate(() => { const t = window.solarTest; t.overlay.visible = false; t.draw(); });
  await page.screenshot({ path: 'work/sun-rendering/resolved.png' });
  await page.evaluate(() => { const t = window.solarTest; t.blocker.visible = true; t.blocker.position.x = 0.8; t.draw(); });
  await page.screenshot({ path: 'work/sun-rendering/partial-eclipse.png' });
  await page.evaluate(() => { const t = window.solarTest; t.blocker.visible = false; t.solar.setAtmosphere(t.atm); t.draw(); });
  await page.screenshot({ path: 'work/sun-rendering/horizon.png' });
  await page.evaluate(() => { const t = window.solarTest; t.solar.setAtmosphere(null); t.camera.position.z = 3.5; t.camera.updateMatrixWorld(); t.draw(); });
  await page.screenshot({ path: 'work/sun-rendering/close.png' });
  console.log('Solar GPU regression passed; captures in work/sun-rendering.');
} finally {
  await browser.close();
}
