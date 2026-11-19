/** Exercise the local Apollo 17 catalog through the viewer. Run with node, a viewer URL, and an output directory. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const base = process.argv[2] ?? 'http://127.0.0.1:5296';
const out = process.argv[3] ?? '/tmp/apollo17-viewer';
const catalog = 'test-catalogs/experiments/moon-apollo17-photometry';
const site = [20.190, 30.794];
const epochs = {
  high: '2009-10-01T10:32:10Z',
  middle: '2010-05-21T13:00:54.5Z',
  low: '2010-06-17T20:55:15.5Z',
  night: '2010-07-09T20:55:15.5Z',
};
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.CHROMIUM_PATH ? undefined : 'chrome',
  executablePath: process.env.CHROMIUM_PATH,
  args: process.platform === 'darwin' ? ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] : [],
});
const frames = {};
const screenshots = new Map();

function difference(a, b) {
  const p = screenshots.get(a), q = screenshots.get(b);
  assert.equal(p.width, q.width);
  assert.equal(p.height, q.height);
  let count = 0, changed = 0, darkened = 0, sum = 0;
  for (let y = 0.2 * p.height | 0; y < 0.8 * p.height; y++) {
    for (let x = 0.2 * p.width | 0; x < 0.8 * p.width; x++) {
      const i = (y * p.width + x) * 4;
      const d = q.data[i] - p.data[i];
      count++;
      sum += Math.abs(d);
      if (Math.abs(d) > 2) changed++;
      if (d < -2) darkened++;
    }
  }
  return { changed: changed / count, darkened: darkened / count, meanAbsoluteDn: sum / count };
}

try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /shader|GL_INVALID|WebGLProgram/i.test(message.text())) errors.push(message.text());
  });
  const url = new URL(base);
  url.searchParams.set('catalog', catalog);
  url.searchParams.set('test', '1');
  url.searchParams.set('solarExposure', 'fixed');
  const ready = () => page.waitForFunction(() => window.__cosmolabe?.assetsReady, null, { timeout: 120_000 });
  const settle = (layer = 'apollo17-original') => page.waitForFunction(layer => {
    const b = window.renderer.getBodyMesh('Moon'), m = b?.terrainManager;
    const s = m?.cubeImageryStats, n = m?.metrics.network;
    return b.surfaceTransitionState === 'streamed' && s?.baseUncoveredBlocks === 0 &&
      !s.inFlight && !s.queued && !n.downloading && !n.queued && !n.parsing &&
      (!layer || b.imageryLayers.some(l => l.id === layer && l.visible && l.view?.inCoverage && !l.view.missingTiles));
  }, layer, { timeout: 120_000 });
  const waitShadows = () => page.waitForFunction(() => {
    const clip = window.renderer.getBodyMesh('Moon').solarShadowStatus;
    return ['ready', 'partial'].includes(clip?.state) && clip.siteFade >= 0.99;
  }, null, { timeout: 150_000 });
  const showImagery = async () => {
    await page.getByRole('button', { name: 'Surface layers', exact: true }).click();
    await page.getByRole('region', { name: 'Moon surface layers' })
      .getByRole('button', { name: /Moon imagery/ }).click();
    return page.getByRole('checkbox', { name: 'Show Apollo 17 · Original NAC' });
  };

  const pose = (utc, height = 1.72, south = 0) => page.evaluate(({ utc, site, height, south }) => {
    const r = window.renderer, b = r.getBodyMesh('Moon'), c = r.camera;
    const camera = r.cameraController.controls;
    window.cosmo.setPlaying(false);
    if (!window.cosmo.setTime({ kind: 'calendar', text: utc })) throw Error(utc);
    r.renderFrame();
    camera.enableDamping = false;
    const [lat, lon] = site.map(angle => angle * Math.PI / 180);
    const q = b.bodyToWorldQuaternion(new b.quaternion.constructor());
    const centre = b.getWorldPosition(c.position.clone());
    const radial = c.position.clone().set(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)).applyQuaternion(q);
    const north = c.position.clone().set(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)).applyQuaternion(q);
    camera.target.copy(centre).addScaledVector(radial, 1734.758 * r.scaleFactor);
    c.position.copy(camera.target).addScaledVector(radial, height * r.scaleFactor).addScaledVector(north, -south * r.scaleFactor);
    c.up.copy(north);
    c.lookAt(camera.target);
    r.renderFrame();
  }, { utc, site, height, south });

  async function capture(name) {
    const data = await page.evaluate(site => {
      const r = window.renderer, b = r.getBodyMesh('Moon'), m = b.terrainManager;
      const webgl = r.getContext().webglRenderer, gl = webgl.getContext();
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      r.renderFrame();
      const depths = [...new Set([...m.tiles.visibleTiles].filter(t => t.engineData?.scene?.visible)
        .map(t => t.internal.depth))].sort((a, b) => a - b);
      const camera = r.camera;
      const centre = b.getWorldPosition(camera.position.clone());
      const rotation = b.bodyToWorldQuaternion(new b.quaternion.constructor());
      const groundPixels = [[0, 0], [-.0015, 0], [.0015, 0], [0, -.0015], [0, .0015]]
        .map(([dy, dx]) => {
          const latitude = site[0] + dy, longitude = site[1] + dx;
          const sample = m.sampleResident(latitude, longitude);
          if (!sample) return null;
          const [lat, lon] = [latitude, longitude].map(value => value * Math.PI / 180);
          const p = camera.position.clone().set(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat))
            .multiplyScalar((1737.4 + sample.elevationKm) * r.scaleFactor).applyQuaternion(rotation).add(centre).project(camera);
          return [Math.round((p.x + 1) * webgl.domElement.width / 2), Math.round((1 - p.y) * webgl.domElement.height / 2)];
        });
      return {
        image: webgl.domElement.toDataURL().split(',')[1],
        gpu: gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
        solar: r.solarGeometryAt('Moon', ...site), clip: b.solarShadowStatus,
        sources: b.imageryLayers.map(({ id, visible, status, view }) => ({ id, visible, status, view })),
        cpu: m.cubeCoverage(...site), terrain: m.cubeStats.version, depths, groundPixels,
      };
    }, site);
    const png = Buffer.from(data.image, 'base64');
    delete data.image;
    frames[name] = data;
    const image = PNG.sync.read(png);
    screenshots.set(name, image);
    data.groundDn = data.groundPixels.map(point => {
      if (!point) return null;
      const [x, y] = point;
      if (x < 2 || x >= image.width - 2 || y < 2 || y >= image.height - 2) return null;
      let sum = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) sum += image.data[((y + dy) * image.width + x + dx) * 4];
      }
      return sum / 25;
    });
    await writeFile(join(out, name + '.png'), png);
    console.log(name, data.gpu, data.solar.elevationDeg.toFixed(2), data.depths.join(','));
  }

  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await ready();
  await page.evaluate(() => {
    window.cosmo.setPlaying(false);
    window.cosmo.select('Moon');
    window.renderer.setLabelsVisible(false);
    window.renderer.setTrajectoriesVisible(false);
  });
  await pose(epochs.high);
  await settle();
  await waitShadows();
  await capture('original-high');
  assert.ok(frames['original-high'].depths.some(level => level >= 13));
  assert.match(frames['original-high'].terrain, /m15/);
  assert.ok(frames['original-high'].solar.elevationDeg > 65);

  const heights = await page.evaluate(async site => {
    const m = window.renderer.getBodyMesh('Moon').terrainManager;
    const a = await m.requestAnalysisSample(...site);
    const b = await m.requestAnalysisSample(20.19, 31.25);
    return [a?.elevationKm, b?.elevationKm];
  }, site);
  assert.ok(Math.abs(heights[0] + 2.642) < 0.01, `Pilot height ${heights[0]} km`);
  assert.ok(Number.isFinite(heights[1]), 'Global terrain outside the pilot');

  await page.evaluate(() => window.renderer.setLightingMode('flood'));
  await capture('original-flood');
  await page.evaluate(() => window.renderer.setLightingMode('natural'));

  const normalized = await page.evaluate(() =>
    window.renderer.getBodyMesh('Moon').imageryLayers.some(l => l.id === 'apollo17-normalized'));
  if (normalized) {
    assert.equal(await page.evaluate(() =>
      window.renderer.getBodyMesh('Moon').imageryLayers.find(l => l.id === 'apollo17-normalized').visible), false);
    await page.evaluate(() => window.renderer.setImageryLightingMode('simulated'));
    await pose(epochs.low);
    await settle();
    await waitShadows();
    await capture('original-approx-low');
    await page.evaluate(() => window.renderer.setImageryLightingMode('original'));
    await pose(epochs.high);
  }
  await page.evaluate(normalized => {
    const r = window.renderer, b = r.getBodyMesh('Moon');
    if (normalized) {
      b.setImageryLayerVisible('apollo17-original', false);
      b.setImageryLayerVisible('apollo17-normalized', true);
    } else {
      r.setImageryLightingMode('simulated');
    }
  }, normalized);
  const layer = normalized ? 'apollo17-normalized' : 'apollo17-original';
  await settle(layer);
  if (normalized) {
    await page.evaluate(() => window.renderer.setLightingMode('flood'));
    await capture('normalized-flood');
    await page.evaluate(() => window.renderer.setLightingMode('natural'));
    await waitShadows();
  }
  await capture('simulated-high');
  await pose(epochs.middle);
  await settle(layer);
  await waitShadows();
  await capture('simulated-middle');
  await pose(epochs.low);
  await settle(layer);
  await page.evaluate(() => window.renderer.setTerrainShadowMode('off'));
  await capture('low-shadows-off');
  await page.evaluate(() => window.renderer.setTerrainShadowMode('high'));
  await waitShadows();
  await capture('simulated-low');
  const changingSun = difference('simulated-high', 'simulated-low');
  const shadowToggle = difference('low-shadows-off', 'simulated-low');
  assert.ok(changingSun.changed > 0.25);
  assert.ok(shadowToggle.darkened > 0.003, JSON.stringify(shadowToggle));
  assert.ok(frames['simulated-low'].solar.elevationDeg < 13);

  await pose(epochs.low, 1.10, 0.95);
  await settle(layer);
  await waitShadows();
  await capture('low-oblique');
  await pose(epochs.low, 0.22, 0.14);
  await settle(layer);
  await waitShadows();
  await capture('low-close');
  const stationary = frames['simulated-low'].groundDn;
  const poseDnDifferences = ['low-oblique', 'low-close'].map(name =>
    frames[name].groundDn.flatMap((dn, i) => dn === null || stationary[i] === null ? [] : [Math.abs(dn - stationary[i])]));
  assert.ok(poseDnDifferences.every(pose => pose.length >= 3 && Math.max(...pose) < 24), JSON.stringify(poseDnDifferences));

  await pose(epochs.night);
  await settle(layer);
  await capture('night');
  const night = screenshots.get('night');
  const centre = (Math.floor(night.height / 2) * night.width + Math.floor(night.width / 2)) * 4;
  assert.ok(frames.night.solar.elevationDeg < -20);
  assert.ok(night.data[centre] < 12, `Night centre DN ${night.data[centre]}`);

  await pose(epochs.high);
  const requests = [];
  page.on('request', req => {
    if (/moon-imagery-cube-apollo17-.*\/(tiles\/|imagery\.json)/.test(req.url())) requests.push(req.url());
  });
  const selectedLayer = await showImagery();
  const toggle = normalized ? page.getByRole('checkbox', { name: 'Show Apollo 17 · Normalized NAC' }) : selectedLayer;
  await toggle.uncheck();
  await settle(null);
  await capture('wac-fallback');
  await toggle.check();
  await settle(layer);
  await capture('reenabled');
  assert.ok(difference('wac-fallback', 'reenabled').changed > 0.25);
  assert.equal(requests.filter(value => value.endsWith('imagery.json')).length, 0, 'Optional manifest cache reused');

  const links = {};
  for (const [name, utc] of [['overhead', epochs.high], ['oblique', epochs.high], ['low Sun', epochs.low]]) {
    const et = await page.evaluate(utc => {
      window.cosmo.setTime({ kind: 'calendar', text: utc });
      return window.cosmo.getTime();
    }, utc);
    const link = new URL(base);
    link.searchParams.set('catalog', catalog);
    link.searchParams.set('view', JSON.stringify({
      version: 1, catalog: { catalog }, time: { kind: 'fixed', source: 'ET', et },
      view: { kind: 'named', name: 'Apollo 17 ' + name, fov: 45 },
      navigation: { selected: 'Moon', tracked: null, lookAt: null, mode: 'free-orbit' },
      playback: { playing: false, rate: 1 }, display: { labels: false, trajectories: false },
    }));
    links[name] = link.href;
  }
  for (const [name, expectedSun, expectedRange] of [
    ['overhead', 68, 1.72], ['oblique', 68, Math.hypot(1.10, 0.95)], ['low Sun', 11, 1.72],
  ]) {
    const reference = new URL(links[name]);
    reference.searchParams.set('test', '1');
    await page.goto(reference.href, { waitUntil: 'domcontentloaded' });
    await ready();
    await settle();
    assert.equal(await page.evaluate(site => Math.round(window.renderer.solarGeometryAt('Moon', ...site).elevationDeg), site), expectedSun);
    const restored = await page.evaluate(() => window.cosmo.getCamera());
    const restoredRangeKm = Math.hypot(...restored.position.map((x, i) => x - restored.target[i]));
    assert.ok(Math.abs(restoredRangeKm - expectedRange) < 0.10, `Shared ${name} range ${restoredRangeKm} km`);
    console.log('Restored', name);
  }

  // The optional NAC manifest may fail without blanking the WAC base. Turning
  // the same layer off and on should recover using the normal UI path.
  const manifest = '**/moon-imagery-cube-apollo17-original/imagery.json';
  let missingManifest = 0;
  await page.route(manifest, route => {
    missingManifest++;
    return route.fulfill({ status: 404 });
  }, { times: 1 });
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await ready();
  await pose(epochs.high);
  await settle(null);
  assert.equal(missingManifest, 1);
  await page.waitForFunction(() =>
    window.renderer.getBodyMesh('Moon').imageryLayers.some(l => l.id === 'apollo17-original' && l.status === 'failed'), null, { timeout: 30_000 });
  const failedLayer = await showImagery();
  await failedLayer.uncheck();
  await failedLayer.check();
  await settle();
  console.log('Recovered the optional NAC manifest through Surface layers');
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'results.json'), JSON.stringify({ heights, normalized, changingSun, shadowToggle, poseDnDifferences, frames, links }, null, 2));
} finally {
  await browser.close();
}
