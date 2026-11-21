/** Cold browser acceptance against a verified publication receipt and a real hosted catalog.
 * node scripts/test-hosted-ingenuity.mjs VIEWER_URL OUT_DIR RECEIPT.json
 */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {identity} from './surface-build/plan.mjs';
import {loadDatasets} from './data-hosting/lib/datasets.mjs';
import {rewriteCatalog} from './data-hosting/lib/hosted-catalogs.mjs';
const [base,out,receiptFile]=process.argv.slice(2);assert.ok(base&&out&&receiptFile,'VIEWER_URL OUT_DIR RECEIPT.json required');
await mkdir(out,{recursive:true});const receipt=JSON.parse(await readFile(receiptFile,'utf8'));
const {identity:pin,...body}=receipt;assert.equal(identity(body),pin);assert.equal(receipt.localOnly,false);assert.ok(receipt.products.every(p=>p.verified));
const source=JSON.parse(await readFile('apps/viewer/test-catalogs/ingenuity-jezero.json','utf8'));
const expected=rewriteCatalog(source,'test-catalogs/ingenuity-jezero.json',loadDatasets().datasets,receipt.baseUrl).json;
const browser=await chromium.launch({headless:true,...(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{}),args:['--enable-gpu','--ignore-gpu-blocklist',process.platform==='darwin'?'--use-angle=metal':'--use-angle=swiftshader']});
const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'}),page=await context.newPage();
const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
const report={baseUrl:base,publicationIdentity:receipt.publicationIdentity,coldBrowserCache:true,products:Object.fromEntries(receipt.products.map(p=>[p.productId,{requests:0,sample:null}])),errors:[],flights:[],passed:false},pending=[];
page.on('pageerror',e=>report.errors.push(e.message));
page.on('request',r=>{for(const p of receipt.products)if(r.url().includes(p.productId)){report.products[p.productId].requests++;if(!r.url().startsWith(receipt.baseUrl+'/'+p.prefix))report.errors.push('Wrong product URL: '+r.url());}});
page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('favicon.ico'))report.errors.push(`${r.status()} ${r.url()}`);const p=receipt.products.find(p=>r.url().startsWith(receipt.baseUrl+'/'+p.prefix));if(p&&r.status()===200&&!report.products[p.productId].sample){const task=r.allHeaders().then(headers=>{if(!report.products[p.productId].sample)report.products[p.productId].sample={url:r.url(),status:r.status(),headers};});pending.push(task);}});
const flights=JSON.parse(await readFile('apps/viewer/test-catalogs/data/ingenuity/flights_index.json','utf8'));
const save=()=>writeFile(`${out}/metrics.json`,JSON.stringify(report,null,2)+'\n');
const idle=()=>{const t=window.renderer?.getBodyMesh('Mars')?.terrainManager,i=t?.cubeImageryStats,n=t?.metrics.network;return t?.tiles.visibleTiles.size>0&&n.queued+n.downloading+n.parsing===0&&t.cubeStats.inFlight===0&&i.inFlight===0&&(i.queued===0||i.budgetLimited);};
const settle=async()=>{const deadline=Date.now()+180000;do{await page.waitForFunction(idle,null,{timeout:Math.max(1,deadline-Date.now())});await page.waitForTimeout(500);if(await page.evaluate(idle))return;}while(Date.now()<deadline);throw new Error('Hosted requests did not remain idle');};
try{
 const response=await context.request.get(new URL('test-catalogs/ingenuity-jezero.json',base).href);assert.equal(response.status(),200);assert.deepEqual(await response.json(),expected,'Hosted catalog differs from the reviewed source and pins');
 await page.goto(`${base}?catalog=test-catalogs/ingenuity-jezero`,{waitUntil:'domcontentloaded',timeout:120000});
 await page.waitForFunction(()=>window.renderer?.getBodyMesh('Mars')?.terrainManager?.cubeImageryStats?.version,null,{timeout:180000});
 await page.evaluate(async()=>{await window.renderer.waitForInitialAssets();window.cosmo.setPlaying(false);});await settle();
 report.initial=await page.evaluate(()=>{const r=window.renderer,t=r.getBodyMesh('Mars').terrainManager,gl=r.getContext().webglRenderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return{gpu:gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER),imagery:t.cubeImageryStats,cpu:t.cubeStats,network:t.metrics.network,renderInfo:{memory:{...r.getContext().webglRenderer.info.memory},render:{...r.getContext().webglRenderer.info.render}}};});
 assert.doesNotMatch(report.initial.gpu,/swiftshader|llvmpipe|software/i);assert.equal(report.initial.imagery.baseUncoveredBlocks,0);
 await page.screenshot({path:`${out}/cold-default.png`});await save();
 const select=page.getByRole('combobox',{name:'Choose flight'});await select.waitFor();assert.equal(await select.locator('option').count(),73);
 for(let i=0;i<72;i++){await select.selectOption(`Ingenuity:${i}`);assert.equal(await select.inputValue(),`Ingenuity:${i}`);await page.waitForFunction(({start,end})=>{const et=window.renderer.timeController.et;return et>=start&&et<=end;},{start:flights[i].etStart,end:flights[i].etEnd},{timeout:5000});const et=await page.evaluate(()=>window.renderer.timeController.et);assert.ok(et>=flights[i].etStart&&et<=flights[i].etEnd,`Flight ${i+1} navigated outside its time interval`);report.flights.push({number:i+1,et});}
 await select.selectOption('Ingenuity:11');await settle();
 report.layers=[];
 for(const id of ['viking','ctx-global','jezero-ctx','jezero-hirise']){await page.evaluate(id=>{const b=window.renderer.getBodyMesh('Mars');for(const l of b.imageryLayers)b.setImageryLayerVisible(l.id,l.id===id||l.id==='viking');},id);await settle();report.layers.push(await page.evaluate(()=>window.renderer.getBodyMesh('Mars').imageryLayers.map(({id,visible,opacity})=>({id,visible,opacity}))));}
 await page.evaluate(()=>{const b=window.renderer.getBodyMesh('Mars');for(const l of b.imageryLayers)b.setImageryLayerVisible(l.id,true);});await settle();
 report.performance=await page.evaluate(async()=>{const r=window.renderer,t=r.getBodyMesh('Mars').terrainManager,frame=r.renderFrame,times=[];r.renderFrame=function(...args){const start=performance.now();const result=frame.apply(this,args);times.push(performance.now()-start);return result;};try{for(let i=0;i<120;i++)await new Promise(requestAnimationFrame);}finally{r.renderFrame=frame;}times.sort((a,b)=>a-b);return{frameCpuMs:{count:times.length,p50:times[times.length>>1],p95:times[Math.floor(times.length*.95)]},imagery:t.cubeImageryStats,cpu:t.cubeStats,gpuTiming:'not measured; CPU frame timings and imagery allocation are reported separately'};});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(500);await page.screenshot({path:`${out}/compact-flight12.png`});
 await Promise.all(pending);for(const p of receipt.products){const observed=report.products[p.productId];assert.ok(observed.requests>0,p.productId);assert.match(observed.sample?.headers.server??'',/cloudflare/i,p.productId);}
 assert.deepEqual(report.errors,[]);report.passed=true;await save();console.log(JSON.stringify({passed:true,gpu:report.initial.gpu,flights:report.flights.length,products:report.products,performance:report.performance.frameCpuMs},null,2));
}catch(e){report.failure=e.stack;await save();await page.screenshot({path:`${out}/failure.png`}).catch(()=>{});throw e;}finally{await browser.close();}
