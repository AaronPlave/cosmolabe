import * as THREE from "three";
import Stats from "three/examples/jsm/libs/stats.module.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { Universe } from "@cosmolabe/core";
import { Spice, type SpiceInstance } from "@cosmolabe/spice";
import { UniverseRenderer, rateLabel, CameraModeName, SpiceCacheWorker } from "@cosmolabe/three";


let universe: Universe | null = null;
let renderer: UniverseRenderer | null = null;
let spice: SpiceInstance | null = null;
let cacheWorker: SpiceCacheWorker | null = null;
/** Kernel URLs loaded into the main SPICE instance (SPK/LSK/PCK only, for worker). */
const workerKernelUrls: string[] = [];
let stats: Stats | null = null;
let transformGizmo: TransformControls | null = null;
let gizmoTarget: THREE.Object3D | null = null;
let gizmoWasPlaying = false;
const _gizmoSpiceQ = new THREE.Quaternion();

const KERNEL_EXTENSIONS = new Set([
  ".bsp",
  ".tls",
  ".tpc",
  ".tf",
  ".tsc",
  ".ti",
  ".ck",
  ".bc",
  ".bpc",
  ".spk",
  ".pck",
  ".fk",
]);

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const overlay = document.getElementById("drop-overlay")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const controls = document.getElementById("controls")!;
const btnPlay = document.getElementById("btn-play")!;
const btnReverse = document.getElementById("btn-reverse")!;
const btnStepBack = document.getElementById("btn-step-back")!;
const btnStepFwd = document.getElementById("btn-step-fwd")!;
const btnSlower = document.getElementById("btn-slower")!;
const btnFaster = document.getElementById("btn-faster")!;
const rateDisplay = document.getElementById("rate-display")!;
const timeDisplay = document.getElementById("time-display")!;
const timeScrubber = document.getElementById("time-scrubber") as HTMLInputElement;
const gotoTimePanel = document.getElementById("goto-time")!;
const gotoTimeInput = document.getElementById("goto-time-input") as HTMLInputElement;
const gotoTimeGo = document.getElementById("goto-time-go")!;
const gotoTimeClose = document.getElementById("goto-time-close")!;
const viewpointBar = document.getElementById("viewpoint-bar")!;
const viewpointSelect = document.getElementById("viewpoint-select") as HTMLSelectElement;
const btnSaveVp = document.getElementById("btn-save-vp")!;
const btnFlyTracked = document.getElementById("btn-fly-tracked")!;
const infoPanel = document.getElementById("info-panel")!;
const cameraStatus = document.getElementById("camera-status")!;
const fovSlider = document.getElementById("fov-slider") as HTMLInputElement;
const fovDisplay = document.getElementById("fov-display")!;
const bodyList = document.getElementById("body-list")!;
const btnLoadNaif = document.getElementById("btn-load-naif")!;
const chkGrid = document.getElementById("chk-grid") as HTMLInputElement;
const chkAxes = document.getElementById("chk-axes") as HTMLInputElement;
const chkStats = document.getElementById("chk-stats") as HTMLInputElement;
const chkTraj = document.getElementById("chk-traj") as HTMLInputElement;
const chkLabels = document.getElementById("chk-labels") as HTMLInputElement;
const selLighting = document.getElementById("sel-lighting") as HTMLSelectElement;
const selInstrument = document.getElementById("sel-instrument") as HTMLSelectElement;
const instrumentViewLabel = document.getElementById("instrument-view-label")!;
const selCamMode = document.getElementById("sel-cam-mode") as HTMLSelectElement;
const pickBtn = document.getElementById("pick-btn")!;
const pickResult = document.getElementById("pick-result")!;
const pickResultBody = document.getElementById("pick-result-body")!;
const pickResultClose = document.getElementById("pick-result-close")!;
const pickLat = document.getElementById("pick-lat")!;
const pickLon = document.getElementById("pick-lon")!;
const pickAlt = document.getElementById("pick-alt")!;
const loadingBar = document.getElementById("loading-bar")!;
const loadingFill = document.getElementById("loading-fill")!;
const loadingLabel = document.getElementById("loading-label")!;
const loadingDetail = document.getElementById("loading-detail")!;

// --- Loading bar helpers ---

function showLoadingBar() {
  loadingBar.classList.add("visible");
}

function hideLoadingBar() {
  loadingBar.classList.remove("visible");
}

function updateLoadingBar(pct: number, label: string, detail?: string) {
  loadingFill.style.width = `${Math.min(100, pct)}%`;
  loadingLabel.textContent = label;
  loadingDetail.textContent = detail ?? "";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Fetch a URL with download progress tracking, auto-decompress .gz files */
async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const isGz = url.endsWith(".gz");

  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.onprogress = (e) => {
      if (onProgress) {
        onProgress(e.loaded, e.lengthComputable ? e.total : 0);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as ArrayBuffer);
      } else {
        reject(new Error(`Fetch failed: ${url} (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error(`Network error: ${url}`));
    xhr.send();
  });

  if (!isGz) return buffer;

  // Check gzip magic bytes — if the server already decompressed transparently, skip
  const header = new Uint8Array(buffer, 0, 2);
  if (header[0] !== 0x1f || header[1] !== 0x8b) {
    console.log(`[Cosmolabe] ${url} already decompressed by server`);
    return buffer;
  }

  // Decompress gzipped kernel
  const ds = new DecompressionStream("gzip");
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

// --- NAIF Generic Kernels ---

// Serve from local public/kernels/ directory (fetched by scripts/fetch-kernels.sh)
const NAIF_BASE = "./kernels";

/** Extensions of kernel types needed by the trajectory cache worker (SPK, LSK, PCK). */
const WORKER_KERNEL_EXTS = new Set(['.bsp', '.tls', '.tpc']);

/** Track a kernel URL for the cache worker if it's SPK/LSK/PCK.
 *  Converts to absolute URL so the worker (whose base URL differs) can fetch it. */
function trackKernelForWorker(url: string): void {
  const lower = url.toLowerCase().replace(/\.gz$/, '');
  for (const ext of WORKER_KERNEL_EXTS) {
    if (lower.endsWith(ext)) {
      workerKernelUrls.push(new URL(url, location.href).href);
      return;
    }
  }
}

/** Standard NAIF generic kernel set for solar system visualization (1950-2050) */
// Only reasonably-sized kernels — satellite kernels are 100MB-1GB each,
// so moon positions use analytical theories (TASS17, L1, Gust86, MarsSat) instead.
const NAIF_KERNELS = [
  { file: "naif0012.tls", label: "Leap seconds" },
  { file: "pck00011.tpc", label: "Body constants" },
  { file: "de440s.bsp", label: "Planets + Moon" },
];

/** Cassini-specific kernels — continuous reconstructed coverage Jun 2004 – Jul 2005.
 *  Small text kernels (FK, SCLK, IK) are fetched directly.
 *  Large binary kernels (SPK, CK) are gzipped and fetched with progress bar.
 *  Run scripts/fetch-cassini-kernels.sh to download the gzipped files. */
const CASSINI_KERNELS_SMALL = [
  { file: "cassini/cas_v43.tf", label: "Cassini frames" },
  { file: "cassini/cas00172.tsc", label: "Cassini clock" },
  // Instrument kernels — FOV definitions for sensor visualization
  { file: "cassini/cas_iss_v10.ti", label: "ISS NAC/WAC" },
  { file: "cassini/cas_vims_v06.ti", label: "VIMS" },
  { file: "cassini/cas_uvis_v07.ti", label: "UVIS" },
  { file: "cassini/cas_radar_v11.ti", label: "RADAR" },
  { file: "cassini/cas_cirs_v10.ti", label: "CIRS" },
  { file: "cassini/cas_caps_v03.ti", label: "CAPS" },
  // SOI attitude (existing, small enough for direct fetch)
  { file: "cassini/04183_04185ra.bc", label: "SOI attitude" },
];

const CASSINI_KERNELS_LARGE = [
  // SPK — Continuous reconstructed chain: through Jul 24, 2005
  { file: "cassini/040909R_SCPSE_01066_04199.bsp.gz", label: "Trajectory (cruise–SOI)", size: 36_000_000 },
  { file: "cassini/041219R_SCPSE_04199_04247.bsp.gz", label: "Trajectory (post-SOI)", size: 4_500_000 },
  { file: "cassini/050105RB_SCPSE_04247_04336.bsp.gz", label: "Trajectory (Titan T-A)", size: 7_800_000 },
  { file: "cassini/050214R_SCPSE_04336_05015.bsp.gz", label: "Trajectory (Huygens)", size: 16_000_000 },
  { file: "cassini/050411R_SCPSE_05015_05034.bsp.gz", label: "Trajectory (Jan–Feb 05)", size: 7_300_000 },
  { file: "cassini/050414R_SCPSE_05034_05060.bsp.gz", label: "Trajectory (Feb–Mar 05)", size: 7_900_000 },
  { file: "cassini/050504R_SCPSE_05060_05081.bsp.gz", label: "Trajectory (Mar 05)", size: 4_500_000 },
  { file: "cassini/050506R_SCPSE_05081_05097.bsp.gz", label: "Trajectory (Mar–Apr 05)", size: 4_400_000 },
  { file: "cassini/050513R_SCPSE_05097_05114.bsp.gz", label: "Trajectory (Apr 05)", size: 4_200_000 },
  { file: "cassini/050606R_SCPSE_05114_05132.bsp.gz", label: "Trajectory (Apr–May 05)", size: 3_100_000 },
  { file: "cassini/050623R_SCPSE_05132_05150.bsp.gz", label: "Trajectory (May 05)", size: 2_500_000 },
  { file: "cassini/050708R_SCPSE_05150_05169.bsp.gz", label: "Trajectory (May–Jun 05)", size: 2_900_000 },
  { file: "cassini/050802R_SCPSE_05169_05186.bsp.gz", label: "Trajectory (Jun–Jul 05)", size: 2_700_000 },
  { file: "cassini/050825R_SCPSE_05186_05205.bsp.gz", label: "Trajectory (Enceladus E-2)", size: 2_500_000 },
  // CK — Reconstructed attitude for key event windows
  { file: "cassini/04179_04183ra.bc.gz", label: "SOI approach attitude", size: 10_000_000 },
  { file: "cassini/04296_04301ra.bc.gz", label: "Titan T-A attitude", size: 6_400_000 },
  { file: "cassini/04356_04361ra.bc.gz", label: "Huygens release attitude", size: 7_000_000 },
  { file: "cassini/05012_05017ra.bc.gz", label: "Huygens landing attitude", size: 6_400_000 },
  { file: "cassini/05192_05197ra.bc.gz", label: "Enceladus E-2 attitude", size: 6_600_000 },
];

/** LRO-specific kernels (orbit around Moon, Jan 1 – Feb 1 2025)
 *  Files are gzipped — fetched with progress and decompressed client-side.
 *  Small kernels first (frames, instruments), then large ones (SPK, CK, PCK). */
const LRO_KERNELS = [
  // Frame definitions
  { file: "lro/lro_frames_2014049_v01.tf.gz", label: "LRO frames", size: 45_000 },
  { file: "lro/moon_080317.tf.gz", label: "Lunar frames", size: 22_000 },
  { file: "lro/moon_assoc_me.tf.gz", label: "Lunar ME frame", size: 10_000 },
  // Instrument FOVs
  { file: "lro/lro_lroc_v20.ti.gz", label: "LROC instruments", size: 74_000 },
  { file: "lro/lro_lola_v00.ti.gz", label: "LOLA instrument", size: 12_000 },
  { file: "lro/lro_dlre_v05.ti.gz", label: "Diviner instrument", size: 47_000 },
  { file: "lro/lro_lamp_v03.ti.gz", label: "LAMP instrument", size: 26_000 },
  { file: "lro/lro_crater_v03.ti.gz", label: "CRaTER instrument", size: 7_000 },
  { file: "lro/lro_lend_v00.ti.gz", label: "LEND instrument", size: 10_000 },
  // Spacecraft clock (required for CK attitude)
  { file: "lro/lro_clkcor_2025351_v00.tsc.gz", label: "LRO clock", size: 2_200_000 },
  // Trajectory
  { file: "lro/lrorg_2024350_2025074_v01.bsp.gz", label: "LRO trajectory", size: 7_200_000 },
  // High-accuracy lunar orientation
  { file: "lro/moon_pa_de421_1900_2050.bpc.gz", label: "Lunar orientation", size: 1_700_000 },
  // Reconstructed spacecraft bus attitude (CK ID -85000, covers Jan 11–21 2025)
  { file: "lro/lrosc_2025011_2025021_v01.bc.gz", label: "LRO bus attitude (CK)", size: 554_000_000 },
];

/** Europa Clipper kernels (Jupiter science phase, 2030–2034) */
const EUROPA_CLIPPER_KERNELS = [
  { file: "europa-clipper/clipper_v16.tf", label: "Clipper frames" },
  { file: "europa-clipper/clipper_dyn_v06.tf", label: "Clipper dynamic frames" },
  { file: "europa-clipper/europaclipper_00227.tsc", label: "Clipper clock" },
  { file: "europa-clipper/gm_de440.tpc", label: "GM values" },
  { file: "europa-clipper/clipper_eis_v06.ti", label: "EIS instruments" },
  { file: "europa-clipper/clipper_ethemis_v06.ti", label: "E-THEMIS instrument" },
  { file: "europa-clipper/clipper_mise_v05.ti", label: "MISE instrument" },
  { file: "europa-clipper/clipper_uvs_v07.ti", label: "UVS instrument" },
  { file: "europa-clipper/ref_trj_scpse.bsp", label: "Clipper trajectory (44 MB)" },
];

/** MSL (Curiosity) kernels — Dingo Gap timeframe (sols 449–583, Nov 2013 – Mar 2014) */
const MSL_KERNELS = [
  { file: "msl/msl.tf", label: "MSL frames" },
  { file: "msl/msl_tp_ops120808_iau2000_v1.tf", label: "MSL topocentric frame" },
  { file: "msl/MSL_76_SCLKSCET.00012.tsc", label: "MSL clock" },
  { file: "msl/msl_ls_ops120808_iau2000_v1.bsp", label: "MSL landing site" },
  { file: "msl/msl_surf_rover_loc_0000_2003_v1.bsp", label: "MSL site locations" },
  { file: "msl/msl_surf_rover_tlm_0449_0583_v1.bsp", label: "MSL rover position" },
  { file: "msl/msl_surf_rover_tlm_0449_0583_v1.bc", label: "MSL rover attitude" },
  { file: "msl/mar099s.bsp", label: "Mars satellite ephemeris (64 MB)" },
];

let naifLoaded = false;
let cassiniLoaded = false;
let lroLoaded = false;
let europaClipperLoaded = false;
let mslLoaded = false;

async function loadNaifKernels(): Promise<void> {
  if (naifLoaded) return;

  if (!spice) {
    infoPanel.textContent = "Initializing SPICE...";
    spice = await Spice.init();
  }

  btnLoadNaif.textContent = "Loading...";
  (btnLoadNaif as HTMLButtonElement).disabled = true;

  for (let i = 0; i < NAIF_KERNELS.length; i++) {
    const kernel = NAIF_KERNELS[i];
    const progress = `(${i + 1}/${NAIF_KERNELS.length})`;
    infoPanel.textContent = `${progress} Fetching ${kernel.label}...`;
    btnLoadNaif.textContent = `Loading ${progress} ${kernel.label}...`;
    console.log(`[Cosmolabe] Fetching NAIF kernel: ${kernel.file}`);

    try {
      const url = `${NAIF_BASE}/${kernel.file}`;
      await spice.furnish({ type: "url", url });
      trackKernelForWorker(url);
    } catch (err) {
      console.error(`[Cosmolabe] Failed to load ${kernel.file}:`, err);
      infoPanel.textContent = `Failed to load ${kernel.label} — CORS or network error`;
      btnLoadNaif.textContent = "Load NAIF Generic Kernels (retry)";
      (btnLoadNaif as HTMLButtonElement).disabled = false;
      return;
    }
  }

  naifLoaded = true;
  btnLoadNaif.textContent = "NAIF Kernels Loaded";
  infoPanel.textContent = `${spice.totalLoaded()} NAIF kernel(s) loaded — drop catalogs or use demos`;
  console.log(
    `[Cosmolabe] All NAIF generic kernels loaded (${spice.totalLoaded()} total)`,
  );
}

async function loadCassiniKernels(): Promise<void> {
  if (cassiniLoaded) return;
  await loadNaifKernels(); // Need generic kernels first

  // Phase 1: small text kernels (FK, SCLK, IK, existing SOI SPK+CK) — direct fetch
  for (const kernel of CASSINI_KERNELS_SMALL) {
    infoPanel.textContent = `Loading ${kernel.label}...`;
    console.log(`[Cosmolabe] Fetching Cassini kernel: ${kernel.file}`);
    try {
      const url = `${NAIF_BASE}/${kernel.file}`;
      await spice!.furnish({ type: "url", url });
      trackKernelForWorker(url);
    } catch (err) {
      console.error(`[Cosmolabe] Failed to load ${kernel.file}:`, err);
    }
  }

  // Phase 2: large gzipped kernels (extended SPK+CK) — with progress bar
  if (CASSINI_KERNELS_LARGE.length > 0) {
    const totalSize = CASSINI_KERNELS_LARGE.reduce((s, k) => s + k.size, 0);
    let loadedSize = 0;
    showLoadingBar();

    for (let i = 0; i < CASSINI_KERNELS_LARGE.length; i++) {
      const kernel = CASSINI_KERNELS_LARGE[i];
      const progress = `(${i + 1}/${CASSINI_KERNELS_LARGE.length})`;
      infoPanel.textContent = `${progress} Loading ${kernel.label}...`;
      console.log(`[Cosmolabe] Fetching Cassini kernel: ${kernel.file}`);

      try {
        const url = `${NAIF_BASE}/${kernel.file}`;
        const buffer = await fetchWithProgress(
          url,
          (loaded, _total) => {
            const currentPct = ((loadedSize + loaded) / totalSize) * 100;
            updateLoadingBar(
              currentPct,
              `${progress} ${kernel.label}`,
              `${formatBytes(loadedSize + loaded)} / ${formatBytes(totalSize)}`,
            );
          },
        );
        const filename = kernel.file.replace(/\.gz$/, "");
        await spice!.furnish({ type: "buffer", data: buffer, filename });
        trackKernelForWorker(url);
      } catch (err) {
        console.error(`[Cosmolabe] Failed to load ${kernel.file}:`, err);
      }
      loadedSize += kernel.size;
      updateLoadingBar(
        (loadedSize / totalSize) * 100,
        `${progress} ${kernel.label} loaded`,
        `${formatBytes(loadedSize)} / ${formatBytes(totalSize)}`,
      );
    }

    hideLoadingBar();
  }

  cassiniLoaded = true;
  console.log(`[Cosmolabe] Cassini kernels loaded (${spice!.totalLoaded()} total)`);
}

async function loadLroKernels(): Promise<void> {
  if (lroLoaded) return;
  await loadNaifKernels(); // Need generic kernels first

  const totalSize = LRO_KERNELS.reduce((s, k) => s + k.size, 0);
  let loadedSize = 0;
  showLoadingBar();

  for (let i = 0; i < LRO_KERNELS.length; i++) {
    const kernel = LRO_KERNELS[i];
    const progress = `(${i + 1}/${LRO_KERNELS.length})`;
    infoPanel.textContent = `${progress} Loading ${kernel.label}...`;
    console.log(`[Cosmolabe] Fetching LRO kernel: ${kernel.file}`);

    try {
      const url = `${NAIF_BASE}/${kernel.file}`;
      const buffer = await fetchWithProgress(
        url,
        (loaded, _total) => {
          const currentPct = ((loadedSize + loaded) / totalSize) * 100;
          updateLoadingBar(
            currentPct,
            `${progress} ${kernel.label}`,
            `${formatBytes(loadedSize + loaded)} / ${formatBytes(totalSize)}`,
          );
        },
      );
      // Strip .gz from filename for SPICE kernel type detection
      const filename = kernel.file.replace(/\.gz$/, "");
      await spice!.furnish({ type: "buffer", data: buffer, filename });
      trackKernelForWorker(url);
    } catch (err) {
      console.error(`[Cosmolabe] Failed to load ${kernel.file}:`, err);
    }
    loadedSize += kernel.size;
    updateLoadingBar((loadedSize / totalSize) * 100, `${progress} ${kernel.label} loaded`, `${formatBytes(loadedSize)} / ${formatBytes(totalSize)}`);
  }

  hideLoadingBar();
  lroLoaded = true;
  console.log(`[Cosmolabe] LRO kernels loaded (${spice!.totalLoaded()} total)`);
}

async function loadEuropaClipperKernels(): Promise<void> {
  if (europaClipperLoaded) return;
  await loadNaifKernels(); // Need generic kernels first
  for (let i = 0; i < EUROPA_CLIPPER_KERNELS.length; i++) {
    const kernel = EUROPA_CLIPPER_KERNELS[i];
    const progress = `(${i + 1}/${EUROPA_CLIPPER_KERNELS.length})`;
    infoPanel.textContent = `${progress} Loading ${kernel.label}...`;
    console.log(`[Cosmolabe] Fetching Europa Clipper kernel: ${kernel.file}`);
    try {
      const url = `${NAIF_BASE}/${kernel.file}`;
      await spice!.furnish({ type: "url", url });
      trackKernelForWorker(url);
    } catch (err) {
      console.error(`[Cosmolabe] Failed to load ${kernel.file}:`, err);
    }
  }
  europaClipperLoaded = true;
  console.log(`[Cosmolabe] Europa Clipper kernels loaded (${spice!.totalLoaded()} total)`);
}

async function loadMslKernels(): Promise<void> {
  if (mslLoaded) return;
  await loadNaifKernels();
  for (const kernel of MSL_KERNELS) {
    infoPanel.textContent = `Loading ${kernel.label}...`;
    console.log(`[Cosmolabe] Fetching MSL kernel: ${kernel.file}`);
    try {
      await spice!.furnish({ type: "url", url: `${NAIF_BASE}/${kernel.file}` });
    } catch (err) {
      console.error(`[Cosmolabe] Failed to load ${kernel.file}:`, err);
    }
  }
  mslLoaded = true;
  console.log(`[Cosmolabe] MSL kernels loaded (${spice!.totalLoaded()} total)`);
}

btnLoadNaif.addEventListener("click", (e) => {
  e.stopPropagation();
  loadNaifKernels();
});

// --- File handling ---

function isKernelFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return KERNEL_EXTENSIONS.has(ext);
}

/** Recursively collect all files from a dropped directory entry */
async function collectFilesFromEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      (entry as FileSystemFileEntry).file(
        (f) => resolve([f]),
        () => resolve([]),
      );
    });
  }
  if (entry.isDirectory) {
    const dirReader = (entry as FileSystemDirectoryEntry).createReader();
    const entries: FileSystemEntry[] = [];
    // readEntries returns in batches, must call until empty
    await new Promise<void>((resolve) => {
      const readBatch = () => {
        dirReader.readEntries(
          (batch) => {
            if (batch.length === 0) {
              resolve();
              return;
            }
            entries.push(...batch);
            readBatch();
          },
          () => resolve(),
        );
      };
      readBatch();
    });
    const nested = await Promise.all(
      entries.map((e) => collectFilesFromEntry(e)),
    );
    return nested.flat();
  }
  return [];
}

/** Collect files from a drop event, supporting both flat file lists and directories */
async function collectDroppedFiles(
  dataTransfer: DataTransfer,
): Promise<File[]> {
  // Try directory-aware API first
  if (dataTransfer.items) {
    const entries: FileSystemEntry[] = [];
    for (const item of dataTransfer.items) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) {
      const nested = await Promise.all(
        entries.map((e) => collectFilesFromEntry(e)),
      );
      return nested.flat();
    }
  }
  // Fallback to flat file list
  return Array.from(dataTransfer.files);
}

const MODEL_EXTENSIONS = new Set([".gltf", ".glb", ".obj", ".cmod"]);
const TEXTURE_EXTENSIONS = new Set([".dds", ".jpg", ".jpeg", ".png", ".bmp", ".tga"]);

interface LoadedFiles {
  jsonFiles: Map<string, { json: Record<string, unknown>; text: string }>;
  kernelFiles: File[];
  dataFiles: Map<string, string>; // .xyzv and other data files by relative name
  binaryFiles: Map<string, ArrayBuffer>; // .cheb and other binary data files
  modelFiles: Map<string, string>; // model files by name → blob URL
}

async function categorizeFiles(files: File[]): Promise<LoadedFiles> {
  const jsonFiles = new Map<
    string,
    { json: Record<string, unknown>; text: string }
  >();
  const kernelFiles: File[] = [];
  const dataFiles = new Map<string, string>();
  const binaryFiles = new Map<string, ArrayBuffer>();
  const modelFiles = new Map<string, string>();

  for (const file of files) {
    const name = file.name.toLowerCase();
    const ext = name.slice(name.lastIndexOf("."));
    if (name.endsWith(".json")) {
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        // Use just the filename (no path) as the key for require resolution
        jsonFiles.set(file.name, { json, text });
      } catch {
        /* skip invalid JSON */
      }
    } else if (isKernelFile(file.name)) {
      kernelFiles.push(file);
    } else if (name.endsWith(".xyzv") || name.endsWith(".xyz")) {
      const text = await file.text();
      // Store by filename for resolveFile lookups
      dataFiles.set(file.name, text);
      // Also store by path fragments for "trajectories/foo.xyzv" lookups
      const webkitPath = (file as any).webkitRelativePath;
      if (webkitPath) {
        dataFiles.set(webkitPath, text);
      }
    } else if (name.endsWith(".cheb")) {
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

/**
 * Resolve `require` references and return catalogs in dependency order.
 * Catalogs with no `require` come first, then those that depend on them.
 */
function resolveCatalogOrder(
  jsonFiles: Map<string, { json: Record<string, unknown>; text: string }>,
  rootNames?: string[],
): Record<string, unknown>[] {
  const ordered: Record<string, unknown>[] = [];
  const loaded = new Set<string>();

  function loadCatalog(name: string) {
    if (loaded.has(name)) return;
    loaded.add(name);

    const entry = jsonFiles.get(name);
    if (!entry) return;
    const json = entry.json;

    // Load dependencies first
    const requires = json.require as string[] | undefined;
    if (requires) {
      for (const dep of requires) {
        loadCatalog(dep);
      }
    }

    // Only add catalogs that have items (skip pure manifest files like solarsys.json)
    if (json.items && (json.items as unknown[]).length > 0) {
      ordered.push(json);
    }
  }

  // If specific roots given, start from those
  if (rootNames) {
    for (const name of rootNames) loadCatalog(name);
  }

  // Load any catalogs referenced by require that we haven't loaded yet
  for (const [name, entry] of jsonFiles) {
    const requires = entry.json.require as string[] | undefined;
    if (requires) {
      loadCatalog(name);
    }
  }

  // Load remaining catalogs not yet included
  for (const [name] of jsonFiles) {
    if (!loaded.has(name)) {
      loadCatalog(name);
    }
  }

  return ordered;
}

async function handleDrop(dataTransfer: DataTransfer) {
  infoPanel.textContent = "Collecting files...";
  const files = await collectDroppedFiles(dataTransfer);
  await handleFileList(files);
}

async function handleFileList(files: File[]) {
  infoPanel.textContent = `Processing ${files.length} file(s)...`;
  const { jsonFiles, kernelFiles, dataFiles, binaryFiles, modelFiles } = await categorizeFiles(files);

  if (jsonFiles.size === 0 && kernelFiles.length === 0) return;

  console.log(
    `[Cosmolabe] Files: ${jsonFiles.size} JSON, ${kernelFiles.length} kernels, ${dataFiles.size} data files`,
  );

  // Initialize SPICE if we have kernel files
  if (kernelFiles.length > 0 && !spice) {
    infoPanel.textContent = "Initializing SPICE...";
    spice = await Spice.init();
  }

  // Load kernel files into SPICE
  if (spice && kernelFiles.length > 0) {
    infoPanel.textContent = `Loading ${kernelFiles.length} kernel(s)...`;
    for (const file of kernelFiles) {
      console.log(`[Cosmolabe] Loading kernel: ${file.name}`);
      const buffer = await file.arrayBuffer();
      await spice.furnish({
        type: "buffer",
        data: buffer,
        filename: file.name,
      });
    }
    console.log(`[Cosmolabe] ${spice.totalLoaded()} kernel(s) loaded`);
    infoPanel.textContent = `${spice.totalLoaded()} kernel(s) loaded`;
  }

  if (kernelFiles.length === 0) {
    console.log(
      "[Cosmolabe] No kernel files found — Builtin trajectories will use Keplerian fallbacks",
    );
  }

  // Resolve catalog order and load
  if (jsonFiles.size > 0) {
    const catalogs = resolveCatalogOrder(jsonFiles);
    console.log(
      `[Cosmolabe] Loading ${catalogs.length} catalog(s): ${[...jsonFiles.keys()].join(", ")}`,
    );
    infoPanel.textContent = `Loading ${catalogs.length} catalog(s)...`;
    if (catalogs.length > 0) {
      initScene(catalogs, dataFiles, binaryFiles, modelFiles);
    }
  }
}

overlay.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).classList.contains("demo-btn")) return;
  fileInput.click();
});
fileInput.addEventListener("change", () => {
  if (fileInput.files) handleFileList(Array.from(fileInput.files));
});

// Demo catalog buttons
for (const btn of document.querySelectorAll(".demo-btn")) {
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const name = (btn as HTMLElement).dataset.catalog;
    if (!name) return;
    // Load mission-specific kernels if needed, otherwise just generic NAIF
    // ISS demo uses TLE (satellite.js) — no SPICE kernels needed
    if (name === "iss") {
      // No kernels needed — TLE propagation via satellite.js
    } else if (name === "cassini-soi") {
      await loadCassiniKernels();
    } else if (name === "lro-moon") {
      await loadLroKernels();
    } else if (name === "europa-clipper") {
      await loadEuropaClipperKernels();
    } else if (name === "msl-dingo-gap") {
      await loadMslKernels();
    } else {
      await loadNaifKernels();
    }
    const resp = await fetch(`./${name}.json`);
    const json = await resp.json();
    console.log(`[Cosmolabe] Loading demo catalog: ${name}`);
    initScene([json]);
  });
}

// Drag and drop (supports directories)
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) handleDrop(e.dataTransfer);
});

// --- Scene initialization ---

function initScene(
  catalogs: Record<string, unknown>[],
  dataFiles?: Map<string, string>,
  binaryFiles?: Map<string, ArrayBuffer>,
  modelFiles?: Map<string, string>,
) {
  // Clean up previous
  renderer?.dispose();
  universe?.dispose();

  // Resolve file by exact match or basename
  const findInMap = <T>(map: Map<string, T>, source: string): T | undefined => {
    if (map.has(source)) return map.get(source);
    const basename = source.split("/").pop()!;
    for (const [key, value] of map) {
      if (key.endsWith(basename)) return value;
    }
    return undefined;
  };

  const resolveFile = dataFiles && dataFiles.size > 0
    ? (source: string) => findInMap(dataFiles, source)
    : undefined;

  const resolveFileBinary = binaryFiles && binaryFiles.size > 0
    ? (source: string) => findInMap(binaryFiles, source)
    : undefined;

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
    if (typeof dt === "string") {
      try {
        let et: number;
        if (spice) {
          et = spice.str2et(dt);
        } else {
          // Fallback: parse ISO UTC string to ET without SPICE
          // ET = seconds past J2000 (2000-01-01T12:00:00 UTC)
          const j2000Ms = Date.UTC(2000, 0, 1, 12, 0, 0);
          et = (new Date(dt).getTime() - j2000Ms) / 1000;
        }
        universe.setTime(et);
        console.log(`[Cosmolabe] Set default time: ${dt} (ET=${et.toFixed(1)})`);
      } catch (e) {
        console.warn(`[Cosmolabe] Failed to parse defaultTime "${dt}":`, e);
      }
      break;
    }
  }

  overlay.classList.add("hidden");
  controls.classList.remove("hidden");

  // Create cache worker for off-main-thread trajectory cache builds.
  // Worker initializes SPICE and loads kernels in background — non-blocking.
  cacheWorker?.dispose();
  cacheWorker = null;
  if (workerKernelUrls.length > 0) {
    try {
      cacheWorker = new SpiceCacheWorker(
        new URL('./workers/spice-cache-relay.ts', import.meta.url),
      );
      cacheWorker.loadKernels([...workerKernelUrls]).then(() => {
        console.log(`[Cosmolabe] Cache worker ready (${workerKernelUrls.length} kernels loaded)`);
      }).catch((err) => {
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
    starFieldOptions: { catalogUrl: '/stars.bin' },
    trajectoryOptions: { trailDuration: 86400 * 30 },
    minBodyPixels: 0,
    cacheWorker: cacheWorker ?? undefined,
    modelResolver: modelFiles && modelFiles.size > 0
      ? (source: string) => findInMap(modelFiles, source)
      : (source: string) => `./${source}`,
  });

  // Position camera to see the solar system
  const allBodies = universe.getAllBodies();
  renderer.camera.position.set(0, 300, 500);
  if (allBodies.length > 0) {
    renderer.camera.lookAt(0, 0, 0);
  }


  // Build body list
  buildBodyList(allBodies);

  // Update info panel
  const kernelInfo = spice ? ` | ${spice.totalLoaded()} kernels` : "";
  infoPanel.textContent = `${allBodies.length} bodies loaded${kernelInfo}`;

  // Initialize scrubber range and start time display updates
  initScrubberRange();
  renderer.timeController.onTimeChange(updateTimeDisplay);
  renderer.timeController.onTimeChange(() => updateRateDisplay());
  renderer.timeController.onTimeChange(() => updateCameraStatus());
  updateRateDisplay();
  updateCameraStatus();

  // Load catalog viewpoints into the camera controller
  initViewpoints();

  // Apply default viewpoint from catalog if specified
  if (universe.defaultViewpoint) {
    applyViewpoint(universe.defaultViewpoint);
    viewpointSelect.value = universe.defaultViewpoint;
  }

  // Populate instrument view dropdown
  initInstrumentSelect();

  // Stats panel (hidden by default, toggled via checkbox/P key)
  if (stats) {
    stats.dom.remove();
  }
  stats = new Stats();
  stats.dom.style.position = 'absolute';
  stats.dom.style.top = '';
  stats.dom.style.left = '';
  stats.dom.style.bottom = '120px';
  stats.dom.style.right = '12px';
  stats.dom.style.display = chkStats.checked ? 'block' : 'none';
  canvas.parentElement!.appendChild(stats.dom);

  renderer.start();

  // Drive stats.update() from our own rAF loop
  const statsLoop = () => {
    if (!renderer) return;
    stats?.update();
    requestAnimationFrame(statsLoop);
  };
  requestAnimationFrame(statsLoop);
}

// --- UI: Time Controls ---

/** Track scrubber bounds (set when scene initializes or time range is known) */
let scrubMinEt = 0;
let scrubMaxEt = 0;
let scrubberDragging = false;

// JS Date can handle ±8.64e15 ms from epoch, which is ~±100M days.
// J2000 epoch is 2000-01-01T12:00:00 = 946728000000 ms from Unix epoch.
// Max safe ET ≈ (8.64e15 - 946728000000) / 1000 ≈ ±7.69e9 seconds (~244 years from J2000).
const MAX_SAFE_ET = 7.5e9; // ~2237 AD / ~1762 AD

function etToUtcString(et: number): string {
  if (!isFinite(et) || Math.abs(et) > MAX_SAFE_ET) {
    const years = et / 31556952;
    return `J2000 ${years >= 0 ? '+' : ''}${years.toFixed(1)} yr`;
  }
  const j2000Ms = Date.UTC(2000, 0, 1, 12, 0, 0);
  const date = new Date(j2000Ms + et * 1000);
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function updateTimeDisplay(et: number) {
  timeDisplay.textContent = etToUtcString(et);
  // Update scrubber position (unless user is dragging it)
  if (!scrubberDragging && scrubMaxEt > scrubMinEt) {
    const frac = (et - scrubMinEt) / (scrubMaxEt - scrubMinEt);
    timeScrubber.value = String(Math.max(0, Math.min(1000, Math.round(frac * 1000))));
  }
}

function updateRateDisplay() {
  if (!renderer) return;
  const tc = renderer.timeController;
  rateDisplay.textContent = rateLabel(tc.rate);
  btnPlay.textContent = tc.playing ? "Pause" : "Play";
  // Highlight reverse button when rate is negative
  btnReverse.classList.toggle("active", tc.rate < 0);
}

function updateCameraStatus() {
  if (!renderer) { cameraStatus.innerHTML = ""; return; }
  const cc = renderer.cameraController;
  const parts: string[] = [];
  // Show mode if not free-orbit
  if (cc.mode !== CameraModeName.FREE_ORBIT) {
    parts.push(`Mode: <span>${cc.mode}</span>`);
  }
  const tracked = cc.trackedBody;
  if (tracked) parts.push(`Tracking: <span>${tracked.body.name}</span>`);
  const lookAt = cc.lookAtBody;
  if (lookAt) parts.push(`Looking at: <span>${lookAt.body.name}</span> <button id="btn-clear-lookat" style="background:#333;color:#888;border:1px solid #555;border-radius:3px;padding:0 5px;cursor:pointer;font-family:monospace;font-size:10px;margin-left:4px;">✕</button>`);
  cameraStatus.innerHTML = parts.join(" &middot; ");
  const btnClear = document.getElementById("btn-clear-lookat");
  if (btnClear) {
    btnClear.addEventListener("click", () => {
      renderer!.cameraController.clearLookAt();
      updateCameraStatus();
    });
  }
}

/** Set scrubber range from universe body trajectories, or a default window around current time */
function initScrubberRange() {
  if (!renderer || !universe) return;
  const range = universe.getTimeRange();
  if (range) {
    // Pad by 10% on each side for comfort
    const span = range[1] - range[0];
    const pad = Math.max(span * 0.1, 86400); // at least 1 day padding
    scrubMinEt = range[0] - pad;
    scrubMaxEt = range[1] + pad;
  } else {
    // No trajectory bounds — default to ±1 year from current time
    const et = renderer.timeController.et;
    const oneYear = 31556952;
    scrubMinEt = et - oneYear;
    scrubMaxEt = et + oneYear;
  }
}

// Play/Pause
btnPlay.addEventListener("click", () => {
  if (!renderer) return;
  renderer.timeController.toggle();
  updateRateDisplay();
});

// Reverse
btnReverse.addEventListener("click", () => {
  if (!renderer) return;
  renderer.timeController.reverse();
  if (!renderer.timeController.playing) renderer.timeController.play();
  updateRateDisplay();
});

// Step backward/forward
btnStepBack.addEventListener("click", () => {
  if (!renderer) return;
  renderer.timeController.stepBackward();
});
btnStepFwd.addEventListener("click", () => {
  if (!renderer) return;
  renderer.timeController.stepForward();
});

// Slower/Faster
btnSlower.addEventListener("click", () => {
  if (!renderer) return;
  renderer.timeController.slower();
  updateRateDisplay();
});
btnFaster.addEventListener("click", () => {
  if (!renderer) return;
  renderer.timeController.faster();
  updateRateDisplay();
});

// FOV slider
fovSlider.addEventListener("input", () => {
  if (!renderer) return;
  const fov = Number(fovSlider.value);
  renderer.camera.fov = fov;
  renderer.camera.updateProjectionMatrix();
  fovDisplay.textContent = `${fov}°`;
});

// Grid overlay toggle
chkGrid.addEventListener("change", () => {
  renderer?.showBodyGrid(chkGrid.checked);
});

// Axes overlay toggle
chkAxes.addEventListener("change", () => {
  axesShown = chkAxes.checked;
  renderer?.showBodyAxes(axesShown);
});

// Stats panel toggle
chkStats.addEventListener("change", () => {
  if (stats) stats.dom.style.display = chkStats.checked ? 'block' : 'none';
});

// Trajectory and label toggles
chkTraj.addEventListener("change", () => {
  renderer?.setTrajectoriesVisible(chkTraj.checked);
});
chkLabels.addEventListener("change", () => {
  renderer?.setLabelsVisible(chkLabels.checked);
});

// Lighting mode selector
selLighting.addEventListener("change", () => {
  renderer?.setLightingMode(selLighting.value as 'natural' | 'shadow' | 'flood');
});

// Time scrubber
timeScrubber.addEventListener("input", () => {
  if (!renderer) return;
  scrubberDragging = true;
  const frac = Number(timeScrubber.value) / 1000;
  const et = scrubMinEt + frac * (scrubMaxEt - scrubMinEt);
  renderer.timeController.setTime(et);
});
timeScrubber.addEventListener("change", () => {
  scrubberDragging = false;
});
timeScrubber.addEventListener("mousedown", () => { scrubberDragging = true; });
timeScrubber.addEventListener("mouseup", () => { scrubberDragging = false; });

// Go-to-time panel
timeDisplay.addEventListener("click", () => {
  gotoTimePanel.classList.toggle("visible");
  if (gotoTimePanel.classList.contains("visible")) {
    gotoTimeInput.value = etToUtcString(renderer?.timeController.et ?? 0).replace(" UTC", "");
    gotoTimeInput.focus();
    gotoTimeInput.select();
  }
});
gotoTimeClose.addEventListener("click", () => {
  gotoTimePanel.classList.remove("visible");
});
function goToTime() {
  if (!renderer || !spice) return;
  const input = gotoTimeInput.value.trim();
  if (!input) return;
  try {
    const et = spice.str2et(input);
    renderer.timeController.setTime(et);
    initScrubberRange();
    gotoTimePanel.classList.remove("visible");
  } catch (e) {
    gotoTimeInput.style.borderColor = "#f44";
    setTimeout(() => { gotoTimeInput.style.borderColor = ""; }, 1500);
  }
}
gotoTimeGo.addEventListener("click", goToTime);
gotoTimeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") goToTime();
  if (e.key === "Escape") gotoTimePanel.classList.remove("visible");
});

// --- UI: Viewpoints ---

let savedViewpointCounter = 0;

function initViewpoints() {
  if (!renderer || !universe) return;

  // Reset dropdown
  viewpointSelect.innerHTML = '<option value="">— select —</option>';

  // Convert catalog ViewpointDefinitions to CameraViewpoints
  const scaleFactor = 1e-6;
  for (const vpDef of universe.viewpoints) {
    // Convert spherical (distance/longitude/latitude) or explicit eye/target to scene coords
    let pos: { x: number; y: number; z: number };
    if (vpDef.eye) {
      pos = {
        x: vpDef.eye[0] * scaleFactor,
        y: vpDef.eye[1] * scaleFactor,
        z: vpDef.eye[2] * scaleFactor,
      };
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
      ? { x: vpDef.target[0] * scaleFactor, y: vpDef.target[1] * scaleFactor, z: vpDef.target[2] * scaleFactor }
      : { x: 0, y: 0, z: 0 };
    const up = vpDef.up
      ? new THREE.Vector3(vpDef.up[0], vpDef.up[1], vpDef.up[2]).normalize()
      : new THREE.Vector3(0, 1, 0);

    renderer.cameraController.addViewpoint({
      name: vpDef.name,
      position: new THREE.Vector3(pos.x, pos.y, pos.z),
      target: new THREE.Vector3(tgt.x, tgt.y, tgt.z),
      up,
      trackBody: vpDef.center,
    });
  }

  // Always add a "Default" viewpoint from initial camera state
  renderer.cameraController.saveViewpoint("Default");

  // Populate dropdown
  rebuildViewpointDropdown();
}

function rebuildViewpointDropdown() {
  if (!renderer) return;
  const vps = renderer.cameraController.getViewpoints();
  viewpointSelect.innerHTML = '<option value="">— select —</option>';
  for (const vp of vps) {
    const opt = document.createElement("option");
    opt.value = vp.name;
    opt.textContent = vp.name;
    viewpointSelect.appendChild(opt);
  }
  // Show viewpoint bar if there are viewpoints
  viewpointBar.style.display = vps.length > 0 ? "flex" : "none";
}

/** Apply a named viewpoint — handles body-centered tracking and custom targets */
function applyViewpoint(name: string) {
  if (!renderer) return;
  const vp = renderer.cameraController.getViewpoint(name);
  if (!vp) return;
  if (vp.trackBody) {
    const bm = renderer.getBodyMesh(vp.trackBody);
    if (bm) {
      renderer.cameraController.track(bm);
      renderer.cameraController.applyViewpoint(vp);
      // If viewpoint has a custom target (not body center), un-track so camera
      // orbits around the target instead of being forced to look at origin.
      // Origin body persists for coordinate precision.
      if (vp.target.lengthSq() > 1e-30) {
        renderer.cameraController.track(null);
      }
    }
  } else {
    renderer.cameraController.goToViewpoint(name, 1.0);
  }
}

viewpointSelect.addEventListener("change", () => {
  const name = viewpointSelect.value;
  if (name) applyViewpoint(name);
});

btnSaveVp.addEventListener("click", () => {
  if (!renderer) return;
  savedViewpointCounter++;
  const name = `Saved ${savedViewpointCounter}`;
  renderer.cameraController.saveViewpoint(name);
  rebuildViewpointDropdown();
  viewpointSelect.value = name;
});

btnFlyTracked.addEventListener("click", () => {
  if (!renderer) return;
  const tracked = renderer.cameraController.trackedBody;
  if (tracked) {
    renderer.cameraController.flyTo(tracked, { scaleFactor: 1e-6 });
  }
});

// --- UI: Instrument PiP View ---

function initInstrumentSelect() {
  if (!renderer) return;
  const sensors = renderer.getSensorNames();
  selInstrument.innerHTML = '<option value="">Off</option>';
  for (const name of sensors) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    selInstrument.appendChild(opt);
  }
  instrumentViewLabel.style.display = sensors.length > 0 ? "flex" : "none";
}

selInstrument.addEventListener("change", () => {
  if (!renderer) return;
  const name = selInstrument.value || null;
  renderer.setInstrumentView(name);
  // If in instrument camera mode, update the mode's sensor to match
  if (name && renderer.cameraController.mode === CameraModeName.INSTRUMENT) {
    renderer.cameraController.setMode(CameraModeName.INSTRUMENT, { sensorName: name });
  }
});

// --- Camera mode selector ---
selCamMode.addEventListener("change", () => {
  if (!renderer) return;
  const cc = renderer.cameraController;
  const modeName = selCamMode.value as CameraModeName;

  // For instrument mode, ensure a sensor is active
  if (modeName === CameraModeName.INSTRUMENT) {
    let instrName = selInstrument.value || '';
    if (!instrName) {
      const sensors = renderer.getSensorNames();
      if (sensors.length > 0) {
        instrName = sensors[0];
        renderer.setInstrumentView(instrName);
        selInstrument.value = instrName;
      }
    }
    cc.setModeForBody(modeName, cc.trackedBody, { sensorName: instrName });
  } else {
    cc.setModeForBody(modeName, cc.trackedBody);
  }
  updateCameraStatus();
});

function buildBodyList(bodies: { name: string; classification?: string }[]) {
  bodyList.innerHTML = "";

  // Show/Hide All controls
  const controlsDiv = document.createElement("div");
  controlsDiv.className = "body-list-controls";
  const showAllBtn = document.createElement("button");
  showAllBtn.textContent = "Show All";
  const hideAllBtn = document.createElement("button");
  hideAllBtn.textContent = "Hide All";
  const soloBtn = document.createElement("button");
  soloBtn.textContent = "Solo";
  soloBtn.title = "Hide all, then show only the next body you click";
  controlsDiv.append(showAllBtn, hideAllBtn, soloBtn);
  bodyList.appendChild(controlsDiv);

  let soloMode = false;

  const items: {
    div: HTMLDivElement;
    checkbox: HTMLInputElement;
    name: string;
  }[] = [];

  /** Highlight the current look-at target in the body list */
  function updateLookAtIndicator(itemList: typeof items) {
    const lookAtName = renderer?.cameraController.lookAtBody?.body.name;
    for (const item of itemList) {
      const span = item.div.querySelector("span");
      if (span) {
        span.style.color = item.name === lookAtName ? "#4488ff" : "";
        span.style.fontStyle = item.name === lookAtName ? "italic" : "";
      }
    }
  }

  for (const body of bodies) {
    const div = document.createElement("div");
    div.className = "body-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.addEventListener("change", (e) => {
      e.stopPropagation();
      const vis = checkbox.checked;
      renderer?.setBodyVisible(body.name, vis);
      div.classList.toggle("hidden-body", !vis);
    });

    const label = document.createElement("span");
    label.textContent = body.name;
    if (body.classification) label.title = body.classification;

    div.append(checkbox, label);
    div.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (!renderer) return;

      if (soloMode) {
        // In solo mode: hide all, show only this one
        for (const item of items) {
          item.checkbox.checked = false;
          item.div.classList.add("hidden-body");
          renderer.setBodyVisible(item.name, false);
        }
        checkbox.checked = true;
        div.classList.remove("hidden-body");
        renderer.setBodyVisible(body.name, true);
        soloMode = false;
        soloBtn.style.color = "";
      } else {
        const bm = renderer.getBodyMesh(body.name);
        if (bm) {
          renderer.cameraController.trackBody(bm, 1e-6);
          updateLookAtIndicator(items);
          updateCameraStatus();
        }
      }
    });

    // Right-click: set as "look at" target (orbit center moves to this body)
    div.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!renderer) return;
      const bm = renderer.getBodyMesh(body.name);
      if (!bm) return;
      // Toggle: if already looking at this body, clear it
      if (renderer.cameraController.lookAtBody === bm) {
        renderer.cameraController.clearLookAt();
      } else {
        renderer.cameraController.lookAt(bm);
      }
      updateLookAtIndicator(items);
      updateCameraStatus();
    });

    items.push({ div, checkbox, name: body.name });
    bodyList.appendChild(div);
  }

  showAllBtn.addEventListener("click", () => {
    for (const item of items) {
      item.checkbox.checked = true;
      item.div.classList.remove("hidden-body");
      renderer?.setBodyVisible(item.name, true);
    }
  });

  hideAllBtn.addEventListener("click", () => {
    for (const item of items) {
      item.checkbox.checked = false;
      item.div.classList.add("hidden-body");
      renderer?.setBodyVisible(item.name, false);
    }
  });

  soloBtn.addEventListener("click", () => {
    soloMode = !soloMode;
    soloBtn.style.color = soloMode ? "#4488ff" : "";
  });
}

// --- Surface Pick Tool ---

let pickModeActive = false;

function setPickMode(active: boolean) {
  pickModeActive = active;
  pickBtn.classList.toggle("active", active);
  document.body.classList.toggle("pick-mode", active);
  if (!active) renderer?.setPickMarker(null);
}

function showPickResult(bodyName: string, latDeg: number, lonDeg: number, altKm: number) {
  const fmt = (n: number, dec: number) => n.toFixed(dec);
  const latStr = `${fmt(Math.abs(latDeg), 5)}° ${latDeg >= 0 ? "N" : "S"}`;
  const lonStr = `${fmt(Math.abs(lonDeg), 5)}° ${lonDeg >= 0 ? "E" : "W"}`;
  const altStr = altKm >= 0
    ? `+${fmt(altKm * 1000, 1)} m`
    : `${fmt(altKm * 1000, 1)} m`;
  pickResultBody.textContent = bodyName;
  pickLat.textContent = latStr;
  pickLon.textContent = lonStr;
  pickAlt.textContent = altStr;
  pickResult.style.display = "block";
}

pickBtn.addEventListener("click", () => {
  setPickMode(!pickModeActive);
  if (!pickModeActive) pickResult.style.display = "none";
});

pickResultClose.addEventListener("click", () => {
  pickResult.style.display = "none";
  renderer?.setPickMarker(null);
  setPickMode(false);
});

canvas.addEventListener("click", (e) => {
  if (!pickModeActive || !renderer) return;
  e.stopPropagation();
  // Convert mouse pixel coords to NDC (-1..+1)
  const rect = canvas.getBoundingClientRect();
  const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  const result = renderer.pickSurface(ndcX, ndcY);
  if (result) {
    showPickResult(result.bodyName, result.latDeg, result.lonDeg, result.altKm);
    renderer.setPickMarker(result);
  }
});

// --- Resize ---

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w;
  canvas.height = h;
  renderer?.resize(w, h);
}

window.addEventListener("resize", onResize);
onResize();

// Keyboard shortcuts
let axesShown = false;
let uiHidden = false;
document.addEventListener("keydown", (e) => {
  if (e.target !== document.body) return; // ignore when typing in inputs

  // Time control shortcuts
  if (!e.ctrlKey && !e.metaKey && !e.altKey && renderer) {
    const tc = renderer.timeController;
    switch (e.key) {
      case " ":
        e.preventDefault();
        tc.toggle();
        updateRateDisplay();
        return;
      case "ArrowLeft":
        e.preventDefault();
        tc.stepBackward();
        return;
      case "ArrowRight":
        e.preventDefault();
        tc.stepForward();
        return;
      case "ArrowDown":
        tc.slower();
        updateRateDisplay();
        return;
      case "ArrowUp":
        tc.faster();
        updateRateDisplay();
        return;
      case "r":
        tc.reverse();
        if (!tc.playing) tc.play();
        updateRateDisplay();
        return;
      case "Home":
        e.preventDefault();
        if (scrubMinEt > -Infinity) tc.setTime(scrubMinEt);
        return;
      case "End":
        e.preventDefault();
        if (scrubMaxEt < Infinity) tc.setTime(scrubMaxEt);
        return;
      case "f": {
        // Fly to tracked body
        const tracked = renderer.cameraController.trackedBody;
        if (tracked) renderer.cameraController.flyTo(tracked, { scaleFactor: 1e-6 });
        return;
      }
      case "v":
        // Save current viewpoint
        savedViewpointCounter++;
        renderer.cameraController.saveViewpoint(`Saved ${savedViewpointCounter}`);
        rebuildViewpointDropdown();
        return;
      case "l":
        chkLabels.checked = !chkLabels.checked;
        renderer.setLabelsVisible(chkLabels.checked);
        return;
      case "Escape":
        renderer.cameraController.resetToFreeOrbit();
        selCamMode.value = CameraModeName.FREE_ORBIT;
        updateCameraStatus();
        if (pickModeActive) { setPickMode(false); pickResult.style.display = "none"; }
        return;
      case "t":
        chkTraj.checked = !chkTraj.checked;
        renderer.setTrajectoriesVisible(chkTraj.checked);
        return;
      case "i": {
        // Cycle instrument PiP: Off → sensor1 → sensor2 → ... → Off
        const sensors = renderer.getSensorNames();
        if (sensors.length === 0) return;
        const current = renderer.activeInstrumentView;
        const idx = current ? sensors.indexOf(current) : -1;
        const next = idx + 1 < sensors.length ? sensors[idx + 1] : null;
        renderer.setInstrumentView(next);
        selInstrument.value = next ?? "";
        return;
      }
      case "m": {
        const nextMode = renderer.cameraController.cycleMode();
        selCamMode.value = nextMode;
        updateCameraStatus();
        return;
      }
      case "\\":
        e.preventDefault();
        uiHidden = !uiHidden;
        controls.style.display = uiHidden ? "none" : "";
        infoPanel.style.display = uiHidden ? "none" : "";
        cameraStatus.style.display = uiHidden ? "none" : "";
        bodyList.style.display = uiHidden ? "none" : "";
        // Toggle label overlay (the pointer-events:none div added by LabelManager)
        for (const child of canvas.parentElement!.children) {
          if (child instanceof HTMLDivElement && child.style.pointerEvents === "none") {
            child.style.display = uiHidden ? "none" : "";
          }
        }
        if (stats) stats.dom.style.display = uiHidden ? "none" : (chkStats.checked ? "block" : "none");
        return;
    }
  }

  if (e.key === "p" && !e.ctrlKey && !e.metaKey) {
    chkStats.checked = !chkStats.checked;
    if (stats) stats.dom.style.display = chkStats.checked ? 'block' : 'none';
  }

  if (e.key === "g" && !e.ctrlKey && !e.metaKey) {
    chkGrid.checked = !chkGrid.checked;
    renderer?.showBodyGrid(chkGrid.checked);
  }

  if (e.key === "x" && !e.ctrlKey && !e.metaKey) {
    axesShown = !axesShown;
    chkAxes.checked = axesShown;
    renderer?.showBodyAxes(axesShown);
  }

  // M key: toggle TransformControls gizmo on tracked body's model for meshRotation calibration
  if (e.key === "m" && !e.ctrlKey && !e.metaKey && renderer) {
    const tracked = renderer.cameraController.trackedBody;
    const tc = renderer.timeController;
    if (transformGizmo) {
      // Detach and remove
      const mq = tracked?.meshRotationQ ?? gizmoTarget!.quaternion;
      console.log(`[meshRotation] Final for catalog JSON: [${mq.w.toFixed(4)}, ${mq.x.toFixed(4)}, ${mq.y.toFixed(4)}, ${mq.z.toFixed(4)}]`);
      transformGizmo.detach();
      renderer.scene.remove(transformGizmo.getHelper());
      if (gizmoTarget) renderer.scene.remove(gizmoTarget);
      transformGizmo.dispose();
      transformGizmo = null;
      gizmoTarget = null;
      // Resume time if it was playing before
      if (gizmoWasPlaying) { tc.play(); updateRateDisplay(); }
      return;
    }
    if (!tracked?.hasModel) return;
    const container = tracked.modelContainer;
    if (!container) return;

    // Pause time so spiceQ stays constant while calibrating
    gizmoWasPlaying = tc.playing;
    tc.pause();
    updateRateDisplay();

    // Snapshot spiceQ: container.quaternion = spiceQ * meshRotationQ
    // → spiceQ = container.quaternion * meshRotationQ^-1
    const meshRotInv = tracked.meshRotationQ.clone().invert();
    _gizmoSpiceQ.multiplyQuaternions(container.quaternion, meshRotInv);

    // Create proxy at the model's full visual orientation.
    // Gizmo rings will align with the model so dragging matches what you see.
    const proxy = new THREE.Object3D();
    proxy.position.copy(tracked.position);
    proxy.quaternion.copy(container.quaternion);
    renderer.scene.add(proxy);

    transformGizmo = new TransformControls(renderer.camera, renderer.renderer.domElement);
    transformGizmo.setMode('rotate');
    transformGizmo.setSpace('local');
    transformGizmo.setSize(1.5);
    transformGizmo.setRotationSnap(Math.PI / 2); // 90° snap
    transformGizmo.attach(proxy);
    renderer.scene.add(transformGizmo.getHelper());
    gizmoTarget = proxy;

    // Disable orbit controls while dragging
    transformGizmo.addEventListener('dragging-changed', (event: any) => {
      renderer!.cameraController.controls.enabled = !event.value;
    });

    // On change: extract meshRotationQ = spiceQ^-1 * proxy.quaternion
    transformGizmo.addEventListener('objectChange', () => {
      const spiceInv = _gizmoSpiceQ.clone().invert();
      tracked.meshRotationQ.multiplyQuaternions(spiceInv, proxy.quaternion);
      tracked.meshRotationQ.normalize();
      const mq = tracked.meshRotationQ;
      console.log(`[meshRotation] ${tracked.body.name}: [${mq.w.toFixed(4)}, ${mq.x.toFixed(4)}, ${mq.y.toFixed(4)}, ${mq.z.toFixed(4)}]`);
    });

    console.log(`[meshRotation] Gizmo attached to ${tracked.body.name} (time paused) — drag rings to rotate (90° snap), press M to detach.`);
    return;
  }

  // Q key: log current meshRotation quaternion
  if (e.key === "q" && !e.ctrlKey && !e.metaKey) {
    const tracked = renderer?.cameraController.trackedBody;
    if (tracked) {
      const mq = tracked.meshRotationQ;
      console.log(`[meshRotation] ${tracked.body.name}: [${mq.w.toFixed(4)}, ${mq.x.toFixed(4)}, ${mq.y.toFixed(4)}, ${mq.z.toFixed(4)}]`);
    }
    return;
  }
});
