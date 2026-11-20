#!/usr/bin/env node
// npm run build && node scripts/test-atmosphere-twilight-gpu.mjs
// Set ATMOSPHERE_CAPTURE_DIR to also save fixed-exposure comparison panels and samples.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { viewerBrowserOptions } from './lib/viewer-browser.mjs';

const captureDir = process.env.ATMOSPHERE_CAPTURE_DIR;
const bundle = await build({
  stdin: {
    contents: `
      export * as THREE from 'three';
      export { AtmosphereMesh, getAtmospherePreset } from './packages/three/dist/AtmosphereMesh.js';
      export { solarDisplayExposure, SOLAR_REFERENCE_DISTANCE_KM } from './packages/three/dist/SolarRadiometry.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: 'esm', platform: 'browser',
});
const browser = await chromium.launch({ headless: true, ...viewerBrowserOptions() });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('http://twilight.test/**', route => new URL(route.request().url()).pathname === '/bundle.js'
    ? route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text })
    : route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Atmosphere twilight test</title>' }));
  await page.goto('http://twilight.test/');
  const { gpu, samples, panels } = await page.evaluate(async capture => {
    const { THREE, AtmosphereMesh, getAtmospherePreset, solarDisplayExposure, SOLAR_REFERENCE_DISTANCE_KM } =
      await import('/bundle.js');
    const width = 360;
    const height = 201;
    const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: capture });
    renderer.setSize(width, height);
    const gl = renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType });
    const pixel = new Float32Array(4);
    const camera = new THREE.PerspectiveCamera(22, width / height, 0.001, 1e7);
    const rad = THREE.MathUtils.degToRad;
    const origin = new THREE.Vector3();
    const offset = new THREE.Vector3();
    const scene = new THREE.Scene();
    const sunRadius = 695700;
    const samples = [];
    const panels = [];

    function lookAt(azimuth, elevation) {
      const az = rad(azimuth);
      const el = rad(elevation);
      offset.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
      camera.lookAt(offset.add(camera.position));
    }

    function sample() {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel);
      return Array.from(pixel.subarray(0, 3));
    }

    try {
      for (const [body, radius, distanceAU] of [['Earth', 6378.1, 1], ['Mars', 3396.19, 1.52], ['Titan', 2574.73, 9.58]]) {
        for (const path of ['lut', 'fallback']) {
          const shell = new AtmosphereMesh(radius, getAtmospherePreset(body), path === 'lut' ? renderer : undefined);
          shell.scale.setScalar(shell.shellRadius);
          shell.updateMatrixWorld(true);
          scene.add(shell);
          const sun = new THREE.Vector3();
          const occluder = { pos: new THREE.Vector3(), radius: 100000 };
          const distance = distanceAU * SOLAR_REFERENCE_DISTANCE_KM;
          const exposure = solarDisplayExposure(distance, sunRadius);
          const update = occluders => shell.update(camera.position, sun, occluders, origin,
            sunRadius, shell.shellRadius, 'main', true, exposure);

          for (const [event, solarElevation, solarAzimuth] of [['sunrise', 1, 0], ['sunset', -1, 180]]) {
            camera.position.set(0, radius + 0.002, 0);
            const el = rad(solarElevation);
            const az = rad(solarAzimuth);
            sun.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).multiplyScalar(distance);
            update([]);
            const directions = ['sunward', 'cross-sun', 'antisolar'];
            const sky = directions.map((direction, i) => {
              lookAt(solarAzimuth + i * 90, 1);
              const rgb = sample();
              if (capture) {
                renderer.setRenderTarget(null);
                renderer.render(scene, camera);
                panels.push({ name: `${body}-${path}-${event}-${direction}`, png: renderer.domElement.toDataURL() });
              }
              return rgb;
            });

            // Full umbra isolates light that bypasses the scattering integral.
            // Lit antisolar sky can legitimately have broad twilight brightness.
            occluder.pos.copy(sun).setLength(1e6);
            update([occluder]);
            lookAt(solarAzimuth + 180, 1);
            const umbra = sample();
            samples.push({ body, path, event, sky, umbra });
          }

          // Aim at the same tangent altitude just inside and outside the shell.
          const limb = [-0.25, 0.25].map(offsetKm => {
            camera.position.y = shell.shellRadius + offsetKm;
            update([]);
            const tangentRadius = (radius + shell.shellRadius) / 2;
            const tangentElevation = -Math.acos(tangentRadius / camera.position.y) * 180 / Math.PI;
            lookAt(180, tangentElevation);
            return sample();
          });
          samples.push({ body, path, limb });
          scene.remove(shell);
          shell.dispose();
        }
      }
      return { gpu, samples, panels };
    } finally {
      renderer.setRenderTarget(null);
      target.dispose();
      renderer.dispose();
    }
  }, Boolean(captureDir));

  if (captureDir) {
    await mkdir(captureDir, { recursive: true });
    await Promise.all([
      writeFile(join(captureDir, 'samples.json'), JSON.stringify({ gpu, samples }, null, 2) + '\n'),
      ...panels.map(({ name, png }) => writeFile(join(captureDir, `${name}.png`), Buffer.from(png.split(',')[1], 'base64'))),
    ]);
  }
  assert.deepEqual(errors, [], 'WebGL errors');
  const unexpected = samples.filter(({ umbra }) => umbra?.some(channel => Math.abs(channel) > 1e-6));
  assert.deepEqual(unexpected.map(({ body, path, event, umbra }) => ({ body, path, event, umbra })), [],
    'Antisolar light survives full umbra');
  for (const sample of samples) {
    const rays = sample.sky ?? sample.limb;
    assert.ok(rays.flat().every(Number.isFinite), `Non-finite sky or limb: ${JSON.stringify(sample)}`);
    // Very dim rays can round to zero in the half-float LUT. Check the lit
    // sunrise direction and the sunlit outer limb as positive controls.
    const litRay = sample.event === 'sunrise' ? sample.sky[0] : sample.limb?.[1];
    if (litRay) {
      assert.ok(Math.max(...litRay) > 1e-6, `Sunlit scattering is missing: ${JSON.stringify(sample)}`);
    }
    if (sample.body === 'Earth' && sample.event === 'sunrise') {
      assert.ok(Math.max(...sample.sky[2]) > 1e-3, `Broad antisolar twilight is missing: ${JSON.stringify(sample)}`);
    }
  }
  console.log(`${gpu}\nEarth, Mars, and Titan twilight and limb probes pass for both atmosphere paths.`);
} finally {
  await browser.close();
}
