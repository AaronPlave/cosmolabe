/** Viewer UI integration with a local fixed-point catalog and no terrain bytes.
 * Start the viewer dev server first. This checks controls, not terrain output.
 * CHROMIUM_PATH=/usr/bin/chromium node scripts/test-terrain-contour-controls.mjs
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.SURFACE_VIEWER_URL ?? 'http://127.0.0.1:5182';
const output = process.env.CONTOUR_OUTPUT ?? 'work/issue-183';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).host===new URL(base).host?route.continue():route.abort());
 const catalog={name:'Offline contour controls',defaultViewpoint:'Moon view',items:[
  {name:'Sun',class:'star',trajectory:{type:'FixedPoint',position:[1e8,0,0]},geometry:{type:'Globe',radius:695700}},
  {name:'Moon',class:'moon',trajectory:{type:'FixedPoint',position:[0,0,0]},geometry:{type:'Globe',radius:1737.4,terrain:{type:'3dtiles',url:`${base}/control-fixture/tileset.json`,datum:{verticalDatum:'reference-sphere',heightConvention:'radial'},cubeSphere:{cpuGrids:`${base}/control-fixture/cpu-grids.json`}}}},
  {name:'Mars',class:'planet',trajectory:{type:'FixedPoint',position:[20000,0,0]},geometry:{type:'Globe',radii:[3396.19,3396.19,3376.2],terrain:{type:'quantized-mesh',url:`${base}/control-fixture/mars/`}}},
  {name:'Moon view',type:'Viewpoint',center:'Moon',distance:2200,latitude:-85,longitude:0}
 ]};
 await page.route('**/contour-controls.json',r=>r.fulfill({json:catalog}));
 const faces=['px','nx','py','ny','pz','nz'];
 const datum={referenceShape:{kind:'sphere',radiusKm:1737.4},verticalDatum:'reference-sphere',heightConvention:'radial'};
 const grid={format:'cosmolabe-cube-height-grid-1',datum,source:{id:'control-fixture',kind:'height-grid',version:'fixture'},
  grid:{width:2,height:2,encoding:'float32 little-endian, metres above the reference sphere',uri:'heights/{face}/{level}/{x}/{y}.f32'},
  heightRangeKm:[-1,1],maxLevel:0,tiles:faces.map(f=>[f,0,0,0,1])};
 await page.route('**/control-fixture/**',r=>{
  const url=r.request().url();
  if(url.endsWith('cpu-grids.json')) return r.fulfill({json:grid});
  if(url.endsWith('.f32')) return r.fulfill({body:Buffer.from(new Float32Array(4).buffer),contentType:'application/octet-stream'});
  if(url.endsWith('tileset.json')) return r.fulfill({json:{asset:{version:'1.1',tilesetVersion:'fixture',generator:'scripts/terrain/dem.py cube-tile'},geometricError:0,root:{boundingVolume:{sphere:[0,0,0,1737400]},geometricError:0,children:[]}}});
  return r.fulfill({status:404,body:'Offline UI fixture: no geometry'});
 });
 await page.goto(`${base}/?catalog=contour-controls&test=1`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__cosmolabe?.ready,{timeout:120000});
 await page.evaluate(()=>window.cosmo.select('Moon'));
 const contours=page.getByRole('checkbox',{name:'Contours',exact:true}); await contours.waitFor({timeout:20000});
 assert.equal(await contours.isChecked(),false);
 assert.equal(await page.getByLabel('Hillshade effect',{exact:true}).count(),1);
 assert.equal(await page.getByLabel('Surface base color',{exact:true}).count(),1);
 await contours.check();
 await page.getByLabel('Contour density',{exact:true}).fill('2');
 assert.equal(await page.evaluate(()=>window.renderer.getBodyMesh('Moon').surfaceAppearance.contours),true);
 await page.getByLabel('Contour elevation labels',{exact:true}).check();
 assert.equal(await page.getByLabel('Contour interval',{exact:true}).inputValue(),'1');
 assert.equal(await page.getByLabel('Contour density',{exact:true}).count(),0);
 await page.getByLabel('Contour interval',{exact:true}).selectOption('0.25');
 await page.evaluate(()=>window.cosmo.select('Mars'));
 await page.getByLabel('Hillshade effect',{exact:true}).waitFor();
 assert.equal(await page.getByRole('checkbox',{name:'Contours',exact:true}).isChecked(),false);
 assert.equal(await page.evaluate(()=>window.renderer.getBodyMesh('Mars').surfaceAppearance.contourLabels),false);
 await page.evaluate(()=>window.cosmo.select('Moon'));
 assert.equal(await page.getByRole('checkbox',{name:'Contours',exact:true}).isChecked(),true);
 assert.equal(await page.getByLabel('Contour elevation labels',{exact:true}).isChecked(),true);
 assert.equal(await page.getByLabel('Contour interval',{exact:true}).inputValue(),'0.25');
 await page.getByLabel('Contour interval',{exact:true}).selectOption('0');
 assert.equal(await page.getByLabel('Contour elevation labels',{exact:true}).isChecked(),false);
 assert.equal(await page.getByLabel('Contour density',{exact:true}).inputValue(),'2');
 await page.screenshot({path:`${output}/contour-controls.png`});
 await page.getByRole('checkbox',{name:'Contours',exact:true}).uncheck();
 assert.equal(await page.getByLabel('Contour density',{exact:true}).count(),0);
 const report={passed:true,errors,checks:['cube contour toggle','cube tint/hillshade controls preserved','density edit','fixed interval and labels','per-body isolation','selection persistence','automatic spacing disables labels and restores density','disabled control collapse'],scope:'UI only, no terrain geometry'};
 await writeFile(`${output}/ui-metrics.json`,JSON.stringify(report,null,2));
 assert.deepEqual(errors,[]); console.log(JSON.stringify(report));
} finally {await browser.close();}
