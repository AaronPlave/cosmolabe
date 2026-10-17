/** Deterministic WebGL validation on analytic relief (not measured terrain).
 * Start the viewer first; CL_VIEWER_URL and CL_CHROMIUM select the runtime.
 * Saves reviewable screenshots, GPU errors, LOD/occlusion checks and timings. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = process.env.CL_OUTPUT ?? 'docs/validation/geographic-vectors';
await mkdir(output, { recursive: true });
const fixtures = await Promise.all(['geographic-jezero', 'geographic-southpole', 'geographic-jezero-dense'].map(name =>
  readFile(`packages/core/src/__tests__/__fixtures__/${name}.json`, 'utf8').then(JSON.parse)));
const browser = await chromium.launch({ executablePath: process.env.CL_CHROMIUM ?? '/usr/bin/chromium',
  args: process.env.CL_GPU === 'hardware'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60_000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(m.text())) errors.push(m.text()); });
  await page.goto(process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173/?test=1', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async ({ root, fixtures }) => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const { Universe, parseGeographicGeoJson, geodeticToBodyFixed } = await import(`/@fs/${root}/packages/core/src/index.ts`);
    const { GeographicVectorLayer } = await import(`/@fs/${root}/packages/three/src/geographic/GeographicVectorLayer.ts`);
    const { patchLogDepthPrecision } = await import(`/@fs/${root}/packages/three/src/LogDepth.ts`);
    patchLogDepthPrecision();
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true });
    renderer.autoClear = false; renderer.setClearColor(0x101923); renderer.setSize(640, 480);
    renderer.setPixelRatio(1);
    const camera = new THREE.PerspectiveCamera(40, 640 / 480, 0.000001, 1e9);
    const scene = new THREE.Scene();
    const universe = new Universe();
    const vectors = new GeographicVectorLayer(universe, 1);
    const captures = [], checks = [], metrics = [];
    const source = { kind: 'local-file', identity: 'deterministic-fixture' };
    const definition = body => ({ id: 'science', name: `${body} science`, body, source: 'fixture.geojson', coordinates: {
      latitude: 'planetographic', longitudeDirection: 'east', longitudeDomain: '-180..180',
      referenceShape: { kind: 'sphere', radiusKm: body === 'Moon' ? 1737.4 : 3396.19 },
    } });
    const load = (data, body) => {
      const layer = parseGeographicGeoJson(JSON.stringify(data), definition(body), source);
      if (layer.skippedFeatures) throw new Error(JSON.stringify(layer.diagnostics));
      universe.geographicLayers.replaceCatalog('fixture', [{ id: layer.id, layer, status: 'ready', source, diagnostics: [] }]);
      universe.events.emit('geographic:changed', {});
      return layer;
    };
    const body = { visible: true, body: { name: 'Mars', geometryType: 'Globe', radii: [3396.19, 3396.19, 3396.19] },
      mesh: new THREE.Mesh(), position: new THREE.Vector3(), terrainTileGroup: new THREE.Group(), terrainDatum: definition('Mars').coordinates,
      getSurfaceOverlays: () => [], bodyToWorldQuaternion: q => q.copy(body.rotation), rotation: new THREE.Quaternion(),
      surfaceTransitionState: 'streamed', isImageryOnlySurface: false };
    body.mesh.visible = false; body.terrainDatum = null;
    scene.add(body.terrainTileGroup);
    let datum;
    const terrain = (lon0, lat0, span, steps, refine) => {
      body.terrainTileGroup.clear();
      const positions = [], colors = [], indices = [];
      for (let y = 0; y <= steps; y++) for (let x = 0; x <= steps; x++) {
        const lonDeg = lon0 + span * (x / steps - 0.5), latDeg = lat0 + span * (y / steps - 0.5);
        const relief = refine * span * 0.07 * (Math.sin(x / steps * Math.PI * 4) * Math.sin(y / steps * Math.PI * 3));
        const p = geodeticToBodyFixed({ latDeg, lonDeg, heightKm: relief }, datum);
        positions.push(p.xKm, p.yKm, p.zKm);
        const shade = 0.5 + 0.13 * Math.sin(x * 0.8) + 0.13 * Math.cos(y * 0.6);
        colors.push(shade * 0.8, shade * 0.5, shade * 0.3);
      }
      for (let y = 0; y < steps; y++) for (let x = 0; x < steps; x++) {
        const a = y * (steps + 1) + x, b = a + 1, c = a + steps + 1;
        indices.push(a, b, c, b, c + 1, c);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setIndex(indices); geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true }));
      body.terrainTileGroup.add(mesh);
      return mesh;
    };
    const look = (lon, lat, distance) => {
      const p = geodeticToBodyFixed({ latDeg: lat, lonDeg: lon }, datum);
      const at = new THREE.Vector3(p.xKm, p.yKm, p.zKm).applyQuaternion(body.rotation).add(body.position);
      const up = new THREE.Vector3(p.xKm, p.yKm, p.zKm).normalize().applyQuaternion(body.rotation);
      camera.position.copy(at).addScaledVector(up, distance);
      camera.up.set(0, 0, 1).applyQuaternion(body.rotation);
      if (Math.abs(lat) > 85) camera.up.set(0, 1, 0).applyQuaternion(body.rotation);
      camera.lookAt(at); camera.updateMatrixWorld(true); camera.updateProjectionMatrix();
      return at;
    };
    const renderFrame = (withVectors = true) => {
      scene.updateMatrixWorld(true); renderer.clear(); renderer.render(scene, camera);
      vectors.begin();
      if (withVectors) vectors.render(renderer, camera, [body]);
      vectors.end();
    };
    const draw = (withVectors = true) => {
      renderFrame(withVectors); renderer.getContext().finish();
      const gl = renderer.getContext(), pixels = new Uint8Array(renderer.domElement.width * renderer.domElement.height * 4);
      gl.readPixels(0, 0, renderer.domElement.width, renderer.domElement.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const capture = name => captures.push({ name, png: renderer.domElement.toDataURL() });
    const changed = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++; return n; };
    const gl = renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const profile = async withVectors => {
      const submission = [], intervals = [];
      let last;
      for (let i = 0; i < 140; i++) {
        const timestamp = await new Promise(requestAnimationFrame);
        const start = performance.now(); renderFrame(withVectors);
        if (i >= 20) { submission.push(performance.now() - start); intervals.push(timestamp - last); }
        last = timestamp;
      }
      const stats = values => {
        values.sort((a, b) => a - b);
        return { median: values[Math.floor(values.length / 2)], p95: values[Math.floor(values.length * 0.95)], average: values.reduce((a, b) => a + b) / values.length };
      };
      return { frames: submission.length, cpuSubmissionMs: stats(submission), frameIntervalMs: stats(intervals) };
    };
    const layer = load(fixtures[0], 'Mars'); datum = layer.datum;
    body.terrainDatum = datum;
    terrain(77.45, 18.45, 0.32, 96, 1); look(77.45, 18.45, 15);
    const noVectors = draw(false), initial = draw();
    checks.push({ name: 'Jezero visible', pass: changed(noVectors, initial) > 100 }); capture('mars-jezero');
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    const surfaceHit = ray.intersectObjects(body.terrainTileGroup.children, false)[0];
    const semanticHit = vectors.pick(320, 240, 640, 480, camera, new Map([['Mars', body]]), {
      point: { bodyName: 'Mars', bodyFixedPositionKm: surfaceHit.point.toArray(), surfaceNormal: surfaceHit.face.normal.toArray() },
      cameraRangeKm: surfaceHit.distance,
    });
    checks.push({ name: 'shared feature identity on terrain', pass: semanticHit?.featureId === layer.features[0].id && semanticHit.layerId === 'science' });
    vectors.setSelected({ layerId: 'science', featureId: layer.features[0].id, bodyName: 'Mars' });
    const selected = draw(); checks.push({ name: 'selected marker', pass: changed(initial, selected) > 5 }); capture('mars-selected');
    terrain(77.45, 18.45, 0.32, 128, 2); const refined = draw();
    checks.push({ name: 'LOD replacement', pass: changed(selected, refined) > 100 && vectors.diagnostics.length === 0 }); capture('mars-refined');
    body.position.set(1e5, -2e5, 3e5); body.rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);
    body.terrainTileGroup.position.copy(body.position); body.terrainTileGroup.quaternion.copy(body.rotation);
    look(77.45, 18.45, 15); const rotated = draw();
    checks.push({ name: 'rotation and floating origin', pass: changed(refined, rotated) < 30 });
    vectors.setHovered({ layerId: 'science', featureId: layer.features[2].id, bodyName: 'Mars' });
    renderer.setSize(360, 640); renderer.setPixelRatio(2); camera.aspect = 360 / 640; camera.updateProjectionMatrix();
    draw(); capture('mars-mobile');

    renderer.setSize(640, 480); renderer.setPixelRatio(1); camera.aspect = 640 / 480;
    body.position.set(0, 0, 0); body.rotation.identity(); body.terrainTileGroup.position.set(0, 0, 0); body.terrainTileGroup.quaternion.identity();
    const localized = load(fixtures[2], 'Mars'); datum = localized.datum; body.terrainDatum = datum;
    vectors.setSelected(null); vectors.setHovered(null);
    terrain(77.45, 18.45, 0.32, 128, 1); look(77.45, 18.45, 15);
    const plainDense = draw(false), drawnDense = draw();
    checks.push({ name: 'localized polygon and 1600 targets retained', pass: vectors.featureCount === fixtures[2].features.length && vectors.diagnostics.length === 0 });
    checks.push({ name: 'localized overflow pages visible', pass: changed(plainDense, drawnDense) > 3000 });
    capture('jezero-localized-dense');
    for (const feature of [localized.features[1], localized.features.at(-1)]) {
      vectors.setSelected({ layerId: 'science', featureId: feature.id, bodyName: 'Mars' });
      checks.push({ name: `overflow page selection ${feature.id}`, pass: changed(drawnDense, draw()) > 5 });
    }
    vectors.setSelected(null);
    metrics.push({ name: 'localized dense layer, desktop viewport, no finish/readback', gpu,
      viewport: [640, 480], pixelRatio: 1, ...vectors.metrics, baseline: await profile(false), vectors: await profile(true) });
    renderer.setSize(390, 844); renderer.setPixelRatio(2); camera.aspect = 390 / 844; look(77.45, 18.45, 20);
    metrics.push({ name: 'localized dense layer, mobile viewport on desktop GPU, no finish/readback', gpu,
      viewport: [390, 844], pixelRatio: 2, ...vectors.metrics, baseline: await profile(false), vectors: await profile(true) });
    draw(); capture('jezero-localized-mobile');
    renderer.setSize(640, 480); renderer.setPixelRatio(1); camera.aspect = 640 / 480;

    body.position.set(0, 0, 0); body.rotation.identity(); body.terrainTileGroup.position.set(0, 0, 0); body.terrainTileGroup.quaternion.identity();
    body.body.name = 'Moon'; body.body.radii = [1737.4, 1737.4, 1737.4];
    const ring = lat => [[-135, lat], [-45, lat], [45, lat], [135, lat], [-135, lat]];
    const polar = { type: 'FeatureCollection', features: [...fixtures[1].features,
      { type: 'Feature', id: 'polar-region', properties: {}, geometry: { type: 'Polygon', coordinates: [ring(-85), ring(-89)] } }] };
    const moon = load(polar, 'Moon'); datum = moon.datum; body.terrainDatum = datum;
    const sphere = new THREE.SphereGeometry(1737.4, 192, 96).rotateX(Math.PI / 2);
    body.terrainTileGroup.clear(); body.terrainTileGroup.add(new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color: 0x555c63 })));
    body.surfaceTransitionState = 'static';
    look(180, -89, 350); const plainMoon = draw(false), seamMoon = draw();
    checks.push({ name: 'polar cap, holes and seam', pass: changed(plainMoon, seamMoon) > 100 }); capture('moon-polar');
    look(0, 89, 350); const plainBack = draw(false), vectorBack = draw();
    checks.push({ name: 'backside occlusion', pass: changed(plainBack, vectorBack) === 0 });

    const dense = { type: 'FeatureCollection', features: Array.from({ length: 4900 }, (_, i) => ({ type: 'Feature', id: i, properties: {},
      geometry: { type: 'Point', coordinates: [-175 + (i % 70) * 5, -80 + Math.floor(i / 70) * 2.3] } })) };
    const started = performance.now(); load(dense, 'Moon'); vectors.begin();
    metrics.push({ name: 'dense index 4900 features', milliseconds: performance.now() - started, features: vectors.featureCount, diagnostics: vectors.diagnostics.length, ...vectors.metrics });
    look(0, 0, 5000); draw(); capture('dense-orbit');
    const timings = [];
    for (let i = 0; i < 6; i++) { const start = performance.now(); draw(); timings.push(performance.now() - start); }
    metrics.push({ name: 'dense full frame with GPU finish/readback (not runtime cost)', milliseconds: timings.reduce((a, b) => a + b) / timings.length });
    vectors.setVisible('science', false); const hiddenStart = performance.now(); draw();
    metrics.push({ name: 'hidden rebuild and full frame', milliseconds: performance.now() - hiddenStart, features: vectors.featureCount });
    const idleStart = performance.now();
    for (let i = 0; i < 100; i++) { vectors.begin(); vectors.render(renderer, camera, [body]); vectors.end(); }
    metrics.push({ name: 'hidden vector update average (100 iterations)', milliseconds: (performance.now() - idleStart) / 100, ...vectors.metrics });
    checks.push({ name: 'hidden zero features', pass: vectors.featureCount === 0 });
    vectors.dispose(); universe.dispose(); renderer.dispose();
    return { captures, checks, metrics, gpu };
  }, { root: resolve('.'), fixtures });
  if (process.env.CL_GPU === 'hardware') assert.doesNotMatch(result.gpu, /swiftshader|llvmpipe|software/i);
  for (const { name, png } of result.captures) await writeFile(`${output}/${name}.png`, Buffer.from(png.split(',')[1], 'base64'));
  delete result.captures;
  await writeFile(`${output}/metrics.json`, JSON.stringify({ ...result, errors }, null, 2) + '\n');
  assert.deepEqual(errors, []);
  for (const check of result.checks) assert.equal(check.pass, true, check.name);
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
