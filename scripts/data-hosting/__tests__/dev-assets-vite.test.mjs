import { createServer as createHttpServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { afterEach, expect, it, vi } from 'vitest';

const servers=[],caches=[];
afterEach(async()=>{
  for(const server of servers.splice(0).reverse()) {
    if(server.middlewares) await server.close();
    else {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
  caches.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true}));
  vi.unstubAllEnvs();
});
async function fixture(mode='auto') {
  const requests=[];
  const upstream=createHttpServer((req,res)=>{
    requests.push({url:req.url,method:req.method});
    if(req.url.endsWith('not-present.json')){res.writeHead(404);res.end('remote missing');return;}
    const body=JSON.stringify({hosted:true});
    res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(body)});res.end(body);
  });servers.push(upstream);
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  vi.stubEnv('DATA_BASE_URL',`http://127.0.0.1:${upstream.address().port}`);
  vi.stubEnv('DEV_DATA_MODE',mode);vi.stubEnv('VITE_BASE','/viewer/');
  const cache=mkdtempSync(join(tmpdir(),'cosmolabe-dev-fallback-'));caches.push(cache);
  const vite=await createViteServer({root:resolve('apps/viewer'),configFile:resolve('apps/viewer/vite.config.ts'),cacheDir:cache,
    server:{host:'127.0.0.1',port:0,watch:null},logLevel:'error',optimizeDeps:{noDiscovery:true,include:[]}});
  servers.push(vite);await vite.listen();
  return {base:`http://127.0.0.1:${vite.httpServer.address().port}/viewer/test-catalogs/`,requests};
}
it('uses existing local managed files before the pin and falls back for missing files under a Vite base path',async()=>{
  const {base,requests}=await fixture();
  const localFile='kernels/naif0012.tls';
  const local=await fetch(base+localFile);
  expect(local.status).toBe(200);expect(await local.text()).toBe(readFileSync(resolve('apps/viewer/test-catalogs',localFile),'utf8'));
  const localHead=await fetch(base+localFile,{method:'HEAD'});expect(localHead.status).toBe(200);expect(await localHead.text()).toBe('');
  expect(requests).toHaveLength(0);
  const missing='data/ingenuity-cube/terrain-3846907d293e9e5d0b0243ce/__dev-fallback-test-missing.json';
  const hosted=await fetch(base+missing);
  expect(hosted.status).toBe(200);expect(await hosted.json()).toEqual({hosted:true});
  expect(requests[0].url).toBe('/cube-terrain/terrain-3846907d293e9e5d0b0243ce/3846907d293e9e5d0b0243cefc2ed446/__dev-fallback-test-missing.json');
  const head=await fetch(base+missing,{method:'HEAD'});expect(head.status).toBe(200);expect(await head.text()).toBe('');expect(requests.at(-1).method).toBe('HEAD');
  expect((await fetch(base+missing.replace('__dev-fallback-test-missing.json','not-present.json'))).status).toBe(404);
  const count=requests.length;
  expect((await fetch(base+'models/unknown.glb')).status).toBe(404);
  expect((await fetch(base+'data/mars-terrain-cube-jezero/unknown.json')).status).toBe(404);
  expect(requests).toHaveLength(count);
},30000);
it('keeps missing local files as real 404s when remote fallback is disabled',async()=>{
  const {base,requests}=await fixture('local');
  expect((await fetch(base+'data/ingenuity-cube/terrain-3846907d293e9e5d0b0243ce/__dev-fallback-test-missing.json')).status).toBe(404);
  expect(requests).toHaveLength(0);
},30000);
