/** Independently verify every object in a completed public surface publication. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {identity} from './surface-build/plan.mjs';
import {mapLimit,objectMeta,serializeInventory} from './data-hosting/lib/publish.mjs';
const [planFile,receiptFile,outFile]=process.argv.slice(2);
assert.ok(planFile&&receiptFile&&outFile,'PLAN.json RECEIPT.json OUT.json required');
const plan=JSON.parse(await readFile(planFile));
const receipt=JSON.parse(await readFile(receiptFile));
const {identity:planPin,directory,...planBody}=plan;assert.equal(identity(planBody),planPin);
const {identity:receiptPin,...receiptBody}=receipt;assert.equal(identity(receiptBody),receiptPin);
assert.equal(receipt.publicationIdentity,plan.identity);assert.equal(receipt.localOnly,false);
assert.match(receipt.baseUrl,/^https:\/\//);assert.equal(receipt.products.length,plan.products.length);
for(const p of plan.products)assert.ok(receipt.products.some(r=>r.productId===p.productId&&r.verified&&r.prefix===p.prefix&&r.inventorySha256===p.inventorySha256));
const origins=receipt.verificationOrigins,base=receipt.baseUrl+'/',sha=b=>createHash('sha256').update(b).digest('hex');
const report={publicationIdentity:plan.identity,baseUrl:receipt.baseUrl,startedAt:new Date().toISOString(),products:[],transportRetries:[],passed:false};
async function fetch(url,options){for(let attempt=1;;attempt++){try{const r=await globalThis.fetch(url,{...options,signal:AbortSignal.timeout(60000)});const body=await r.arrayBuffer();return new Response(body,{status:r.status,headers:r.headers});}catch(e){report.transportRetries.push({url,attempt,error:String(e.cause??e)});if(attempt>=3)throw e;await new Promise(r=>setTimeout(r,500*attempt));}}}
for(const p of plan.products){
 const r=await fetch(base+p.prefix+'inventory.jsonl.gz');assert.equal(r.status,200);
 const inventory=gunzipSync(Buffer.from(await r.arrayBuffer())).toString();assert.equal(sha(inventory),p.inventorySha256);assert.equal(inventory,serializeInventory(p.entries));
 const summary={productId:p.productId,objects:0,bytes:0,originSamples:[],coldLods:[]};
 await mapLimit(p.entries,8,async(e)=>{const r=await fetch(base+p.prefix+e.path,{headers:{Origin:origins[0]}});assert.equal(r.status,200,e.path);assert.match(r.headers.get('server')??'',/cloudflare/i);const b=Buffer.from(await r.arrayBuffer());assert.equal(b.length,e.size,e.path);assert.equal(sha(b),e.sha256,e.path);const meta=objectMeta(e.path,e.gzip);assert.ok(r.headers.get('content-type')?.startsWith(meta.contentType),e.path);assert.ok(r.headers.get('cache-control')?.includes('immutable'),e.path);assert.ok([origins[0],'*'].includes(r.headers.get('access-control-allow-origin')),e.path);assert.ok(!r.headers.get('content-encoding')||['br','gzip','zstd'].includes(r.headers.get('content-encoding')),e.path);summary.objects++;summary.bytes+=b.length;if(summary.objects%1000===0)console.log(p.productId,summary.objects);});
 const tiles=p.entries.filter(e=>/\/(\d+)\/\d+\/\d+\.(glb|png|webp|jpg)$/.test(e.path)).map(e=>({...e,level:Number(e.path.match(/\/(\d+)\/\d+\/\d+\.(glb|png|webp|jpg)$/)[1])})).sort((a,b)=>a.level-b.level);
 assert.ok(tiles.length);
 const min=tiles[0].level,max=tiles.at(-1).level,mid=Math.floor((min+max)/2);
 const samples=[tiles[0],tiles.find(e=>e.level>=mid),tiles.at(-1)];
 for(const origin of origins){const r=await fetch(base+p.prefix+samples[0].path,{headers:{Origin:origin}});await r.arrayBuffer();assert.equal(r.status,200);assert.ok([origin,'*'].includes(r.headers.get('access-control-allow-origin')));summary.originSamples.push({origin,status:r.status,allowOrigin:r.headers.get('access-control-allow-origin')});}
 for(const e of samples){const r=await fetch(base+p.prefix+e.path+'?release-cold='+Date.now(),{headers:{Origin:origins[0]}});const b=Buffer.from(await r.arrayBuffer());assert.equal(r.status,200);assert.equal(sha(b),e.sha256);summary.coldLods.push({path:e.path,level:e.level,status:r.status,bytes:b.length,headers:Object.fromEntries(r.headers)});}
 const missing=await fetch(base+p.prefix+'__missing__/independent-release-probe',{headers:{Origin:origins[0]}});assert.equal(missing.status,404);await missing.arrayBuffer();summary.missingStatus=404;
 report.products.push(summary);console.log('verified',p.productId,summary.objects,summary.bytes);
}
report.passed=true;report.finishedAt=new Date().toISOString();await writeFile(outFile,JSON.stringify(report,null,2)+'\n');
