#!/usr/bin/env node
// Paired high-fill frame timings with only incident solar extinction toggled.
// Includes CPU submission and a one-pixel GPU readback; excludes PNG encoding.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 384 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('THREE.WebGLProgram')) errors.push(message.text());
  });
  await page.goto(`${process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5174'}/?catalog=atmosphere-earth-textured&test=1`);
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, { timeout: 120000 });
  const result = await page.evaluate(() => {
    const r = window.renderer;
    if (window.__cosmolabe.assetSummary.failed) throw new Error('Profile scene has failed assets');
    r.stop(); r.setLabelsVisible(false);
    window.__cosmolabe.capture('Orbit 400 km');
    const mat = r.getBodyMesh('Earth').mesh.material;
    const original = mat.onBeforeCompile.bind(mat);
    const gl = r.renderer.getContext();
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const pixel = new Uint8Array(4);
    const renderSync = () => {
      r.renderFrame();
      // Chrome can queue gl.finish() without waiting for GPU completion.
      // Reading an actual rendered pixel forces a round trip to the GPU.
      gl.readPixels(Math.floor(width / 2), Math.floor(height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    };
    const frames = { prior: [], solar: [] };
    const blocks = [];
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    for (let block = 0; block < 4; block++) {
      const pair = {};
      // Alternate mode order to reduce bias from warmup or thermal drift.
      for (const enabled of block % 2 ? [true, false] : [false, true]) {
        mat.onBeforeCompile = (shader, renderer) => {
          original(shader, renderer);
          if (!enabled) shader.fragmentShader = shader.fragmentShader.replace(
            'directLight.color *= computeSurfaceSunTransmittance(vAPWorldPos);', '');
        };
        mat.customProgramCacheKey = () => `profile-solar-${enabled}`;
        mat.needsUpdate = true;
        // Exclude recompilation and first draws, but synchronize each frame.
        for (let i = 0; i < 4; i++) renderSync();
        const times = [];
        for (let i = 0; i < 8; i++) {
          const start = performance.now(); renderSync();
          times.push(performance.now() - start);
        }
        const key = enabled ? 'solar' : 'prior';
        frames[key].push(...times); pair[key] = median(times);
      }
      blocks.push(pair);
    }
    // Establish that the controlled globe really fills the viewport.
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4) if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 10) lit++;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const priorMs = median(frames.prior), solarMs = median(frames.solar);
    return { viewport: [width, height], viewpoint: 'Earth Orbit 400 km', litFraction: lit / (width * height),
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      framesPerMode: frames.prior.length, blocks, priorMs, solarMs,
      deltaMs: solarMs - priorMs, deltaPercent: 100 * (solarMs / priorMs - 1) };
  });
  assert.deepEqual(errors, [], 'Profile encountered shader/page errors');
  assert.ok(result.litFraction > 0.9, `Expected high-fill globe: ${result.litFraction}`);
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
