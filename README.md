# Cosmolabe

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js: 20+](https://img.shields.io/badge/node-20%2B-brightgreen)](https://nodejs.org/)

**Mission visualization and spatial reasoning in your browser.** Track spacecraft,
inspect instrument fields of view, find geometry events, and connect them to a
3D scene and timeline. Explore planetary terrain or replay your own ephemeris
and simulation data from a JSON catalog.

**[Open the hosted demo](https://aaronplave.com/cosmolabe/)** ·
**[Catalog reference](docs/catalog-format.md)** · **[Get started](#getting-started)**

![Cassini closest approach: selected 3D event, distance windows, distance and range-rate plots](docs/img/mission-events.png)

*Cassini at Saturn orbit insertion: the selected closest approach aligns with
distance and range-rate plots. Two event lanes show when the spacecraft is within
100,000 and 150,000 km of Saturn, on a six-hour timeline.*

## What you can do

1. **Load a mission.** Choose a catalog in the browser, configure another
   [catalog source](docs/catalog-sources.md), or drop in a catalog and its files.
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
5. **Return to a view.** [Copy a view link](docs/view-state.md) to share catalog,
   epoch, camera, selection, supported display layers, searches and measurements.
   Recipients need access to the same catalog and assets; local file uploads and
   some camera modes cannot be shared. Panel arrangements are session state.
6. **Capture or script a workflow.** Save screenshots and WebGL video, or drive
   the viewer with [ViewerControl and scripts](docs/scripting.md), including the
   Earth–Moon tour. Browser-viewport recording also captures the analysis UI;
   the built-in video recorder captures the WebGL canvas only.

The Svelte viewer keeps 3D at the center: a thin tool rail opens analysis panels
that can dock, float, resize or minimize. Picking and tracking establish context;
the bottom timeline combines playback, event intervals and temporal analysis.
See the [viewer shell guide](docs/ui-shell.md).

## Mission gallery

These are actual viewer captures with ordinary rendering, including the UI.
[Capture recipes and asset prerequisites](docs/readme-media.md) make them reproducible.

![Europa Clipper with Europa, Jupiter and one EIS narrow-angle field of view](docs/img/mission-clipper.jpg)

*Europa Clipper after a Europa encounter: spacecraft context and a single EIS
narrow-angle field of view, with unrelated orbit trails hidden.*

![LRO above textured lunar terrain with its spacecraft information panel](docs/img/mission-lro.jpg)

*Lunar Reconnaissance Orbiter over the Moon: streamed terrain and imagery with
the spacecraft visible, without a large frustum covering the surface.*

![Saturn rings and Cassini's orbit-insertion trajectory](docs/img/mission-cassini.jpg)

*Cassini at Saturn: the ring system, illumination and one spacecraft trajectory.*

![Earth–Moon scripted tour with its script panel](docs/img/mission-tour.png)

*The Earth–Moon catalog includes a script that drives time, camera and layers
through the same ViewerControl methods used by hosts.*

![Cassini to Saturn distance overlay and the Measurements panel](docs/img/mission-measurements.png)

*A single Cassini–Saturn center-to-center distance, with its endpoints and live
readout. This differs from altitude above Saturn's reference surface.*

<details>
<summary>Experimental Mars surface and workflow recording</summary>

![Ingenuity over Jezero terrain in the experimental Mars surface viewer](docs/img/mission-mars.jpg)

*Ingenuity at Jezero — experimental surface visualization. The capture needs the
locally generated fused Mars terrain product described in the recipes.*

[Recreate the Clipper flyby video](docs/readme-media.md#record-the-mission-workflow-video)

The default recording follows Clipper past Europa as its limb slowly reveals
Jupiter, then pulls back to the system. Instrument cones and the live WAC
picture-in-picture stay visible throughout.
The script also offers a Cassini analysis clip with distance windows and plots.
Video binaries stay outside the repository until published.

</details>

## Example catalogs

Browse the current [Examples index](apps/viewer/test-catalogs/index.json):

| Example | What it demonstrates |
| --- | --- |
| Europa Clipper | Jupiter science-phase trajectory, spacecraft model and instruments |
| Cassini Saturn Tour | Orbit insertion, Titan/Huygens and Enceladus encounter viewpoints |
| LRO at the Moon | Lunar orbit, instruments, terrain and imagery |
| ISS (TLE) | Satellite propagation without SPICE; element epoch limits accuracy |
| Psyche; Voyager 1 & 2 | Cruise, flybys and long mission arcs |
| Ingenuity at Jezero; Curiosity at Mars | Experimental Mars surface scenes |
| MoonFall at Shackleton | Synthetic four-hopper lunar south-pole mission |
| CCSDS OEM Ingest | Cassini flown from a text ephemeris, without a spacecraft SPK |
| Earth–Moon Scripted Tour | Scripted camera, time and display changes |
| Earth + Moon; Inner Planets | Analytical/Keplerian scenes without kernels |

Mission catalogs can download substantial kernels, textures and models. Terrain
and imagery continue streaming after scene loading; availability and detail depend
on the catalog's data services and local asset setup.

## Getting started

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
paths available automatically. See [data hosting](docs/data-hosting.md),
[contributing](CONTRIBUTING.md) and the [capture prerequisites](docs/readme-media.md).

```sh
npm test              # numerical, model, control and viewer-state tests
npm run typecheck     # packages, tests, viewer and Svelte
npm run lint
```

GPU/browser checks are separate; see the [visual regression guide](apps/viewer/test-screenshots/README.md).
Promotional captures live in `docs/img/`, separately from regression goldens.

## Architecture and embedding

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

- **[Core](packages/core/README.md)** loads supported Cosmographia-style catalog
  definitions plus Cosmolabe extensions. Compatibility is bounded by the
  [catalog reference](docs/catalog-format.md), available assets and supported
  geometry; Cosmographia Python scripts are not source-compatible with viewer scripts.
- **[Three.js](packages/three/README.md)** renders trajectories, instrument FOVs,
  event markers, textured globes, terrain, atmospheres, eclipses, rings and ring
  shadows. Surface Explorer and Mars surface workflows remain experimental.
  Catalog data and kernel coverage bound the geometry shown.
- **[Control](packages/control/README.md)** provides host time, selection and camera
  control, scripting and observation hooks. Renderer plugins add custom overlays.
- **[Interop](packages/interop/README.md)** parses/writes KVN OEM and quaternion
  AEM, parses CDM encounter summaries, and exports CSV time series/intervals and
  CZML availability/ground tracks. OEM is directly loadable as a catalog trajectory;
  AEM/CDM are library transforms, not general viewer drop-in sources. These are
  scoped format implementations, not complete CCSDS message coverage.
- **[Cesium adapter](packages/cesium-adapter/README.md)** and
  **[Cesium renderer](packages/cesium/README.md)** support globe-centric integration.
  See [choosing a renderer](packages/cesium-adapter/CHOOSING_A_RENDERER.md).

For engine details see [CSPICE WASM](packages/cspice-wasm/README.md), the
[SPICE reference package](packages/spice/README.md) and [development architecture](CONTRIBUTING.md#project-layout).
[ROADMAP.md](ROADMAP.md) tracks planned work; this README describes shipped workflows
rather than promising complete renderer or catalog coverage.

## Attribution, contributing and license

Named after Jacques Besson's 1566 [cosmolabe](https://en.wikipedia.org/wiki/Cosmolabe),
a universal instrument for astrometry, cartography, navigation and surveying.
The catalog format derives from NASA JPL's
[Cosmographia](https://naif.jpl.nasa.gov/naif/cosmographia.html), originally created
by Chris Laurel, author of [Celestia](https://celestiaproject.space/).

Cosmolabe uses [TimeCraftJS](https://github.com/NASA-AMMOS/timecraftjs)/CSPICE,
[Three.js](https://threejs.org/),
[3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS),
[CesiumJS](https://cesium.com/platform/cesiumjs/) and
[satellite.js](https://github.com/shashwatak/satellite-js). See [NOTICE](NOTICE)
for component and data attribution.

Contributions welcome: [development and PR guide](CONTRIBUTING.md),
[code of conduct](CODE_OF_CONDUCT.md), [security reporting](SECURITY.md).
Licensed under Apache-2.0; see [LICENSE](LICENSE).

This software is not approved or endorsed by NASA or JPL. It uses NASA-released
open-source components but is independently developed and maintained.
