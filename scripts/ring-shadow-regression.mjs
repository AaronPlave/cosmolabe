#!/usr/bin/env node
/**
 * GPU coverage regression for issue #124. No viewer assets or SPICE kernels.
 * Run after `npm run build`: node scripts/ring-shadow-regression.mjs
 * Requires Playwright Chromium (`npx playwright install chromium`).
 * Compares the actual shader with an 8x supersampled binary annulus, across
 * pixel ratios, projected sizes, Sun angles and subpixel camera offsets.
 * Also checks texture bands and rejected intersections. Browser errors fail the check.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { RING_SHADOW_FRAG_PARS } from '../packages/three/dist/RingShadow.js';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('http://ring-shadow.test/**', route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === 'three.module.js' || name === 'three.core.js') {
      return route.fulfill({
        contentType: 'text/javascript',
        body: readFileSync(new URL(`../node_modules/three/build/${name}`, import.meta.url), 'utf8'),
      });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Ring shadow regression</title>' });
  });
  await page.goto('http://ring-shadow.test/');
  const results = await page.evaluate(async shader => {
    const THREE = await import('/three.module.js');
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 2;
    const opaque = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    opaque.needsUpdate = true;
    const bandData = new Uint8Array(1024 * 4).fill(255);
    for (let x = 0; x < 1024; x++) {
      // One transparent gap and one translucent band within the annulus.
      if (x > 400 && x < 520) bandData[x * 4 + 3] = 0;
      if (x > 650 && x < 800) bandData[x * 4 + 3] = 128;
    }
    const bands = new THREE.DataTexture(bandData, 1024, 1);
    bands.minFilter = bands.magFilter = THREE.LinearFilter;
    bands.needsUpdate = true;
    const uniforms = {
      uSunWorldPos: { value: new THREE.Vector3() },
      uRingCenterWorld: { value: new THREE.Vector3() },
      uRingNormalWorld: { value: new THREE.Vector3(0, 0, 1) },
      uRingInnerRadius: { value: 0.7 }, uRingOuterRadius: { value: 1.2 },
      uRingMap: { value: opaque },
      span: { value: 2 }, receiverX: { value: 0 }, receiverZ: { value: -0.5 },
      tilt: { value: 0.15 },
    };
    const vertexShader = `
      uniform float span, receiverX, receiverZ, tilt;
      varying vec3 vShadowWorldPos;
      void main() {
        // Tilt and rotate the receiver footprint to exercise diagonal edges.
        vec2 p = vec2(position.x * 0.921 - position.y * 0.389,
                      position.x * 0.389 + position.y * 0.921) * span;
        vShadowWorldPos = vec3(p.x + receiverX, p.y * 0.65, receiverZ + p.y * tilt);
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`;
    function material(source) {
      return new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader: `
        uniform vec3 uSunWorldPos;
        varying vec3 vShadowWorldPos;
        ${source}
        void main() { gl_FragColor = vec4(vec3(computeRingShadow()), 1.0); }` });
    }
    const binarySource = shader.replace('return 1.0 - a * coverage;',
      'return (r < uRingInnerRadius || r > uRingOuterRadius) ? 1.0 : 1.0 - a;');
    const filtered = material(shader), binary = material(binarySource);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), filtered);
    scene.add(mesh);
    function render(mat, size) {
      const target = new THREE.WebGLRenderTarget(size, size);
      mesh.material = mat;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const pixels = new Uint8Array(size * size * 4);
      renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
      target.dispose();
      return pixels;
    }
    const cases = [];
    for (const span of [1.6, 2.5, 4]) {
      for (const dpr of [1, 2]) {
        for (const elevation of [10, 35, 70]) {
          const slope = 1 / Math.tan(elevation * Math.PI / 180);
          uniforms.span.value = span;
          uniforms.uSunWorldPos.value.set(10000 * slope, 0, 10000);
          const size = 128 * dpr;
          for (const offset of [0, 0.25, 0.5]) {
            uniforms.receiverX.value = -0.5 * slope + offset * 2 * span / size;
            const actual = render(filtered, size), old = render(binary, size);
            const reference = render(binary, size * 8);
            let newError = 0, oldError = 0;
            for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
              let mean = 0;
              for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
                mean += reference[((y * 8 + j) * size * 8 + x * 8 + i) * 4] / 64;
              }
              const index = (y * size + x) * 4;
              newError += Math.abs(actual[index] - mean);
              oldError += Math.abs(old[index] - mean);
            }
            cases.push({ span, dpr, elevation, offset, errorRatio: newError / oldError });
          }
        }
      }
    }
    // Check real texture sampling: away from the two boundaries the result
    // must match the binary shader exactly, including gaps and partial alpha.
    uniforms.uRingMap.value = bands;
    const detailed = render(filtered, 256), detailedOld = render(binary, 256);
    uniforms.uRingMap.value = opaque;
    const mask = render(filtered, 256);
    let interiorMismatches = 0, gapPixels = 0, translucentPixels = 0;
    for (let i = 0; i < mask.length; i += 4) {
      if (mask[i] !== 0) continue;
      if (detailed[i] !== detailedOld[i]) interiorMismatches++;
      if (detailed[i] === 255) gapPixels++;
      if (detailed[i] > 100 && detailed[i] < 150) translucentPixels++;
    }
    const rejected = [];
    uniforms.tilt.value = 0;
    for (const [name, sun, z] of [
      ['parallel', [10000, 0, -0.5], -0.5],
      ['behind', [0, 0, -10000], -0.5],
      ['past-sun', [0, 0, -0.25], -0.5],
      ['on-plane', [0, 0, 10000], 0],
      ['at-sun', [0, 0, 0], 0],
    ]) {
      if (name === 'at-sun') {
        uniforms.span.value = 0;
        uniforms.receiverX.value = 0;
      }
      uniforms.uSunWorldPos.value.set(...sun);
      uniforms.receiverZ.value = z;
      const pixels = render(filtered, 64);
      rejected.push({ name, allLit: pixels.every(v => v === 255) });
    }
    renderer.dispose();
    return { cases, interiorMismatches, gapPixels, translucentPixels, rejected };
  }, RING_SHADOW_FRAG_PARS);
  assert.deepEqual(errors, [], 'WebGL/browser errors');
  for (const c of results.cases) {
    assert.ok(c.errorRatio < 0.65, `coverage must improve supersampled error: ${JSON.stringify(c)}`);
  }
  assert.equal(results.interiorMismatches, 0, 'texture bands changed away from annulus edges');
  assert.ok(results.gapPixels > 0 && results.translucentPixels > 0, 'detailed bands must be exercised');
  for (const c of results.rejected) assert.ok(c.allLit, `${c.name} intersections must remain unshadowed`);
  console.log(JSON.stringify(results, null, 2));
  console.log('Ring shadow GPU regression passed.');
} finally {
  await browser.close();
}
