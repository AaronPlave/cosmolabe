import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CubeImageryLayer } from '../CubeImageryLayer.js';
import { InThreadExecutor, SourceTileCache, VirtualCubeSource, WorkerExecutor, buildTileUrl, capabilitiesGrid, produceVirtualTile, type VirtualWorkerRequest, type VirtualWorkerReply, type VirtualSourceDescriptor } from '../VirtualCubeImagery.js';
import { cubeFaceToDirection, cubeTileAt, cubeTileId, type CubeFace } from '../surface/CubeSphere.js';
import { imageryTileRect, type CubeImageryManifest, type ImageryAddress } from '../surface/CubeImagery.js';
import type { DecodedSourceTile } from '../surface/ProjectedImagery.js';
import type { TerrainImageryConfig } from '../TerrainManager.js';

const R = 1737.4e3;
const tick = () => new Promise(r => setTimeout(r, 0));
const faces: CubeFace[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

/** A fake tile server: answers by URL, records requests, can hold or fail them. */
function server(answer: (url: string) => number = () => 200) {
  const requests: string[] = [];
  const held = new Map<string, () => void>();
  let hold = false;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (hold) await new Promise<void>((resolve, reject) => {
      held.set(url, resolve);
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    const status = answer(url);
    return new Response(status === 200 ? new Blob([url]) : null, { status });
  }) as unknown as typeof fetch;
  // One colour per URL day (or per URL), so pixels say which day was drawn.
  const decode = async (blob: Blob): Promise<DecodedSourceTile> => {
    const url = await blob.text();
    if (url.includes('corrupt')) throw new Error('corrupt PNG');
    const day = /\d{4}-\d{2}-(\d{2})/.exec(url)?.[1];
    const value = day ? Number(day) * 10 : 200;
    return { width: 4, height: 4, data: new Uint8ClampedArray(64).map((_, i) => (i % 4 === 3 ? 255 : value)) };
  };
  return { requests, fetchImpl, decode, held, setHold: (v: boolean) => { hold = v; }, release: () => { for (const r of held.values()) r(); held.clear(); } };
}

const XYZ: TerrainImageryConfig = { id: 'daily', type: 'xyz', projection: 'EPSG:3857', levels: 6, dimension: 4,
  url: 'https://tiles.test/Layer/default/2024-06-01/GoogleMapsCompatible/{z}/{y}/{x}.jpg' };
const options = (cache: SourceTileCache) => ({ tileSize: 8, gutter: 1, ellipsoid: null, radiusKm: 6371, executor: new InThreadExecutor(cache) });

describe('SourceTileCache', () => {
  it('shares a request between consumers and aborts it only when all abandon it', async () => {
    const s = server(); s.setHold(true);
    const cache = new SourceTileCache({ fetchImpl: s.fetchImpl, decode: s.decode });
    const a = new AbortController(), b = new AbortController();
    const first = cache.get('https://t/1', a.signal), second = cache.get('https://t/1', b.signal);
    await tick();
    expect(s.requests).toEqual(['https://t/1']);
    a.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(cache.stats.aborted).toBe(0);
    s.release();
    expect((await second).data![0]).toBe(200);
    expect(cache.stats).toMatchObject({ requests: 1, tiles: 1 });
    // A later reader is served from memory.
    await cache.get('https://t/1', new AbortController().signal);
    expect(cache.stats.hits).toBe(1);
    // Both consumers abandoning a request aborts it.
    s.setHold(true);
    const c = new AbortController(), d = new AbortController();
    const p1 = cache.get('https://t/2', c.signal).catch(e => e), p2 = cache.get('https://t/2', d.signal).catch(e => e);
    await tick(); c.abort(); d.abort();
    expect((await p1).name).toBe('AbortError'); expect((await p2).name).toBe('AbortError');
    expect(cache.stats.aborted).toBe(1);
  });

  it('caches declared gaps as transparent and remembers failures with backoff', async () => {
    const s = server(url => (url.endsWith('404') ? 404 : url.endsWith('500') ? 500 : 200));
    const cache = new SourceTileCache({ fetchImpl: s.fetchImpl, decode: s.decode, retryFailedMs: 60_000 });
    expect((await cache.get('https://t/404', new AbortController().signal)).data).toBeNull();
    expect(cache.stats.nodata).toBe(1);
    await expect(cache.get('https://t/500', new AbortController().signal)).rejects.toThrow('HTTP 500');
    const before = s.requests.length;
    await expect(cache.get('https://t/500', new AbortController().signal)).rejects.toThrow('HTTP 500');
    expect(s.requests.length).toBe(before); // within backoff: not requested again
    cache.retryFailed();
    await expect(cache.get('https://t/500', new AbortController().signal)).rejects.toThrow();
    expect(s.requests.length).toBeGreaterThan(before);
  }, 20_000);

  it('bounds concurrency and decoded bytes', async () => {
    const s = server(); s.setHold(true);
    const cache = new SourceTileCache({ fetchImpl: s.fetchImpl, decode: s.decode, maxConcurrent: 2, maxBytes: 64 * 3 });
    const all = Array.from({ length: 5 }, (_, i) => cache.get(`https://t/${i}`, new AbortController().signal));
    await tick();
    expect(s.requests.length).toBe(2);
    expect(cache.stats.queued).toBe(3);
    for (let i = 0; i < 5; i++) { s.release(); await tick(); await tick(); }
    await Promise.all(all);
    expect(s.requests.length).toBe(5);
    expect(cache.stats.residentBytes).toBeLessThanOrEqual(64 * 3);
    expect(cache.stats.evicted).toBe(2);
  });
});

describe('VirtualCubeSource', () => {
  it('produces registered tiles from the day it is given and never another', async () => {
    const s = server();
    const source = new VirtualCubeSource(XYZ, options(new SourceTileCache({ fetchImpl: s.fetchImpl, decode: s.decode })));
    source.setDate('2024-06-03');
    await source.ready;
    const result = await source.produce({ face: 'px', level: 2, x: 1, y: 2 }, new AbortController().signal);
    expect(s.requests.length).toBeGreaterThan(0);
    expect(s.requests.every(u => u.includes('/default/2024-06-03/'))).toBe(true);
    expect(result.data[0]).toBe(30);
    expect(result.data[3]).toBe(255);
    expect(source.coverage).toMatchObject({ kind: 'virtual', projection: 'mercator', nativeMatrix: '5', minLevel: 0 });
    // Retired mid-flight: a day change while fetching never yields the old day's pixels.
    s.setHold(true);
    const pending = source.produce({ face: 'px', level: 3, x: 3, y: 3 }, new AbortController().signal).catch(e => e);
    await tick();
    source.setDate('2024-06-04');
    s.release();
    expect((await pending).name).toBe('AbortError');
  });

  it('fails closed for a dated layer whose URL cannot carry the day', async () => {
    const s = server();
    const source = new VirtualCubeSource({ ...XYZ, url: 'https://tiles.test/static/{z}/{y}/{x}.jpg' }, options(new SourceTileCache({ fetchImpl: s.fetchImpl, decode: s.decode })));
    await source.ready;
    expect(() => source.setDate('2024-06-01')).toThrow(/cannot take effect/);
    // A capabilities source learns its template late; the day is checked when it arrives.
    const rad = Math.PI / 180;
    const capabilities = { layers: [{ identifier: 'Static', boundingBox: null, styles: [], dimensions: [],
      resourceUrls: [{ template: 'https://t/{TileMatrix}/{TileRow}/{TileCol}.jpg', resourceType: 'tile', format: 'image/jpeg' }],
      tileMatrixSets: [{ identifier: 'g', supportedCRS: 'EPSG:4326', tileMatrices: [{ identifier: '0', tileWidth: 4, tileHeight: 4, matrixWidth: 2, matrixHeight: 1, bounds: [-180 * rad, -90 * rad, 180 * rad, 90 * rad] }] }] }] };
    const early = new VirtualCubeSource({ type: 'wmts-capabilities', url: 'https://t/caps.xml' }, { ...options(new SourceTileCache({ fetchImpl: s.fetchImpl, decode: s.decode })),
      fetchCapabilities: async () => { await tick(); return capabilities as never; } });
    early.setDate('2024-06-01');
    await expect(early.ready).rejects.toThrow(/cannot take effect/);
  });

  it('draws a corrupt tile from its true parent, counted degraded, and fails when no parent loads', async () => {
    const s = server();
    const corrupt = (u: string) => /\/3\/\d+\/\d+/.test(u);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => s.fetchImpl(corrupt(String(input)) ? `${String(input)}#corrupt` : input, init)) as typeof fetch;
    const geographic: TerrainImageryConfig = { type: 'xyz', levels: 4, dimension: 4, url: 'https://t/{z}/{y}/{x}.png', latitudeConvention: 'planetocentric' };
    const source = new VirtualCubeSource(geographic, options(new SourceTileCache({ fetchImpl, decode: s.decode })));
    await source.ready;
    const address = cubeTileAt([1, 0.2, 0.1], 3);
    const result = await source.produce(address, new AbortController().signal);
    expect(result.matrix).toBe('3');
    expect(result.degradedTiles).toBeGreaterThan(0);
    expect(source.stats.degraded).toBe(1);
    const all = (async (input: RequestInfo | URL, init?: RequestInit) => s.fetchImpl(`${String(input)}#corrupt`, init)) as typeof fetch;
    const broken = new VirtualCubeSource(geographic, options(new SourceTileCache({ fetchImpl: all, decode: s.decode })));
    await expect(broken.produce(address, new AbortController().signal)).rejects.toThrow('corrupt');
  });

  it('builds a GIBS-style EPSG:4326 grid from capabilities, with its own matrices and time dimension', () => {
    const rad = Math.PI / 180;
    // GIBS 250m: level 0 is 2×1 tiles of 512 px at 0.5625°/px (576° wide, data in the first 360°).
    const tm = (id: string, w: number, h: number, deg: number) => ({ identifier: id, tileWidth: 512, tileHeight: 512, matrixWidth: w, matrixHeight: h,
      bounds: [-180 * rad, (90 - h * 512 * deg) * rad, (-180 + w * 512 * deg) * rad, 90 * rad] });
    const capabilities = { layers: [{ identifier: 'VIIRS', boundingBox: { bounds: [-180 * rad, -90 * rad, 180 * rad, 90 * rad] },
      resourceUrls: [{ template: 'https://gibs/wmts/epsg4326/best/VIIRS/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpg', resourceType: 'tile', format: 'image/jpeg' }],
      styles: [{ identifier: 'default', isDefault: true }], dimensions: [{ identifier: 'Time', defaultValue: '2026-11-26', values: [], uom: '', current: false }],
      tileMatrixSets: [{ identifier: '250m', supportedCRS: 'urn:ogc:def:crs:OGC:1.3:CRS84', tileMatrices: [tm('0', 2, 1, 0.5625), tm('1', 3, 2, 0.28125)] }] }] };
    const built = capabilitiesGrid(capabilities as never, { url: '', layer: 'VIIRS', tileMatrixSet: '250m' }, 'geodetic');
    expect(built.grid.projection).toBe('geographic');
    expect(built.grid.matrices[1]).toMatchObject({ cols: 3, rows: 2, x0: -180, y0: 90 });
    expect(built.grid.matrices[1].dx).toBeCloseTo(0.28125, 12);
    expect(buildTileUrl(built.url, built.grid.matrices[1], 2, 1, '2024-06-01')).toBe('https://gibs/wmts/epsg4326/best/VIIRS/default/2024-06-01/250m/1/1/2.jpg');
    expect(buildTileUrl(built.url, built.grid.matrices[0], 0, 0, undefined)).toContain('/default/2026-11-26/');
    expect(built.grid.bounds).toBeNull();
  });
});

describe('WorkerExecutor protocol', () => {
  /** The worker's message handler, run in-process behind a Worker-shaped object. */
  function fakeWorker(s: ReturnType<typeof server>) {
    const cache = new SourceTileCache({ fetchImpl: s.fetchImpl, decode: s.decode });
    const sources = new Map<string, VirtualSourceDescriptor>(), jobs = new Map<number, AbortController>();
    const posted: VirtualWorkerRequest[] = [];
    const worker = { onmessage: null as ((e: MessageEvent<VirtualWorkerReply>) => void) | null, onerror: null, terminate: vi.fn(),
      postMessage(msg: VirtualWorkerRequest) {
        posted.push(msg);
        if (msg.type === 'source') sources.set(msg.key, msg.source);
        else if (msg.type === 'abort') jobs.get(msg.id)?.abort();
        else if (msg.type === 'produce') {
          const c = new AbortController(); jobs.set(msg.id, c);
          produceVirtualTile(sources.get(msg.key)!, msg.address, msg.date, cache, c.signal)
            .then(result => worker.onmessage?.({ data: { type: 'tile', id: msg.id, result, stats: cache.stats } } as MessageEvent<VirtualWorkerReply>))
            .catch(e => worker.onmessage?.({ data: { type: 'error', id: msg.id, message: String(e?.message), aborted: e?.name === 'AbortError', stats: cache.stats } } as MessageEvent<VirtualWorkerReply>));
        }
      } };
    return { worker, posted };
  }

  it('sends each source once, returns tiles with the shared cache stats, and forwards aborts', async () => {
    const s = server(), { worker, posted } = fakeWorker(s);
    const executor = new WorkerExecutor(worker as unknown as Worker, { maxBytes: 1 << 20 });
    const source = new VirtualCubeSource(XYZ, { tileSize: 8, gutter: 1, ellipsoid: null, radiusKm: 6371, executor });
    source.setDate('2024-06-02');
    const tile = await source.produce({ face: 'px', level: 2, x: 1, y: 2 }, new AbortController().signal);
    await source.produce({ face: 'px', level: 2, x: 2, y: 2 }, new AbortController().signal);
    expect(tile.data[0]).toBe(20);
    expect(posted.filter(m => m.type === 'source')).toHaveLength(1);
    expect(executor.stats.requests).toBe(s.requests.length);
    s.setHold(true);
    const c = new AbortController();
    const pending = source.produce({ face: 'nx', level: 4, x: 9, y: 9 }, c.signal).catch(e => e); // uncached source tiles
    await tick(); c.abort();
    expect(posted.some(m => m.type === 'abort')).toBe(true);
    expect((await pending).name).toBe('AbortError');
    executor.dispose();
    expect(worker.terminate).toHaveBeenCalled();
  });
});

describe('WorkerExecutor pool routing', () => {
  it('keeps neighbouring tiles on one worker cache and spreads distant ones, with pooled stats', () => {
    const posted: Array<Array<{ type: string; address?: ImageryAddress }>> = [[], [], []];
    const workers = posted.map(log => ({ onmessage: null, onerror: null, terminate: vi.fn(), postMessage: (m: { type: string; address?: ImageryAddress }) => log.push(m) }));
    const executor = new WorkerExecutor(workers as unknown as Worker[], { maxBytes: 3 << 20, maxConcurrent: 9 });
    const source = { grid: null, url: { template: '', tms: false, dimensions: {} }, tileSize: 8, gutter: 1, ellipsoid: null, maxSourcePixels: 1 } as unknown as VirtualSourceDescriptor;
    const go = (a: ImageryAddress) => { void executor.produce('s', source, a, undefined, new AbortController().signal).catch(() => {}); };
    // Four siblings and their children share a level-(L−3) ancestor: one worker.
    for (let x = 64; x < 66; x++) for (let y = 64; y < 66; y++) go({ face: 'px', level: 10, x, y });
    const busy = posted.map(log => log.filter(m => m.type === 'produce').length);
    expect(busy.filter(n => n > 0)).toHaveLength(1);
    for (let i = 0; i < 24; i++) go({ face: (['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const)[i % 6], level: 10, x: i * 40, y: i * 13 });
    expect(posted.filter(log => log.some(m => m.type === 'produce')).length).toBeGreaterThan(1);
    // Budgets are split across the pool; stats are its totals.
    expect(posted.every(log => log[0].type === 'init')).toBe(true);
    expect(executor.stats.maxBytes).toBe(3 << 20);
    executor.dispose();
  });
});

/** A cube product listing every tile to level 1 (a base). */
function cubeManifest(): CubeImageryManifest {
  const tiles: string[] = [];
  for (const face of faces) for (let level = 0; level <= 1; level++) for (let x = 0; x < 2 ** level; x++) for (let y = 0; y < 2 ** level; y++) tiles.push(cubeTileId({ face, level, x, y }));
  return { format: 'cosmolabe-cube-imagery-1', source: { id: 'base', kind: 'imagery', version: 'v1' }, bodyId: 'Moon',
    registration: { crsId: 'cosmolabe:cube-gnomonic-1/IAU_MOON', pixelConvention: 'corner', registrationErrorKm: 0, resampling: 'test', footprint: 'test' },
    tileSize: 8, gutter: 1, encoding: 'png', colorSpace: 'srgb', minLevel: 0, maxLevel: 1, uri: 'tiles/{face}/{level}/{x}/{y}.png', tiles };
}

function geometryTile(a: ImageryAddress, n = 9): THREE.Group {
  const { u0, v0, size } = imageryTileRect(a);
  const pts: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pts.push(...cubeFaceToDirection(a.face, u0 + size * i / (n - 1), v0 + size * j / (n - 1)).map(c => c * R));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  const index: number[] = [];
  for (let j = 0; j + 1 < n; j++) for (let i = 0; i + 1 < n; i++) { const k = j * n + i; index.push(k, k + 1, k + n + 1, k, k + n + 1, k + n); }
  geometry.setIndex(index);
  const scene = new THREE.Group(); scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
  return scene;
}

describe('mixed cube + virtual imagery stack', () => {
  async function stack() {
    const s = server();
    const cache = new SourceTileCache({ fetchImpl: s.fetchImpl, decode: s.decode });
    const loadTexture = vi.fn(async () => ({ texture: new THREE.Texture(), bytes: 10 * 10 * 4 * 4 / 3, downloadBytes: 1 }));
    const layers: TerrainImageryConfig[] = [{ id: 'base', type: 'cube', url: 'http://test/imagery.json' }, XYZ];
    const layer = new CubeImageryLayer({ url: layers[0].url, layers, residentLevel: 0 }, { fetchManifest: async () => cubeManifest(), loadTexture, sourceCache: cache });
    const address = cubeTileAt([1, 0, 0], 2);
    const tileSet = new THREE.Group(), scene = geometryTile(address);
    tileSet.add(scene); layer.addTile(scene, scene, address);
    const cam = new THREE.PerspectiveCamera(60, 1.6, 1, 1e8);
    cam.position.set(R + 2_000_000, 0, 0); cam.up.set(0, 0, 1); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
    const frame = async (n = 1) => { for (let i = 0; i < n; i++) { layer.update(cam, tileSet.matrixWorld, 2 * Math.tan(Math.PI / 6) / 800, null); await tick(); await tick(); } };
    return { s, cache, layer, frame, loadTexture };
  }

  it('composes a cube product with a resampled XYZ layer under one budget and identity', async () => {
    const { s, layer, frame, loadTexture } = await stack();
    layer.setSourceDate('daily', '2024-06-02');
    await layer.ready;
    await frame(20);
    expect(loadTexture).toHaveBeenCalled(); // cube base pages
    expect(s.requests.length).toBeGreaterThan(0); // source tiles for the virtual layer
    expect(s.requests.every(u => u.includes('2024-06-02'))).toBe(true);
    const report = layer.virtualSources[0];
    expect(report).toMatchObject({ id: 'daily', date: '2024-06-02' });
    expect(report.stats.produced).toBeGreaterThan(0);
    expect(layer.stats.textures).toBeGreaterThan(1);
    expect(layer.stats.sourceCache!.requests).toBe(s.requests.length);
    const info = layer.imageryLayers.find(l => l.id === 'daily')!;
    expect(info.view?.zoomLevel).not.toBeNull();
  });

  it('switches days atomically: old work aborted, old pages released, only the new day requested', async () => {
    const { s, layer, frame } = await stack();
    layer.setSourceDate('daily', '2024-06-02');
    await layer.ready; await frame(20);
    const resident = layer.virtualSources[0].stats.produced;
    expect(resident).toBeGreaterThan(0);
    s.requests.length = 0;
    layer.setSourceDate('daily', '2024-06-05');
    expect(layer.imageryLayers.find(l => l.id === 'daily')!.requests).toBe(0);
    await frame(20);
    expect(s.requests.length).toBeGreaterThan(0);
    expect(s.requests.every(u => u.includes('2024-06-05'))).toBe(true);
    // No day: nothing requested, nothing drawn for the layer.
    s.requests.length = 0;
    layer.setSourceDate('daily', null);
    await frame(5);
    expect(s.requests).toEqual([]);
    expect(layer.sampleAt(cubeFaceToDirection('px', 0.1, 0.1) as [number, number, number])[1].enabled).toBe(0);
  });

  it('a failing virtual base leaves base coverage unproven, and recovers on explicit retry', async () => {
    let down = true;
    const s = server(() => (down ? 503 : 200));
    const cache = new SourceTileCache({ fetchImpl: s.fetchImpl, decode: s.decode, retryFailedMs: 60_000 });
    const layer = new CubeImageryLayer({ url: XYZ.url, layers: [{ ...XYZ, id: 'base' }], residentLevel: 0, virtualTileSize: 8, virtualGutter: 1, retryFailedMs: 60_000, maxSourcePixels: 16 * 4 * 4 }, { sourceCache: cache });
    const address = cubeTileAt([1, 0, 0], 2);
    const tileSet = new THREE.Group(), scene = geometryTile(address);
    tileSet.add(scene); layer.addTile(scene, scene, address);
    const cam = new THREE.PerspectiveCamera(60, 1.6, 1, 1e8);
    cam.position.set(R + 2_000_000, 0, 0); cam.up.set(0, 0, 1); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
    const frame = async (n = 1) => { for (let i = 0; i < n; i++) { layer.update(cam, tileSet.matrixWorld, 2 * Math.tan(Math.PI / 6) / 800, null); await tick(); await tick(); } };
    await layer.ready;
    await vi.waitFor(async () => { await frame(); expect(layer.stats.failures).toBeGreaterThan(0); }, { timeout: 15_000 });
    await frame(3);
    expect(layer.stats.baseUncoveredBlocks).toBeGreaterThan(0); // the static map stays: no unproven base
    expect(layer.imageryLayers[0].status).not.toBe('ok');
    down = false;
    layer.retryFailed();
    await vi.waitFor(async () => { await frame(); expect(layer.stats.baseUncoveredBlocks).toBe(0); }, { timeout: 15_000 });
    layer.dispose();
  }, 40_000);

  it('a hidden virtual layer requests nothing until switched on', async () => {
    const s = server();
    const cache = new SourceTileCache({ fetchImpl: s.fetchImpl, decode: s.decode });
    const layers: TerrainImageryConfig[] = [{ id: 'base', type: 'cube', url: 'http://test/imagery.json' }, { ...XYZ, visible: false }];
    const layer = new CubeImageryLayer({ url: layers[0].url, layers }, { fetchManifest: async () => cubeManifest(), loadTexture: async () => ({ texture: new THREE.Texture(), bytes: 1, downloadBytes: 1 }), sourceCache: cache });
    await layer.ready;
    expect(layer.virtualSources).toEqual([]); // not even its grid is set up
    expect(s.requests).toEqual([]);
    layer.dispose();
  });
});

describe('TerrainManager: dated non-cube layers over cube terrain', () => {
  const NO_RENDERER = undefined as unknown as THREE.WebGLRenderer;
  async function make(daily: Partial<TerrainImageryConfig>) {
    const { TerrainManager } = await import('../TerrainManager.js');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).endsWith('imagery.json') ? Response.json({ ...cubeManifest(), bodyId: 'Earth', registration: { ...cubeManifest().registration, crsId: 'cosmolabe:cube-gnomonic-1/IAU_EARTH' } }) : new Response('', { status: 404 })));
    return new TerrainManager({ type: '3dtiles', url: 'https://example.invalid/t/tileset.json', datum: { verticalDatum: 'reference-sphere', heightConvention: 'radial' },
      cubeSphere: { cpuGrids: 'https://example.invalid/t/cpu-grids.json', residentLevel: 0 },
      imagery: [{ id: 'base', type: 'cube', url: 'https://example.invalid/i/imagery.json' }, { ...XYZ, ...daily }] }, [6378.137, 6378.137, 6356.752], NO_RENDERER);
  }

  it('follows the simulation day through the cube renderer and reports it', async () => {
    const tm = await make({ temporal: { policy: 'follow-simulation', start: '2022-01-14', end: 'present', latencyDays: 1 } });
    try {
      await tm.cubeImageryLayer!.ready;
      expect(tm.cubeImageryLayer!.virtualSources[0].date).toBeNull(); // no clock yet: nothing requested
      tm.updateImageryTime(Date.parse('2024-03-09T17:00:00Z'), 0);
      await vi.waitFor(() => expect(tm.cubeImageryLayer!.virtualSources[0].date).toBe('2024-03-09'));
      expect(tm.imageryLayers.find(l => l.id === 'daily')!.temporal).toMatchObject({ policy: 'follow-simulation', date: '2024-03-09' });
      expect(tm.setImageryLayerTime('daily', { date: '2024-03-01' })).toBe(true);
      expect(tm.cubeImageryLayer!.virtualSources[0].date).toBe('2024-03-01');
      // Before the product's first day: none shown, none requested.
      expect(tm.setImageryLayerTime('daily', { date: '2020-01-01' })).toBe(true);
      expect(tm.cubeImageryLayer!.virtualSources[0].date).toBeNull();
    } finally { tm.dispose(); vi.unstubAllGlobals(); }
  });

  it('fails closed when a dated layer URL cannot carry the day', async () => {
    const tm = await make({ url: 'https://tiles.test/static/{z}/{y}/{x}.jpg', temporal: { policy: 'fixed', date: '2024-06-01' } });
    try {
      await tm.cubeImageryLayer!.ready.catch(() => {});
      await vi.waitFor(() => expect(tm.imageryLayers.find(l => l.id === 'daily')!.status).toBe('failed'));
      expect(tm.cubeImageryLayer!.virtualSources.find(v => v.id === 'daily')?.date ?? null).toBeNull();
    } finally { tm.dispose(); vi.unstubAllGlobals(); }
  });
});
