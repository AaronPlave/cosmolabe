# Roadmap

This is a snapshot of planned work. Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## What Cosmolabe is for

Cosmolabe is **mission-aware visualization and spatial reasoning** — not a generic planetary viewer that happens to do geometry. It ships in two forms, and both are first-class:

- **The standalone viewer** (`apps/viewer`) — drag in a catalog and its kernels, or pick a built-in scene, and get an interactive mission view with the timeline, event finders and sensor geometry, no code required.
- **The embeddable library** — the same core, renderer and `ViewerControl` surface inside a mission application (PlanDev, `is-timeline-three`, a dashboard).

The viewer is also the library's first and most demanding consumer: anything it needs from the packages is something an embedding host will need too.

Generic planetary visualization is ground Cesium has covered for years; competing there is not the goal. What the tree already has that a generic viewer does not is the mission plumbing: the SPICE conformance layer, `@cosmolabe/interop`'s CCSDS OEM / AEM / CDM, CZML and CSV parsers *and* writers, CK-driven attitude, sensor and instrument geometry, and the geometry/event finders.

So the aim is the best *mission-aware* viewer: terrain plus spacecraft state plus instrument FOV plus observation footprint plus illumination plus access plus the mission timeline. The rendering work is largely the same; what changes is how it is chosen and sequenced — by whether it serves a mission workflow.

The sections below are in priority order, and each builds on the ones above it:

1. **Foundation** — correctness and mechanism everything else depends on.
2. **Viewer and integration surface** — the standalone viewer as a product, and how a host application drives and synchronises with Cosmolabe.
3. **Mission semantics** — events, intervals, observations, and the geometry that answers questions about them.
4. **Mission-aware visualization** — surface, terrain and sensor rendering tied to observations and operations.

Rendering polish and WebGPU sit below all four absent a concrete performance or workflow requirement.

## 1. Foundation

- **Generalised named frames.** Today `trajectoryFrame` is a three-bucket classification (`ecliptic` | `equatorial` | `body-fixed`). `Universe.absolutePositionOf` *does* rotate between the equatorial and ecliptic inertial frames when summing across the parent chain — `0dff40d` added that, and it is measured exact — so the obliquity error this entry originally described is fixed. What remains is the coarseness of the classification itself: three buckets cannot name TEME vs EME2000 vs ICRF, cannot express a body-fixed frame per body, and give an author no way to declare a frame the renderer does not already know. Real ops viewers (STK, NASA Eyes) carry a named-frame registry — `ICRF`, `EME2000`, `ECLIPJ2000`, `TEME`, `ITRF`, `IAU_MOON`, per-spacecraft `LVLH` / `RIC`, etc. — with rotations from each frame to a canonical (typically ICRF), composed on demand. The proper fix: `trajectoryFrame` becomes a frame name (string from a registered set); each trajectory declares its frame explicitly; `absolutePositionOf` inserts the correct rotation per parent-chain leg; SPICE provides accurate dynamic rotations when available (precession + nutation + libration), and a small set of static analytical transforms covers the SPICE-free path. Consumers that today work around the gap (e.g. `is-timeline-three` rotates EME2000 OEM samples to ECLIPJ2000 at catalog-emit time in `MissionConfigToCatalog.ts`) can drop their app-side rotations once this lands. Estimated 2–3 days: design the registry, retrofit existing trajectory classes to declare their frame by name, thread transforms through `absolutePositionOf`, update the rotation-model frame compatibility checks, write the test matrix. Worth doing before a third deep-space mission lands — and several items below (OEM/AEM source types, observation geometry, view state and host sync) depend on it.
- **One factory mechanism for trajectory and rotation types** (#38) — built-in types go through the same `trajectoryFactories` / `rotationFactories` path as user-supplied ones.
- **Lint that actually runs** (#11, #25) — a working eslint flat config, and `npm run lint` in CI.
- **Structured faults** (#43) — say why geometry is unavailable, with the coverage window that explains it. Its only dependency (#39, `ckcov` / `ckobj`) has landed, so this goes early rather than waiting on the visualization tier: every tier above reports "no data here" somewhere.
- SPICE / WASM layer: the M-0002 migration onto `cspice-wasm` is done (#34). Remaining: wrap additional CSPICE functions on demand (the WASM layer already exports all ~500; wrappers are added as features need them), and expand Web Worker offloading for SPICE computation beyond trajectory caching and geometry searches.

## 2. Viewer and integration surface

Two consumers of the same core: people using the standalone viewer directly, and mission applications embedding Cosmolabe. Both want a small, stable surface with real consumers behind it, and minimal lock-in.

**The rule for extension points: build one when an integration needs to extend it, not when something could eventually be extensible.** An extension point built before a consumer exists doesn't stay free — `StateStore` (#33) is the in-tree proof: observable-state machinery with one write and no readers, now sitting on the plugin surface via `RendererContext`. Every item below names the consumer it serves; a new one has to do the same.

### Standalone viewer

- **Hosted viewer** — a published build anyone can open with no clone, with the built-in scenes as a gallery. *Consumer: viewer users; also the demo for every embedding pitch.*
- **Shareable view state** — one JSON shape for a full view (camera mode + target body + position/orientation/distance + time + frame + selection + time scale + FOV), with three ways in and out:
  - *Import / export.* A "download view" button producing the JSON blob, an "upload view" / paste-to-load path, and the same shape valid as a catalog viewpoint entry so a saved view drops directly into a catalog. Today a view can only be saved to the in-session store.
  - *Shareable URL.* Cosmographia ships a `cosmo://` URL scheme (`UniverseView.cpp` `getStateUrl()` / `setStateFromUrl()`) that bundles the same fields into a single pasteable URL. Plan: a `cosmolabe://` (or `?view=…` query string on the hosted demo) that round-trips the JSON fields, plus a "Copy share link" button next to Download. Avoid baking secrets/state larger than ~2 KB into the URL — kick anything bigger back to the JSON path.
  - *Consumer:* viewer users sharing a view in review, and hosts restoring a view from their own state.
- **Viewer UX** — the 3D-first analysis UX (#71), responsive and mobile foundation (#59), catalog sources and navigation (#93, #94), readiness gating on models and textures (#19). *Consumer: viewer users.*

### Embedding

- **Stabilise `ViewerControl`** (#31) — the imperative surface a host drives Cosmolabe through. *Consumer: the standalone viewer's own UI and every embedding host.*
- **Host synchronisation** for time, selection and camera — a host timeline or planning tool and the 3D view stay in step in both directions. *Consumer: PlanDev and timeline hosts.*
- **Provenance and authority in the plugin data model** (#9), including the `CommLinkPlugin` refactor. *Consumer: hosts mixing predicted, as-flown and simulated data.*
- **PlanDev adapter** — sim-result-driven 3D panel, drop-in for planning/replay tools. *Consumer: PlanDev.*
- **Stabilise `RendererPlugin`** and document the full lifecycle (`attachToBody`, `RendererContext`, time/state hooks, teardown). *Consumer: the stock plugins.*
- **Plugin API guarantees** — semver discipline, deprecation policy, changelog covering plugin-facing surfaces; public TypeScript types for everything plugin authors touch, with no `any` leaks across package boundaries.
- **Custom trajectory and rotation types** — the mechanism already exists (`trajectoryFactories` / `rotationFactories`); #38 finishes it. *Consumer: `is-timeline-three` and mission-specific ephemeris sources.*
- **CCSDS OEM / AEM as built-in trajectory + rotation source types** — `@cosmolabe/interop` already parses these; `is-timeline-three` parses them server-side today and feeds the records into existing types via the catalog `samples` / `records` extensions. Library-side source types would let a catalog declare `trajectory: { type: "OEM", source: "..." }` and `rotationModel: { type: "AEM", source: "..." }` the same way `.xyzv` and `.q` work today, with segment-to-arc mapping for OEMs that span multiple center bodies (cruise → Moon flyby → return). Depends on named frames above — OEM segments declare `REF_FRAME` explicitly, so frame composition becomes routine rather than per-app pre-rotation. *Consumer: `is-timeline-three`.*
- **Headless / server-side `@cosmolabe/core`** — first-class examples, tests, and bundling guidance (the architecture supports it; the docs and ergonomics need work).
- **Embedding without the viewer chrome** — theming and UI composition so the renderer drops into an existing app shell without inheriting the standalone viewer's UI.

### Dropped until an integration asks

These were previously on this roadmap. None has a named consumer, so none is planned; any of them comes back when an integration needs it and says so.

- Custom event finders as a plugin extension point
- Custom camera modes as a plugin extension point
- Custom catalog node types
- Framework bindings (React Three Fiber, Svelte, Vue). A framework-neutral embeddable element plus a clean imperative surface (`ViewerControl`, #31) covers these cases; a wrapper can be a fifty-line example rather than a package we own and keep current against a renderer that is still moving.
- A plugin starter template repo

## 3. Mission semantics

- **Mission event / interval model** — one representation for events and intervals, whether they come from a geometry search, a host timeline, or a catalog, so the view, the timeline and a host can all refer to the same thing.
- **Observations: a general model** (#28) — instrument, target, window and geometry as first-class data rather than a sensor that happens to be on.
- **Observation geometry validated against archive data** — footprints and viewing geometry checked against planetary archive products, the same way the SPICE layer is checked against the reference implementation.
- **Interactive LOS, access, footprint and eclipse** — ask the question in the scene and get the answer from the same geometry the finders use: line of sight, access windows, footprints, eclipses and occultations. Includes occlusion for sensor geometry (#27), drawing event results in the scene (#67), and closest-approach altitude with one implementation (#64).

## 4. Mission-aware visualization

Surface, terrain and sensor rendering, tied to observations and operations. Ground-level use cases (rovers, landers, drone-swarm concepts, EDL replay, instrument observations of a surface) drive the work.

### Sensor / instrument viz

Catalog field names mirror Cosmographia's `Sensor` schema (`UniverseLoader::loadSensorGeometry()`) so authored catalogs port without churn; extensions are additive — a stock Cosmographia sensor block still loads.

- **Sensor footprints painted on the target surface.** Compute the FOV–body intersection (cone edges raycast against the target ellipsoid; for tiled terrain, against the active LOD heightfield) and render the resulting polygon as a decal on the body surface. Drives the NASA Psyche / Mars-flyby use case. Base schema (Cosmographia-compatible, `type: "Sensor"`): `target`, `range`, `horizontalFov` / `verticalFov` (degrees, full apex — *not* half-angle), `shape` (`"elliptical"` | `"rectangular"`), `frustumColor`, `frustumOpacity`, `orientation` quaternion `[w,x,y,z]`. Footprint = line-strip polygon on the surface, scaled inward slightly to avoid Z-fighting; `footprintOpacity` default 1.0, `gridOpacity` default 0.15 (Cosmographia hardcodes both; we expose them as optional). Extensions on top (Cosmographia has none of these — every sensor is "always on" while rendered, never persists a stamp):
  - `active: [{ start, end }]` observation-window list — footprint only paints inside these windows; replays deterministically from the catalog. Should come from the observation model (#28) rather than a parallel sensor-only schema.
  - `accumulate: true` — stamps written into a persistent overlay texture on the target body so a flyby leaves a painted swath. Off by default (matches Cosmographia).
  - `fadeSeconds` — live (non-accumulated) mode fades the stamp opacity over N seconds so brief observations leave a visible trace.
  - Plugin-driven painting via `RendererPlugin` for the PlanDev / sim-result case — separate from the catalog path.
  - Showcase: Psyche-style Mars-flyby demo catalog with an `active` window producing a painted swath.
- **Nadir-pointing sensor visualizer** — `type: "NadirSensor"`, a cheap downward-pointing cone on a body that doesn't require a full instrument-frame definition. Field names (`range`, `horizontalFov`, `verticalFov`, `frustumColor`, `frustumOpacity`) consistent with the `Sensor` block above. Cosmographia doesn't expose this in its loader — schema is ours to define.
- **Multi-cone sensor geometry** — `type: "MultiConeSensor"`, array of cones sharing a base (star trackers, scanners with multiple detector heads). Cosmographia ships `MultiConeSensorGeometry` in `thirdparty/vesta` but never wired it into `UniverseLoader`, so no existing JSON shape to mirror. We define the schema with field names lifted from the vesta C++ API (`SensorCone` struct + `addBeam()` / `setLimitConeAngle()`):
  ```json
  {
    "type": "MultiConeSensor",
    "target": "Earth",
    "range": "100000 km",
    "limitConeAngle": 180.0,
    "orientation": [w, x, y, z],
    "beams": [
      { "elevation": 45.0, "azimuth":  0.0, "coneAngle": 30.0, "color": [1, 0, 0] },
      { "elevation": 45.0, "azimuth": 90.0, "coneAngle": 30.0, "color": [0, 1, 0] }
    ]
  }
  ```

### Surface and terrain

Terrain is here because observations land on it and surface operations happen on it — each item should be judged by whether it serves footprints, illumination, access or a surface-ops scene, not by visual fidelity alone. The terrain work is tracked in #47 and its children (#48, #50–#53).

- High-resolution DEM and imagery overlays — broader Mars/Moon coverage beyond the Dingo Gap demo, easier authoring of WMS/WMTS/TMS layers in catalogs
- Surface Explorer camera mode — promote from experimental: smoother transitions between orbital and surface views, pose presets, look-around controls (#51)
- Rover, lander, EDL and drone-swarm scene patterns — first-class catalog support and demo scenes (lunar lander, Mars rover EDL, drone swarm concept)
- Ground-fixed lighting and shadow improvements at terrain LOD boundaries — illumination on the surface is a mission question (landing-site lighting, rover power)
- Atmospheric rendering from the surface — sky color, sun/horizon glow, twilight, aerial perspective for distant terrain (current `AtmosphereMesh` is limb-only / orbital)

## Supporting tracks

These run alongside the tiers above and are pulled forward when a tier needs them.

### Catalog format

- Track and close any remaining gaps versus Cosmographia's full schema
- Better validation and error messages for malformed catalogs (#10)
- ~~Warn (or throw) at catalog load when a body's resolved `trajectoryFrame` disagrees with its parent's~~ — **done differently, and this TODO is retired.** The ~12 M km Psyche/Voyager error was fixed at the source by `0dff40d`, which added per-leg frame composition to `Universe.absolutePositionOf` and put markers, trails, worker samples and `arcResolver` on one `alignPositionToFrame`. A child frame differing from its parent's is now correct, measured at 19 mm against the analytic transform, so warning on it would fire on every TLE satellite and on `cassini-soi`'s moons. See issue #6 for the control. What remains genuinely undetectable is a *mis-declared* frame (catalog says `equatorial`, data is ecliptic); that is only checkable where the source states its own frame, which `checkOemFrame` already does for OEM.
- Authoring helpers (CLI lint, schema for editor autocomplete)
- **Surface feature labels** (craters, valles, montes, etc.) — sourced from existing data, not a hand-maintained catalog. Two paths in order of preference: (a) *map layer* — many planetary WMS/WMTS endpoints (USGS Astrogeology / IAU planetary nomenclature) already serve nomenclature as a feature layer that can be overlaid on `SurfaceTileOverlay`; investigate turning it on for the existing tile pipeline; (b) *download once* — pull static USGS / IAU GeoJSON at build time, convert to lightweight per-body label data, integrate with `LabelManager`. No hand-curated cosmolabe catalog.
- **CelesTrak / network TLE refresh** for `TLETrajectory` — support a `tleSource` URL (CelesTrak / Space-Track) and optional auto-refresh interval. Today `TLETrajectory` takes static `line1` / `line2` at construction; add a fetcher + cache layer while keeping the static path for offline/deterministic catalogs.

### Demos, examples, and docs

- More built-in scenes, favouring mission workflows: Mars rover EDL, lunar lander, comet flyby, drone-swarm concept, asteroid sample return, an instrument-observation flyby
- Recipe-style examples: PlanDev sim replay, embedding in a dashboard, embedding from React / Svelte / Vue through `ViewerControl` (examples, not packages), writing a custom `RendererPlugin`, surface-ops scene authoring
- Expanded test coverage around terrain streaming, surface camera, and renderer plugins
- Visual regression / screenshot tests for stock scenes
- **Video recording** — MediaRecorder-based capture (or offscreen frame-sequence export) with deterministic time scrubbing so demo clips can be re-rendered reproducibly. Today only still screenshots are supported. Pairs with shareable view state above.

## Below the line: rendering polish

Not scheduled absent a concrete performance requirement or a mission workflow that needs it.

- Ring shadow casting (planet-to-ring and ring-to-planet)
- Night-side emission (city lights, thermal maps)
- Lunar-Lambert / Hapke BRDF for airless bodies — moves up if observation-geometry validation (tier 3) needs photometrically correct airless surfaces
- Bloom / glare post-processing
- WebGPU renderer path
- Named-star labels in `StarField` — bright-star lookup (Sirius, Vega, Polaris, etc.), toggle + magnitude threshold
- Diffraction spikes / sun-glare lens artifact — cheap cosmetic post-effect for sun and other bright bodies
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

## Out of scope (for now)

- Competing as a generic planetary terrain viewer — the standalone viewer is a mission viewer, and terrain work is in service of mission workflows (see [What Cosmolabe is for](#what-cosmolabe-is-for))
- 2D ground-track-only tooling
- Trajectory optimization or maneuver design
- Headless analysis tooling without a renderer (the `core` package supports headless use and the integration tier documents it, but analysis tooling around it is not a focus)
