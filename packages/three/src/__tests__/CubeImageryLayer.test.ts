import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CubeImageryLayer, cubeBlockInsideBounds, cubeBlockOverlapsBounds, isDrawnCubeImagerySource } from '../CubeImageryLayer.js';
import { SurfaceAppearance, DEFAULT_SURFACE_APPEARANCE } from '../SurfaceAppearance.js';
import { injectAerialPerspectiveIntoShader } from '../AerialPerspective.js';
import { injectShadowIntoShader, makeShadowUniforms } from '../EclipseShadow.js';
import { cubeFaceToDirection, cubeTileId, type CubeFace } from '../surface/CubeSphere.js';
import { directionToTexel, imageryTileRect, type CubeImageryManifest, type ImageryAddress } from '../surface/CubeImagery.js';

const R = 1737.4e3; // metres, like the tile set
const faces: CubeFace[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const southPole = [0, 0, -1] as const;

/** All faces to level 1, then every tile to `deep` under the level-3 tile holding the south-pole corner. */
function manifest(deep = 9): CubeImageryManifest {
  const tiles: string[] = [];
  for (const face of faces) for (let level = 0; level <= 1; level++) for (let x = 0; x < 2 ** level; x++) for (let y = 0; y < 2 ** level; y++) tiles.push(cubeTileId({ face, level, x, y }));
  const root = directionToTexel(southPole, 3, 256, 4).address;
  for (let level = 2; level <= deep; level++) {
    const shift = level - 3;
    const k = 2 ** Math.max(0, shift);
    const x0 = shift >= 0 ? root.x * k : root.x >> -shift, y0 = shift >= 0 ? root.y * k : root.y >> -shift;
    for (let x = x0; x < x0 + k; x++) for (let y = y0; y < y0 + k; y++) tiles.push(cubeTileId({ face: 'nz', level, x, y }));
  }
  return { format: 'cosmolabe-cube-imagery-1', source: { id: 'test', kind: 'imagery', version: 'v1' }, bodyId: 'Moon',
    registration: { crsId: 'cosmolabe:cube-gnomonic-1/IAU_MOON', pixelConvention: 'corner', registrationErrorKm: 0, resampling: 'test', footprint: 'test' },
    tileSize: 256, gutter: 4, encoding: 'png', colorSpace: 'srgb', minLevel: 0, maxLevel: deep, uri: 'tiles/{face}/{level}/{x}/{y}.png', tiles };
}

/** A geometry tile like the cube product's: a lattice relative to its centre, the centre as the mesh translation. */
function geometryTile(a: ImageryAddress, n = 17): { scene: THREE.Group; mesh: THREE.Mesh } {
  const { u0, v0, size } = imageryTileRect(a);
  const abs: number[][] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) abs.push([...cubeFaceToDirection(a.face, u0 + size * i / (n - 1), v0 + size * j / (n - 1))].map(c => c * R));
  const centre = [0, 1, 2].map(c => abs.reduce((s, p) => s + p[c], 0) / abs.length);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(abs.flatMap(p => p.map((c, k) => c - centre[k]))), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(abs.flatMap(p => p.map(c => c / R))), 3));
  const index: number[] = [];
  for (let j = 0; j + 1 < n; j++) for (let i = 0; i + 1 < n; i++) { const k = j * n + i; index.push(k, k + 1, k + n + 1, k, k + n + 1, k + n); }
  geometry.setIndex(index);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.position.set(centre[0], centre[1], centre[2]);
  const scene = new THREE.Group();
  scene.add(mesh);
  return { scene, mesh };
}

/** A loader whose requests resolve or fail only when the test says so. */
function controlledLoader() {
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  const aborted: string[] = [];
  const loadTexture = (url: string, signal: AbortSignal) => new Promise<{ texture: THREE.Texture; bytes: number; downloadBytes: number }>((resolve, reject) => {
    const id = /tiles\/(.*)\.png$/.exec(url)![1];
    signal.addEventListener('abort', () => { aborted.push(id); pending.delete(id); reject(new DOMException('Aborted', 'AbortError')); });
    pending.set(id, {
      resolve: () => { pending.delete(id); const t = new THREE.Texture(); t.name = id; resolve({ texture: t, bytes: 264 * 264 * 4 * 4 / 3, downloadBytes: 1000 }); },
      reject: (e) => { pending.delete(id); reject(e); },
    });
  });
  const settle = async (predicate: (id: string) => boolean = () => true, fail = false) => {
    for (const [id, p] of [...pending]) if (predicate(id)) { if (fail) p.reject(new Error('HTTP 503')); else p.resolve(); }
    await new Promise(r => setTimeout(r, 0));
  };
  return { loadTexture, pending, aborted, settle };
}

function camera(altitudeM: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(60, 1.6, 1, 1e8);
  c.position.set(0, 0, -(R + altitudeM));
  c.up.set(0, 1, 0);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld();
  return c;
}

async function setup(options: Partial<ConstructorParameters<typeof CubeImageryLayer>[0]> = {}, configure: (mesh: THREE.Mesh) => void = () => {}) {
  const loader = controlledLoader();
  const layer = new CubeImageryLayer({ url: 'http://test/imagery.json', ...options }, { fetchManifest: async () => manifest(), loadTexture: loader.loadTexture });
  await layer.ready;
  const tileSet = new THREE.Group(); // tile-set frame = world here
  const address = directionToTexel(southPole, 3, 256, 4).address; // a coarse geometry tile at the pole
  const { scene, mesh } = geometryTile(address);
  tileSet.add(scene);
  configure(mesh);
  layer.addTile(scene, scene, address);
  const pixelAngle = 2 * Math.tan(Math.PI / 6) / 800;
  const tick = (cam: THREE.Camera, frames = 1) => { for (let i = 0; i < frames; i++) layer.update(cam, tileSet.matrixWorld, pixelAngle, null); };
  return { layer, loader, scene, mesh, address, tick, tileSet };
}

async function drain(s: Awaited<ReturnType<typeof setup>>, cam = camera(5000), limit = 40) {
  for(let i=0;i<limit;i++) { s.tick(cam); await s.loader.settle(); }
  s.tick(cam);
}
function compile(material: THREE.Material) {
  const shader = { ...THREE.ShaderLib.standard, uniforms: {} as Record<string, {value: unknown}> };
  material.onBeforeCompile(shader as never, undefined as never); return shader;
}

describe('CubeImageryLayer paged imagery', () => {
  it('reports source-specific failures without attributing an overlay outage to the base',async()=>{
    const layers=['base','overlay'].map(id=>({type:'cube' as const,id,url:`http://${id}/imagery.json`}));
    const l=new CubeImageryLayer({url:layers[0].url,layers,residentLevel:0,maxLevel:1},{fetchManifest:async()=>manifest(1),loadTexture:async url=>{
      if(url.includes('//overlay/')&&/\/tiles\/[^/]+\/1\//.test(url))throw Error('overlay detail unavailable');return {texture:new THREE.Texture(),bytes:4,downloadBytes:4};
    }});
    await l.ready;const a=directionToTexel(southPole,3,256,4).address,{scene}=geometryTile(a),parent=new THREE.Group();parent.add(scene);l.addTile(scene,scene,a);
    for(let i=0;i<8;i++){l.update(camera(5000),parent.matrixWorld,.001,null);await new Promise(r=>setTimeout(r,0));}
    expect(l.imageryLayers[0].view?.degradedTiles).toBe(0);expect(l.imageryLayers[0].view?.missingTiles).toBe(0);
    expect(l.imageryLayers[1].view?.degradedTiles).toBeGreaterThan(0);expect(l.imageryLayers[1].view?.missingTiles).toBeGreaterThan(0);expect(l.stats.baseUncoveredBlocks).toBe(0);l.dispose();
  });
  it('binds a valid integer page table before the first imagery update',async()=>{
    const s=await setup();const shader=compile(s.mesh.material as THREE.Material);
    const table=shader.uniforms.cubePageTable.value as THREE.DataTexture;
    expect(table.isDataTexture).toBe(true);expect(table.format).toBe(THREE.RGBAIntegerFormat);
    expect(table.type).toBe(THREE.IntType);expect([...(table.image.data as Int32Array)]).toEqual([-1,-1,-1,-1]);s.layer.dispose();
  });
  it('bounds persistent tile failures and recovers only after explicit retry',async()=>{
    const s=await setup({maxLevel:0,residentLevel:0,retryFailedMs:0});
    for(let i=0;i<12;i++){s.tick(camera(5000));await s.loader.settle(()=>true,true);}
    expect(s.layer.stats.requests).toBe(24);
    expect(s.loader.pending.size).toBe(0);
    expect(s.layer.stats.baseUncoveredBlocks).toBeGreaterThan(0);
    s.layer.retryFailed();s.tick(camera(5000));await s.loader.settle();s.tick(camera(5000));
    expect(s.layer.stats.requests).toBe(30);expect(s.layer.stats.baseUncoveredBlocks).toBe(0);s.layer.dispose();
  });
  it('loads a product native floor above zero without requesting invented overview files',async()=>{
    const loader=controlledLoader(),m={...manifest(2),minLevel:2,maxLevel:2,tiles:faces.flatMap(face=>Array.from({length:16},(_,i)=>cubeTileId({face,level:2,x:i%4,y:Math.floor(i/4)})))};
    const l=new CubeImageryLayer({url:'http://test/imagery.json',residentLevel:0},{fetchManifest:async()=>m,loadTexture:loader.loadTexture});
    await l.ready;const a=directionToTexel(southPole,3,256,4).address,{scene}=geometryTile(a),parent=new THREE.Group();parent.add(scene);l.addTile(scene,scene,a);
    const requested:string[]=[];
    for(let i=0;i<10;i++){l.update(camera(8e6),parent.matrixWorld,.001,null);requested.push(...loader.pending.keys());await loader.settle();}
    expect(requested.length).toBeGreaterThan(0);expect(requested.every(id=>Number(id.split('/')[1])===2)).toBe(true);
    expect(l.stats.baseUncoveredBlocks).toBe(0);expect(l.sampleAt(southPole)[0].level).toBe(2);l.dispose();
  });
  it('refines on original meshes with no imagery geometry, material clones or physical buffer changes', async () => {
    const s=await setup({residentLevel:0});
    const {geometry,material}=s.mesh, physical=['position','normal'].map(n=>geometry.getAttribute(n).array), index=geometry.index!.array;
    await drain(s);
    expect(s.layer.stats.maxDisplayedLevel).toBeGreaterThan(3);
    expect(s.mesh.geometry).toBe(geometry); expect(s.mesh.material).toBe(material);
    expect(['position','normal'].map(n=>geometry.getAttribute(n).array)).toEqual(physical);
    expect(geometry.index!.array).toBe(index);
    expect(s.scene.children).toEqual([s.mesh]); expect(s.mesh.visible).toBe(true);
    expect(s.layer.stats.extraDraws).toBe(0); expect(s.layer.stats.blockGeometryBytes).toBe(0);
    expect(s.layer.stats.blockBuildMs).toBe(0); expect(s.layer.stats.splitTiles).toBe(0);
    expect(isDrawnCubeImagerySource(s.mesh)).toBe(false);
    const shader=compile(material as THREE.Material);
    expect(shader.fragmentShader).toContain('sampler2DArray cubePages');
    expect(shader.fragmentShader).toContain('cubePageFind');
    expect(shader.fragmentShader).toContain('textureGrad');
    s.layer.dispose();
  });
  it('retains committed imagery through delayed responses, rapid reversal and terrain replacement', async () => {
    const s=await setup({residentLevel:0}); await drain(s);
    const before=s.layer.sampleAt(southPole), requests=s.layer.stats.requests;
    for(let i=0;i<16;i++)s.tick(camera(i%2?6000:5000));
    expect(s.layer.sampleAt(southPole).map(x=>x.level)).toEqual(before.map(x=>x.level));
    s.layer.removeTile(s.scene); s.layer.addTile(s.scene,s.scene,s.address); s.tick(camera(5000));
    expect(s.layer.sampleAt(southPole).map(x=>x.level)).toEqual(before.map(x=>x.level));
    expect(s.layer.stats.requests-requests).toBeLessThanOrEqual(8);
    expect(compile(s.mesh.material as THREE.Material).vertexShader.match(/attribute vec3 cubeImageryUvw;/g)).toHaveLength(1);
    s.layer.dispose();
  });
  it('keeps compiled uniform objects live through pool resizing and material reuse',async()=>{
    const s=await setup({residentLevel:0});await drain(s);
    const shader=compile(s.mesh.material as THREE.Material),table=shader.uniforms.cubePageTable;
    s.layer.setOptions({maxTextureBytes:32*2**20});await drain(s);
    const current=compile(s.mesh.material as THREE.Material);
    expect(current.uniforms.cubePageTable).toBe(table);
    s.layer.removeTile(s.scene);s.layer.addTile(s.scene,s.scene,s.address);s.tick(camera(5000));
    expect(compile(s.mesh.material as THREE.Material).uniforms.cubePageTable).toBe(table);s.layer.dispose();
  });
  it('defers refinement under constrained memory without evicting the displayed cover', async () => {
    const s=await setup({residentLevel:0,maxTextureBytes:6*264*264*4*4/3,maxConcurrentRequests:2});
    // Four independently owned terrain patches straddle the pole, so the image
    // cover cannot collapse to a single narrow visible descendant.
    for (const x of [3,4]) for (const y of [3,4]) {
      const a={face:'nz' as const,level:3,x,y};if(x===s.address.x&&y===s.address.y)continue;
      const {scene}=geometryTile(a);s.tileSet.add(scene);s.layer.addTile(scene,scene,a);
    }
    await drain(s);const before=s.layer.sampleAt(southPole);
    const state=s.layer.stats;
    expect(state.budgetLimited).toBe(true);
    expect(state.baseUncoveredBlocks).toBe(0);
    expect(state.textures+state.inFlight).toBeLessThanOrEqual(10);
    for(let i=0;i<40;i++){s.tick(camera(i%2?5100:5000));await s.loader.settle();}
    expect(s.layer.sampleAt(southPole).map(x=>x.level)).toEqual(before.map(x=>x.level));
    expect(s.layer.stats.evicted).toBe(state.evicted);
    s.layer.dispose();
  });
  it('does not falsely establish base coverage with optional transparent images', async () => {
    const loader=controlledLoader();
    const layer=new CubeImageryLayer({url:'http://base/imagery.json',residentLevel:0,layers:[{type:'cube',id:'base',url:'http://base/imagery.json'},{type:'cube',id:'overlay',url:'http://overlay/imagery.json'}]}, {
      fetchManifest:async()=>manifest(1), loadTexture:async(url,signal)=>url.includes('//base/')?loader.loadTexture(url,signal):{texture:new THREE.DataTexture(new Uint8Array([30,40,50,0]),1,1),bytes:4,downloadBytes:4}});
    await layer.ready;
    const a=directionToTexel(southPole,1,256,4).address,{scene}=geometryTile(a),parent=new THREE.Group();parent.add(scene);layer.addTile(scene,scene,a);
    for(let i=0;i<12;i++){layer.update(camera(5000),parent.matrixWorld,.001,null);await loader.settle(()=>true,true);}
    expect(layer.sampleAt(southPole)[1].enabled).toBe(1);
    expect(layer.sampleAt(southPole)[0].enabled).toBe(0);
    expect(layer.stats.baseUncoveredBlocks).toBeGreaterThan(0);
    layer.dispose();
  });
  it('rejects missing mandatory manifests and incompatible optional references', async () => {
    const cfg={url:'http://base/a.json',layers:[{type:'cube' as const,url:'http://base/a.json'},{type:'cube' as const,url:'http://overlay/a.json'}]};
    const bad=new CubeImageryLayer(cfg,{fetchManifest:async url=>{if(url.includes('//base/'))throw Error('base unavailable');return manifest(1);}});
    await expect(bad.ready).rejects.toThrow('base unavailable');bad.dispose();
    const l=new CubeImageryLayer(cfg,{fetchManifest:async url=>({...manifest(1),bodyId:url.includes('//base/')?'Moon':'Mars'}),loadTexture:controlledLoader().loadTexture});
    await l.ready;expect(l.imageryLayers[1].status).toBe('failed');expect(l.manifest?.bodyId).toBe('Moon');l.dispose();
  });
  it.each([0,255])('keeps independent lower imagery available through source alpha %i and layer edits',async alpha=>{
    const layers=['base','a','b','c'].map(id=>({type:'cube' as const,id,url:`http://${id}/imagery.json`}));
    const l=new CubeImageryLayer({url:layers[0].url,layers,residentLevel:0},{fetchManifest:async()=>manifest(5),loadTexture:async()=>({texture:new THREE.DataTexture(new Uint8Array([90,80,70,alpha]),1,1),bytes:4,downloadBytes:4})});
    await l.ready;const a=directionToTexel(southPole,3,256,4).address,{scene,mesh}=geometryTile(a),parent=new THREE.Group();parent.add(scene);l.addTile(scene,scene,a);
    const tick=()=>l.update(camera(5000),parent.matrixWorld,.001,null);
    for(let i=0;i<25;i++){tick();await new Promise(r=>setTimeout(r,0));}
    expect(l.sampleAt(southPole).at(-1)?.enabled).toBe(1);
    if(alpha===0)expect(l.sampleAt(southPole).every(x=>x.level>=3)).toBe(true);
    for(const id of ['a','b','c'])l.setLayerOpacity(id,.5);
    for(let i=0;i<25;i++){tick();await new Promise(r=>setTimeout(r,0));}
    expect(l.sampleAt(southPole).every(x=>x.level>=3)).toBe(true);
    const geometry=mesh.geometry,material=mesh.material;
    expect(l.setLayerVisible('b',false)).toBe(true);tick();expect(l.sampleAt(southPole).find(x=>x.id==='b')?.enabled).toBe(0);
    l.setLayerOpacity('a',.25);l.moveLayer('c',1);tick();
    expect(l.sampleAt(southPole).map(x=>x.id)).toEqual(['base','c','a','b']);
    expect(l.sampleAt(southPole).find(x=>x.id==='a')?.opacity).toBe(.25);
    expect(mesh.geometry).toBe(geometry);expect(mesh.material).toBe(material);
    const shader=compile(material as THREE.Material);expect(shader.fragmentShader).toContain('sampleValue.a * cubeLayer');
    expect(shader.uniforms.cubeLayer2_opacity.value).toBe(.25);
    l.setLayerVisible('b',true);for(let i=0;i<25;i++){tick();await new Promise(r=>setTimeout(r,0));}
    expect(l.sampleAt(southPole).find(x=>x.id==='b')?.enabled).toBe(1);l.dispose();
  });
  it('preserves contour/style fields and dynamic upstream shader hooks without derived geometry',async()=>{
    const fade={value:1};
    const s=await setup({residentLevel:0},mesh=>{
      const material=mesh.material as THREE.MeshStandardMaterial;
      material.onBeforeCompile=shader=>{shader.uniforms.fixtureFade=fade;injectShadowIntoShader(shader,makeShadowUniforms());injectAerialPerspectiveIntoShader(shader, {});};
      material.customProgramCacheKey=()=>`fade-${fade.value}`;
    });
    const style=new SurfaceAppearance({referenceShape:{kind:"sphere",radiusKm:R/1000},verticalDatum:"reference-sphere",heightConvention:"radial"});s.layer.surfaceAppearance=style;
    style.attach(s.mesh,s.mesh.matrix.clone(),s.scene);style.set({...DEFAULT_SURFACE_APPEARANCE,hillshade:true});style.update(Infinity);
    const attributes=['position','normal'].map(n=>s.mesh.geometry.getAttribute(n));
    await drain(s);const mat=s.mesh.material as THREE.Material,first=mat.customProgramCacheKey();fade.value=.5;
    expect(mat.customProgramCacheKey()).not.toBe(first);
    const shader=compile(mat);expect(shader.uniforms.fixtureFade).toBe(fade);
    expect(shader.fragmentShader).toContain('saShade');expect(shader.fragmentShader).toContain('getShadowMask()');
    expect(shader.fragmentShader.indexOf('outgoingLight = diffuseColor.rgb')).toBeLessThan(shader.fragmentShader.indexOf('AerialPerspectiveResult _ap'));
    expect(['position','normal'].map(n=>s.mesh.geometry.getAttribute(n))).toEqual(attributes);
    s.layer.invalidateBlocks();s.tick(camera(5000));expect(s.scene.children).toEqual([s.mesh]);
    s.layer.dispose();style.forget(s.scene);
  });
  it('rejects decoded images that exceed their manifest reservation',async()=>{
    let disposed=0;const l=new CubeImageryLayer({url:'http://test/imagery.json',maxConcurrentRequests:2},{fetchManifest:async()=>manifest(1),loadTexture:async()=>{const texture=new THREE.Texture();texture.addEventListener('dispose',()=>disposed++);return {texture,bytes:1e9,downloadBytes:1};}});
    await l.ready;await new Promise(r=>setTimeout(r,0));expect(l.stats.failures).toBe(2);expect(l.stats.textureBytes).toBe(0);expect(disposed).toBe(2);l.dispose();
  });
  it('does not hammer failed image decoding or accept wrong tile dimensions',async()=>{
    const close=vi.fn();vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1,height:1,close})));
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}})));
    const l=new CubeImageryLayer({url:'http://test/imagery.json',residentLevel:0,maxConcurrentRequests:2},{fetchManifest:async()=>manifest(1)});
    try{await l.ready;await new Promise(r=>setTimeout(r,0));expect(l.stats.failures).toBe(2);expect(l.stats.textureBytes).toBe(0);expect(close).toHaveBeenCalledTimes(2);}
    finally{l.dispose();vi.unstubAllGlobals();}
  });
  it('keeps coverage tests conservative at polar and antimeridian seams',()=>{
    const a=(lat:number,lon:number)=>directionToTexel([Math.cos(lat*Math.PI/180)*Math.cos(lon*Math.PI/180),Math.cos(lat*Math.PI/180)*Math.sin(lon*Math.PI/180),Math.sin(lat*Math.PI/180)],13,256,4).address;
    expect(cubeBlockOverlapsBounds(a(18.45,77.4),[77.16,18.21,77.7,18.72])).toBe(true);
    expect(cubeBlockInsideBounds(a(18.9,77.4),[77.16,18.21,77.7,18.72])).toBe(false);
    expect(cubeBlockInsideBounds(a(0,179.9),[170,-1,-170,1])).toBe(true);
    expect(cubeBlockOverlapsBounds(a(90,0),[170,89,-170,90])).toBe(true);
  });
});

describe("source ingestion and bounded recovery",()=>{
  it('keeps the lower layer when an optional source manifest fails or is incompatible', async () => {
    const layers = ['base', 'outage', 'wrong-body'].map(id => ({ type: 'cube' as const, id, url: `http://${id}/imagery.json` }));
    const layer = new CubeImageryLayer({ url: layers[0].url, layers }, {
      fetchManifest: async url => { if (url.includes('outage')) throw new Error('offline'); return { ...manifest(1), ...(url.includes('wrong-body') ? { bodyId: 'Mars' } : {}) }; },
      loadTexture: async () => ({ texture: new THREE.Texture(), bytes: 1, downloadBytes: 1 }),
    });
    await layer.ready;
    expect(layer.imageryLayers.map(s => s.status)).toEqual(['ok', 'failed', 'failed']);
    layer.dispose();
  });

  it('rejects HTML 404 image responses before decoding and retains the resident base', async () => {
    const decode = vi.fn(async () => ({ width: 264, height: 264, close() {} }));
    vi.stubGlobal('createImageBitmap', decode);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).includes('//optional/')
      ? new Response('<html>Not found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } })
      : new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } })));
    const layers = ['base', 'optional'].map(id => ({ type: 'cube' as const, id, url: `http://${id}/imagery.json` }));
    const layer = new CubeImageryLayer({ url: layers[0].url, layers, residentLevel: 0, retryFailedMs: 60_000 }, {
      fetchManifest: async () => ({ ...manifest(0), maxLevel: 0, tiles: faces.map(face => cubeTileId({ face, level: 0, x: 0, y: 0 })) }),
    });
    try {
      await layer.ready;
      const tileSet = new THREE.Group(), address = directionToTexel(southPole, 3, 256, 4).address;
      const { scene } = geometryTile(address); tileSet.add(scene); layer.addTile(scene, scene, address);
      const tick = async () => { layer.update(camera(3000), tileSet.matrixWorld, 0.001, null); await new Promise(r => setTimeout(r, 0)); };
      for (let i = 0; i < 10; i++) await tick();
      expect(layer.stats.failedTiles).toBe(1); // only the optional face actually in view is requested
      expect(layer.stats.baseUncoveredBlocks).toBe(0);
      expect(layer.stats.untexturedBlocks).toBe(0);
      expect(layer.stats.textures).toBe(6);
      expect(decode).toHaveBeenCalledTimes(6); // Only valid base responses reach the decoder.
      const requests = layer.stats.requests;
      for (let i = 0; i < 5; i++) await tick();
      expect(layer.stats.requests).toBe(requests);
    } finally { layer.dispose(); vi.unstubAllGlobals(); }
  });

  it('rejects a missing mandatory base even when the optional manifest is valid', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => String(url).includes('base')
      ? new Response('', { status: 404 }) : Response.json(manifest(1)));
    vi.stubGlobal('fetch', fetchMock);
    const layers = ['base', 'optional'].map(id => ({ type: 'cube' as const, id, url: `http://${id}/imagery.json` }));
    const layer = new CubeImageryLayer({ url: layers[0].url, layers });
    try {
      await expect(layer.ready).rejects.toThrow('HTTP 404');
      await Promise.resolve();
      expect(layer.stats.ready).toBe(false);
      expect(layer.manifest).toBeNull();
      expect(layer.stats.textures).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { layer.dispose(); vi.unstubAllGlobals(); }
  });

  it('bounds persistent optional 503 retries and explicitly recovers its manifest later', async () => {
    vi.useFakeTimers();
    let offline = true, optionalRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('optional')) { optionalRequests++; if (offline) return new Response('', { status: 503 }); }
      return Response.json(manifest(1));
    }));
    const layers = ['base', 'optional'].map(id => ({ type: 'cube' as const, id, url: `http://${id}/imagery.json` }));
    const layer = new CubeImageryLayer({ url: layers[0].url, layers }, {
      loadTexture: async () => ({ texture: new THREE.Texture(), bytes: 1, downloadBytes: 1 }),
    });
    try {
      await vi.runAllTimersAsync();
      await layer.ready;
      expect(layer.stats.ready).toBe(true);
      expect(layer.stats.textures).toBeGreaterThan(0);
      expect(layer.imageryLayers.map(s => s.status)).toEqual(['ok', 'failed']);
      expect(optionalRequests).toBe(4);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(optionalRequests).toBe(4);
      offline = false;
      layer.retryFailed(); layer.retryFailed(); // overlapping recovery calls share one request
      await vi.runAllTimersAsync();
      expect(optionalRequests).toBe(5);
      expect(layer.imageryLayers.map(s => s.status)).toEqual(['ok', 'idle']);
      const tileSet = new THREE.Group(), address = directionToTexel(southPole,3,256,4).address;
      const {scene}=geometryTile(address);tileSet.add(scene);layer.addTile(scene,scene,address);
      for(let i=0;i<5;i++) { layer.update(camera(3000),tileSet.matrixWorld,.001,null);await vi.runAllTimersAsync(); }
      expect(layer.imageryLayers.map(s => s.status)).toEqual(['ok', 'ok']);
    } finally { layer.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); }
  });


});
