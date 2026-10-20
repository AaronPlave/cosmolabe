#!/usr/bin/env node
// GPU regression for PR #203: separate observer LUTs, star fade, stitched DDS mips.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${process.env.CL_VIEWER_URL ?? 'http://localhost:5173'}/?catalog=test-catalogs/atmosphere-earth&test=1`);
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, { timeout: 120000 });
  const result = await page.evaluate(async () => {
    const r = window.renderer;
    r.stop();
    r.cameraController.cancelAnimation();
    r.renderFrame();
    const earth = r.getBodyMesh('Earth');
    const atm = r.atmosphereMeshes.get('Earth').atm;
    const sun = r.getBodyMesh('Sun').position;
    const direction = sun.clone().sub(earth.position).normalize();
    const instrument = r.camera.clone();
    instrument.position.copy(earth.position).addScaledVector(direction, (earth.displayRadius + 2) * r.scaleFactor);
    instrument.lookAt(sun);
    const oldInstrument = r.instrumentView;
    const oldStars = r.starField;
    // Test mode disables stars; record the same brightness input used by their shader.
    let brightness = 0;
    r.starField = { setSkyBrightness: value => { brightness = value; } };
    const passes = [];
    r.instrumentView = { camera: instrument, render(renderer, scene) {
      passes.push({ brightness, expected: atm.getDaytimeSkyBrightness() });
      renderer.render(scene, instrument);
    } };
    const states = [];
    try {
      for (const inside of [false, true]) {
        r.camera.position.copy(earth.position).addScaledVector(direction,
          (earth.displayRadius + (inside ? 5 : 500)) * r.scaleFactor);
        r.camera.lookAt(sun);
        const mainBrightness = r.updateAtmospheres(r.camera);
        r.starField.setSkyBrightness(mainBrightness);
        const texture = atm.material.uniforms.uSkyViewLUT.value;
        const mainVersion = atm._skyView.target.texture.version;
        const pixels = new Uint16Array(192 * 108 * 4);
        if (inside) r.renderer.readRenderTargetPixels(atm._skyView.target, 0, 0, 192, 108, pixels);
        let lutDraws = 0;
        const render = r.renderer.render;
        r.renderer.render = function(scene, camera) {
          if (scene === atm._skyView.scene || scene === atm._instrumentSkyView?.scene) lutDraws++;
          return render.call(this, scene, camera);
        };
        try { r.renderInstrumentScene(); } finally { r.renderer.render = render; }
        const after = new Uint16Array(pixels.length);
        if (inside) r.renderer.readRenderTargetPixels(atm._skyView.target, 0, 0, 192, 108, after);
        states.push({ inside, mainBrightness, restoredBrightness: brightness, lutDraws,
          textureRestored: texture === atm.material.uniforms.uSkyViewLUT.value,
          pixelsUnchanged: pixels.every((v, i) => v === after[i]),
          mainVersionUnchanged: mainVersion === atm._skyView.target.texture.version });
      }
    } finally { r.instrumentView = oldInstrument; r.starField = oldStars; }

    // DXT1 checker tiles. Generate output mips from the full two-tile image.
    const size = 64;
    const buffer = new ArrayBuffer(128 + size * size / 2);
    const header = new Int32Array(buffer, 0, 32);
    header[0] = 0x20534444; header[1] = 124; header[2] = 0x21007;
    header[3] = header[4] = size; header[7] = 1;
    header[19] = 32; header[20] = 4; header[21] = 0x31545844; header[27] = 0x401008;
    const bytes = new DataView(buffer);
    for (let block = 0; block < size * size / 16; block++) {
      bytes.setUint16(128 + block * 8, (block + Math.floor(block / 16)) % 2 ? 0xffff : 0, true);
    }
    const url = URL.createObjectURL(new Blob([buffer]));
    try {
      await earth.loadTiledBaseMap([url, url], r.renderer);
    } finally { URL.revokeObjectURL(url); }
    const map = earth.mesh.material.map;
    // Read the generated last mip directly from its framebuffer attachment.
    // The 1x1 sample must average both bright and dark source blocks.
    const gl = r.renderer.getContext();
    const texture = r.renderer.properties.get(map).__webglTexture;
    const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 7);
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
    gl.deleteFramebuffer(framebuffer);
    return { states, passes, stitched: { generateMipmaps: map.generateMipmaps, minFilter: map.minFilter,
      pixel: [...pixel], complete: status === gl.FRAMEBUFFER_COMPLETE }, glError: gl.getError() };
  });
  for (const state of result.states) {
    assert.equal(state.restoredBrightness, state.mainBrightness);
    assert.equal(state.textureRestored, true);
    assert.equal(state.pixelsUnchanged, true);
    assert.equal(state.mainVersionUnchanged, true);
    assert.equal(state.lutDraws, 1, 'instrument integrates once; restoration integrates zero times');
  }
  assert.equal(result.states[0].mainBrightness, 0);
  for (const pass of result.passes) {
    assert.ok(pass.brightness > 0);
    assert.equal(pass.brightness, pass.expected);
  }
  assert.equal(result.stitched.generateMipmaps, true);
  assert.equal(result.stitched.minFilter, 1008); // LinearMipmapLinearFilter
  assert.equal(result.stitched.complete, true);
  assert.ok(result.stitched.pixel[0] > 50 && result.stitched.pixel[0] < 205, JSON.stringify(result.stitched));
  assert.equal(result.glError, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
