/** Offline GPU regression: intact glyphs on slopes, foreground occlusion,
 * ordinary/logarithmic depth, and resource restoration. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 5197, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(m.text())) errors.push(m.text()); });
  await page.route('**/label-test', r => r.fulfill({ contentType: 'text/html', body: '<body style="margin:0;background:black"></body>' }));
  await page.goto(`${server.resolvedUrls.local[0]}label-test`);
  const results = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { TerrainContourLabels } = await import('/packages/three/src/TerrainContourLabels.ts');
    const { DEFAULT_SURFACE_APPEARANCE } = await import('/packages/three/src/SurfaceAppearance.ts');
    const result = [];
    for (const logarithmicDepthBuffer of [false, true]) for (const orthographic of [false, true]) {
      const renderer = new THREE.WebGLRenderer({ logarithmicDepthBuffer, preserveDrawingBuffer: true });
      renderer.setSize(512, 512); renderer.setClearColor(0);
      document.body.append(renderer.domElement);
      const scene = new THREE.Scene(), camera = orthographic
        ? new THREE.OrthographicCamera(-225, 225, 225, -225, 0.01, 1e6)
        : new THREE.PerspectiveCamera(50, 1, 0.01, 1e6);
      camera.position.z = 500; camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
      const geometry = new THREE.PlaneGeometry(400, 400, 8, 8), p = geometry.getAttribute('position');
      geometry.setAttribute('surfaceHeightKm', new THREE.Float32BufferAttribute(Array.from({ length: p.count }, (_, i) => p.getX(i) / 100), 1));
      geometry.setAttribute('surfaceGround', new THREE.Float32BufferAttribute(new Array(p.count).fill(1), 1));
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0 }));
      mesh.rotation.x = Math.PI / 3; scene.add(mesh);
      const labels = new TerrainContourLabels(); scene.add(labels.group);
      const settings = { ...DEFAULT_SURFACE_APPEARANCE, contours: true, contourLabels: true, contourIntervalKm: 1, contourOpacity: 1, contourColor: '#ffffff' };
      for (let i = 0; i < 10; i++) labels.update(camera, 512, 512, [mesh], settings);
      const sprites = labels.group.children.filter(s => s.visible);
      const pixels = () => {
        renderer.render(scene, camera);
        const gl = renderer.getContext(), data = new Uint8Array(512 * 512 * 4);
        gl.readPixels(0, 0, 512, 512, gl.RGBA, gl.UNSIGNED_BYTE, data);
        return data;
      };
      const lit = data => { let count = 0; for (let i = 0; i < data.length; i += 4) if (data[i] > 60) count++; return count; };
      const sloped = pixels();
      sprites.forEach(s => { s.material.depthTest = false; });
      const unrestricted = pixels();
      sprites.forEach(s => { s.material.depthTest = true; });
      const occluder = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), new THREE.MeshBasicMaterial({ color: 0 }));
      occluder.position.z = 200; scene.add(occluder);
      const occluded = pixels();
      occluder.visible = false;
      // Regression sensitivity: standard flat billboard depth clips glyphs.
      sprites.forEach(s => { s.material.onBeforeCompile = () => {}; s.material.customProgramCacheKey = () => 'flat-control'; s.material.needsUpdate = true; });
      const flat = pixels();
      labels.update(camera, 512, 512, [mesh], { ...settings, contours: false });
      const disabled = pixels();
      result.push({ logarithmicDepthBuffer, orthographic, labels: sprites.length, sloped: lit(sloped), unrestricted: lit(unrestricted), occluded: lit(occluded), flat: lit(flat), disabled: lit(disabled) });
      labels.dispose(); geometry.dispose(); mesh.material.dispose(); occluder.geometry.dispose(); occluder.material.dispose(); renderer.dispose(); renderer.domElement.remove();
    }
    return result;
  });
  console.log(JSON.stringify({ results, errors }, null, 2));
  for (const r of results) {
    assert.ok(r.labels > 0 && r.sloped > 80, 'must render real text');
    assert.ok(r.sloped >= r.unrestricted * 0.98, 'slope depth must preserve full glyphs');
    assert.ok(r.flat < r.sloped * 0.9, 'flat billboard negative control must clip text');
    assert.equal(r.occluded, 0, 'foreground terrain must hide labels');
    assert.equal(r.disabled, 0, 'disabling contours must hide labels');
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await server.close(); }
