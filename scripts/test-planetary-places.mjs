/** Real static Gazetteer catalogs through the normal viewer, UI and workers.
 * CL_VIEWER_URL=http://127.0.0.1:5189/ node scripts/test-planetary-places.mjs
 * CL_GPU=hardware uses Chrome/Metal at 3840x2160; default is CI SwiftShader. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve('.'), base = process.env.CL_VIEWER_URL ?? 'http://127.0.0.1:5189/';
const output = process.env.CL_OUTPUT ?? '/tmp/planetary-places';
await mkdir(output, { recursive: true });
const tls = await mkdtemp(join(tmpdir(), 'place-tls-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tls, 'key.pem'), '-out', join(tls, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
const server = createServer({ key: await readFile(join(tls, 'key.pem')), cert: await readFile(join(tls, 'cert.pem')) }, async (req, res) => {
  if (!req.url.includes('blocked')) res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', req.url.endsWith('.geojson') ? 'application/geo+json' : 'application/json');
  if (req.url.includes('missing')) { res.writeHead(404); res.end('Missing dataset'); return; }
  if (req.url.includes('malformed')) { res.end('{bad geojson'); return; }
  if (req.url.includes('oversized')) { res.setHeader('Content-Length', 3 * 1024 * 1024); res.end('{}'); return; }
  try { res.end(await readFile(join(root, 'apps/viewer/test-catalogs', req.url))); }
  catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const hosted = `https://127.0.0.1:${server.address().port}/`;
const hardware = process.env.CL_GPU === 'hardware';
const browser = await chromium.launch({ executablePath: hardware ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
  args: hardware ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [], errors = [];
try {
  const context = await browser.newContext({ viewport: hardware ? { width: 1920, height: 1080 } : { width: 1440, height: 900 }, deviceScaleFactor: hardware ? 2 : 1, ignoreHTTPSErrors: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', e => { console.error('PAGEERROR',e.stack); errors.push(e.message); });
  await page.addInitScript(() => {
    window.__placeLongTasks = [];
    new PerformanceObserver(list => window.__placeLongTasks.push(...list.getEntries().map(e => e.duration))).observe({ type: 'longtask', buffered: true });
  });
  await page.addInitScript(() => {
    // Vite HMR query strings denote module identity. Drive the live module,
    // including its version, rather than constructing another state singleton.
    window.__placeModule = path => import(performance.getEntriesByType('resource').map(e=>e.name)
      .filter(url=>new URL(url).pathname===path).at(-1) ?? path);
  });
  const started = Date.now();
  await page.goto(`${base}?catalog=test-catalogs/planetary-places`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const ready = async () => {
    await page.waitForFunction(() => !!window.renderer, null, { timeout: 60000 });
    await page.evaluate(() => window.renderer.waitForInitialAssets());
  };
  await ready();
  const loadMetrics = async () => page.evaluate(() => {
    const r = window.renderer;
    return { places: r.placeNames.index.places.length, indexBuildMs: r.placeNames.indexBuildMs,
      sources: r.universe.geographicLayers.loads.map(l => ({ id: l.id, status: l.status, features: l.layer?.features.length, skipped: l.layer?.skippedFeatures, diagnostics: l.diagnostics })),
      importMs: performance.getEntriesByName('geographic:scene-import').at(-1)?.duration,
      workerRoundtripMs: performance.getEntriesByName('geographic:worker-roundtrip').map(e => e.duration),
      usedHeapBytes: performance.memory?.usedJSHeapSize, longTasksMs: window.__placeLongTasks };
  });
  const initial = await loadMetrics();
  console.log('Checked', results.length); results.push({ phase: 'catalog-relative require graph', readyMs: Date.now() - started, ...initial });
  assert.equal(initial.places, 11139); assert.ok(initial.importMs < 15000);
  assert.ok(initial.sources.every(l => l.status === 'ready' && l.skipped === 0));
  const search = async (query, expected) => {
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Search places, bodies, commands...').fill(query);
    await page.getByLabel('Place body', { exact: true }).selectOption('');
    await page.getByLabel('Place type', { exact: true }).selectOption('');
    await page.getByRole('option').filter({ has: page.getByText(expected, { exact: true }) }).first().click();
  };
  await search('Jez', 'Jezero');
  await page.getByRole('button', { name: 'Jump to', exact: true }).click();
  await page.waitForTimeout(300);
  const pose = () => page.evaluate(() => ({ position: window.renderer.camera.position.toArray(), target: window.renderer.cameraController.controls.target.toArray() }));
  const jezeroPose = await pose();
  await page.waitForTimeout(400);
  const held = await pose();
  assert.ok(Math.hypot(...held.target.map((v, i) => v - jezeroPose.target[i])) < 1e-8);
  await page.getByRole('button', { name: 'Copy coordinates', exact: true }).click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^18\.40820000° N, 77\.68730000° E$/);
  await page.screenshot({ path: `${output}/jezero-details.png` });
  console.log('Jezero copy and jump checked');
  await page.getByRole('button', { name: 'Fly to', exact: true }).click();
  await page.waitForFunction(() => !window.renderer.cameraController.animating, null, {timeout:15000});
  await page.waitForTimeout(100);
  const flown = await pose();
  assert.ok(Math.hypot(...flown.position.map((v, i) => v - jezeroPose.position[i])) < 1e-8);
  await search('Alpha', 'Example mission site Alpha (synthetic)');
  assert.match(await page.locator('body').innerText(), /mission\/user/);
  await search('Shack', 'Shackleton');
  await page.getByRole('button', { name: 'Jump to', exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.renderer.placeNames.selectedRef), 'moon:usgs:places/gazetteer:5450');
  // Body and type filters operate within the existing palette.
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search places, bodies, commands...').fill('Jezero');
  await page.getByLabel('Place body', { exact: true }).selectOption('Moon');
  assert.equal(await page.getByRole('option').filter({ hasText: 'Jezero' }).count(), 0);
  await page.getByLabel('Place body', { exact: true }).selectOption('Mars');
  await page.getByLabel('Place type', { exact: true }).selectOption('Crater, craters');
  await page.getByRole('option').filter({ hasText: 'Jezero' }).first().click();
  // Exercise the actual per-body names toggle and sample warm renderer cost.
  await page.evaluate(async()=>{const {openTool}=await window.__placeModule('/src/lib/shell.svelte.ts');openTool('display');});
  await page.getByText('By body',{exact:true}).click();
  await page.getByText('Mars geographic names', { exact: true }).click();
  await page.getByText('Moon geographic names', { exact: true }).click();
  const measure = async name => {
    await page.evaluate(async ({ name, root }) => {
      const { selectPlace } = await window.__placeModule('/src/lib/places.ts');
      selectPlace(null); window.renderer.applyNamedViewpoint(name);
    }, { name, root });
    await page.waitForTimeout(500);
    const metrics = await page.evaluate(async () => {
      const r = window.renderer, cpu = [], labels = [], frames = [];
      const original = r.renderFrame.bind(r);
      r.renderFrame = (...args) => { const start = performance.now(); const v = original(...args); cpu.push(performance.now() - start); labels.push({ ...r.placeNames.metrics }); return v; };
      let last = await new Promise(requestAnimationFrame);
      for (let i = 0; i < 60; i++) { const now = await new Promise(requestAnimationFrame); frames.push(now - last); last = now; }
      r.renderFrame = original;
      const stats = a => { a.sort((a,b)=>a-b); return { median: a[Math.floor(a.length/2)], p95: a[Math.floor(a.length*.95)] }; };
      const gl = r.renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
      return { frameMs: stats(frames), renderCpuMs: stats(cpu), labelCpuMs: stats(labels.map(l => l.cpuMs)), labelCandidates: Math.max(...labels.map(l => l.candidates)), labels: Math.max(...labels.map(l => l.drawn)), enters:labels.at(-1).enters-labels[0].enters, exits:labels.at(-1).exits-labels[0].exits, losDeferred: Math.max(...labels.map(l=>l.losDeferred)),
        gpu: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL), resolution: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        displayed: [...document.querySelectorAll('.cl-place-name')].filter(e=>e.style.display!=='none').map(e=>({ ref:e.dataset.placeRef, anchor:e.dataset.anchor })) };
    });
    assert.ok(metrics.labels > 0 && metrics.labels <= 32); assert.ok(metrics.labelCandidates <= 1024);
    if (hardware) { assert.doesNotMatch(metrics.gpu, /swiftshader|software/i); assert.deepEqual(metrics.resolution, [3840,2160]); }
    console.log('Checked', results.length); results.push({ phase: name, ...metrics });
    await page.screenshot({ path: `${output}/${name.replaceAll(' ', '-').toLowerCase()}.png` });
  };
  await measure('Mars places orbit');
  await measure('Moon places orbit');
  // Every displayed label is a real shared geographic hit, and camera orbiting
  // rechecks backside/terrain LOS rather than keeping stale screen boxes.
  const pick = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.cl-place-name')].find(e=>e.style.display!=='none');
    const rect = el.getBoundingClientRect(), canvas = window.renderer.renderer.domElement.getBoundingClientRect();
    return { x:rect.x + 10 - canvas.x, y:rect.y + 7 - canvas.y, ref:el.dataset.placeRef };
  });
  await page.mouse.click(pick.x, pick.y);
  assert.equal(await page.evaluate(()=>window.renderer.placeNames.selectedRef), pick.ref);
  await page.setViewportSize({ width: 390, height: 844 });
  await search('Shackleton', 'Shackleton');
  await page.getByRole('button', { name: 'Jump to', exact: true }).click();
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `${output}/compact-shackleton.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  // Actual cross-origin TLS static server, with CORS headers and relative requires.
  await page.evaluate(async ({ root, url }) => { const { loadCatalogUrl } = await window.__placeModule('/src/lib/loader.ts'); await loadCatalogUrl(document.querySelector('canvas'), url); }, { root, url: `${hosted}planetary-places.json` });
  await ready(); const https = await loadMetrics(); assert.equal(https.places,11139); console.log('Checked', results.length); results.push({ phase:'HTTPS/CORS require graph',...https });
  // The normal local file handler, once with flat multi-file paths and once
  // with directory paths as remembered by the actual directory picker.
  for (const directory of [false,true]) {
    await page.evaluate(async ({ root, directory }) => {
      const { handleFileList } = await window.__placeModule('/src/lib/loader.ts');
      const { rememberLocalFilePath } = await window.__placeModule('/src/lib/local-files.ts');
      const paths=['planetary-places.json','places/mars.json','places/moon.json','places/mars-001.geojson','places/moon-001.geojson','places/moon-002.geojson','places/moon-003.geojson','places/moon-004.geojson','places/user-sites.geojson','textures/mars.dds','textures/moon-2k.jpg'];
      const files=await Promise.all(paths.map(async path=>{const file=new File([await (await fetch(`/test-catalogs/${path}`)).arrayBuffer()],path.split('/').at(-1));if(directory)rememberLocalFilePath(file,`catalog/${path}`);return file;}));
      await handleFileList(document.querySelector('canvas'),files);
    }, { root, directory });
    await ready(); const local = await loadMetrics(); assert.equal(local.places,11139); assert.ok(local.sources.every(l=>l.status==='ready')); results.push({phase:directory?'Local directory':'Local multiple files',...local});
  }
  // Optional failures never prevent the rest of the real scene from loading.
  await page.route('**/optional-failures.json',async route=>{
    const scene=JSON.parse(await readFile(join(root,'apps/viewer/test-catalogs/planetary-places.json'),'utf8'));
    scene.require=[`${hosted}places/mars.json`];
    for(const item of scene.items)if(item.geometry?.baseMap)item.geometry.baseMap=`${hosted}${item.geometry.baseMap}`;
    scene.geographicLayers=['missing','blocked','malformed','oversized'].map(kind=>({...scene.geographicLayers[0],id:kind,source:`${hosted}places/${kind}.geojson`}));
    await route.fulfill({json:scene});
  });
  await page.evaluate(async ({root,base})=>{const {loadCatalogUrl}=await window.__placeModule('/src/lib/loader.ts');await loadCatalogUrl(document.querySelector('canvas'),`${base}optional-failures.json`);},{root,base});
  await ready(); const failures=await loadMetrics(); assert.equal(failures.sources.filter(l=>l.status==='error').length,4); assert.equal(failures.places,2051); results.push({phase:'Optional failures',...failures});
  if (process.env.CL_TERRAIN) {
    await page.setViewportSize(hardware ? {width:1920,height:1080} : {width:1440,height:900});
    for (const [body, catalog, query] of [['Moon','geographic-vectors-shackleton-terrain.json','Shackleton'],['Mars','geographic-vectors-jezero-terrain.json','Jezero']]) {
      const url=`${base}planetary-places-terrain-${body}.json`;
      await page.route(url,async route=>{
        const scene=JSON.parse(await readFile(join(root,'apps/viewer/test-catalogs',catalog),'utf8'));
        scene.require=[`${hosted}places/${body.toLowerCase()}.json`];
        scene.geographicLayers=[];
        for(const item of scene.items)if(item.geometry?.terrain){
          item.geometry.terrain.url=`${base}test-catalogs/${item.geometry.terrain.url}`;
          if(item.geometry.terrain.cubeSphere)item.geometry.terrain.cubeSphere.cpuGrids=`${base}test-catalogs/${item.geometry.terrain.cubeSphere.cpuGrids}`;
        }
        await route.fulfill({json:scene});
      });
      await page.evaluate(async({root,url})=>{const {loadCatalogUrl}=await window.__placeModule('/src/lib/loader.ts');await loadCatalogUrl(document.querySelector('canvas'),url);},{root,url});
      await ready();
      await page.evaluate(async()=>{const {navigationView}=await window.__placeModule('/src/lib/navigation-view.svelte.ts');navigationView.preset='overhead';navigationView.rangeText='30';});
      await search(query,query);await page.getByRole('button',{name:'Jump to',exact:true}).click();
      await page.evaluate(async()=>{const {openTool}=await window.__placeModule('/src/lib/shell.svelte.ts');openTool('display');});
      await page.getByText('By body',{exact:true}).click();
      await page.getByText(`${body} geographic names`,{exact:true}).click();
      await page.evaluate(()=>window.renderer.setLightingMode('natural'));
      await page.waitForTimeout(4000);
      const terrain=await page.evaluate(async({root,body,query})=>{
        const {placeAnchor}=await import(`/@fs/${root}/packages/three/src/geographic/PlaceSurface.ts`);
        const r=window.renderer,bm=r.getBodyMesh(body),p=r.placeNames.index.search(query)[0];
        const anchor=placeAnchor(p,bm);
        const probe=r.pickScene(r.renderer.domElement.clientWidth/2,r.renderer.domElement.clientHeight/2,'probe');
        const labels=[],intervals=[];let last=await new Promise(requestAnimationFrame);for(let i=0;i<30;i++){const now=await new Promise(requestAnimationFrame);intervals.push(now-last);last=now;labels.push({...r.placeNames.metrics});}intervals.sort((a,b)=>a-b);
        return{body,source:anchor?.source,hasTerrain:bm.hasTerrain,terrainMetrics:bm.terrainMetrics,labels,frameMs:{median:intervals[15],p95:intervals[28]},
          probe:probe?.kind==='surface'?{lat:probe.point.latDeg,lon:probe.point.lonDeg,source:probe.point.source}:probe};
      },{root,body,query});
      results.push({phase:`${body} measured terrain`,...terrain});
      await page.screenshot({path:`${output}/${body.toLowerCase()}-terrain.png`});
      console.log('Terrain',body,terrain.source,terrain.probe,terrain.terrainMetrics);
      assert.ok(terrain.hasTerrain);assert.ok(terrain.probe);assert.equal(terrain.probe.source,'terrain');
      if(body==='Moon')assert.equal(terrain.source,'terrain-sample');
      else assert.equal(terrain.source,'reference-shape');
    }
  }
  assert.deepEqual(errors,[]);
} finally {
  await writeFile(`${output}/metrics.json`,JSON.stringify({results,errors},null,2)+'\n');
  await browser.close(); await new Promise(r=>server.close(r)); await rm(tls,{recursive:true,force:true});
}
console.log(JSON.stringify({results,errors},null,2));
