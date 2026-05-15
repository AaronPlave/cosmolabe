# Roadmap

This is a snapshot of planned work, grouped by theme. Items are not strictly ordered; current priorities are **surface visualization** and **library extensibility** (making it easy to build real apps on top of Cosmolabe). Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Surface visualization (priority)

Ground-level use cases (rovers, landers, drone-swarm concepts, EDL replay) drive most of the active work.

- Surface Explorer camera mode — promote from experimental: smoother transitions between orbital and surface views, pose presets, look-around controls
- Atmospheric rendering from the surface — sky color, sun/horizon glow, twilight, aerial perspective for distant terrain (current `AtmosphereMesh` is limb-only / orbital)
- High-resolution DEM and imagery overlays — broader Mars/Moon coverage beyond the Dingo Gap demo, easier authoring of WMS/WMTS/TMS layers in catalogs
- Rover, lander, and drone-swarm scene patterns — first-class catalog support and demo scenes (lunar lander, Mars rover EDL, drone swarm concept)
- Ground-fixed lighting and shadow improvements at terrain LOD boundaries

## Rendering polish

- Ring shadow casting (planet-to-ring and ring-to-planet)
- Night-side emission (city lights, thermal maps)
- Lunar-Lambert / Hapke BRDF for airless bodies
- Bloom / glare post-processing
- WebGPU renderer path
- **Re-composite overlay objects after the surface-tile pass.** Pass 1.5
  (`UniverseRenderer.update()`, the `hasVisibleTiles` block) calls
  `clearDepth()` and renders surface tiles in a camera-relative projection.
  After it returns, the depth buffer reflects only the tile depth — Pass 1's
  body-sphere depth values are gone. This is fine for color compositing of
  *tiles vs bodies* (Pass 1's body color survives where tiles don't cover and
  is overwritten where they do), but it means an overlay re-rendered after
  Pass 1.5 has no body-sphere depth to test against. An earlier attempt
  ("Pass 1.6") re-rendered `OVERLAY_LAYER` after the tile pass to fix a
  perceived trail-disappearing bug — that bug turned out to be the
  TilesFadePlugin renderOrder issue handled now in `TerrainManager`, while the
  Pass 1.6 re-render itself broke depth-correct occlusion of trails behind
  bodies for scenes with surface tiles (e.g. Curiosity@Mars). It was reverted.
  If we ever need to re-composite overlays on top of surface tiles, do it
  correctly: either preserve body-sphere depth across Pass 1.5 (e.g.
  re-render body silhouettes into the depth buffer before the overlay pass),
  or move overlays into a dedicated `overlayScene` and depth-test against a
  combined depth buffer built by including body silhouettes in the tile pass.

## Library extensibility (priority)

Cosmolabe should be viable as a library that other teams build real apps on top of — not just a viewer. That means stable, well-documented extension points and minimal lock-in.

- Stabilize the `RendererPlugin` API and document the full lifecycle (`attachToBody`, `RendererContext`, time/state hooks, teardown)
- Plugin API guarantees: semver discipline, deprecation policy, changelog covering plugin-facing surfaces
- More extension points where users currently have to fork: custom trajectory/rotation types, custom catalog node types, custom event finders, custom camera modes
- Headless / server-side usage of `@cosmolabe/core` — first-class examples, tests, and bundling guidance (the architecture supports it; the docs and ergonomics need work)
- Theming and UI composition — make it easy to embed the renderer inside an existing app shell without inheriting the demo viewer's chrome
- Framework bindings: React Three Fiber for R3F apps; lightweight Svelte / Vue / vanilla wrappers
- Public TypeScript types for everything plugin authors touch, with no `any` leaks across package boundaries
- Plugin authoring guide and a starter template repo

## Integrations

- PlanDev adapter — sim-result-driven 3D panel, drop-in for planning/replay tools
- Expanded Web Worker offloading for SPICE computation beyond trajectory caching

## SPICE / WASM layer

- Migrate from the bundled TimeCraftJS asm.js build to a public `cspice-wasm` npm package
- Wrap additional CSPICE functions on demand (the WASM layer already exports all ~500; wrappers are added as features need them)

## Catalog format

- Track and close any remaining gaps versus Cosmographia's full schema
- Better validation and error messages for malformed catalogs
- Warn (or throw) at catalog load when a body's resolved `trajectoryFrame` disagrees with its parent's — silently bit Psyche/Voyager demos when J2000 children inherited ECLIPJ2000 parents from the base library and trajectory lines rendered ~12 M km off
- Authoring helpers (CLI lint, schema for editor autocomplete)

## Demos, examples, and docs

- Hosted demo gallery (no clone required)
- More built-in scenes: Mars rover EDL, lunar lander, comet flyby, drone-swarm concept, asteroid sample return
- Recipe-style examples: PlanDev sim replay, embedding in a dashboard, writing a custom `RendererPlugin`, surface-ops scene authoring
- Expanded test coverage around terrain streaming, surface camera, and renderer plugins
- Visual regression / screenshot tests for stock scenes

## Out of scope (for now)

- 2D ground-track-only tooling
- Trajectory optimization or maneuver design
- Headless analysis without a renderer (the `core` package supports this, but tooling around it is not a focus)
