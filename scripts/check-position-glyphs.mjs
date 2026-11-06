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
        // Directly behind Europa from the wide-view camera: its glyph is depth-hidden,
        // so it must not be pickable either.
        { name: 'Hidden Probe', class: 'spacecraft', center: 'Jupiter', trajectory: { type: 'FixedPoint', position: [668000, 0, 0] },
          geometry: { type: 'Mesh', source: 'models/clipper_spacecraft.glb', size: 0.01 }, label: { color: [1, 1, 1] } },
        // Surface-locked assets on Europa's near and far side. (No terrain data is
        // needed: the parent's globe is the occluder.)
        { name: 'Rover Near', class: 'spacecraft', center: 'Jupiter', trajectory: { type: 'FixedPoint', position: [672560.8, 0, 0] },
          geometry: { type: 'Mesh', source: 'models/clipper_spacecraft.glb', size: 0.002, surfaceLock: true }, label: { color: [1, 1, 1] } },
        { name: 'Rover Far', class: 'spacecraft', center: 'Jupiter', trajectory: { type: 'FixedPoint', position: [669439.2, 0, 0] },
          geometry: { type: 'Mesh', source: 'models/clipper_spacecraft.glb', size: 0.002, surfaceLock: true }, label: { color: [1, 1, 1] } },
        // An artificial entity alone in the frame: its label is never culled, so it is the
        // subject of the label-coordinated LOD checks.
        { name: 'Lone Probe', class: 'spacecraft', center: 'Jupiter', trajectory: { type: 'FixedPoint', position: [671000, 30000, -4000] },
          geometry: { type: 'Mesh', source: 'models/clipper_spacecraft.glb', size: 0.01 }, label: { color: [1, 1, 1] } },
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
      const frame = async (n = 30) => { for (let i = 0; i < n; i++) r.renderFrame(); await new Promise(requestAnimationFrame); r.renderFrame(); };
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
        r.setPositionGlyphsEnabled(enabled); await frame(enabled ? 40 : 2);
        const g = r.getPositionGlyphReadout().find((e) => e.name === 'Europa Clipper');
        const a = g?.anchor ?? (() => { const v = sc.position.clone().project(r.camera);
          return { x: (v.x * 0.5 + 0.5) * r.renderer.domElement.clientWidth, y: (-v.y * 0.5 + 0.5) * r.renderer.domElement.clientHeight }; })();
        return { glyph: g ?? null, ...patch(a) };
      };
      const off = await measure(false);
      const on = await measure(true);
      // The same view with Clipper selected/tracked: focus keeps the locator (and its label)
      // regardless of label decluttering.
      r.setLabelPinned('Europa Clipper', true);
      const focus = await measure(true);
      r.setLabelPinned('Europa Clipper', false);
      await frame(30);
      return { distanceKm, modelVisible: sc.isModelVisible, off, on, focus, lab: r.labelManager?.getLabelState('Europa Clipper') };
    }, { distanceKm });
    sweep.push(info);
    await page.screenshot({ path: `work/position-glyphs/zoom-${String(distanceKm).replace('.', '_')}km.png` });
    console.log(`${String(info.distanceKm).padStart(8)} km  glyph=${info.on.glyph ? info.on.glyph.glyphWeight.toFixed(2) : 'none'}  extent=${info.on.glyph?.extentPx.toFixed(1) ?? '-'}px  ` +
      `off(max/med)=${info.off.max.toFixed(0)}/${info.off.median.toFixed(0)}  on(max/med)=${info.on.max.toFixed(0)}/${info.on.median.toFixed(0)}`);
  }
  // Wide view: for the selected/tracked spacecraft, the glyph makes the position a bright
  // point against the dark sky where the legacy fallback drew nothing.
  const wide = sweep[0];
  assert.ok(wide.focus.glyph && wide.focus.glyph.glyphWeight === 1, 'wide view: selected spacecraft keeps its locator');
  assert.ok(wide.focus.max - wide.focus.median > 120, `wide view: glyph must stand out (${JSON.stringify(wide.focus)})`);
  assert.ok(wide.off.max - wide.off.median < wide.focus.max - wide.focus.median, 'glyph must improve on the legacy fallback');
  // Ordinary entities: a marker never outlives its label (no orphaned dots), and an
  // unresolved entity with a legible label has one.
  for (const s of sweep) {
    if (s.on.glyph) assert.ok(s.lab.legible, `marker without a legible label at ${s.distanceKm} km`);
    if (s.lab.legible && s.distanceKm >= 2) assert.ok(s.on.glyph, `unresolved entity with a legible label has its marker at ${s.distanceKm} km`);
  }
  assert.ok(sweep.some((s) => !s.lab.legible && !s.on.glyph), 'the sweep exercises a culled label with no marker');
  // No dead zone: whenever the (focus) glyph is drawn, the position stays distinct from its surroundings.
  for (const s of sweep) {
    if (s.focus.glyph && s.focus.glyph.glyphWeight >= 0.5) assert.ok(s.focus.max - s.focus.median > 60, `no dead zone at ${s.distanceKm} km: ${JSON.stringify(s.focus)}`);
  }
  // Resolved: no glyph left at the closest zoom.
  assert.equal(sweep.at(-1).on.glyph, null, 'resolved model keeps no glyph');
  assert.equal(sweep.at(-1).focus.glyph, null, 'resolved model keeps no ring either, even when selected');

  // Selected / tracked / hover rings, label-coordinated, in the wide view.
  const states = await page.evaluate(async () => {
    const { getRenderer, setDisplayOption } = window.glyphState;
    const r = getRenderer(); const sc = r.getBodyMesh('Europa Clipper');
    setDisplayOption('labels', true, { persist: false });
    window.cosmo.untrack();
    r.camera.position.copy(sc.position).add({ x: 60000 * r.scaleFactor, y: 18000 * r.scaleFactor, z: 0 });
    r.camera.lookAt(sc.position); r.camera.updateMatrixWorld(true);
    const frame = async (n = 30) => { for (let i = 0; i < n; i++) r.renderFrame(); await new Promise(requestAnimationFrame); r.renderFrame(); };
    const entry = async (name = 'Europa Clipper') => { await frame(); return r.getPositionGlyphReadout().find((e) => e.name === name); };
    const rest = await entry(); // an ordinary entity whose label is culled has no marker at all
    const out = { rest: rest ? rest.ring : 'none' };
    // Hover alone must never read as selection (it temporarily pins the label).
    r.setHoveredBody('Europa Clipper'); const hov = await entry();
    out.hoverRing = hov.ring; out.hovered = hov.hovered; r.setHoveredBody(null);
    r.setLabelPinned('Europa Clipper', true); out.selected = (await entry()).ring;
    window.cosmo.track?.('Europa Clipper'); out.tracked = (await entry()).ring;
    window.cosmo.untrack(); r.setLabelPinned('Europa Clipper', false);
    r.camera.position.copy(sc.position).add({ x: 60000 * r.scaleFactor, y: 18000 * r.scaleFactor, z: 0 });
    r.camera.lookAt(sc.position); r.camera.updateMatrixWorld(true); await frame();

    // Picking: a glyph hidden behind Europa must not be pickable; visible ones are,
    // including a surface-locked asset on the near side but not one on the far side.
    for (const n of ['Europa Clipper', 'Hidden Probe', 'Rover Near', 'Rover Far']) r.setLabelPinned(n, true); // focus: markers drawn regardless of label decluttering
    const pick = async (name) => {
      const e = await entry(name);
      if (!e?.anchor) return { anchor: null };
      const hit = r.pickScene(e.anchor.x, e.anchor.y, 'select', { labelSlopPx: 0 });
      return { anchor: e.anchor, hit: hit?.kind === 'entity' ? hit.bodyName : (hit?.kind ?? null) };
    };
    out.pickVisible = (await pick('Europa Clipper')).hit;
    out.pickHidden = (await pick('Hidden Probe')).hit;
    out.pickRoverNear = (await pick('Rover Near')).hit;
    out.pickRoverFar = (await pick('Rover Far')).hit;
    for (const n of ['Hidden Probe', 'Rover Near', 'Rover Far']) r.setLabelPinned(n, false);
    r.setLabelPinned('Europa Clipper', false);

    // The glyph replaces the legacy lit minimum-size placeholder sphere (the library
    // default, minBodyPixels = 4); with glyphs off it is restored. The viewer app
    // itself passes minBodyPixels = 0, where nothing is drawn for a tiny model body
    // and a globe renders at its real size: glyphs must not change that.
    const tiny = r.getBodyMesh('Tiny');
    const vis = () => ({ clipper: sc.mesh.visible, tiny: tiny.mesh.visible });
    const appMinBodyPixels = r.minBodyPixels;
    r.minBodyPixels = 4;
    await frame();
    // Real mesh scale at the library default: a natural body is never inflated to the
    // minimum marker size (ratio 1 = real projected size); only an artificial placeholder is.
    const realScale = (b) => b.mesh.scale.x / (r.scaleFactor * b.ellipsoidRatios[0]);
    out.scale = { naturalTiny: realScale(tiny), naturalEuropa: realScale(r.getBodyMesh('Europa')), naturalJupiter: realScale(r.getBodyMesh('Jupiter')) };
    out.placeholderOn = { ...vis(), europa: r.getBodyMesh('Europa').mesh.visible };
    r.setPositionGlyphsEnabled(false); await frame(); out.placeholderOff = vis();
    out.scale.artificialClipperGlyphsOff = realScale(sc); // legacy artificial placeholder keeps its floor
    r.setPositionGlyphsEnabled(true); await frame(); out.placeholderBack = vis();
    r.minBodyPixels = 0; await frame(); out.appDefault = vis();
    r.setPositionGlyphsEnabled(false); await frame(); out.appDefaultGlyphsOff = vis();
    r.setPositionGlyphsEnabled(true); r.minBodyPixels = appMinBodyPixels; await frame();

    // --- Label-coordinated LOD (live-testing feedback) ---
    const ring2 = async (name = 'Europa Clipper') => { await frame(); return r.getPositionGlyphReadout().find((e) => e.name === name) ?? null; };
    out.lod = {};
    out.lod.ordinaryWithLabel = !!(await ring2('Lone Probe'));
    r.setLabelVisible('Lone Probe', false);                       // label deliberately gone ...
    out.lod.ordinaryNoLabel = (await ring2('Lone Probe')) !== null; // ... so the marker goes too
    r.setLabelVisible('Lone Probe', true);
    out.lod.ordinaryBack = (await ring2('Lone Probe')) !== null;
    // Natural bodies: no filled point, ever, in ordinary view; a hollow ring only when focused.
    out.lod.naturalOrdinary = ['Tiny', 'Europa', 'Jupiter'].map((n) => r.getPositionGlyphReadout().some((e) => e.name === n));
    r.setLabelPinned('Tiny', true);
    const tinyFocus = await ring2('Tiny');
    out.lod.naturalFocus = tinyFocus ? { ring: tinyFocus.ring, footprint: tinyFocus.footprintPx } : null;
    r.setLabelPinned('Tiny', false);
    r.setLabelVisible('Europa Clipper', false);              // focus keeps its locator ...
    r.setLabelPinned('Europa Clipper', true);
    out.lod.focusNoLabelRing = (await ring2())?.ring ?? null;
    r.setLabelPinned('Europa Clipper', false);
    r.setLabelVisible('Europa Clipper', true);
    window.glyphState.setDisplayOption('labels', false, { persist: false }); // all labels off:
    await frame();
    out.lod.allLabelsOffOrdinary = r.getPositionGlyphReadout().filter((e) => e.ring === 'none').length;
    r.setLabelPinned('Europa Clipper', true);
    out.lod.allLabelsOffFocus = (await ring2())?.ring ?? null;  // selected entity keeps its locator
    r.setLabelPinned('Europa Clipper', false);
    window.glyphState.setDisplayOption('labels', true, { persist: false });
    await frame();

    // --- Whole-glyph terrain/plate occlusion ---
    // A reconstructed-surface plate between the camera and the selected spacecraft's
    // anchor must hide the whole symbol (dot and ring), and releasing it brings it back.
    r.setLabelVisible('Lone Probe', false); // keep the only drawn glyph in this section the one under test
    r.setLabelPinned('Europa Clipper', true);
    out.occ = { before: (await ring2())?.occluded ?? null };
    const rover = r.getBodyMesh('Rover Near');
    const V3 = r.camera.position.constructor, M4 = r.camera.matrixWorld.constructor, Q = r.camera.quaternion.constructor;
    const plate = r.getBodyMesh('Europa').mesh.clone();
    plate.userData.dskSurface = true; plate.matrixAutoUpdate = false;
    const mid = r.camera.position.clone().add(sc.position.clone().sub(r.camera.position).multiplyScalar(0.5));
    const radius = 3000 * r.scaleFactor / 1560.8;
    rover.modelContainer.updateWorldMatrix(true, false);
    plate.matrix.copy(new M4().copy(rover.modelContainer.matrixWorld).invert()
      .multiply(new M4().compose(mid, new Q(), new V3(radius, radius, radius))));
    rover.modelContainer.add(plate);
    await frame(2); r.renderFrame();
    const during = await ring2();
    const sprites = r.positionGlyphs.group.children.filter((o) => o.visible);
    out.occ.during = { occluded: during?.occluded ?? null, visibility: during?.visibility ?? null, drawnSprites: sprites.length, drawn: r.getPositionGlyphReadout().filter((e) => e.visibility > 0.003).map((e) => `${e.name}:${e.visibility.toFixed(3)}:${e.ring}`) };
    out.occ.pickDuring = (() => { const a = during?.anchor; return a ? r.pickScene(a.x, a.y, 'select', { labelSlopPx: 0 })?.bodyName ?? null : null; })();
    rover.modelContainer.remove(plate);
    out.occ.after = (await ring2())?.occluded ?? null;
    r.setLabelPinned('Europa Clipper', false);
    r.setLabelVisible('Lone Probe', true);
    return out;
  });
  console.log('states', JSON.stringify(states));
  assert.equal(states.rest, 'none'); assert.equal(states.hoverRing, 'none', 'hover must not draw a selected ring');
  assert.equal(states.hovered, true);
  assert.equal(states.selected, 'selected'); assert.equal(states.tracked, 'tracked');
  assert.equal(states.pickVisible, 'Europa Clipper');
  assert.notEqual(states.pickHidden, 'Hidden Probe', 'glyph behind Europa must not be pickable');
  assert.equal(states.pickRoverNear, 'Rover Near', 'surface-locked asset on the visible side stays pickable');
  assert.notEqual(states.pickRoverFar, 'Rover Far', 'surface-locked asset on the far side is occluded by its parent');
  for (const [name, ratio] of Object.entries({ naturalTiny: states.scale.naturalTiny, naturalEuropa: states.scale.naturalEuropa, naturalJupiter: states.scale.naturalJupiter })) {
    assert.ok(Math.abs(ratio - 1) < 1e-9, `${name} must render at its real projected size at minBodyPixels 4 (mesh scale ratio ${ratio})`);
  }
  assert.ok(states.scale.artificialClipperGlyphsOff > 1000, 'an artificial placeholder keeps its minimum-size floor (only natural bodies are exempt)');
  assert.deepEqual(states.placeholderOn, { clipper: false, tiny: true, europa: true }, 'glyph replaces the lit placeholder for unresolved artificial bodies only; natural bodies keep their real-scale rendering');
  assert.deepEqual(states.placeholderOff, { clipper: true, tiny: true }, 'legacy placeholder returns when glyphs are disabled');
  assert.deepEqual(states.placeholderBack, { clipper: false, tiny: true });
  assert.deepEqual(states.appDefault, states.appDefaultGlyphsOff, 'with minBodyPixels 0 the glyph changes no placeholder state');
  // Label-coordinated LOD: no marker without the label that explains it; focus overrides.
  assert.equal(states.lod.ordinaryWithLabel, true, 'a labelled ordinary spacecraft shows its marker');
  assert.equal(states.lod.ordinaryNoLabel, false, 'an ordinary entity whose label is gone has no marker');
  assert.deepEqual(states.lod.naturalOrdinary, [false, false, false], 'natural bodies get no filled point in ordinary view');
  assert.equal(states.lod.naturalFocus?.ring, 'selected', 'a selected natural body gets a hollow ring');
  assert.ok(states.lod.naturalFocus.footprint >= 8, 'the natural-body locator is the ring, not a dot');
  assert.equal(states.lod.ordinaryBack, true, 'the marker returns with its label');
  assert.equal(states.lod.focusNoLabelRing, 'selected', 'a selected entity keeps its locator even without a label');
  assert.equal(states.lod.allLabelsOffOrdinary, 0, 'with labels disabled, no unexplained markers on ordinary entities');
  assert.equal(states.lod.allLabelsOffFocus, 'selected', 'with labels disabled, the selected entity keeps its locator');
  // Whole-glyph occlusion by a plate in front of the anchor.
  assert.equal(states.occ.before, false);
  assert.equal(states.occ.during.occluded, true, 'plate in front of the anchor hides the glyph');
  assert.equal(states.occ.during.drawnSprites, 0, 'no part (dot or ring) of an occluded glyph is drawn');
  assert.notEqual(states.occ.pickDuring, 'Europa Clipper', 'an occluded glyph is not pickable');
  assert.equal(states.occ.after, false, 'the glyph returns when the plate is gone');
  await page.screenshot({ path: 'work/position-glyphs/wide-tracked.png' });

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('position glyph acceptance: OK (screenshots in work/position-glyphs/)');
} finally { await browser.close(); }
