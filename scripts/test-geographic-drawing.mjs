/** Surface drawing and editing smoke (#200): the real viewer and UI on Mars and
 * the Moon, driven with pointer and keyboard input through the flow of
 * docs/design/surface-layers-ux.md. Draws a polygon from browsing and counts
 * the actions (Draw → points → Enter → name → drag a point → Done), with the
 * shape going into "My annotations · Mars"; edits a shape selected in 3D
 * straight away (drag, midpoint insert, delete a point, undo/redo); draws a
 * point, path, circle and ellipse from the floating bar; is refused a
 * self-crossing polygon; edits typed properties; reloads; exports and imports
 * GeoJSON (exported and plain); copies one read-only feature into
 * annotations; edits a large multipart feature with bounded handles; styles
 * the annotations layer and checks the style returns after
 * a reload and a trip to another catalog; draws on the Moon in its own convention; and checks that the
 * tool releases the scene and does not disturb navigation. */
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
    await page.getByRole('button', { name: 'Surface layers', exact: true }).waitFor();
    await page.waitForFunction(() => window.renderer?.geographicVectors.featureCount > 0);
  };
  const panelOpen = () => page.locator('[aria-label="Mars surface layers"], .layer-view, [aria-label="Selected feature"], .layer-form').count();
  const openPanel = async () => { if (!(await panelOpen())) await page.getByRole('button', { name: 'Surface layers', exact: true }).click(); };
  const showLayers = async () => {
    await openPanel();
    while (!(await page.locator('[aria-label="Mars surface layers"]').count())) {
      await page.locator('nav button').first().click();
      await page.waitForTimeout(100);
    }
  };
  /** Open a read-only feature from its layer and fly over it, landing back on the layer. */
  const flyOver = async (layerName, featureName) => {
    await showLayers();
    await page.getByRole('button', { name: `Open ${layerName}` }).click();
    await page.getByRole('option', { name: featureName, exact: true }).click();
    await page.getByRole('button', { name: 'Fly to', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: layerName, exact: true }).click();
  };
  /** Canvas position of lon/lat in a layer's declared convention. */
  const screen = (layerId, lon, lat) => page.evaluate(({ layerId, lon, lat }) => {
    const layer = window.renderer.universe.geographicLayers.get(layerId);
    const p = window.__normalize([lon, lat], layer.coordinates);
    const [s] = window.renderer.projectGeographicPositions(layer.body, [p], layer.datum, { sampleTerrain: true });
    return s;
  }, { layerId, lon, lat });
  const exposeHelpers = () => page.evaluate(async (root) => {
    const core = await import('/@fs' + root + '/packages/core/src/index.ts');
    window.__normalize = core.normalizeGeographicPosition;
  }, process.cwd());
  /** Click lon/lat; when the layer does not exist yet, through the reference layer's convention. */
  const clickAt = async (layerId, lon, lat) => {
    const s = await screen(layerId, lon, lat);
    assert.ok(s.facing && s.inFront, `(${lon}, ${lat}) is on the visible side`);
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, s), 'CANVAS', `(${lon}, ${lat}) at ${s.x.toFixed(0)},${s.y.toFixed(0)} is not under a panel or off screen`);
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(400);
    return s;
  };
  const bar = page.getByRole('toolbar', { name: 'Drawing' });
  const editBar = page.getByRole('toolbar', { name: 'Editing shape' });
  const tool = (name) => bar.getByRole('button', { name, exact: true }).click();
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('cosmolabe-geographic-edits') ?? '{"layers":[]}').layers);
  const edit = async (id) => (await stored()).find(l => l.id === id);
  const drawn = (id) => page.evaluate((id) => window.renderer.universe.geographicLayers.get(id)?.features.length ?? 0, id);
  const selected = () => page.evaluate(() => window.renderer.geographicVectors.selectedFeature);
  const pointerTool = () => page.evaluate(() => !!window.renderer.pointerTool);
  const counted = {};
  let scenario = null;
  const act = async (fn) => { counted[scenario] = (counted[scenario] ?? 0) + 1; await fn(); };
  // Jezero's catalog layer is the reference for clicks until the annotations layer exists.
  const REF = 'jezero-science';

  await load();
  await exposeHelpers();
  await flyOver('Jezero synthetic science', 'region Area');

  // Scenario 3: browse → draw a polygon → name it → move a point → done, in one panel.
  scenario = 'drawNameEdit';
  const viewBefore = await page.evaluate(() => window.renderer.camera.position.toArray());
  await act(() => page.getByRole('button', { name: 'Draw', exact: true }).click());
  await bar.waitFor();
  const marsId = await page.evaluate(() => [...window.renderer.universe.geographicLayers.layers].find(l => l.name === 'My annotations · Mars')?.id);
  assert.ok(marsId, 'drawing made My annotations · Mars');
  results.marsConvention = await page.evaluate((id) => window.renderer.universe.geographicLayers.get(id).coordinates, marsId);
  assert.equal(results.marsConvention.longitudeDomain, '0..360', 'it takes the convention of the body’s catalog layer');
  for (const [lon, lat] of [[77.42, 18.42], [77.46, 18.42], [77.46, 18.46], [77.42, 18.46]]) await act(() => clickAt(REF, lon, lat));
  await page.screenshot({ path: `${output}/path-preview.png` });
  await act(() => page.keyboard.press('Enter'));
  await page.waitForTimeout(400);
  assert.equal(await drawn(marsId), 1);
  assert.equal(await pointerTool(), false, 'finishing ends the tool');
  const polygonId = (await edit(marsId)).features[0].id;
  assert.deepEqual(await selected(), { layerId: marsId, featureId: `string:${polygonId}`, bodyName: 'Mars' }, 'the new shape is selected');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Name', 'the name waits for typing');
  await act(async () => { await page.keyboard.type('Delta sample area'); await page.keyboard.press('Enter'); });
  await page.waitForTimeout(300);
  assert.equal((await edit(marsId)).features[0].properties.name, 'Delta sample area');
  assert.equal(await page.locator('.edit-overlay .handle.vertex').count(), 4, 'its handles show without another mode');
  await page.screenshot({ path: `${output}/edit-handles.png` });
  const v0 = await page.locator('.edit-overlay .handle.vertex').first().boundingBox();
  await act(async () => {
    await page.mouse.move(v0.x + v0.width / 2, v0.y + v0.height / 2);
    await page.mouse.down();
    await page.mouse.move(v0.x + v0.width / 2 - 30, v0.y + v0.height / 2 + 20, { steps: 6 });
    await page.mouse.up();
  });
  await page.waitForTimeout(400);
  const moved = (await edit(marsId)).features[0].geometry.coordinates[0];
  results.movedVertex = moved[0];
  assert.ok(Math.abs(moved[0][0] - 77.42) > 1e-6 || Math.abs(moved[0][1] - 18.42) > 1e-6, 'the point moved');
  assert.deepEqual(moved.at(-1), moved[0], 'ring stays closed');
  await act(() => editBar.getByRole('button', { name: 'Done' }).click());
  assert.equal(await selected(), null);
  assert.equal(await page.locator('.edit-overlay .handle.vertex').count(), 0);
  results.actions = { drawNameEdit: counted.drawNameEdit, vertices: 4 };
  assert.equal(counted.drawNameEdit - 4, 5, `draw, finish, name, drag and done take 5 actions besides the points (${counted.drawNameEdit})`);
  void viewBefore;

  // Selecting your own shape in 3D shows its handles straight away.
  scenario = 'select3dEdit';
  // Inside the polygon, clear of Jezero's traverse, which crosses it diagonally.
  const centre = await screen(marsId, 77.455, 18.428);
  await act(() => page.mouse.click(centre.x, centre.y));
  await page.waitForTimeout(400);
  assert.equal((await selected())?.layerId, marsId);
  assert.equal(await page.locator('.edit-overlay .handle.vertex').count(), 4);
  // Drag a midpoint to insert a point.
  const mid = await page.locator('.edit-overlay .handle.mid').first().boundingBox();
  await page.mouse.move(mid.x + mid.width / 2, mid.y + mid.height / 2);
  await page.mouse.down();
  await page.mouse.move(mid.x + mid.width / 2, mid.y + mid.height / 2 + 25, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const ring = async () => (await edit(marsId)).features[0].geometry.coordinates[0].length;
  assert.equal(await ring(), 6, 'midpoint insert');
  // Choose a point, then Delete removes it; undo and redo.
  const v1 = await page.locator('.edit-overlay .handle.vertex').nth(1).boundingBox();
  await page.mouse.click(v1.x + v1.width / 2, v1.y + v1.height / 2);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  assert.equal(await ring(), 5);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  assert.equal(await ring(), 6);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(300);
  assert.equal(await ring(), 5);

  // Typed properties in the Feature view keep their JSON types.
  const props = page.getByRole('group', { name: 'Edit feature' });
  const addProperty = async (name, type, set) => {
    await props.getByRole('button', { name: 'Property', exact: true }).click();
    const row = props.locator('.pair').last();
    await row.getByLabel('Property name').fill(name);
    await row.getByLabel(`Type of ${name}`).selectOption(type);
    if (set) await set(row);
  };
  await addProperty('sampled', 'boolean', row => row.getByLabel('Value of sampled').check());
  await addProperty('depth', 'null');
  await addProperty('tags', 'json', row => row.getByLabel('Value of tags').fill('["delta", 2, {"ok": true}]'));
  await addProperty('sol', 'number', row => row.getByLabel('Value of sol').fill('412'));
  await props.getByLabel('Value of tags').fill('["delta",');
  assert.equal(await props.getByRole('button', { name: 'Save' }).count(), 0, 'broken JSON cannot be saved');
  await props.getByLabel('Value of tags').fill('["delta", 2, {"ok": true}]');
  await props.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(300);
  const typed = (await edit(marsId)).features[0].properties;
  results.typedAttributes = typed;
  assert.deepEqual({ name: typed.name, sampled: typed.sampled, depth: typed.depth, tags: typed.tags, sol: typed.sol },
    { name: 'Delta sample area', sampled: true, depth: null, tags: ['delta', 2, { ok: true }], sol: 412 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  results.actions.select3dEdit = counted.select3dEdit;

  // The other tools, from the floating bar, into the same layer.
  await showLayers();
  // A point: what you click is what is drawn and picked.
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await tool('Point');
  const clicked = await clickAt(REF, 77.43, 18.435);
  assert.equal(await drawn(marsId), 2, 'into the same annotations layer');
  await page.waitForFunction(({ x, y, id }) => window.renderer.pickScene(x, y, 'select')?.layerId === id, { x: clicked.x, y: clicked.y, id: marsId }, { timeout: 15000 }).catch(() => {});
  results.pickedAtClick = await page.evaluate(({ x, y }) => window.renderer.pickScene(x, y, 'select'), clicked);
  assert.equal(results.pickedAtClick?.layerId, marsId);
  await page.keyboard.press('Escape');
  await showLayers();

  // A path; a camera drag while drawing navigates and adds no point.
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await tool('Path');
  for (const [lon, lat] of [[77.41, 18.41], [77.44, 18.46], [77.47, 18.42]]) await clickAt(REF, lon, lat);
  const pose = await page.evaluate(() => window.renderer.camera.position.toArray());
  await page.mouse.move(900, 600); await page.mouse.down(); await page.mouse.move(960, 640, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(300);
  assert.notDeepEqual(await page.evaluate(() => window.renderer.camera.position.toArray()), pose, 'a drag still navigates');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  assert.equal(await drawn(marsId), 3);
  assert.equal((await edit(marsId)).features[2].geometry.coordinates.length, 3, 'drag added no point');
  // Back over Jezero: Fly to on the new path.
  await page.getByRole('button', { name: 'Fly to', exact: true }).click();
  await page.waitForTimeout(2500);
  await page.keyboard.press('Escape');
  await flyOver('Jezero synthetic science', 'region Area');

  // A self-crossing polygon is refused with the reason, and nothing is added.
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await tool('Polygon');
  for (const [lon, lat] of [[77.42, 18.42], [77.46, 18.46], [77.46, 18.42], [77.42, 18.46]]) await clickAt(REF, lon, lat);
  await page.keyboard.press('Enter');
  results.refusal = await bar.locator('.hint').innerText();
  assert.match(results.refusal, /intersect/);
  assert.equal(await drawn(marsId), 3);
  // Escape clears the draft, a second Escape stops drawing and gives clicks back.
  await page.keyboard.press('Escape');
  assert.equal(await pointerTool(), true);
  await page.keyboard.press('Escape');
  assert.equal(await pointerTool(), false, 'Escape releases the scene');

  // Circle and ellipse keep their parameters.
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await tool('Circle');
  await clickAt(REF, 77.47, 18.44);
  await clickAt(REF, 77.48, 18.44);
  await page.keyboard.press('Escape');
  await showLayers();
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await tool('Ellipse');
  await clickAt(REF, 77.44, 18.47);
  await clickAt(REF, 77.47, 18.475);
  await clickAt(REF, 77.44, 18.477);
  const shapes = (await edit(marsId)).features.slice(3).map(f => f.shape);
  results.shapes = shapes;
  assert.equal(shapes[0].kind, 'circle');
  assert.equal(shapes[1].kind, 'ellipse');
  assert.ok(shapes[1].semiMinorKm < shapes[1].semiMajorKm);
  await page.keyboard.press('Escape');

  // Reload: everything is still there, exactly.
  const before = await edit(marsId);
  await load();
  await exposeHelpers();
  assert.equal(await drawn(marsId), before.features.length);
  assert.deepEqual(await edit(marsId), before);

  // Export from the layer's menu, then import it back: identical coordinates and conventions.
  await showLayers();
  await page.getByRole('button', { name: 'More for My annotations · Mars' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export GeoJSON' }).click()]);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  results.exportMeta = exported['cosmolabe:geographic'];
  assert.equal(exported['cosmolabe:geographic'].body, 'Mars');
  assert.deepEqual(exported['cosmolabe:geographic'].coordinates, before.coordinates);
  assert.deepEqual(exported.features.map(f => f.geometry), before.features.map(f => f.geometry));
  await showLayers();
  await page.locator('input[type=file]').setInputFiles({ name: 'notes.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(exported)) });
  await page.waitForTimeout(500);
  const imported = (await stored()).at(-1);
  assert.notEqual(imported.id, before.id);
  assert.deepEqual(imported.features, before.features);

  // Plain GeoJSON: Import asks for its body and convention, and reads it in the chosen one.
  await showLayers();
  const plain = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'c1', properties: { name: 'West crater', rim: true }, geometry: { type: 'Point', coordinates: [282.55, 18.45] } }] };
  await page.locator('input[type=file]').setInputFiles({ name: 'craters.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(plain)) });
  const importForm = page.getByRole('region', { name: 'Import GeoJSON' }).or(page.locator('[aria-label="Import GeoJSON"]'));
  await importForm.waitFor();
  await importForm.getByRole('radio', { name: 'west' }).click();
  await importForm.getByRole('radio', { name: '0..360' }).click();
  await importForm.getByRole('button', { name: 'Import' }).click();
  await page.waitForTimeout(500);
  const craters = (await stored()).find(l => l.name === 'craters');
  results.plainImport = { body: craters.body, coordinates: craters.coordinates, feature: craters.features[0] };
  assert.equal(craters.body, 'Mars');
  assert.equal(craters.coordinates.longitudeDirection, 'west');
  assert.deepEqual(craters.features[0].geometry.coordinates, [282.55, 18.45], 'coordinates kept as written');
  const craterLon = await page.evaluate((id) => window.renderer.universe.geographicLayers.get(id).features[0].geometry.coordinates.lonDeg, craters.id);
  assert.ok(Math.abs(craterLon - 77.45) < 1e-9, `282.55°W is 77.45°E: ${craterLon}`);

  // One read-only feature copied into annotations; the original layer stays as it is, and visible.
  const original = await page.evaluate(() => JSON.stringify(window.renderer.universe.geographicLayers.get('jezero-science').features));
  await showLayers();
  await page.getByRole('button', { name: 'Open Jezero synthetic science' }).click();
  await page.getByRole('option', { name: 'region Area', exact: true }).click();
  await page.getByRole('button', { name: 'Edit a copy of this feature' }).click();
  await page.waitForTimeout(400);
  const copied = await selected();
  results.featureCopy = copied;
  assert.equal(copied?.layerId, marsId, 'the copy goes into My annotations · Mars and is selected');
  assert.equal(await page.locator('.edit-overlay .handle.vertex').count() > 0, true, 'the copy is editable at once');
  assert.equal(await page.evaluate(() => window.renderer.geographicVectors.isVisible('jezero-science')), true);
  assert.equal(await page.evaluate(() => JSON.stringify(window.renderer.universe.geographicLayers.get('jezero-science').features)), original);
  await page.keyboard.press('Escape');

  // A large multipart feature with holes (20 parts × (160 + 60) = 4,400 points): only the move
  // handle until points are asked for; then thinned and capped handles; an edit keeps every ring.
  const circle = (lon, lat, r, n) => { const c = Array.from({ length: n }, (_, i) => [lon + r * Math.cos(2 * Math.PI * i / n), lat + r * Math.sin(2 * Math.PI * i / n)]); return [...c, c[0]]; };
  const parts = Array.from({ length: 20 }, (_, i) => { const lon = 77.405 + (i % 5) * 0.017, lat = 18.405 + Math.floor(i / 5) * 0.017; return [circle(lon, lat, 0.006, 160), circle(lon, lat, 0.002, 60).reverse()]; });
  const bigText = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'big', properties: { name: 'Big multipart' }, geometry: { type: 'MultiPolygon', coordinates: parts } }] });
  await showLayers();
  await page.locator('input[type=file]').setInputFiles({ name: 'Big shapes.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(bigText) });
  await importForm.waitFor();
  await importForm.getByRole('radio', { name: 'east' }).click();
  await importForm.getByRole('radio', { name: '0..360' }).click();
  await importForm.getByRole('button', { name: 'Import' }).click();
  await page.waitForTimeout(500);
  const bigId = (await stored()).find(l => l.name === 'Big shapes')?.id;
  assert.ok(bigId, 'the large feature imports');
  await showLayers();
  await page.getByRole('button', { name: 'Open Big shapes' }).click();
  await page.getByRole('option', { name: 'Big multipart Areas', exact: true }).click();
  await editBar.waitFor();
  await page.waitForTimeout(500);
  const handleCount = () => page.locator('.edit-overlay .handle').count();
  const big = { before: await handleCount(), note: await editBar.locator('.hint').last().innerText() };
  assert.equal(big.before, 1, 'only the move handle before points are asked for');
  assert.match(big.note, /4,400 points/);
  await editBar.getByRole('button', { name: 'Show points' }).click();
  await page.waitForTimeout(500);
  big.shown = await handleCount();
  big.hint = await editBar.locator('.hint').last().innerText();
  await page.screenshot({ path: `${output}/large-feature.png` });
  assert.ok(big.shown > 1 && big.shown <= 400, `bounded handles (${big.shown})`);
  assert.match(big.hint, /Zoom in to edit [\d,]+ more points/);
  // Frame rate with the handles up (software rendering here: a relative number, not a hardware one).
  big.framesPerSecond = await page.evaluate(() => new Promise((done) => { let n = 0; const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else done(+(n / ((performance.now() - t0) / 1000)).toFixed(1)); }; requestAnimationFrame(tick); }));
  // Loose floor: per-frame overlay work once cost seconds here (heights sampled for every vertex).
  assert.ok(big.framesPerSecond > 2, `the scene keeps moving with points shown (${big.framesPerSecond} fps)`);
  // Drag one vertex: every part and hole is still there, with the same number of points.
  const ringsOf = async () => (await edit(bigId)).features[0].geometry.coordinates.map((poly) => poly.map((ring) => ring.length));
  const ringsBefore = await ringsOf();
  const handle = page.locator('.edit-overlay .handle.vertex').first();
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 6, box.y + box.height / 2 + 4, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  assert.deepEqual(await ringsOf(), ringsBefore, 'parts, holes and point counts unchanged by a move');
  assert.notDeepEqual((await edit(bigId)).features[0].geometry.coordinates, parts, 'the point moved');
  big.edited = true;
  results.largeFeature = big;
  await editBar.getByRole('button', { name: 'Done' }).click();

  // A drawn layer's style comes back after a reload and after a trip to another catalog.
  await showLayers();
  // The import above made a second layer of the same name; the original is listed first.
  await page.getByRole('button', { name: 'Open My annotations · Mars' }).first().click();
  await page.getByRole('radio', { name: 'style' }).click();
  const annotationStyle = page.locator('[aria-label="Style of My annotations · Mars"]');
  await annotationStyle.getByRole('button', { name: 'Orange' }).click();
  await annotationStyle.getByLabel('Opacity').fill('0.6');
  await annotationStyle.getByLabel('Labels', { exact: true }).check();
  await page.waitForTimeout(400);
  // Stored styles drop empty members (rule: null), so compare without them.
  const drawnStyle = () => page.evaluate((id) => JSON.parse(JSON.stringify(window.renderer.geographicVectors.getStyle(id), (k, v) => v ?? undefined)), marsId);
  const styledDrawn = await drawnStyle();
  results.drawnLayerStyle = styledDrawn;
  assert.equal(styledDrawn?.point?.color, '#e69f00');
  assert.equal(styledDrawn?.opacity, 0.6);
  assert.ok(styledDrawn?.labels, 'labels on');
  await load();
  assert.deepEqual(await drawnStyle(), styledDrawn, 'restored after a reload');
  await page.goto(`${base}?catalog=test-catalogs/mars-imagery-jezero`);
  await page.waitForFunction((id) => !!window.renderer?.universe.geographicLayers.get(id), marsId);
  assert.deepEqual(await drawnStyle(), styledDrawn, 'restored in another catalog on the same body');
  await page.evaluate(() => window.renderer.waitForInitialAssets());
  await load();
  await exposeHelpers();
  assert.deepEqual(await drawnStyle(), styledDrawn, 'restored on returning to the first catalog');

  // The Moon, in its own convention, into its own annotations layer.
  await flyOver('Lunar synthetic regions', (await page.evaluate(() => window.renderer.universe.geographicLayers.get('moon-science').features[0].properties?.name ?? '')) + ' ' + (await page.evaluate(() => ({ Point: 'Point', MultiPoint: 'Points', LineString: 'Line', MultiLineString: 'Lines', Polygon: 'Area', MultiPolygon: 'Areas' })[window.renderer.universe.geographicLayers.get('moon-science').features[0].geometry.type])));
  const moonFeature = await page.evaluate(() => window.renderer.universe.geographicLayers.get('moon-science').features[0].original.geometry.coordinates);
  const moonPoint = Array.isArray(moonFeature[0]) ? (Array.isArray(moonFeature[0][0]) ? moonFeature[0][0] : moonFeature[0]) : moonFeature;
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await tool('Point');
  await clickAt('moon-science', moonPoint[0], moonPoint[1]);
  const moon = (await stored()).find(l => l.name === 'My annotations · Moon');
  results.moon = { convention: moon.coordinates, point: moon.features[0].geometry.coordinates };
  assert.equal(moon.body, 'Moon');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${output}/moon.png` });

  // Phone layout while drawing: the bar stays clear of the sheet and timeline.
  await showLayers();
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${output}/compact.png` });
  // The bar sits clear of the open sheet and the bottom dock, and still leaves scene to draw on.
  const sheet = await page.locator('[aria-label="Mars surface layers"]').boundingBox();
  const dock = await page.locator('.compact-dock').boundingBox();
  const barBox = await bar.boundingBox();
  results.compact = { sheet, dock, bar: barBox };
  assert.ok(sheet && dock && barBox, 'sheet, dock and bar all show');
  assert.ok(barBox.y + barBox.height <= sheet.y, 'the bar is above the sheet');
  assert.ok(barBox.y + barBox.height <= dock.y, 'the bar is above the dock');
  assert.ok(barBox.y > 200, 'scene remains above the bar');
  // Closing the layers sheet: the bar stays clear of whatever the sheet shows now, or drops to the dock.
  await page.locator('.compact-dock').getByRole('button', { name: 'Surface layers' }).click();
  await page.waitForTimeout(400);
  const after = { sheet: await page.locator('[data-sheet]').boundingBox(), bar: await bar.boundingBox() };
  results.compact.afterClosing = after;
  if (after.sheet && after.sheet.height > 0) assert.ok(after.bar.y + after.bar.height <= after.sheet.y, 'above the sheet now showing');
  else assert.ok(after.bar.y > barBox.y, 'with no sheet, the bar drops toward the dock');
  assert.ok(after.bar.y + after.bar.height <= dock.y, 'and stays above the dock');
  await page.keyboard.press('Escape');

  results.errors = errors;
  await writeFile(`${output}/drawing.json`, JSON.stringify(results, null, 2) + '\n');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  await page?.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  throw error;
} finally { await browser.close(); }
