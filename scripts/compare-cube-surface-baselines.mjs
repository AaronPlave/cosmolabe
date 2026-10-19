/** Compare CUBE_STYLE_BASELINE_ONLY captures from independent main/PR viewers.
 * node scripts/compare-cube-surface-baselines.mjs MAIN_DIR PR_DIR OUTPUT_DIR
 * Cache-dependent imagery differences are reported, not attributed to normals.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const [mainDir, prDir, outDir] = process.argv.slice(2);
assert.ok(mainDir && prDir && outDir, 'Expected MAIN_DIR PR_DIR OUTPUT_DIR');
await mkdir(outDir, { recursive: true });
const readResults = async dir => JSON.parse(await readFile(`${dir}/results.json`, 'utf8'));
const [main, pr] = await Promise.all([readResults(mainDir), readResults(prDir)]);
const results = [];
for (const product of main) {
  const candidate = pr.find(row => row.name === product.name);
  assert.ok(candidate);
  assert.deepEqual(product.errors, []); assert.deepEqual(candidate.errors, []);
  for (const [view, before] of Object.entries(product.views)) {
    const after = candidate.views[view];
    assert.equal(before.et, after.et, 'same epoch');
    assert.deepEqual(before.camera, after.camera, 'same camera');
    assert.deepEqual(before.ids, after.ids, 'same source terrain tiles');
    assert.equal(before.styleActive, false); assert.equal(after.styleActive, false);
    assert.equal(before.sunIntensity, 2); assert.equal(after.sunIntensity, 2);
    // Guard against accidentally comparing the PR server to itself.
    assert.ok(before.sourceModules.length && after.sourceModules.length);
    assert.notDeepEqual(before.sourceModules.map(url => new URL(url).pathname),
      after.sourceModules.map(url => new URL(url).pathname));
    const readPng = async dir => PNG.sync.read(await readFile(`${dir}/${product.name}-${view}.png`));
    const [a, b] = await Promise.all([readPng(mainDir), readPng(prDir)]);
    assert.equal(a.width, b.width); assert.equal(a.height, b.height);
    const diff = new PNG({ width: a.width, height: a.height });
    const changedPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: .01 });
    await writeFile(`${outDir}/${product.name}-${view}-main-diff.png`, PNG.sync.write(diff));
    let legacyMainPixels = null;
    if (after.legacyControl) {
      assert.equal(after.legacyControl.restoredPixels, 0);
      assert.deepEqual(after.legacyControl.cacheBefore, after.legacyControl.cacheAfter);
      if (view === 'lit') assert.ok(after.legacyControl.changedPixels > 100);
      const legacy = PNG.sync.read(await readFile(`${prDir}/${product.name}-${view}-legacy-control.png`));
      legacyMainPixels = pixelmatch(a.data, legacy.data, null, a.width, a.height, { threshold: .01 });
      assert.equal(legacyMainPixels, 0, 'legacy normal control reproduces independent main pixels');
    }
    results.push({ product: product.name, view, changedPixels, changedPercent: changedPixels / (a.width * a.height) * 100,
      sameImageryLevels: JSON.stringify(before.imagery.displayedLevels) === JSON.stringify(after.imagery.displayedLevels),
      mainNormalSlopeDegrees: before.normalSlopeDegrees, prNormalSlopeDegrees: after.normalSlopeDegrees,
      legacyControl: after.legacyControl, legacyMainPixels });
  }
}
await writeFile(`${outDir}/comparison.json`, JSON.stringify({ equalEpochCameraTerrainTiles: true, threshold: .01, results }, null, 2));
console.log(results.map(({ product, view, changedPercent, sameImageryLevels, legacyControl }) =>
  ({ product, view, changedPercent, sameImageryLevels, controlledNormalPixels: legacyControl?.changedPixels })));
