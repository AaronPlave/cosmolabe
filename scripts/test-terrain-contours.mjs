/** Offline WebGL smoke test. npm run build first.
 * node scripts/test-terrain-contours.mjs
 * Uses checked-in Mars TINs and an explicitly synthetic lunar polar patch.
 * This does not certify streamed imagery, cube terrain, or hardware timings.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const output = process.env.CONTOUR_OUTPUT ?? 'work/issue-183/captures';
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 5193 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(msg.text())) errors.push(msg.text()); });
  await page.route('**/contour-smoke', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0;background:#111"></body></html>' }));
  await page.goto(`${server.resolvedUrls.local[0]}contour-smoke`);
  const results = await page.evaluate(async upstreamAvailable => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { SurfaceAppearance, DEFAULT_SURFACE_APPEARANCE: defaults } = await import('/packages/three/src/SurfaceAppearance.ts');
    const { QuantizedMeshLoader } = await import('/node_modules/3d-tiles-renderer/src/three/plugins/loaders/QuantizedMeshLoader.js');
    const { injectShadowIntoShader, makeShadowUniforms } = await import('/packages/three/src/EclipseShadow.ts');
    const { injectAerialPerspectiveIntoShader, makeAerialPerspectiveUniforms } = await import('/packages/three/src/AerialPerspective.ts');
    const { normalizeAtmosphere } = await import('/packages/three/src/AtmosphereModel.ts');
    const { getAtmospherePreset } = await import('/packages/three/src/AtmosphereMesh.ts');
    const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
    renderer.setSize(800, 600); renderer.setClearColor(0x151922); document.body.append(renderer.domElement);
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    const result = { gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), captures: [] };
    const datum = { referenceShape: { kind: 'ellipsoid', radiiKm: [3396.19, 3396.19, 3376.2] }, heightConvention: 'radial', verticalDatum: 'ellipsoid' };
    const moon = { referenceShape: { kind: 'sphere', radiusKm: 1737.4 }, heightConvention: 'radial', verticalDatum: 'reference-sphere' };
    // Procedural color texture exercises textured material composition, not
    // real imagery registration. Actual terrain TINs below are unmodified.
    const texels = new Uint8Array(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) {
      const v = 95 + 30 * Math.sin((i % 32) * 0.5) * Math.cos(Math.floor(i / 32) * 0.4);
      texels.set([v * 1.2, v, v * 0.8, 255], i * 4);
    }
    const texture = new THREE.DataTexture(texels, 32, 32); texture.needsUpdate = true;
    async function marsTile(z, x, y) {
      const loader = new QuantizedMeshLoader();
      loader.ellipsoid.radius.set(3396190 - 8765, 3396190 - 8765, 3376200 - 8765);
      loader.minLon = (x / 2 ** (z + 1) * 360 - 180) * Math.PI / 180;
      loader.maxLon = ((x + 1) / 2 ** (z + 1) * 360 - 180) * Math.PI / 180;
      loader.minLat = (y / 2 ** z * 180 - 90) * Math.PI / 180;
      loader.maxLat = ((y + 1) / 2 ** z * 180 - 90) * Math.PI / 180;
      loader.skirtLength = 10;
      return loader.parse(await (await fetch(`/packages/three/src/__tests__/fixtures/marshub-${z}-${x}-${y}.terrain`)).arrayBuffer());
    }
    for (const body of ['Mars', 'Moon-synthetic-pole', 'Moon-synthetic-globe']) {
      const scene = new THREE.Scene(), group = new THREE.Group(); scene.add(group);
      const ambient = new THREE.AmbientLight(0xffffff, 2); scene.add(ambient);
      const sun = new THREE.DirectionalLight(0xffffff, 0.3); sun.position.set(1e7, 1e7, -1e7); scene.add(sun);
      const shadows = makeShadowUniforms();
      // Compile the real eclipse/AP chain. Optical parameters stay disabled:
      // this is a material compatibility fixture, not an atmosphere scene.
      const ap = makeAerialPerspectiveUniforms(normalizeAtmosphere(getAtmospherePreset('Mars')), 3396.19, 1000, null);
      const style = new SurfaceAppearance(body === 'Mars' ? datum : moon);
      const parents = [], children = [];
      let center, up;
      if (body === 'Mars') {
        const parent = await marsTile(13, 11716, 4935); parents.push(parent);
        center = parent.position.clone(); up = center.clone().normalize();
        for (const x of [23432, 23433]) for (const y of [9870, 9871]) children.push(await marsTile(14, x, y));
      } else if (body === 'Moon-synthetic-globe') {
        // Analytic global relief, not lunar observations. At this camera scale
        // every ground pixel exceeds the former 0.5 km footprint cutoff.
        const geometry = new THREE.SphereGeometry(1737400, 256, 128), p = geometry.getAttribute('position');
        const direction = new THREE.Vector3();
        for (let i = 0; i < p.count; i++) {
          direction.fromBufferAttribute(p, i).normalize();
          const lon = Math.atan2(direction.y, direction.x), lat = Math.asin(direction.z);
          const height = 6000 * Math.sin(8 * lon) * Math.cos(lat) + 3000 * Math.sin(12 * lat);
          p.setXYZ(i, direction.x * (1737400 + height), direction.y * (1737400 + height), direction.z * (1737400 + height));
        }
        geometry.computeVertexNormals();
        center = new THREE.Vector3(); up = new THREE.Vector3(0, 0, 1);
        parents.push(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
      } else {
        const geometry = new THREE.PlaneGeometry(10000, 10000, 80, 80), p = geometry.getAttribute('position');
        center = new THREE.Vector3(0, 0, -1737400); up = new THREE.Vector3(0, 0, -1);
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), y = p.getY(i), r = Math.hypot(x, y);
          const relief = 400 * Math.exp(-(((r - 2500) / 600) ** 2)) - 250 * Math.exp(-((r / 1600) ** 2));
          p.setZ(i, 1737400 - Math.sqrt(1737400 ** 2 - r ** 2) - relief);
        }
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()); mesh.position.copy(center); parents.push(mesh);
      }
      for (const mesh of [...parents, ...children]) {
        const matrix = new THREE.Matrix4().makeTranslation(...mesh.position);
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of materials) {
          m.map = texture; m.side = THREE.DoubleSide;
          if (body === 'Mars') {
            m.onBeforeCompile = shader => { injectShadowIntoShader(shader, shadows); injectAerialPerspectiveIntoShader(shader, ap); };
            m.customProgramCacheKey = () => 'contour-shadow-ap-compatibility';
          }
        }
        style.attach(mesh, matrix); mesh.position.sub(center); group.add(mesh);
      }
      children.forEach(m => { m.visible = false; });
      const bounds = new THREE.Box3().setFromObject(group), size = bounds.getSize(new THREE.Vector3()).length();
      const target = bounds.getCenter(new THREE.Vector3());
      const camera = new THREE.PerspectiveCamera(40, 800 / 600, 0.01, size * 10);
      camera.position.copy(target).addScaledVector(up, size * 1.35); camera.lookAt(target); camera.updateMatrixWorld();
      function render(name, settings) {
        style.set({ ...defaults, ...settings }); style.update(Infinity); renderer.render(scene, camera);
        const pixels = new Uint8Array(800 * 600 * 4); gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        result.captures.push({ name: `${body}-${name}`, png: renderer.domElement.toDataURL() });
        return pixels;
      }
      const off = render('off', {}), on = render('contours', { contours: true });
      let changed = 0; for (let i = 0; i < off.length; i += 4) if (Math.abs(off[i] - on[i]) > 2) changed++;
      result[body] = { changedPixels: changed };
      render('combined', { contours: true, baseColor: 'elevation', hillshade: true });
      // On fully dark terrain the old diffuse-color injection produced no
      // visible lines. An annotation must survive absence of incident light.
      ambient.intensity = 0; sun.intensity = 0;
      const dark = render('dark-off', {});
      const darkContours = render('dark-contours', { contours: true, contourColor: '#ff0000', contourOpacity: 1 });
      let darkChanged = 0;
      for (let i = 0; i < dark.length; i += 4) if (darkContours[i] > dark[i] + 10) darkChanged++;
      result[body].darkContourPixels = darkChanged;
      ambient.intensity = 2; sun.intensity = 0.3;
      if (body === 'Mars') {
        parents.forEach(m => { m.visible = false; });
        children.forEach(m => { m.visible = true; }); render('children', { contours: true });
      }
      for (const factor of [0.25, 1, 4]) {
        camera.position.copy(target).addScaledVector(up, size * factor); camera.lookAt(target); camera.updateMatrixWorld();
        render(`zoom-${factor}`, { contours: true });
      }
      // Restore camera before comparing byte-identical disabled pixels.
      camera.position.copy(target).addScaledVector(up, size * 1.35); camera.lookAt(target); camera.updateMatrixWorld();
      children.forEach(m => { m.visible = false; }); parents.forEach(m => { m.visible = true; });
      const final = render('off-again', {});
      result[body].restored = final.every((v, i) => v === off[i]);
      result[body].heightAttributesAfterDisable = [...parents, ...children].filter(m => m.geometry.hasAttribute('surfaceHeightKm')).length;
      if (upstreamAvailable && body === 'Moon-synthetic-pole') {
        const { wrapTopoLineMaterial } = await import('/work/issue-183/wrapTopoLineMaterial.js');
        for (const mesh of parents) {
          const m = mesh.material; const params = wrapTopoLineMaterial(m, m.onBeforeCompile.bind(m));
          params.ellipsoid.value.setScalar(1737400); params.frame.value.makeTranslation(0, 0, 1737400);
          params.resolution.value.set(800, 600); params.topoColor.value.set('#f2e6c9'); params.cartoOpacity.value = 0;
          m.defines.USE_TOPO_LINES = 1; m.defines.USE_TOPO_ELLIPSOID = 1; m.needsUpdate = true;
        }
        renderer.render(scene, camera);
        result.captures.push({ name: 'upstream-0.4.27-synthetic-smoke', png: renderer.domElement.toDataURL() });
        result.upstreamEvaluated = true;
      }
      group.traverse(m => { if (m.isMesh) { m.geometry.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach(mat => mat.dispose()); } });
    }
    texture.dispose(); renderer.dispose(); return result;
  }, existsSync('work/issue-183/wrapTopoLineMaterial.js'));
  for (const { name, png } of results.captures) await writeFile(`${output}/${name}.png`, Buffer.from(png.split(',')[1], 'base64'));
  delete results.captures;
  results.errors = errors;
  await writeFile(`${output}/metrics.json`, JSON.stringify(results, null, 2));
  assert.deepEqual(errors, []);
  for (const body of ['Mars', 'Moon-synthetic-pole', 'Moon-synthetic-globe']) {
    assert.ok(results[body].changedPixels > 100, JSON.stringify(results));
    assert.ok(results[body].darkContourPixels > 100, JSON.stringify(results));
    assert.ok(results[body].restored, `${body} disabled shader did not restore original pixels`);
    assert.equal(results[body].heightAttributesAfterDisable, 0);
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); await server.close(); }
