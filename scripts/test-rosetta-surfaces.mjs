#!/usr/bin/env node
// Real 67P picking and GPU depth regression. Run against the current viewer.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import sharp from 'sharp';
const viewer = process.env.CL_VIEWER_URL ?? 'http://localhost:5173';
const output = process.env.ROSETTA_CAPTURE_DIR ?? '/tmp/rosetta-surfaces';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${viewer}/?catalog=test-catalogs/rosetta&test=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__cosmolabe?.assetsReady, null, { timeout: 180000 });
  await page.evaluate(() => window.__cosmolabe.capture('Impact at Sais (2016-09-30)'));
  const result = await page.evaluate(async () => {
    const T = await import('/node_modules/.vite/deps/three.js');
    const r = window.renderer, camera = r.camera;
    const body = r.bodyMeshes.get('67P/Churyumov-Gerasimenko');
    const caster = new T.Raycaster(); caster.layers.enableAll();
    let picked;
    for (let y = -0.3; y <= 0.3 && !picked; y += 0.1) for (let x = -0.3; x <= 0.3; x += 0.1) {
      caster.setFromCamera(new T.Vector2(x, y), camera);
      const hit = caster.intersectObjects([body.modelContainer], true)[0];
      if (hit) { picked = { x, y, hit }; break; }
    }
    if (!picked) throw new Error('No visible 67P plate');
    const { x, y, hit } = picked;
    const rect = r.renderer.domElement.getBoundingClientRect();
    const screenX = (x + 1) * rect.width / 2, screenY = (1 - y) * rect.height / 2;
    const bodyHit = r._discoverBodyMesh(x, y);
    const surfaceHit = r.pickSurface(x, y);
    const front = camera.position.clone().lerp(hit.point, 0.9);
    const behind = camera.position.clone().lerp(hit.point, 1.1);
    const rayDir = hit.point.clone().sub(camera.position).normalize();
    const right = new T.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new T.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const focal = rect.height / (2 * Math.tan(camera.fov * Math.PI / 360));
    function line(center, color, row) {
      const worldPerPx = center.distanceTo(camera.position) / focal;
      const p = center.clone().addScaledVector(up, row * worldPerPx);
      const a = p.clone().addScaledVector(right, -40 * worldPerPx);
      const b = p.clone().addScaledVector(right, 40 * worldPerPx);
      const geometry = new T.BufferGeometry().setFromPoints([a, b]);
      const object = new T.Line(geometry, new T.LineBasicMaterial({ color, depthTest: true, depthWrite: false, toneMapped: false }));
      r.scene.add(object);
      const pixel = p.clone().project(camera);
      return { x: (pixel.x + 1) * rect.width / 2, y: (1 - pixel.y) * rect.height / 2 };
    }
    const frontPixel = line(front, 0xff00ff, 5);
    const behindPixel = line(behind, 0x00ff00, -5);
    function labelOpacity(point) {
      const sprite = new T.Sprite(new T.SpriteMaterial({ depthTest: false, depthWrite: false }));
      r.labelManager.applyOcclusionFade(sprite, point, point.distanceTo(camera.position), [body], camera.position);
      return sprite.material.opacity;
    }
    window.__dskClicks = [];
    r.events.on('body:click', event => window.__dskClicks.push(event.bodyName));
    return { bodyHit, source: surfaceHit?.point.source, screenX, screenY, frontPixel, behindPixel,
      frontLabelOpacity: labelOpacity(front), behindLabelOpacity: labelOpacity(behind),
      frontOccluded: body.dskOccludes(camera.position, front), behindOccluded: body.dskOccludes(camera.position, behind),
      dskLayer: body.getDskMeshes()[0]?.layers.mask,
      viewDirection: rayDir.toArray() };
  });
  assert.equal(result.bodyHit, '67P/Churyumov-Gerasimenko');
  assert.equal(result.source, 'dsk');
  assert.equal(result.frontLabelOpacity, 1); assert.equal(result.behindLabelOpacity, 0);
  assert.equal(result.frontOccluded, false); assert.equal(result.behindOccluded, true);
  const capture = await page.evaluate(() => window.__cosmolabe.capture());
  const png = Buffer.from(capture.split(',')[1], 'base64');
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  function near(pixel, predicate) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const offset = (Math.round(pixel.y + dy) * info.width + Math.round(pixel.x + dx)) * info.channels;
      if (predicate(data[offset], data[offset + 1], data[offset + 2])) return true;
    }
    return false;
  }
  assert.ok(near(result.frontPixel, (r,g,b) => r > 150 && g < 80 && b > 150), 'foreground magenta line must remain visible over 67P');
  assert.equal(near(result.behindPixel, (r,g,b) => g > 150 && r < 80 && b < 80), false, '67P must hide the green line behind its plates');
  await page.mouse.click(result.screenX, result.screenY);
  assert.ok((await page.evaluate(() => window.__dskClicks)).includes('67P/Churyumov-Gerasimenko'));
  assert.deepEqual(errors, []);
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/dsk-depth.png`, png);
  writeFileSync(`${output}/report.json`, JSON.stringify({ ...result, errors }, null, 2));
  console.log(`67P real mesh click/probe, foreground/background line pixels and label occlusion passed: ${output}`);
} finally { await browser.close(); }
