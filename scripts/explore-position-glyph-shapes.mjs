import { chromium } from 'playwright';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
const browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors=[]; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (/fail|error/i.test(m.text())) console.log('CONSOLE', m.text().slice(0,200)); });
const ROOT = new URL('../apps/viewer/test-catalogs/', import.meta.url).pathname;
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === 'http://127.0.0.1:5173' && /^\/(kernels|models|base|textures|europa-clipper\.json)/.test(url.pathname)) {
    const file = ROOT + decodeURIComponent(url.pathname).replace(/^\//, '');
    if (existsSync(file)) return route.fulfill({ body: readFileSync(file), contentType: ({ '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg' })[extname(file)] ?? 'application/octet-stream' });
  }
  return route.continue();
});
await page.goto('http://127.0.0.1:5173/?catalog=europa-clipper&test=1', { waitUntil: 'domcontentloaded' });
await page.evaluate(async () => {
  const source = await (await fetch('/src/lib/commands.ts')).text();
  const u = source.match(/from ["']([^"']*viewer-state\.svelte[^"']*)["']/)?.[1];
  window.gs = await import(u ?? '/src/lib/viewer-state.svelte.ts');
});
await page.waitForFunction(() => { const { getRenderer, vs } = window.gs; const r = getRenderer(); return vs.sceneLoaded && vs.assetsReady && r?.getBodyMesh('Europa Clipper')?.hasModel; }, null, { timeout: 240000 });
const info = await page.evaluate(() => { const r = window.gs.getRenderer(); const sc=r.getBodyMesh('Europa Clipper'); const eu=r.getBodyMesh('Europa'); return { et: r.timeController.et, present: sc.present, vis: sc.visible, dist: sc.position.distanceTo(eu.position)/r.scaleFactor, scale: r.scaleFactor, hasModel: sc.hasModel, att: sc.attitudeAvailable }; });
console.log(JSON.stringify(info));
mkdirSync('work/position-glyphs/real', { recursive: true });
const shots = [];
for (const [label, distKm, pinned, tracked] of [['wide-40000km-rest', 40000, false, false], ['wide-40000km-selected', 40000, true, false], ['wide-40000km-tracked', 40000, true, true], ['mid-6000km-rest', 6000, false, false], ['handoff-1.5km-rest', 1.5, false, false], ['handoff-0.9km-rest', 0.9, false, false], ['handoff-0.6km-rest', 0.6, false, false]]) {
  for (const shape of ['dot', 'square']) {
    const res = await page.evaluate(async ({ distKm, shape, pinned, tracked }) => {
      const r = window.gs.getRenderer(); const sc = r.getBodyMesh('Europa Clipper');
      r.timeController.setTime(985657200); window.cosmo.setPlaying(false);
      if (!tracked) window.cosmo.untrack(); else window.cosmo.track?.('Europa Clipper');
      r.positionGlyphs.spacecraftShape = shape;
      r.setLabelPinned('Europa Clipper', pinned);
      r.camera.fov = 50; r.camera.updateProjectionMatrix();
      const frame = async () => { r.renderFrame(); await new Promise(requestAnimationFrame); r.renderFrame(); };
      await frame();
      r.cameraController.controls.target.copy(sc.position);
      r.camera.up.set(0, 1, 0);
      r.camera.position.copy(sc.position).add({ x: 0.55 * distKm * r.scaleFactor, y: 0.3 * distKm * r.scaleFactor, z: 0.78 * distKm * r.scaleFactor });
      r.camera.lookAt(sc.position); r.camera.updateMatrixWorld(true);
      await frame(); await frame();
      const g = r.getPositionGlyphReadout().find(e => e.name === 'Europa Clipper');
      return { anchor: g?.anchor ?? null, weight: g?.glyphWeight ?? 0, extent: g?.extentPx ?? null, modelVisible: sc.isModelVisible };
    }, { distKm, shape, pinned, tracked });
    const a = res.anchor ?? { x: 640, y: 400 };
    const x = Math.max(0, Math.min(1280 - 360, Math.round(a.x - 180))), y = Math.max(0, Math.min(800 - 240, Math.round(a.y - 120)));
    await page.screenshot({ path: `work/position-glyphs/real/${label}-${shape}-full.png` });
    await page.screenshot({ path: `work/position-glyphs/real/${label}-${shape}-crop.png`, clip: { x, y, width: 360, height: 240 } });
    console.log(label, shape, JSON.stringify(res));
  }
} console.log(errors.join('\n'));
await browser.close();
