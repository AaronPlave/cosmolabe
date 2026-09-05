# Roadmap

This is a snapshot of planned work, grouped by theme. Items are not strictly ordered; current priorities are **surface visualization** and **library extensibility** (making it easy to build real apps on top of Cosmolabe). Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Surface visualization (priority)

Ground-level use cases (rovers, landers, drone-swarm concepts, EDL replay) drive most of the active work.

- Surface Explorer camera mode — promote from experimental: smoother transitions between orbital and surface views, pose presets, look-around controls
- Atmospheric rendering from the surface — sky color, sun/horizon glow, twilight, aerial perspective for distant terrain (current `AtmosphereMesh` is limb-only / orbital)
- High-resolution DEM and imagery overlays — broader Mars/Moon coverage beyond the Dingo Gap demo, easier authoring of WMS/WMTS/TMS layers in catalogs
- Rover, lander, and drone-swarm scene patterns — first-class catalog support and demo scenes (lunar lander, Mars rover EDL, drone swarm concept)
- Ground-fixed lighting and shadow improvements at terrain LOD boundaries

## Sensor / instrument viz

Catalog field names mirror Cosmographia's `Sensor` schema (`UniverseLoader::loadSensorGeometry()`) so authored catalogs port without churn; extensions are additive — a stock Cosmographia sensor block still loads.

- **Sensor footprints painted on the target surface.** Compute the FOV–body intersection (cone edges raycast against the target ellipsoid; for tiled terrain, against the active LOD heightfield) and render the resulting polygon as a decal on the body surface. Drives the NASA Psyche / Mars-flyby use case. Base schema (Cosmographia-compatible, `type: "Sensor"`): `target`, `range`, `horizontalFov` / `verticalFov` (degrees, full apex — *not* half-angle), `shape` (`"elliptical"` | `"rectangular"`), `frustumColor`, `frustumOpacity`, `orientation` quaternion `[w,x,y,z]`. Footprint = line-strip polygon on the surface, scaled inward slightly to avoid Z-fighting; `footprintOpacity` default 1.0, `gridOpacity` default 0.15 (Cosmographia hardcodes both; we expose them as optional). Extensions on top — but read finding 3 of [docs/cosmographia-parity.md](docs/cosmographia-parity.md) before naming them. A Cosmographia *sensor* is indeed always-on while rendered, but the program pairs it with a separate `observation` catalog item (`class: "observation"`, `geometry.type: "Observations"`) that names the sensor and carries `groups: [{ startTime, endTime, obsRate }]`, `fillInObservations` and footprint styling. Two of the three extensions below are that feature under our own names, so prefer Cosmographia's field names — and its split into a second item — unless there is a reason not to:
  - `active: [{ start, end }]` observation-window list — footprint only paints inside these windows; replays deterministically from the catalog. This is Cosmographia's `groups`, minus its `obsRate`.
  - `accumulate: true` — stamps written into a persistent overlay texture on the target body so a flyby leaves a painted swath. This is Cosmographia's `fillInObservations`. Off by default.
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

## Rendering polish

- Ring shadow casting (planet-to-ring and ring-to-planet)
- Night-side emission (city lights, thermal maps)
- Lunar-Lambert / Hapke BRDF for airless bodies
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
- **Generalised inertial-frame handling.** Today `trajectoryFrame` is a three-bucket classification (`ecliptic` | `equatorial` | `body-fixed`). `Universe.absolutePositionOf` *does* rotate between the equatorial and ecliptic inertial frames when summing across the parent chain — `0dff40d` added that, and it is measured exact — so the obliquity error this entry originally described is fixed. What remains is the coarseness of the classification itself: three buckets cannot name TEME vs EME2000 vs ICRF, cannot express a body-fixed frame per body, and give an author no way to declare a frame the renderer does not already know. Real ops viewers (STK, NASA Eyes) carry a named-frame registry — `ICRF`, `EME2000`, `ECLIPJ2000`, `TEME`, `ITRF`, `IAU_MOON`, per-spacecraft `LVLH` / `RIC`, etc. — with rotations from each frame to a canonical (typically ICRF), composed on demand. The proper fix: `trajectoryFrame` becomes a frame name (string from a registered set); each trajectory declares its frame explicitly; `absolutePositionOf` inserts the correct rotation per parent-chain leg; SPICE provides accurate dynamic rotations when available (precession + nutation + libration), and a small set of static analytical transforms covers the SPICE-free path. Consumers that today work around the gap (e.g. `is-timeline-three` rotates EME2000 OEM samples to ECLIPJ2000 at catalog-emit time in `MissionConfigToCatalog.ts`) can drop their app-side rotations once this lands. Estimated 2–3 days: design the registry, retrofit existing trajectory classes to declare their frame by name, thread transforms through `absolutePositionOf`, update the rotation-model frame compatibility checks, write the test matrix. Worth doing before a third deep-space mission lands.

## Integrations

- PlanDev adapter — sim-result-driven 3D panel, drop-in for planning/replay tools
- Expanded Web Worker offloading for SPICE computation beyond trajectory caching

## SPICE / WASM layer

- Migrate from the bundled TimeCraftJS asm.js build to a public `cspice-wasm` npm package
- Wrap additional CSPICE functions on demand (the WASM layer already exports all ~500; wrappers are added as features need them)

## Catalog format

- Track and close any remaining gaps versus Cosmographia's full schema — the current inventory is [docs/cosmographia-parity.md](docs/cosmographia-parity.md), which reads the Cosmographia user's guide against our loader. Live gaps from it: the object form of `trajectoryFrame` (`{ "type": "Spice", "name": "IAU_EARTH" }`) is misread as ecliptic, a SPICE-enhanced sensor block (`geometry.type: "Spice"` + `instrName`) draws no frustum at all, an item's `startTime`/`endTime` window is parsed and dropped, and `trajectoryPlot.lineWidth` and `label.fadeSize` are declared but read by nobody.
- Better validation and error messages for malformed catalogs
- ~~Warn (or throw) at catalog load when a body's resolved `trajectoryFrame` disagrees with its parent's~~ — **done differently, and this TODO is retired.** The ~12 M km Psyche/Voyager error was fixed at the source by `0dff40d`, which added per-leg frame composition to `Universe.absolutePositionOf` and put markers, trails, worker samples and `arcResolver` on one `alignPositionToFrame`. A child frame differing from its parent's is now correct, measured at 19 mm against the analytic transform, so warning on it would fire on every TLE satellite and on `cassini-soi`'s moons. See issue #6 for the control. What remains genuinely undetectable is a *mis-declared* frame (catalog says `equatorial`, data is ecliptic); that is only checkable where the source states its own frame, which `checkOemFrame` already does for OEM.
- Authoring helpers (CLI lint, schema for editor autocomplete)
- **Surface feature labels** (craters, valles, montes, etc.) — sourced from existing data, not a hand-maintained catalog. Two paths in order of preference: (a) *map layer* — many planetary WMS/WMTS endpoints (USGS Astrogeology / IAU planetary nomenclature) already serve nomenclature as a feature layer that can be overlaid on `SurfaceTileOverlay`; investigate turning it on for the existing tile pipeline; (b) *download once* — pull static USGS / IAU GeoJSON at build time, convert to lightweight per-body label data, integrate with `LabelManager`. No hand-curated cosmolabe catalog.
- **CelesTrak / network TLE refresh** for `TLETrajectory` — support a `tleSource` URL (CelesTrak / Space-Track) and optional auto-refresh interval. Today `TLETrajectory` takes static `line1` / `line2` at construction; add a fetcher + cache layer while keeping the static path for offline/deterministic catalogs.
- **CCSDS OEM / AEM as built-in trajectory + rotation source types** — today the canonical ingest format for deep-space mission predicts is a CCSDS OEM (Orbit Ephemeris Message, position) and CCSDS AEM (Attitude Ephemeris Message, attitude) text file. Cosmolabe accepts Cosmographia `.xyzv` and `.q` files via `InterpolatedStates` / `Interpolated` types; OEM and AEM are the same shape with one more level of CCSDS metadata (`META_START`/`META_STOP`, per-segment `CENTER_NAME` and `REF_FRAME`, `ATTITUDE_DIR` / `QUATERNION_TYPE` for AEM). `is-timeline-three` parses these server-side today and feeds the parsed records into existing cosmolabe types via the catalog `samples` / `records` extensions. Library-side parsing would let a catalog declare `trajectory: { type: "OEM", source: "..." }` and `rotationModel: { type: "AEM", source: "..." }` the same way `.xyzv` and `.q` work today, with the parser handling segment-to-arc mapping for OEMs that span multiple center bodies (cruise → Moon flyby → return). Pairs naturally with the generalised inertial-frame handling above — OEM segments declare `REF_FRAME` explicitly, so frame composition becomes routine rather than per-app pre-rotation.

## Demos, examples, and docs

- Hosted demo gallery (no clone required)
- More built-in scenes: Mars rover EDL, lunar lander, comet flyby, drone-swarm concept, asteroid sample return
- Recipe-style examples: PlanDev sim replay, embedding in a dashboard, writing a custom `RendererPlugin`, surface-ops scene authoring
- Expanded test coverage around terrain streaming, surface camera, and renderer plugins
- Visual regression / screenshot tests for stock scenes
- **Video recording** — MediaRecorder-based capture (or offscreen frame-sequence export) with deterministic time scrubbing so demo clips can be re-rendered reproducibly. Today only still screenshots are supported.
- **Camera view import / export** — today a view can be saved to the in-session store and reloaded, but there's no way to move a view between sessions, machines, or into a catalog. Add (a) a "download view" button producing a small JSON blob (camera mode + target body + position/orientation/distance + time), (b) an "upload view" / paste-to-load path, and (c) make that JSON shape valid as a catalog viewpoint entry so a saved view drops directly into a demo catalog. Pairs naturally with video recording above.
- **Shareable state URL** — Cosmographia ships a `cosmo://` URL scheme (`UniverseView.cpp` `getStateUrl()` / `setStateFromUrl()`) that bundles `jd` (Julian date), camera position/orientation, frame, selected body, time scale, and FOV into a single URL — pasteable into chat or email, no file attachment. Cosmolabe's catalog `Viewpoint` is spatial-only (matches Cosmographia) and the new JSON export is full-state but file-based; a URL slots in between. Plan: a `cosmolabe://` (or `?view=…` query string on the hosted demo) that round-trips the same fields as the JSON export, plus a "Copy share link" button next to Download. Avoid baking secrets/state larger than ~2 KB into the URL — kick anything bigger back to the JSON path.

## Out of scope (for now)

- 2D ground-track-only tooling
- Trajectory optimization or maneuver design
- Headless analysis without a renderer (the `core` package supports this, but tooling around it is not a focus)
