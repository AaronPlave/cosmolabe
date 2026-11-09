/** Terrain solar shadows (#205) under real WebGL: the actual tile-shader hook and clipmap, in a realistic
 * transformed scene (scale 1e-6, rotated body, offset body, camera-relative geometry), against the CPU ground truth
 * in TerrainSunVisibility.ts, for a synthetic ridge with known occlusion.
 *
 *   node scripts/test-terrain-solar-shadow-webgl.mjs        (CL_CHROMIUM=/path to override the browser)
 *   CL_SHADOW_OUTPUT=/tmp/terrain-solar-shadow selects the JSON directory.
 *
 * Checks: (1) frame/data alignment (debug view 3) is green everywhere, so scale, rotation and gnomonic
 * placement are right; (2) per-receiver Sun fraction matches the reference across solar elevation and azimuth;
 * (3) no light leaks on the shadowed side and no false shadow on the open side; (4) unknown coverage is not drawn
 * as shadow. Software WebGL is repeatable acceptance evidence, not a hardware benchmark: timings are reported, with no
 * GPU or mobile claim.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.CL_SHADOW_OUTPUT ?? '/tmp/terrain-solar-shadow';
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root, logLevel: 'warn', server: { host: '127.0.0.1', port: 0 }, appType: 'custom' });
server.middlewares.use(async (req, res, next) => {
  if (req.url !== '/') return next();
  const html = await server.transformIndexHtml('/', `<link rel="icon" href="data:,"><canvas width="64" height="64"></canvas><script type="module">
    import * as THREE from 'three';
    import { SolarShadowClipmap, injectSolarShadowIntoShader } from '/packages/three/src/SolarShadowClipmap.ts';
    import { solarVisibility } from '/packages/three/src/TerrainSunVisibility.ts';
    window.shadowTest = { THREE, SolarShadowClipmap, injectSolarShadowIntoShader, solarVisibility };
  </script>`);
  res.setHeader('Content-Type', 'text/html');
  res.end(html);
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CL_CHROMIUM || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.shadowTest);
  const result = await page.evaluate(() => {
    const { THREE, SolarShadowClipmap, injectSolarShadowIntoShader, solarVisibility } = window.shadowTest;
    const DEG = Math.PI / 180, SCALE = 1e-6;
    const canvas = document.querySelector('canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const gl = renderer.getContext();
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Float readback unavailable');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    const floatLinear = renderer.extensions.has('OES_texture_float_linear');
    const W = 800, H = 8;
    const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType });

    // A non-trivial world: rotated, offset body at the renderer's real scale.
    const bodyPos = new THREE.Vector3(3, -2, 5);
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -0.7, 1.1));
    const toScene = (v) => new THREE.Vector3(v[0], v[1], v[2]).applyQuaternion(rot).multiplyScalar(SCALE).add(bodyPos);

    const suite = (R, name) => {
    const datum = { referenceShape: { kind: 'sphere', radiusKm: R }, verticalDatum: 'reference-sphere', heightConvention: 'radial' };
    const E0 = -25, E1 = 55; // km east of the anchor covered by the image
    const ridgeAt = (c) => (lonDeg) => Math.abs(lonDeg * DEG * R - c.d0) <= c.width / 2 ? c.height : 0; // N-S crest by longitude

    function render({ elDeg, azDeg, ridge, mode, holeFromKm = null, quality = 'high', hardwareLinear = floatLinear }) {
      const crest = ridgeAt(ridge);
      const source = {
        datum, revision: 0,
        elevationKm: (lat, lon) => (holeFromKm !== null && lon * DEG * R > holeFromKm ? null : crest(lon)),
        probe: () => 'finest',
      };
      const clip = new SolarShadowClipmap(source, { budgetMs: 1e9 }, hardwareLinear);
      // Ground strip along the equator, geometry relative to the anchor point so float32 keeps metres.
      const O = [R, 0, 0], positions = [], index = [];
      const cols = Math.round((E1 - E0) / 0.05), rows = 3;
      for (let j = 0; j < rows; j++) for (let i = 0; i <= cols; i++) {
        const e = E0 + i * 0.05, n = (j - 1) * 0.25;
        const lon = e / R, lat = n / R;
        const h = crest(lon / DEG);
        const r = R + h, c = Math.cos(lat);
        positions.push(r * c * Math.cos(lon) - O[0], r * c * Math.sin(lon) - O[1], r * Math.sin(lat) - O[2]);
      }
      for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols; i++) {
        const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
        index.push(a, c, b, b, c, d);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(index);
      geo.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side: THREE.DoubleSide });
      material.onBeforeCompile = shader => injectSolarShadowIntoShader(shader, clip.uniforms);
      material.customProgramCacheKey = () => '_ss_test_v1' + (hardwareLinear ? 'hw' : 'sw');
      const mesh = new THREE.Mesh(geo, material);
      mesh.quaternion.copy(rot); mesh.scale.setScalar(SCALE);
      mesh.position.copy(toScene(O));
      mesh.frustumCulled = false;

      // Sun at the given elevation/azimuth above the anchor's horizon (east = +Y, north = +Z, up = +X).
      const s = [Math.sin(elDeg * DEG), Math.cos(elDeg * DEG) * Math.sin(azDeg * DEG), Math.cos(elDeg * DEG) * Math.cos(azDeg * DEG)];
      const sunBody = s.map(v => v * 1.496e8);
      const sunPos = new THREE.Vector3(...sunBody).applyQuaternion(rot).multiplyScalar(SCALE).add(bodyPos);
      const scene = new THREE.Scene();
      const sun = new THREE.DirectionalLight(0xffffff, 2);
      sun.position.copy(sunPos); sun.target.position.copy(toScene(O)); sun.target.updateMatrixWorld();
      scene.add(sun, sun.target, new THREE.AmbientLight(0xffffff, 0.02), mesh);

      // Overhead orthographic view of the strip (east = image right).
      const camera = new THREE.OrthographicCamera(-(E1 - E0) / 2 * SCALE, (E1 - E0) / 2 * SCALE, 0.4 * SCALE, -0.4 * SCALE, 1e-6, 300 * SCALE);
      const centreE = (E0 + E1) / 2;
      camera.position.copy(toScene([R + 80, centreE, 0]));
      camera.up.set(0, 0, 1).applyQuaternion(rot);
      camera.lookAt(toScene([R, centreE, 0]));
      camera.updateMatrixWorld();

      const frame = { camera, bodyPosition: bodyPos, bodyToScene: rot, sunPosition: sunPos, scaleFactor: SCALE,
        focus: toScene([R, centreE, 0]) };
      // The ortho camera is 80 km up: well inside the default range. Build to completion.
      const t0 = performance.now();
      for (let k = 0; k < 8; k++) clip.update(frame, 0);
      const buildMs = performance.now() - t0;
      clip.setDebug(mode);
      clip.setQuality(quality);
      clip.renderHorizons(renderer);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const px = new Float32Array(W * H * 4);
      renderer.readRenderTargetPixels(target, 0, 0, W, H, px);
      renderer.setRenderTarget(null);
      const row = (y) => Array.from({ length: W }, (_, x) => [px[(y * W + x) * 4], px[(y * W + x) * 4 + 1], px[(y * W + x) * 4 + 2]]);
      const out = { status: clip.status, buildMs, row: row(H >> 1) };
      clip.dispose(); material.dispose(); geo.dispose();
      return out;
    }

    const ridge = { d0: 30, width: 2, height: 1.5 };
    const colE = (x) => E0 + (x + 0.5) * (E1 - E0) / W;
    const out = { scale: SCALE, ridge, alignment: {}, sweeps: [], unknown: {}, timing: {} };

    // 1. Frame/data alignment: debug view 3 is green (|rendered - clipmap| < 10 m) wherever the strip is covered.
    {
      const r = render({ elDeg: 10, azDeg: 90, ridge, mode: 3 });
      const px = r.row;
      let green = 0, red = 0, blue = 0, magenta = 0;
      for (const [rr, g, b] of px) { if (g > 0.5 && rr < 0.5) green++; else if (rr > 0.5 && g < 0.5 && b < 0.5) red++; else if (b > 0.5 && rr < 0.5) blue++; else magenta++; }
      out.alignment = { green, red, blue, magenta, total: px.length, state: r.status.state };
    }

    // 2. Sun fraction per receiver against the CPU reference, over solar elevation and azimuth.
    const crest = ridgeAt(ridge);
    const heightAbs = (e) => crest(e / R / DEG); // ridge by arc distance east
    // A shadow edge may sit up to max(1 km, 12 % of the distance to the ridge) from the reference's (the clipmap holds
    // the ridge's vertical walls as bilinear slopes a texel wide), plus one texel of the level whose horizon map holds
    // the receiver (horizons are computed at texel centres and interpolated): 62 m inside the 8 km level, 0.5 km from
    // its cross-fade band out.
    const centreE = (E0 + E1) / 2;
    const tolerance = (e) => Math.max(1.0, 0.12 * Math.abs(ridge.d0 - e)) + (Math.abs(e - centreE) < 0.8 * 8 - 0.1 ? 0.0625 : Math.abs(e - centreE) < 0.8 * 64 ? 0.5 : 2.5);
    const sweep = (quality, hardwareLinear = floatLinear) => {
    const sweeps = [];
    let worstMean = 0, worstMax = 0, leaks = 0, falseShadow = 0, compared = 0;
    // The Sun is one direction in space; each receiver has its own horizon, so its elevation and azimuth differ
    // from the nominal ones (the planet curves 0.033 deg per km). The reference gets each receiver's own.
    const localSun = (s, e) => {
      const lon = e / R, up = [Math.cos(lon), Math.sin(lon), 0], east = [-Math.sin(lon), Math.cos(lon), 0], north = [0, 0, 1];
      const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      return { el: Math.asin(d(s, up)) / DEG, az: (Math.atan2(d(s, east), d(s, north)) / DEG + 360) % 360 };
    };
    for (const azDeg of [90, 125]) for (const elDeg of [1.5, 2.5, 4, 7, 12]) {
      const r = render({ elDeg, azDeg, ridge, mode: 1, quality, hardwareLinear });
      const s = [Math.sin(elDeg * DEG), Math.cos(elDeg * DEG) * Math.sin(azDeg * DEG), Math.cos(elDeg * DEG) * Math.cos(azDeg * DEG)];
      let sum = 0, n = 0, max = 0;
      const samples = [], profile = [];
      for (let x = 0; x < W; x += 4) {
        const e = colE(x);
        // Skip the ridge itself and a texel-scale band around its crest, and receivers whose Sun is near/below their
        // horizon (no direct light there: the shader does not march them).
        if (Math.abs(e - ridge.d0) < ridge.width / 2 + 0.4) continue;
        const loc = localSun(s, e);
        if (loc.el < 0.5) continue;
        const ref = solarVisibility((de, dn) => heightAbs(e + de), loc.az, loc.el, 0, R, 330, 0.05);
        // Receivers within `tolerance` of a reference edge are judged against the reference on either side of it.
        const tol = tolerance(e);
        const around = [-tol, 0, tol].map(k => solarVisibility((de, dn) => heightAbs(e + k + de), loc.az, loc.el, 0, R, 330, 0.05).fraction);
        const lo = Math.min(...around), hi = Math.max(...around);
        const gpuVis = r.row[x][0];
        const err = Math.abs(gpuVis - ref.fraction);
        sum += err; n++; max = Math.max(max, err);
        if (gpuVis > hi + 0.1) leaks++;
        if (gpuVis < lo - 0.1) falseShadow++;
        compared++;
        profile.push([+e.toFixed(2), +ref.fraction.toFixed(3), +gpuVis.toFixed(3)]);
      }
      worstMean = Math.max(worstMean, sum / n); worstMax = Math.max(worstMax, max);
      sweeps.push({ azDeg, elDeg, meanAbsError: sum / n, maxAbsError: max, buildMs: r.buildMs, samples, profile });
    }
    // Where each sweep's shadow edge (first receiver below half Sun, going toward the ridge) sits, GPU vs reference.
    const edges = sweeps.map(sw => {
      const first = (k) => (sw.profile.find(q => q[0] < ridge.d0 - 1.5 && q[k] < 0.5) ?? [null])[0];
      const ref = first(1), g = first(2);
      return { azDeg: sw.azDeg, elDeg: sw.elDeg, refEdgeKm: ref, gpuEdgeKm: g, shiftKm: ref === null || g === null ? null : g - ref,
        toleranceKm: ref === null ? null : tolerance(ref) };
    });
    return { sweeps, edges, compared, worstMean, worstMax, leaks, falseShadow };
    };
    Object.assign(out, sweep('high'));
    out.floatLinear = floatLinear;
    { const r = sweep('high', !floatLinear); out.otherFilterPath = { hardwareLinear: !floatLinear, worstMean: r.worstMean, leaks: r.leaks, falseShadow: r.falseShadow }; }
    out.quality = {};
    for (const q of ['medium', 'low']) { const r = sweep(q); out.quality[q] = { worstMean: r.worstMean, leaks: r.leaks, falseShadow: r.falseShadow, edges: r.edges }; }

    // 3. Unknown coverage is never drawn as shadow: with the source ending west of the ridge, the receivers behind
    // the hole see no ridge, so they are lit (and tinted in debug view 2), not black.
    {
      const lit = render({ elDeg: 2.5, azDeg: 90, ridge, mode: 1, holeFromKm: 10 });
      const tint = render({ elDeg: 2.5, azDeg: 90, ridge, mode: 2, holeFromKm: 10 });
      const x = Math.round((0 - E0) / (E1 - E0) * W); // e = 0 km: terrain known, but the ridge (30 km) is in the hole
      out.unknown = { vis: lit.row[x][0], tintedMagenta: tint.row[x][2] > 0.5 && tint.row[x][1] < 0.5, state: lit.status.state };
    }
    out.timing = { clipmapBuildMsPerFrame: out.sweeps.map(s => s.buildMs) };
    out.body = name; out.radiusKm = R;
    return out;
    };
    return { gpu, moon: suite(1737.4, 'Moon'), mars: suite(3389.5, 'Mars') };
  });
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2));
  assert.deepEqual(errors, [], 'page errors: ' + errors.join('; '));
  const summary = { gpu: result.gpu };
  for (const r of [result.moon, result.mars]) {
    // Alignment: every covered pixel agrees with the clipmap to 10 m.
    assert.ok(r.alignment.green / r.alignment.total > 0.98, `${r.body}: frame/data alignment ${JSON.stringify(r.alignment)}`);
    // Reference parity.
    assert.ok(r.worstMean < 0.015, `${r.body}: mean |GPU - reference| ${r.worstMean}`);
    assert.equal(r.leaks, 0, `${r.body}: light leaks: lit where the reference is shadowed, beyond the edge tolerance`);
    assert.equal(r.falseShadow, 0, `${r.body}: false shadow: dark where the reference is lit, beyond the edge tolerance`);
    for (const e of r.edges) if (e.shiftKm !== null) assert.ok(Math.abs(e.shiftKm) <= e.toleranceKm, `${r.body}: shadow edge moved ${e.shiftKm} km (tolerance ${e.toleranceKm}) at az ${e.azDeg} el ${e.elDeg}`);
    // Cheaper presets take longer steps through the data; on this ridge (many texels wide) they stay within the same bounds.
    for (const [q, tolerance] of [['medium', 0.015], ['low', 0.015]]) {
      assert.equal(r.quality[q].leaks, 0, `${r.body} ${q}: light leaks`);
      assert.ok(r.quality[q].worstMean < tolerance, `${r.body} ${q}: mean |GPU - reference| ${r.quality[q].worstMean}`);
    }
    assert.ok(r.otherFilterPath.worstMean < 0.015 && r.otherFilterPath.leaks === 0, `${r.body}: the other filtering path (hardwareLinear ${r.otherFilterPath.hardwareLinear}): ${JSON.stringify(r.otherFilterPath)}`);
    assert.ok(r.unknown.vis > 0.95, `${r.body}: unknown coverage drawn dark: ${r.unknown.vis}`);
    assert.ok(r.unknown.tintedMagenta, `${r.body}: unknown coverage not tinted in debug view 2`);
    summary[r.body] = { floatLinear: r.floatLinear, otherFilterPath: r.otherFilterPath, alignment: r.alignment, worstMean: r.worstMean, worstMax: r.worstMax, compared: r.compared, leaks: r.leaks,
      falseShadow: r.falseShadow, quality: Object.fromEntries(Object.entries(r.quality).map(([q, v]) => [q, { worstMean: v.worstMean, leaks: v.leaks, falseShadow: v.falseShadow, maxEdgeShiftKm: Math.max(...v.edges.map(e => Math.abs(e.shiftKm ?? 0))) }])), maxEdgeShiftKm: Math.max(...r.edges.map(e => Math.abs(e.shiftKm ?? 0))), unknown: r.unknown };
  }
  console.log(JSON.stringify(summary, null, 2));
  console.log('terrain solar shadow WebGL: pass');
} finally {
  await browser?.close();
  await server.close();
}
