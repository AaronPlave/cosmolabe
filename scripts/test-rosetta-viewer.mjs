#!/usr/bin/env node
// Browser smoke/captures against a running current-checkout viewer.
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const output = process.env.ROSETTA_CAPTURE_DIR ?? mkdtempSync(join(tmpdir(), 'cosmolabe-rosetta-'));
const viewer = process.env.CL_VIEWER_URL ?? 'http://localhost:5173';
const browser = await chromium.launch({ headless: true, args: [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
] });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${viewer.replace(/\/$/, '')}/?catalog=test-catalogs/rosetta&test=1`, {
    waitUntil: 'domcontentloaded', timeout: 120000,
  });
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, null, { timeout: 180000 });
  mkdirSync(output, { recursive: true });
  const assets = await page.evaluate(() => window.__cosmolabe.assetSummary);
  assert.equal(assets.failed, 0);
  assert.equal(assets.timedOut, false);
  const save = (name, data) => writeFileSync(join(output, name), Buffer.from(data.split(',')[1], 'base64'));
  const viewpoints = await page.evaluate(() => window.__cosmolabe.viewpoints());
  for (const name of viewpoints) {
    save(`${name.replaceAll(/[^a-z0-9]+/gi, '-')}.png`, await page.evaluate(n => window.__cosmolabe.capture(n), name));
  }
  // Close view in spacecraft axes without changing the catalog or inventing a
  // mounting offset. Use the actual rendered body-fixed→world orientation.
  await page.evaluate(() => {
    window.__cosmolabe.capture('Philae separation (2014-11-12)');
    const r = window.renderer, cc = r.cameraController;
    const vp = cc.getViewpoint('Philae separation (2014-11-12)');
    const bm = r.bodyMeshes.get('Rosetta');
    const q = bm.bodyToWorldQuaternion(bm.quaternion.clone());
    const position = vp.position.clone().set(0.010, -0.008, 0.006).applyQuaternion(q).multiplyScalar(r.scaleFactor);
    cc.applyViewpoint({ ...vp, position });
  });
  save('hga-mount.png', await page.evaluate(() => window.__cosmolabe.capture()));

  const transitions = [];
  for (const epoch of [
    '2012-01-01T00:00:00Z',
    '2014-11-12T08:35:14Z', '2014-11-12T08:35:15Z', '2014-11-12T08:35:16Z',
    '2014-11-12T15:34:04Z', '2014-11-12T17:24:00Z', '2014-11-12T18:00:00Z',
    '2016-09-30T10:39:29Z', '2016-09-30T10:39:30Z', '2016-09-30T10:39:31Z',
  ]) {
    const state = await page.evaluate(time => {
      if (!window.__cosmolabe.seek(time)) throw new Error(`Cannot seek ${time}`);
      window.__cosmolabe.capture();
      return [...window.renderer.bodyMeshes].filter(([name]) => /Rosetta|Philae/.test(name)).map(([name, body]) => ({
        name, present: body.present, visible: body.visible, position: body.position.toArray(),
      }));
    }, epoch);
    const philae = state.find(body => body.name === 'Philae');
    const rosetta = state.filter(body => body.name.startsWith('Rosetta'));
    assert.equal(philae.present, epoch >= '2014-11-12T08:35:15Z');
    assert.ok(rosetta.every(body => body.present === (epoch <= '2016-09-30T10:39:30Z')));
    for (const body of state) {
      assert.equal(body.visible, body.present);
      if (body.present) assert.ok(body.position.every(Number.isFinite));
    }
    transitions.push({ epoch, state });
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(output, 'report.json'), JSON.stringify({ assets, viewpoints, transitions, errors }, null, 2));
  console.log(`Rosetta: ${viewpoints.length} viewpoints, ${transitions.length} transition epochs, ${assets.loaded} assets; captures: ${output}`);
} finally {
  await browser.close();
}
