#!/usr/bin/env node
/** Same-camera, same-epoch, same-imagery before/after of the #204 Sun-direction correction on
 * real streamed imagery on an ellipsoid (NASA Trek Viking MDIM 2.1 tiles, cached).
 * The fixture uses geometry.imagery without geometry.terrain: no displaced terrain relief.
 *
 * Scene origin is Earth, the camera views Mars, nothing casts a shadow. "Before" is the old
 * origin-aimed Sun (the shared light targets the scene origin); "after" is the receiver-aimed Sun
 * (`illuminationReceiver()`, the only difference). Each render is scored against the physical
 * Lambert incidence of the true Mars-to-Sun direction on the visible sphere.
 *
 *   npm run build && CL_CHROMIUM=/opt/pw-browsers/chromium node scripts/demo-surface-sun-direction-gpu.mjs
 *   CL_SUN_OUTPUT=/tmp/sun-direction  CL_SUN_EPOCH=2026-11-06T12:00:00Z  (defaults shown)
 * Needs network once for the tiles (curl through the configured proxy); then offline.
 * Software WebGL: repeatable evidence, not a performance claim. Not run in CI (network).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const output = process.env.CL_SUN_OUTPUT ?? '/tmp/sun-direction';
const cache = process.env.CL_SUN_TILES ?? '/tmp/sun-direction-tiles';
const epochIso = process.env.CL_SUN_EPOCH ?? '2026-11-06T12:00:00Z';
const LEVELS = 4;
const TREK = 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm';
mkdirSync(output, { recursive: true });

// Level 0 is 2x1 tiles in EPSG:4326; level z is 2^(z+1) x 2^z.
const tiles = [];
for (let z = 0; z < LEVELS; z++) for (let y = 0; y < 2 ** z; y++) for (let x = 0; x < 2 ** (z + 1); x++) tiles.push([z, y, x]);
for (const [z, y, x] of tiles) {
  const file = `${cache}/${z}-${y}-${x}.jpg`;
  if (existsSync(file)) continue;
  mkdirSync(cache, { recursive: true });
  execFileSync('curl', ['-fsS', '-m', '60', '--retry', '3', '-o', file, `${TREK}/${z}/${y}/${x}.jpg`]);
}

const bundle = await build({ stdin: { contents: `
  export * as THREE from 'three';
  export { Universe } from './packages/core/dist/Universe.js';
  export { UniverseRenderer } from './packages/three/dist/UniverseRenderer.js';
`, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'esm', platform: 'browser',
  external: ['@mapbox/vector-tile', 'pbf', 'pmtiles'] });

const browser = await chromium.launch({ headless: true, executablePath: process.env.CL_CHROMIUM,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.text().startsWith('[sun-demo]')) console.log(m.text());
    if (m.type() === 'error' || /GL_INVALID_OPERATION|Feedback loop/i.test(m.text())) errors.push(m.text());
  });
  await page.route('http://sun-demo.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
    const m = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.jpg$/.exec(path);
    if (m) return route.fulfill({ contentType: 'image/jpeg', body: readFileSync(`${cache}/${m[1]}-${m[2]}-${m[3]}.jpg`) });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>body{margin:0;background:black}canvas{width:640px;height:640px}</style><canvas></canvas>' });
  });
  await page.goto('http://sun-demo.test/');
  const result = await page.evaluate(async ({ epochIso, levels }) => {
    const { THREE, Universe, UniverseRenderer } = await import('/bundle.js');
    const universe = new Universe();
    universe.loadCatalog({ name: 'sun-direction demo', items: [
      { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, geometry: { type: 'Globe', radius: 695700 } },
      { name: 'Earth', class: 'planet', center: 'Sun', trajectory: { type: 'Builtin', name: 'Earth' },
        rotationModel: { type: 'Builtin' }, geometry: { type: 'Globe', radius: 6371 } },
      { name: 'Mars', class: 'planet', center: 'Sun', trajectory: { type: 'Builtin', name: 'Mars' },
        rotationModel: { type: 'Builtin' },
        geometry: { type: 'Globe', radii: [3396.19, 3396.19, 3376.2],
          imagery: [{ id: 'viking', url: 'http://sun-demo.test/tiles/{z}/{y}/{x}.jpg', levels, attribution: 'NASA Trek / USGS Viking MDIM 2.1' }] } },
    ] });
    const J2000 = Date.UTC(2000, 0, 1, 12);
    const et = (Date.parse(epochIso) - J2000) / 1000 + 69.184;
    universe.setTime(et);
    const viewer = new UniverseRenderer(document.querySelector('canvas'), universe, {
      minBodyPixels: 0, showStars: false, showLabels: false, showTrajectories: false,
    });
    viewer.timeController.pause();
    viewer.timeController.setTime?.(et);
    viewer.cameraController.controls.enableDamping = false;
    const earth = viewer.getBodyMesh('Earth'), mars = viewer.getBodyMesh('Mars'), sunBm = viewer.getBodyMesh('Sun');
    viewer.cameraController.setOriginBody(earth);
    viewer.renderFrame();
    const sf = viewer.scaleFactor;
    const radius = mars.displayRadius * sf;
    const q = mars.bodyToWorldQuaternion(new THREE.Quaternion());
    // True Mars-to-Sun direction. The camera is 3.6 radii out, 70° from the Sun so the terminator crosses the
    // disk, on the 70° cone's point nearest the equator, so the polar caps (very bright albedo) stay out of view.
    const sunFromMars = sunBm.position.clone().sub(mars.position).normalize();
    const sunFromOrigin = sunBm.position.clone().sub(earth.position).normalize();
    const poleWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const a = new THREE.Vector3().crossVectors(sunFromMars, poleWorld).normalize();
    const b2 = new THREE.Vector3().crossVectors(sunFromMars, a).normalize();
    let viewDir = null, best = Infinity;
    for (let k = 0; k < 720; k++) {
      const phi = (k / 720) * 2 * Math.PI;
      const d = sunFromMars.clone().multiplyScalar(Math.cos(1.2217))
        .addScaledVector(a, Math.sin(1.2217) * Math.cos(phi)).addScaledVector(b2, Math.sin(1.2217) * Math.sin(phi)).normalize();
      const lat = Math.abs(d.dot(poleWorld));
      if (lat < best) { best = lat; viewDir = d; }
    }
    function pose() {
      const c = viewer.camera;
      c.position.copy(mars.position).addScaledVector(viewDir, radius * 3.6);
      c.up.copy(poleWorld); c.fov = 35;
      viewer.cameraController.controls.target.copy(mars.position);
      c.lookAt(mars.position); c.updateProjectionMatrix(); c.updateMatrixWorld(true);
    }
    const frame = async () => { pose(); viewer.renderFrame(); await new Promise(requestAnimationFrame); };
    const light = viewer.sunLight;
    const aim = () => ({
      lightPosition: light.position.toArray(), lightTarget: light.target.position.toArray(),
      direction: light.position.clone().sub(light.target.position).normalize().toArray(),
    });
    // Stream tiles in (receiver-aimed = production).
    for (let i = 0; i < 120; i++) await frame();
    const tm = mars.terrainManager;
    const streamed = { terrainVisible: !!mars.terrainTileGroup?.visible, tiles: tm?.metrics?.tiles ?? null,
      meshes: (() => { let n = 0; mars.terrainTileGroup?.traverse(o => { if (o.isMesh) n++; }); return n; })(), transition: mars.surfaceTransitionState };
    const gl = viewer.renderer.getContext();
    const W = viewer.renderer.domElement.width, H = viewer.renderer.domElement.height;
    const capture = async mode => {
      const original = viewer.illuminationReceiver;
      if (mode === 'before') viewer.illuminationReceiver = () => null; // the old origin-aimed Sun
      for (let i = 0; i < 3; i++) await frame();
      // Render and read back in the same task: the drawing buffer is cleared once it is presented.
      pose(); viewer.renderFrame();
      const info = aim();
      const pixels = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const png = viewer.renderer.domElement.toDataURL();
      viewer.illuminationReceiver = original;
      return { mode, info, pixels, png };
    };
    const before = await capture('before'), after = await capture('after');
    // Score: Lambert cos(incidence) of the TRUE Mars-to-Sun direction at each visible sphere pixel
    // vs measured linear luminance. Albedo varies, so use Pearson r over the lit-limb disk.
    const cam = viewer.camera;
    const ray = new THREE.Raycaster();
    const center = mars.position, R = radius;
    const toLin = v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const samples = [];
    for (let y = 8; y < H; y += 8) for (let x = 8; x < W; x += 8) {
      ray.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, 1 - (y / H) * 2), cam);
      const o = ray.ray.origin.clone().sub(center), d = ray.ray.direction;
      const b = o.dot(d), c = o.dot(o) - R * R, disc = b * b - c;
      if (disc <= 0) continue;
      const t = -b - Math.sqrt(disc);
      const n = o.clone().addScaledVector(d, t).normalize();
      const latDeg = Math.asin(n.clone().applyQuaternion(q.clone().invert()).z) * 180 / Math.PI;
      samples.push({ cos: Math.max(0, n.dot(sunFromMars)), cosOrigin: Math.max(0, n.dot(sunFromOrigin)), latDeg, i: ((H - 1 - y) * W + x) * 4 });
    }
    const lum = (img, s) => toLin(img.pixels[s.i]) * 0.2126 + toLin(img.pixels[s.i + 1]) * 0.7152 + toLin(img.pixels[s.i + 2]) * 0.0722;
    const pearson = (a, b) => { const n = a.length, ma = a.reduce((p, v) => p + v, 0) / n, mb = b.reduce((p, v) => p + v, 0) / n;
      let sab = 0, saa = 0, sbb = 0; for (let k = 0; k < n; k++) { sab += (a[k] - ma) * (b[k] - mb); saa += (a[k] - ma) ** 2; sbb += (b[k] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
    const score = (img, set = samples) => ({ pixels: set.length,
      rTrueSun: pearson(set.map(s => s.cos), set.map(s => lum(img, s))), rOriginSun: pearson(set.map(s => s.cosOrigin), set.map(s => lum(img, s))),
      meanLuminance: set.reduce((p, s) => p + lum(img, s), 0) / set.length });
    // Polar caps are far brighter than regolith by albedo alone, so also score the mid-latitude disk.
    const mid = samples.filter(s => Math.abs(s.latDeg) < 55);
    // Albedo-free check: the same imagery at the same pixel is lit by two Sun directions, so albedo cancels in
    // L_after / L_before. Lambert predicts cos(true Sun) / cos(origin Sun) wherever both are well above the
    // terminator (ambient is ~3% of the Sun term there). Regress log-ratio on log-prediction.
    const ratioPairs = samples.filter(s => s.cos > 0.25 && s.cosOrigin > 0.25).map(s => ({
      predicted: Math.log(s.cos / s.cosOrigin), measured: Math.log(lum(after, s) / lum(before, s)) })).filter(p => Number.isFinite(p.measured));
    const meanOf = v => v.reduce((p, x) => p + x, 0) / v.length;
    const mp = meanOf(ratioPairs.map(p => p.predicted)), mm = meanOf(ratioPairs.map(p => p.measured));
    const sxy = ratioPairs.reduce((p, q) => p + (q.predicted - mp) * (q.measured - mm), 0), sxx = ratioPairs.reduce((p, q) => p + (q.predicted - mp) ** 2, 0);
    const errors = ratioPairs.map(p => Math.abs(Math.exp(p.measured - p.predicted) - 1)).sort((x, y) => x - y);
    const albedoFree = { pixels: ratioPairs.length, rLogRatio: pearson(ratioPairs.map(p => p.predicted), ratioPairs.map(p => p.measured)),
      slope: sxy / sxx, predictedLogRatioSpread: Math.sqrt(sxx / ratioPairs.length), medianRelativeError: errors[Math.floor(errors.length / 2)] };
    const angleBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, new THREE.Vector3(...a).dot(new THREE.Vector3(...b))))) * 180 / Math.PI;
    // Sun elevation at the sub-camera point on Mars, from the production diagnostic.
    const sub = viewDir.clone().applyQuaternion(q.clone().invert());
    const lat = Math.asin(sub.z) * 180 / Math.PI, lon = Math.atan2(sub.y, sub.x) * 180 / Math.PI;
    return {
      epochIso, et, sampleCount: samples.length, streamed,
      positions: { sun: sunBm.position.toArray(), earthOrigin: earth.position.toArray(), mars: mars.position.toArray(), scaleFactor: sf },
      sunDirection: { fromOrigin: sunFromOrigin.toArray(), fromMars: sunFromMars.toArray(), separationDeg: angleBetween(sunFromOrigin.toArray(), sunFromMars.toArray()) },
      before: { ...before.info, angleToTrueSunDeg: angleBetween(before.info.direction, sunFromMars.toArray()), ...score(before), midLatitude: score(before, mid) },
      after: { ...after.info, angleToTrueSunDeg: angleBetween(after.info.direction, sunFromMars.toArray()), ...score(after), midLatitude: score(after, mid) },
      albedoFree,
      subCamera: { latitudeDeg: lat, longitudeDeg: lon, sun: viewer.solarGeometryAt?.('Mars', lat, lon) ?? null },
      png: { before: before.png, after: after.png },
    };
  }, { epochIso, levels: LEVELS });
  assert.deepEqual(errors, [], 'no page or console errors');
  const { png, ...summary } = result;
  writeFileSync(`${output}/result.json`, JSON.stringify(summary, null, 2));
  for (const k of ['before', 'after']) writeFileSync(`${output}/mars-${k}.png`, Buffer.from(png[k].split(',')[1], 'base64'));
  console.log(JSON.stringify({ ...summary, positions: undefined }, null, 2));
  // Streamed imagery-only ellipsoid tiles were drawn, not the fallback sphere.
  assert.ok(summary.streamed.terrainVisible && summary.streamed.meshes > 0, `streamed surface active: ${JSON.stringify(summary.streamed)}`);
  // The two renders differ only by the Sun target, and the correction is the physical Sun direction.
  assert.ok(summary.sunDirection.separationDeg > 10, 'epoch gives a meaningful origin-vs-Mars Sun direction difference');
  assert.ok(summary.after.angleToTrueSunDeg < 0.01, 'receiver-aimed light matches the true Mars-to-Sun direction');
  assert.ok(Math.abs(summary.before.angleToTrueSunDeg - summary.sunDirection.separationDeg) < 0.01, 'old light is the origin-to-Sun direction');
  // One captioned figure, with the values needed to verify the correction rather than judge the look.
  const fmt = v => `(${v.map(x => x.toFixed(4)).join(', ')})`;
  const caption = [
    `Same camera, epoch ${summary.epochIso}, imagery (NASA Trek Viking MDIM 2.1, streamed: ${summary.streamed.meshes} tile meshes, state "${summary.streamed.transition}"), scene origin Earth, camera 3.6 Mars radii out, no shadow caster.`,
    `Camera sub-point lat ${summary.subCamera.latitudeDeg.toFixed(1)} lon ${summary.subCamera.longitudeDeg.toFixed(1)}: Sun elevation ${summary.subCamera.sun?.elevationDeg.toFixed(1)} deg, azimuth ${summary.subCamera.sun?.azimuthDeg.toFixed(1)} deg. Keplerian ephemeris (no SPICE kernels); imagery provenance: unknown (legacy relit).`,
    `Sun direction from the scene origin (Earth) ${fmt(summary.sunDirection.fromOrigin)}; from Mars ${fmt(summary.sunDirection.fromMars)}; separation ${summary.sunDirection.separationDeg.toFixed(2)} deg.`,
  ];
  const panels = [
    ['BEFORE: origin-aimed Sun (old)', summary.before, png.before],
    ['AFTER: receiver-aimed Sun (this PR)', summary.after, png.after],
  ];
  const sheet = await (await browser.newPage()).evaluate(async ({ caption, panels }) => {
    const load = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const W = 640, top = 84, foot = 74;
    const c = document.createElement('canvas'); c.width = W * 2 + 8; c.height = top + W + foot;
    const g = c.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
    g.font = '12px sans-serif'; g.fillStyle = '#ddd';
    caption.forEach((t, i) => g.fillText(t.length > 190 ? t.slice(0, 190) + '…' : t, 6, 16 + i * 16));
    for (let i = 0; i < panels.length; i++) {
      const [title, info, src] = panels[i];
      g.drawImage(await load(src), i * (W + 8), top);
      g.fillStyle = '#fff'; g.font = 'bold 13px sans-serif'; g.fillText(title, i * (W + 8) + 8, top - 8);
      g.font = '12px sans-serif'; g.fillStyle = '#9ad';
      const f = v => v.map(x => x.toFixed(4)).join(', ');
      g.fillText(`light position (${f(info.lightPosition.map(x => x))})`.replace(/\d+\.\d+/g, m => (+m).toFixed(1)), i * (W + 8) + 8, top + W + 16);
      g.fillText(`light target (${info.lightTarget.map(x => x.toFixed(1)).join(', ')})`, i * (W + 8) + 8, top + W + 32);
      g.fillText(`light direction (${f(info.direction)})`, i * (W + 8) + 8, top + W + 48);
      g.fillText(`angle to true Mars-to-Sun direction: ${info.angleToTrueSunDeg.toFixed(2)} deg`, i * (W + 8) + 8, top + W + 64);
    }
    return c.toDataURL('image/png');
  }, { caption, panels });
  writeFileSync(`${output}/before-after.png`, Buffer.from(sheet.split(',')[1], 'base64'));
  const F = summary.albedoFree;
  assert.ok(F.pixels > 500 && F.predictedLogRatioSpread > 0.15, `enough lit pixels with a real Sun-direction contrast: ${JSON.stringify(F)}`);
  assert.ok(F.rLogRatio > 0.95 && Math.abs(F.slope - 1) < 0.1 && F.medianRelativeError < 0.1,
    `albedo-free before/after ratio matches cos(true Sun)/cos(origin Sun): ${JSON.stringify(F)}`);
} finally {
  await browser.close();
}
