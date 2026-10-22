// Isolated viewer for generated build artifacts. The normal app and renderer
// run unchanged; bound CSS discovery to viewer source and ignore generated data.
import { createServer } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { geodeticToBodyFixed } from '../../packages/three/dist/TerrainSampler.js';
const report=JSON.parse(await readFile(process.argv[2]??'work/surface-build/real-pilot-report.json'));
const terrain=report.products.find(p=>p.kind==='cube-terrain');
const products=new Map(report.products.map(p=>[p.id,resolve(report.directory,p.id)]));
const catalog=JSON.parse(await readFile('apps/viewer/test-catalogs/experiments/mars-terrain-cube-jezero.json'));
catalog.name='Real Mars surface build pilot';
catalog.description=report.limitation;
const globe=catalog.items.find(i=>i.name==='Mars').geometry;
globe.terrain.url=`/__surface-pilot/${terrain.id}/tileset-measured.json`;
globe.terrain.cubeSphere.cpuGrids=`/__surface-pilot/${terrain.id}/cpu-grids.json`;
globe.terrain.cubeSphere.imagery={maxScreenTexelError:1};
globe.imagery=report.products.filter(p=>p.kind==='cube-imagery').map((p,i)=>({
  type:'cube',id:p.id,name:i?'HiRISE native detail (25 cm)':'HiRISE context',
  url:`/__surface-pilot/${p.id}/imagery.json`,visible:p.visible,opacity:p.opacity,
  resolutionMeters:p.nativeFidelity[0].nativeGsdM,
}));
const cp=terrain.controls[0];
const g=geodeticToBodyFixed({latDeg:cp.lat,lonDeg:cp.lon,heightKm:cp.heightM/1000},terrain.datum);
const target=[g.xKm,g.yKm,g.zKm],la=cp.lat*Math.PI/180,lo=cp.lon*Math.PI/180;
const normal=[Math.cos(la)*Math.cos(lo),Math.cos(la)*Math.sin(lo),Math.sin(la)];
const up=[-Math.sin(la)*Math.cos(lo),-Math.sin(la)*Math.sin(lo),Math.cos(la)];
catalog.items[0]={name:'Native detail',type:'Viewpoint',center:'Mars',frame:'BodyFixed',
  eye:target.map((v,i)=>v+normal[i]*.05),target,up,fov:45};
catalog.defaultViewpoint='Native detail';
const server=await createServer({root:resolve('apps/viewer'),configFile:resolve('apps/viewer/vite.config.ts'),
  optimizeDeps:{entries:[resolve('apps/viewer/index.html')]},
  plugins:[{name:'pilot-bounded-css-scan',enforce:'pre',configureServer(server){
    server.middlewares.use(async(req,res,next)=>{
      const path=new URL(req.url,'http://localhost').pathname;
      if(path==='/test-catalogs/experiments/mars-surface-build-pilot.json'){
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(catalog));return;
      }
      if(!path.startsWith('/__surface-pilot/'))return next();
      const parts=decodeURIComponent(path).split('/').filter(Boolean),root=products.get(parts[1]);
      const file=root&&resolve(root,...parts.slice(2));
      if(!file?.startsWith(root+sep)){res.statusCode=403;res.end('Invalid product path');return;}
      try{res.setHeader('Content-Type',({'.json':'application/json','.glb':'model/gltf-binary','.png':'image/png'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));}
      catch{res.statusCode=404;res.end('Missing pinned product file');}
    });
  },transformIndexHtml(html){
    return html.replace('</body>',`<script type="module">
      const source=await(await fetch('/src/lib/commands.ts')).text();
      const url=source.match(/from ["']([^"']*viewer-state\\.svelte[^"']*)["']/)?.[1];
      const state=await import(url??'/src/lib/viewer-state.svelte.ts');
      const timer=setInterval(()=>{if(!state.vs.assetsReady)return;clearInterval(timer);
        window.cosmo.setPlaying(false);window.cosmo.untrack();
        const r=state.getRenderer(),bm=r.getBodyMesh('Mars');
        r.setTerrainDebugMode('imagery-unlit','Mars');
        const V=r.camera.position.constructor,centre=new V();bm.getWorldPosition(centre);
        const world=p=>new V(p[0],p[2],-p[1]).applyQuaternion(bm.mesh.quaternion).multiplyScalar(r.scaleFactor).add(centre);
        const target=${JSON.stringify(target)},normal=${JSON.stringify(normal)},north=${JSON.stringify(up)};
        const t=world(target),eye=world(target.map((v,i)=>v+normal[i]*.05));
        r.cameraController.controls.enableDamping=false;r.cameraController.controls.target.copy(t);
        r.camera.position.copy(eye);r.camera.up.copy(world(north).sub(centre).normalize());
        r.camera.fov=45;r.camera.updateProjectionMatrix();r.camera.lookAt(t);r.camera.updateMatrixWorld(true);
      },100);
    </script></body>`);
  },async load(id){
    if(id.endsWith('/src/app.css'))return (await readFile(id,'utf8')).replace('@import "tailwindcss";','@import "tailwindcss" source(none);\n@source "./";');
  },transform(code,id){
    if(id.endsWith('/src/app.css'))return code.replace('@import "tailwindcss";','@import "tailwindcss" source(none);\n@source "./";');
  }}],
  server:{host:'127.0.0.1',port:Number(process.env.PILOT_VIEWER_PORT??5187),strictPort:true,
    watch:null}});
await server.listen();server.printUrls();
console.log(`Pilot: http://127.0.0.1:${server.config.server.port}/?catalog=test-catalogs/experiments/mars-surface-build-pilot`);
