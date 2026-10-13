#!/usr/bin/env node
/** Same-path surface/frame prototypes using the viewer's built package entry. */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { createSpiceEngine } from '../packages/cspice-wasm/dist/index.js';
import { Body, FixedPointTrajectory, bodySurfaceCoordinates, bodyFixedToSurfacePosition } from '../packages/core/dist/index.js';
const root = process.cwd(), out = resolve('docs/validation/graticule/coordinate-frame');
const fixture = resolve('apps/viewer/graticule-validation.html'), baseline = resolve('packages/three/src/BodyMeshBefore.ts');
mkdirSync(out, { recursive: true });
writeFileSync(fixture, readFileSync('scripts/graticule-validation/fixture.html'));
writeFileSync(baseline, execFileSync('git', ['show', '8d685f73f94cab63bca54d4d16c6eee909a2a89a:packages/three/src/BodyMesh.ts']));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], loaded = new Set(), results = [], paths = [], silhouetteChecks = [];
const fingerprint = Object.fromEntries(['AdaptiveGraticule', 'GraticuleFrame', 'GraticuleShader'].flatMap(name => ['src/' + name + '.ts', 'dist/' + name + '.js'])
  .map(path => [path, createHash('sha256').update(readFileSync('packages/three/' + path)).digest('hex')]));
const angle = 0.5, radial = [Math.cos(angle), Math.sin(angle), 0], side = [-Math.sin(angle), Math.cos(angle), 0];
const pose = (i, count) => {
  const t = i / (count - 1), smooth = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  const d = 300 * Math.pow(101 / 300, smooth(t / 0.6));
  const pan = 0.003 * Math.sin(t * Math.PI), r = [Math.cos(angle + pan), Math.sin(angle + pan), 0];
  const eye = r.map(v => v * d), target = r.map(v => v * 100), roll = 0.25 * Math.sin(t * Math.PI);
  let up = [-radial[1] * Math.sin(roll), radial[0] * Math.sin(roll), Math.cos(roll)];
  if (t > 0.7) { const tilt = smooth((t - 0.7) / 0.3); for (let j = 0; j < 3; j++) target[j] = eye[j] - r[j] * (1 - 0.94 * tilt) + side[j] * 0.94 * tilt;
    up = up.map((v, j) => v * (1 - tilt) + r[j] * tilt); }
  return { eye, target, up };
};
const catalog = JSON.parse(readFileSync('apps/viewer/test-catalogs/msl-dingo-gap.json'));
const spice = await createSpiceEngine();
for (const path of ['naif0012.tls','msl/pck00008.tpc','msl/msl.tf','msl/msl_tp_ops120808_iau2000_v1.tf','msl/MSL_76_SCLKSCET.00012.tsc','msl/msl_surf_rover_tlm_0449_0583_v1.bc','msl/msl_ls_ops120808_iau2000_v1.bsp','msl/msl_surf_rover_loc_0000_2003_v1.bsp','msl/msl_surf_rover_tlm_0449_0583_v1.bsp']) await spice.furnsh(path.split('/').at(-1),new Uint8Array(readFileSync('apps/viewer/test-catalogs/kernels/'+path)));
const et=await spice.str2et(catalog.defaultTime.replace(/Z$/,''));
const rover=Object.values((await spice.spkpos('-76',et,'IAU_MARS','NONE','499')).position);
const attitude=await spice.pxform('MSL_ROVER','IAU_MARS',et),world=await spice.pxform('ECLIPJ2000','IAU_MARS',et);
const mul=(m,v)=>[0,1,2].map(i=>m[i*3]*v[0]+m[i*3+1]*v[1]+m[i*3+2]*v[2]);
const up=mul(world,[0,1,0]);
const mars=new Body({name:'Mars',trajectory:new FixedPointTrajectory([0,0,0]),radii:[3396.19,3396.19,3376.2],geometryType:'Globe'});
const site=bodyFixedToSurfacePosition({xKm:rover[0],yKm:rover[1],zKm:rover[2]},bodySurfaceCoordinates(mars));
const catalogPoses=catalog.items.filter(v=>['Dingo Gap Approach','Curiosity Surface','Curiosity Close-up'].includes(v.name)).map(v=>{
 const lat=v.latitude*Math.PI/180,lon=v.longitude*Math.PI/180;
 let offset=[Math.cos(lat)*Math.cos(lon),Math.cos(lat)*Math.sin(lon),Math.sin(lat)].map(x=>x*v.distance);
 if(v.center==='Curiosity')offset=mul(attitude,offset);
 const center=v.center==='Curiosity'?rover:[0,0,0];
 return {catalogName:v.name,eye:offset.map((x,i)=>x+center[i]),target:center,up,...(v.center==='Curiosity'?{terrain:true,depression:true,depressionHeight:site.heightKm,patchLat:site.latDeg,patchLon:site.lonDeg,patchSpan:.04}:{})};
});
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => { if (r.url().includes('/packages/three/')) loaded.add(r.url().split('/packages/three/')[1].split('?')[0]); });
  await page.goto(`${process.env.GRID_VIEWER_URL ?? 'http://localhost:5173'}/graticule-validation.html`); await page.waitForFunction(() => window.ready);
  for (const coordinateFrame of [false, true]) {
    const mode = coordinateFrame ? 'frame' : 'surface', frames = [], dir = mkdtempSync(resolve(tmpdir(), 'grid-frame-'));
    await page.evaluate(options => window.setup(options), { radii: [100, 100, 100], coordinateFrame, controls: true, ...pose(0, 97) });
    await page.evaluate(() => window.loadImagery('/textures/moon-2k.jpg'));
    await page.evaluate(() => { window.validationTime = performance.now(); Object.defineProperty(performance, 'now', { configurable: true, value: () => window.validationTime }); });
    for (let i = 0; i < 97; i++) {
      const p = pose(i, 97);
      const frame = await page.evaluate(p => { window.validationTime += 125; window.pose(p); return window.frame(); }, p);
      const png = await page.evaluate(() => window.capture());
      writeFileSync(resolve(dir, `frame-${String(i).padStart(4, '0')}.png`), Buffer.from(png.split(',')[1], 'base64'));
      frames.push({ index: i, pose: p, ...frame });
      if ([0, 48, 64, 80, 96].includes(i)) writeFileSync(resolve(out, `${mode}-${i}.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '8', '-i', resolve(dir, 'frame-%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', resolve(out, `${mode}.mp4`)]);
    rmSync(dir, { recursive: true, force: true }); paths.push({ mode, frames });
  }
  const regionalChecks = [];
  for (const latitude of [0, 17]) {
    const view = i => {
      const lon = .5 + i * .000015, lat = latitude * Math.PI / 180 + .00001 * Math.sin(i / 6);
      const r = [Math.cos(lat)*Math.cos(lon), Math.cos(lat)*Math.sin(lon), Math.sin(lat)];
      return { eye:r.map(v=>v*101),target:r.map(v=>v*100),up:[-.12*Math.sin(lon),.12*Math.cos(lon),1] };
    };
    await page.evaluate(o=>window.setup(o),{radii:[100,100,100],coordinateFrame:true,...view(0)});
    await page.evaluate(()=>window.loadImagery('/textures/moon-2k.jpg'));
    for(let i=0;i<20;i++)await page.evaluate(()=>{window.validationTime+=16;window.frame()});
    const stationary=[];
    for(let i=0;i<8;i++)stationary.push(await page.evaluate(()=>{window.validationTime+=16;return window.frame()}));
    const frames=[];
    for(let i=0;i<40;i++){
      if(i===20)await page.evaluate(()=>window.tessellate(96));
      const f=await page.evaluate(o=>{window.validationTime+=16;window.pose(o);return window.frame()},view(i));
      const alignment=await page.evaluate(()=>window.alignmentChecks());
      frames.push({index:i,...f,alignment});
    }
    const png=await page.evaluate(()=>window.capture());writeFileSync(resolve(out,`regional-${latitude}-rendered.png`),Buffer.from(png.split(',')[1],'base64'));
    const covered=f=>['latitude','longitude'].every(axis=>f.metrics.frameTicks.filter(t=>t.axis===axis).length>=2);
    const pass=frames.every(f=>f.metrics.frameQueries<=8&&f.runtime.visibleFrameElements===f.metrics.frameElements&&f.metrics.frameTextureBytes<524288&&f.alignment.every(a=>a.alignmentPx!==null&&a.alignmentPx<=.3))
      &&frames.filter(f=>f.index<20||f.index>=23).every(covered)
      &&stationary.every(f=>f.metrics.frameTextureUploads===stationary[0].metrics.frameTextureUploads);
    regionalChecks.push({latitude,pass,stationary,frames});
  }
  const catalogChecks=[];
  for(const options of catalogPoses){
    for(const coordinateFrame of [false,true]){
      await page.evaluate(o=>window.setup(o),{radii:[3396.19,3396.19,3376.2],name:'Mars',coordinateFrame,...options});
      await page.evaluate(()=>window.loadImagery('/textures/mars.dds'));
      for(let i=0;i<24;i++)await page.evaluate(()=>{window.validationTime+=16;window.frame()});
      const frame=await page.evaluate(()=>window.frame());
      const png=await page.evaluate(()=>window.capture());writeFileSync(resolve(out,`${coordinateFrame?'frame':'surface'}-${options.catalogName.replaceAll(' ','-').toLowerCase()}.png`),Buffer.from(png.split(',')[1],'base64'));
      catalogChecks.push({coordinateFrame,options,...frame,alignment:await page.evaluate(()=>window.alignmentChecks())});
    }
  }
  for (const coordinateFrame of [false, true]) for (const deviceScaleFactor of [1, 2]) {
    await page.setViewportSize({ width: 800, height: 800 });
    // Separate browser contexts exercise actual device pixel ratios.
    const context = await browser.newContext({ viewport: { width: 800, height: 800 }, deviceScaleFactor }); const p = await context.newPage();
    p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(`${process.env.GRID_VIEWER_URL ?? 'http://localhost:5173'}/graticule-validation.html`); await p.waitForFunction(() => window.ready);
    for (const [name, options] of [['bright', { color: '#eeeece' }], ['dark', { color: '#10151b' }], ['small-globe', { eye: [800, 0, 0], target: [0, 0, 0] }], ['terrain', { terrain: true, relief: true }]]) {
      await p.evaluate(options => window.setup(options), { radii: [100, 100, 100], eye: [101, 0, 0], target: [100, 0, 0], coordinateFrame, ...options });
      for (let i = 0; i < 12; i++) { await p.evaluate(() => window.frame()); await p.waitForTimeout(20); }
      const frame = await p.evaluate(() => window.frame()); results.push({ mode: coordinateFrame ? 'frame' : 'surface', name, deviceScaleFactor, ...frame });
      const png = await p.evaluate(() => window.capture()); writeFileSync(resolve(out, `${coordinateFrame ? 'frame' : 'surface'}-${name}-${deviceScaleFactor}.png`), Buffer.from(png.split(',')[1], 'base64'));
      if (name === 'small-globe') {
        await p.evaluate(() => { window.gridLines(false); window.frame(); });
        const plain = await p.evaluate(() => window.capture());
        const { data: off, info } = await sharp(Buffer.from(plain.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const on = await sharp(Buffer.from(png.split(',')[1], 'base64')).removeAlpha().raw().toBuffer();
        const mask = new Uint8Array(info.width * info.height);
        for (let j = 0; j < mask.length; j++) mask[j] = Math.abs(off[j * 3] - 5) + Math.abs(off[j * 3 + 1] - 8) + Math.abs(off[j * 3 + 2] - 17) > 8 ? 1 : 0;
        let changed = 0, outside = 0;
        // Permit one physical pixel of silhouette antialiasing, independent of DPR.
        for (let j = 0; j < mask.length; j++) {
          if (Math.abs(on[j * 3] - off[j * 3]) + Math.abs(on[j * 3 + 1] - off[j * 3 + 1]) + Math.abs(on[j * 3 + 2] - off[j * 3 + 2]) <= 8) continue;
          changed++; const x = j % info.width, y = Math.floor(j / info.width); let inside = false;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && x + dx < info.width && y + dy >= 0 && y + dy < info.height && mask[(y + dy) * info.width + x + dx]) inside = true;
          if (!inside) outside++;
        }
        silhouetteChecks.push({ mode: coordinateFrame ? 'frame' : 'surface', deviceScaleFactor, changedPixels: changed, outsideSilhouettePixels: outside, antialiasAllowancePhysicalPixels: 1 });
      }
    }
    await context.close();
  }
  const all = [...paths.flatMap(p => p.frames), ...results];
  const pass = errors.length === 0 && [...loaded].some(v => v.endsWith('/GraticuleFrame.js') || v.endsWith('/GraticuleFrame.ts')) && [...loaded].some(v => v.endsWith('/BodyMesh.js') || v.endsWith('/BodyMesh.ts')) && all.every(f => f.runtime.graticuleInstances === 1 && f.runtime.visibleGridSprites === f.metrics.labels && f.runtime.visibleFrameElements === f.metrics.frameElements && f.metrics.frameQueries <= 8)
    && regionalChecks.every(c=>c.pass) && catalogChecks.every(c=>c.metrics.frameQueries<=8&&c.alignment.every(a=>a.alignmentPx!==null&&a.alignmentPx<=.3))
    && paths[1].frames.some(f => new Set(f.metrics.frameTicks.map(t => t.axis)).size === 2) && results.every(f => f.metrics.frameTicks.length <= 8)
    && silhouetteChecks.every(c => c.changedPixels > 0 && c.outsideSilhouettePixels === 0);
  const report = { pass, fingerprint, loadedModules: [...loaded].sort(), errors, paths, results, silhouetteChecks, regionalChecks, catalogChecks, catalogTime:catalog.defaultTime, roverPosition:rover, site };
  writeFileSync(resolve(out, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ pass, loaded: [...loaded], errors, frames: paths.map(p => p.frames.length), frameAxes: [...new Set(paths[1].frames.flatMap(f => f.metrics.frameTicks.map(t => t.axis)))] }));
  if (!pass) process.exitCode = 1;
} finally { await browser.close(); rmSync(fixture, { force: true }); rmSync(baseline, { force: true }); }
