/** Live ViewState integration. Start `npm --prefix apps/viewer run dev` first.
 * CL_VIEWER_URL can point at a dedicated dev server. No fixed settle sleeps. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173/';
const frozen = readFileSync(new URL('../apps/viewer/test-permalinks/earth-moon-v1.url', import.meta.url), 'utf8').trim();
const fixture = new URL(frozen, base);
const expected = JSON.parse(fixture.searchParams.get('view'));
fixture.searchParams.set('test', '1');
const browser = await chromium.launch({ headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function read(page) {
  return page.evaluate(() => ({ time: window.cosmo.getTime(), selected: window.cosmo.getSelected(),
    tracked: window.cosmo.getTracked(), origin: window.cosmo.getCameraReference(),
    camera: window.cosmo.getCamera(), playing: window.cosmo.isPlaying(), rate: window.cosmo.getRate() }));
}
async function ready(page, time = expected.time.et) {
  await page.waitForFunction(et => window.cosmo && Math.abs(window.cosmo.getTime() - et) < 1e-6 &&
    window.cosmo.getSelected() === 'Moon', time, { timeout: 60000 });
}
async function open(context, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}
async function copy(page) {
  const addressBefore = page.url();
  const historyBefore = await page.evaluate(() => history.length);
  const button = page.getByRole('button', { name: 'Copy view link', exact: true });
  await button.click();
  await page.getByRole('status').filter({ hasText: 'View link copied' }).waitFor();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(page.url(), addressBefore, 'copy must leave the browser URL untouched');
  assert.equal(await page.evaluate(() => history.length), historyBefore, 'copy must not add history entries');
  return url;
}
function cameraEqual(a, b) {
  assert.equal(a.fov, b.fov);
  for (const key of ['position', 'target', 'up']) a[key].forEach((x, i) => assert.ok(
    Math.abs(x - b[key][i]) < 1e-6 * Math.max(1, Math.abs(x)), `${key}[${i}]: ${x} vs ${b[key][i]}`));
}

try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1280, height: 900 } });
  const page = await open(context, fixture.href);
  await ready(page);
  console.log('Frozen link restored');
  const initial = await read(page);
  assert.equal(initial.tracked, 'Earth');
  assert.equal(initial.camera.fov, 42);
  assert.equal(initial.rate, 30);
  assert.equal(initial.playing, false);
  assert.ok(Math.abs(Math.hypot(...initial.camera.position) - 900000) < 1e-6, 'Lunar Orbit semantic catalog view');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page);
  cameraEqual((await read(page)).camera, initial.camera);

  // Named catalog views are recognized from the actual pose, not a dropdown.
  console.log('Reload restored');
  const named = await copy(page);
  assert.equal(JSON.parse(new URL(named).searchParams.get('view')).view.kind, 'named');

  // Untracking retains Earth's floating origin. Copy/reopen must retain it too.
  await page.evaluate(() => {
    window.cosmo.untrack();
    window.cosmo.setTime({ kind: 'et', et: 123456 });
    window.cosmo.setCamera([25000, 4000, 6000], [0, 0, 0], [0, 1, 0]);
    window.cosmo.setFov(35);
    window.cosmo.setTimeRate(-10);
  });
  const poseBefore = await read(page);
  await page.getByRole('button', { name: 'Display', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.fov-slider')?.value === '35');
  const poseUrl = await copy(page);
  const pose = JSON.parse(new URL(poseUrl).searchParams.get('view'));
  assert.equal(pose.view.kind, 'pose');
  assert.equal(pose.view.origin, 'Earth');
  assert.equal(pose.navigation.tracked, null);
  console.log('Pose link copied');
  const fresh = await browser.newContext();
  const reopened = await open(fresh, poseUrl);
  await ready(reopened, 123456);
  const restored = await read(reopened);
  assert.equal(restored.origin, 'Earth');
  assert.equal(restored.tracked, null);
  assert.equal(restored.rate, -10);
  cameraEqual(restored.camera, poseBefore.camera);
  await fresh.close();

  console.log('Fresh-session pose restored');
  // Explicit navigation, independent of copying, creates the history entry.
  // Use same-document navigation to exercise the viewer's popstate restore.
  await page.evaluate(url => {
    history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, poseUrl);
  await ready(page, 123456);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await ready(page);
  cameraEqual((await read(page)).camera, initial.camera);
  await page.goForward({ waitUntil: 'domcontentloaded' });
  await ready(page, 123456);
  cameraEqual((await read(page)).camera, poseBefore.camera);

  await page.waitForFunction(() => document.querySelector('.fov-slider')?.value === '35');
  console.log('Back/Forward restored');
  // Playback and pointer dragging do not generate history entries.
  const historyBefore = await page.evaluate(() => history.length);
  await page.evaluate(() => { window.cosmo.setPlaying(true); window.cosmo.setTime({ kind: 'et', et: 555 }); window.cosmo.setPlaying(false); });
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.mouse.move(680, 440, { steps: 8 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => history.length), historyBefore);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await ready(page);
  // A restored cut remains stationary after the previous drag. Count frames
  // to exercise controls damping; this is not an asset settle delay.
  await page.evaluate(() => new Promise(resolve => {
    let frames = 0;
    const next = () => ++frames === 12 ? resolve() : requestAnimationFrame(next);
    requestAnimationFrame(next);
  }));
  cameraEqual((await read(page)).camera, initial.camera);
  await page.waitForFunction(() => document.querySelector('.fov-slider')?.value === '42');

  // Error state is visible even when no catalog has loaded; no default fallback.
  for (const [patch, message] of [
    [{ version: 99 }, 'Unsupported view state version'],
    [{ navigation: { ...expected.navigation, selected: 'Missing Body' } }, 'entity "Missing Body"'],
    [{ catalog: { catalog: 'missing-issue-119-catalog' } }, "Couldn't load"],
    [{ catalog: { entry: 'missing-source/missing-entry' } }, 'No catalog'],
    [{ view: { kind: 'pose', version: 1, frame: 'UNKNOWN', origin: null, camera: initial.camera } }, 'camera frame'],
  ]) {
    const bad = new URL(base);
    bad.searchParams.set('test', '1');
    bad.searchParams.set('view', JSON.stringify({ ...expected, ...patch }));
    const failed = await open(context, bad.href);
    await failed.getByRole('alert').filter({ hasText: message }).waitFor({ timeout: 60000 });
    await failed.close();
  }
  await page.screenshot({ path: '/tmp/cosmolabe-119-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await copy(page);
  assert.ok(await page.getByRole('button', { name: 'Copy view link', exact: true }).isVisible());
  await page.screenshot({ path: '/tmp/cosmolabe-119-compact.png' });
  await page.close();
  // Timeline profiles travel as definitions: order and flags survive a copy.
  const profiles = { version: 1, profiles: [
    { profile: { quantity: 'range', bodies: { observer: 'Earth', target: 'Moon' } }, label: 'Distance', enabled: true, visible: true },
    { profile: { quantity: 'range-rate', bodies: { observer: 'Earth', target: 'Moon' } }, label: 'Range rate', enabled: false, visible: true },
  ] };
  const profileUrl = new URL(fixture.href);
  profileUrl.searchParams.set('view', JSON.stringify({ ...expected, profiles }));
  const profilePage = await open(context, profileUrl.href);
  await ready(profilePage);
  assert.deepEqual(JSON.parse(new URL(await copy(profilePage)).searchParams.get('view')).profiles, profiles);
  await profilePage.close();
  const eventFixture = new URL(readFileSync(new URL('../apps/viewer/test-permalinks/earth-moon-events-v1.url', import.meta.url), 'utf8').trim(), base);
  const eventExpected = JSON.parse(eventFixture.searchParams.get('view'));
  eventFixture.searchParams.set('test', '1');
  const eventPage = await open(context, eventFixture.href);
  await ready(eventPage, eventExpected.time.et);
  await eventPage.getByRole('button', { name: 'Events', exact: true }).click();
  await eventPage.locator('.event-result.selected').waitFor({ timeout: 90000 });
  const beforeEvents = await read(eventPage);
  assert.equal(beforeEvents.time, eventExpected.time.et, 'event selection must not override saved mission time');
  const eventUrl = await copy(eventPage);
  const shared = JSON.parse(new URL(eventUrl).searchParams.get('view'));
  assert.deepEqual(shared.events.selected, eventExpected.events.selected);
  assert.equal(shared.events.queries[0].query.abcorr, 'NONE');
  assert.equal(shared.events.queries[0].label, 'Lunar encounters');
  assert.equal(shared.events.queries[0].windowMode, 'explicit');
  assert.equal(shared.events.queries[0].searched, true);
  assert.ok(!('results' in shared.events), 'results are recomputed rather than embedded');
  assert.ok(await eventPage.locator('option:checked', { hasText: 'Custom' }).count() > 0, 'a shared explicit window restores as Custom');
  const controls = await eventPage.locator('select').evaluateAll(elements => elements.map(e => e.value));
  for (const value of ['Earth', 'Moon', 'local', '3600']) assert.ok(controls.includes(value), `visible query field ${value}`);
  await eventPage.goto(eventUrl, { waitUntil: 'domcontentloaded' });
  await ready(eventPage, eventExpected.time.et);
  await eventPage.reload({ waitUntil: 'domcontentloaded' });
  await ready(eventPage, eventExpected.time.et);
  await eventPage.getByRole('button', { name: 'Events', exact: true }).click();
  await eventPage.locator('.event-result.selected').waitFor({ timeout: 90000 });
  cameraEqual((await read(eventPage)).camera, beforeEvents.camera);
  assert.deepEqual(JSON.parse(new URL(await copy(eventPage)).searchParams.get('view')).events.selected, eventExpected.events.selected);
  await eventPage.screenshot({ path: '/tmp/cosmolabe-119-event-desktop.png' });

  // A fresh ordinary session recomputes the selected event using the worker.
  await eventPage.close();
  const eventContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const eventFresh = await open(eventContext, eventUrl);
  await ready(eventFresh, eventExpected.time.et);
  await eventFresh.getByRole('button', { name: 'Events', exact: true }).click();
  await eventFresh.locator('.event-result.selected').waitFor({ timeout: 90000 });
  assert.deepEqual(JSON.parse(new URL(await copy(eventFresh)).searchParams.get('view')).events.selected, eventExpected.events.selected);
  await eventFresh.setViewportSize({ width: 390, height: 844 });
  await copy(eventFresh);
  await eventFresh.screenshot({ path: '/tmp/cosmolabe-119-event-compact.png' });
  await eventContext.close();
  console.log('Permalink integration passed: frozen named view, reload, copy, retained origin, fresh session, Back/Forward, history, errors, compact rail UI, event query reruns, selected-result restoration and timeline profiles.');
} finally {
  await browser.close();
}
