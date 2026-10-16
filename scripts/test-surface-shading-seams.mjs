/** Render a shared planar boundary whose tile vertex normals disagree.
 * The legacy normal path creates a lighting seam; geometry-derived hillshade
 * must produce the same radiance on both sides without modifying those normals.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.SURFACE_VIEWER_URL ?? 'http://127.0.0.1:5182';
const output = 'docs/validation/surface-appearance/seams';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(msg.text())) errors.push(msg.text()); });
  await page.goto(base);
  const result = await page.evaluate(async modulePath => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const { SurfaceAppearance, DEFAULT_SURFACE_APPEARANCE } = await import(modulePath);
    const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
    renderer.setSize(400, 200);
    renderer.setClearColor(0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const camera = new THREE.OrthographicCamera(-1, 1, 0.5, -0.5, 0.1, 10);
    camera.position.z = 2;
    const datum = { referenceShape: { kind: 'sphere', radiusKm: 1737.4 }, heightConvention: 'radial', verticalDatum: 'reference-sphere' };
    function capture(legacy) {
      const scene = new THREE.Scene();
      for (const [left, right, bias] of [[-1, 0, 0.6], [0, 1, -0.6]]) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([left, -0.5, 0, right, -0.5, 0, right, 0.5, 0, left, 0.5, 0], 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute([0, bias, 0.8, 0, bias, 0.8, 0, bias, 0.8, 0, bias, 0.8], 3));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        const material = new THREE.MeshStandardMaterial();
        const mesh = new THREE.Mesh(g, material);
        const style = new SurfaceAppearance(datum);
        style.set({ ...DEFAULT_SURFACE_APPEARANCE, baseColor: 'neutral', imageryAmount: 0, hillshade: true, azimuthDeg: 90 });
        style.attach(mesh, new THREE.Matrix4().makeTranslation(0, 0, 1737400));
        style.update(Infinity);
        if (legacy) {
          const compile = material.onBeforeCompile, key = material.customProgramCacheKey;
          material.onBeforeCompile = (shader, r) => {
            compile(shader, r);
            shader.vertexShader = 'varying vec3 vLegacyNormal;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvLegacyNormal = normal;');
            shader.fragmentShader = 'varying vec3 vLegacyNormal;\n' + shader.fragmentShader.replace(/vec3 saNormal = [^;]+;/, 'vec3 saNormal = normalize(mat3(saLocalToBody) * vLegacyNormal);');
          };
          material.customProgramCacheKey = () => key() + '_legacy';
        }
        scene.add(mesh);
      }
      renderer.render(scene, camera);
      const gl = renderer.getContext(), pixels = new Uint8Array(400 * 200 * 4);
      gl.readPixels(0, 0, 400, 200, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const rgb = x => Array.from(pixels.slice((100 * 400 + x) * 4, (100 * 400 + x) * 4 + 3));
      const left = rgb(190), right = rgb(210);
      const jump = Math.max(...left.map((value, i) => Math.abs(value - right[i])));
      const png = renderer.domElement.toDataURL();
      scene.traverse(mesh => { if (mesh.isMesh) { mesh.geometry.dispose(); mesh.material.dispose(); } });
      return { left, right, jump, png };
    }
    const legacy = capture(true), current = capture(false);
    renderer.dispose();
    return { legacy, current };
  }, `/@fs/${resolve('packages/three/dist/SurfaceAppearance.js')}`);
  assert.deepEqual(errors, []);
  assert.ok(result.legacy.jump > 20, 'fixture must reproduce a visible normal seam');
  assert.ok(result.current.jump <= 1, 'coplanar shared edge must shade continuously');
  for (const [name, capture] of Object.entries(result)) {
    await writeFile(`${output}/${name}.png`, Buffer.from(capture.png.split(',')[1], 'base64'));
    delete capture.png;
  }
  await writeFile(`${output}/metrics.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(result);
} finally { await browser.close(); }
