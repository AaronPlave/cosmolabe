# Viewer workflows and integration

[Back to the project overview](../README.md). This guide covers supported inputs,
workflow limits, local assets and embedding options.

## Workflows

1. **Load a mission.** Choose a catalog in the browser, configure another
   [catalog source](catalog-sources.md), or drop in a catalog and its files.
   Inputs include SPICE kernels, TLEs, Keplerian elements, tabulated states and
   CCSDS OEM ephemerides; SPICE is optional for visualization.
2. **Follow the spacecraft.** Pick bodies in 3D, track a spacecraft or target,
   change camera frames, and inspect instrument geometry and sensor views.
3. **Find an encounter.** Run Event Finder for closest approaches, distance
   windows, eclipses or occultations. Select a result to see its geometry in 3D;
   scrub the shared timeline through event lanes and geometry profiles.
   Searches require the appropriate SPICE kernels and coverage.
4. **Measure the scene.** Create distances, directions and angles between
   entities, surface picks or explicit coordinates, with live panel readouts.
5. **Return to a view.** [Copy a view link](view-state.md) to share catalog,
   epoch, camera, selection, supported display layers, searches and measurements.
   Recipients need access to the same catalog and assets; local file uploads and
   some camera modes cannot be shared. Panel arrangements are session state.
6. **Capture or script a workflow.** Save screenshots and WebGL video, or drive
   the viewer with [ViewerControl and scripts](scripting.md), including the
   Earth–Moon tour. Browser-viewport recording also captures the analysis UI;
   the built-in video recorder captures the WebGL canvas only.

The Svelte viewer keeps 3D at the center: a thin tool rail opens analysis panels
that can dock, float, resize or minimize. Picking and tracking establish context;
the bottom timeline combines playback, event intervals and temporal analysis.
See the [viewer shell guide](ui-shell.md).

## Local setup and assets

Use Node.js 20 or later. For local mission examples, install
[Git LFS](https://git-lfs.com/) **before cloning** so tracked meshes, DDS textures,
large lunar maps and kernel binaries are downloaded rather than left as pointers.
A small analytical scene does not require every mission dataset.

```sh
git clone https://github.com/AaronPlave/cosmolabe.git
cd cosmolabe
git lfs pull          # fetch LFS-managed assets if the clone skipped them
npm install
npm run build
npm --prefix apps/viewer run dev
```

Open the URL printed by Vite. To run the Cesium integration viewer instead:

```sh
npm --prefix apps/cesium-viewer run dev
```

LFS is only part of the asset setup: large ignored mission kernels are obtained
with the relevant `scripts/fetch-*-kernels.sh` scripts, and generated terrain has
its own build prerequisites. The hosted deployment rewrites published datasets
to Cloudflare R2 when configured; it does not make a local clone's relative data
paths available automatically. See [data hosting](data-hosting.md),
[contributing](../CONTRIBUTING.md) and the [capture prerequisites](readme-media.md).

```sh
npm test              # numerical, model, control and viewer-state tests
npm run typecheck     # packages, tests, viewer and Svelte
npm run lint
```

GPU/browser checks are separate; see the [visual regression guide](../apps/viewer/test-screenshots/README.md).
Promotional captures live in `docs/img/`, separately from regression goldens.

## Architecture and format support

The standalone viewer composes a queryable universe model, injected SPICE/frame
services and a renderer. Core and control have no rendering or DOM dependencies;
host applications can query states or drive the viewer without rewriting its UI.

```text
cosmolabe/
├── apps/
│   ├── viewer/           Svelte 5 mission viewer over Three.js
│   └── cesium-viewer/    Cesium integration examples
├── packages/
│   ├── core/             Universe, catalogs, trajectories and geometry
│   ├── control/          ViewerControl, scripts and portable view state
│   ├── interop/          CCSDS parsing/writing, CSV and CZML export
│   ├── frames/           State/frame contracts and heritage SPICE adapter
│   ├── cspice-wasm/      Runtime CSPICE WASM and bindings
│   ├── spice/            Independent test reference; not a runtime dependency
│   ├── three/            Three.js renderer and renderer plugins
│   ├── cesium-adapter/   CZML scene export and coordinate transforms
│   └── cesium/           Cesium renderer
├── docs/                 Formats, architecture, workflows and validation
└── scripts/              Data preparation, hosting and browser checks
```

- **[Core](../packages/core/README.md)** loads supported Cosmographia-style catalog
  definitions plus Cosmolabe extensions. Compatibility is bounded by the
  [catalog reference](catalog-format.md), available assets and supported
  geometry; Cosmographia Python scripts are not source-compatible with viewer scripts.
- **[Three.js](../packages/three/README.md)** renders trajectories, instrument FOVs,
  event markers, textured globes, terrain, atmospheres, eclipses, rings and ring
  shadows. Surface Explorer and Mars surface workflows remain experimental.
  Catalog data and kernel coverage bound the geometry shown.
- **[Control](../packages/control/README.md)** provides host time, selection and camera
  control, scripting and observation hooks. Renderer plugins add custom overlays.
- **[Interop](../packages/interop/README.md)** parses/writes KVN OEM and quaternion
  AEM, parses CDM encounter summaries, and exports CSV time series/intervals and
  CZML availability/ground tracks. OEM is directly loadable as a catalog trajectory;
  AEM/CDM are library transforms, not general viewer drop-in sources. These are
  scoped format implementations, not complete CCSDS message coverage.
- **[Cesium adapter](../packages/cesium-adapter/README.md)** and
  **[Cesium renderer](../packages/cesium/README.md)** support globe-centric integration.
  See [choosing a renderer](../packages/cesium-adapter/CHOOSING_A_RENDERER.md).

For engine details see [CSPICE WASM](../packages/cspice-wasm/README.md), the
[SPICE reference package](../packages/spice/README.md) and [development architecture](../CONTRIBUTING.md#project-layout).
[ROADMAP.md](../ROADMAP.md) tracks planned work; this README describes shipped workflows
rather than promising complete renderer or catalog coverage.

