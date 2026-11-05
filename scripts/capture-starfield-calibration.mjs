/** Fixed-time/exposure normal-viewer comparison, including actual compositing.
 * Start the viewer, then CL_CHROMIUM=/usr/bin/chromium node scripts/capture-starfield-calibration.mjs
 * CL_VIEWER_URL defaults to http://127.0.0.1:5188; CL_STAR_OUTPUT selects artifacts.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = (process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5188').replace(/\/+$/, '');
const output = process.env.CL_STAR_OUTPUT ?? '/tmp/starfield-viewer';
const scales = [0.06, 0.3, 0.6];
const epoch = 773366400;
const results = [];
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CL_CHROMIUM,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const viewports = [{ width: 800, height: 600 }, ...(process.env.CL_STAR_SMOKE ? [] : [{ width: 1280, height: 720 }])];
  for (const viewport of viewports) {
    for (const dpr of process.env.CL_STAR_SMOKE ? [1] : [1, 2]) {
      for (const [body, catalog, viewpoint] of [
        ['Earth', 'atmosphere-earth-textured', 'Whole disc'],
        ['Moon', 'geographic-vectors', 'Lunar polar vectors'],
        ['Saturn', 'atmosphere-saturn-shadow', 'Clouds and shadows'],
      ]) {
        const page = await browser.newPage({ viewport, deviceScaleFactor: dpr });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {
          if (/Shader Error|VALIDATE_STATUS|ERROR: 0:/.test(message.text())) errors.push(message.text());
        });
        try {
          await page.goto(`${base}/?catalog=test-catalogs/${catalog}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
          await page.waitForFunction(() => window.renderer?.starField?.getCatalogStatus().state === 'ready', null, { timeout: 60000 });
          const assets = await page.evaluate(async ({ viewpoint, body, epoch }) => {
            const r = window.renderer;
            const assets = await r.waitForInitialAssets();
            r.stop(); r.timeController.setTime(epoch);
            window.cosmo.untrack(); r.applyNamedViewpoint(viewpoint); r.renderFrame();
            r.cameraController.controls.staticMoving = true;
            r.renderer.toneMappingExposure = 1;
            if (body === 'Moon') {
              for (const id of ['jezero-science', 'moon-science']) r.geographicVectors.setVisible(id, false);
              const center = r.getBodyMesh(body).position.clone();
              const sun = r.absolutePositionOf('Sun', epoch), moon = r.absolutePositionOf(body, epoch);
              const direction = center.clone().set(...sun).sub(center.clone().set(...moon)).normalize();
              r.camera.position.copy(center).addScaledVector(direction, 4 * 1737.4 * r.scaleFactor);
              r.cameraController.controls.target.copy(center); r.camera.lookAt(center);
            }
            r.renderFrame();
            return assets;
          }, { viewpoint, body, epoch });
          assert.equal(assets.failed, 0); assert.equal(assets.timedOut, false);
          for (const pose of body === 'Earth' ? ['Earth', 'dark-sky', 'narrow-sky'] : [body]) {
            const rows = await page.evaluate(async ({ scales, pose }) => {
              const r = window.renderer, c = r.camera, field = r.starField;
              const controls = r.cameraController.controls, points = field.children[0];
              const positions = points.geometry.getAttribute('position');
              const magnitudes = points.geometry.getAttribute('aMagnitude');
              if (pose.endsWith('sky')) {
                const direction = c.position.clone().fromBufferAttribute(positions, 0).transformDirection(field.matrixWorld);
                controls.target.copy(c.position).add(direction);
                c.fov = pose === 'narrow-sky' ? 1 : 60;
                c.updateProjectionMatrix(); c.lookAt(controls.target);
              }
              const read = () => {
                r.renderFrame(); const gl = r.renderer.getContext();
                const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
                gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                return pixels;
              };
              field.visible = false; const baseline = read(); field.visible = true;
              const width = r.renderer.domElement.width, height = r.renderer.domElement.height;
              function measure(pixels) {
                let changedPixels = 0, brightForegroundChanges = 0, maxDelta = 0, signal = 0;
                for (let i = 0; i < pixels.length; i += 4) {
                  const delta = Math.max(pixels[i] - baseline[i],
                    pixels[i + 1] - baseline[i + 1], pixels[i + 2] - baseline[i + 2]);
                  signal += Math.max(0, delta);
                  if (delta > 0) {
                    changedPixels++;
                    if (Math.max(baseline[i], baseline[i + 1], baseline[i + 2]) >= 32) brightForegroundChanges++;
                  }
                  maxDelta = Math.max(maxDelta, delta);
                }
                const detections = { magnitude3: { inView: 0, detected: 0 }, magnitude4: { inView: 0, detected: 0 } };
                const v = c.position.clone();
                for (let i = 0; i < positions.count; i++) {
                  const mag = magnitudes.getX(i);
                  if (mag > 4) continue;
                  v.fromBufferAttribute(positions, i).transformDirection(field.matrixWorld).transformDirection(c.matrixWorldInverse);
                  if (v.z >= 0) continue;
                  v.applyMatrix4(c.projectionMatrix);
                  const x = Math.floor((v.x + 1) * width / 2), y = Math.floor((v.y + 1) * height / 2);
                  const radius = Math.ceil(2 * r.renderer.getPixelRatio());
                  if (x < radius || y < radius || x >= width - radius || y >= height - radius) continue;
                  let peak = 0;
                  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
                    const offset = ((y + dy) * width + x + dx) * 4;
                    for (let ch = 0; ch < 3; ch++) peak = Math.max(peak, pixels[offset + ch] - baseline[offset + ch]);
                  }
                  detections.magnitude4.inView++;
                  if (peak >= 7) detections.magnitude4.detected++;
                  if (mag <= 3) {
                    detections.magnitude3.inView++;
                    if (peak >= 16) detections.magnitude3.detected++;
                  }
                }
                return { changedPixels, brightForegroundChanges, maxDelta, signal, detections };
              }
              const rows = [];
              for (const scale of scales) {
                field.setLinearFluxScale(scale);
                const pixels = read();
                rows.push({ scale, ...measure(pixels), png: r.renderer.domElement.toDataURL(),
                  epoch: r.timeController.et, position: c.position.toArray(), quaternion: c.quaternion.toArray(),
                  fov: c.fov, exposure: r.renderer.toneMappingExposure, toneMapping: r.renderer.toneMapping,
                  outputColorSpace: r.renderer.outputColorSpace, resolution: [width, height],
                  sigmaCss: points.material.uniforms.uSigmaCss.value, skyBrightness: points.material.uniforms.uSkyBrightness.value });
              }
              // A real viewer slow pan at the candidate scale. Byte sums record
              // quantization; the separate GPU fixture checks pre-tone flux.
              if (pose.endsWith('sky')) {
                const aim = controls.target.clone().sub(c.position);
                const axis = c.up.clone().normalize(), pan = [];
                for (let phase = 0; phase < 8; phase++) {
                  controls.target.copy(c.position).add(aim.clone().applyAxisAngle(axis,
                    phase / (8 * (c.aspect * height / r.renderer.getPixelRatio() / 2) * c.projectionMatrix.elements[0])));
                  c.lookAt(controls.target);
                  const pixels = read(); let signal = 0;
                  for (let i = 0; i < pixels.length; i += 4) signal += pixels[i] + pixels[i + 1] + pixels[i + 2];
                  pan.push(signal);
                }
                rows.at(-1).pan = pan;
              }
              return rows;
            }, { scales, pose });
            for (const { png, ...row } of rows) {
              const filename = `${pose.toLowerCase()}-${viewport.width}x${viewport.height}-dpr${dpr}-scale${row.scale}.png`;
              await writeFile(`${output}/${filename}`, Buffer.from(png.split(',')[1], 'base64'));
              results.push({ pose, viewport, dpr, catalog, assets, filename, ...row, errors });
              assert.equal(row.epoch, epoch); assert.equal(row.exposure, 1);
              assert.equal(row.sigmaCss, 0.875);
              if (pose.endsWith('sky') && row.scale === 0.6) {
                for (const detection of Object.values(row.detections)) {
                  assert.ok(detection.inView > 0);
                  assert.equal(detection.detected, detection.inView, JSON.stringify({ pose, viewport, dpr, detection }));
                }
              }
            }
            console.log(JSON.stringify({ pose, viewport, dpr,
              comparison: rows.map(({ scale, changedPixels, detections, brightForegroundChanges }) => ({ scale, changedPixels, detections, brightForegroundChanges })) }));
          }
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      }
    }
  }
} finally {
  await writeFile(`${output}/matrix.json`, JSON.stringify({ browser: browser.version(), epoch, results }, null, 2));
  await browser.close();
}
