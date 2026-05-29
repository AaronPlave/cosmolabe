/**
 * Catalog & kernel loading logic.
 *
 * Catalog-driven: a catalog file (URL or dropped JSON) declares its `require`
 * dependencies and `spiceKernels`. The resolver walks the require graph,
 * furnishes all referenced kernels (with `.tm` meta-kernels expanded), and
 * initializes the scene. There is no per-mission code path.
 */
import * as THREE from 'three';
import { Universe, loadCatalogFromUrl, type ResolvedCatalogGraph, type ResolvedKernel } from '@cosmolabe/core';
import { Spice, type SpiceInstance } from '@cosmolabe/spice';
import { UniverseRenderer, SpiceCacheWorker, ScreenshotPlugin, VideoRecordPlugin, OrbitalInfoPlugin } from '@cosmolabe/three';
import SpiceCacheRelayWorker from '../workers/spice-cache-relay.ts?worker';
import { parseMetaKernel } from './metakernel';
import {
  vs,
  bindRenderer,
  syncBodies,
  setSceneLoaded,
  setKernelCount,
  setLoadingState,
  selectBody,
  formatBytes,
} from './viewer-state.svelte';

// ── State ──
let spice: SpiceInstance | null = null;
let universe: Universe | null = null;
let renderer: UniverseRenderer | null = null;
let cacheWorker: SpiceCacheWorker | null = null;
const workerKernelUrls: string[] = [];
/** URLs of kernels already furnished in this session — prevents redundant fetch + furnish across demos. */
const furnishedKernels = new Set<string>();

const KERNEL_EXTENSIONS = new Set([
  '.bsp', '.tls', '.tpc', '.tf', '.tsc', '.ti', '.ck', '.bc', '.bpc', '.spk', '.pck', '.fk', '.tm',
]);
const MODEL_EXTENSIONS = new Set(['.gltf', '.glb', '.obj', '.cmod']);
const TEXTURE_EXTENSIONS = new Set(['.dds', '.jpg', '.jpeg', '.png', '.bmp', '.tga']);

const WORKER_KERNEL_EXTS = new Set(['.bsp', '.tls', '.tpc']);

function trackKernelForWorker(url: string): void {
  const lower = url.toLowerCase().replace(/\.gz$/, '');
  for (const ext of WORKER_KERNEL_EXTS) {
    if (lower.endsWith(ext)) {
      workerKernelUrls.push(new URL(url, location.href).href);
      return;
    }
  }
}

// ── Fetch with progress + gzip decompression ──

async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const isGz = url.endsWith('.gz');

  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onprogress = (e) => onProgress?.(e.loaded, e.lengthComputable ? e.total : 0);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as ArrayBuffer);
      else reject(new Error(`Fetch failed: ${url} (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error(`Network error: ${url}`));
    xhr.send();
  });

  if (!isGz) return buffer;

  // Check gzip magic bytes — if the server already decompressed, skip
  const header = new Uint8Array(buffer, 0, 2);
  if (header[0] !== 0x1f || header[1] !== 0x8b) return buffer;

  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array(buffer));
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

// ── Kernel pipeline ──

async function ensureSpice(): Promise<SpiceInstance> {
  if (!spice) {
    setLoadingState({ label: 'Initializing SPICE...' });
    spice = await Spice.init();
  }
  return spice;
}

function isLargeKernel(k: ResolvedKernel): boolean {
  return typeof k.size === 'number' && k.size > 1_000_000;
}

/** Furnish a single kernel URL. Handles `.gz` decompression. Tracks for cache worker. */
async function furnishKernelUrl(url: string, opts?: { size?: number; onProgress?: (loaded: number) => void }): Promise<void> {
  if (furnishedKernels.has(url)) return;
  const s = await ensureSpice();

  if (opts?.size && opts.size > 0) {
    const buffer = await fetchWithProgress(url, (loaded) => opts.onProgress?.(loaded));
    const filename = filenameFromUrl(url).replace(/\.gz$/, '');
    await s.furnish({ type: 'buffer', data: buffer, filename });
  } else {
    await s.furnish({ type: 'url', url });
  }
  furnishedKernels.add(url);
  trackKernelForWorker(url);
}

/** Resolve a meta-kernel (.tm) into a list of absolute kernel URLs. */
async function expandMetaKernel(metaUrl: string): Promise<string[]> {
  const resp = await fetch(metaUrl);
  if (!resp.ok) throw new Error(`Failed to fetch meta-kernel: ${metaUrl} (${resp.status})`);
  const text = await resp.text();
  const mk = parseMetaKernel(text);
  return mk.kernels.map(k => new URL(k, metaUrl).href);
}

/** Furnish every kernel referenced by a resolved catalog graph. */
async function furnishKernelsFromGraph(graph: ResolvedCatalogGraph): Promise<void> {
  // Expand any .tm meta-kernels first so we have the complete flat list.
  const flat: ResolvedKernel[] = [];
  for (const k of graph.kernels) {
    if (furnishedKernels.has(k.url)) continue;
    if (k.url.toLowerCase().endsWith('.tm')) {
      try {
        const expanded = await expandMetaKernel(k.url);
        for (const exp of expanded) flat.push({ url: exp });
      } catch (err) {
        console.warn(`[Cosmolabe] Failed to expand meta-kernel ${k.url}:`, err);
      }
    } else {
      flat.push(k);
    }
  }

  const small = flat.filter(k => !isLargeKernel(k));
  const large = flat.filter(k => isLargeKernel(k));

  for (const k of small) {
    setLoadingState({ label: `Loading ${k.label ?? filenameFromUrl(k.url)}...` });
    try {
      await furnishKernelUrl(k.url);
    } catch (err) {
      console.warn(`[Cosmolabe] Failed to load ${k.url}:`, err);
    }
  }

  if (large.length > 0) {
    const totalSize = large.reduce((s, k) => s + (k.size ?? 0), 0);
    let loadedSize = 0;
    setLoadingState({ show: true });

    for (let i = 0; i < large.length; i++) {
      const k = large[i];
      const progress = `(${i + 1}/${large.length})`;
      setLoadingState({ label: `${progress} ${k.label ?? filenameFromUrl(k.url)}` });
      try {
        await furnishKernelUrl(k.url, {
          size: k.size,
          onProgress: (loaded) => {
            setLoadingState({
              progress: ((loadedSize + loaded) / totalSize) * 100,
              detail: `${formatBytes(loadedSize + loaded)} / ${formatBytes(totalSize)}`,
            });
          },
        });
      } catch (err) {
        console.warn(`[Cosmolabe] Failed to load ${k.url}:`, err);
      }
      loadedSize += k.size ?? 0;
    }
    setLoadingState({ show: false });
  }

  setKernelCount(spice?.totalLoaded() ?? 0);
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.split('/').pop() || url;
  } catch {
    return url.split('/').pop() ?? url;
  }
}

// ── File handling ──

function isKernelFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return KERNEL_EXTENSIONS.has(ext);
}

async function collectFilesFromEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      (entry as FileSystemFileEntry).file(f => resolve([f]), () => resolve([]));
    });
  }
  if (entry.isDirectory) {
    const dirReader = (entry as FileSystemDirectoryEntry).createReader();
    const entries: FileSystemEntry[] = [];
    await new Promise<void>((resolve) => {
      const readBatch = () => {
        dirReader.readEntries((batch) => {
          if (batch.length === 0) { resolve(); return; }
          entries.push(...batch);
          readBatch();
        }, () => resolve());
      };
      readBatch();
    });
    const nested = await Promise.all(entries.map(e => collectFilesFromEntry(e)));
    return nested.flat();
  }
  return [];
}

async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  if (dataTransfer.items) {
    const entries: FileSystemEntry[] = [];
    for (const item of dataTransfer.items) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) {
      const nested = await Promise.all(entries.map(e => collectFilesFromEntry(e)));
      return nested.flat();
    }
  }
  return Array.from(dataTransfer.files);
}

interface LoadedFiles {
  jsonFiles: Map<string, { json: Record<string, unknown>; text: string }>;
  kernelFiles: File[];
  dataFiles: Map<string, string>;
  binaryFiles: Map<string, ArrayBuffer>;
  modelFiles: Map<string, string>;
}

async function categorizeFiles(files: File[]): Promise<LoadedFiles> {
  const jsonFiles = new Map<string, { json: Record<string, unknown>; text: string }>();
  const kernelFiles: File[] = [];
  const dataFiles = new Map<string, string>();
  const binaryFiles = new Map<string, ArrayBuffer>();
  const modelFiles = new Map<string, string>();

  for (const file of files) {
    const name = file.name.toLowerCase();
    const ext = name.slice(name.lastIndexOf('.'));
    if (name.endsWith('.json')) {
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        jsonFiles.set(file.name, { json, text });
      } catch { /* skip invalid JSON */ }
    } else if (isKernelFile(file.name)) {
      kernelFiles.push(file);
    } else if (name.endsWith('.xyzv') || name.endsWith('.xyz')) {
      const text = await file.text();
      dataFiles.set(file.name, text);
      const webkitPath = (file as any).webkitRelativePath;
      if (webkitPath) dataFiles.set(webkitPath, text);
    } else if (name.endsWith('.cheb')) {
      const buf = await file.arrayBuffer();
      const webkitPath = (file as any).webkitRelativePath;
      binaryFiles.set(file.name, buf);
      if (webkitPath) binaryFiles.set(webkitPath, buf);
    } else if (MODEL_EXTENSIONS.has(ext) || TEXTURE_EXTENSIONS.has(ext)) {
      const blobUrl = URL.createObjectURL(file);
      modelFiles.set(file.name, blobUrl);
      const webkitPath = (file as any).webkitRelativePath;
      if (webkitPath) modelFiles.set(webkitPath, blobUrl);
    }
  }
  return { jsonFiles, kernelFiles, dataFiles, binaryFiles, modelFiles };
}

function resolveCatalogOrder(
  jsonFiles: Map<string, { json: Record<string, unknown>; text: string }>,
): Record<string, unknown>[] {
  const ordered: Record<string, unknown>[] = [];
  const loaded = new Set<string>();

  function loadCatalog(name: string) {
    if (loaded.has(name)) return;
    loaded.add(name);
    const entry = jsonFiles.get(name);
    if (!entry) return;
    const requires = entry.json.require as string[] | undefined;
    if (requires) for (const dep of requires) loadCatalog(dep);
    if (entry.json.items && (entry.json.items as unknown[]).length > 0) ordered.push(entry.json);
  }

  for (const [name, entry] of jsonFiles) {
    if (entry.json.require) loadCatalog(name);
  }
  for (const [name] of jsonFiles) {
    if (!loaded.has(name)) loadCatalog(name);
  }
  return ordered;
}

// ── Scene initialization ──

function initScene(
  canvas: HTMLCanvasElement,
  catalogs: Record<string, unknown>[],
  dataFiles?: Map<string, string>,
  binaryFiles?: Map<string, ArrayBuffer>,
  modelFiles?: Map<string, string>,
) {
  // Clean up previous
  renderer?.dispose();
  universe?.dispose();

  const findInMap = <T>(map: Map<string, T>, source: string): T | undefined => {
    if (map.has(source)) return map.get(source);
    const basename = source.split('/').pop()!;
    for (const [key, value] of map) {
      if (key.endsWith(basename)) return value;
    }
    return undefined;
  };

  const resolveFile = dataFiles?.size ? (source: string) => findInMap(dataFiles, source) : undefined;
  const resolveFileBinary = binaryFiles?.size ? (source: string) => findInMap(binaryFiles, source) : undefined;

  universe = new Universe(
    spice ?? undefined,
    (resolveFile || resolveFileBinary) ? { resolveFile, resolveFileBinary } : undefined,
  );

  // Inject Cesium Ion token from VITE_CESIUM_ION_TOKEN into any `terrain` block
  // of type "cesium-ion" before the Universe parses the catalog. Keeps the
  // catalog files shareable (no token in source) — operator just sets the env
  // var in apps/viewer/.env.local once.
  const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;
  for (const json of catalogs) {
    injectCesiumIonToken(json, ionToken);
    universe.loadCatalog(json as any);
  }

  // Set initial time from catalog defaultTime. SPICE str2et needs the LSK kernel —
  // if it isn't loaded (e.g. TLE-only demos) the call throws; fall back to Date math
  // so a missing kernel doesn't silently leave the universe at J2000.
  for (const json of catalogs) {
    const dt = (json as Record<string, unknown>).defaultTime;
    if (typeof dt === 'string') {
      let et: number | undefined;
      if (spice) {
        try { et = spice.str2et(dt); } catch { /* fall through */ }
      }
      if (et === undefined) {
        const j2000Ms = Date.UTC(2000, 0, 1, 12, 0, 0);
        const ms = new Date(dt).getTime();
        if (!Number.isNaN(ms)) et = (ms - j2000Ms) / 1000;
      }
      if (et !== undefined) universe.setTime(et);
      else console.warn(`[Cosmolabe] Failed to parse defaultTime "${dt}"`);
      break;
    }
  }

  // Create cache worker
  cacheWorker?.dispose();
  cacheWorker = null;
  if (workerKernelUrls.length > 0) {
    try {
      cacheWorker = new SpiceCacheWorker(new SpiceCacheRelayWorker());
      cacheWorker.loadKernels([...workerKernelUrls]).catch((err) => {
        console.warn('[Cosmolabe] Cache worker kernel loading failed:', err);
      });
    } catch (err) {
      console.warn('[Cosmolabe] Failed to create cache worker:', err);
      cacheWorker = null;
    }
  }

  renderer = new UniverseRenderer(canvas, universe, {
    scaleFactor: 1e-6,
    showTrajectories: true,
    showLabels: true,
    showStars: true,
    starFieldOptions: { catalogUrl: `${import.meta.env.BASE_URL}stars.bin` },
    trajectoryOptions: { trailDuration: 86400 * 30 },
    minBodyPixels: 0,
    cacheWorker: cacheWorker ?? undefined,
    modelResolver: modelFiles?.size
      ? (source: string) => findInMap(modelFiles, source)
      : (source: string) => `./${source}`,
    bloom: { enabled: true },
  });

  renderer.camera.position.set(0, 300, 500);
  renderer.camera.lookAt(0, 0, 0);

  // Register stock plugins
  renderer.use(new ScreenshotPlugin());
  renderer.use(new VideoRecordPlugin());
  renderer.use(new OrbitalInfoPlugin());

  // Double-click a body → fly to it + select it for the info panel
  const r = renderer;
  r.events.on('body:dblclick', ({ bodyName }) => {
    const bm = r.getBodyMesh(bodyName);
    if (bm) r.cameraController.flyTo(bm, { scaleFactor: 1e-6 });
    selectBody(bodyName);
    // Update tracked body in reactive state (flyTo defers the actual
    // tracking to _pendingOriginSwitch, but UI needs to know now)
    vs.trackedBodyName = bodyName;
  });

  // Bind reactive state
  bindRenderer(renderer, universe);
  syncBodies(universe);
  setKernelCount(spice?.totalLoaded() ?? 0);

  // Load catalog viewpoints
  const scaleFactor = 1e-6;
  for (const vpDef of universe.viewpoints) {
    let pos: { x: number; y: number; z: number };
    if (vpDef.eye) {
      pos = { x: vpDef.eye[0] * scaleFactor, y: vpDef.eye[1] * scaleFactor, z: vpDef.eye[2] * scaleFactor };
    } else if (vpDef.distance != null) {
      const dist = vpDef.distance * scaleFactor;
      const lon = ((vpDef.longitude ?? 0) * Math.PI) / 180;
      const lat = ((vpDef.latitude ?? 0) * Math.PI) / 180;
      // Body-fixed Cartesian (Z = pole, X = prime meridian) at distance `dist`
      // in the direction of (lat, lon). This is the same convention trajectories
      // and pick-marker code use; the rotation below maps it to world coords.
      pos = {
        x: dist * Math.cos(lat) * Math.cos(lon),
        y: dist * Math.cos(lat) * Math.sin(lon),
        z: dist * Math.sin(lat),
      };
      // Viewpoint distance + lat/lon are intended as a body-fixed offset from
      // the tracked body (e.g. "Jezero Overhead" should point at Jezero on
      // Mars, not at random inertial coords that Mars no longer faces). Rotate
      // the position by the tracked body's (or its parent's) body-fixed →
      // inertial transform at defaultTime so the camera lands at the right
      // surface location.
      const refBody = vpDef.center ? universe.getBody(vpDef.center) : undefined;
      // For a body that itself spins (planet, moon), use the body's own rotation.
      // For a child of a spinning body (e.g. Ingenuity → Mars), use the parent's rotation.
      const spinBody = refBody?.rotation
        ? refBody
        : refBody?.parentName ? universe.getBody(refBody.parentName) : undefined;
      const q = spinBody?.rotationAt(universe.time);
      if (q) {
        // rotationAt returns inertial → body-fixed. Use conjugate to go the other way.
        const qw = q[0], qx = -q[1], qy = -q[2], qz = -q[3];
        const tx = 2 * (qy * pos.z - qz * pos.y);
        const ty = 2 * (qz * pos.x - qx * pos.z);
        const tz = 2 * (qx * pos.y - qy * pos.x);
        pos = {
          x: pos.x + qw * tx + (qy * tz - qz * ty),
          y: pos.y + qw * ty + (qz * tx - qx * tz),
          z: pos.z + qw * tz + (qx * ty - qy * tx),
        };
      }
    } else {
      pos = { x: 0, y: 300, z: 500 };
    }

    const tgt = vpDef.target
      ? new THREE.Vector3(vpDef.target[0] * scaleFactor, vpDef.target[1] * scaleFactor, vpDef.target[2] * scaleFactor)
      : new THREE.Vector3(0, 0, 0);
    const up = vpDef.up ? new THREE.Vector3(vpDef.up[0], vpDef.up[1], vpDef.up[2]).normalize() : new THREE.Vector3(0, 1, 0);

    renderer.cameraController.addViewpoint({
      name: vpDef.name,
      position: new THREE.Vector3(pos.x, pos.y, pos.z),
      target: tgt,
      up,
      trackBody: vpDef.center,
    });
  }
  renderer.cameraController.saveViewpoint('Default');

  // Apply default viewpoint
  if (universe.defaultViewpoint) {
    const vp = renderer.cameraController.getViewpoint(universe.defaultViewpoint);
    if (vp) {
      if (vp.trackBody) {
        const bm = renderer.getBodyMesh(vp.trackBody);
        if (bm) {
          renderer.cameraController.track(bm);
          renderer.cameraController.applyViewpoint(vp);
          if (vp.target.lengthSq() > 1e-30) renderer.cameraController.track(null);
        }
      } else {
        renderer.cameraController.goToViewpoint(universe.defaultViewpoint, 1.0);
      }
    }
  }

  setSceneLoaded(true);
  renderer.start();

  // Expose for console-based tuning during development.
  (window as unknown as { renderer: UniverseRenderer }).renderer = renderer;
}

// ── Public API for components ──

/** Load a demo catalog by name. The catalog drives kernel furnishing via `require` + `spiceKernels`. */
export async function loadDemo(canvas: HTMLCanvasElement, name: string) {
  setLoadingState({ label: `Loading ${name}...` });

  const entryUrl = new URL(`./${name}.json`, location.href).href;
  const graph = await loadCatalogFromUrl(entryUrl);

  // SPICE-free path: if the catalog graph declares no kernels, skip SPICE init
  // entirely. The CatalogLoader falls through to Keplerian/analytical trajectories.
  if (graph.kernels.length > 0) {
    await ensureSpice();
    await furnishKernelsFromGraph(graph);
  }

  const dataFiles = await fetchCatalogDataFiles(graph);
  initScene(canvas, graph.catalogs.map(c => c.json as Record<string, unknown>), dataFiles);
}

/**
 * Pre-fetch text data files referenced by trajectory specs (e.g. `.xyzv` for
 * InterpolatedStates). Drag-drop already populates a dataFiles map; URL-loaded
 * demos otherwise have no way to resolve relative `source:` paths.
 */
async function fetchCatalogDataFiles(graph: ResolvedCatalogGraph): Promise<Map<string, string> | undefined> {
  const refs: { absUrl: string; sourcePath: string }[] = [];
  for (const { url: catalogUrl, json } of graph.catalogs) {
    collectDataRefs(json as Record<string, unknown>, catalogUrl, refs);
  }
  if (refs.length === 0) return undefined;

  const files = new Map<string, string>();
  await Promise.all(refs.map(async ({ absUrl, sourcePath }) => {
    const res = await fetch(absUrl);
    if (!res.ok) {
      console.warn(`[Cosmolabe] Failed to fetch trajectory data ${absUrl}: ${res.status}`);
      return;
    }
    files.set(sourcePath, await res.text());
  }));
  return files;
}

/**
 * Walk a catalog tree and inject `cesiumIonToken` into any `terrain` block
 * whose `type` is `"cesium-ion"`. Token comes from VITE_CESIUM_ION_TOKEN.
 * If a terrain config already has its own token, leave it alone. If neither
 * is set, leave the field unset and let TerrainManager throw a clear error
 * later — that's better than silently swallowing here.
 */
function injectCesiumIonToken(node: unknown, token: string | undefined): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) injectCesiumIonToken(child, token);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.type === 'cesium-ion' && obj.cesiumIonToken == null && token) {
    obj.cesiumIonToken = token;
  }
  for (const value of Object.values(obj)) injectCesiumIonToken(value, token);
}

function collectDataRefs(
  node: unknown,
  baseUrl: string,
  out: { absUrl: string; sourcePath: string }[],
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectDataRefs(child, baseUrl, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.type === 'InterpolatedStates' && typeof obj.source === 'string') {
    out.push({ absUrl: new URL(obj.source, baseUrl).href, sourcePath: obj.source });
  }
  for (const value of Object.values(obj)) collectDataRefs(value, baseUrl, out);
}

/** Handle dropped files */
export async function handleDrop(canvas: HTMLCanvasElement, dataTransfer: DataTransfer) {
  const files = await collectDroppedFiles(dataTransfer);
  await handleFileList(canvas, files);
}

/** Handle file input selection */
export async function handleFileList(canvas: HTMLCanvasElement, files: File[]) {
  setLoadingState({ label: `Processing ${files.length} file(s)...` });
  const { jsonFiles, kernelFiles, dataFiles, binaryFiles, modelFiles } = await categorizeFiles(files);

  if (jsonFiles.size === 0 && kernelFiles.length === 0) return;

  if (kernelFiles.length > 0) {
    const s = await ensureSpice();
    for (const file of kernelFiles) {
      const buffer = await file.arrayBuffer();
      await s.furnish({ type: 'buffer', data: buffer, filename: file.name });
    }
    setKernelCount(s.totalLoaded());
  }

  if (jsonFiles.size > 0) {
    const catalogs = resolveCatalogOrder(jsonFiles);
    if (catalogs.length > 0) initScene(canvas, catalogs, dataFiles, binaryFiles, modelFiles);
  }
}

/** Get the current renderer instance */
export function getCurrentRenderer(): UniverseRenderer | null {
  return renderer;
}

/** Get the current SPICE instance */
export function getSpice(): SpiceInstance | null {
  return spice;
}

/** Resize the renderer */
export function resize(w: number, h: number) {
  renderer?.resize(w, h);
}
