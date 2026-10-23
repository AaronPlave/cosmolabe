import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const [viewerUrl,out]=process.argv.slice(2);
assert(viewerUrl&&out,'Usage: test-surface-build-cold-warm.mjs VIEWER_URL OUT_DIR');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist']});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],loads=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{if(r.url().startsWith('https://data.aaronplave.com/')&&!r.ok())errors.push(`${r.status()} ${r.url()}`);});
 const cdp=await page.context().newCDPSession(page);await cdp.send('Network.enable');
 let requests=new Map(),cached=new Set();
 cdp.on('Network.requestWillBeSent',e=>{if(e.request.url.startsWith('https://data.aaronplave.com/'))requests.set(e.requestId,e.request.url);});
 cdp.on('Network.requestServedFromCache',e=>{if(requests.has(e.requestId))cached.add(e.requestId);});
 cdp.on('Network.responseReceived',e=>{if(requests.has(e.requestId)&&(e.response.fromDiskCache||e.response.fromServiceWorker))cached.add(e.requestId);});
 for(const phase of ['cold','warm']){
  requests=new Map();cached=new Set();
  if(phase==='cold')await page.goto(viewerUrl,{waitUntil:'domcontentloaded'});
  else await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window.cosmo&&!!window.renderer,null,{timeout:120000});
  await page.waitForFunction(()=>{const b=window.renderer?.getBodyMesh('Mars'),i=b?.terrainManager?.cubeImageryStats,n=b?.terrainMetrics.network;return i?.maxDisplayedLevel===16&&i.baseUncoveredBlocks===0&&i.failedTiles===0&&!b.mesh.visible&&n.queued+n.downloading+n.parsing+i.inFlight+i.queued===0;},null,{timeout:120000});
  await page.waitForTimeout(500);
  const state=await page.evaluate(()=>{const r=window.renderer,b=r.getBodyMesh('Mars'),i=b.terrainManager.cubeImageryStats;return {maxImageLevel:i.maxDisplayedLevel,baseUncoveredBlocks:i.baseUncoveredBlocks,failedTiles:i.failedTiles,staticSphereVisible:b.mesh.visible,physicalPick:r.pickSurface(0,0)?.physical?.kind,provenance:b.terrainManager.imageryLayers.map(l=>({id:l.id,attribution:l.attribution,description:l.description}))};});
  assert.equal(state.physicalPick,'hit');if(phase==='warm')assert(cached.size>0,'warm reload should reuse the browser HTTP cache');
  await page.screenshot({path:`${out}/${phase}-public-load.png`});
  loads.push({phase,...state,publicRequests:requests.size,publicRequestsFromCache:cached.size,publicUrls:[...new Set(requests.values())]});
 }
 assert.deepEqual(errors,[]);
 const result={buildId:JSON.parse(await readFile('work/surface-build/real-pilot-report.json')).buildId,viewerUrl,viewerOrigin:new URL(viewerUrl).origin,dataOrigin:'https://data.aaronplave.com',requestInterception:false,testMode:false,deployedViewerOrigin:!new URL(viewerUrl).hostname.match(/^(localhost|127\.0\.0\.1)$/),loads,errors};
 await writeFile(`${out}/cold-warm.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({loads:loads.map(({publicUrls:_publicUrls,...v})=>v),errors},null,2));
}finally{await browser.close();}
