import * as THREE from "three";
import { Universe } from "@spicecraft/core";
import { Spice, type SpiceInstance } from "@spicecraft/spice";
import { UniverseRenderer } from "@spicecraft/three";


let universe: Universe | null = null;
let renderer: UniverseRenderer | null = null;
let spice: SpiceInstance | null = null;

const KERNEL_EXTENSIONS = new Set([
  ".bsp",
  ".tls",
  ".tpc",
  ".tf",
  ".tsc",
  ".ti",
  ".ck",
  ".spk",
  ".pck",
  ".fk",
]);

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const overlay = document.getElementById("drop-overlay")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const controls = document.getElementById("controls")!;
const btnPlay = document.getElementById("btn-play")!;
const rateSelect = document.getElementById("rate-select") as HTMLSelectElement;
const timeDisplay = document.getElementById("time-display")!;
const infoPanel = document.getElementById("info-panel")!;
const bodyList = document.getElementById("body-list")!;
const btnLoadNaif = document.getElementById("btn-load-naif")!;

// --- NAIF Generic Kernels ---

// Serve from local public/kernels/ directory (fetched by scripts/fetch-kernels.sh)
const NAIF_BASE = "./kernels";

/** Standard NAIF generic kernel set for solar system visualization (1950-2050) */
// Only reasonably-sized kernels — satellite kernels are 100MB-1GB each,
// so moon positions use analytical theories (TASS17, L1, Gust86, MarsSat) instead.
const NAIF_KERNELS = [
  { file: "naif0012.tls", label: "Leap seconds" },
  { file: "pck00011.tpc", label: "Body constants" },
  { file: "de440s.bsp", label: "Planets + Moon" },
];

/** Cassini-specific kernels (SOI period: Jun 27 – Jul 3, 2004) */
const CASSINI_KERNELS = [
  { file: "cassini/cas_v43.tf", label: "Cassini frames" },
  { file: "cassini/cas00172.tsc", label: "Cassini clock" },
  { file: "cassini/cas_iss_v10.ti", label: "ISS instruments" },
  { file: "cassini/040629AP_SCPSE_04179_04185.bsp", label: "Cassini SOI trajectory" },
  { file: "cassini/04183_04185ra.bc", label: "Cassini attitude (SOI)" },
];

let naifLoaded = false;
let cassiniLoaded = false;

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
    console.log(`[SpiceCraft] Fetching NAIF kernel: ${kernel.file}`);

    try {
      await spice.furnish({ type: "url", url: `${NAIF_BASE}/${kernel.file}` });
    } catch (err) {
      console.error(`[SpiceCraft] Failed to load ${kernel.file}:`, err);
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
    `[SpiceCraft] All NAIF generic kernels loaded (${spice.totalLoaded()} total)`,
  );
}

async function loadCassiniKernels(): Promise<void> {
  if (cassiniLoaded) return;
  await loadNaifKernels(); // Need generic kernels first
  for (const kernel of CASSINI_KERNELS) {
    infoPanel.textContent = `Loading ${kernel.label}...`;
    console.log(`[SpiceCraft] Fetching Cassini kernel: ${kernel.file}`);
    try {
      await spice!.furnish({ type: "url", url: `${NAIF_BASE}/${kernel.file}` });
    } catch (err) {
      console.error(`[SpiceCraft] Failed to load ${kernel.file}:`, err);
    }
  }
  cassiniLoaded = true;
  console.log(`[SpiceCraft] Cassini kernels loaded (${spice!.totalLoaded()} total)`);
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
    `[SpiceCraft] Files: ${jsonFiles.size} JSON, ${kernelFiles.length} kernels, ${dataFiles.size} data files`,
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
      console.log(`[SpiceCraft] Loading kernel: ${file.name}`);
      const buffer = await file.arrayBuffer();
      await spice.furnish({
        type: "buffer",
        data: buffer,
        filename: file.name,
      });
    }
    console.log(`[SpiceCraft] ${spice.totalLoaded()} kernel(s) loaded`);
    infoPanel.textContent = `${spice.totalLoaded()} kernel(s) loaded`;
  }

  if (kernelFiles.length === 0) {
    console.log(
      "[SpiceCraft] No kernel files found — Builtin trajectories will use Keplerian fallbacks",
    );
  }

  // Resolve catalog order and load
  if (jsonFiles.size > 0) {
    const catalogs = resolveCatalogOrder(jsonFiles);
    console.log(
      `[SpiceCraft] Loading ${catalogs.length} catalog(s): ${[...jsonFiles.keys()].join(", ")}`,
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
    if (name === "cassini-soi") {
      await loadCassiniKernels();
    } else {
      await loadNaifKernels();
    }
    const resp = await fetch(`./${name}.json`);
    const json = await resp.json();
    console.log(`[SpiceCraft] Loading demo catalog: ${name}`);
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

  // Set initial time from catalog defaultTime (if present and SPICE is available)
  for (const json of catalogs) {
    const dt = (json as Record<string, unknown>).defaultTime;
    if (typeof dt === "string" && spice) {
      try {
        const et = spice.str2et(dt);
        universe.setTime(et);
        console.log(`[SpiceCraft] Set default time: ${dt} (ET=${et.toFixed(1)})`);
      } catch (e) {
        console.warn(`[SpiceCraft] Failed to parse defaultTime "${dt}":`, e);
      }
      break;
    }
  }

  overlay.classList.add("hidden");
  controls.classList.remove("hidden");

  renderer = new UniverseRenderer(canvas, universe, {
    scaleFactor: 1e-6,
    showTrajectories: true,
    showLabels: true,
    showStars: true,
    starFieldOptions: { catalogUrl: '/stars.bin' },
    trajectoryOptions: { trailDuration: 86400 * 30, numPoints: 300 },
    minBodyPixels: 4,
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

  // Set initial time rate
  renderer.timeController.setRate(Number(rateSelect.value));

  // Build body list
  buildBodyList(allBodies);

  // Update info panel
  const kernelInfo = spice ? ` | ${spice.totalLoaded()} kernels` : "";
  infoPanel.textContent = `${allBodies.length} bodies loaded${kernelInfo}`;

  // Start time display updates
  renderer.timeController.onTimeChange(updateTimeDisplay);

  renderer.start();
}

// --- UI ---

btnPlay.addEventListener("click", () => {
  if (!renderer) return;
  renderer.timeController.toggle();
  btnPlay.textContent = renderer.timeController.playing ? "Pause" : "Play";
});

rateSelect.addEventListener("change", () => {
  renderer?.timeController.setRate(Number(rateSelect.value));
});

function updateTimeDisplay(et: number) {
  const j2000Ms = Date.UTC(2000, 0, 1, 12, 0, 0);
  const date = new Date(j2000Ms + et * 1000);
  timeDisplay.textContent =
    date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

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
          renderer.cameraController.zoomTo(bm, 1e-6);
          renderer.cameraController.track(bm);
        }
      }
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
document.addEventListener("keydown", (e) => {
  if (e.target !== document.body) return; // ignore when typing in inputs
  if (e.key === "x" && !e.ctrlKey && !e.metaKey) {
    axesShown = !axesShown;
    renderer?.showBodyAxes(axesShown);
  }

  // Debug: rotate tracked body's meshRotation
  // 1/2 = ±X, 3/4 = ±Y, 5/6 = ±Z, q = log quaternion
  // No modifier = 90° steps, Shift = 15° fine steps
  const tracked = renderer?.cameraController.trackedBody;
  if (!tracked) return;
  const angle = e.shiftKey ? Math.PI / 12 : Math.PI / 2; // 15° or 90°
  const s = Math.sin(angle / 2);
  const c = Math.cos(angle / 2);
  const step = new THREE.Quaternion();
  let rotated = false;
  switch (e.key) {
    case "1": case "!": step.set(s, 0, 0, c); rotated = true; break;  // +X
    case "2": case "@": step.set(-s, 0, 0, c); rotated = true; break; // -X
    case "3": case "#": step.set(0, s, 0, c); rotated = true; break;  // +Y
    case "4": case "$": step.set(0, -s, 0, c); rotated = true; break; // -Y
    case "5": case "%": step.set(0, 0, s, c); rotated = true; break;  // +Z
    case "6": case "^": step.set(0, 0, -s, c); rotated = true; break; // -Z
    case "q":
      if (!e.ctrlKey && !e.metaKey) {
        const mq = tracked.meshRotationQ;
        console.log(`[meshRotation] ${tracked.body.name}: [${mq.w.toFixed(4)}, ${mq.x.toFixed(4)}, ${mq.y.toFixed(4)}, ${mq.z.toFixed(4)}]`);
      }
      return;
  }
  if (rotated) {
    tracked.meshRotationQ.premultiply(step);
    tracked.meshRotationQ.normalize();
    const mq = tracked.meshRotationQ;
    console.log(`[meshRotation] ${tracked.body.name}: [${mq.w.toFixed(4)}, ${mq.x.toFixed(4)}, ${mq.y.toFixed(4)}, ${mq.z.toFixed(4)}]`);
  }
});
