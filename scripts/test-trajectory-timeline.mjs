import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const base=process.argv[2]??'http://127.0.0.1:5174/',out=process.argv[3]??'work/ingenuity-246/review-followup/timeline';await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-gpu','--ignore-gpu-blocklist','--use-angle=metal']});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(`${base}?catalog=test-catalogs/ingenuity-jezero`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.renderer?.getBodyMesh('Mars')?.terrainManager?.cubeImageryStats?.version,null,{timeout:120000});
 await page.evaluate(async()=>{await window.renderer.waitForInitialAssets();window.cosmo.setPlaying(false);});
 const select=page.getByRole('combobox',{name:'Choose flight'});await select.waitFor({timeout:30000});assert.equal(await select.locator('option').count(),73);
 await select.selectOption('Ingenuity:11');await page.waitForTimeout(500);
 const snapshot=()=>page.evaluate(async()=>{const {vs}=await import('/src/lib/viewer-state.svelte.ts');const r=window.renderer,gl=r.getContext().webglRenderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return{et:vs.et,min:vs.scrubMin,max:vs.scrubMax,playing:vs.playing,option:document.querySelector('select[aria-label="Choose flight"]').value,gpu:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),glError:gl.getError()};});
 const f12=await snapshot();assert.equal(f12.option,'Ingenuity:11');assert.ok(f12.max-f12.min<300);assert.ok(f12.et>f12.min&&f12.et<f12.max);
 await page.getByRole('button',{name:'Previous flight',exact:true}).click();assert.equal((await snapshot()).option,'Ingenuity:10');
 await page.getByRole('button',{name:'Next flight',exact:true}).click();assert.equal((await snapshot()).option,'Ingenuity:11');
 await page.getByRole('button',{name:'Expand timeline',exact:true}).first().click();await page.getByRole('button',{name:'Go to Flight 12',exact:true}).waitFor();
 await page.screenshot({path:`${out}/desktop-flight12.png`});
 await select.selectOption('Ingenuity:71');await page.waitForTimeout(200);assert.ok(await page.getByRole('button',{name:'Next flight',exact:true}).isDisabled());
 await select.selectOption('Ingenuity:0');assert.ok(await page.getByRole('button',{name:'Previous flight',exact:true}).isDisabled());
 await page.evaluate(async()=>{const {resetScrubberZoom,setTime}=await import('/src/lib/viewer-state.svelte.ts');setTime(678747688);resetScrubberZoom();});await page.waitForTimeout(200);
 assert.equal(await page.getByRole('button',{name:/^Go to Flight /}).count(),72);await page.screenshot({path:`${out}/desktop-overview.png`});
 await select.selectOption('Ingenuity:11');await page.setViewportSize({width:390,height:844});await page.waitForTimeout(700);await page.screenshot({path:`${out}/compact-flight12.png`});
 assert.equal(await select.inputValue(),'Ingenuity:11');const geometry=await select.boundingBox();assert.ok(geometry.x>=0&&geometry.x+geometry.width<=390);
 assert.deepEqual(errors,[]);assert.equal(f12.glError,0);assert.doesNotMatch(f12.gpu,/SwiftShader|llvmpipe/i);
 await page.goto(`${base}?catalog=test-catalogs/moonfall-shackleton`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.renderer?.getBodyMesh('Moon')?.terrainManager?.cubeImageryStats?.version,null,{timeout:120000});assert.equal(await page.getByRole('combobox',{name:'Choose flight'}).count(),0);assert.deepEqual(errors,[]);await writeFile(`${out}/metrics.json`,JSON.stringify({passed:true,moonFallNavigatorAbsent:true,errors,f12,options:72,overviewMarks:72,compactSelect:geometry},null,2));console.log('PASS',f12,geometry);
}finally{await browser.close();}
