/** Live streamed-terrain UI/shader smoke check. Start viewer dev server first.
 * SURFACE_VIEWER_URL=http://127.0.0.1:5182 node scripts/test-surface-appearance.mjs
 * Uses existing Mars/Moon sources; never substitutes a synthetic elevation mesh.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const base = process.env.SURFACE_VIEWER_URL ?? 'http://127.0.0.1:5182';
const output = 'docs/validation/surface-appearance';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const results = [];
try {
  for (const body of ['Mars', 'Moon']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    const requestFailures = [];
    const tileWarnings = [];
    let sourceImages = 0;
    page.on('requestfailed', request => requestFailures.push({ url: request.url(), error: request.failure()?.errorText }));
    page.on('response', response => { if (response.url().includes('trek.nasa.gov') && response.ok()) sourceImages++; });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => { if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(msg.text())) errors.push(msg.text()); });
    page.on('console', msg => { if (/Tile load error/.test(msg.text())) tileWarnings.push(msg.text()); });
    const mars = body === 'Mars';
    // Small fixed catalogs keep this test about terrain rather than spacecraft
    // assets/kernel availability. Source URLs/reference offset match demo scenes.
    const catalog = {
      name: `${body} surface appearance validation`, defaultViewpoint: 'Terrain',
      items: [
        { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: mars ? [-1e8, -1e8, 3e7] : [1e8, 0, -1e8] }, geometry: { type: 'Globe', radius: 695700 } },
        { name: body, class: mars ? 'planet' : 'moon', trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
          rotationModel: { type: 'Fixed', quaternion: [1, 0, 0, 0], inertialFrame: 'EclipticJ2000' }, geometry: {
          type: 'Globe', ...(mars ? { radii: [3396.19, 3396.19, 3376.2] } : { radius: 1737.4 }),
          ...(mars ? { atmosphere: 'Mars' } : {}),
          terrain: { type: 'quantized-mesh', url: `https://marshub.s3.amazonaws.com/${mars ? 'mars' : 'moon'}_v14/`,
            referenceRadiusOffsetKm: mars ? 8.765 : 0, errorTarget: 3, fadeDurationMs: 300,
            imagery: { url: mars
              ? 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg'
              : 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg', levels: 7 },
          },
        } },
        { name: 'Terrain', type: 'Viewpoint', center: body, distance: mars ? 4300 : 2100, latitude: mars ? 18 : -85, longitude: mars ? -133 : 0 },
      ],
    };
    if (mars) {
      const terrain = catalog.items[1].geometry.terrain;
      terrain.imagery = [terrain.imagery, { ...terrain.imagery, opacity: 0.35 }];
    }
    await page.route('**/surface-style-validation.json', route => route.fulfill({ json: catalog }));
    await page.goto(`${base}/?catalog=surface-style-validation&test=1`);
    await page.waitForFunction(() => window.__cosmolabe?.ready, { timeout: 120000 });
    await page.evaluate(body => { window.renderer.timeController.pause(); window.cosmo.select(body); }, body);
    const pose = await page.evaluate(body => {
      const r = window.renderer, bm = r.getBodyMesh(body);
      const p = r.camera.position.clone().sub(bm.position).applyQuaternion(bm.bodyToWorldQuaternion(r.camera.quaternion.clone()).invert());
      return { latDeg: Math.asin(p.z / p.length()) * 180 / Math.PI, lonDeg: Math.atan2(p.y, p.x) * 180 / Math.PI };
    }, body);
    assert.ok(Math.abs(pose.latDeg - (mars ? 18 : -85)) < 0.1);
    assert.ok(Math.abs(pose.lonDeg - (mars ? -133 : 0)) < 0.1);
    await page.waitForFunction(body => {
      const group = window.renderer.getBodyMesh(body).terrainTileGroup;
      let meshes = 0;
      group.traverse(c => { if (c.isMesh) meshes++; });
      return meshes > 10;
    }, body, { timeout: 120000 });
    // Let imagery arrive; readiness of terrain is intentionally separate from
    // the initial-asset gate, because it streams after the camera is established.
    await page.waitForTimeout(8000);
    async function stats() {
      return page.evaluate(async body => {
        const r = window.renderer, bm = r.getBodyMesh(body);
        const intervals = [];
        let previous = performance.now();
        for (let i = 0; i < 90; i++) {
          await new Promise(requestAnimationFrame);
          const now = performance.now(); intervals.push(now - previous); previous = now;
        }
        intervals.sort((a, b) => a - b);
        let meshes = 0, heightBytes = 0, mapped = 0, minHeight = Infinity, maxHeight = -Infinity;
        bm.terrainTileGroup.traverse(c => {
          if (!c.isMesh) return;
          meshes++;
          heightBytes += c.geometry.getAttribute('surfaceHeightKm')?.array.byteLength ?? 0;
          const heights = c.geometry.getAttribute('surfaceHeightKm')?.array ?? [];
          for (const h of heights) { minHeight = Math.min(minHeight, h); maxHeight = Math.max(maxHeight, h); }
          const materials = Array.isArray(c.material) ? c.material : [c.material];
          if (materials.some(m => m.map || m.defines?.LAYER_0_EXISTS === 1)) mapped++;
        });
        const gl = r.getContext().webglRenderer.getContext();
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return { medianFrameMs: intervals[45], p95FrameMs: intervals[85], meshes, mapped, heightBytes, minHeight, maxHeight, terrainRequests: bm.terrainMetrics.network.requests,
          memory: { ...r.getContext().webglRenderer.info.memory }, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
      }, body);
    }
    const normal = await stats();
    await page.evaluate(body => {
      window.__surfacePhysicalSnapshot = [];
      window.renderer.getBodyMesh(body).terrainTileGroup.traverse(mesh => {
        if (!mesh.isMesh) return;
        window.__surfacePhysicalSnapshot.push({ mesh, position: mesh.geometry.getAttribute('position').array.slice(), normal: mesh.geometry.getAttribute('normal').array.slice() });
      });
    }, body);
    const normalCanvas = await page.evaluate(() => window.__cosmolabe.capture());
    const terrain = await page.evaluate(body => ({ diagnostics: window.renderer.getBodyMesh(body).terrainDiagnostics, sample: window.renderer.getBodyMesh(body).sampleTerrain(body === 'Mars' ? 18 : -85, body === 'Mars' ? -133 : 0) }), body);
    assert.ok(terrain.diagnostics.tileCount > 0, 'source terrain must have decoded');
    assert.ok(sourceImages > 0, 'source imagery must have downloaded');
    assert.ok(normal.mapped > 0, `streamed imagery must be present: ${JSON.stringify(requestFailures.slice(-8))}`);
    assert.equal(normal.heightBytes, 0);
    await page.screenshot({ path: `${output}/${body.toLowerCase()}-normal.png` });
    await page.getByLabel('Surface style', { exact: true }).selectOption('hillshade');
    await page.getByLabel('Hillshade contrast', { exact: true }).fill('2');
    await page.getByLabel('Light elevation', { exact: true }).fill('20');
    await page.getByLabel('Hillshade imagery blend', { exact: true }).fill('0.35');
    const hillshade = await stats();
    await page.screenshot({ path: `${output}/${body.toLowerCase()}-hillshade.png` });
    // Actual user control interaction and renderer state agreement.
    await page.getByLabel('Light azimuth', { exact: true }).fill('90');
    assert.equal(await page.evaluate(body => window.renderer.getBodyMesh(body).surfaceAppearance.azimuthDeg, body), 90);
    await page.getByLabel('Surface style', { exact: true }).selectOption('elevation');
    await page.getByLabel('Elevation palette', { exact: true }).selectOption('blue-gold');
    await page.getByLabel('Combine hillshade', { exact: true }).check();
    await page.getByText('Fixed elevation range', { exact: true }).click();
    await page.getByLabel('Minimum elevation km').fill(mars ? '-10' : '-8');
    await page.getByLabel('Minimum elevation km').press('Tab');
    await page.getByLabel('Maximum elevation km').fill(mars ? '25' : '8');
    await page.getByLabel('Maximum elevation km').press('Tab');
    const combined = await stats();
    assert.equal(combined.terrainRequests, normal.terrainRequests, 'styles must not request additional terrain');
    assert.ok(combined.heightBytes > 0);
    assert.equal(await page.getByLabel('Elevation legend').count(), 1);
    await page.screenshot({ path: `${output}/${body.toLowerCase()}-combined.png` });
    await page.evaluate(body => window.renderer.getBodyMesh(body).setTerrainDebugMode('lod'), body);
    await page.waitForTimeout(200);
    await page.evaluate(body => window.renderer.getBodyMesh(body).setTerrainDebugMode('none'), body);
    await page.waitForTimeout(200);
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileCombined = await stats();
    await page.screenshot({ path: `${output}/${body.toLowerCase()}-mobile.png` });
    await page.getByLabel('Elevation legend').scrollIntoViewIfNeeded();
    const scrolling = await page.getByLabel('Elevation legend').evaluate(el => {
      const panel = el.closest('.instrument-body');
      const dock = panel.closest('section')?.parentElement;
      return { panelScrollTop: panel.scrollTop, dockScrollTop: dock?.scrollTop ?? 0 };
    });
    assert.ok(scrolling.panelScrollTop > 0, 'phone controls must scroll inside the panel');
    assert.equal(scrolling.dockScrollTop, 0);
    await page.screenshot({ path: `${output}/${body.toLowerCase()}-mobile-legend.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByLabel('Surface style', { exact: true }).selectOption('natural');
    const mobileRestored = await stats();
    await page.setViewportSize({ width: 1280, height: 900 });
    const restored = await stats();
    const physicalUnchanged = await page.evaluate(() => window.__surfacePhysicalSnapshot.every(({ mesh, position, normal }) => {
      const unchanged = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
      return unchanged(position, mesh.geometry.getAttribute('position').array) && unchanged(normal, mesh.geometry.getAttribute('normal').array);
    }));
    assert.ok(physicalUnchanged, 'style switching must preserve physical geometry and normals');
    const restoredCanvas = await page.evaluate(() => window.__cosmolabe.capture());
    const decode = value => PNG.sync.read(Buffer.from(value.split(',')[1], 'base64'));
    const first = decode(normalCanvas), last = decode(restoredCanvas);
    const changedPixels = pixelmatch(first.data, last.data, null, first.width, first.height, { threshold: 0.1 });
    const restoredChangedFraction = changedPixels / (first.width * first.height);
    assert.ok(restoredChangedFraction < 0.01, `normal restoration changed ${restoredChangedFraction * 100}% of pixels`);
    assert.equal(restored.heightBytes, 0);
    assert.equal(mobileRestored.heightBytes, 0);
    assert.equal(await page.getByLabel('Elevation legend').count(), 0);
    await page.screenshot({ path: `${output}/${body.toLowerCase()}-restored.png` });
    assert.deepEqual(errors, []);
    results.push({ body, pose, normal, hillshade, combined, restored, mobileCombined, mobileRestored, scrolling, physicalUnchanged, restoredChangedFraction, terrain, sourceImages, tileWarnings, requestFailures, errors });
    await writeFile(`${output}/metrics.json`, JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(results.at(-1)));
    await page.close();
  }
} finally { await browser.close(); }
