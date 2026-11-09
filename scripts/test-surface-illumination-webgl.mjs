/** Actual terrain-tile shader hook (#204) under real WebGL: neutral-albedo sloped
 * planes against analytic cos(incidence), illumination-baked imagery against
 * double-lighting, flood against slope shading, and program/variant counts.
 * CL_CHROMIUM=/usr/bin/chromium node scripts/test-surface-illumination-webgl.mjs
 * CL_ILLUM_OUTPUT=/tmp/surface-illumination selects the JSON/screenshot directory.
 * Software WebGL is repeatable acceptance evidence, not a hardware benchmark:
 * its timings are reported but carry no GPU or mobile claim.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.CL_ILLUM_OUTPUT ?? '/tmp/surface-illumination';
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root, logLevel: 'warn',
  server: { host: '127.0.0.1', port: 0 }, appType: 'custom' });
server.middlewares.use(async (req, res, next) => {
  if (req.url !== '/') return next();
  const html = await server.transformIndexHtml('/', `<link rel="icon" href="data:,"><canvas width="64" height="64"></canvas><script type="module">
    import * as THREE from 'three';
    import { injectAsIsDisplayIntoShader, injectOverlayAsIsIntoShader, declareSurfaceAsIs, createSurfaceAsIsUniforms, LIGHTING_MODES, applyLightingMode } from '/packages/three/src/SurfaceIllumination.ts';
    // The installed library's own overlay compositor (an internal module, loaded from the package source).
    import { wrapOverlaysMaterial } from '/node_modules/3d-tiles-renderer/src/three/plugins/images/overlays/wrapOverlaysMaterial.js';
    window.illumTest = { THREE, injectAsIsDisplayIntoShader, injectOverlayAsIsIntoShader, wrapOverlaysMaterial, declareSurfaceAsIs, createSurfaceAsIsUniforms, LIGHTING_MODES, applyLightingMode };
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
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.illumTest);
  const result = await page.evaluate(() => {
    const { THREE, injectAsIsDisplayIntoShader, injectOverlayAsIsIntoShader, wrapOverlaysMaterial, declareSurfaceAsIs, createSurfaceAsIsUniforms, LIGHTING_MODES, applyLightingMode } = window.illumTest;
    const canvas = document.querySelector('canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // linear readback
    renderer.toneMapping = THREE.NoToneMapping;
    const gl = renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Float readback unavailable');
    const target = new THREE.WebGLRenderTarget(64, 64, { type: THREE.FloatType });
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.set(0, 0, 3);
    const deg = d => d * Math.PI / 180;
    const asIsUniforms = createSurfaceAsIsUniforms('flood'); // flood: terminator gate off

    /** The production material: lit Standard material + the as-is hook. */
    function tileMaterial(albedo) {
      const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      map.needsUpdate = true;
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(albedo, albedo, albedo), map, roughness: 1, metalness: 0 });
      m.onBeforeCompile = shader => injectAsIsDisplayIntoShader(shader, asIsUniforms);
      m.customProgramCacheKey = () => '_illum_v1';
      return m;
    }
    /** Mean linear red of the centre of a plane tilted `slope` toward +X, Sun at `elevation` above +X. */
    function shade({ albedo = 0.5, slope, elevation, mode = 'natural', asIs = 0, material }) {
      const scene = new THREE.Scene();
      const ambient = new THREE.AmbientLight();
      const sun = new THREE.DirectionalLight();
      scene.add(ambient, sun, sun.target);
      applyLightingMode(mode, ambient, sun);
      // Surface frame: up=+Z, tilt about Y so the normal leans toward +X.
      sun.position.set(Math.cos(deg(elevation)), 0, Math.sin(deg(elevation))).multiplyScalar(5);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material ?? tileMaterial(albedo));
      mesh.rotation.y = deg(slope);
      scene.add(mesh);
      // View along the plane's own normal so every case covers the same pixels.
      camera.position.set(Math.sin(deg(slope)), 0, Math.cos(deg(slope))).multiplyScalar(3);
      camera.lookAt(0, 0, 0);
      asIsUniforms.surfaceAsIs.value = asIs;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const px = new Float32Array(64 * 64 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 64, 64, px);
      renderer.setRenderTarget(null);
      let sum = 0, n = 0;
      for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) { sum += px[(y * 64 + x) * 4]; n++; }
      return sum / n;
    }

    const out = { gpu, cases: [], baked: {}, flood: {}, programs: {}, timing: {}, perPixel: {}, overlayPlugin: {}, terminator: {} };
    // 1. Neutral-albedo sloped planes vs analytic cos(incidence), normalised to normal incidence.
    const reference = shade({ slope: 0, elevation: 90 });
    for (const slope of [-40, 0, 25, 60]) for (const elevation of [10, 35, 70]) {
      const value = shade({ slope, elevation });
      // The diffuse term is the whole signal at roughness 1 plus a small specular floor.
      const analytic = Math.max(0, Math.cos(deg(90 - elevation - slope)));
      out.cases.push({ slope, elevation, measured: value / reference, analytic });
    }
    // 2. Illumination-baked: identical with the Sun on or off, whatever the slope; relit is not.
    const backFacing = { slope: -60, elevation: 10 };
    out.baked.relitBackFacing = shade({ ...backFacing, asIs: 0 }) ;
    out.baked.asIsBackFacing = shade({ ...backFacing, asIs: 1 });
    out.baked.asIsFacing = shade({ slope: 25, elevation: 70, asIs: 1 });
    out.baked.asIsFlood = shade({ slope: 25, elevation: 70, asIs: 1, mode: 'flood' });
    out.baked.albedoRadiance = 0.5; // linear albedo of the fixture
    // 3. Flood: no direct term, so slope and Sun elevation cannot change the image.
    out.flood.values = [[-40, 10], [0, 90], [60, 35]].map(([slope, elevation]) => shade({ slope, elevation, mode: 'flood' }));
    // 4. Program variants: relit and baked tiles share one program.
    // Every shade() above used a fresh tile material in all modes, relit and as-is.
    const a = tileMaterial(0.5), b = tileMaterial(0.3);
    shade({ slope: 0, elevation: 45, material: a, asIs: 0 });
    shade({ slope: 0, elevation: 45, material: b, asIs: 1 });
    out.programs.total = renderer.info.programs.length;
    // 6. Per-pixel provenance (#204): one plane, left half a relit layer, right half a baked layer, blended by
    // the same `surfaceAsIs = mix(surfaceAsIs, layerWeight, alpha)` the cube and overlay compositors emit.
    const halfMaterial = (rightAlpha) => {
      const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      map.needsUpdate = true;
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.5, 0.5, 0.5), map, roughness: 1, metalness: 0 });
      m.onBeforeCompile = shader => {
        declareSurfaceAsIs(shader);
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
          `#include <map_fragment>\n{ float a = step(0.5, vMapUv.x) * ${rightAlpha.toFixed(2)}; surfaceAsIsLayer(diffuseColor.rgb, diffuseColor.rgb * a, 1.0, a); }`);
        injectAsIsDisplayIntoShader(shader, createSurfaceAsIsUniforms('flood'));
      };
      m.customProgramCacheKey = () => '_illum_half_' + rightAlpha;
      return m;
    };
    const readHalves = (material) => {
      const scene = new THREE.Scene();
      const ambient = new THREE.AmbientLight(), sun = new THREE.DirectionalLight();
      scene.add(ambient, sun, sun.target);
      applyLightingMode('natural', ambient, sun);
      sun.position.set(Math.cos(deg(10)), 0, Math.sin(deg(10))).multiplyScalar(5); // grazing: relit is dim
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
      camera.position.set(0, 0, 3); camera.lookAt(0, 0, 0);
      renderer.setRenderTarget(target); renderer.render(scene, camera);
      const px = new Float32Array(64 * 64 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 64, 64, px); renderer.setRenderTarget(null);
      const mean = (x0, x1) => { let sum = 0, n = 0; for (let y = 24; y < 40; y++) for (let x = x0; x < x1; x++) { sum += px[(y * 64 + x) * 4]; n++; } return sum / n; };
      return { left: mean(10, 22), right: mean(42, 54) };
    };
    out.perPixel = { opaque: readHalves(halfMaterial(1)), half: readHalves(halfMaterial(0.5)) };
    // 6b. The real ImageOverlayPlugin compositor (3d-tiles-renderer's own wrapOverlaysMaterial and LayerInfo
    // struct), with real layerMaps textures and layerInfo objects, as the plugin supplies them: a relit layer
    // covering the plane and a baked layer covering its right half. The per-layer `asIs` is uploaded by member
    // name from the overlay object, so this fails if the struct patch or the upload does not work on a GPU.
    const overlayMaterial = (bakedWeight, bakedOpacity) => {
      const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
      const params = wrapOverlaysMaterial(m, undefined);
      const wrapped = m.onBeforeCompile;
      const uniforms = createSurfaceAsIsUniforms('flood');
      m.onBeforeCompile = shader => { wrapped(shader); injectOverlayAsIsIntoShader(shader); injectAsIsDisplayIntoShader(shader, uniforms); };
      m.defines.LAYER_COUNT = 2;
      m.customProgramCacheKey = () => '_overlay_gl_' + bakedWeight + '_' + bakedOpacity;
      const full = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); full.needsUpdate = true;
      const right = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0, 128, 128, 128, 255]), 2, 1); right.magFilter = THREE.NearestFilter; right.needsUpdate = true;
      params.layerMaps.value = [full, right];
      params.layerInfo.value = [
        { color: new THREE.Color(1, 1, 1), opacity: 1, alphaMask: 0, alphaInvert: 0, asIs: 0 },
        { color: new THREE.Color(1, 1, 1), opacity: bakedOpacity, alphaMask: 0, alphaInvert: 0, asIs: bakedWeight },
      ];
      return m;
    };
    const overlayGeometry = new THREE.PlaneGeometry(2, 2);
    for (const name of ['layer_uv_0', 'layer_uv_1']) {
      const uv = overlayGeometry.getAttribute('uv'), a = new Float32Array(uv.count * 3);
      for (let i = 0; i < uv.count; i++) { a[3 * i] = uv.getX(i); a[3 * i + 1] = uv.getY(i); a[3 * i + 2] = 0.5; }
      overlayGeometry.setAttribute(name, new THREE.BufferAttribute(a, 3));
    }
    const readOverlay = (material) => {
      const scene = new THREE.Scene();
      const ambient = new THREE.AmbientLight(), sun = new THREE.DirectionalLight();
      scene.add(ambient, sun, sun.target, new THREE.Mesh(overlayGeometry, material));
      applyLightingMode('natural', ambient, sun);
      sun.position.set(Math.cos(deg(10)), 0, Math.sin(deg(10))).multiplyScalar(5);
      camera.position.set(0, 0, 3); camera.lookAt(0, 0, 0);
      renderer.setRenderTarget(target); renderer.render(scene, camera);
      const px = new Float32Array(64 * 64 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 64, 64, px); renderer.setRenderTarget(null);
      const mean = (x0, x1) => { let sum = 0, n = 0; for (let y = 24; y < 40; y++) for (let x = x0; x < x1; x++) { sum += px[(y * 64 + x) * 4]; n++; } return sum / n; };
      return { left: mean(10, 22), right: mean(42, 54) };
    };
    out.overlayPlugin = { baked: readOverlay(overlayMaterial(1, 1)), relit: readOverlay(overlayMaterial(0, 1)), half: readOverlay(overlayMaterial(1, 0.5)) };
    // 6c. Partial-opacity compositing against a quantitative reference (the library's real overlay compositor,
    // the real hooks). Blending the layers' own renderings is the truth: each layer is rendered ALONE at full
    // opacity (a baked one as-is, a relit one Sun-lit), then folded bottom to top with the same alphas as the
    // stack. The stack rendered in one pass must match; so must 0 %, 50 % and 100 % opacity, different layer
    // colours and several Sun angles. The earlier formulation (blend the colours, then one baked weight) is
    // evaluated from the same renders to show it differs.
    const stackGeometry = new THREE.PlaneGeometry(2, 2);
    for (let k = 0; k < 4; k++) {
      const uv = stackGeometry.getAttribute('uv'), a = new Float32Array(uv.count * 3);
      for (let i = 0; i < uv.count; i++) { a[3 * i] = uv.getX(i); a[3 * i + 1] = uv.getY(i); a[3 * i + 2] = 0.5; }
      stackGeometry.setAttribute('layer_uv_' + k, new THREE.BufferAttribute(a, 3));
    }
    const rgbOf = (px, x0, x1) => { const m = [0, 0, 0]; let n = 0; for (let y = 24; y < 40; y++) for (let x = x0; x < x1; x++) { for (let c = 0; c < 3; c++) m[c] += px[(y * 64 + x) * 4 + c]; n++; } return m.map(v => v / n); };
    /** base: {color,asIs}; layers: [{color,asIs,alpha}]; one plane, Sun at `elevation` (deg). Returns mean linear RGB. */
    const renderStack = (base, layers, elevation) => {
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(...base.color), roughness: 1, metalness: 0 });
      const params = wrapOverlaysMaterial(m, undefined);
      const wrapped = m.onBeforeCompile;
      const uniforms = createSurfaceAsIsUniforms('flood'); // flood: gate off, so the compositing alone is measured
      uniforms.surfaceAsIs.value = base.asIs;
      m.onBeforeCompile = shader => { wrapped(shader); injectOverlayAsIsIntoShader(shader); injectAsIsDisplayIntoShader(shader, uniforms); };
      m.defines.LAYER_COUNT = layers.length;
      m.customProgramCacheKey = () => '_stack_gl_' + layers.length;
      // Coverage is the texture's alpha channel (as for a real tile with partial coverage), opacity stays 1: the
      // library scales a layer's colour by its opacity twice (see 'libraryOpacity'), which is its own and applies to
      // relit-only stacks alike.
      params.layerMaps.value = layers.map(l => { const t = new THREE.DataTexture(new Uint8Array([...l.color.map(v => Math.round(v * 255)), Math.round(l.alpha * 255)]), 1, 1); t.needsUpdate = true; return t; });
      params.layerInfo.value = layers.map(l => ({ color: new THREE.Color(1, 1, 1), opacity: l.opacity ?? 1, alphaMask: 0, alphaInvert: 0, asIs: l.asIs }));
      const scene = new THREE.Scene();
      const ambient = new THREE.AmbientLight(), sun = new THREE.DirectionalLight();
      scene.add(ambient, sun, sun.target, new THREE.Mesh(stackGeometry, m));
      applyLightingMode('natural', ambient, sun);
      sun.position.set(Math.cos(deg(elevation)), 0, Math.sin(deg(elevation))).multiplyScalar(5);
      camera.position.set(0, 0, 3); camera.lookAt(0, 0, 0);
      renderer.setRenderTarget(target); renderer.render(scene, camera);
      const px = new Float32Array(64 * 64 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 64, 64, px); renderer.setRenderTarget(null);
      return rgbOf(px, 24, 40);
    };
    const mix3 = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
    const baseGrey = [0.55, 0.5, 0.45];
    const stackSpecs = [
      { name: 'relit over relit base, baked colour A', base: { color: baseGrey, asIs: 0 }, layers: [{ color: [0.2, 0.6, 0.9], asIs: 1 }] },
      { name: 'baked over baked base, relit colour B', base: { color: baseGrey, asIs: 1 }, layers: [{ color: [0.9, 0.35, 0.1], asIs: 0 }] },
      { name: 'three layers: baked / relit / baked', base: { color: baseGrey, asIs: 0 }, layers: [{ color: [0.8, 0.2, 0.2], asIs: 1 }, { color: [0.1, 0.7, 0.3], asIs: 0 }, { color: [0.3, 0.3, 0.95], asIs: 1 }] },
      { name: 'three layers: relit / baked / relit, baked base', base: { color: baseGrey, asIs: 1 }, layers: [{ color: [0.9, 0.9, 0.2], asIs: 0 }, { color: [0.1, 0.4, 0.8], asIs: 1 }, { color: [0.7, 0.1, 0.6], asIs: 0 }] },
    ];
    const alphaSets = [[0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5], [0.3, 0.6, 0.5], [0.2, 0, 0.8], [1, 0, 1]];
    out.stacking = { worst: 0, oldWorst: 0, cases: [] };
    for (const spec of stackSpecs) for (const alphas of alphaSets) for (const elevation of [10, 45, 80]) {
      const layers = spec.layers.map((l, i) => ({ ...l, alpha: Math.round(alphas[i] * 255) / 255 })); // what an 8-bit alpha holds
      const stacked = renderStack(spec.base, layers, elevation);
      // The truth: each layer rendered alone, folded with the stack's alphas.
      let ref = renderStack(spec.base, [], elevation);
      layers.forEach(l => { ref = mix3(ref, renderStack(spec.base, [{ ...l, alpha: 1 }], elevation), l.alpha); });
      // The earlier formulation: blended colour lit as one, then mixed by the blended baked weight.
      let D = spec.base.color, W = spec.base.asIs;
      layers.forEach(l => { D = mix3(D, l.color, l.alpha); W = W * (1 - l.alpha) + l.asIs * l.alpha; });
      const lit = renderStack({ color: D, asIs: 0 }, [], elevation);
      const old = lit.map((v, i) => v * (1 - W) + D[i] * W);
      const err = Math.max(...stacked.map((v, i) => Math.abs(v - ref[i])));
      const oldErr = Math.max(...old.map((v, i) => Math.abs(v - ref[i])));
      out.stacking.worst = Math.max(out.stacking.worst, err);
      out.stacking.oldWorst = Math.max(out.stacking.oldWorst, oldErr);
      out.stacking.cases.push({ stacked, ref, old, spec: spec.name, alphas: alphas.slice(0, layers.length), elevation, err, oldErr });
    }
    // Informational: the library's own opacity (not coverage) is applied to a layer's colour twice, whatever the
    // provenance: a relit-only layer at opacity 0.5 over a relit base is not the 50 % blend of the two renderings.
    {
      const lay = { color: [0.2, 0.6, 0.9], asIs: 0 };
      const half = renderStack({ color: baseGrey, asIs: 0 }, [{ ...lay, alpha: 1, opacity: 0.5 }], 45);
      const want = mix3(renderStack({ color: baseGrey, asIs: 0 }, [], 45), renderStack({ color: baseGrey, asIs: 0 }, [{ ...lay, alpha: 1 }], 45), 0.5);
      out.libraryOpacity = { got: half, fiftyPercentBlend: want, maxDiff: Math.max(...half.map((v, i) => Math.abs(v - want[i]))) };
    }
    // 7. Terminator gate: baked pixels go to the mode's night floor when the Sun is below the body's local horizon.
    const gated = (elevationDeg, mode) => {
      const uniforms = createSurfaceAsIsUniforms(mode);
      uniforms.surfaceAsIs.value = 1;
      const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      map.needsUpdate = true;
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.5, 0.5, 0.5), map, roughness: 1, metalness: 0 });
      m.onBeforeCompile = shader => injectAsIsDisplayIntoShader(shader, uniforms);
      m.customProgramCacheKey = () => '_illum_gate';
      const scene = new THREE.Scene();
      const ambient = new THREE.AmbientLight(), sun = new THREE.DirectionalLight();
      scene.add(ambient, sun, sun.target);
      applyLightingMode(mode, ambient, sun);
      // Body centre at the origin, surface point at +Z (local up = +Z); the Sun at `elevationDeg` above the +X horizon.
      sun.position.set(Math.cos(deg(elevationDeg)), 0, Math.sin(deg(elevationDeg))).multiplyScalar(5);
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
      plane.position.set(0, 0, 100);
      scene.add(plane);
      camera.position.set(0, 0, 103); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
      uniforms.centerView.value.set(0, 0, 0).applyMatrix4(camera.matrixWorldInverse);
      renderer.setRenderTarget(target); renderer.render(scene, camera);
      const px = new Float32Array(64 * 64 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 64, 64, px); renderer.setRenderTarget(null);
      let sum = 0, n = 0;
      for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) { sum += px[(y * 64 + x) * 4]; n++; }
      return sum / n;
    };
    out.terminator = { dayNatural: gated(30, 'natural'), nightNatural: gated(-20, 'natural'), nightShadow: gated(-20, 'shadow'), nightFlood: gated(-20, 'flood'), grazing: gated(0.2, 'natural') };
    // 5. Software-GL timing, unrepresentative of any GPU: hook vs plain Standard material.
    const plain = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
    const time = (material) => {
      shade({ slope: 10, elevation: 40, material }); // warm / compile
      const t = performance.now();
      for (let i = 0; i < 40; i++) shade({ slope: 10, elevation: 40, material });
      return (performance.now() - t) / 40;
    };
    out.timing = { plainMs: time(plain), hookMs: time(a), note: 'software WebGL; no GPU/mobile claim' };
    canvas.getContext; // keep canvas referenced for screenshot
    return out;
  });
  assert.deepEqual(errors, [], 'no page or console errors');
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2));

  // 1. Analytic incidence. Tolerance covers the roughness-1 specular floor.
  for (const c of result.cases) {
    assert.ok(Math.abs(c.measured - c.analytic) < 0.04, `incidence slope ${c.slope} elev ${c.elevation}: measured ${c.measured.toFixed(4)} vs ${c.analytic.toFixed(4)}`);
  }
  const facing = result.cases.find(c => c.slope === 25 && c.elevation === 35).measured;
  const flat = result.cases.find(c => c.slope === 0 && c.elevation === 35).measured;
  const away = result.cases.find(c => c.slope === -40 && c.elevation === 35).measured;
  assert.ok(facing > flat && flat > away, 'facing slope brighter than flat brighter than back-facing');
  assert.ok(result.cases.find(c => c.slope === -40 && c.elevation === 10).measured < 0.04, 'past the terminator is dark');
  // 2. Baked.
  const { relitBackFacing, asIsBackFacing, asIsFacing, asIsFlood } = result.baked;
  assert.ok(relitBackFacing < 0.03, `relit back-facing slope is dark: ${relitBackFacing}`);
  assert.ok(Math.abs(asIsBackFacing - 0.5) < 1e-3 && Math.abs(asIsFacing - 0.5) < 1e-3 && Math.abs(asIsFlood - 0.5) < 1e-3,
    `baked imagery shows its own pixels regardless of slope, Sun and mode: ${asIsBackFacing}, ${asIsFacing}, ${asIsFlood}`);
  // 3. Flood is slope independent but visibly not physical (uniform, bright).
  const [f0, f1, f2] = result.flood.values;
  assert.ok(Math.abs(f0 - f1) < 1e-4 && Math.abs(f1 - f2) < 1e-4, `flood is slope independent: ${result.flood.values}`);
  // 5. Per-pixel provenance: the baked half shows its own albedo exactly, the relit half is lit by the grazing Sun.
  const { opaque, half } = result.perPixel;
  assert.ok(Math.abs(opaque.right - 0.5) < 1e-3, `a baked layer is shown as-is inside its footprint: ${opaque.right}`);
  assert.ok(opaque.left < 0.1 && opaque.left < opaque.right * 0.25, `the relit layer beside it stays Sun-lit (dim at 10 deg): ${opaque.left}`);
  assert.ok(half.right > opaque.left && half.right < opaque.right, `a half-opaque baked layer is half as-is: ${half.right}`);
  // 5b. The real overlay compositor: the baked layer is as-is on its half, the relit layer is lit on the other,
  // an all-relit stack is lit everywhere, and a half-opaque baked layer lands between.
  const o = result.overlayPlugin;
  assert.ok(Math.abs(o.baked.right - 128 / 255) < 1e-3, `baked overlay half shows its own texel (128/255): ${o.baked.right}`);
  assert.ok(o.baked.left < 0.1 && o.baked.left < o.baked.right * 0.25, `the relit layer beside it stays Sun-lit: ${o.baked.left}`);
  assert.ok(Math.abs(o.relit.left - o.baked.left) < 1e-4 && Math.abs(o.relit.right - o.baked.left) < 1e-4, `an all-relit stack is lit everywhere: ${o.relit.left}, ${o.relit.right}`);
  assert.ok(o.half.right > o.baked.left && o.half.right < o.baked.right, `a half-opaque baked layer is half as-is: ${o.half.right}`);
  // 5c. Partial opacity matches the blend of the individually rendered layers.
  const st = result.stacking;
  assert.ok(st.worst < 2e-3, `stacked compositing matches the blend of individually rendered layers: worst error ${st.worst}`);
  assert.ok(st.oldWorst > 0.03, `the colour-then-weight formulation would have differed (sanity): ${st.oldWorst}`);
  // 6. Terminator gate: Sun up = as-is; Sun below the local horizon = the mode's floor; flood never gates.
  const t = result.terminator;
  assert.ok(Math.abs(t.dayNatural - 0.5) < 1e-3, `Sun up: baked shown as-is: ${t.dayNatural}`);
  assert.ok(Math.abs(t.nightNatural - 0.5 * 8 / 255) < 1e-3, `natural night floor: ${t.nightNatural}`);
  assert.ok(Math.abs(t.nightShadow - 0.5 * 0x55 / 255) < 1e-3, `shadow night floor: ${t.nightShadow}`);
  assert.ok(Math.abs(t.nightFlood - 0.5) < 1e-3, `flood is uniform: ${t.nightFlood}`);
  assert.ok(t.grazing > t.nightNatural && t.grazing < t.dayNatural, `the terminator is a short ramp, not a step: ${t.grazing}`);
  // 4. One program.
  assert.equal(result.programs.total, 1, 'relit, baked and flood tiles all share one program');
  console.log(JSON.stringify({ gpu: result.gpu, cases: result.cases.length, programs: result.programs.total, timing: result.timing }, null, 2));
  // Evidence sheet: synthetic ridge, real shaders, software WebGL. Rows are lighting
  // paths, columns are Sun elevations at azimuth 90 deg (east). No mission epoch applies.
  const sheet = await page.evaluate(() => {
    const { THREE, injectAsIsDisplayIntoShader, createSurfaceAsIsUniforms, applyLightingMode } = window.illumTest;
    const W = 230, H = 150, cols = [8, 25, 60];
    const rows = [
      { label: 'BEFORE: ambient-only', mode: 'flood', asIs: 0, ambientOnly: true, prov: 'legacy tile pass' },
      { label: 'natural, reflectance (relit)', mode: 'natural', asIs: 0, prov: 'reflectance' },
      { label: 'natural, unknown (legacy relit)', mode: 'natural', asIs: 0, prov: 'unknown' },
      { label: 'natural, baked (as-is, not relit)', mode: 'natural', asIs: 1, prov: 'baked' },
      { label: 'shadow (nonphysical aid)', mode: 'shadow', asIs: 0, prov: 'reflectance' },
      { label: 'flood (nonphysical aid)', mode: 'flood', asIs: 0, prov: 'reflectance' },
    ];
    const out = document.createElement('canvas');
    out.width = W * cols.length + 190; out.height = H * rows.length + 56;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, out.width, out.height);
    ctx.fillStyle = '#ddd'; ctx.font = '12px sans-serif';
    ctx.fillText('Synthetic neutral-albedo ridge fixture (no mission epoch). Sun azimuth 90 deg (east); software WebGL, shader hook from SurfaceIllumination.ts', 8, 16);
    ctx.fillText('Ridge crest runs N-S; east flank faces the Sun, west flank faces away. Unlit baked texture is a checker of fixed albedo.', 8, 32);
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.toneMapping = THREE.NoToneMapping;
    const geometry = new THREE.PlaneGeometry(4, 3, 96, 72);
    const pos = geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      pos.setZ(i, Math.max(0, 0.9 - Math.abs(x) * 0.75) + 0.05 * Math.sin(y * 4) * Math.cos(x * 5));
    }
    geometry.computeVertexNormals();
    const tex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? '#b9b3a6' : '#8d887d'; g.fillRect(x * 8, y * 8, 8, 8); }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
    const asIs = createSurfaceAsIsUniforms('flood');
    const material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 });
    material.onBeforeCompile = sh => injectAsIsDisplayIntoShader(sh, asIs);
    material.customProgramCacheKey = () => '_illum_v1';
    const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 50);
    camera.up.set(0, 0, 1); camera.position.set(0, -4.2, 3); camera.lookAt(0, 0, 0.3);
    rows.forEach((row, r) => cols.forEach((elevation, c) => {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x000000);
      const ambient = new THREE.AmbientLight(), sun = new THREE.DirectionalLight();
      scene.add(ambient, sun, sun.target, new THREE.Mesh(geometry, material));
      applyLightingMode(row.mode, ambient, sun);
      if (row.ambientOnly) sun.intensity = 0;
      const e = elevation * Math.PI / 180;
      sun.position.set(Math.cos(e), 0, Math.sin(e)).multiplyScalar(6);
      asIs.surfaceAsIs.value = row.asIs;
      renderer.render(scene, camera);
      ctx.drawImage(canvas, 190 + c * W, 44 + r * H);
      ctx.fillStyle = '#fff'; ctx.fillText(`Sun el ${elevation}\u00b0 az 90\u00b0`, 196 + c * W, 58 + r * H);
    }));
    rows.forEach((row, r) => {
      ctx.fillStyle = '#fff'; ctx.fillText(row.label, 6, 64 + r * H);
      ctx.fillStyle = '#9ad'; ctx.fillText(`mode: ${row.mode}`, 6, 80 + r * H);
      ctx.fillText(`provenance: ${row.prov}`, 6, 96 + r * H);
    });
    return out.toDataURL('image/png');
  });
  await writeFile(`${output}/ridge-lighting-sheet.png`, Buffer.from(sheet.split(',')[1], 'base64'));
  await page.screenshot({ path: `${output}/last-frame.png` });
} finally {
  await browser?.close();
  await server.close();
}
