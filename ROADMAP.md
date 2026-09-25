# Roadmap

This is a snapshot of planned work. Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## What Cosmolabe is for

Cosmolabe is **mission-aware visualization and spatial reasoning** — not a generic planetary viewer that happens to do geometry. It ships in two forms, and both are first-class:

- **The standalone viewer** (`apps/viewer`) — drag in a catalog and its kernels, or pick a built-in scene, and get an interactive mission view with the timeline, event finders and sensor geometry, no code required.
- **The embeddable library** — the same core, renderer and `ViewerControl` surface inside a mission application (PlanDev, `is-timeline-three`, a dashboard).

The viewer is also the library's first and most demanding consumer: anything it needs from the packages is something an embedding host will need too.

Generic planetary visualization is ground Cesium has covered for years; competing there is not the goal. What the tree already has that a generic viewer does not is the mission plumbing: the SPICE conformance layer, `@cosmolabe/interop`'s CCSDS OEM / AEM / CDM, CZML and CSV parsers *and* writers, CK-driven attitude, sensor and instrument geometry, and the geometry/event finders.

So the aim is the best *mission-aware* viewer: terrain plus spacecraft state plus instrument FOV plus observation footprint plus illumination plus access plus the mission timeline. The rendering work is largely the same; what changes is how it is chosen and sequenced — by whether it serves a mission workflow.

The sections below are **priority layers, not sequential phases**. Work proceeds across them as individual prerequisites allow — the event/analysis vertical slice (#71) is active now, alongside viewer and foundation work. Where one item genuinely depends on another, the entry says so.

1. **Foundation** — correctness and mechanism everything else depends on.
2. **Viewer and integration surface** — the standalone viewer as a product, and how a host application drives and synchronises with Cosmolabe.
3. **Mission semantics** — events, intervals, observations, and the geometry that answers questions about them.
4. **Mission-aware visualization** — surface, terrain and sensor rendering tied to observations and operations.

Rendering polish and WebGPU sit below all four absent a concrete performance or workflow requirement.

**One rule applies across all of it: build an extension point, schema or API when a named consumer needs it, not when something could eventually be useful.** An extension point built before a consumer exists doesn't stay free — `StateStore` (#33) is the in-tree proof: observable-state machinery with one write and no readers, now sitting on the plugin surface via `RendererContext`. Planned items name who they serve; ideas without a consumer go to [Held until asked](#held-until-asked).

## Recently landed

Kept here briefly so the tiers below read as what's left, not what's done.

- `ViewerControl` port and the no-eval script language (#31, `@cosmolabe/control`) — the viewer's own UI drives it
- eslint flat config, `npm run lint` green and in CI (#11, #25); `no-explicit-any` is off pending the typing cleanup (#98)
- SPICE migration onto `cspice-wasm` (#34); `ckcov` / `ckobj` exported (#39); per-scene kernel lifecycle (#70)
- Geometry/event finder architecture (#60), eclipse and occultation finder (#58), closest approach and range (#61), off-main-thread searches with progress and cancellation (#66, #69, #83)
- Deployment-configurable catalog sources and indexes (#93); viewer readiness gated on models and textures (#19)
- Camera view JSON import/export (`camera-view-io.ts`) and video recording (`VideoRecordPlugin`)
- Rosetta + Philae full-mission demo (#107): native `Dsk` geometry for irregular bodies and spacecraft, `TimeSwitched` geometry, per-arc rotation models, existence windows (`startTime` / `endTime` hide a body), `.3ds` models, and verified resampling/thinning of dense archive SPKs and CKs (`scripts/resample-spk.mjs`, `scripts/thin-ck.mjs`)

## 1. Foundation

- **Explicit named frames** (#101) — trajectories and rotation models declare their frame by name, with correct time-dependent transforms across the parent chain, on both the SPICE and SPICE-free paths, and for OEM/AEM `REF_FRAME`. Today's three-bucket `trajectoryFrame` can't tell TEME from EME2000 from ICRF or name a per-body frame, so consumers pre-rotate app-side (`is-timeline-three`). OEM/AEM source types and observation geometry below depend on this; how state-dependent frames (LVLH, RIC) fit is an open question on the issue.
- **One factory mechanism for trajectory and rotation types** (#38) — built-in types go through the same `trajectoryFactories` / `rotationFactories` path as user-supplied ones.
- **Structured faults** (#43) — say why geometry is unavailable, with the coverage window that explains it. Its only dependency (#39) has landed, so it can go any time; every layer reports "no data here" somewhere.
- **Typing cleanup** (#98) — real types at the existing `any` sites, then `no-explicit-any` back on as an error. Prerequisite for the no-`any`-leaks guarantee below.
- **SPICE memory in workers** — stop duplicating kernel bytes per worker (#86), and the iOS memory-pressure crashes on mission examples (#88).
- SPICE / WASM layer: wrap additional CSPICE functions on demand (the WASM layer already exports all ~500; wrappers are added as features need them), and expand Web Worker offloading for SPICE computation beyond trajectory caching and geometry searches.

## 2. Viewer and integration surface

Two consumers of the same core: people using the standalone viewer directly, and mission applications embedding Cosmolabe. Both want a small, stable surface with real consumers behind it, and minimal lock-in.

Every item names the consumer it serves, per the rule above.

### Standalone viewer

- **Hosted viewer** — a published build anyone can open with no clone, with the built-in scenes as a gallery (catalog sources and indexes, #93, are the mechanism). *Consumer: viewer users; also the demo for every embedding pitch.*
- **One view-state serialization, shareable** — three camera serializations exist today: catalog `Viewpoint` JSON, `camera-view-io.ts` export/import, and `ViewerControl.snapshot()`. Unify them on one shape (camera mode + target + pose + time + frame + selection + time scale + FOV) that is also valid as a catalog viewpoint entry, then add a share URL over it (Cosmographia's `cosmo://` `getStateUrl()` / `setStateFromUrl()` is the precedent; a `?view=…` query string on the hosted viewer, a "Copy share link" button, anything over ~2 KB kicked back to the JSON path). *Consumer: viewer users sharing a view in review, and hosts restoring a view from their own state.*
- **Viewer UX** — the 3D-first analysis UX (#71), responsive and mobile foundation (#59), minimal home and compact catalog navigation (#94). *Consumer: viewer users.*

### Embedding

- **`ViewerControl` as the embedding contract** — the port has landed (#31); what remains is holding it to the same semver and deprecation discipline as the plugin API, and documenting it for hosts. *Consumer: the standalone viewer's own UI and every embedding host.*
- **Host synchronisation** for time, selection and camera — a host timeline or planning tool and the 3D view stay in step in both directions. Builds on `ViewerControl`'s read side and events. *Consumer: PlanDev and timeline hosts.*
- **Provenance and authority in the plugin data model** (#9), including the `CommLinkPlugin` refactor. *Consumer: hosts mixing predicted, as-flown and simulated data.*
- **PlanDev adapter** — sim-result-driven 3D panel, drop-in for planning/replay tools. *Consumer: PlanDev.*
- **Stabilise `RendererPlugin`** and document the full lifecycle (`attachToBody`, `RendererContext`, time/state hooks, teardown). *Consumer: the stock plugins.*
- **Plugin API guarantees** — semver discipline, deprecation policy, changelog covering plugin-facing surfaces; public TypeScript types for everything plugin authors touch, with no `any` leaks across package boundaries (after #98).
- **Custom trajectory and rotation types** — the mechanism already exists (`trajectoryFactories` / `rotationFactories`); #38 finishes it. *Consumer: `is-timeline-three` and mission-specific ephemeris sources.*
- **CCSDS OEM / AEM as built-in trajectory + rotation source types** — `@cosmolabe/interop` already parses these; `is-timeline-three` parses them server-side today and feeds the records into existing types via the catalog `samples` / `records` extensions. Library-side source types would let a catalog declare `trajectory: { type: "OEM", source: "..." }` and `rotationModel: { type: "AEM", source: "..." }` the same way `.xyzv` and `.q` work today, with segment-to-arc mapping for OEMs that span multiple center bodies (cruise → Moon flyby → return). Depends on named frames (#101) — OEM segments declare `REF_FRAME` explicitly, so frame composition becomes routine rather than per-app pre-rotation. *Consumer: `is-timeline-three`.*
- **Headless / server-side `@cosmolabe/core`** — first-class examples, tests, and bundling guidance (the architecture supports it; the docs and ergonomics need work).
- **Embedding without the viewer chrome** — theming and UI composition so the renderer drops into an existing app shell without inheriting the standalone viewer's UI.

## 3. Mission semantics

- **Mission event / interval model** — one representation for events and intervals, whether they come from a geometry search, a host timeline, or a catalog, so the view, the timeline and a host can all refer to the same thing.
- **Observations: a general model** (#28) — instrument, target, window and geometry as first-class data rather than a sensor that happens to be on.
- **Observation geometry validated against archive data** — footprints and viewing geometry checked against planetary archive products, the same way the SPICE layer is checked against the reference implementation.
- **Interactive LOS, access, footprint and eclipse** — the finder architecture and the eclipse/occultation and closest-approach finders have landed (#58, #60, #61); what remains is asking the question in the scene and seeing the answer there: event results drawn on the trajectory (#67), finder time series on the timeline (#65), flyby altitude with one closest-approach implementation (#64), progress that doesn't restart between a search's calls (#87), occlusion for sensor geometry (#27), then line of sight and access windows.

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

### Surface and terrain

Terrain is here because observations land on it and surface operations happen on it — each item should be judged by whether it serves footprints, illumination, access or a surface-ops scene, not by visual fidelity alone. The terrain work is tracked in #47 and its children (#48, #50–#53).

- High-resolution DEM and imagery overlays — broader Mars/Moon coverage beyond the Dingo Gap demo, easier authoring of WMS/WMTS/TMS layers in catalogs
- Surface Explorer camera mode — promote from experimental: smoother transitions between orbital and surface views, pose presets, look-around controls (#51)
- Rover, lander, EDL and drone-swarm scene patterns — first-class catalog support and demo scenes (lunar lander, Mars rover EDL, drone swarm concept)
- Ground-fixed lighting and shadow improvements at terrain LOD boundaries — illumination on the surface is a mission question (landing-site lighting, rover power)
- Irregular-body surfaces beyond the first `Dsk` (#107) — multiple DSK resolutions chosen by distance, picking and camera collision against the plate model instead of a sphere, sensor footprints and illumination on the plate model, and imagery projected onto it. Consumers: close operations at 67P, and the footprint work above
- Atmospheric rendering from the surface — sky color, sun/horizon glow, twilight, aerial perspective for distant terrain (current `AtmosphereMesh` is limb-only / orbital)

## Supporting tracks

These run alongside the tiers above and are pulled forward when a tier needs them.

### Catalog format

- Track and close any remaining gaps versus Cosmographia's full schema
- Better validation and error messages for malformed catalogs (#10)
- ~~Warn (or throw) at catalog load when a body's resolved `trajectoryFrame` disagrees with its parent's~~ — **done differently, and this TODO is retired.** The ~12 M km Psyche/Voyager error was fixed at the source by `0dff40d`, which added per-leg frame composition to `Universe.absolutePositionOf` and put markers, trails, worker samples and `arcResolver` on one `alignPositionToFrame`. A child frame differing from its parent's is now correct, measured at 19 mm against the analytic transform, so warning on it would fire on every TLE satellite and on `cassini-soi`'s moons. See issue #6 for the control. What remains genuinely undetectable is a *mis-declared* frame (catalog says `equatorial`, data is ecliptic); that is only checkable where the source states its own frame, which `checkOemFrame` already does for OEM.
- Authoring helpers (CLI lint, schema for editor autocomplete)
- **Surface feature labels** (craters, valles, montes, etc.) — sourced from existing data, not a hand-maintained catalog. Two paths in order of preference: (a) *map layer* — many planetary WMS/WMTS endpoints (USGS Astrogeology / IAU planetary nomenclature) already serve nomenclature as a feature layer that can be overlaid on `SurfaceTileOverlay`; investigate turning it on for the existing tile pipeline; (b) *download once* — pull static USGS / IAU GeoJSON at build time, convert to lightweight per-body label data, integrate with `LabelManager`. No hand-curated cosmolabe catalog.

### Demos, examples, and docs

- More built-in scenes, favouring mission workflows: Mars rover EDL, lunar lander, drone-swarm concept, asteroid sample return, an instrument-observation flyby (a comet rendezvous landed with Rosetta, #107)
- Recipe-style examples: PlanDev sim replay, embedding in a dashboard, embedding from React / Svelte / Vue through `ViewerControl` (examples, not packages), writing a custom `RendererPlugin`, surface-ops scene authoring
- Expanded test coverage around terrain streaming, surface camera, and renderer plugins
- Visual regression / screenshot tests for stock scenes

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

## Held until asked

Not planned. Each needs a named consumer before it moves up — per the rule at the top. Several were previously on this roadmap.

**Extension points**
- Custom event finders as a plugin extension point
- Custom camera modes as a plugin extension point
- Custom catalog node types
- Framework bindings (React Three Fiber, Svelte, Vue). A framework-neutral embeddable element plus the imperative `ViewerControl` surface covers these cases; a wrapper can be a fifty-line recipe example rather than a package we own and keep current against a renderer that is still moving.
- A plugin starter template repo

**Catalog schema**
- `NadirSensor` — a cheap downward-pointing cone without a full instrument-frame definition. Cosmographia doesn't expose one, so the schema would be ours; don't define it ahead of a mission that needs it.
- `MultiConeSensor` — cones sharing a base (star trackers, multi-head scanners). Cosmographia ships `MultiConeSensorGeometry` in `thirdparty/vesta` but never wired it into `UniverseLoader`; if a mission needs it, lift field names from the vesta API (`SensorCone`, `addBeam()`, `setLimitConeAngle()`).
- Network TLE refresh for `TLETrajectory` — a `tleSource` URL (CelesTrak / Space-Track) with auto-refresh, keeping the static `line1` / `line2` path for deterministic catalogs.

**Viewer**
- Deterministic frame-sequence video export — `VideoRecordPlugin` already records in real time; an offscreen, time-stepped export for reproducible clips waits for someone who needs byte-reproducible video.

## Out of scope (for now)

- Competing as a generic planetary terrain viewer — the standalone viewer is a mission viewer, and terrain work is in service of mission workflows (see [What Cosmolabe is for](#what-cosmolabe-is-for))
- 2D ground-track-only tooling
- Trajectory optimization or maneuver design
- Headless analysis tooling without a renderer (the `core` package supports headless use and the integration tier documents it, but analysis tooling around it is not a focus)
