import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { hostedAssetUrl, createDevAssetFallback } from '../lib/dev-assets.mjs';

const datasets = {
  'cube-terrain/fixture': { kind:'cube-terrain',name:'fixture',catalogPrefix:'data/fixture/',build:'pinned-v1' },
  'kernels/generic': { kind:'kernels',name:'generic',catalogPrefix:'kernels/',build:'v1',recursive:false },
  'kernels/nested': { kind:'kernels',name:'nested',catalogPrefix:'kernels/nested/',build:'v2' },
  'terrain/unpublished': { kind:'terrain',name:'unpublished',catalogPrefix:'data/unpublished/',build:null },
  'terrain/local': { kind:'terrain',name:'local',catalogPrefix:'data/local/',build:'v3',localOnly:true },
};
const servers=[];
async function serve(handler) {
  const server=createServer(handler);servers.push(server);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return `http://127.0.0.1:${server.address().port}`;
}
afterEach(async()=>{
  await Promise.all(servers.splice(0).map(s=>{s.closeAllConnections();return new Promise(resolve=>s.close(resolve));}));
});

it('maps exact registry pins, longest prefixes and kernel layout without scanning products',()=>{
  expect(hostedAssetUrl('data/fixture/cpu-grids.json',datasets,'https://data.example/root/').href).toBe('https://data.example/root/cube-terrain/fixture/pinned-v1/cpu-grids.json');
  expect(hostedAssetUrl('kernels/naif.tls',datasets,'https://data.example').pathname).toBe('/kernels/generic-v1/naif.tls');
  expect(hostedAssetUrl('kernels/nested/file.bsp',datasets,'https://data.example').pathname).toBe('/kernels/nested-v2/file.bsp');
});
it.each(['data/unpublished/tileset.json','data/local/tileset.json','models/file.glb','kernels/unknown/file.bsp','../data/fixture/file','data/fixture/../file','/data/fixture/file'])('does not invent a fallback for %s',name=>{
  expect(hostedAssetUrl(name,datasets,'https://data.example')).toBeUndefined();
});

describe('streamed hosted fallback',()=>{
  it('serves GET/HEAD, relative manifests, binary/gzip bodies, ranges and actual 404s',async()=>{
    const seen=[];
    const raw=Buffer.from([0,1,2,127,128,254,255]), zipped=gzipSync(raw);
    const upstream=await serve((req,res)=>{
      seen.push({url:req.url,method:req.method,headers:req.headers});
      if(req.url.includes('missing')){res.writeHead(404,{'content-type':'text/plain'});res.end('missing upstream');return;}
      if(req.url.includes('.terrain')){res.writeHead(200,{'content-type':'application/octet-stream','content-encoding':'gzip','content-length':zipped.length});res.end(zipped);return;}
      if(req.headers.range){res.writeHead(206,{'content-range':'bytes 0-2/7','content-length':3});res.end(raw.subarray(0,3));return;}
      if(req.url.includes('.glb')){res.writeHead(200,{'content-type':'model/gltf-binary','content-length':raw.length});res.end(raw);return;}
      const text=JSON.stringify({tiles:['tiles/0.glb']});
      res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(text),'cache-control':'public, max-age=31536000, immutable'});res.end(text);
    });
    const fallback=createDevAssetFallback({datasets,baseUrl:upstream});
    const local=await serve((req,res)=>{if(!fallback(req,res,new URL(req.url,local).pathname.slice(1))){res.writeHead(404);res.end('local missing');}});
    const manifest=await fetch(local+'/data/fixture/tileset.json?version=1',{headers:{cookie:'private',authorization:'Bearer private'}});
    expect(manifest.status).toBe(200);expect(await manifest.json()).toEqual({tiles:['tiles/0.glb']});
    expect(manifest.headers.get('cache-control')).toBe('no-cache');
    expect(seen[0].url).toBe('/cube-terrain/fixture/pinned-v1/tileset.json?version=1');
    expect(seen[0].headers.cookie).toBeUndefined();expect(seen[0].headers.authorization).toBeUndefined();
    const head=await fetch(local+'/data/fixture/tileset.json',{method:'HEAD'});
    expect(head.status).toBe(200);expect(head.headers.get('content-length')).toBeTruthy();expect(await head.text()).toBe('');
    expect(seen.at(-1).method).toBe('HEAD');
    expect(Buffer.from(await (await fetch(local+'/data/fixture/tiles/0.glb')).arrayBuffer())).toEqual(raw);
    const terrain=await fetch(local+'/data/fixture/0.terrain');
    expect(terrain.headers.get('content-encoding')).toBe('gzip');expect(Buffer.from(await terrain.arrayBuffer())).toEqual(raw);
    const ranged=await fetch(local+'/data/fixture/tiles/0.glb',{headers:{range:'bytes=0-2'}});
    expect(ranged.status).toBe(206);expect(ranged.headers.get('content-range')).toBe('bytes 0-2/7');
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(raw.subarray(0,3));
    const missing=await fetch(local+'/data/fixture/missing');expect(missing.status).toBe(404);expect(await missing.text()).toBe('missing upstream');
    const count=seen.length;
    expect((await fetch(local+'/models/missing')).status).toBe(404);
    expect((await fetch(local+'/data/local/missing')).status).toBe(404);
    expect((await fetch(local+'/data/fixture/tileset.json',{method:'POST'})).status).toBe(404);
    expect(seen).toHaveLength(count);
  });
  it('honors local-only mode and returns 502 for an unreachable upstream',async()=>{
    const only=createDevAssetFallback({datasets,mode:'local'});
    expect(only({method:'GET'}, {},'data/fixture/file')).toBe(false);
    const upstream=await serve((_req,res)=>res.end());
    const server=servers.pop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    const fallback=createDevAssetFallback({datasets,baseUrl:upstream});
    const local=await serve((req,res)=>fallback(req,res,'data/fixture/file'));
    expect((await fetch(local+'/data/fixture/file')).status).toBe(502);
  });
  it('retries transient upstream failures once, preserving terminal errors',async()=>{
    const counts=new Map();
    const upstream=await serve((req,res)=>{
      const n=(counts.get(req.url)??0)+1;counts.set(req.url,n);
      if(req.url.endsWith('/reset') && n===1){req.socket.destroy();return;}
      if(req.url.endsWith('/always-fail') || n===1){res.writeHead(503);res.end('temporary');return;}
      res.writeHead(200);res.end('recovered');
    });
    const fallback=createDevAssetFallback({datasets,baseUrl:upstream});
    const local=await serve((req,res)=>fallback(req,res,'data/fixture'+req.url));
    for(const path of ['/transient','/reset']) {
      const response=await fetch(local+path);expect(response.status).toBe(200);expect(await response.text()).toBe('recovered');
      expect(counts.get('/cube-terrain/fixture/pinned-v1'+path)).toBe(2);
    }
    const failure=await fetch(local+'/always-fail');expect(failure.status).toBe(503);expect(await failure.text()).toBe('temporary');
    expect(counts.get('/cube-terrain/fixture/pinned-v1/always-fail')).toBe(2);
  });

});
