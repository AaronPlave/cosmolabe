// Actual published oblate Mars product, ordinary dev or deployed viewer.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const [viewerUrl, out] = process.argv.slice(2);
assert(viewerUrl && out, 'Usage: test-mars-surface-appearance.mjs VIEWER_URL OUT_DIR');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: [process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  page.on('request', r => { if (/\/cube-(terrain|imagery)\//.test(r.url())) requests.push(r.url()); });
  page.on('response', r => { if (/\/cube-(terrain|imagery)\//.test(r.url()) && !r.ok()) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.renderer?.getBodyMesh('Mars')?.surfaceAppearanceStatus.state === 'ready', null, { timeout: 120000 });
  // The local pilot performs one automatic imagery-debug framing after assets
  // arrive. Wait for that initialization before testing ordinary lit styles.
  if (await page.locator('#surface-pilot-reset').count()) await page.waitForFunction(() => window.renderer.getBodyMesh('Mars').terrainDebugMode === 'imagery-unlit');
  await page.evaluate(() => { window.cosmo.setPlaying(false); window.cosmo.select('Mars'); window.renderer.setTerrainDebugMode('none', 'Mars'); });
  const fly = page.getByRole('button', { name: 'Fly to HiRISE ortho — native detail', exact: true });
  if (!await fly.isVisible()) await page.locator('summary').filter({ hasText: 'Imagery' }).click();
  await fly.click();
  await page.waitForFunction(() => !window.renderer.cameraController._anim);
  const settle = async () => {
    await page.waitForFunction(() => {
      const b = window.renderer.getBodyMesh('Mars'), tm = b.terrainManager, n = tm.metrics.network, i = tm.cubeImageryStats;
      return tm.surfaceAppearanceStatus.state === 'ready' && !b.mesh.visible && i?.maxDisplayedLevel >= 14 &&
        i.baseUncoveredBlocks === 0 && i.failedTiles === 0 && n.queued + n.downloading + n.parsing + i.inFlight + i.queued + tm.cubeStats.inFlight === 0;
    }, null, { timeout: 120000 });
    await page.waitForTimeout(1000);
  };
  await settle();
  await page.evaluate(() => window.renderer.pickSurface(0, 0));
  await settle();
  const before = await page.evaluate(() => {
    const r = window.renderer, b = r.getBodyMesh('Mars'), tm = b.terrainManager;
    const physical = [];
    for (const scene of tm.cubeScenes) scene.traverse(m => {
      if (!m.isMesh || m.name.startsWith('cube-imagery-block ')) return;
      for (const name of ['position', 'normal', 'index']) {
        const a = name === 'index' ? m.geometry.index : m.geometry.getAttribute(name);
        if (a) physical.push({ geometry: m.geometry, name, array: a.array, copy: a.array.slice() });
      }
    });
    const grids = [...tm.cube.source.sampler.tiles.values()].map(t => ({ tile: t, array: t.elevationsKm, copy: t.elevationsKm.slice() }));
    window.marsAppearanceBaseline = { physical, grids, gridRequests: tm.cubeStats.requests };
    const gl = r.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { datum: tm.surfaceAppearanceDatum, status: tm.surfaceAppearanceStatus, sourceBuffers: physical.length, grids: grids.length,
      gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), physicalPick: r.pickSurface(0, 0)?.physical?.kind };
  });
  assert.equal(before.datum.referenceShape.kind, 'ellipsoid');
  assert.equal(before.datum.heightConvention, 'geodetic-normal');
  assert.equal(before.physicalPick, 'hit');
  const requestCount = requests.length;
  const base = page.getByRole('combobox', { name: 'Surface base color', exact: true });
  await base.selectOption('elevation');
  await page.getByRole('checkbox', { name: 'Contours', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Hillshade effect', exact: true }).check();
  await settle();
  const styled = await page.evaluate(() => {
    const r = window.renderer, tm = r.getBodyMesh('Mars').terrainManager;
    let checkedVertices = 0, maxNormalHeightErrorKm = 0, maxNormalVsRadialOffsetKm = 0, derivedMeshes = 0;
    for (const [mesh, entry] of tm.surfaceStyle.meshes) {
      const heights = mesh.geometry.getAttribute('surfaceHeightKm');
      if (!heights) continue;
      if (entry.derived) { derivedMeshes++; continue; }
      const positions = mesh.geometry.getAttribute('position'), V = r.camera.position.constructor;
      for (let i = 0; i < positions.count; i += Math.max(1, Math.floor(positions.count / 32))) {
        const p = new V().fromBufferAttribute(positions, i).applyMatrix4(entry.matrix).multiplyScalar(0.001);
        const normal = tm.bodyFixedToGeodetic({ xKm: p.x, yKm: p.y, zKm: p.z }).heightKm;
        maxNormalHeightErrorKm = Math.max(maxNormalHeightErrorKm, Math.abs(heights.getX(i) - normal));
        maxNormalVsRadialOffsetKm = Math.max(maxNormalVsRadialOffsetKm, Math.abs(normal - (p.length() - tm.cube.source.manifest.geometry.referenceRadiusKm)));
        checkedVertices++;
      }
    }
    return { debugMode: r.getBodyMesh('Mars').terrainDebugMode, checkedVertices, maxNormalHeightErrorKm, maxNormalVsRadialOffsetKm, derivedMeshes, tintPick: r.pickSurfaceTintHeight(r.renderer.domElement.clientWidth / 2, r.renderer.domElement.clientHeight / 2),
      physicalPick: r.pickSurface(0, 0)?.physical?.kind, settings: tm.surfaceAppearance, imagery: tm.cubeImageryStats };
  });
  assert(styled.checkedVertices > 0 && styled.derivedMeshes > 0);
  assert.equal(styled.debugMode, 'none');
  assert(styled.maxNormalHeightErrorKm < 0.00001, 'styled heights must use geodetic normals');
  assert(styled.maxNormalVsRadialOffsetKm > 1, 'fixture must distinguish normal heights from radial offsets');
  assert.equal(styled.physicalPick, 'hit');
  assert(Number.isFinite(styled.tintPick?.heightKm), 'styled rendered range pick must be available');
  assert.equal(requests.length, requestCount, 'enabling styles must not fetch data');
  const capture = await page.screenshot({ path: `${out}/elevation-contours-hillshade.png` });
  const { data, info } = await sharp(capture).extract({ left: 50, top: 70, width: 850, height: 750 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let coloredPixels = 0;
  for (let i = 0; i < data.length; i += info.channels) if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 20) coloredPixels++;
  assert(coloredPixels > 10000, 'elevation colors must render in the terrain viewport, beyond grayscale imagery and controls');
  // A close Mars view resolves metre-scale contours. The former manual menu
  // started at 10 m, so choosing any fixed interval could remove every line
  // from the crop even though automatic spacing resolved to 1 m.
  const contourToggle = page.getByRole('checkbox', { name: 'Contours', exact: true });
  const intervalSelect = page.getByRole('combobox', { name: 'Contour interval', exact: true });
  const terrainPixels = async () => sharp(await page.screenshot()).extract({ left: 50, top: 70, width: 850, height: 750 }).removeAlpha().raw().toBuffer();
  await contourToggle.uncheck();
  await page.waitForTimeout(300);
  const withoutContours = await terrainPixels();
  await contourToggle.check();
  const fixedContours = [];
  for (const intervalKm of [0.001, 0.002, 0.005]) {
    await intervalSelect.selectOption(String(intervalKm));
    await page.waitForTimeout(300);
    const resolved = await page.evaluate(() => {
      const b = window.renderer.getBodyMesh('Mars');
      return { selected: b.surfaceAppearance.contourIntervalKm, rendered: b.surfaceContourIntervalKm };
    });
    assert.equal(resolved.selected, intervalKm);
    assert.equal(resolved.rendered, intervalKm);
    const pixels = await terrainPixels();
    let changedPixels = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      if (Math.max(...[0, 1, 2].map(c => Math.abs(pixels[i + c] - withoutContours[i + c]))) > 8) changedPixels++;
    }
    assert(changedPixels > 100, `${intervalKm * 1000} m fixed contours must visibly render on Mars`);
    fixedContours.push({ intervalKm, changedPixels, ...resolved });
    await page.screenshot({ path: `${out}/fixed-contours-${intervalKm * 1000}m.png` });
  }
  // Larger intervals remain literal; do not invent contour levels merely to
  // keep lines visible on a patch with less relief than the requested spacing.
  for (const intervalKm of [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]) {
    await intervalSelect.selectOption(String(intervalKm));
    assert.equal(await page.evaluate(() => window.renderer.getBodyMesh('Mars').surfaceContourIntervalKm), intervalKm);
  }
  await intervalSelect.selectOption('0');
  await settle();
  assert.equal(await page.evaluate(() => window.renderer.getBodyMesh('Mars').surfaceAppearance.contourIntervalKm), 0);
  assert.equal(requests.length, requestCount, 'contour interval edits must not fetch data');
  // Refinement and coarser fallback must still work while styles are enabled.
  await page.getByRole('checkbox', { name: 'Show HiRISE ortho — native detail', exact: true }).uncheck();
  await page.waitForFunction(() => window.renderer.getBodyMesh('Mars').terrainManager.cubeImageryStats.maxDisplayedLevel <= 13);
  await page.screenshot({ path: `${out}/styled-coarse-fallback.png` });
  await page.getByRole('checkbox', { name: 'Show HiRISE ortho — native detail', exact: true }).check();
  await settle();
  // Let explicit imagery toggle requests finish before testing style-only work.
  const requestsAfterLayerToggle = requests.length;
  await base.selectOption('neutral');
  await settle();
  await page.screenshot({ path: `${out}/neutral-hillshade.png` });
  await page.getByRole('checkbox', { name: 'Contours', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Hillshade effect', exact: true }).uncheck();
  await base.selectOption('imagery');
  await settle();
  await page.screenshot({ path: `${out}/disabled-restored-imagery.png` });
  await base.selectOption('elevation');
  await page.getByRole('checkbox', { name: 'Hillshade effect', exact: true }).check();
  await settle();
  await page.screenshot({ path: `${out}/reenabled.png` });
  const invariant = await page.evaluate(() => {
    const baseline = window.marsAppearanceBaseline, tm = window.renderer.getBodyMesh('Mars').terrainManager;
    return { unchangedPhysicalBuffers: baseline.physical.every(a => (a.name === 'index' ? a.geometry.index : a.geometry.getAttribute(a.name)).array === a.array && a.array.length === a.copy.length && a.array.every((v, i) => v === a.copy[i])),
      unchangedCpuGrids: baseline.grids.every(a => a.tile.elevationsKm === a.array && a.array.every((v, i) => v === a.copy[i])),
      gridRequestsBefore: baseline.gridRequests, gridRequestsAfter: tm.cubeStats.requests, status: tm.surfaceAppearanceStatus,
      imagery: tm.cubeImageryStats, physicalPick: window.renderer.pickSurface(0, 0)?.physical?.kind };
  });
  assert.equal(invariant.unchangedPhysicalBuffers, true); assert.equal(invariant.unchangedCpuGrids, true);
  assert.equal(invariant.gridRequestsAfter, invariant.gridRequestsBefore);
  assert.equal(requests.length, requestsAfterLayerToggle, 'style-only toggles must not fetch data');
  assert.equal(invariant.imagery.baseUncoveredBlocks, 0);
  // Also check the much smaller visible height range at the declared crop
  // viewpoint. Even 2 m may legitimately have no crossing in this close view.
  await page.evaluate(() => window.renderer.applyNamedViewpoint('Native detail', { animate: false }));
  await settle();
  const closeWithoutContours = await terrainPixels();
  await contourToggle.check();
  await intervalSelect.selectOption('0.001');
  await page.waitForTimeout(300);
  const closeWithContours = await terrainPixels();
  let closeContourPixels = 0;
  for (let i = 0; i < closeWithContours.length; i += 3) {
    if (Math.max(...[0, 1, 2].map(c => Math.abs(closeWithContours[i + c] - closeWithoutContours[i + c]))) > 8) closeContourPixels++;
  }
  assert(closeContourPixels > 100, '1 m fixed contours must render in the close native-detail view');
  await page.screenshot({ path: `${out}/close-fixed-contours-1m.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  // The responsive dock replaces its panel nodes after the viewport changes.
  await page.waitForTimeout(500);
  await base.waitFor({ state: 'visible' });
  await base.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/compact-controls.png` });
  const compact = await base.boundingBox();
  assert(compact && compact.x >= 0 && compact.x + compact.width <= 390, 'appearance selector must fit the compact viewer');
  assert.deepEqual(errors, []);
  const evidence = { viewerUrl, viewerOrigin: new URL(viewerUrl).origin, testMode: false, requestInterception: false,
    before, styled, coloredPixels, fixedContours, closeContourPixels, invariant, compact, initialRequests: requestCount, finalRequests: requests.length, errors };
  await writeFile(`${out}/appearance.json`, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ gpu: before.gpu, checkedVertices: styled.checkedVertices, invariant, errors }));
} finally { await browser.close(); }
