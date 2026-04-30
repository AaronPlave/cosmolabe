/**
 * Catalog & kernel loading logic — ported from legacy main.ts.
 *
 * Manages SPICE initialization, kernel fetching (with progress), file drops,
 * catalog dependency resolution, and scene creation.
 */
import * as THREE from 'three';
import { Universe } from '@cosmolabe/core';
import { Spice, type SpiceInstance } from '@cosmolabe/spice';
import { UniverseRenderer, SpiceCacheWorker, ScreenshotPlugin, OrbitalInfoPlugin } from '@cosmolabe/three';
import SpiceCacheRelayWorker from '../workers/spice-cache-relay.ts?worker';
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

const KERNEL_EXTENSIONS = new Set([
  '.bsp', '.tls', '.tpc', '.tf', '.tsc', '.ti', '.ck', '.bc', '.bpc', '.spk', '.pck', '.fk',
]);
const MODEL_EXTENSIONS = new Set(['.gltf', '.glb', '.obj', '.cmod']);
const TEXTURE_EXTENSIONS = new Set(['.dds', '.jpg', '.jpeg', '.png', '.bmp', '.tga']);

const NAIF_BASE = './kernels';
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

// ── Kernel sets ──

const NAIF_KERNELS = [
  { file: 'naif0012.tls', label: 'Leap seconds' },
  { file: 'pck00011.tpc', label: 'Body constants' },
  { file: 'de440s.bsp', label: 'Planets + Moon' },
];

const CASSINI_KERNELS_SMALL = [
  { file: 'cassini/cas_v43.tf', label: 'Cassini frames' },
  { file: 'cassini/cas00172.tsc', label: 'Cassini clock' },
  { file: 'cassini/cas_iss_v10.ti', label: 'ISS NAC/WAC' },
  { file: 'cassini/cas_vims_v06.ti', label: 'VIMS' },
  { file: 'cassini/cas_uvis_v07.ti', label: 'UVIS' },
  { file: 'cassini/cas_radar_v11.ti', label: 'RADAR' },
  { file: 'cassini/cas_cirs_v10.ti', label: 'CIRS' },
  { file: 'cassini/cas_caps_v03.ti', label: 'CAPS' },
  { file: 'cassini/04183_04185ra.bc', label: 'SOI attitude' },
];

const CASSINI_KERNELS_LARGE = [
  { file: 'cassini/040909R_SCPSE_01066_04199.bsp.gz', label: 'Trajectory (cruise–SOI)', size: 36_000_000 },
  { file: 'cassini/041219R_SCPSE_04199_04247.bsp.gz', label: 'Trajectory (post-SOI)', size: 4_500_000 },
  { file: 'cassini/050105RB_SCPSE_04247_04336.bsp.gz', label: 'Trajectory (Titan T-A)', size: 7_800_000 },
  { file: 'cassini/050214R_SCPSE_04336_05015.bsp.gz', label: 'Trajectory (Huygens)', size: 16_000_000 },
  { file: 'cassini/050411R_SCPSE_05015_05034.bsp.gz', label: 'Trajectory (Jan–Feb 05)', size: 7_300_000 },
  { file: 'cassini/050414R_SCPSE_05034_05060.bsp.gz', label: 'Trajectory (Feb–Mar 05)', size: 7_900_000 },
  { file: 'cassini/050504R_SCPSE_05060_05081.bsp.gz', label: 'Trajectory (Mar 05)', size: 4_500_000 },
  { file: 'cassini/050506R_SCPSE_05081_05097.bsp.gz', label: 'Trajectory (Mar–Apr 05)', size: 4_400_000 },
  { file: 'cassini/050513R_SCPSE_05097_05114.bsp.gz', label: 'Trajectory (Apr 05)', size: 4_200_000 },
  { file: 'cassini/050606R_SCPSE_05114_05132.bsp.gz', label: 'Trajectory (Apr–May 05)', size: 3_100_000 },
  { file: 'cassini/050623R_SCPSE_05132_05150.bsp.gz', label: 'Trajectory (May 05)', size: 2_500_000 },
  { file: 'cassini/050708R_SCPSE_05150_05169.bsp.gz', label: 'Trajectory (May–Jun 05)', size: 2_900_000 },
  { file: 'cassini/050802R_SCPSE_05169_05186.bsp.gz', label: 'Trajectory (Jun–Jul 05)', size: 2_700_000 },
  { file: 'cassini/050825R_SCPSE_05186_05205.bsp.gz', label: 'Trajectory (Enceladus E-2)', size: 2_500_000 },
  { file: 'cassini/04179_04183ra.bc.gz', label: 'SOI approach attitude', size: 10_000_000 },
  { file: 'cassini/04296_04301ra.bc.gz', label: 'Titan T-A attitude', size: 6_400_000 },
  { file: 'cassini/04356_04361ra.bc.gz', label: 'Huygens release attitude', size: 7_000_000 },
  { file: 'cassini/05012_05017ra.bc.gz', label: 'Huygens landing attitude', size: 6_400_000 },
  { file: 'cassini/05192_05197ra.bc.gz', label: 'Enceladus E-2 attitude', size: 6_600_000 },
];

const LRO_KERNELS = [
  { file: 'lro/lro_frames_2014049_v01.tf.gz', label: 'LRO frames', size: 45_000 },
  { file: 'lro/moon_080317.tf.gz', label: 'Lunar frames', size: 22_000 },
  { file: 'lro/moon_assoc_me.tf.gz', label: 'Lunar ME frame', size: 10_000 },
  { file: 'lro/lro_lroc_v20.ti.gz', label: 'LROC instruments', size: 74_000 },
  { file: 'lro/lro_lola_v00.ti.gz', label: 'LOLA instrument', size: 12_000 },
  { file: 'lro/lro_dlre_v05.ti.gz', label: 'Diviner instrument', size: 47_000 },
  { file: 'lro/lro_lamp_v03.ti.gz', label: 'LAMP instrument', size: 26_000 },
  { file: 'lro/lro_crater_v03.ti.gz', label: 'CRaTER instrument', size: 7_000 },
  { file: 'lro/lro_lend_v00.ti.gz', label: 'LEND instrument', size: 10_000 },
  { file: 'lro/lro_clkcor_2025351_v00.tsc.gz', label: 'LRO clock', size: 2_200_000 },
  { file: 'lro/lrorg_2024350_2025074_v01.bsp.gz', label: 'LRO trajectory', size: 7_200_000 },
  { file: 'lro/moon_pa_de421_1900_2050.bpc.gz', label: 'Lunar orientation', size: 1_700_000 },
];

const EUROPA_CLIPPER_KERNELS = [
  { file: 'europa-clipper/clipper_v16.tf', label: 'Clipper frames' },
  { file: 'europa-clipper/clipper_dyn_v06.tf', label: 'Clipper dynamic frames' },
  { file: 'europa-clipper/europaclipper_00227.tsc', label: 'Clipper clock' },
  { file: 'europa-clipper/gm_de440.tpc', label: 'GM values' },
  { file: 'europa-clipper/clipper_eis_v06.ti', label: 'EIS instruments' },
  { file: 'europa-clipper/clipper_ethemis_v06.ti', label: 'E-THEMIS instrument' },
  { file: 'europa-clipper/clipper_mise_v05.ti', label: 'MISE instrument' },
  { file: 'europa-clipper/clipper_uvs_v07.ti', label: 'UVS instrument' },
  { file: 'europa-clipper/ref_trj_scpse.bsp', label: 'Clipper trajectory (44 MB)' },
];

const MSL_KERNELS = [
  { file: 'msl/msl.tf', label: 'MSL frames' },
  { file: 'msl/msl_tp_ops120808_iau2000_v1.tf', label: 'MSL topocentric frame' },
  { file: 'msl/MSL_76_SCLKSCET.00012.tsc', label: 'MSL clock' },
  { file: 'msl/msl_ls_ops120808_iau2000_v1.bsp', label: 'MSL landing site' },
  { file: 'msl/msl_surf_rover_loc_0000_2003_v1.bsp', label: 'MSL site locations' },
  { file: 'msl/msl_surf_rover_tlm_0449_0583_v1.bsp', label: 'MSL rover position' },
  { file: 'msl/msl_surf_rover_tlm_0449_0583_v1.bc', label: 'MSL rover attitude' },
  { file: 'msl/mar099s.bsp', label: 'Mars satellite ephemeris (64 MB)' },
];

let naifLoaded = false;
let cassiniLoaded = false;
let lroLoaded = false;
let europaClipperLoaded = false;
let mslLoaded = false;

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

// ── Kernel loading ──

async function ensureSpice(): Promise<SpiceInstance> {
  if (!spice) {
    setLoadingState({ label: 'Initializing SPICE...' });
    spice = await Spice.init();
  }
  return spice;
}

async function loadNaifKernels(): Promise<void> {
  if (naifLoaded) return;
  const s = await ensureSpice();

  for (let i = 0; i < NAIF_KERNELS.length; i++) {
    const kernel = NAIF_KERNELS[i];
    setLoadingState({ label: `(${i + 1}/${NAIF_KERNELS.length}) Fetching ${kernel.label}...` });
    const url = `${NAIF_BASE}/${kernel.file}`;
    await s.furnish({ type: 'url', url });
    trackKernelForWorker(url);
  }
  naifLoaded = true;
  setKernelCount(s.totalLoaded());
}

async function loadKernelSet(
  kernels: { file: string; label: string; size?: number }[],
  flag: () => boolean,
  setFlag: () => void,
) {
  if (flag()) return;
  await loadNaifKernels();

  const small = kernels.filter(k => !k.size);
  const large = kernels.filter(k => k.size);

  // Small kernels: direct fetch
  for (const kernel of small) {
    setLoadingState({ label: `Loading ${kernel.label}...` });
    try {
      const url = `${NAIF_BASE}/${kernel.file}`;
      await spice!.furnish({ type: 'url', url });
      trackKernelForWorker(url);
    } catch (err) {
      console.error(`[Cosmolabe] Failed to load ${kernel.file}:`, err);
    }
  }

  // Large kernels: with progress
  if (large.length > 0) {
    const totalSize = large.reduce((s, k) => s + (k.size ?? 0), 0);
    let loadedSize = 0;
    setLoadingState({ show: true });

    for (let i = 0; i < large.length; i++) {
      const kernel = large[i];
      const progress = `(${i + 1}/${large.length})`;
      setLoadingState({ label: `${progress} ${kernel.label}` });

      try {
        const url = `${NAIF_BASE}/${kernel.file}`;
        const buffer = await fetchWithProgress(url, (loaded) => {
          setLoadingState({
            progress: ((loadedSize + loaded) / totalSize) * 100,
            detail: `${formatBytes(loadedSize + loaded)} / ${formatBytes(totalSize)}`,
          });
        });
        const filename = kernel.file.replace(/\.gz$/, '');
        await spice!.furnish({ type: 'buffer', data: buffer, filename });
        trackKernelForWorker(url);
      } catch (err) {
        console.error(`[Cosmolabe] Failed to load ${kernel.file}:`, err);
      }
      loadedSize += kernel.size ?? 0;
    }
    setLoadingState({ show: false });
  }

  setFlag();
  setKernelCount(spice!.totalLoaded());
}

async function loadCassiniKernels() {
  await loadKernelSet(
    [...CASSINI_KERNELS_SMALL, ...CASSINI_KERNELS_LARGE],
    () => cassiniLoaded,
    () => { cassiniLoaded = true; },
  );
}
async function loadLroKernels() {
  await loadKernelSet(LRO_KERNELS, () => lroLoaded, () => { lroLoaded = true; });
}
async function loadEuropaClipperKernels() {
  await loadKernelSet(EUROPA_CLIPPER_KERNELS, () => europaClipperLoaded, () => { europaClipperLoaded = true; });
}
async function loadMslKernels() {
  await loadKernelSet(MSL_KERNELS, () => mslLoaded, () => { mslLoaded = true; });
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

  for (const json of catalogs) {
    universe.loadCatalog(json as any);
  }

  // Set initial time from catalog defaultTime
  for (const json of catalogs) {
    const dt = (json as Record<string, unknown>).defaultTime;
    if (typeof dt === 'string') {
      try {
        let et: number;
        if (spice) {
          et = spice.str2et(dt);
        } else {
          const j2000Ms = Date.UTC(2000, 0, 1, 12, 0, 0);
          et = (new Date(dt).getTime() - j2000Ms) / 1000;
        }
        universe.setTime(et);
      } catch (e) {
        console.warn(`[Cosmolabe] Failed to parse defaultTime "${dt}":`, e);
      }
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
  });

  renderer.camera.position.set(0, 300, 500);
  renderer.camera.lookAt(0, 0, 0);

  // Register stock plugins
  renderer.use(new ScreenshotPlugin());
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
      pos = {
        x: dist * Math.cos(lat) * Math.cos(lon),
        y: dist * Math.sin(lat),
        z: dist * Math.cos(lat) * Math.sin(lon),
      };
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
}

// ── Public API for components ──

/** Load a demo catalog by name */
export async function loadDemo(canvas: HTMLCanvasElement, name: string) {
  setLoadingState({ label: `Loading ${name}...` });

  if (name === 'iss') {
    // TLE — no kernels
  } else if (name === 'cassini-soi') {
    await loadCassiniKernels();
  } else if (name === 'lro-moon') {
    await loadLroKernels();
  } else if (name === 'europa-clipper') {
    await loadEuropaClipperKernels();
  } else if (name === 'msl-dingo-gap') {
    await loadMslKernels();
  } else {
    await loadNaifKernels();
  }

  const resp = await fetch(`./${name}.json`);
  const json = await resp.json();
  initScene(canvas, [json]);
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
