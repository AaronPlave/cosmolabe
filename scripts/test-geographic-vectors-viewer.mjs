/** Real viewer integration smoke: hosted-relative GeoJSON, automatic drawing,
 * physical oblate coordinates, shared feature picking and fallback readout. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = process.env.CL_OUTPUT ?? 'docs/validation/geographic-vectors';
const browser = await chromium.launch({ executablePath: process.env.CL_CHROMIUM ?? '/usr/bin/chromium',
  args: process.env.CL_GPU === 'hardware'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  page.setDefaultNavigationTimeout(60_000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(m.text())) errors.push(m.text()); });
  const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173/';
  await page.goto(`${base}?test=1`, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async ({ base, root }) => {
    const { loadCatalogUrl, getUniverse, getCurrentRenderer } = await import('/src/lib/loader.ts');
    const { geodeticToBodyFixed } = await import(`/@fs/${root}/packages/core/src/index.ts`);
    const THREE = await import('/node_modules/.vite/deps/three.js');
    await loadCatalogUrl(document.querySelector('canvas'), new URL('test-catalogs/geographic-vectors.json', base).href, 'Geographic vector validation');
    const renderer = getCurrentRenderer(); renderer.stop(); renderer.setLabelsVisible(false); renderer.setLightingMode('flood'); renderer.renderFrame();
    const layer = getUniverse().geographicLayers.get('jezero-science');
    const position = layer.features[0].geometry.coordinates;
    const p = geodeticToBodyFixed(position, layer.datum);
    const bm = renderer.getBodyMesh('Mars');
    const world = new THREE.Vector3(p.xKm, p.yKm, p.zKm).multiplyScalar(renderer.scaleFactor)
      .applyQuaternion(bm.bodyToWorldQuaternion(new THREE.Quaternion())).add(bm.position);
    const projected = world.clone().project(renderer.camera);
    const canvas = renderer.renderer.domElement, rect = canvas.getBoundingClientRect();
    const hit = renderer.pickScene((projected.x + 1) / 2 * rect.width, (1 - projected.y) / 2 * rect.height, 'select', { labelSlopPx: 0 });
    if (hit?.kind === 'geographic-feature') renderer.geographicVectors.setSelected(hit);
    renderer.renderFrame();
    const gl = renderer.renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { features: renderer.geographicVectors.featureCount, diagnostics: renderer.geographicVectors.diagnostics,
      gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      projected: projected.toArray(), camera: renderer.camera.position.toArray(), rotation: bm.bodyToWorldQuaternion(new THREE.Quaternion()).toArray(),
      hit, readout: document.querySelector('.cl-geographic-status')?.textContent, png: canvas.toDataURL() };
  }, { base, root: resolve('.') });
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/viewer-reference.png`, Buffer.from(result.png.split(',')[1], 'base64'));
  delete result.png;
  result.chrome = [];
  for (const [name, viewport] of [['desktop', { width: 1100, height: 760 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    // The host caches panel rectangles for 250 ms, including after resize.
    await page.waitForTimeout(300);
    const chrome = await page.evaluate(async () => {
      const { getCurrentRenderer } = await import('/src/lib/loader.ts');
      const renderer = getCurrentRenderer(); renderer.renderFrame();
      const element = document.querySelector('.cl-geographic-status');
      const rect = element.getBoundingClientRect();
      const overlaps = [...document.querySelectorAll('[data-scene-occluder]')].filter(other => {
        const b = other.getBoundingClientRect();
        return b.width && b.height && rect.left < b.right && rect.right > b.left && rect.top < b.bottom && rect.bottom > b.top;
      }).map(other => other.className);
      return { visible: getComputedStyle(element).visibility !== 'hidden',
        bounds: rect.toJSON(), overlaps, readout: element.textContent };
    });
    assert.equal(chrome.visible, true, `${name}: readout should fit beside viewer chrome`);
    assert.ok(chrome.bounds.width >= 250 && chrome.bounds.height <= 48, `${name}: readout should stay compact and readable after resize`);
    assert.deepEqual(chrome.overlaps, [], `${name}: readout must clear viewer chrome`);
    result.chrome.push({ name, viewport, ...chrome });
    await page.screenshot({ path: `${output}/viewer-chrome-${name}.png` });
  }
  await writeFile(`${output}/viewer.json`, JSON.stringify({ ...result, errors }, null, 2) + '\n');
  assert.deepEqual(errors, []);
  assert.equal(result.features, 9);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.hit?.kind, 'geographic-feature');
  assert.equal(result.hit?.layerId, 'jezero-science');
  assert.equal(result.hit?.featureId, 'string:science');
  assert.match(result.readout, /reference globe/);
  console.log(result);
} finally { await browser.close(); }
