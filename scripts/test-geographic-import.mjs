/** Real worker + local file-handler smoke test. Start the viewer dev server first.
 * CL_VIEWER_URL selects the server; CL_CHROMIUM optionally selects an installed browser. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const text = readFileSync(new URL('../packages/core/src/__tests__/__fixtures__/geographic-southpole.json', import.meta.url), 'utf8');
const browser = await chromium.launch({
  executablePath: process.env.CL_CHROMIUM,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  const url = new URL(process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173/');
  url.searchParams.set('test', '1');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async text => {
    const { handleFileList, getUniverse } = await import('/src/lib/loader.ts');
    const json = {
      name: 'Local Moon science',
      require: ['../bodies/moon.json'],
      geographicCoordinates: {
        latitude: 'planetographic', longitudeDirection: 'east', longitudeDomain: '-180..180',
        referenceShape: { kind: 'sphere', radiusKm: 1737.4 },
      },
      geographicLayers: [{ id: 'sites', name: 'Sites', body: 'Moon', source: '../vectors/sites.geojson' }],
    };
    const body = { items: [{ name: 'Moon', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, geometry: { type: 'Globe', radius: 1737.4 } }] };
    const localFile = (text, path) => {
      const file = new File([text], path.split('/').at(-1));
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
      return file;
    };
    const bodyFile = () => localFile(JSON.stringify(body), 'bundle/bodies/moon.json');
    const canvas = document.querySelector('canvas');
    await handleFileList(canvas, [localFile(JSON.stringify(json), 'bundle/mission/scene.json'), bodyFile(), localFile(text, 'bundle/vectors/sites.geojson')]);
    const old = getUniverse();
    const layer = old.geographicLayers.get('sites');
    const result = { layers: old.geographicLayers.layers.length, features: layer.features.length, ownership: layer.ownership,
      requiredBody: Boolean(old.getBody('Moon')) };
    await handleFileList(canvas, [localFile(JSON.stringify({ ...json, geographicLayers: [] }), 'bundle/mission/replacement.json'), bodyFile()]);
    Object.assign(result, { oldLayers: old.geographicLayers.layers.length, newLayers: getUniverse().geographicLayers.layers.length });

    const scene = { ...json, geographicLayers: [{ ...json.geographicLayers[0], source: 'sites.geojson' }] };
    await handleFileList(canvas, [localFile(JSON.stringify(scene), 'bundle/mission/scene.json'), bodyFile(),
      localFile(text, 'bundle/a/sites.geojson'), localFile(text, 'bundle/b/sites.geojson')]);
    result.duplicateRejected = getUniverse().geographicLayers.loads[0].status === 'error'
      && getUniverse().geographicLayers.loads[0].diagnostics[0].message.includes('ambiguous');
    const before = getUniverse();
    try { await handleFileList(canvas, [localFile(JSON.stringify(json), 'bundle/mission/scene.json')]); }
    catch (error) { result.missingDiagnosed = error.message.includes('moon.json') && error.message.includes('missing'); }
    result.oldScenePreserved = getUniverse() === before;

    await handleFileList(canvas, [new File([JSON.stringify({ name: 'Large catalog', ...body,
      metadata: 'x'.repeat(2 * 1024 * 1024 + 1) })], 'large.json')]);
    result.largeCatalogLoaded = Boolean(getUniverse().getBody('Moon'));
    return result;
  }, text);
  assert.deepEqual(result, { layers: 1, features: 2, ownership: 'transient', requiredBody: true,
    oldLayers: 0, newLayers: 0, duplicateRejected: true, missingDiagnosed: true, oldScenePreserved: true, largeCatalogLoaded: true });
  console.log('Local relative require, duplicate files, missing dependency, large catalog and scene replacement passed');

  // Hold B's catalog response while A is cancelled. A must not close B's progress
  // or reset it to "Preparing scene" when its own catalog response arrives late.
  for (const phase of ['geographic', 'catalog']) {
    const oldUrl = new URL(`review-${phase}-old.json`, url).href;
    const newUrl = new URL(`review-${phase}-new.json`, url).href;
    const geoUrl = new URL(`review-${phase}-unavailable.geojson`, url).href;
    const body = { items: [{ name: 'Moon', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, geometry: { type: 'Globe', radius: 1737.4 } }] };
    const oldCatalog = { ...body, geographicCoordinates: { latitude: 'planetographic', longitudeDirection: 'east',
      longitudeDomain: '-180..180', referenceShape: { kind: 'sphere', radiusKm: 1737.4 } },
    geographicLayers: [{ id: 'waiting', name: 'Waiting', body: 'Moon', source: geoUrl }] };
    let oldRoute, newRoute;
    let oldWaiting, newWaiting;
    const oldRequested = new Promise(resolve => { oldWaiting = resolve; });
    const newRequested = new Promise(resolve => { newWaiting = resolve; });
    await page.route(oldUrl, route => {
      if (phase === 'catalog') { oldRoute = route; oldWaiting(); }
      else return route.fulfill({ json: oldCatalog });
    });
    await page.route(geoUrl, () => { oldWaiting(); });
    await page.route(newUrl, route => { newRoute = route; newWaiting(); });
    await page.evaluate(async oldUrl => {
      const { loadCatalogUrl } = await import('/src/lib/loader.ts');
      window.geoOldResult = null;
      void loadCatalogUrl(document.querySelector('canvas'), oldUrl, 'Old catalog')
        .then(() => { window.geoOldResult = 'loaded'; }, error => { window.geoOldResult = error.name; });
    }, oldUrl);
    await oldRequested;
    await page.evaluate(async newUrl => {
      const { loadCatalogUrl } = await import('/src/lib/loader.ts');
      window.geoNewResult = null;
      void loadCatalogUrl(document.querySelector('canvas'), newUrl, 'New catalog')
        .then(() => { window.geoNewResult = 'loaded'; }, error => { window.geoNewResult = error.message; });
    }, newUrl);
    await newRequested;
    if (oldRoute) await oldRoute.fulfill({ json: oldCatalog });
    await page.waitForFunction(() => window.geoOldResult !== null);
    const state = await page.evaluate(async () => {
      const { vs } = await import('/src/lib/viewer-state.svelte.ts');
      return { showLoading: vs.showLoading, catalog: vs.loadingCatalog, label: vs.loadingLabel, result: window.geoOldResult };
    });
    assert.deepEqual(state, { showLoading: true, catalog: 'New catalog', label: 'Fetching catalog...', result: 'AbortError' });
    await newRoute.fulfill({ json: body });
    await page.waitForFunction(() => window.geoNewResult !== null);
    assert.equal(await page.evaluate(() => window.geoNewResult), 'loaded');
  }
  console.log('Rapid switches during geographic and catalog fetch preserve the active progress UI');
} finally { await browser.close(); }
