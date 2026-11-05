/** Cached hidden LOD tiles must not change the visible hillshade field. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.SURFACE_VIEWER_URL ?? 'http://127.0.0.1:5182';
const output = 'docs/validation/surface-appearance/lod';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(message.text())) errors.push(message.text()); });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async modulePath => {
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const { SurfaceAppearance, DEFAULT_SURFACE_APPEARANCE } = await import(modulePath);
    const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
    renderer.setSize(300, 300); renderer.setClearColor(0);
    const camera = new THREE.OrthographicCamera(-1.2, 1.2, 1.2, -1.2, 0.1, 100);
    camera.position.z = 20;
    const datum = { referenceShape: { kind: 'sphere', radiusKm: 1737.4 }, heightConvention: 'radial', verticalDatum: 'reference-sphere' };
    const matrix = new THREE.Matrix4().makeTranslation(0, 0, 1737400);
    const settings = { ...DEFAULT_SURFACE_APPEARANCE, baseColor: 'neutral', imageryAmount: 0, hillshade: true, azimuthDeg: 90, elevationDeg: 40, contrast: 3 };
    const make = fine => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(fine
        ? [0, 0, 0, 1, 0, 0.5, 0, 1, 0]
        : [0, 0, 0, 0, 1, 0, -1, 0, 0], 3));
      geometry.computeVertexNormals();
      return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
    };
    const capture = scene => {
      renderer.render(scene, camera);
      const gl = renderer.getContext(), pixels = new Uint8Array(300 * 300 * 4);
      gl.readPixels(0, 0, 300, 300, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let litPixels = 0;
      for (let p = 0; p < pixels.length; p += 4) if (pixels[p] > 0 || pixels[p + 1] > 0 || pixels[p + 2] > 0) litPixels++;
      if (litPixels < 1000) throw new Error(`Expected visible shaded terrain; found ${litPixels} lit pixels`);
      return { pixels, png: renderer.domElement.toDataURL() };
    };
    const direct = fine => {
      const scene = new THREE.Scene(), tile = make(fine), style = new SurfaceAppearance(datum);
      scene.add(tile); style.attach(tile, matrix); style.set(settings); style.update(Infinity);
      return capture(scene);
    };
    const expectedFine = direct(true), expectedCoarse = direct(false);
    const scene = new THREE.Scene(), coarse = make(false), fine = make(true), parent = new THREE.Group();
    scene.add(coarse, parent); parent.add(fine); parent.visible = false;
    const style = new SurfaceAppearance(datum);
    style.attach(coarse, matrix); style.attach(fine, matrix); style.set(settings); style.update(Infinity);
    const checks = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const zoom of ['fine', 'coarse']) {
        coarse.visible = zoom === 'coarse'; parent.visible = zoom === 'fine';
        style.update(cycle ? 0 : Infinity);
        const actual = capture(scene), expected = zoom === 'fine' ? expectedFine : expectedCoarse;
        let changedPixels = 0;
        for (let p = 0; p < actual.pixels.length; p += 4) {
          if (actual.pixels[p] !== expected.pixels[p] || actual.pixels[p + 1] !== expected.pixels[p + 1] || actual.pixels[p + 2] !== expected.pixels[p + 2]) changedPixels++;
        }
        checks.push({ cycle, zoom, changedPixels, png: actual.png });
      }
    }
    renderer.dispose();
    return { checks, directFine: expectedFine.png, directCoarse: expectedCoarse.png };
  }, `/@fs/${resolve('packages/three/dist/SurfaceAppearance.js')}`);
  assert.deepEqual(errors, []);
  for (const check of result.checks) {
    await writeFile(`${output}/${check.zoom}-${check.cycle}.png`, Buffer.from(check.png.split(',')[1], 'base64'));
    delete check.png;
    assert.equal(check.changedPixels, 0, JSON.stringify(check));
  }
  for (const name of ['directFine', 'directCoarse']) {
    await writeFile(`${output}/${name}.png`, Buffer.from(result[name].split(',')[1], 'base64'));
    delete result[name];
  }
  await writeFile(`${output}/metrics.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(result);
} finally { await browser.close(); }
