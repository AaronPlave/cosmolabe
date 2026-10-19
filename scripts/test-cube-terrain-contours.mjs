/** Offline cube-sphere GLTF + real imagery-block lifecycle check.
 * Synthetic polar crater and test texture; not a MoonFall data validation.
 * CHROMIUM_PATH=/usr/bin/chromium node scripts/test-cube-terrain-contours.mjs
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const output = process.env.CONTOUR_OUTPUT ?? 'work/issue-183/cube-captures';
await mkdir(output, { recursive: true });
const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const ids = new Set(faces.map(f => `${f}/0/0/0`));
for (let l = 1; l <= 8; l++) ids.add(`nz/${l}/${128 >> (8 - l)}/${128 >> (8 - l)}`);
for (const x of [256, 257]) for (const y of [256, 257]) ids.add(`nz/9/${x}/${y}`);
const imagery = {
  format: 'cosmolabe-cube-imagery-1', source: { id: 'synthetic-contour-test', kind: 'imagery', version: 'fixture' }, bodyId: 'Moon',
  registration: { crsId: 'cosmolabe:cube-gnomonic-1/IAU_MOON', pixelConvention: 'corner', registrationErrorKm: 0, resampling: 'test', footprint: 'synthetic' },
  tileSize: 32, gutter: 1, encoding: 'png', colorSpace: 'srgb', minLevel: 0, maxLevel: 9, uri: 'tiles/{face}/{level}/{x}/{y}.png', tiles: [...ids],
};
const grid = {
  format: 'cosmolabe-cube-height-grid-1', datum: { referenceShape: { kind: 'sphere', radiusKm: 1737.4 }, heightConvention: 'radial', verticalDatum: 'reference-sphere' },
  source: { id: 'unused-test-cpu-grid', kind: 'height-grid', version: 'fixture' }, grid: { width: 2, height: 2, uri: 'heights/{face}/{level}/{x}/{y}.f32' },
  heightRangeKm: [-1, 1], maxLevel: 0, tiles: faces.map(f => [f, 0, 0, 0, 1]),
};
const png = new PNG({ width: 34, height: 34 });
for (let i = 0; i < 34 * 34; i++) png.data.set([100, 85, 70, 255], i * 4);
const image = PNG.sync.write(png);
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 5194 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(m.text())) errors.push(m.text()); });
  await page.route('**/cube-contour-smoke', route => route.fulfill({ contentType: 'text/html', body: '<body style="margin:0"></body>' }));
  await page.route('**/contour-cube-fixture/**', route => {
    const url = route.request().url();
    if (url.endsWith('imagery.json')) return route.fulfill({ json: imagery });
    if (url.endsWith('cpu-grids.json')) return route.fulfill({ json: grid });
    if (url.endsWith('.f32')) return route.fulfill({ body: Buffer.from(new Float32Array(4).buffer), contentType: 'application/octet-stream' });
    if (url.endsWith('.png')) return route.fulfill({ body: image, contentType: 'image/png' });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${server.resolvedUrls.local[0]}cube-contour-smoke`);
  const result = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const { TerrainManager } = await import('/packages/three/src/TerrainManager.ts');
    const { DEFAULT_SURFACE_APPEARANCE: defaults } = await import('/packages/three/src/SurfaceAppearance.ts');
    const { cubeFaceToDirection } = await import('/packages/three/src/surface/CubeSphere.ts');
    const { makeShadowUniforms } = await import('/packages/three/src/EclipseShadow.ts');
    const R = 1737400, n = 33, world = [], indices = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const u = 2 / 256 * i / (n - 1), v = 2 / 256 * j / (n - 1), d = cubeFaceToDirection('nz', u, v);
      const r = Math.hypot(d[0] * R + 6500, d[1] * R - 6500);
      const h = 400 * Math.exp(-(((r - 2500) / 600) ** 2)) - 250 * Math.exp(-((r / 1600) ** 2));
      world.push(d.map(c => c * (R + h)));
    }
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const k = j * n + i; indices.push(k, k + 1, k + n + 1, k, k + n + 1, k + n);
    }
    const surfaceTriangles = indices.length / 3;
    // Duplicate boundary vertices as a skirt, like the production cube product.
    const edge = Array.from({ length: n }, (_, i) => i);
    for (const k of edge) { const p = new THREE.Vector3(...world[k]); world.push(p.multiplyScalar(1 - 100 / p.length()).toArray()); }
    for (let i = 0; i < n - 1; i++) indices.push(edge[i], n * n + i, edge[i + 1], edge[i + 1], n * n + i, n * n + i + 1);
    const center = new THREE.Vector3(); world.slice(0, n * n).forEach(p => center.add(new THREE.Vector3(...p))); center.divideScalar(n * n);
    const yup = p => [p[0], p[2], -p[1]];
    const positions = new Float32Array(world.flatMap(p => yup(p.map((c, i) => c - center.getComponent(i)))));
    const normals = new Float32Array(world.flatMap(p => yup(new THREE.Vector3(...p).normalize().toArray())));
    const index = new Uint32Array(indices), binary = new Uint8Array(positions.byteLength + normals.byteLength + index.byteLength);
    binary.set(new Uint8Array(positions.buffer)); binary.set(new Uint8Array(normals.buffer), positions.byteLength); binary.set(new Uint8Array(index.buffer), positions.byteLength + normals.byteLength);
    const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, translation: yup(center.toArray()) }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, extras: { surfaceTriangles } }] }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
      buffers: [{ byteLength: binary.length, uri: `data:application/octet-stream;base64,${btoa(Array.from(binary, c => String.fromCharCode(c)).join(''))}` }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }, { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength }, { buffer: 0, byteOffset: positions.byteLength + normals.byteLength, byteLength: index.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [-20000, -20000, -20000], max: [20000, 20000, 20000] }, { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' }, { bufferView: 2, componentType: 5125, count: index.length, type: 'SCALAR' }],
    };
    const loaded = await new GLTFLoader().parseAsync(JSON.stringify(json), '');
    loaded.scene.rotation.x = Math.PI / 2; // pinned TilesRenderer's Y-up → Z-up correction
    let source; loaded.scene.traverse(o => { if (o.isMesh) source = o; });
    const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true }); renderer.setSize(800, 600); document.body.append(renderer.domElement);
    const manager = new TerrainManager({ type: '3dtiles', url: '/contour-cube-fixture/tileset.json', datum: { heightConvention: 'radial', verticalDatum: 'reference-sphere' },
      cubeSphere: { cpuGrids: '/contour-cube-fixture/cpu-grids.json', imagery: { url: '/contour-cube-fixture/imagery.json', maxScreenTexelError: 0.05 } } }, R / 1000, renderer);
    manager.enableShadowReceiving(makeShadowUniforms());
    const layer = manager.cubeImageryLayer; await layer.ready;
    const group = manager.tiles.group; group.rotation.set(0, 0, 0); group.scale.setScalar(1); group.position.copy(center).negate(); group.add(loaded.scene);
    manager.customizeTileMaterial(loaded.scene, { content: { uri: 'nz/8/128/128.glb' } });
    layer.addTile(loaded.scene, loaded.scene, { face: 'nz', level: 8, x: 128, y: 128 });
    const scene = new THREE.Scene(); scene.add(group); scene.add(new THREE.AmbientLight(0xffffff, 2));
    const camera = new THREE.PerspectiveCamera(40, 800 / 600, 1, 1e6); camera.position.z = -30000; camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const gl = renderer.getContext(), captures = [];
    function render(name) {
      group.updateMatrixWorld(true); layer.update(camera, group.matrixWorld, 2 * Math.tan(Math.PI / 9) / 600, renderer);
      manager.surfaceStyle.update(Infinity); renderer.render(scene, camera);
      const pixels = new Uint8Array(800 * 600 * 4); gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (name) captures.push({ name, png: renderer.domElement.toDataURL() }); return pixels;
    }
    // Let the real bitmap loader fetch and decode the routed local PNGs.
    for (let i = 0; i < 40; i++) { render(); await new Promise(resolve => setTimeout(resolve, 25)); }
    const off = render('cube-off'); manager.setSurfaceAppearance({ ...defaults, contours: true }); const on = render('cube-contours');
    let changed = 0; for (let i = 0; i < off.length; i += 4) if (Math.abs(off[i] - on[i]) > 2) changed++;
    const blocks = []; loaded.scene.traverse(o => { if (o.name.startsWith('cube-imagery-block') && o.visible) blocks.push(o); });
    const activeStats = { ...layer.stats }, heightCount = blocks.filter(b => b.geometry.hasAttribute('surfaceHeightKm')).length;
    layer.setOptions({ maxLevel: 8 }); const unsplit = render('cube-unsplit');
    let splitDifference = 0; for (let i = 0; i < on.length; i += 4) if (Math.abs(on[i] - unsplit[i]) > 3) splitDifference++;
    layer.setOptions({ maxLevel: 9 }); render();
    manager.setSurfaceAppearance({ ...defaults }); const restored = render('cube-off-again');
    layer.debug = 'unlit'; const debugOff = render('cube-debug'); manager.setSurfaceAppearance({ ...defaults, contours: true }); const debugOn = render();
    layer.debug = 'none';
    // Zoom, tilted view, and repeated block rebuilds exercise the same production callbacks.
    for (let i = 0; i < 12; i++) {
      camera.position.set(i % 2 ? 4000 : 0, 0, i % 2 ? -15000 : -45000); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
      manager.setSurfaceAppearance({ ...defaults, contours: i % 3 !== 0 }); render(i === 11 ? 'cube-tilted' : undefined);
    }
    manager.setSurfaceAppearance({ ...defaults }); render();
    let remainingHeights = 0; loaded.scene.traverse(o => { if (o.isMesh && o.geometry.hasAttribute('surfaceHeightKm')) remainingHeights++; });
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const result = { gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), surfaceTriangles: source.geometry.userData.surfaceTriangles,
      changedPixels: changed, splitDifferencePixels: splitDifference, blocks: activeStats.blocks, blocksWithHeights: heightCount, displayedLevels: activeStats.displayedLevels,
      restored: restored.every((v, i) => v === off[i]), debugUnchanged: debugOn.every((v, i) => v === debugOff[i]), remainingHeights, captures };
    manager.dispose(); renderer.dispose(); return result;
  });
  for (const c of result.captures) await writeFile(`${output}/${c.name}.png`, Buffer.from(c.png.split(',')[1], 'base64'));
  delete result.captures; result.errors = errors;
  await writeFile(`${output}/metrics.json`, JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []); assert.ok(result.changedPixels > 100, JSON.stringify(result));
  assert.ok(result.splitDifferencePixels < 100, JSON.stringify(result));
  assert.ok(result.blocks > 1); assert.equal(result.blocksWithHeights, result.blocks);
  assert.ok(result.restored); assert.ok(result.debugUnchanged); assert.equal(result.remainingHeights, 0);
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); await server.close(); }
