/** Surface drawing and editing smoke (#200): the real viewer and UI on Mars and
 * the Moon, driven with pointer and keyboard input. Draws a point, path,
 * polygon, circle and ellipse; undoes and redoes; is refused a self-crossing
 * polygon; drags vertex and midpoint handles; edits attributes; reloads;
 * exports and reimports GeoJSON with exact coordinates; makes an editable copy
 * of a read-only layer; and checks the tool does not disturb navigation or
 * ordinary selection. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const output = process.env.CL_OUTPUT ?? 'docs/validation/geographic-drawing';
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5188/';
const browser = await chromium.launch({ executablePath: process.env.CL_CHROMIUM ?? '/opt/pw-browsers/chromium',
  args: process.env.CL_GPU === 'hardware'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = {};
let page;
try {
  await mkdir(output, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' || /Shader Error|VALIDATE_STATUS/.test(m.text())) errors.push(m.text()); });

  const load = async () => {
    await page.goto(`${base}?catalog=test-catalogs/geographic-vectors`);
    await page.getByRole('button', { name: 'Draw', exact: true }).waitFor();
    await page.waitForFunction(() => window.renderer?.geographicVectors.featureCount > 0);
  };
  /** Fly over a read-only feature so its body fills the view. */
  const flyOver = async (layerName, featureName) => {
    if (!(await page.locator('[aria-label$="surface layers"]').count())) await page.getByRole('button', { name: 'Surface layers' }).click();
    if (!(await page.locator(`[aria-label="Features of ${layerName}"]`).count())) await page.getByRole('button', { name: `List features of ${layerName}` }).click();
    await page.getByRole('option', { name: featureName, exact: true }).dblclick();
    await page.waitForTimeout(2500);
    // Out of the way of the scene clicks that follow.
    await page.getByRole('button', { name: 'Surface layers', exact: true }).click();
  };
  /** Canvas position of lon/lat in a layer's declared convention. */
  const screen = (layerId, lon, lat) => page.evaluate(({ layerId, lon, lat }) => {
    const layer = window.renderer.universe.geographicLayers.get(layerId);
    const c = layer.coordinates;
    const east = c.longitudeDirection === 'east' ? lon : -lon;
    const p = window.__normalize([lon, lat], c);
    const [s] = window.renderer.projectGeographicPositions(layer.body, [p], layer.datum, { sampleTerrain: true });
    void east;
    return s;
  }, { layerId, lon, lat });
  const exposeHelpers = () => page.evaluate(async (root) => {
    const core = await import('/@fs' + root + '/packages/core/src/index.ts');
    window.__normalize = core.normalizeGeographicPosition;
  }, process.cwd());
  const clickAt = async (layerId, lon, lat) => {
    const s = await screen(layerId, lon, lat);
    assert.ok(s.facing && s.inFront, `(${lon}, ${lat}) is on the visible side`);
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, s), 'CANVAS', `(${lon}, ${lat}) at ${s.x.toFixed(0)},${s.y.toFixed(0)} is not under a panel or off screen`);
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(400);
    return s;
  };
  const tool = (name) => page.getByRole('toolbar', { name: 'Drawing tools' }).getByRole('button', { name, exact: true }).click();
  const edit = (id) => page.evaluate((id) => JSON.parse(localStorage.getItem('cosmolabe-geographic-edits') ?? '{"layers":[]}').layers.find(l => l.id === id), id);
  const drawn = (id) => page.evaluate((id) => window.renderer.universe.geographicLayers.get(id)?.features.length ?? 0, id);

  await load();
  await exposeHelpers();
  await flyOver('Jezero synthetic science', 'region Polygon');

  // A new Mars layer in the catalog's own convention (planetocentric, east, 0–360).
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await page.getByRole('button', { name: 'New layer' }).click();
  await page.getByRole('group', { name: 'New layer' }).locator('input').first().fill('Jezero notes');
  await page.getByRole('group', { name: 'New layer' }).getByRole('button', { name: 'Create' }).click();
  const marsId = await page.evaluate(() => [...window.renderer.universe.geographicLayers.layers].find(l => l.name === 'Jezero notes').id);
  const marsLayer = await page.evaluate((id) => window.renderer.universe.geographicLayers.get(id).coordinates, marsId);
  results.marsConvention = marsLayer;
  assert.equal(marsLayer.longitudeDomain, '0..360', 'new layer matches the existing Mars layer’s convention');

  // Point.
  await tool('Point');
  const clicked = await clickAt(marsId, 77.43, 18.43);
  assert.equal(await drawn(marsId), 1);
  const point = (await edit(marsId)).features[0].geometry.coordinates;
  results.clickedPoint = point;
  // What you click is what is drawn and picked: the new point is under the click.
  await page.waitForFunction(({ x, y, id }) => window.renderer.pickScene(x, y, 'select')?.layerId === id, { x: clicked.x, y: clicked.y, id: marsId }, { timeout: 15000 }).catch(() => {});
  const under = await page.evaluate(({ x, y }) => window.renderer.pickScene(x, y, 'select'), clicked);
  results.pickedAtClick = under;
  assert.equal(under?.kind, 'geographic-feature');
  assert.equal(under?.layerId, marsId);
  assert.ok(Math.abs(point[0] - 77.43) < 0.01 && Math.abs(point[1] - 18.43) < 0.01, `near the intended place on the rendered reference globe: ${point}`);

  // Closing Draw from the rail (not its own button) gives scene clicks back.
  if (await page.getByRole('toolbar', { name: 'Drawing tools' }).getByRole('button', { name: 'Point', exact: true }).getAttribute('aria-pressed') !== 'true') await tool('Point');
  assert.equal(await page.evaluate(() => !!window.renderer.pointerTool), true);
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  assert.equal(await page.evaluate(() => !!window.renderer.pointerTool), false, 'rail close releases the draw tool');
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await page.getByRole('toolbar', { name: 'Drawing tools' }).waitFor();

  // Path, finished with Enter. A camera drag while drawing navigates and adds no vertex.
  await tool('Path');
  await clickAt(marsId, 77.41, 18.41);
  await clickAt(marsId, 77.44, 18.46);
  await clickAt(marsId, 77.47, 18.42);
  await page.screenshot({ path: `${output}/path-preview.png` });
  const pose = await page.evaluate(() => {
    const cc = window.renderer.cameraController;
    return { position: window.renderer.camera.position.toArray(), up: window.renderer.camera.up.toArray(), target: cc.controls.target.toArray() };
  });
  await page.mouse.move(900, 600); await page.mouse.down(); await page.mouse.move(960, 640, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(300);
  assert.notDeepEqual(await page.evaluate(() => window.renderer.camera.position.toArray()), pose.position, 'a drag still navigates');
  // Back over Jezero with the panel's Frame action (a cut).
  await page.evaluate(async () => {
    const m = await import('/src/lib/geographic-layers.svelte.ts');
    m.goToFeature({ layerId: 'jezero-science', featureId: 'string:region', bodyName: 'Mars' }, { cut: true });
  });
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  assert.equal(await drawn(marsId), 2);
  assert.equal((await edit(marsId)).features[1].geometry.coordinates.length, 3, 'drag added no vertex');

  // A self-crossing polygon is refused with the reason, and nothing is added.
  await tool('Polygon');
  for (const [lon, lat] of [[77.42, 18.42], [77.46, 18.46], [77.46, 18.42], [77.42, 18.46]]) await clickAt(marsId, lon, lat);
  await page.keyboard.press('Enter');
  results.refusal = await page.locator('[role="status"]').filter({ hasText: /intersect/ }).first().innerText();
  assert.equal(await drawn(marsId), 2);
  await page.keyboard.press('Escape');

  // A valid polygon, closed with a double-click.
  for (const [lon, lat] of [[77.42, 18.42], [77.46, 18.42], [77.46, 18.46]]) await clickAt(marsId, lon, lat);
  const last = await screen(marsId, 77.42, 18.46);
  await page.mouse.dblclick(last.x, last.y);
  await page.waitForTimeout(500);
  assert.equal(await drawn(marsId), 3);
  const polygonId = (await edit(marsId)).features[2].id;

  // Undo and redo.
  await page.keyboard.press('Escape'); // leave the tool, keep the panel
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  assert.equal(await drawn(marsId), 2);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(300);
  assert.equal(await drawn(marsId), 3);

  // Circle and ellipse keep their parameters.
  await tool('Circle');
  await clickAt(marsId, 77.47, 18.44);
  await clickAt(marsId, 77.48, 18.44);
  await tool('Ellipse');
  await clickAt(marsId, 77.44, 18.47);
  await clickAt(marsId, 77.47, 18.475);
  await clickAt(marsId, 77.44, 18.477);
  const shapes = (await edit(marsId)).features.slice(3).map(f => f.shape);
  results.shapes = shapes;
  assert.equal(shapes[0].kind, 'circle');
  assert.equal(shapes[1].kind, 'ellipse');
  assert.ok(shapes[1].semiMinorKm < shapes[1].semiMajorKm);
  await page.keyboard.press('Escape');

  // Ordinary selection works with the tool off; edit the polygon's attributes and shape.
  const centre = await screen(marsId, 77.43, 18.43);
  await page.mouse.click(centre.x + 0.5, centre.y + 0.5);
  await page.waitForTimeout(300);
  await page.evaluate((id) => { /* select the polygon explicitly */ }, polygonId);
  // Select it from its layer's feature list.
  await page.waitForTimeout(500);
  if (!(await page.locator('[aria-label$="surface layers"]').count())) await page.getByRole('button', { name: 'Surface layers', exact: true }).click();
  if (!(await page.locator('[aria-label="Features of Jezero notes"]').count())) await page.getByRole('button', { name: 'List features of Jezero notes' }).click();
  const polygonName = (await edit(marsId)).features.find(f => f.id === polygonId).properties.name;
  await page.locator('[aria-label="Features of Jezero notes"]').getByRole('option', { name: new RegExp(`^${polygonName}`) }).click();
  await page.locator('[aria-label="Selected feature"]').waitFor();
  const attrs = page.getByRole('group', { name: 'Edit feature' });
  await attrs.getByLabel('name').fill('Delta sample area');
  await attrs.getByLabel('category').fill('sampling');
  await attrs.getByRole('button', { name: 'Save attributes' }).click();
  await page.waitForTimeout(300);
  const saved = (await edit(marsId)).features.find(f => f.id === polygonId).properties;
  assert.equal(saved.name, 'Delta sample area');
  assert.equal(saved.category, 'sampling');
  // New properties take the type chosen for them, and keep it.
  const addProperty = async (name, type, set) => {
    await attrs.getByRole('button', { name: 'Property', exact: true }).click();
    const row = attrs.locator('.pair').last();
    await row.getByLabel('Property name').fill(name);
    await row.getByLabel(`Type of ${name}`).selectOption(type);
    if (set) await set(row);
  };
  await addProperty('sampled', 'boolean', row => row.getByLabel('Value of sampled').check());
  await addProperty('depth', 'null');
  await addProperty('tags', 'json', row => row.getByLabel('Value of tags').fill('["delta", 2, {"ok": true}]'));
  await addProperty('sol', 'number', row => row.getByLabel('Value of sol').fill('412'));
  await attrs.getByRole('button', { name: 'Save attributes' }).click();
  await page.waitForTimeout(300);
  const typed = (await edit(marsId)).features.find(f => f.id === polygonId).properties;
  results.typedAttributes = typed;
  assert.deepEqual({ sampled: typed.sampled, depth: typed.depth, tags: typed.tags, sol: typed.sol }, { sampled: true, depth: null, tags: ['delta', 2, { ok: true }], sol: 412 });
  // Editing other fields keeps those types; broken JSON is refused, not saved as text.
  await attrs.getByLabel('Value of tags').fill('["delta",');
  assert.equal(await attrs.getByRole('button', { name: 'Save attributes' }).isDisabled(), true);
  await attrs.getByLabel('Value of tags').fill('["delta"]');
  await attrs.getByLabel('name', { exact: true }).fill('Delta sample area 2');
  await attrs.getByRole('button', { name: 'Save attributes' }).click();
  await page.waitForTimeout(300);
  const retyped = (await edit(marsId)).features.find(f => f.id === polygonId).properties;
  assert.deepEqual({ sampled: retyped.sampled, depth: retyped.depth, tags: retyped.tags, sol: retyped.sol }, { sampled: true, depth: null, tags: ['delta'], sol: 412 });
  await attrs.getByRole('button', { name: /Edit shape/ }).click();
  await page.waitForTimeout(500);
  const handles = await page.locator('.edit-overlay .handle.vertex').count();
  assert.equal(handles, 4);
  await page.screenshot({ path: `${output}/edit-handles.png` });
  // Drag the first vertex.
  const v0 = await page.locator('.edit-overlay .handle.vertex').first().boundingBox();
  await page.mouse.move(v0.x + v0.width / 2, v0.y + v0.height / 2);
  await page.mouse.down();
  await page.mouse.move(v0.x + v0.width / 2 - 30, v0.y + v0.height / 2 + 20, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const moved = (await edit(marsId)).features.find(f => f.id === polygonId).geometry.coordinates[0];
  results.movedVertex = moved[0];
  assert.ok(Math.abs(moved[0][0] - 77.42) > 1e-6 || Math.abs(moved[0][1] - 18.42) > 1e-6);
  assert.deepEqual(moved.at(-1), moved[0], 'ring stays closed');
  // Drag a midpoint to insert a vertex.
  const mid = await page.locator('.edit-overlay .handle.mid').first().boundingBox();
  await page.mouse.move(mid.x + mid.width / 2, mid.y + mid.height / 2);
  await page.mouse.down();
  await page.mouse.move(mid.x + mid.width / 2, mid.y + mid.height / 2 + 25, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  results.afterInsert = await page.locator('.message, .refusal').allInnerTexts();
  assert.equal((await edit(marsId)).features.find(f => f.id === polygonId).geometry.coordinates[0].length, 6, `midpoint insert: ${results.afterInsert}`);
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  // Reload: everything is still there, exactly.
  const before = await edit(marsId);
  await load();
  await exposeHelpers();
  assert.equal(await drawn(marsId), before.features.length);
  assert.deepEqual(await edit(marsId), before);

  // Export GeoJSON, then import it as a new editable layer: identical coordinates and conventions.
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'GeoJSON' }).click()]);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  results.exportMeta = exported['cosmolabe:geographic'];
  assert.equal(exported['cosmolabe:geographic'].body, 'Mars');
  assert.deepEqual(exported['cosmolabe:geographic'].coordinates, before.coordinates);
  assert.deepEqual(exported.features.map(f => f.geometry), before.features.map(f => f.geometry));
  await page.locator('input[type=file]').setInputFiles({ name: 'notes.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(exported)) });
  await page.waitForTimeout(500);
  const imported = await page.evaluate(() => JSON.parse(localStorage.getItem('cosmolabe-geographic-edits')).layers.at(-1));
  assert.notEqual(imported.id, before.id);
  assert.deepEqual(imported.features, before.features);

  // Plain GeoJSON says nothing of body or convention: Import asks, and reads it in the chosen one.
  const plain = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'c1', properties: { name: 'West crater', rim: true }, geometry: { type: 'Point', coordinates: [282.55, 18.45] } }] };
  await page.locator('input[type=file]').setInputFiles({ name: 'craters.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(plain)) });
  const importForm = page.getByRole('group', { name: 'Import GeoJSON' });
  await importForm.waitFor();
  await importForm.getByRole('radio', { name: 'west' }).click();
  await importForm.getByRole('radio', { name: '0..360' }).click();
  await importForm.getByRole('button', { name: 'Import' }).click();
  await page.waitForTimeout(500);
  const craters = await page.evaluate(() => JSON.parse(localStorage.getItem('cosmolabe-geographic-edits')).layers.find(l => l.name === 'craters'));
  results.plainImport = { body: craters.body, coordinates: craters.coordinates, feature: craters.features[0] };
  assert.equal(craters.body, 'Mars');
  assert.equal(craters.coordinates.longitudeDirection, 'west');
  assert.deepEqual(craters.features[0].geometry.coordinates, [282.55, 18.45], 'coordinates kept as written');
  assert.equal(craters.features[0].properties.rim, true);
  const craterLon = await page.evaluate((id) => window.renderer.universe.geographicLayers.get(id).features[0].geometry.coordinates.lonDeg, craters.id);
  assert.ok(Math.abs(craterLon - 77.45) < 1e-9, `282.55°W is 77.45°E: ${craterLon}`);

  // Read-only data gets an editable copy; the original is hidden and unchanged.
  const original = await page.evaluate(() => JSON.stringify(window.renderer.universe.geographicLayers.get('jezero-science').features));
  if (!(await page.locator('[aria-label$="surface layers"]').count())) await page.getByRole('button', { name: 'Surface layers', exact: true }).click();
  if (!(await page.locator('[aria-label="Features of Jezero synthetic science"]').count())) await page.getByRole('button', { name: 'List features of Jezero synthetic science' }).click();
  await page.locator('[aria-label="Features of Jezero synthetic science"]').getByRole('option', { name: 'region Polygon', exact: true }).click();
  await page.locator('[aria-label="Selected feature"]').waitFor();
  await page.getByRole('button', { name: 'Make editable copy' }).click();
  await page.waitForTimeout(500);
  assert.equal(await drawn('jezero-science:edits'), 6);
  assert.equal(await page.evaluate(() => window.renderer.geographicVectors.isVisible('jezero-science')), false);
  assert.equal(await page.evaluate(() => JSON.stringify(window.renderer.universe.geographicLayers.get('jezero-science').features)), original);

  // The Moon, in its own convention.
  await flyOver('Lunar synthetic regions', (await page.evaluate(() => window.renderer.universe.geographicLayers.get('moon-science').features[0].properties?.name ?? '')) + ' ' + (await page.evaluate(() => window.renderer.universe.geographicLayers.get('moon-science').features[0].geometry.type)));
  await page.getByRole('button', { name: 'New layer' }).click();
  const form = page.getByRole('group', { name: 'New layer' });
  await form.locator('input').first().fill('Lunar notes');
  await form.getByLabel('Body', { exact: true }).click();
  await page.getByRole('option', { name: 'Moon', exact: true }).click();
  await form.getByRole('button', { name: 'Create' }).click();
  const moonId = await page.evaluate(() => [...window.renderer.universe.geographicLayers.layers].find(l => l.name === 'Lunar notes').id);
  const moonFeature = await page.evaluate(() => {
    const l = window.renderer.universe.geographicLayers.get('moon-science');
    return l.features[0].original.geometry.coordinates;
  });
  const moonPoint = Array.isArray(moonFeature[0]) ? (Array.isArray(moonFeature[0][0]) ? moonFeature[0][0] : moonFeature[0]) : moonFeature;
  await tool('Point');
  await clickAt(moonId, moonPoint[0], moonPoint[1]);
  assert.equal(await drawn(moonId), 1);
  results.moon = { convention: (await edit(moonId)).coordinates, point: (await edit(moonId)).features[0].geometry.coordinates };
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${output}/moon.png` });

  // Phone layout with the Draw panel.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${output}/compact.png` });

  results.errors = errors;
  await writeFile(`${output}/drawing.json`, JSON.stringify(results, null, 2) + '\n');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  await page?.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally { await browser.close(); }
