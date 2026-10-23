/** GPU cost of the geographic vector pass, over reproducible scenes.
 *
 * Measures whole-frame GPU time with EXT_disjoint_timer_query_webgl2 (not
 * frame intervals), CPU render time, and the vector layer's draw calls, pages
 * and proxy surface meshes, for: vectors off/on, one point, one small polygon,
 * a selected polygon, 200 annotations, dense Jezero, global Earth countries,
 * wide regional polygons over streamed Mars terrain (network), and Jezero on
 * measured terrain when its local data is present.
 *
 * Default: SwiftShader at 1280×720 (fragment work dominates, so it shows how
 * the pass scales with surface coverage, but it is not a hardware number).
 * CL_GPU=hardware runs Chrome with Metal at 1920×1080 CSS × 2 = 3840×2160.
 * Writes JSON and a Markdown table to CL_OUTPUT (default
 * docs/validation/geographic-gpu/<CL_LABEL or "swiftshader">). */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const hardware = process.env.CL_GPU === 'hardware';
const label = process.env.CL_LABEL ?? (hardware ? 'hardware' : 'swiftshader');
const output = process.env.CL_OUTPUT ?? `docs/validation/geographic-gpu/${label}`;
const base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5188/';
const frames = Number(process.env.CL_FRAMES ?? 30);
const browser = await chromium.launch({
  executablePath: process.env.CL_CHROMIUM ?? (hardware ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium'),
  args: hardware ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const BENCH = 'geographic-vectors-gpu-bench';
const polygon = { layerId: 'bench-polygon', featureId: 'string:a1', bodyName: 'Mars' };
/** Each scene: a catalog, a viewpoint, the vector layers shown (others hidden) and an optional selection. */
const scenes = [
  { name: 'Jezero close · vectors off', catalog: BENCH, view: 'Jezero close', show: [] },
  { name: 'Jezero close · one point', catalog: BENCH, view: 'Jezero close', show: ['bench-point'] },
  { name: 'Jezero close · one small polygon', catalog: BENCH, view: 'Jezero close', show: ['bench-polygon'] },
  { name: 'Jezero close · polygon selected', catalog: BENCH, view: 'Jezero close', show: ['bench-polygon'], select: polygon },
  { name: 'Jezero close · 200 annotations', catalog: BENCH, view: 'Jezero close', show: ['bench-many'] },
  { name: 'Mars disk · vectors off', catalog: BENCH, view: 'Mars disk', show: [] },
  { name: 'Mars disk · one small polygon', catalog: BENCH, view: 'Mars disk', show: ['bench-polygon'] },
  { name: 'Mars disk · 200 annotations', catalog: BENCH, view: 'Mars disk', show: ['bench-many'] },
  { name: 'Dense Jezero · vectors off', catalog: 'geographic-vectors-jezero-dense', show: [] },
  { name: 'Dense Jezero · vectors on', catalog: 'geographic-vectors-jezero-dense', show: 'all' },
  { name: 'Earth orbit · vectors off', catalog: 'geographic-vectors-earth-countries', view: 'Earth orbit', show: [] },
  { name: 'Earth orbit · countries', catalog: 'geographic-vectors-earth-countries', view: 'Earth orbit', show: 'all' },
  { name: 'Rhine close · vectors off', catalog: 'geographic-vectors-earth-countries', view: 'Rhine close', show: [] },
  { name: 'Rhine close · countries', catalog: 'geographic-vectors-earth-countries', view: 'Rhine close', show: 'all' },
  // The review's regional case: a few wide polygons and lines over streamed Mars terrain and
  // imagery (network). Residency depends on what has streamed in, so each view settles first.
  { name: 'Gale regional · vectors off', catalog: 'geographic-vectors-mars-streamed', view: 'Gale regional', show: [], settleMs: 15000 },
  { name: 'Gale regional · wide regions', catalog: 'geographic-vectors-mars-streamed', view: 'Gale regional', show: 'all', settleMs: 3000 },
  { name: 'Gale close · vectors off', catalog: 'geographic-vectors-mars-streamed', view: 'Gale close', show: [], settleMs: 20000 },
  { name: 'Gale close · wide regions', catalog: 'geographic-vectors-mars-streamed', view: 'Gale close', show: 'all', settleMs: 3000 },
];
// Measured terrain is local data, not in Git.
if (existsSync('apps/viewer/test-catalogs/data/mars-terrain-fused')) {
  scenes.push(
    { name: 'Jezero terrain · vectors off', catalog: 'geographic-vectors-jezero-terrain', show: [] },
    { name: 'Jezero terrain · vectors on', catalog: 'geographic-vectors-jezero-terrain', show: 'all' },
  );
}

const results = [];
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: hardware ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }, deviceScaleFactor: hardware ? 2 : 1 });
  page.setDefaultTimeout(120_000);
  let loaded = null;
  for (const scene of scenes) {
    if (loaded !== scene.catalog) {
      await page.goto(`${base}?catalog=test-catalogs/${scene.catalog}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.renderer);
      await page.evaluate(() => window.renderer.waitForInitialAssets());
      await page.waitForFunction(() => window.renderer.geographicVectors.featureCount > 0);
      loaded = scene.catalog;
    }
    if (scene.view) await page.evaluate((name) => window.renderer.applyNamedViewpoint(name), scene.view);
    await page.evaluate(({ show, select }) => {
      const r = window.renderer;
      for (const layer of r.universe.geographicLayers.layers) r.geographicVectors.setVisible(layer.id, show === 'all' || show.includes(layer.id));
      r.geographicVectors.setSelected(select ?? null);
      r.geographicVectors.setHovered(null);
    }, { show: scene.show, select: scene.select ?? null });
    await page.mouse.move(2, 2);
    await page.waitForTimeout(scene.settleMs ?? 1500);
    const result = await page.evaluate(async (frames) => {
      const r = window.renderer;
      const gl = r.renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const queries = [], gpu = [], cpu = [];
      let disjoint = false;
      const poll = () => {
        if (ext && gl.getParameter(ext.GPU_DISJOINT_EXT)) disjoint = true;
        for (let i = queries.length - 1; i >= 0; i--) if (gl.getQueryParameter(queries[i], gl.QUERY_RESULT_AVAILABLE)) {
          gpu.push(gl.getQueryParameter(queries[i], gl.QUERY_RESULT) / 1e6); gl.deleteQuery(queries[i]); queries.splice(i, 1);
        }
      };
      const render = r.renderFrame.bind(r);
      let submitted = 0;
      r.renderFrame = (...args) => {
        poll();
        const query = ext && submitted < frames ? gl.createQuery() : null;
        if (query) { gl.beginQuery(ext.TIME_ELAPSED_EXT, query); submitted++; }
        const t = performance.now(); const v = render(...args); cpu.push(performance.now() - t);
        if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); queries.push(query); }
        return v;
      };
      for (let i = 0; i < frames + 5; i++) await new Promise(requestAnimationFrame);
      for (let i = 0; i < 30 && queries.length; i++) { await new Promise(requestAnimationFrame); poll(); }
      r.renderFrame = render;
      for (const q of queries) gl.deleteQuery(q);
      const stats = (a) => { a.sort((x, y) => x - y); return { median: +(a[Math.floor(a.length / 2)] ?? 0).toFixed(2), p95: +(a[Math.floor(a.length * 0.95)] ?? 0).toFixed(2), samples: a.length }; };
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        gpuMs: ext && !disjoint && gpu.length ? stats(gpu) : null, cpuMs: stats(cpu),
        metrics: r.geographicVectors.metrics, features: r.geographicVectors.featureCount,
        resolution: [gl.drawingBufferWidth, gl.drawingBufferHeight], gpu: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
      };
    }, frames);
    results.push({ scene: scene.name, ...result });
    console.log(JSON.stringify(results.at(-1)));
  }
  // Incremental cost: each vectors-on scene against the matching vectors-off scene.
  const offOf = (name) => results.find((r) => r.scene === `${name.split(' · ')[0]} · vectors off`);
  const rows = results.map((r) => {
    const off = offOf(r.scene);
    const extra = r.gpuMs && off?.gpuMs && off !== r ? (r.gpuMs.median - off.gpuMs.median).toFixed(2) : '';
    return `| ${r.scene} | ${r.gpuMs?.median ?? '—'} | ${r.gpuMs?.p95 ?? '—'} | ${extra} | ${r.cpuMs.median} | ${r.metrics.drawCalls} | ${r.metrics.drawPages} | ${r.metrics.surfaceMeshes} | ${r.features} |`;
  });
  const table = [
    `Resolution ${results[0]?.resolution.join('×')}, ${results[0]?.gpu}. GPU = whole-frame timer queries (ms); +vectors = median against the same view with vectors off.`,
    '',
    '| Scene | GPU median | GPU p95 | +vectors | CPU render median | Draw calls | Pages | Surface meshes | Features |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2) + '\n');
  await writeFile(`${output}/results.md`, table + '\n');
  console.log(table);
} finally { await browser.close(); }
