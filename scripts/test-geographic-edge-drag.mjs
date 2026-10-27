/** Dragging an edit handle quickly past the edge of the view: the real viewer
 * on streamed Mars terrain (marshub mars_v14, network). The "Aeolis Mons" area
 * is copied into annotations through the UI, then one vertex is dragged in a
 * few large jumps out over the left-hand toolbar and released there.
 *
 * Handles are rebuilt as the preview changes, and one that passes over
 * another (one handle per screen cell) or out of view left the DOM with its
 * pointer capture, so the drag never ended: the preview stayed stuck and the
 * release reached the scene. The drag here crosses a neighbouring vertex on
 * its way out, as a quick drag across a shape does. Now the drag
 * must end on release, with no preview left, the shape still being edited,
 * and the vertex where it was let go (held to the edge of the view).
 *
 * Env: CL_VIEWER_URL (default http://127.0.0.1:5188/), CL_CHROMIUM,
 * CL_GPU=hardware (Chrome with Metal). */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5188/';
const hardware = process.env.CL_GPU === 'hardware';
const browser = await chromium.launch({
  executablePath: process.env.CL_CHROMIUM ?? (hardware ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium'),
  args: hardware ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  page.setDefaultTimeout(180_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?test=1&catalog=test-catalogs/geographic-vectors-mars-streamed`);
  await page.waitForFunction(() => window.renderer?.geographicVectors.featureCount > 0);
  await page.evaluate(() => window.renderer.applyNamedViewpoint('Gale regional'));
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: 'Surface layers', exact: true }).click();
  await page.waitForTimeout(500);
  const open = page.getByRole('button', { name: 'Open Gale regions' });
  if (await open.count()) await open.click();
  await page.getByRole('option', { name: 'Aeolis Mons Area', exact: true }).click();
  await page.getByRole('button', { name: 'Edit a copy', exact: true }).click();
  const toolbar = page.getByRole('toolbar', { name: 'Editing shape' });
  await toolbar.waitFor();
  await page.locator('[aria-label="Minimize"], button[title^="Minimize"]').first().click().catch(() => {});
  await page.waitForTimeout(3000);

  // The leftmost vertex handle on screen, and the vertex handle nearest it.
  const [handle, neighbour] = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.edit-overlay .handle.vertex')].map((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, label: el.getAttribute('aria-label') };
    }).filter((h) => h.x > 80 && h.x < innerWidth - 20 && h.y > 20 && h.y < innerHeight - 80);
    const first = all.reduce((a, b) => (b.x < a.x ? b : a));
    const d = (h) => Math.hypot(h.x - first.x, h.y - first.y);
    return [first, all.filter((h) => h !== first).reduce((a, b) => (d(b) < d(a) ? b : a))];
  });
  assert.ok(handle, 'a vertex handle is on screen');
  const canvasLeft = await page.evaluate(() => window.renderer.renderer.domElement.getBoundingClientRect().left);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  // Quickly: onto the neighbouring vertex, then out past the edge (off the window, as a fast drag goes).
  for (const [x, y] of [[neighbour.x, neighbour.y], [canvasLeft + 30, handle.y], [canvasLeft - 120, handle.y]]) await page.mouse.move(x, y, { steps: 1 });
  const during = await page.locator('.edit-overlay .preview').count();
  await page.mouse.up();
  await page.waitForTimeout(800);
  // Then wander, as the pointer does after a release.
  await page.mouse.move(handle.x + 150, handle.y + 120, { steps: 5 });
  await page.waitForTimeout(500);
  const after = await page.evaluate((label) => {
    const el = [...document.querySelectorAll('.edit-overlay .handle.vertex')].find((e) => e.getAttribute('aria-label') === label);
    const b = el?.getBoundingClientRect();
    return { previews: document.querySelectorAll('.edit-overlay .preview').length, vertexX: b ? b.left + b.width / 2 : null };
  }, handle.label);
  const editing = await toolbar.isVisible();
  console.log(JSON.stringify({ handle, neighbour, canvasLeft, during, ...after, editing, errors }));
  assert.ok(during > 0, 'the drag previewed the change');
  assert.equal(after.previews, 0, 'the drag ended on release: no preview left behind');
  assert.ok(editing, 'the shape is still being edited');
  assert.ok(after.vertexX !== null && after.vertexX >= canvasLeft - 1 && after.vertexX < canvasLeft + 60, `the vertex went where it was let go, held to the edge (x ${after.vertexX})`);
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
