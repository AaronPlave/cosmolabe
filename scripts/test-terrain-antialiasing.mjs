/** Exact reported pose on the physical GPU, at DPR 1 and 2. The optional
 * --baseline-msaa fixture restores centre interpolation with native MSAA.
 * FrontSide is a diagnostic A/B, never a proposed production terrain change.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const base = process.argv[2] ?? 'http://127.0.0.1:5174/';
const out = process.argv[3] ?? 'work/ingenuity-246/review-followup/antialiasing';
await mkdir(out, { recursive: true });
const view={version:1,catalog:{catalog:'test-catalogs/ingenuity-jezero'},time:{kind:'fixed',source:'ET',et:722439881.1},view:{kind:'pose',version:1,frame:'ECLIPJ2000',origin:'Ingenuity',camera:{position:[0.09431799557302048,0.8765765398338419,-0.8885344966792921],target:[0.06646074962485488,0.018230723064687523,0.01434861140341277],up:[0.8683749019220087,0.3719977604649347,-0.32788717753982277],fov:6}},navigation:{selected:null,tracked:'Ingenuity',lookAt:null,mode:'sc-fixed'},playback:{playing:false,rate:2},display:{trajectories:true,labels:true,grid:false,axes:false,sensors:false,sensorLabels:false}};
const baseline = process.argv.includes('--baseline-msaa');
const browser = await chromium.launch({ headless: true,
  ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  args: ['--enable-gpu', '--ignore-gpu-blocklist', process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader'],
});
const report = { passed: false, baselineFixture: baseline, views: [], comparisons: [], errors: [] };
try {
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1592, height: 800 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    if (baseline) await page.route('**/UniverseRenderer.ts*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('patchLogDepthCoverage();', '') });
    });
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (/GL_INVALID|INVALID_OPERATION|Shader Error/.test(m.text())) report.errors.push(m.text()); });
    await page.goto(`${base}?catalog=test-catalogs/ingenuity-jezero&view=${encodeURIComponent(JSON.stringify(view))}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.renderer?.getBodyMesh('Mars')?.terrainManager?.cubeImageryStats?.version, null, { timeout: 120000 });
    await page.evaluate(async () => {
      const r = window.renderer; await r.waitForInitialAssets(); window.cosmo.setPlaying(false);
    });
    await page.waitForFunction(() => {
      const t = window.renderer.getBodyMesh('Mars').terrainManager, n = t.metrics.network, i = t.cubeImageryStats;
      return n.queued+n.downloading+n.parsing+i.queued+i.inFlight === 0 || i.budgetLimited;
    }, null, { timeout: 60000 });
    await page.waitForTimeout(1800);
    const captures = [];
    for (const side of [2, 0]) {
      await page.evaluate(side => {
        const r = window.renderer;
        r.getBodyMesh('Mars').terrainTileGroup.traverse(o => {
          if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) { m.side = side; m.needsUpdate = true; }
        });
      }, side);
      await page.waitForTimeout(500);
      const frame = await page.evaluate(() => {
        const r = window.renderer, wr = r.getContext().webglRenderer, gl = wr.getContext(), dbg = gl.getExtension('WEBGL_debug_renderer_info');
        r.renderFrame(); const meshes = [];
        r.getBodyMesh('Mars').terrainTileGroup.traverseVisible(o => { if (o.isMesh) meshes.push({ indices: o.geometry.index?.count, surface: o.geometry.userData.surfaceTriangles, draw: o.geometry.drawRange }); });
        return { image: wr.domElement.toDataURL(), gpu: gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
          fov: r.camera.fov, position: r.camera.position.toArray(), target: r.cameraController.controls.target.toArray(),
          rasterDensity: wr.getPixelRatio(),glError: gl.getError(), samples: gl.getParameter(gl.SAMPLES), meshes,
          imagery: r.getBodyMesh('Mars').terrainManager.cubeImageryStats };
      });
      const key = `dpr${dpr}-${baseline?'centre':'centroid'}-${side===2?'double':'front'}`;
      const bytes = Buffer.from(frame.image.split(',')[1], 'base64'); delete frame.image;
      await writeFile(`${out}/${key}.png`, bytes);
      if(side===2)await page.locator('canvas').first().screenshot({path:`${out}/${key}-display.png`});
      captures.push(await sharp(bytes).removeAlpha().raw().toBuffer());
      report.views.push({ key, ...frame });
      assert.equal(frame.glError, 0); assert.doesNotMatch(frame.gpu, /SwiftShader|llvmpipe|software/i);
      assert.ok(frame.imagery.baseUncoveredBlocks === 0);
      assert.ok(frame.samples > 0);assert.equal(frame.rasterDensity,dpr);
    }
    const [a,b] = captures; let changed = 0, dark = 0, maximumDifference = 0;
    for (let j=0; j<a.length; j+=3) {
      const diff = Math.max(...[0,1,2].map(k => Math.abs(a[j+k]-b[j+k])));
      if (diff>3) changed++; if (b[j]-a[j]>8) dark++; maximumDifference = Math.max(maximumDifference,diff);
    }
    const comparison = { dpr, changed, dark, maximumDifference }; report.comparisons.push(comparison); console.log(comparison);
    const [first,second] = report.views.slice(-2);
    assert.deepEqual(first.meshes, second.meshes); assert.deepEqual(first.position, second.position); assert.deepEqual(first.target, second.target);
    if (baseline) assert.ok(dark>100, 'The former MSAA strategy must reproduce the reported defect');
    else assert.ok(dark<20*dpr*dpr, 'Back-facing terrain introduces repeated dark seams');
    await context.close();
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} finally { await writeFile(`${out}/metrics.json`, JSON.stringify(report,null,2)+'\n'); await browser.close(); }
