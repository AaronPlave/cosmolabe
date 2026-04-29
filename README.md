# Cosmolabe

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js: 20+](https://img.shields.io/badge/node-20%2B-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)

Web mission visualization — SPICE-accurate geometry, TLE tracking, planetary terrain, and a 3D renderer. A TypeScript monorepo for visualizing spacecraft missions in the browser.

Named after the [cosmolabe](https://en.wikipedia.org/wiki/Cosmolabe), Jacques Besson's 1566 universal instrument designed to replace the sphere, astrolabes, geometric square, quadrant, and celestial/terrestrial globes — one tool for astrometry, cartography, navigation, and surveying. Cosmolabe picks up where [Cosmographia](https://naif.jpl.nasa.gov/naif/cosmographia.html) left off — a C++ desktop visualization app originally created by Chris Laurel (author of [Celestia](https://celestiaproject.space/)), with SPICE-enhanced releases published by NASA NAIF and ESA, but no longer actively developed. Cosmolabe reimplements its catalog format and rendering capabilities as composable web packages, supporting SPICE kernels, TLE data, Keplerian elements, and time-series simulation results — load any combination and get an interactive 3D mission visualization in the browser.

## What It Does

- **SPICE in the browser** — typed TypeScript wrappers over CSPICE compiled to WASM (via TimeCraftJS). Position/velocity, frame transforms, surface geometry, illumination, orbital elements, and geometry event finders (eclipses, occultations, conjunctions).
- **Cosmographia-compatible catalogs** — load the same JSON catalog files that the desktop app used. Bodies, trajectories, rotations, instruments, viewpoints — all parsed and rendered.
- **Queryable universe model** — `universe.getBody('LRO').stateAt(et)` returns SPICE-accurate position and velocity at any ephemeris time. Zero rendering dependencies in the core.
- **Three.js rendering** — textured globes with DDS/JPG surface maps, streaming 3D terrain (quantized mesh, 3D Tiles, Cesium Ion), orbit trails, instrument FOV cones, atmospheric scattering, planetary rings, star fields from the HYG catalog, body labels, and geometry readouts.
- **CesiumJS adapter** — optional bridge for teams already invested in Cesium. CZML export, coordinate transforms, and a parallel renderer (`@cosmolabe/cesium`).
- **Time controls** — play/pause, adjustable rate, scrub to any moment in a mission's timeline.

## Repo Structure

```
cosmolabe/
├── packages/
│   ├── spice/            # @cosmolabe/spice           — CSPICE WASM bindings
│   ├── core/             # @cosmolabe/core            — Universe model (zero rendering deps)
│   ├── three/            # @cosmolabe/three           — Three.js rendering layer
│   ├── cesium-adapter/   # @cosmolabe/cesium-adapter  — CZML export + coordinate transforms
│   └── cesium/           # @cosmolabe/cesium          — CesiumJS rendering layer
├── apps/
│   ├── viewer/           # Three.js demo app (Svelte 5)
│   └── cesium-viewer/    # CesiumJS demo app
├── scripts/              # Build tooling (star catalog compiler, normal map generator)
├── package.json          # npm workspaces monorepo
└── tsconfig.json
```

`@cosmolabe/core` never imports `three` or `cesium`. The renderer packages compose over `core`. See [packages/cesium-adapter/CHOOSING_A_RENDERER.md](packages/cesium-adapter/CHOOSING_A_RENDERER.md) for guidance on which renderer fits your project.

### `@cosmolabe/spice`

Typed wrappers over the full CSPICE function library compiled to WASM. Handles all the `malloc`/`ccall`/`getValue`/`free` memory management and returns clean TypeScript objects.

**Wrapped functions:** `spkpos`, `spkezr`, `pxform`, `sxform`, `sincpt`, `subpnt`, `subslr`, `ilumin`, `oscelt`, `conics`, `bodvcd`, `bodvrd`, `gfposc`, `gfsep`, `gfoclt`, `gfdist`, `mxv`, `mtxv`, `vcrss`, `vnorm`, `vdot`, `utc2et`, `et2utc`, `et2lst`, `str2et`.

### `@cosmolabe/core`

Pure TypeScript universe model with no rendering dependencies. Usable server-side or with any renderer.

- **Universe** — body registry, time state, state queries
- **CatalogLoader** — parses Cosmographia JSON catalogs (all 10 trajectory types, 6 rotation models, 8 geometry types, 4 inertial frames, body-fixed and two-vector frames)
- **Trajectories** — FixedPoint, Keplerian, Spice, InterpolatedStates, Composite, Builtin, ChebyshevPoly, LinearCombination, TLE (via satellite.js)
- **Rotations** — Uniform, Fixed, Euler, Spice, Interpolated, TrajectoryNadir
- **GeometryCalculator** — altitude, sub-spacecraft point, sun angles, orbital elements, eclipse/occultation detection
- **Plugin interfaces** — `SpiceScenePlugin` for data-only plugins, `RendererPlugin` for renderer-specific visualization

### `@cosmolabe/three`

Three.js rendering layer that syncs a `Universe` into an interactive 3D scene.

- **UniverseRenderer** — scene graph sync, origin-shifting for precision at planetary scales, multi-pass depth rendering
- **BodyMesh** — textured spheres with DDS/JPG surface maps, correct rotation, 3D model support (GLTF)
- **TerrainManager** — streaming terrain via 3d-tiles-renderer (quantized mesh, 3D Tiles, Cesium Ion, imagery tiles)
- **TrajectoryLine** — orbit trails with configurable duration, fade, and color (incl. per-segment colors)
- **SensorFrustum** — instrument FOV visualization (elliptical, rectangular)
- **InstrumentView** — camera frustums with projected imagery
- **AtmosphereMesh** — Rayleigh + Mie limb scattering (adapted from Celestia's algorithm)
- **EclipseShadow** — analytical body-to-body umbra/penumbra shading
- **RingMesh** — planetary rings
- **StarField** — naked-eye stars from the HYG catalog with magnitude-based filtering
- **LabelManager**, **GeometryReadout**, **EventMarkers** — UI overlays
- **CameraController** — orbit camera, body tracking, Surface Explorer mode for ground-level navigation, smooth transitions, keyboard shortcuts
- **TimeController** — play/pause/rate/scrub
- **Plugins** — TrajectoryColor, ManeuverVector, CommLink, Screenshot

### `@cosmolabe/cesium-adapter`

Standalone bridge into CesiumJS. CZML export, coordinate transforms (ICRF ↔ ecliptic ↔ planetary fixed frames), time conversions. The cesium peer dep is optional — useful as a build target when you don't want to ship the renderer.

### `@cosmolabe/cesium`

CesiumJS rendering layer composing over `@cosmolabe/core` and `@cosmolabe/cesium-adapter`. Body entities, surface points, comm links, ground tracks. Demonstrated by `apps/cesium-viewer` (live ISS tracking + relay/eclipse demos).

### Viewer Apps

- **`apps/viewer/`** — Three.js + Svelte 5 demo app. Drag-drop SPICE kernel files and Cosmographia JSON catalogs, or pick from built-in demos: LRO at the Moon (16K textures), Europa Clipper at Jupiter, Cassini at Saturn (with rings + sensor frustums), ISS (TLE-propagated), inner solar system, Saturn system, Earth-Moon, MSL at Dingo Gap (Curiosity rover with high-res Mars terrain).
- **`apps/cesium-viewer/`** — CesiumJS demo featuring live ISS telemetry, eclipse highlighting, and ground-station comm relay.

## Getting Started

This repo uses [Git LFS](https://git-lfs.com/) to host demo SPICE kernels, 3D models, and large textures. Without LFS the placeholder pointer files won't resolve and demos will fail to load.

```bash
git clone https://github.com/AaronPlave/cosmolabe.git
cd cosmolabe
git lfs pull          # required — fetches kernels, models, textures
npm install
npm run build         # typecheck + build all packages
npm test              # run vitest
```

To run a viewer:

```bash
cd apps/viewer && npm run dev          # Three.js viewer
# or
cd apps/cesium-viewer && npm run dev   # Cesium viewer
```

Open the viewer and choose a demo catalog, or drag in your own kernel files and catalog JSON.

### Running Tests

```bash
npx vitest run                                  # all tests
npx vitest run packages/core                    # one package
npx vitest run --reporter=verbose <test-name>   # debug single test
```

274+ tests across 30 files covering SPICE wrappers, trajectory math, catalog parsing, geometry calculations, CZML export, and coordinate transforms. Tests that depend on SPICE kernels live under `packages/spice/test-kernels/` and `apps/viewer/test-catalogs/kernels/` — both are LFS-tracked.

## Architecture

```
┌─────────────────────────────────────┐
│           Viewer Apps               │   Drag-drop UI, time controls
├──────────────────┬──────────────────┤
│ @cosmolabe/three │ @cosmolabe/cesium│   Renderer layers
├──────────────────┼──────────────────┤
│                  │ /cesium-adapter  │   CZML + coordinate transforms
├──────────────────┴──────────────────┤
│         @cosmolabe/core             │   Universe model, catalog loader
├─────────────────────────────────────┤
│         @cosmolabe/spice            │   CSPICE WASM bindings
├─────────────────────────────────────┤
│           timecraftjs               │   CSPICE compiled to WASM (npm dep)
└─────────────────────────────────────┘
```

Key constraints:
- `core` never imports `three` or `cesium` — it's a pure data model
- `spice` wraps the WASM layer and handles all memory management
- Renderer packages compose `core` with their respective rendering libraries
- The viewer apps are thin shells that wire everything together with a UI

## Adoption Model

**Tier 1 (today):** Load SPICE kernels + a Cosmographia catalog JSON — get a full 3D mission visualization with no code. Trajectories, globes, terrain, instruments, time controls, stars, labels, event markers all come free from the catalog.

**Tier 2:** Built-in configurable plugins for common patterns — color orbits by eclipse state, show comm link lines, mark maneuvers on trajectories — enabled with a few lines of config.

**Tier 3:** Custom `RendererPlugin` interface for novel instrument visualization.

## Planned Work

**Rendering:**
- Ring shadow casting (planet-to-ring and ring-to-planet)
- Night-side emission (city lights / thermal maps)
- Lunar-Lambert lighting for airless bodies
- Bloom/glare post-processing

**Plugin system:**
- Aerie adapter (sim-result-driven 3D panel)
- GroundTrackPlugin

**Future:**
- WebGPU renderer path
- Expanded Web Worker offloading for SPICE computation

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project layout, and PR guidelines. By contributing, you agree your contribution is licensed under Apache-2.0.

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md) code of conduct.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md). Please do not file public issues for security concerns.

## Dependencies

| Dependency | Role |
|---|---|
| [timecraftjs](https://github.com/NASA-AMMOS/timecraftjs) | CSPICE compiled to WASM — provides all ~500 CSPICE functions |
| [three](https://threejs.org/) | 3D rendering |
| [3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS) | Streaming 3D terrain tiles |
| [cesium](https://cesium.com/platform/cesiumjs/) | Optional CesiumJS renderer + globe primitives |
| [satellite.js](https://github.com/shashwatak/satellite-js) | TLE/SGP4 orbit propagation |

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This software is not approved or endorsed by NASA or JPL. It uses NASA-released open-source components (CSPICE via TimeCraftJS, 3DTilesRendererJS) but is independently developed and maintained.
