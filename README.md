# spicecraft

Web SPICE geometry and 3D mission visualization. A TypeScript monorepo that brings NASA JPL's CSPICE toolkit to the browser and renders spacecraft missions in 3D using Three.js.

Spicecraft picks up where [Cosmographia](https://naif.jpl.nasa.gov/naif/cosmographia.html) left off — a C++ desktop visualization app originally created by Chris Laurel (author of [Celestia](https://celestiaproject.space/)), with SPICE-enhanced releases published by NASA NAIF and ESA, but no longer actively developed. Spicecraft reimplements its catalog format and rendering capabilities as composable web packages where you load a JSON catalog and optionally SPICE kernels and get an interactive 3D mission visualization in the browser.

## What It Does

- **SPICE in the browser** — typed TypeScript wrappers over CSPICE compiled to WASM (via TimeCraftJS). Position/velocity, frame transforms, surface geometry, illumination, orbital elements, and geometry event finders (eclipses, occultations, conjunctions).
- **Cosmographia-compatible catalogs** — load the same JSON catalog files that the desktop app used. Bodies, trajectories, rotations, instruments, viewpoints — all parsed and rendered.
- **Queryable universe model** — `universe.getBody('LRO').stateAt(et)` returns SPICE-accurate position and velocity at any ephemeris time. Zero rendering dependencies in the core.
- **Three.js rendering** — textured globes with DDS/JPG surface maps, streaming 3D terrain (quantized mesh, 3D Tiles, Cesium Ion), orbit trails, instrument FOV cones, atmospheric scattering, planetary rings, star fields from the HYG catalog, body labels, and geometry readouts.
- **Time controls** — play/pause, adjustable rate, scrub to any moment in a mission's timeline.

## Repo Structure

```
spicecraft/
├── packages/
│   ├── spice/          # @spicecraft/spice — CSPICE WASM bindings
│   ├── core/           # @spicecraft/core  — Universe model (zero rendering deps)
│   └── three/          # @spicecraft/three  — Three.js rendering layer
├── apps/
│   └── viewer/         # Standalone demo app (drag-drop catalogs + kernels)
├── scripts/            # Build tooling (star catalog compiler, normal map generator)
├── package.json        # npm workspaces monorepo
└── tsconfig.json
```

### `@spicecraft/spice`

Typed wrappers over the full CSPICE function library compiled to WASM. Handles all the `malloc`/`ccall`/`getValue`/`free` memory management and returns clean TypeScript objects.

**Wrapped functions:** `spkpos`, `spkezr`, `pxform`, `sxform`, `sincpt`, `subpnt`, `subslr`, `ilumin`, `oscelt`, `conics`, `bodvcd`, `bodvrd`, `gfposc`, `gfsep`, `gfoclt`, `gfdist`, `mxv`, `mtxv`, `vcrss`, `vnorm`, `vdot`, `utc2et`, `et2utc`, `et2lst`, `str2et`.

### `@spicecraft/core`

Pure TypeScript universe model with no rendering dependencies. Usable server-side or with any renderer.

- **Universe** — body registry, time state, state queries
- **CatalogLoader** — parses Cosmographia JSON catalogs (all 10 trajectory types, 6 rotation models, 8 geometry types, 4 inertial frames, body-fixed and two-vector frames)
- **Trajectories** — FixedPoint, Keplerian, Spice, InterpolatedStates, Composite, Builtin, ChebyshevPoly, LinearCombination, TLE (via satellite.js)
- **Rotations** — Uniform, Spice, Nadir
- **GeometryCalculator** — altitude, sub-spacecraft point, sun angles, orbital elements, eclipse/occultation detection
- **Plugin interfaces** — `SpiceScenePlugin` for data-only plugins, `RendererPlugin` for Three.js visualization

### `@spicecraft/three`

Three.js rendering layer that syncs a `Universe` into an interactive 3D scene.

- **UniverseRenderer** — scene graph sync, origin-shifting for precision at planetary scales, multi-pass depth rendering
- **BodyMesh** — textured spheres with DDS/JPG surface maps, correct rotation, 3D model support (GLTF)
- **TerrainManager** — streaming terrain via 3d-tiles-renderer (quantized mesh, 3D Tiles, Cesium Ion, imagery tiles)
- **TrajectoryLine** — orbit trails with configurable duration, fade, and color
- **SensorFrustum** — instrument FOV visualization (elliptical, rectangular)
- **InstrumentView** — camera frustums with projected imagery
- **AtmosphereMesh** — Rayleigh + Mie limb scattering (adapted from Celestia's algorithm)
- **RingMesh** — planetary rings
- **StarField** — 8,827 naked-eye stars from the HYG catalog with magnitude-based filtering
- **LabelManager**, **GeometryReadout**, **EventMarkers** — UI overlays
- **CameraController** — orbit camera, body tracking, smooth transitions, keyboard shortcuts
- **TimeController** — play/pause/rate/scrub

### Viewer App

Standalone demo at `apps/viewer/`. Choose from built-in demo catalogs or drag and drop your own SPICE kernel files and Cosmographia JSON catalogs. Ships with demos including:

- **LRO at the Moon** — Lunar Reconnaissance Orbiter with 16K Moon textures
- **Europa Clipper at Jupiter** — with Galilean moons
- **Cassini at Saturn** — spacecraft model, SPICE attitude, sensor frustums, rings
- **ISS** — TLE-propagated orbit
- **Inner solar system**, **Saturn system**, **Earth-Moon** — various scale demos
- **MSL at Dingo Gap** — Curiosity rover with high-res Mars terrain

## Getting Started

```bash
npm install
npx tsc --build packages/spice packages/core packages/three
cd apps/viewer && npx vite
```

Open the viewer and choose a demo catalog, or drag in your own kernel files and catalog JSON.

### Running Tests

```bash
npx vitest run
```

51 tests across 8 files covering SPICE wrappers, trajectory math, catalog parsing, and geometry calculations.

## Architecture

```
┌─────────────────────────────────────┐
│           Viewer App                │   Drag-drop UI, time controls
├─────────────────────────────────────┤
│       @spicecraft/three             │   Three.js scene graph, rendering
├─────────────────────────────────────┤
│       @spicecraft/core              │   Universe model, catalog loader
├─────────────────────────────────────┤
│       @spicecraft/spice             │   CSPICE WASM bindings
├─────────────────────────────────────┤
│         timecraftjs                 │   CSPICE compiled to WASM (npm dep)
└─────────────────────────────────────┘
```

Key constraints:
- `core` never imports `three` — it's a pure data model
- `spice` wraps the WASM layer and handles all memory management
- `three` composes `core` with Three.js, adding visual representations for every core concept
- The viewer is a thin app that wires everything together with a UI

## Adoption Model

**Tier 1 (today):** Load SPICE kernels + a Cosmographia catalog JSON — get a full 3D mission visualization with no code. Trajectories, globes, terrain, instruments, time controls, stars, labels, event markers all come free from the catalog.

**Tier 2 (planned):** Built-in configurable plugins for common patterns — color orbits by eclipse state, show comm link lines, mark activities on trajectories — enabled with a few lines of config.

**Tier 3 (planned):** Custom `RendererPlugin` interface for novel instrument visualization.

## Planned Work

**Rendering (in progress):**
- Body-to-body shadow casting (analytical shadow cones in shaders)
- SPICE eclipse state detection via `gfoclt`
- Ring shadow casting (planet-to-ring and ring-to-planet)
- Night-side emission (city lights / thermal maps)
- Lunar-Lambert lighting for airless bodies
- Bloom/glare post-processing

**Plugin system:**
- `renderer.use(plugin)` lifecycle with resource declaration
- Built-in configurable plugins (TrajectoryColor, LinkLine, ActivityMarker, SurfaceRegion)

**Future:**
- React Three Fiber components
- WebGPU renderer path
- Web Workers for off-main-thread SPICE computation

## Dependencies

| Dependency | Role |
|---|---|
| [timecraftjs](https://github.com/NASA-AMMOS/timecraftjs) | CSPICE compiled to WASM — provides all ~500 CSPICE functions |
| [three](https://threejs.org/) | 3D rendering |
| [3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS) | Streaming 3D terrain tiles |
| [satellite.js](https://github.com/shashwatak/satellite-js) | TLE/SGP4 orbit propagation |

