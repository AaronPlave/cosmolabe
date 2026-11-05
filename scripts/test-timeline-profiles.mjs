/** #359 native Rosetta timeline + shared script/Ask dispatcher acceptance.
 * CL_VIEWER_URL selects an already-running checkout. No external model or screenshots.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5199/';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(new URL('?catalog=test-catalogs/rosetta&test=1', base).href, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.cosmo?.getScene()?.ready, null, { timeout: 120000 });
  await page.evaluate(() => {
    const c = window.cosmo; c.setPlaying(false);
    const et = c.getTime();
    c.setTimelineWindow({ kind: 'et', et }, { kind: 'et', et: et + 3600 });
  });
  const result = await page.evaluate(async () => {
    const loaded = path => performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname.endsWith(path));
    const control = await import(loaded('/packages/control/src/index.ts'));
    const c = window.cosmo, tools = control.createCapabilityTools(c, { surface: 'fixed' });
    const before = { time: c.getTime(), camera: c.getCamera(), tracked: c.getTracked(), selected: c.getSelected(), playing: c.isPlaying() };
    const options = await tools.call('invokeCapability', { id: 'profiles.getProfileOptions', input: {} });
    const target = c.listObjects().find(n => n.startsWith('67P/'));
    if (!target || !c.listObjects().includes('Philae')) throw new Error('Missing Rosetta participants');
    const definition = { id: 'philae-distance', profile: { quantity: 'range', bodies: { observer: 'Philae', target } } };
    await control.execute(control.parse(`upsertProfile ${JSON.stringify(JSON.stringify(definition))}`), c);
    await new Promise(requestAnimationFrame);
    const fromScript = c.getProfile(definition.id);
    // Follow-up uses the same ID through Ask's discoverable dispatcher.
    tools.describeCapabilities(['profiles.upsertProfile']);
    const ask = await tools.call('invokeCapability', { id: 'profiles.upsertProfile', input: { definition: JSON.stringify({ ...definition, visible: true }) } });
    await new Promise(requestAnimationFrame);
    const observed = await tools.call('invokeCapability', { id: 'profiles.getProfile', input: { id: definition.id } });
    const after = { time: c.getTime(), camera: c.getCamera(), tracked: c.getTracked(), selected: c.getSelected(), playing: c.isPlaying() };
    const unsupported = await tools.call('invokeCapability', { id: 'profiles.upsertProfile', input: { definition: JSON.stringify({ ...definition, id: 'clearance', profile: { ...definition.profile, quantity: 'physical-clearance' } }) } });
    tools.dispose();
    return { before, after, options, fromScript, ask, observed, unsupported, total: c.listProfiles().total };
  });
  assert.deepEqual(result.after, result.before, 'profile creation must not move the scene');
  assert.equal(result.total, 1);
  assert.equal(result.options.ok, true);
  assert.equal(result.fromScript.definition.profile.quantity, 'range');
  assert.equal(result.fromScript.timeline.present, true);
  assert.equal(result.fromScript.timeline.traceVisible, true);
  assert.equal(result.ask.ok, true);
  assert.equal(result.ask.receipt.status, 'completed');
  assert.equal(result.observed.data.timeline.traceVisible, true);
  assert.equal(result.unsupported.ok, false);
  const row = page.locator('[data-tl-row="profile:philae-distance"]');
  assert.ok(await row.locator('path.trace').getAttribute('d'), 'native sampled trace exists');
  await row.getByRole('button', { name: 'Hide profile', exact: true }).click();
  await page.waitForFunction(() => window.cosmo.getProfile('philae-distance').definition.visible === false);
  await row.getByRole('button', { name: 'Show profile', exact: true }).click();
  await row.locator('.tl-label-main').click();
  await page.locator('[data-slot=popover-content] select').first().selectOption('range-rate');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  assert.equal(await page.evaluate(() => window.cosmo.getProfile('philae-distance').definition.profile.quantity), 'range-rate');
  await row.getByRole('button', { name: 'Remove profile', exact: true }).click();
  assert.equal(await page.evaluate(() => window.cosmo.listProfiles().total), 0);
  // Native Add uses the same semantic adapter and is visible to a host read.
  await page.getByRole('button', { name: 'Add profile', exact: true }).click();
  const config = page.locator('[data-slot=popover-content]');
  await config.locator('select').nth(1).selectOption('Philae');
  await config.locator('select').nth(2).selectOption('67P/Churyumov-Gerasimenko');
  await config.getByRole('button', { name: 'Add', exact: true }).click();
  const native = await page.evaluate(() => window.cosmo.listProfiles().items);
  assert.equal(native.length, 1);
  assert.equal(native[0].profile.bodies.observer, 'Philae');
  assert.equal(native[0].profile.quantity, 'range');
  await page.evaluate(id => window.cosmo.removeProfile(id), native[0].id);
  assert.deepEqual(errors, []);
  console.log('PASS: Rosetta Philae → 67P native timeline, shared script/Ask ID, quantity/visibility/edit/remove, unchanged scene, unsupported physical clearance refused');
} finally { await browser.close(); }
