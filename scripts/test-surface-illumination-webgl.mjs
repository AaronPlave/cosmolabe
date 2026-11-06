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
    import { injectAsIsDisplayIntoShader, LIGHTING_MODES, applyLightingMode } from '/packages/three/src/SurfaceIllumination.ts';
    window.illumTest = { THREE, injectAsIsDisplayIntoShader, LIGHTING_MODES, applyLightingMode };
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
    const { THREE, injectAsIsDisplayIntoShader, LIGHTING_MODES, applyLightingMode } = window.illumTest;
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
    const asIsUniform = { value: 0 };

    /** The production material: lit Standard material + the as-is hook. */
    function tileMaterial(albedo) {
      const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      map.needsUpdate = true;
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(albedo, albedo, albedo), map, roughness: 1, metalness: 0 });
      m.onBeforeCompile = shader => injectAsIsDisplayIntoShader(shader, asIsUniform);
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
      asIsUniform.value = asIs;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const px = new Float32Array(64 * 64 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 64, 64, px);
      renderer.setRenderTarget(null);
      let sum = 0, n = 0;
      for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) { sum += px[(y * 64 + x) * 4]; n++; }
      return sum / n;
    }

    const out = { gpu, cases: [], baked: {}, flood: {}, programs: {}, timing: {} };
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
  // 4. One program.
  assert.equal(result.programs.total, 1, 'relit, baked and flood tiles all share one program');
  console.log(JSON.stringify({ gpu: result.gpu, cases: result.cases.length, programs: result.programs.total, timing: result.timing }, null, 2));
  // Evidence sheet: synthetic ridge, real shaders, software WebGL. Rows are lighting
  // paths, columns are Sun elevations at azimuth 90 deg (east). No mission epoch applies.
  const sheet = await page.evaluate(() => {
    const { THREE, injectAsIsDisplayIntoShader, applyLightingMode } = window.illumTest;
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
    const asIs = { value: 0 };
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
      asIs.value = row.asIs;
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
