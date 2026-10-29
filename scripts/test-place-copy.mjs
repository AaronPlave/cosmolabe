/** Places clipboard feedback expires like the view-link message. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5194/';
const hardware = process.env.CL_GPU === 'hardware';
const browser = await chromium.launch({
  executablePath: hardware ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
  args: hardware ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.goto(`${base}?catalog=test-catalogs/planetary-places`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.renderer?.placeNames?.index.places.length === 11139);
  await page.evaluate(async () => {
    const path = '/src/lib/places.ts';
    const url = performance.getEntriesByType('resource').map(e => e.name).find(url => new URL(url).pathname === path);
    const places = await import(url ?? path);
    places.selectPlace(places.searchPlaces('Valles Marineris')[0]);
  });
  const copied = page.getByText('Coordinates copied', { exact: true });
  await page.getByRole('button', { name: 'Copy coordinates', exact: true }).click();
  await copied.waitFor();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /° [NS], .*° [EW]/);
  await page.waitForTimeout(3200);
  await page.getByRole('button', { name: 'Copy coordinates', exact: true }).click();
  await page.waitForTimeout(3200);
  assert.equal(await copied.isVisible(), true, 'a repeated copy restarts the timeout');
  await copied.waitFor({ state: 'hidden', timeout: 4000 });
  await page.getByText('Place details', { exact: true }).click();
  await page.getByRole('button', { name: 'Copy source details', exact: true }).click();
  const sourceCopied = page.getByText('Source details copied', { exact: true });
  await sourceCopied.waitFor();
  assert.ok(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).ref);
  await sourceCopied.waitFor({ state: 'hidden', timeout: 7000 });
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied'); };
  });
  await page.getByRole('button', { name: 'Copy coordinates', exact: true }).click();
  const failed = page.getByText('Clipboard unavailable', { exact: true });
  await failed.waitFor();
  await failed.waitFor({ state: 'hidden', timeout: 7000 });
  console.log('PASS: coordinate and source copy success/error feedback expires; repeated copy restarts timeout; clipboard content preserved.');
} finally {
  await browser.close();
}
