/** Reproduce globe tick registration at close zoom on the real Earth catalog.
 * GRID_VIEWER_URL=http://127.0.0.1:5188 GRID_OUTPUT=/tmp/grid-close node scripts/graticule-close-zoom-validation.mjs
 * Registration errors compare ticks with independent triangle raycasts, not GPU raster accuracy.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const out = resolve(process.env.GRID_OUTPUT ?? '/tmp/grid-close');
await mkdir(out, { recursive: true });
const report = { passed: false, errors: [], views: [] };
const browser = await chromium.launch({ channel: process.platform === 'darwin' ? 'chrome' : undefined, headless: true,
  args: process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror', error => report.errors.push(error.message));
try {
await page.goto(`${process.env.GRID_VIEWER_URL ?? 'http://127.0.0.1:5188'}/?catalog=test-catalogs/earth-moon&test=1`);
await page.waitForFunction(()=>window.renderer?.getBodyMesh('Earth')&&window.__cosmolabe?.assetsReady,undefined, { timeout: 60000 });
for (const altitude of [30, 12, 5, 2, 12]) {
await page.evaluate(async({altitude,coreUrl})=>{
 const lat = altitude === 2 ? 16.6825 : 16.67, lon = altitude === 2 ? 0.1625 : 0.18;
 const r=window.renderer,bm=r.getBodyMesh('Earth'), c=window.cosmo;
 const state=await import(performance.getEntriesByType('resource').map(e=>e.name).filter(u=>new URL(u).pathname==='/src/lib/viewer-state.svelte.ts').at(-1));
 state.setLighting('flood');c.setPlaying(false);c.untrack();c.select(null);c.setLayer('grid',true);c.setGridScope('bodies','Earth');c.setGridDensity('auto');c.setGridLabels(true);c.setGridCoordinateFrame(false);
 const core=await import(coreUrl), V=r.camera.position.constructor;
 const pt=(lat,lon,h)=>{const p=core.surfacePositionToBodyFixed({latDeg:lat,lonDeg:lon,heightKm:h},bm.surfaceCoordinates);return new V(p.xKm,p.yKm,p.zKm).applyQuaternion(bm.bodyToWorldQuaternion(r.camera.quaternion.clone())).multiplyScalar(r.scaleFactor).add(bm.position);};
 const target=pt(lat,lon,0);r.cameraController.controls.enableDamping=false;r.camera.position.copy(pt(lat,lon,altitude));r.camera.up.copy(pt(lat+.01,lon,0).sub(target).normalize());r.cameraController.controls.target.copy(target);r.camera.lookAt(target);r.camera.updateMatrixWorld(true);
}, { altitude, coreUrl: `/@fs/${process.cwd()}/packages/core/dist/index.js` });
await page.waitForTimeout(2000);
const view = await page.evaluate(async coreUrl => {
  const core = await import(coreUrl), r = window.renderer, bm = r.getBodyMesh('Earth'), grid = bm.graticule;
  const V = r.camera.position.constructor, ray = new grid.raycaster.constructor();
  const world = grid.toWorld, errors = [];
  for (const annotation of bm.gridMetrics.annotations) {
    const value = annotation.axis === 'latitude' ? annotation.latDeg : annotation.lonDeg;
    if (Math.abs(parseFloat(annotation.text) - Math.abs(value)) > 1e-6) throw new Error(`Rounded caption ${annotation.text} for ${value}`);
    const p = core.surfacePositionToBodyFixed({ latDeg: annotation.latDeg, lonDeg: annotation.lonDeg }, bm.surfaceCoordinates);
    const q = core.surfacePositionToBodyFixed({ latDeg: annotation.latDeg, lonDeg: annotation.lonDeg, heightKm: 1 }, bm.surfaceCoordinates);
    const base = new V(p.xKm,p.yKm,p.zKm), normal = new V(q.xKm,q.yKm,q.zKm).sub(base).normalize();
    ray.set(base.addScaledVector(normal, 100).applyMatrix4(world), normal.negate().transformDirection(world));
    const hit = ray.intersectObject(bm.mesh)[0];
    if (!hit) throw new Error('Visible tick has no globe triangle');
    const actual = hit.point.project(r.camera), tick = grid.labels.get(annotation.id).sprite.getWorldPosition(new V()).project(r.camera);
    errors.push(Math.hypot((actual.x-tick.x)*innerWidth/2, (actual.y-tick.y)*innerHeight/2));
  }
  const gl = r.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  return { labels: errors.length, maxRegistrationErrorCssPx: Math.max(0,...errors), step: bm.gridMetrics.latitudeStep,
    gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null };
}, `/@fs/${process.cwd()}/packages/core/dist/index.js`);
assert.ok(view.labels > 0, `No labels at ${altitude} km`);
assert.ok(view.maxRegistrationErrorCssPx < 0.2, `Globe registration drift at ${altitude} km`);
report.views.push({ altitudeKm: altitude, latitudeDeg: altitude === 2 ? 16.6825 : 16.67, longitudeDeg: altitude === 2 ? 0.1625 : 0.18, ...view });
console.log(JSON.stringify(report.views.at(-1)));
await page.screenshot({ path: `${out}/earth-${altitude}km.png` });
}
assert.deepEqual(report.errors, []);
report.passed = true;
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
