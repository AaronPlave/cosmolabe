/** Coarse-LOD hillshade regression: a smooth datum must not acquire triangle slopes.
 * Compare the previous PR implementation on identical synthetic and real geometry. */
import { chromium } from 'playwright';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.SURFACE_VIEWER_URL ?? 'http://127.0.0.1:5182';
const output = 'docs/validation/surface-appearance/curvature';
await mkdir(output, { recursive: true });
const oldSource = execFileSync('git', ['show', '842cbea:packages/three/src/SurfaceAppearance.ts'], { encoding: 'utf8' })
  .replace("'three'", "'/node_modules/.vite/deps/three.js'")
  .replace("'./TerrainSampler.js'", JSON.stringify(`/@fs/${resolve('packages/three/dist/TerrainSampler.js')}`));
const oldModule = ts.transpileModule(oldSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(message.text())) errors.push(message.text()); });
  await page.route('**/hillshade-before.js', route => route.fulfill({ contentType: 'text/javascript', body: oldModule }));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const fixture = await page.evaluate(async modulePath => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const current = await import(modulePath), before = await import('/hillshade-before.js');
    const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
    renderer.setSize(400, 400); renderer.setClearColor(0);
    const camera = new THREE.OrthographicCamera(-1.2, 1.2, 1.2, -1.2, 0.1, 10); camera.position.z = 3;
    const captures = [];
    for (const segments of [4, 16]) for (const version of ['before', 'current']) {
      const scene = new THREE.Scene(), geometry = new THREE.SphereGeometry(3396190, segments, segments);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()); mesh.scale.setScalar(1 / 3396190); scene.add(mesh);
      const style = new (version === 'before' ? before : current).SurfaceAppearance({ referenceShape: { kind: 'sphere', radiusKm: 3396.19 }, heightConvention: 'radial', verticalDatum: 'reference-sphere' });
      style.attach(mesh, new THREE.Matrix4());
      style.set({ ...current.DEFAULT_SURFACE_APPEARANCE, baseColor: 'neutral', imageryAmount: 0, hillshade: true, azimuthDeg: 100, elevationDeg: 40, contrast: 3 });
      style.update(Infinity); renderer.render(scene, camera);
      const gl = renderer.getContext(), pixels = new Uint8Array(400 * 400 * 4); gl.readPixels(0, 0, 400, 400, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const brightness = [];
      for (let y = 50; y < 350; y++) for (let x = 50; x < 350; x++) {
        const n = (y * 400 + x) * 4;
        if (pixels[n] > 0 && pixels[n + 1] > 0 && pixels[n + 2] > 0) brightness.push(pixels[n]);
      }
      captures.push({ segments, version, spread: Math.max(...brightness) - Math.min(...brightness), png: renderer.domElement.toDataURL() });
      geometry.dispose(); mesh.material.dispose();
    }
    renderer.dispose(); return captures;
  }, `/@fs/${resolve('packages/three/dist/SurfaceAppearance.js')}`);
  for (const capture of fixture) {
    await writeFile(`${output}/smooth-${capture.segments}-${capture.version}.png`, Buffer.from(capture.png.split(',')[1], 'base64')); delete capture.png;
    assert.ok(capture.version === 'current' ? capture.spread <= 1 : capture.spread > (capture.segments === 4 ? 20 : 1), JSON.stringify(capture));
  }
  console.log('Smooth sphere', fixture);
  const catalog = { name: 'Coarse hillshade review', defaultViewpoint: '5600', items: [
    { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: [1e8, -1e8, 0] }, geometry: { type: 'Globe', radius: 695700 } },
    { name: 'Mars', class: 'planet', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, rotationModel: { type: 'Fixed', quaternion: [1, 0, 0, 0], inertialFrame: 'EclipticJ2000' }, geometry: {
      type: 'Globe', radii: [3396.19, 3396.19, 3376.2], terrain: { type: 'quantized-mesh', url: 'https://marshub.s3.amazonaws.com/mars_v14/', referenceRadiusOffsetKm: 8.765, errorTarget: 2,
        imagery: { url: 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg', levels: 7 } },
    } }, ...[5600, 9000, 3800].map(distance => ({ name: String(distance), type: 'Viewpoint', center: 'Mars', distance, latitude: -40, longitude: 70 })),
  ] };
  await page.route('**/coarse-hillshade.json', route => route.fulfill({ json: catalog }));
  await page.goto(`${base}/?catalog=coarse-hillshade&test=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__cosmolabe?.ready, { timeout: 120000 });
  await page.evaluate(() => { window.renderer.timeController.pause(); window.cosmo.select('Mars'); });
  await page.waitForFunction(() => window.renderer.getBodyMesh('Mars').terrainDiagnostics.tileCount > 10, { timeout: 120000 });
  const live = [];
  for (const range of [5600, 9000, 3800]) {
    await page.evaluate(range => window.renderer.applyNamedViewpoint(String(range)), range);
    await page.waitForTimeout(6000);
    await page.getByLabel('Hillshade effect', { exact: true }).check();
    await page.getByLabel('Light azimuth', { exact: true }).fill('100');
    await page.getByLabel('Light elevation', { exact: true }).fill('40');
    await page.getByLabel('Hillshade contrast', { exact: true }).fill('3');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${output}/mars-${range}-current.png` });
    const result = await page.evaluate(async () => {
      const THREE = await import('/node_modules/.vite/deps/three.js');
      const { SurfaceAppearance } = await import('/hillshade-before.js');
      const bm = window.renderer.getBodyMesh('Mars'), current = bm.terrainManager.surfaceStyle;
      const old = new SurfaceAppearance(current.datum), copies = [];
      for (const [mesh, entry] of current.meshes) {
        if (!entry.ready) continue;
        const geometry = mesh.geometry.clone();
        for (const name of ['surfaceReliefNormal', 'surfaceGround']) geometry.deleteAttribute(name);
        const copy = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
        old.attach(copy, entry.matrix); copies.push({ mesh, copy });
      }
      old.set(current.current); old.update(Infinity);
      window.__curvatureRestore = [];
      for (const { mesh, copy } of copies) {
        const attribute = mesh.geometry.getAttribute('surfaceReliefNormal');
        mesh.geometry.setAttribute('surfaceReliefNormal', copy.geometry.getAttribute('surfaceReliefNormal'));
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const compile = material.onBeforeCompile, key = material.customProgramCacheKey;
          window.__curvatureRestore.push({ mesh, attribute, material, compile, key, copy });
          material.onBeforeCompile = (shader, renderer) => { compile(shader, renderer); shader.fragmentShader = shader.fragmentShader.replace('normalize(saUp + vSAReliefNormal)', 'normalize(vSAReliefNormal)'); };
          material.customProgramCacheKey = () => key() + '_curvature_before'; material.needsUpdate = true;
        }
      }
      return { rangeKm: bm.position.distanceTo(window.renderer.camera.position) / window.renderer.scaleFactor, meshes: copies.length, source: bm.terrainDiagnostics };
    });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${output}/mars-${range}-before.png` });
    await page.evaluate(() => { for (const r of window.__curvatureRestore) {
      r.mesh.geometry.setAttribute('surfaceReliefNormal', r.attribute); r.material.onBeforeCompile = r.compile; r.material.customProgramCacheKey = r.key; r.material.needsUpdate = true;
      r.copy.geometry.dispose(); r.copy.material.dispose();
    } window.__curvatureRestore = []; });
    await page.getByLabel('Hillshade effect', { exact: true }).uncheck();
    await page.screenshot({ path: `${output}/mars-${range}-imagery.png` });
    live.push(result); console.log('Live', result);
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/metrics.json`, JSON.stringify({ fixture, live, errors }, null, 2) + '\n');
} finally { await browser.close(); }
