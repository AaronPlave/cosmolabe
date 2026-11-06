/** Visual acceptance for unresolved-entity position glyphs (#337), in the real viewer.
 * Start `npm --prefix apps/viewer run dev` first, then:
 *   CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/check-position-glyphs.mjs
 *
 * Synthetic Europa-Clipper-like scene (the real demo needs a 44 MB BSP): a
 * 10 m spacecraft model on the *unlit* side of Europa, plus a tiny natural
 * moon. Checks, from real framebuffer pixels:
 *   - with glyphs OFF the spacecraft's position is a near-black dot (the bug);
 *   - with glyphs ON its position is a bright, distinct point at every zoom
 *     from far wide view to the resolved model — no dead zone;
 *   - selected/tracked add a ring; resolved bodies keep no glyph or ring;
 *   - hover/selection state is coordinated with the label anchor.
 * Screenshots land in work/position-glyphs/ for human inspection.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5173/';
const catalog = {
  name: 'Position glyph reference',
  items: [
    { name: 'Sun', class: 'star', trajectory: { type: 'FixedPoint', position: [-7.8e8, 0, 0] }, geometry: { type: 'Globe', radius: 695000 } },
    { name: 'Jupiter', class: 'planet', trajectory: { type: 'FixedPoint', position: [0, 0, 0] },
      geometry: { type: 'Globe', radii: [71492, 71492, 66854] }, label: { color: [0.9, 0.7, 0.4] },
      items: [
        { name: 'Europa', class: 'moon', center: 'Jupiter', trajectory: { type: 'FixedPoint', position: [671000, 0, 0] },
          geometry: { type: 'Globe', radius: 1560.8 }, label: { color: [0.85, 0.88, 1] } },
        { name: 'Tiny', class: 'moon', center: 'Jupiter', trajectory: { type: 'FixedPoint', position: [671000, 9000, 4000] },
          geometry: { type: 'Globe', radius: 4 }, label: { color: [0.8, 0.8, 0.8] } },
        { name: 'Europa Clipper', class: 'spacecraft', center: 'Jupiter',
          trajectory: { type: 'FixedPoint', position: [671000, 0, 2600] },
          geometry: { type: 'Mesh', source: 'models/clipper_spacecraft.glb', size: 0.01 }, label: { color: [1, 1, 1] } },
      ] },
  ],
};

/** A small bus with two long solar wings, as binary glTF (the repo's real model is a Git LFS asset). */
function spacecraftGlb() {
  const boxes = [[-1.5, 1.5, -1.5, 1.5, -1.5, 1.5], [1.5, 12, -0.05, 0.05, -2.5, 2.5], [-12, -1.5, -0.05, 0.05, -2.5, 2.5]];
  const positions = []; const indices = [];
  for (const [x0, x1, y0, y1, z0, z1] of boxes) {
    const base = positions.length / 3;
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) positions.push(x, y, z);
    for (const [a, b, c] of [[0,1,3],[0,3,2],[4,6,7],[4,7,5],[0,4,5],[0,5,1],[2,3,7],[2,7,6],[0,2,6],[0,6,4],[1,5,7],[1,7,3]]) indices.push(base + a, base + b, base + c);
  }
  const pos = Buffer.from(new Float32Array(positions).buffer);
  const idx = Buffer.from(new Uint16Array(indices).buffer);
  const bin = Buffer.concat([pos, idx, Buffer.alloc((4 - (pos.length + idx.length) % 4) % 4)]);
  const json = JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.85, 1], metallicFactor: 0.2 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [-12, -1.5, -2.5], max: [12, 1.5, 2.5] },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length, target: 34962 }, { buffer: 0, byteOffset: pos.length, byteLength: idx.length, target: 34963 }],
    buffers: [{ byteLength: bin.length }],
  });
  const jsonBuf = Buffer.concat([Buffer.from(json), Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const chunk = (type, buf) => { const h = Buffer.alloc(8); h.writeUInt32LE(buf.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, buf]); };
  return Buffer.concat([header, chunk(0x4e4f534a, jsonBuf), chunk(0x004e4942, bin)]);
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/models/clipper_spacecraft.glb', (route) => route.fulfill({
    contentType: 'model/gltf-binary', body: spacecraftGlb() }));
  await page.route('**/glyph-reference.json', (route) => route.fulfill({ json: catalog }));
  await page.goto(new URL('?catalog=glyph-reference&test=1', base).href, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const source = await (await fetch('/src/lib/commands.ts')).text();
    const stateURL = source.match(/from ["']([^"']*viewer-state\.svelte[^"']*)["']/)?.[1];
    window.glyphState = await import(stateURL ?? '/src/lib/viewer-state.svelte.ts');
  });
  await page.waitForFunction(() => {
    const { getRenderer, vs } = window.glyphState;
    const r = getRenderer();
    return vs.sceneLoaded && vs.assetsReady && r?.getBodyMesh('Europa Clipper')?.hasModel;
  }, null, { timeout: 60000 });

  mkdirSync('work/position-glyphs', { recursive: true });
  const sweep = [];
  // Radii (px) at which the model's own projected radius is, as the camera closes in.
  for (const distanceKm of [60000, 6000, 1200, 600, 300, 150, 60, 20, 6, 2, 0.6, 0.15, 0.04, 0.01]) {
    const info = await page.evaluate(async ({ distanceKm }) => {
      const { getRenderer, setDisplayOption } = window.glyphState;
      const r = getRenderer();
      const sc = r.getBodyMesh('Europa Clipper');
      window.cosmo.setPlaying(false);
      setDisplayOption('trajectories', false, { persist: false });
      r.cameraController.controls.enableDamping = false;
      r.camera.fov = 50; r.camera.updateProjectionMatrix();
      const frame = async () => { r.renderFrame(); await new Promise(requestAnimationFrame); r.renderFrame(); };
      r.cameraController.controls.target.copy(sc.position);
      r.camera.up.set(0, 1, 0);
      r.camera.position.copy(sc.position).add({ x: distanceKm * r.scaleFactor, y: distanceKm * 0.3 * r.scaleFactor, z: 0 });
      r.camera.lookAt(sc.position); r.camera.updateMatrixWorld(true);
      const gl = r.renderer.getContext();
      const lum = (x, y) => { const p = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]; };
      const dpr = r.renderer.getPixelRatio();
      const patch = (a) => { // brightest vs median luminance in a 15x15 patch around the anchor
        const cx = Math.round(a.x * dpr), cy = Math.round((r.renderer.domElement.clientHeight - a.y) * dpr);
        const v = []; for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) v.push(lum(cx + dx, cy + dy));
        v.sort((p, q) => p - q); return { max: v[v.length - 1], median: v[v.length >> 1] };
      };
      const measure = async (enabled) => {
        r.setPositionGlyphsEnabled(enabled); await frame();
        const g = r.getPositionGlyphReadout().find((e) => e.name === 'Europa Clipper');
        const a = g?.anchor ?? (() => { const v = sc.position.clone().project(r.camera);
          return { x: (v.x * 0.5 + 0.5) * r.renderer.domElement.clientWidth, y: (-v.y * 0.5 + 0.5) * r.renderer.domElement.clientHeight }; })();
        return { glyph: g ?? null, ...patch(a) };
      };
      const off = await measure(false);
      const on = await measure(true);
      return { distanceKm, modelVisible: sc.isModelVisible, off, on };
    }, { distanceKm });
    sweep.push(info);
    await page.screenshot({ path: `work/position-glyphs/zoom-${String(distanceKm).replace('.', '_')}km.png` });
    console.log(`${String(info.distanceKm).padStart(8)} km  glyph=${info.on.glyph ? info.on.glyph.glyphWeight.toFixed(2) : 'none'}  extent=${info.on.glyph?.extentPx.toFixed(1) ?? '-'}px  ` +
      `off(max/med)=${info.off.max.toFixed(0)}/${info.off.median.toFixed(0)}  on(max/med)=${info.on.max.toFixed(0)}/${info.on.median.toFixed(0)}`);
  }
  // Wide view: glyph ON makes the position a bright point against the dark sky; OFF it is not.
  const wide = sweep[0];
  assert.ok(wide.on.glyph && wide.on.glyph.glyphWeight === 1, 'wide view: glyph drawn');
  assert.ok(wide.on.max - wide.on.median > 120, `wide view: glyph must stand out (${JSON.stringify(wide.on)})`);
  assert.ok(wide.off.max - wide.off.median < wide.on.max - wide.on.median, 'glyph must improve on the lit placeholder');
  // No dead zone: whenever the glyph is drawn or the model is not yet visible, the
  // position remains distinct from its surroundings.
  for (const s of sweep) {
    if (s.on.glyph && s.on.glyph.glyphWeight >= 0.5) assert.ok(s.on.max - s.on.median > 60, `no dead zone at ${s.distanceKm} km: ${JSON.stringify(s.on)}`);
  }
  // Resolved: no glyph left at the closest zoom.
  assert.equal(sweep.at(-1).on.glyph, null, 'resolved model keeps no glyph');

  // Selected / tracked / hover rings, label-coordinated, in the wide view.
  const states = await page.evaluate(async () => {
    const { getRenderer, setDisplayOption } = window.glyphState;
    const r = getRenderer(); const sc = r.getBodyMesh('Europa Clipper');
    setDisplayOption('labels', true, { persist: false });
    r.camera.position.copy(sc.position).add({ x: 60000 * r.scaleFactor, y: 18000 * r.scaleFactor, z: 0 });
    r.camera.lookAt(sc.position); r.camera.updateMatrixWorld(true);
    const frame = async () => { r.renderFrame(); await new Promise(requestAnimationFrame); r.renderFrame(); };
    const ring = async () => { await frame(); return r.getPositionGlyphReadout().find((e) => e.name === 'Europa Clipper')?.ring; };
    const out = { rest: await ring() };
    r.setLabelPinned('Europa Clipper', true); out.selected = await ring();
    window.cosmo.track?.('Europa Clipper'); out.tracked = await ring();
    return out;
  });
  console.log('ring states', JSON.stringify(states));
  assert.equal(states.rest, 'none'); assert.equal(states.selected, 'selected'); assert.equal(states.tracked, 'tracked');
  await page.screenshot({ path: 'work/position-glyphs/wide-tracked.png' });

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('position glyph acceptance: OK (screenshots in work/position-glyphs/)');
} finally { await browser.close(); }
