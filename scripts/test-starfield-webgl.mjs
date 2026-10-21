/** Actual StarField shaders, float/8-bit readback, DPR/pan and depth regression.
 * CL_CHROMIUM=/usr/bin/chromium node scripts/test-starfield-webgl.mjs
 * CL_STAR_OUTPUT=/tmp/starfield-webgl selects the JSON/screenshot directory.
 * Software WebGL is repeatable acceptance evidence, not a hardware benchmark.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.CL_STAR_OUTPUT ?? '/tmp/starfield-webgl';
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root, logLevel: 'warn',
  server: { host: '127.0.0.1', port: 0 }, appType: 'custom' });
server.middlewares.use(async (req, res, next) => {
  if (req.url !== '/') return next();
  const html = await server.transformIndexHtml('/', `<link rel="icon" href="data:,"><canvas></canvas><script type="module">
    import * as THREE from 'three';
    import { StarField } from '/packages/three/src/StarField.ts';
    window.starfieldTest = { THREE, StarField };
  </script>`);
  res.setHeader('Content-Type', 'text/html');
  res.end(html);
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CL_CHROMIUM,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.starfieldTest);
  const result = await page.evaluate(async () => {
    const { THREE, StarField } = window.starfieldTest;
    const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('canvas'),
      antialias: false, preserveDrawingBuffer: true, logarithmicDepthBuffer: true });
    const gl = renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Float readback unavailable');
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    const field = new StarField({ linearFluxScale: 1 });
    scene.add(field);
    async function load(mag) {
      const buffer = new ArrayBuffer(28), view = new DataView(buffer);
      for (let i = 0; i < 4; i++) view.setUint8(i, 'STAR'.charCodeAt(i));
      view.setUint32(4, 1, true);
      view.setFloat32(16, -1, true);
      view.setFloat32(20, mag, true);
      view.setFloat32(24, 0.65, true);
      const url = URL.createObjectURL(new Blob([buffer]));
      try { await field.loadCatalog(url); } finally { URL.revokeObjectURL(url); }
      if (field.getCatalogStatus().state !== 'ready') throw new Error('Fixture failed to load');
    }
    function pan(phase, size) {
      camera.rotation.y = Math.atan(phase / (size / 2 * camera.projectionMatrix.elements[0]));
    }
    const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    function measure(pixels, size, dpr, decode = x => x) {
      let flux = 0, centroid = 0, litPixels = 0, peakByte = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const y = luminance(decode(pixels[i]), decode(pixels[i + 1]), decode(pixels[i + 2]));
        flux += y / (dpr * dpr);
        centroid += (i / 4 % size + 0.5) / dpr * y / (dpr * dpr);
        if (y > 0) litPixels++;
        peakByte = Math.max(peakByte, pixels[i], pixels[i + 1], pixels[i + 2]);
      }
      return { flux, centroid: flux > 0 ? centroid / flux : null, litPixels, peakByte };
    }
    const linear = [], display = [];
    for (const size of [128, 192]) for (const dpr of [1, 2]) {
      renderer.setPixelRatio(dpr); renderer.setSize(size, size);
      const n = size * dpr;
      const target = new THREE.WebGLRenderTarget(n, n, { type: THREE.FloatType });
      renderer.setRenderTarget(target);
      for (const fov of [1, 60, 120]) {
        camera.fov = fov; camera.updateProjectionMatrix();
        for (const mag of [0, 2.5]) {
          await load(mag);
          for (const phase of [0, 0.125, 0.49, 0.8]) {
            pan(phase, size); renderer.render(scene, camera);
            const pixels = new Float32Array(n * n * 4);
            renderer.readRenderTargetPixels(target, 0, 0, n, n, pixels);
            linear.push({ size, dpr, fov, mag, phase, ...measure(pixels, n, dpr) });
          }
        }
      }
      renderer.setRenderTarget(null); target.dispose();
    }
    // Read the actual 8-bit sRGB default framebuffer at the provisional scale.
    // Keep quantization results as measurements, not a fake visibility pass.
    field.setLinearFluxScale(0.06);
    camera.fov = 60; camera.updateProjectionMatrix();
    const size = 128;
    const toLinear = byte => {
      const s = byte / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const toSrgb = linear => linear <= 0.0031308
      ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
    for (const dpr of [1, 2]) {
      renderer.setPixelRatio(dpr); renderer.setSize(size, size);
      const n = size * dpr;
      for (const tone of ['none', 'ACES']) {
        renderer.toneMapping = tone === 'ACES' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
        renderer.toneMappingExposure = 1;
        for (const mag of [-1.44, 0, 2.5, 4, 5, 6.5]) {
          await load(mag);
          const color = field.children[0].geometry.getAttribute('color');
          const rgb = [color.getX(0), color.getY(0), color.getZ(0)];
          const y = luminance(...rgb);
          for (let step = 0; step < 16; step++) {
            const phase = step / 16;
            pan(phase, size); renderer.render(scene, camera);
            const pixels = new Uint8Array(n * n * 4);
            gl.readPixels(0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            let maxReferenceError = 0;
            if (tone === 'none') {
              for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
                const dx = i + 0.5 - (size / 2 + phase) * dpr;
                const dy = j + 0.5 - n / 2;
                const sigma = 0.875 * dpr;
                const signal = 0.06 * 10 ** (-0.4 * mag) * dpr * dpr *
                  Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)) / (2 * Math.PI * sigma * sigma);
                for (let c = 0; c < 3; c++) {
                  const reference = Math.round(255 * toSrgb(signal * rgb[c] / y));
                  maxReferenceError = Math.max(maxReferenceError, Math.abs(pixels[(j * n + i) * 4 + c] - reference));
                }
              }
            }
            display.push({ dpr, tone, mag, phase, maxReferenceError, ...measure(pixels, n, dpr, toLinear) });
          }
        }
      }
    }
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setPixelRatio(1); renderer.setSize(size, size); pan(0, size);
    field.setLinearFluxScale(1); await load(0);
    function read() {
      renderer.render(scene, camera);
      const pixels = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    }
    const baseline = read();
    camera.position.set(123, -456, 789);
    const translated = read(); camera.position.set(0, 0, 0);
    camera.rotation.y = Math.PI;
    const behind = measure(read(), size, 1); pan(0, size);
    const occlusion = [];
    const terrain = new THREE.PlaneGeometry(4, 4, 16, 16);
    const positions = terrain.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      positions.setZ(i, 0.3 * Math.cos(positions.getX(i)) * Math.cos(positions.getY(i)));
    }
    for (const geometry of [new THREE.SphereGeometry(1, 32, 16), terrain]) {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0 }));
      mesh.position.z = -8; scene.add(mesh);
      occlusion.push(measure(read(), size, 1).flux);
      scene.remove(mesh); geometry.dispose(); mesh.material.dispose();
    }
    await field.loadCatalog('/packages/three/src/data/stars.bin');
    const catalog = field.getCatalogStatus();
    field.setLinearFluxScale(0.06);
    renderer.setSize(640, 480); camera.aspect = 640 / 480;
    camera.fov = 60; camera.updateProjectionMatrix(); renderer.render(scene, camera);
    const screenshot = renderer.domElement.toDataURL();
    const translationInvariant = baseline.every((value, i) => value === translated[i]);
    field.dispose(); renderer.dispose();
    return { gpu, linear, display, translationInvariant, behind, occlusion, catalog, screenshot };
  });
  const { screenshot, ...metrics } = result;
  await writeFile(`${output}/readback.json`, JSON.stringify({ browser: browser.version(), ...metrics, errors }, null, 2));
  await writeFile(`${output}/catalog.png`, Buffer.from(screenshot.split(',')[1], 'base64'));
  assert.deepEqual(errors, []);
  for (const row of result.linear) {
    assert.ok(Math.abs(row.flux / 10 ** (-0.4 * row.mag) - 1) < 0.001, JSON.stringify(row));
    assert.ok(Math.abs(row.centroid - (row.size / 2 + row.phase)) < 0.03, JSON.stringify(row));
  }
  for (const row of result.display) assert.ok(row.maxReferenceError <= 1, JSON.stringify(row));
  for (const dpr of [1, 2]) {
    const sample = tone => result.display.find(row => row.dpr === dpr && row.tone === tone && row.mag === 0 && row.phase === 0);
    assert.ok(sample('ACES').flux > 0 && sample('ACES').flux < sample('none').flux,
      'Shared renderer tone mapping must affect the display signal');
  }
  assert.equal(result.translationInvariant, true);
  assert.equal(result.behind.flux, 0);
  assert.deepEqual(result.occlusion, [0, 0]);
  assert.equal(result.catalog.state, 'ready');
  console.log(JSON.stringify({ output, gpu: result.gpu, linearSamples: result.linear.length,
    displaySamples: result.display.length, catalog: result.catalog, occlusion: result.occlusion,
    display: [1, 2].flatMap(dpr => [-1.44, 0, 2.5, 4, 5, 6.5].map(mag => {
      const rows = result.display.filter(row => row.dpr === dpr && row.mag === mag && row.tone === 'none');
      return { dpr, mag, fluxRange: [Math.min(...rows.map(r => r.flux)), Math.max(...rows.map(r => r.flux))],
        litPixelRange: [Math.min(...rows.map(r => r.litPixels)), Math.max(...rows.map(r => r.litPixels))] };
    })) }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
