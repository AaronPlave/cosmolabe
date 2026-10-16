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
      geographicCoordinates: {
        latitude: 'planetographic', longitudeDirection: 'east', longitudeDomain: '-180..180',
        referenceShape: { kind: 'sphere', radiusKm: 1737.4 },
      },
      items: [{ name: 'Moon', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, geometry: { type: 'Globe', radius: 1737.4 } }],
      geographicLayers: [{ id: 'sites', name: 'Sites', body: 'Moon', source: 'sites.geojson' }],
    };
    const canvas = document.querySelector('canvas');
    await handleFileList(canvas, [new File([JSON.stringify(json)], 'scene.json'), new File([text], 'sites.geojson')]);
    const old = getUniverse();
    const layer = old.geographicLayers.get('sites');
    const result = { layers: old.geographicLayers.layers.length, features: layer.features.length, ownership: layer.ownership };
    await handleFileList(canvas, [new File([JSON.stringify({ ...json, geographicLayers: [] })], 'replacement.json')]);
    return { ...result, oldLayers: old.geographicLayers.layers.length, newLayers: getUniverse().geographicLayers.layers.length };
  }, text);
  assert.deepEqual(result, { layers: 1, features: 2, ownership: 'transient', oldLayers: 0, newLayers: 0 });
  console.log('Local GeoJSON worker import and scene replacement passed');
} finally { await browser.close(); }
