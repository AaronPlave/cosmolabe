#!/usr/bin/env node
// Reproduce #251's synthetic Skyfall contract end-to-end on a static HTTP store.
// No remote upload, credentials, observed mission geometry or deployment edits.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createFixture } from './fixture.mjs';
import { executeBuild } from './run.mjs';
import { publishBuild, catalogCandidate, applyCatalogCandidate } from './publication.mjs';
import { publishedFeedback } from './report.mjs';
const [outArg = 'work/surface-build/skyfall-acceptance', python = 'python3'] = process.argv.slice(2);
const out=resolve(outArg),cache=join(out,'cache');await mkdir(out,{recursive:true});
const json=v=>JSON.stringify(v,null,2)+'\n';
const children=[],handles=[];
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function start(file,args,env,logName){
  const handle=await open(join(out,logName),'w');handles.push(handle);
  const p=spawn(process.execPath,[file,...args],{env:{...process.env,...env},stdio:['ignore',handle.fd,handle.fd]});children.push(p);
  p.on('error',e=>console.error(e));return p;
}
async function ready(url,child){
  for(let i=0;i<240;i++){
    if(child.exitCode!==null)throw new Error(`local server exited: ${child.exitCode}`);
    try{await fetch(url,{signal:AbortSignal.timeout(1000)});return;}catch{await new Promise(r=>setTimeout(r,250));}
  }
  throw new Error('local server did not start: '+url);
}
try{
  const input=join(out,'inputs');const {lock,bindings}=await createFixture(input,python);
  const report=await executeBuild(lock,{cache,bindings,bindingsDir:input,python,workers:2,log:t=>process.stderr.write(t)});
  await writeFile(join(out,'report.json'),json(report));
  const storePort=await port(),viewerPort=await port(),baseUrl=`http://127.0.0.1:${storePort}`;
  const localDir=join(out,'published');
  const store=await start('scripts/surface-build/serve-publication.mjs',[localDir,String(storePort)],{},'store.log');await ready(baseUrl,store);
  const receipt=await publishBuild(lock,{cache,localDir,baseUrl});
  const republished=await publishBuild(lock,{cache,localDir,baseUrl});
  if(!republished.products.every(p=>p.reused))throw new Error('immutable re-publication did not reuse every product');
  const receiptFile=join(out,'publication.json');await writeFile(receiptFile,json(receipt));
  await writeFile(join(out,'published-planner-feedback.json'),json(publishedFeedback(report,receipt)));
  const catalog=JSON.parse(await readFile('apps/viewer/test-catalogs/experiments/mars-terrain-cube-jezero.json'));
  const globe=catalog.items.find(i=>i.name==='Mars').geometry,terrain=report.products.find(p=>p.kind==='cube-terrain');
  globe.terrain.url=`/test-catalogs/data/${terrain.id}/tileset-measured.json`;
  globe.terrain.cubeSphere.cpuGrids=`/test-catalogs/data/${terrain.id}/cpu-grids.json`;
  globe.imagery=report.products.filter(p=>p.kind==='cube-imagery').map(p=>({type:'cube',id:p.id,name:p.sourceIds[0],visible:p.visible,opacity:p.opacity,url:`/test-catalogs/data/${p.id}/imagery.json`}));
  const catalogFile=join(out,'catalog.json');await writeFile(catalogFile,json(catalog));
  const candidate=await catalogCandidate(lock,{cache,receipt,catalog,catalogRel:'test-catalogs/fixture.json',
    catalogPrefixes:Object.fromEntries(report.products.map(p=>[p.id,`data/${p.id}/`]))});
  await writeFile(join(out,'catalog-candidate.json'),json(candidate));
  await applyCatalogCandidate(candidate,catalogFile);
  const viewer=await start('scripts/surface-build/serve-pilot.mjs',[join(out,'report.json')],{
    PILOT_VIEWER_PORT:String(viewerPort),SURFACE_PUBLICATION_RECEIPT:receiptFile,SURFACE_CATALOG_FILE:catalogFile},'viewer.log');
  const viewerUrl=`http://127.0.0.1:${viewerPort}/`;await ready(viewerUrl,viewer);
  const browser=await start('scripts/test-surface-build-pilot.mjs',[join(out,'report.json'),join(out,'browser')],{
    SURFACE_HOSTED:'1',CL_VIEWER_URL:viewerUrl},'browser.log');
  const result=await new Promise(r=>browser.once('exit',r));
  if(result!==0)throw new Error(`Skyfall browser failed (${result}); see ${join(out,'browser.log')}`);
  await applyCatalogCandidate(candidate,catalogFile,{rollback:true});
  if(JSON.stringify(JSON.parse(await readFile(catalogFile)))!==JSON.stringify(catalog))throw new Error('catalog rollback changed content');
  const evidence={version:1,kind:'surface-acceptance-receipt',buildId:report.buildId,publicationIdentity:receipt.identity,
    hostedHttp:true,immutableRepublish:true,catalogRewriteAndRollback:true,browser:'browser/browser.json',
    plannerFeedback:'published-planner-feedback.json',productionUpload:false};
  await writeFile(join(out,'acceptance.json'),json(evidence));console.log(json(evidence));
}finally{for(const p of children)if(p.exitCode===null)p.kill('SIGTERM');for(const h of handles)await h.close();}
