/** Capture production MoonFall terrain on the viewer serving this checkout.
 * node scripts/test-lunar-textured-lighting.mjs http://127.0.0.1:5296 /tmp/lunar-textured-lighting
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const base = process.argv[2] ?? 'http://127.0.0.1:5296';
const out = process.argv[3] ?? 'work/lunar-textured-lighting';
const pilot = process.argv.includes('--copernicus');
const catalog = pilot ? 'experiments/moon-copernicus-photometry' : 'moonfall-shackleton';
const locations = {
  copernicus: [9.6447, -20.3651],
  farSide: [-79.7, -143.2],
  kocher: [-84.4671, -134.0244],
  monsKocher: [-85.46, -118.06],
  deForestN: [-79.1656, -165.7583],
  zeeman: [-75.0682, -135.0613],
  shackleton: [-89.67, 129.78],
};
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.CHROMIUM_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROMIUM_PATH,
  args: process.platform === 'darwin' ? ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] : [],
});
const captures = {};
const comparisons = {};
const pixels = new Map();

function compare(label, from, to, crop) {
  const a = pixels.get(from), b = pixels.get(to);
  let absolute = 0, changed = 0, darkened = 0, count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (crop) {
      const x = (i / 4) % a.width, y = Math.floor(i / 4 / a.width);
      if (x < crop.left || x >= crop.right || y < crop.top || y >= crop.bottom) continue;
    }
    const difference = b.data[i] - a.data[i];
    count++;
    absolute += Math.abs(difference);
    changed += Math.abs(difference) >= 3;
    darkened += difference <= -3;
  }
  return comparisons[label] = {
    crop, meanAbsoluteDn: absolute / count, changedFraction: changed / count, darkenedFraction: darkened / count,
  };
}

async function run() {
  const page = await browser.newPage({ viewport: { width: 1080, height: 760 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /shader|GL_INVALID|WebGLProgram/i.test(message.text())) errors.push(message.text());
  });
  await page.goto(new URL(`/?catalog=test-catalogs/${catalog}&test=1&solarExposure=fixed`, base).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady === true, null, { timeout: 120_000 });
  const overview = await page.evaluate(() => {
    const r = window.renderer;
    window.cosmo.setPlaying(false);
    window.cosmo.untrack();
    r.setLabelsVisible(false);
    r.setTrajectoriesVisible(false);
    r.setTerrainShadowMode('off');
    const c = r.camera, controls = r.cameraController.controls;
    controls.enableDamping = false;
    return { eye: c.position.toArray(), target: controls.target.toArray(), up: c.up.toArray() };
  });

  const pose = (time, distance, site = locations.farSide) => page.evaluate(({ time, distance, site, overview }) => {
    const r = window.renderer;
    if (!window.cosmo.setTime({ kind: 'calendar', text: time })) throw new Error(time);
    r.renderFrame();
    const b = r.getBodyMesh('Moon'), c = r.camera, controls = r.cameraController.controls;
    if (distance === null) {
      c.position.fromArray(overview.eye);
      c.up.fromArray(overview.up);
      controls.target.fromArray(overview.target);
    } else {
      const [lat, lon] = site.map(value => value * Math.PI / 180);
      const basis = b.bodyToWorldQuaternion(new b.quaternion.constructor());
      const radial = c.position.clone().set(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)).applyQuaternion(basis);
      const north = c.position.clone().set(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)).applyQuaternion(basis);
      const centre = b.getWorldPosition(c.position.clone());
      controls.target.copy(centre).addScaledVector(radial, 1737.4 * r.scaleFactor);
      c.position.copy(controls.target).addScaledVector(radial, distance * r.scaleFactor).addScaledVector(north, -0.35 * distance * r.scaleFactor);
      c.up.copy(north);
    }
    c.lookAt(controls.target);
    r.renderFrame();
  }, { time, distance, site, overview });

  const settle = (streamed = true) => page.waitForFunction(streamed => {
    const b = window.renderer.getBodyMesh('Moon'), m = b.terrainManager;
    if (!streamed) return b.mesh.visible && !b.terrainVisible;
    const s = m.cubeImageryStats, n = m.metrics.network;
    return b.surfaceTransitionState === 'streamed' && s?.baseUncoveredBlocks === 0
      && !s.inFlight && !s.queued && !n.queued && !n.downloading && !n.parsing;
  }, streamed, { timeout: 120_000 });

  const shadows = async mode => {
    await page.evaluate(mode => window.renderer.setTerrainShadowMode(mode), mode);
    if (mode === 'off') return;
    await page.waitForFunction(() => {
      const s = window.renderer.getBodyMesh('Moon').solarShadowStatus;
      return (s?.state === 'ready' || s?.state === 'partial') && s.siteFade >= .99;
    }, null, { timeout: 120_000 });
  };

  // Reproduce the old declaration in memory without swapping products or forcing new tile requests.
  const legacy = enabled => page.evaluate(enabled => {
    const layers = window.renderer.getBodyMesh('Moon').terrainManager.cubeImageryLayer.sources;
    for (const { info } of layers.filter(source => ['wac', 'nac'].includes(source.info.id))) {
      info.illumination = enabled ? 'unknown' : 'baked';
    }
  }, enabled);

  const layerVisibility = (id, visible) => page.evaluate(({ id, visible }) => {
    window.renderer.getBodyMesh('Moon').setImageryLayerVisible(id, visible);
  }, { id, visible });

  const capture = async (name, utc, forceGlobe = false) => {
    const { png, state } = await page.evaluate(({ locations, forceGlobe }) => {
      const r = window.renderer, b = r.getBodyMesh('Moon'), m = b.terrainManager, c = r.camera;
      const webgl = r.getContext().webglRenderer, gl = webgl.getContext();
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      const q = b.bodyToWorldQuaternion(new b.quaternion.constructor()).invert();
      const center = b.getWorldPosition(c.position.clone());
      const position = p => p.clone().sub(center).applyQuaternion(q).divideScalar(r.scaleFactor).toArray();
      const samples = [];
      for (let i = 0; i < 17; i++) {
        const start = performance.now();
        r.renderFrame();
        if (i >= 2) samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      const tiles = [...m.tiles.visibleTiles].filter(t => t.engineData?.scene?.visible && !m.culledScenes.includes(t.engineData.scene));
      const materials = new Set();
      for (const tile of tiles) tile.engineData.scene.traverse(node => {
        if (node.isMesh && node.material) {
          const { normalMap, roughness, metalness } = node.material;
          materials.add(JSON.stringify({ normalMap: !!normalMap, roughness, metalness }));
        }
      });
      let png = webgl.domElement.toDataURL().split(',')[1];
      if (forceGlobe) {
        // Keep terrain updates and camera state identical, but draw only the globe for this frame.
        const update = b.updateTerrain;
        b.updateTerrain = function (...args) {
          update.apply(this, args);
          this.mesh.visible = true;
          m.group.visible = false;
        };
        try {
          r.renderFrame();
          png = webgl.domElement.toDataURL().split(',')[1];
        } finally {
          b.updateTerrain = update;
          b.mesh.visible = false;
          m.group.visible = true;
        }
      }
      return {
        png,
        state: {
          gpu: gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
          eyeKm: position(c.position), targetKm: position(r.cameraController.controls.target),
          up: c.up.clone().applyQuaternion(q).toArray(), fov: c.fov,
          solar: Object.fromEntries(Object.entries(locations).map(([key, [lat, lon]]) => [key, r.solarGeometryAt('Moon', lat, lon)])),
          sunFixed: r.getBodyMesh('Sun').position.clone().sub(b.position).normalize().applyQuaternion(q).toArray(),
          shadows: r.terrainShadowSummary(), clipmap: b.solarShadowStatus, transition: b.surfaceTransitionState,
          vehicles: Object.fromEntries(['Polaris-A', 'Polaris-B', 'Polaris-C', 'Polaris-D'].map(name =>
            [name, r.getBodyMesh(name)?.shadowUniforms.uTerrainSunVisibility.value]).filter(([, fraction]) => fraction !== undefined)),
          forcedGlobe: forceGlobe,
          globeMaterial: {
            type: b.mesh.material.type, map: !!b.mesh.material.map,
            normalMap: !!b.mesh.material.normalMap, displacement: !!b.mesh.material.displacementMap,
          },
          terrain: m.metrics.tiles, drawnTreeDepths: [...new Set(tiles.map(t => t.internal.depth))].sort(),
          imagery: m.cubeImageryStats, sources: b.imageryLayers.map(({ id, illumination, visible, view }) => ({ id, illumination, visible, view })),
          renderSubmissionMedianMs: samples[7], toneMapping: webgl.toneMapping, exposure: webgl.toneMappingExposure,
          environment: !!r.scene.environment, ambient: r.ambientLight.color.getHex(),
          hillshade: b.surfaceAppearance?.hillshade ?? false, materials: [...materials].map(s => JSON.parse(s)),
        },
      };
    }, { locations, forceGlobe });
    const data = Buffer.from(png, 'base64');
    await writeFile(join(out, name + '.png'), data);
    pixels.set(name, PNG.sync.read(data));
    captures[name] = { utc, ...state };
    await writeFile(join(out, 'results.json'), JSON.stringify({ captures, comparisons }, null, 2) + '\n');
    console.log(name, state.transition, state.shadows?.state);
  };

  if (pilot) {
    const site = locations.copernicus;
    const time = '2028-12-10T06:00:00Z', later = '2028-12-26T00:00:00Z';
    await pose(time, 68, site);
    await settle();
    await capture('original-natural', time);
    await page.evaluate(() => window.renderer.setLightingMode('flood'));
    await capture('original-flood', time);
    await page.getByRole('button', { name: 'Surface layers', exact: true }).click();
    await page.getByRole('button', { name: 'Moon imagery' }).click();
    const control = page.getByRole('checkbox', { name: /Show WAC normalized reflectance/ });
    await control.click();
    await page.waitForFunction(() => {
      const moon = window.renderer.getBodyMesh('Moon');
      const layer = moon.imageryLayers.find(l => l.id === 'wac-emp-copernicus');
      return layer?.illumination === 'reflectance' && layer.view?.zoomLevel >= 7;
    }, null, { timeout: 90_000 });
    await settle();
    await capture('normalized-flood', time);
    await page.evaluate(() => window.renderer.setLightingMode('natural'));
    await capture('normalized-natural', time);
    await shadows('high');
    await capture('normalized-high', time);
    assert.ok(compare('normalization', 'original-flood', 'normalized-flood').changedFraction > .05);
    assert.ok(compare('directional lighting', 'normalized-flood', 'normalized-natural').darkenedFraction > .05);
    assert.ok(compare('shadow toggle', 'normalized-natural', 'normalized-high').darkenedFraction > .01);
    await pose(later, 68, site);
    await settle();
    await shadows('high');
    await capture('normalized-time-change', later);
    await page.evaluate(() => window.renderer.setLightingMode('flood'));
    await capture('normalized-flood-high', later);
    assert.ok(compare('time invariance in Flood', 'normalized-flood', 'normalized-flood-high').changedFraction < .002);
    await pose(later, 125, site);
    await settle();
    await capture('bounded-overlay', later);
    await control.click();
    await settle();
    await capture('bounded-overlay-off', later);
    const bound = compare('outside imagery footprint', 'bounded-overlay', 'bounded-overlay-off', { left: 0, right: 180, top: 0, bottom: 760 });
    assert.ok(bound.changedFraction < .002);
    await pose(later, 68, site);
    await settle();
    await capture('ordinary-wac-restored', later);
    assert.ok(compare('restore WAC', 'original-flood', 'ordinary-wac-restored').changedFraction < .002);
    assert.deepEqual(errors, []);
    await writeFile(join(out, 'results.json'), JSON.stringify({ captures, comparisons }, null, 2) + '\n');
    return;
  }

  for (const { name, time, distance } of [
    { name: 'kocher-low', time: '2028-12-18T18:00:00Z', distance: 235 },
    { name: 'kocher-higher', time: '2028-12-13T12:00:00Z', distance: 235 },
    { name: 'shackleton', time: '2028-12-15T10:04:00Z', distance: null },
  ]) {
    await shadows('off');
    await pose(time, distance);
    await settle();
    await capture(name + '-baked', time);
    assert.ok(captures[name + '-baked'].sources.filter(s => ['wac', 'nac'].includes(s.id)).every(s => s.illumination === 'baked'));
    await shadows('high');
    await capture(name + '-baked-shadows', time);
    await legacy(true);
    await capture(name + '-legacy-shadows', time);
    await shadows('off');
    await capture(name + '-legacy', time);
    await legacy(false);

    compare(name + ': observed shadow toggle', name + '-baked', name + '-baked-shadows');
    assert.ok(compare(name + ': legacy shadow toggle', name + '-legacy', name + '-legacy-shadows').darkenedFraction > .001);
    assert.ok(compare(name + ': remove second lighting pass', name + '-legacy', name + '-baked').changedFraction > .1);
    const a = captures[name + '-baked'], b = captures[name + '-legacy'];
    assert.deepEqual(a.eyeKm, b.eyeKm);
    assert.deepEqual(a.targetKm, b.targetKm);
    assert.deepEqual(a.up, b.up);
    assert.deepEqual(a.drawnTreeDepths, b.drawnTreeDepths);
    assert.equal(a.imagery.tiles, b.imagery.tiles);
    assert.equal(a.imagery.requests, b.imagery.requests);
    await page.evaluate(() => window.renderer.setLightingMode('flood'));
    await capture(name + '-flood', time);
    await page.evaluate(() => window.renderer.setLightingMode('natural'));

    if (name === 'kocher-low') {
      await legacy(true);
      await page.evaluate(() => { window.renderer.ambientLight.intensity = 0; });
      await capture(name + '-legacy-no-ambient', time);
      await page.evaluate(() => { window.renderer.ambientLight.intensity = 1; });
      compare('ambient isolation', name + '-legacy', name + '-legacy-no-ambient');
      await legacy(false);
      await shadows('high');
      await page.evaluate(() => window.renderer.setTerrainShadowDebug(4));
      await capture(name + '-neutral-shadows', time);
      await page.evaluate(() => window.renderer.setTerrainShadowDebug(5));
      await capture(name + '-neutral', time);
      await page.evaluate(() => window.renderer.setTerrainShadowDebug(0));
      await shadows('off');
    }

    if (name !== 'kocher-higher') {
      await layerVisibility('nac', false);
      await settle();
      await capture(name + '-wac-only', time);
      compare(name + ': contribution of NAC', name + '-baked', name + '-wac-only');
      await layerVisibility('nac', true);
      await settle();
    }
  }
  assert.ok(comparisons['shackleton: observed shadow toggle'].darkenedFraction > .001);
  assert.ok(Object.values(captures['shackleton-baked-shadows'].vehicles).some(fraction => fraction < .99));
  assert.ok(Object.values(captures['shackleton-baked'].vehicles).every(fraction => fraction === 1));

  const terminatorTime = '2028-12-18T18:00:00Z';
  for (const [suffix, utc] of [['', terminatorTime], ['-later', '2028-12-18T23:00:00Z']]) {
    await shadows('off');
    await pose(utc, 991);
    await settle();
    await capture('terminator-off' + suffix, utc);
    await shadows('high');
    await capture('terminator-high' + suffix, utc);
    assert.equal(captures['terminator-high' + suffix].clipmap.levels.length, 1);
    assert.ok(compare('orbital horizon' + suffix, 'terminator-off' + suffix, 'terminator-high' + suffix).changedFraction > .01);
  }
  await pose(terminatorTime, 1400);
  await settle();
  await capture('terminator-out-of-range-high', terminatorTime);
  assert.equal(captures['terminator-out-of-range-high'].clipmap.state, 'out-of-range');
  await shadows('off');
  await capture('terminator-out-of-range-off', terminatorTime);
  assert.equal(compare('out-of-range fallback', 'terminator-out-of-range-off', 'terminator-out-of-range-high').changedFraction, 0);

  const time = '2028-12-15T10:04:00Z';
  await pose(time, null);
  await settle();
  const display = page.getByRole('button', { name: 'Display', exact: true });
  await display.click();
  const lighting = page.getByRole('combobox', { name: 'Lighting', exact: true });
  const shadowControl = page.getByRole('combobox', { name: 'Terrain shadows' });
  const status = page.getByTestId('terrain-shadow-status');
  const expectStatus = phrase => status.getByText(phrase, { exact: false }).waitFor();
  assert.equal(await shadowControl.inputValue(), 'off');
  await expectStatus('The simulated Sun moves the day/night boundary');
  await shadowControl.selectOption('high');
  await page.waitForFunction(() => /loaded (terrain )?heights|layered over|shadow detail/.test(
    document.querySelector('[data-testid="terrain-shadow-status"]')?.textContent ?? ''));
  await lighting.selectOption('flood');
  await expectStatus('Flood shows the imagery');
  await capture('shackleton-flood-high', time);
  assert.equal(compare('Flood ignores High', 'shackleton-flood', 'shackleton-flood-high').changedFraction, 0);
  await lighting.selectOption('natural');
  await shadowControl.selectOption('off');
  await lighting.selectOption('shadow');
  await expectStatus('The simulated night side is brighter');
  await capture('shackleton-shadow-mode', time);
  await lighting.selectOption('flood');
  await expectStatus('Flood shows the imagery');
  await capture('shackleton-flood-mode', time);
  assert.ok(compare('Shackleton: Natural to Shadow', 'shackleton-baked', 'shackleton-shadow-mode').changedFraction > .01);
  assert.ok(compare('Shackleton: Shadow to Flood', 'shackleton-shadow-mode', 'shackleton-flood-mode').changedFraction > .01);
  await lighting.selectOption('natural');

  const orbitalSite = [-20, -145];
  // Lock the epoch, then move the actual camera over successive animation frames.
  await pose(time, 40_000, orbitalSite);
  await settle(false);
  await capture('orbital-static', time);
  assert.equal(await status.count(), 0, 'The static globe must not inherit the streamed imagery status');
  const dolly = (from, to) => page.evaluate(async ({ from, to }) => {
    const r = window.renderer, b = r.getBodyMesh('Moon');
    const { controls } = r.cameraController, camera = r.camera;
    const offset = camera.position.clone().sub(controls.target).divideScalar(from);
    const states = [];
    for (let i = 0; i <= 80; i++) {
      const distance = from * (to / from) ** (i / 80);
      camera.position.copy(controls.target).addScaledVector(offset, distance);
      r.renderFrame();
      const clip = b.solarShadowStatus;
      const range = clip?.state === 'off' ? null : clip?.rangeKm ?? null;
      if (states.at(-1)?.state !== b.surfaceTransitionState || states.at(-1)?.range !== range) {
        states.push({ state: b.surfaceTransitionState, distance, range, baseUncovered: b.terrainManager.cubeImageryStats?.baseUncoveredBlocks });
      }
      await new Promise(requestAnimationFrame);
    }
    return states;
  }, { from, to });
  // The 80px show threshold is reached at roughly 12,500 km from lunar centre.
  const inbound = await dolly(40_000, 11_500);
  await settle();
  await expectStatus('Photographic shadows remain');
  await capture('orbital-streamed-baked', time);
  await legacy(true);
  await capture('orbital-streamed-legacy', time);
  await legacy(false);
  await capture('orbital-matched-globe', time, true);
  // Same tight rectangular crop in all paths. Includes black corner pixels outside the disk.
  const disk = { left: 450, top: 315, right: 630, bottom: 495 };
  const matched = compare('globe versus baked stream, same camera', 'orbital-matched-globe', 'orbital-streamed-baked', disk);
  compare('globe versus legacy stream, same camera', 'orbital-matched-globe', 'orbital-streamed-legacy', disk);
  assert.ok(matched.changedFraction > .1);
  assert.deepEqual(captures['orbital-matched-globe'].eyeKm, captures['orbital-streamed-baked'].eyeKm);
  assert.deepEqual(captures['orbital-matched-globe'].targetKm, captures['orbital-streamed-baked'].targetKm);
  assert.deepEqual(captures['orbital-matched-globe'].up, captures['orbital-streamed-baked'].up);
  await lighting.selectOption('flood');
  await expectStatus('Flood shows the imagery');
  await capture('orbital-flood-streamed', time);
  await capture('orbital-flood-globe', time, true);
  compare('globe versus baked stream in Flood, same camera', 'orbital-flood-globe', 'orbital-flood-streamed', disk);
  await lighting.selectOption('natural');

  const outbound = await dolly(11_500, 40_000);
  await settle(false);
  await capture('orbital-static-again', time);
  assert.deepEqual(outbound.map(sample => sample.state), ['streamed', 'preloading', 'static']);
  assert.ok(inbound.some(sample => sample.state === 'preloading'));
  assert.ok([...inbound, ...outbound].filter(sample => sample.state === 'streamed').every(sample => sample.baseUncovered === 0));
  assert.equal(compare('return to orbit', 'orbital-static', 'orbital-static-again').changedFraction, 0);
  assert.equal(await status.count(), 0);
  await writeFile(join(out, 'transitions.json'), JSON.stringify({ inbound, outbound }, null, 2) + '\n');
  await display.click();

  await pose(time, null);
  await settle();
  await capture('shackleton-streamed-again', time);
  assert.ok(compare('return from orbit', 'shackleton-baked', 'shackleton-streamed-again').changedFraction < .005);
  await pose(terminatorTime, 280);
  await settle();
  await shadows('high');
  const outwardShadow = await dolly(280, 390);
  await settle();
  await shadows('high');
  await capture('orbital-after-dolly', terminatorTime);
  const inwardShadow = await dolly(390, 280);
  await settle();
  await shadows('high');
  await capture('near-after-dolly', terminatorTime);
  assert.deepEqual(outwardShadow.map(sample => sample.range), [320, 1500]);
  assert.deepEqual(inwardShadow.map(sample => sample.range), [1500, 320]);
  assert.ok([...outwardShadow, ...inwardShadow].every(sample => sample.state === 'streamed' && sample.baseUncovered === 0));
  await writeFile(join(out, 'shadow-transitions.json'), JSON.stringify({ outwardShadow, inwardShadow }, null, 2) + '\n');
  await shadows('off');
  await pose(time, null);
  await settle();
  await display.click();
  await page.setViewportSize({ width: 390, height: 780 });
  await shadowControl.scrollIntoViewIfNeeded();
  await expectStatus('Photographic shadows remain');
  assert.equal(await shadowControl.getAttribute('aria-describedby'), 'terrain-shadow-status');
  await page.screenshot({ path: join(out, 'compact-display.png') });
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'results.json'), JSON.stringify({ captures, comparisons }, null, 2) + '\n');
}

try {
  await run();
} finally {
  await browser.close();
}
