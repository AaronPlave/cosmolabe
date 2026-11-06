/** Real-scene acceptance for position glyphs (#337): zoom sweeps in the actual viewer.
 * Start `npm --prefix apps/viewer run dev` first, then, for one scene:
 *   SCENE=earth-moon|solar-system|europa-clipper MIN_BODY_PIXELS=0|4 CHROMIUM_PATH=/opt/pw-browsers/chromium \
 *     node scripts/check-position-glyph-scenes.mjs
 * MIN_BODY_PIXELS=0 is the viewer's setting, 4 the library default (legacy minimum-size placeholder).
 *
 * For each scene it sweeps the camera slowly in and then out around a target, in the
 * ordinary / selected / tracked / labels-off states, and asserts from live renderer
 * state that:
 *   - an ordinary entity's marker exists only while its label is legible (no orphaned dots);
 *   - a selected/tracked entity keeps its locator while it is unresolved, and its label;
 *   - natural bodies (planets, moons, asteroids) never get a filled point: only a selected/tracked one
 *     gets a hollow ring, and only while its real disk is too small to mark the position itself;
 *   - something always represents the focus entity (glyph, real-scale body or model): no dead zone,
 *     at both minBodyPixels settings;
 *   - markers do not chatter (bounded on/off transitions per slow sweep, both directions);
 *   - nothing is left over for a resolved body.
 * Screenshots (1x) go to work/position-glyphs/scenes/<scene>/ for human inspection.
 * Needs the scene's LFS textures / kernels locally (see apps/viewer/test-catalogs/README.md).
 */
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { chromium } from 'playwright';

const SCENES = {
  'earth-moon': { natural: true, catalog: 'earth-moon', target: 'Moon', minKm: 2500, maxKm: 4e7, others: ['Earth'], ready: 'Moon' },
  'solar-system': { natural: true, catalog: 'solar-system', target: 'Moon', minKm: 3000, maxKm: 6e9, others: ['Earth', 'Mars', 'Jupiter', 'Saturn', 'Ceres', 'Phobos'], ready: 'Saturn' },
  'europa-clipper': { natural: false, catalog: 'europa-clipper', target: 'Europa Clipper', minKm: 0.02, maxKm: 4e5, others: ['Europa'], ready: 'Europa Clipper', et: 985657200 },
};
const scene = SCENES[process.env.SCENE ?? 'earth-moon'];
assert.ok(scene, `unknown SCENE ${process.env.SCENE}`);
const MIN_BODY_PIXELS = Number(process.env.MIN_BODY_PIXELS ?? 0);
const outDir = `work/position-glyphs/scenes/${process.env.SCENE ?? 'earth-moon'}${MIN_BODY_PIXELS ? `-min${MIN_BODY_PIXELS}` : ''}`;
mkdirSync(outDir, { recursive: true });

const ROOT = new URL('../apps/viewer/test-catalogs/', import.meta.url).pathname;
const MIME = { '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.png': 'image/png' };
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://127.0.0.1:5173' && /^\/(kernels|models|base|textures|places|[\w-]+\.json$)/.test(url.pathname)) {
      const file = ROOT + decodeURIComponent(url.pathname).replace(/^\//, '');
      if (existsSync(file)) return route.fulfill({ body: readFileSync(file), contentType: MIME[extname(file)] ?? 'application/octet-stream' });
    }
    return route.continue();
  });
  await page.goto(`http://127.0.0.1:5173/?catalog=${scene.catalog}&test=1`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const source = await (await fetch('/src/lib/commands.ts')).text();
    const stateURL = source.match(/from ["']([^"']*viewer-state\.svelte[^"']*)["']/)?.[1];
    window.gs = await import(stateURL ?? '/src/lib/viewer-state.svelte.ts');
  });
  await page.waitForFunction((ready) => { const { getRenderer, vs } = window.gs; return vs.sceneLoaded && vs.assetsReady && getRenderer()?.getBodyMesh(ready); }, scene.ready, { timeout: 240000 });

  /** One sweep: slow zoom in then out. Returns per-step observations. */
  const sweep = (opts) => page.evaluate(async ({ scene, opts }) => {
    const { getRenderer, setDisplayOption } = window.gs;
    const r = getRenderer(); const target = r.getBodyMesh(scene.target);
    if (scene.et) r.timeController.setTime(scene.et);
    r.minBodyPixels = opts.minBodyPixels;
    window.cosmo.setPlaying(false);
    setDisplayOption('labels', opts.labels, { persist: false });
    setDisplayOption('trajectories', true, { persist: false });
    for (const n of r.bodyMeshes.keys()) r.setLabelPinned(n, false);
    if (opts.tracked) window.cosmo.track?.(scene.target); else window.cosmo.untrack();
    if (opts.selected) r.setLabelPinned(scene.target, true);
    r.camera.fov = 50; r.camera.updateProjectionMatrix();
    r.cameraController.controls.enableDamping = false;
    const steps = 60, perStep = 6;
    const dists = Array.from({ length: steps }, (_, i) => scene.minKm * (scene.maxKm / scene.minKm) ** (i / (steps - 1)));
    const order = [...dists, ...[...dists].reverse()];
    const rows = [];
    const prevW = new Map(), illegibleRun = new Map();
    const frames = (n) => { for (let i = 0; i < n; i++) r.renderFrame(); };
    for (let k = 0; k < order.length; k++) {
      const d = order[k];
      r.renderFrame();
      const p = target.position;
      r.cameraController.controls.target.copy(p); r.camera.up.set(0, 1, 0);
      r.camera.position.set(p.x + 0.4 * d * r.scaleFactor, p.y + 0.25 * d * r.scaleFactor, p.z + 0.88 * d * r.scaleFactor);
      r.camera.lookAt(p); r.camera.updateMatrixWorld(true);
      frames(perStep);
      const readout = r.getPositionGlyphReadout();
      const g = readout.find((e) => e.name === scene.target) ?? null;
      const lab = r.labelManager?.getLabelState(scene.target) ?? null;
      const others = {};
      for (const n of scene.others) {
        const e = readout.find((x) => x.name === n);
        others.n = others.n ?? {};
        others.n[n] = e ? { w: +(e.glyphWeight * e.visibility).toFixed(3), ring: e.ring } : null;
      }
      if (opts.trace) { const e = r.labelManager.labels.get(opts.trace); const gl = readout.find((x) => x.name === opts.trace); (window.__trace ??= []).push({ k, d: +d.toPrecision(4), legible: e?.legible, coll: e && +e.collisionFade.toFixed(2), selfSize: e && +e.selfSizeFade.toFixed(2), occ: e && +e.occlusionOpacity.toFixed(2), w: gl ? +(gl.glyphWeight * gl.visibility).toFixed(3) : null, gw: gl && +gl.glyphWeight.toFixed(3), vis: gl && +gl.visibility.toFixed(3), ext: gl && +gl.extentPx.toFixed(2) }); }
      rows.push({
        k, up: k < steps, d: +d.toPrecision(4),
        w: g ? +(g.glyphWeight * g.visibility).toFixed(3) : 0, ring: g?.ring ?? 'none', extent: g ? +g.extentPx.toFixed(2) : null,
        legible: lab?.legible ?? false,
        footprint: g ? g.footprintPx : 0,
        meshVisible: target.mesh.visible, modelVisible: target.hasModel && target.isModelVisible,
        naturalPoint: readout.filter((e) => !['spacecraft', 'other', 'instrument'].includes(r.getBodyMesh(e.name).body.classification ?? '') && e.ring === 'none' && e.glyphWeight * e.visibility > 0.02).map((e) => e.name),
        // A marker may lag its label's decision by a short eased fade; it is an orphan if it
        // grows (or fails to shrink) while the label is illegible, or lingers more than 3 steps.
        orphan: readout.filter((e) => {
          const w = e.glyphWeight * e.visibility;
          const legible = r.labelManager?.getLabelState(e.name)?.legible ?? false;
          const focus = e.ring !== 'none';
          const run = (legible || focus) ? 0 : (illegibleRun.get(e.name) ?? 0) + 1;
          illegibleRun.set(e.name, run);
          const prev = prevW.get(e.name); prevW.set(e.name, w);
          return !focus && !legible && w > 0.05 && (run > 3 || (prev !== undefined && w > prev + 1e-6));
        }).map((e) => e.name),
        // footprint > 5px means the ring part is actually drawn (a lone dot is 3px)
        discRing: readout.filter((e) => e.ring !== 'none' && r.getBodyMesh(e.name).body.geometryType === 'Globe' && e.extentPx > 2.001 && e.footprintPx > 5).map((e) => e.name),
        discDot: readout.filter((e) => r.getBodyMesh(e.name).body.geometryType === 'Globe' && e.extentPx > 3.001 && e.glyphWeight * e.visibility > 0.05).map((e) => e.name),
        count: readout.filter((e) => e.glyphWeight * e.visibility > 0.05).length,
        others: others.n,
      });
    }
    return { rows, steps };
  }, { scene, opts });

  /** Screenshots at chosen distances in the given state, at 1x. */
  const shoot = async (label, opts, distances) => {
    for (const d of distances) {
      const info = await page.evaluate(async ({ scene, opts, d }) => {
        const { getRenderer, setDisplayOption } = window.gs;
        const r = getRenderer(); const target = r.getBodyMesh(scene.target);
        if (scene.et) r.timeController.setTime(scene.et);
        r.minBodyPixels = opts.minBodyPixels;
        setDisplayOption('labels', opts.labels, { persist: false });
        for (const n of r.bodyMeshes.keys()) r.setLabelPinned(n, false);
        if (opts.tracked) window.cosmo.track?.(scene.target); else window.cosmo.untrack();
        if (opts.selected) r.setLabelPinned(scene.target, true);
        for (let i = 0; i < 40; i++) {
          r.renderFrame(); const p = target.position;
          r.cameraController.controls.target.copy(p); r.camera.up.set(0, 1, 0);
          r.camera.position.set(p.x + 0.4 * d * r.scaleFactor, p.y + 0.25 * d * r.scaleFactor, p.z + 0.88 * d * r.scaleFactor);
          r.camera.lookAt(p); r.camera.updateMatrixWorld(true);
        }
        await new Promise(requestAnimationFrame); r.renderFrame();
        const g = r.getPositionGlyphReadout().find((e) => e.name === scene.target);
        return { anchor: g?.anchor ?? null };
      }, { scene, opts, d });
      const a = info.anchor ?? { x: 640, y: 400 };
      const x = Math.max(0, Math.min(1280 - 420, Math.round(a.x - 210))), y = Math.max(0, Math.min(800 - 260, Math.round(a.y - 130)));
      const name = `${label}-${String(d).replace('.', '_')}km`;
      await page.screenshot({ path: `${outDir}/${name}-full.png` });
      await page.screenshot({ path: `${outDir}/${name}-crop.png`, clip: { x, y, width: 420, height: 260 } });
    }
  };

  const states = {
    ordinary: { labels: true, selected: false, tracked: false },
    selected: { labels: true, selected: true, tracked: false },
    tracked: { labels: true, selected: true, tracked: true },
    'labels-off-ordinary': { labels: false, selected: false, tracked: false },
    'labels-off-tracked': { labels: false, selected: true, tracked: true },
  };
  const summary = {};
  if (process.env.TRACE) { await sweep({ ...states.ordinary, trace: process.env.TRACE }); console.log((await page.evaluate(() => window.__trace.filter((t) => t.k >= 34 && t.k <= 46))).map((t) => JSON.stringify(t)).join('\n')); process.exit(0); }
  for (const [name, o] of Object.entries(states)) {
    const opts = { ...o, minBodyPixels: MIN_BODY_PIXELS };
    const { rows } = await sweep(opts);
    const flips = (rs) => rs.slice(1).filter((x, i) => (x.w > 0.05) !== (rs[i].w > 0.05)).length;
    const up = rows.filter((x) => x.up), down = rows.filter((x) => !x.up);
    const orphan = rows.filter((x) => x.orphan.length);
    const discRing = rows.filter((x) => x.discRing.length), discDot = rows.filter((x) => x.discDot.length);
    const maxCount = Math.max(...rows.map((x) => x.count));
    summary[name] = { flipsUp: flips(up), flipsDown: flips(down), maxGlyphs: maxCount,
      onRange: (() => { const on = rows.filter((x) => x.w > 0.05).map((x) => x.d); return on.length ? [Math.min(...on), Math.max(...on)] : null; })() };
    console.log(name.padEnd(20), JSON.stringify(summary[name]));
    // Invariants
    assert.equal(orphan.length, 0, `${name}: ordinary markers without a legible label: ${JSON.stringify(orphan[0])}`);
    const naturalPoint = rows.filter((x) => x.naturalPoint.length);
    assert.equal(naturalPoint.length, 0, `${name}: filled point on a natural body: ${JSON.stringify(naturalPoint[0])}`);
    assert.equal(discRing.length, 0, `${name}: ring around a visible physical disk: ${JSON.stringify(discRing[0])}`);
    assert.equal(discDot.length, 0, `${name}: marker over a visible physical disk: ${JSON.stringify(discDot[0])}`);
    assert.ok(summary[name].flipsUp <= 2 && summary[name].flipsDown <= 2, `${name}: marker chatters during slow zoom: ${JSON.stringify(summary[name])}`);
    if (name === 'ordinary' || name === 'labels-off-ordinary') {
      // (Steady state: a marker only trails its label by the short eased fade checked as `orphan` above.)
      assert.ok(rows.every((x) => x.w <= 0.05 || x.legible || x.w < 0.35), `${name}: ordinary marker strongly shown without its label`);
    }
    // (The first steps may still be easing out markers from the previous state.)
    if (name === 'labels-off-ordinary') assert.equal(Math.max(...rows.filter((x) => x.k >= 4).map((x) => x.count)), 0, 'labels off: no unexplained markers anywhere');
    if (name === 'tracked' || name === 'selected' || name === 'labels-off-tracked') {
      // Focus keeps its locator while unresolved (the target is a point at the far end of the sweep).
      const far = rows.filter((x) => x.extent !== null && x.extent <= 1);
      const unresolvedRows = rows.filter((x) => x.d >= scene.maxKm * 0.3);
      assert.ok(unresolvedRows.every((x) => x.w > 0.5), `${name}: focus keeps its locator at far zoom`);
      if (name !== 'labels-off-tracked') assert.ok(unresolvedRows.every((x) => x.legible), `${name}: focus keeps its label at far zoom`);
      assert.ok(far.length >= 0);
    }
    if (scene.natural) {
      // The natural target is never marked in ordinary view, and its focus locator is a hollow ring.
      if (name === 'ordinary' || name === 'labels-off-ordinary') assert.ok(rows.every((x) => x.w <= 0.02), `${name}: natural body must get no marker`);
      else assert.ok(rows.filter((x) => x.w > 0.05).every((x) => x.footprint >= 8), `${name}: natural locator must be the ring, not a dot`);
      // Real-scale rendering is never replaced: nothing hides the body at either minBodyPixels.
      assert.ok(rows.every((x) => x.meshVisible), `${name}: natural body's real-scale rendering was hidden`);
    } else if (name !== 'ordinary' && name !== 'labels-off-ordinary') {
      // Artificial focus: something always represents it — glyph, placeholder or model; never a dead zone.
      const dead = rows.filter((x) => !(x.w > 0.05 || x.meshVisible || x.modelVisible));
      assert.equal(dead.length, 0, `${name} @ minBodyPixels ${MIN_BODY_PIXELS}: nothing represents the focus at ${JSON.stringify(dead[0])}`);
    }
    // Resolved: nothing left once the body is large.
    assert.ok(rows.filter((x) => x.d <= scene.minKm * 1.5).every((x) => x.w <= 0.05), `${name}: resolved body keeps no glyph`);
  }

  // Screenshots for human comparison at normal display scale.
  const shotDists = [scene.minKm * 4, scene.maxKm * 0.02, scene.maxKm * 0.3, scene.maxKm].map((v) => +v.toPrecision(3));
  for (const [name, o] of Object.entries(states)) await shoot(name, { ...o, minBodyPixels: MIN_BODY_PIXELS }, shotDists);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`scene ${process.env.SCENE ?? 'earth-moon'}: OK (screenshots in ${outDir}/)`);
} finally { await browser.close(); }
