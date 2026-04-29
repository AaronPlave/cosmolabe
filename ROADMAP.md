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
