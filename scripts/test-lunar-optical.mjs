/** Real lunar product comparison, #147. Run against this checkout's Vite server:
 * node scripts/test-lunar-optical.mjs http://127.0.0.1:5198 --baseline
 * node scripts/test-lunar-optical.mjs http://127.0.0.1:5198
 * Captures and measurements go to ignored work/lunar-optical/.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { loadDatasets } from './data-hosting/lib/datasets.mjs';
import { rewriteCatalog } from './data-hosting/lib/hosted-catalogs.mjs';

const base = process.argv[2] ?? 'http://127.0.0.1:5198';
const baseline = process.argv.includes('--baseline');
const hosted = process.argv.includes('--hosted');
const defaultOnly = process.argv.includes('--default-only');
const out = 'work/lunar-optical', label = baseline ? 'baseline' : 'separate';
await mkdir(out, { recursive: true });
const path = 'apps/viewer/test-catalogs/moonfall-shackleton.json';
const baselineRef = process.env.LUNAR_OPTICAL_BASELINE_REF ?? 'bcecc2ec';
const source = JSON.parse(baseline ? execFileSync('git', ['show', `${baselineRef}:${path}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) : await readFile(path, 'utf8'));
// Render original/local cube payloads. Hosted verification is separately done by
// publish-data with the production and localhost:5173 CORS origins.
const datasets = loadDatasets().datasets;
const selected = hosted ? datasets : Object.fromEntries(Object.entries(datasets).filter(([, ds]) => ds.kind === 'kernels'));
const catalog = rewriteCatalog(source, 'test-catalogs/moonfall-shackleton.json', selected,
  hosted ? `${base}/test-catalogs/__hosted/` : 'https://data.aaronplave.com').json;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROMIUM_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const report = { baseline, defaultOnly, transport: hosted ? 'hosted-through-vite-proxy' : 'local-payloads', errors: [], psrRequests: [], views: [], passed: false };
const at = (lat, lon, height) => {
  const a = lat * Math.PI / 180, b = lon * Math.PI / 180, r = 1737.4 + height;
  return [r * Math.cos(a) * Math.cos(b), r * Math.cos(a) * Math.sin(b), r * Math.sin(a)];
};
const poses = {
  shackleton: { eye: at(-89.07, 129.78, 6), target: at(-89.67, 129.78, -2.5), fov: 60 },
  pole: { eye: at(-89.5, 0, 8), target: at(-90, 0, 0), fov: 60 },
  boundary: { eye: at(-82, 0, 80), target: at(-84, 0, 0), fov: 50 },
  orbit: { eye: at(-80, 20, 450), target: at(-90, 0, 0), fov: 50 },
};
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') console.error(m.text()); });
  page.on('request', r => { if (r.url().includes('moon-imagery-cube-psr-nac-stretch/')) report.psrRequests.push(r.url()); });
  await page.route('**/test-catalogs/moonfall-shackleton.json', route => route.fulfill({ json: catalog }));
  await page.goto(`${base}/?catalog=test-catalogs/moonfall-shackleton`, { waitUntil: 'domcontentloaded' });
  console.log('Viewer document loaded');
  await page.waitForFunction(() => window.renderer?.getBodyMesh('Moon')?.terrainManager?.cubeImageryStats?.ready, null, { timeout: 180000 });
  console.log('Imagery ready');
  await page.evaluate(async defaultTime => {
    window.cosmo.setPlaying(false);
    await Promise.race([window.renderer.waitForInitialAssets(), new Promise((_, reject) => setTimeout(() => reject(new Error('Initial assets exceeded 120 seconds')), 120000))]);
    if (!window.cosmo.setTime({ kind: 'calendar', text: defaultTime })) throw new Error('Cannot set the fixed comparison epoch');
  }, source.defaultTime);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  console.log('Initial assets ready');
  report.gpu = await page.evaluate(() => {
    const gl = window.renderer.getContext().webglRenderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  });
  assert.doesNotMatch(report.gpu, /swiftshader|llvmpipe|software/i);
  const idle = () => {
    const t = window.renderer.getBodyMesh('Moon').terrainManager, n = t.metrics.network, i = t.cubeImageryStats;
    return t.tiles.visibleTiles.size > 0 && n.queued + n.downloading + n.parsing === 0 && i.ready && !i.inFlight && (!i.queued || i.budgetLimited);
  };
  const settle = async () => {
    const deadline = Date.now() + 180000;
    do {
      await page.waitForFunction(idle, null, { timeout: Math.max(1, deadline-Date.now()) });
      await page.waitForTimeout(1200);
      if (await page.evaluate(idle)) return;
    } while (Date.now() < deadline);
    throw new Error('Lunar imagery did not remain idle across refinement frames');
  };
  const pose = async view => {
    await page.evaluate(view => {
      const r = window.renderer, b = r.getBodyMesh('Moon'), V = r.camera.position.constructor;
      window.cosmo.untrack();
      const centre = new V(); b.getWorldPosition(centre);
      const world = ([x, y, z]) => new V(x, z, -y).applyQuaternion(b.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
      const eye = world(view.eye), target = world(view.target), c = r.camera, controls = r.cameraController.controls;
      controls.enableDamping = false; c.fov = view.fov; c.updateProjectionMatrix(); c.position.copy(eye);
      c.up.copy(eye.clone().sub(centre).normalize()); controls.target.copy(target); c.lookAt(target); c.updateMatrixWorld(true);
    }, view);
  };
  const capture = async (name, mode) => {
    await page.mouse.move(1100, 850); // Clear a layer-row footprint hover before capturing terrain.
    await page.evaluate(mode => window.renderer.setLightingMode(mode), mode);
    await settle();
    const stats = await page.evaluate(() => {
      const b = window.renderer.getBodyMesh('Moon'), t = b.terrainManager;
      return { imagery: t.cubeImageryStats, layers: b.imageryLayers, frame: t.frameAvailability };
    });
    assert.equal(stats.frame.kind, 'available');
    assert.equal(stats.imagery.baseUncoveredBlocks, 0); assert.equal(stats.imagery.gpuError, null);
    assert.equal(stats.imagery.failedTiles, 0);
    const canvas = await page.evaluate(() => {
      window.renderer.renderFrame(); return window.renderer.getContext().webglRenderer.domElement.toDataURL();
    });
    const bytes = Buffer.from(canvas.split(',')[1], 'base64');
    await writeFile(`${out}/${label}-${name}-${mode}.png`, bytes);
    const result = { name, mode, ...stats };
    if (!baseline && Object.hasOwn(poses, name)) {
      const a = PNG.sync.read(bytes), b = PNG.sync.read(await readFile(`${out}/baseline-${name}-${mode}.png`));
      assert.equal(a.width, b.width); assert.equal(a.height, b.height);
      let sum = 0, large = 0, max = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const error = Math.max(...[0, 1, 2].map(c => Math.abs(a.data[i + c] - b.data[i + c])));
        sum += error; large += error > 16; max = Math.max(max, error);
      }
      result.difference = { meanMaxChannelDn: sum / (a.width * a.height), fractionAbove16Dn: large / (a.width * a.height), maximumDn: max };
    }
    report.views.push(result); console.log(label, name, mode, result.difference ?? 'captured');
  };
  for (const [name, view] of Object.entries(poses)) {
    await pose(view);
    for (const mode of ['natural', 'flood']) await capture(name, mode);
  }
  if (!baseline) assert.deepEqual(report.psrRequests, [], 'disabled PSR must make no requests, including its manifest');
  if (!baseline && !defaultOnly) {
    await pose(poses.shackleton);
    await page.getByRole('button', { name: 'Surface layers', exact: true }).click();
    await page.getByRole('button', { name: 'Moon imagery', exact: true }).click();
    const nac = page.getByRole('checkbox', { name: 'Show Moon · NAC south-pole detail', exact: true });
    const psr = page.getByRole('checkbox', { name: 'Show PSR observations · stretched / indirectly lit', exact: true });
    await nac.uncheck();
    await capture('wac-only', 'flood');
    await nac.check();
    await page.getByRole('button', { name: 'Moon · NAC south-pole detail details', exact: true }).click();
    const opacity = page.getByRole('slider', { name: 'Moon · NAC south-pole detail opacity', exact: true });
    await opacity.focus(); await opacity.press('Home');
    for (let i = 0; i < 10; i++) await opacity.press('ArrowRight');
    assert.equal(await opacity.inputValue(), '0.5');
    await capture('nac-half', 'flood');
    await opacity.press('End'); await psr.check();
    await page.waitForFunction(() => window.renderer.getBodyMesh('Moon').imageryLayers.find(l => l.id === 'psr-nac').maxLevel > 0);
    for (const mode of ['natural', 'flood']) await capture('psr', mode);
    assert.ok(report.psrRequests.some(url => /\/tiles\//.test(url)), 'must load actual PSR payloads');
    await psr.uncheck();
    await capture('restored', 'flood');
    const count = report.psrRequests.length;
    await pose(poses.orbit); await settle();
    assert.equal(report.psrRequests.length, count, 'disabled PSR must stop requesting');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'PSR observations · stretched / indirectly lit details', exact: true }).click();
    assert.equal(await psr.isVisible(), true);
    assert.equal(await page.getByText(/not calibrated reflectance or sunlight at the simulation time/).isVisible(), true);
    report.compact = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(report.compact.scrollWidth <= report.compact.width);
    await page.screenshot({ path: `${out}/separate-compact-controls.png` });
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  await writeFile(`${out}/${label}${defaultOnly ? '-default' : ''}-browser.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
