# Cosmographia parity notes

Cosmolabe's catalog schema is Cosmographia's, so what Cosmographia's own
documentation says is a specification we are implicitly held to. This file is
the result of reading that documentation against our loader and renderer
(issue #26): what the guide says, where we actually stand, and what each gap
would cost to close.

It is a research note, not a spec. The catalog reference is
[docs/catalog-format.md](catalog-format.md); planned work lives in
[ROADMAP.md](../ROADMAP.md). Findings here that turned into work are
cross-referenced to those.

## What was read, and what wasn't

The guide named in the issue — `cosmographiausersguide_v8.pdf` on
cosmoguide.org — **was not read.** `cosmoguide.org` and `naif.jpl.nasa.gov`
are both refused by this environment's egress policy (403 at the proxy on
CONNECT), so neither the PDF nor the HTML guide could be fetched. Everything
below comes from these sources instead:

| Source | What it is | How far to trust it |
|---|---|---|
| cosmoguide.org pages, via web search | The same guide in HTML form, reaching me as search-engine summaries of individual pages | **Second-hand.** Page-level paraphrase and quoted JSON fragments, not verbatim pages. Field *names* quoted below appeared in returned JSON examples; defaults and edge-case semantics did not. |
| [`claurel/cosmographia`](https://github.com/claurel/cosmographia) `data/help/*.html` | Upstream (pre-SPICE) Cosmographia's in-app help, ~23 KB | Read in full. Authoritative for the base program, silent on everything NAIF added. |
| [`NablaZeroLabs/cosmo-demos`](https://github.com/NablaZeroLabs/cosmo-demos) | Four working SPICE-enhanced Cosmographia scenes (catalogs + Python scripts) | Primary evidence of what a real catalog looks like in the field. |
| This repository | — | Every claim about Cosmolabe below was checked in the source and is cited `file:line`. |

So: **Cosmolabe-side claims are verified; Cosmographia-side claims are
second-hand.** Anything that would turn into schema we ship should be
re-checked against the PDF before it is implemented. The list of what only the
PDF can settle is at the end.

### The guide's page inventory

Search surfaced these pages, which is a usable table of contents for whoever
reads the PDF next. All under `https://cosmoguide.org/`:

| Area | Pages |
|---|---|
| Orientation | `introduction/`, `glossary/`, `important-things-to-remember/` |
| Catalog files | `catalog-file-overview/`, `catalog-file-defining-a-natural-body/`, `catalog-file-defining-a-spacecraft/`, `catalog-file-defining-a-sensor/`, `catalog-file-defining-an-observation/`, `catalog-file-setting-up-use-of-spice-data/`, `catalog-file-to-load-multiple-files/`, `other-catalog-files/`, `loading-and-unloading-files/` |
| Type catalogs | `trajectory-types/`, `rotationmodel-types/`, `bodyframeintermediateframe-types/`, `geometry-types/`, `trajectory/` |
| Frames | `reference-frames/`, `selecting-a-rendering-frame/` |
| Camera & objects | `adjusting-the-camera-view/`, `setting-an-object-as-the-center/`, `object-functions-overview/` |
| Visuals & settings | `visual-attributes-overview/`, `visual-functions/`, `vector-functions-overview/`, `visual-guides-settings/`, `graphics-settings/`, `interface-settings/`, `visualization-settings-overview/`, `other/` |
| Scripting | `scripting-overview/`, `scripting-functions/`, `scripting-example/` |
| Operations | `using-the-command-line/`, `using-the-spice-error-log/`, `common-problems-and-possible-solutions/`, `data-used-by-cosmographia/` |

## Findings

Ordered by what they would change, not by how interesting they are.

### 1. `trajectoryFrame` has an object form, and we silently misread it

Cosmographia writes a frame as an object, the same shape in `trajectoryFrame`
and `bodyFrame` — the guide documents them together under *Body
Frame/Intermediate Frame Types*, with `Spice`, `ICRF`, `BodyFixed` and
`TwoVector` types. Every orbit in `cosmo-demos`' `ct006_iau_earth` scene
declares:

```json
"trajectoryFrame": { "type": "Spice", "name": "IAU_EARTH" },
"trajectory": { "type": "Spice", "target": "-999", "center": "Earth", "frame": "IAU_EARTH" }
```

We accept the object form for `bodyFrame` (`CatalogLoader.ts:101`, parsed via
`BodyFrameSpec`) but type `trajectoryFrame` as a bare `string`
(`CatalogLoader.ts:97`). Two things then go wrong, neither of them loudly:

- The three-bucket classification compares by identity —
  `item.trajectoryFrame === 'J2000'`, `=== 'BodyFixed'`
  (`CatalogLoader.ts:729-732`). An object matches neither, so the body falls
  through to the ecliptic default.
- The same value is passed straight through as a SPICE frame *name* —
  `item.trajectoryFrame ?? 'ECLIPJ2000'` at `CatalogLoader.ts:803`, `:850`,
  `:888`, `:1109`, `:1143`, `:1220`.

So a stock SPICE-enhanced catalog that names a body-fixed trajectory frame is
either placed in the wrong frame or fails at query time with a frame name that
was never a string. The README's "existing Cosmographia catalogs load
unmodified" does not hold here.

This is the same gap ROADMAP's *Generalised inertial-frame handling* entry
describes, with one addition worth carrying into the design: **the named-frame
registry does not need a new schema.** Cosmographia already spells a named
frame `{ "type": "Spice", "name": "IAU_EARTH" }`, and we already parse that
shape on the other field. Accepting the object form on `trajectoryFrame` is
the smaller half of that work and can land before the registry does.

### 2. Sensors are keyed by `instrName`, and we only understand `spiceId`

The guide's sensor catalog takes its FOV from SPICE, by instrument *name*:

```json
{ "class": "sensor", "name": "CAS_ISS_NAC", "parent": "Cassini",
  "startTime": "1997-10-15 09:26:08.390 UTC", "endTime": "2015-08-01 01:58:52.000 UTC",
  "geometry": { "type": "Spice", "instrName": "CASSINI_ISS_NAC", "target": "Saturn",
                "range": 45000, "rangeTracking": true,
                "frustumColor": [0,1,1], "frustumBaseLineWidth": 3, "frustumOpacity": 0.3,
                "gridOpacity": 1, "footprintOpacity": 0.8,
                "sideDivisions": 300, "onlyVisibleDuringObs": false } }
```

Note the geometry `type`: the SPICE-enhanced build spells a SPICE-driven
sensor `"type": "Spice"`, distinct from the upstream `"type": "Sensor"` block
that carries explicit FOV angles. We handle only the latter, and two separate
things go wrong:

- **`type: "Spice"` draws nothing.** A frustum is built only for
  `geometryType === 'Sensor'` (`UniverseRenderer.ts:1936`). A stock
  SPICE-enhanced sensor catalog loads, creates a body, and renders no
  instrument at all — with no diagnostic, because an unrecognised geometry
  type is not an error anywhere in the loader.
- **`type: "Sensor"` without angles silently invents them.** `SensorFrustum`
  reads `horizontalFov` / `verticalFov` / `spiceId`
  (`SensorFrustum.ts:52-58`) — our own field names — and defaults a missing
  horizontal FOV to **10°** (`SensorFrustum.ts:52`) rather than reporting that
  it has none. A catalog that expected SPICE to supply the FOV gets a
  plausible-looking frustum of the wrong size.

`instrName` appears nowhere in this repository.

This is a smaller fix than it looks, because the hard part is already
written. `UniverseRenderer.enrichSensorFromSpice()` calls `getfov`, derives
`shape` from the FOV shape word, and converts CIRCLE / ELLIPSE / RECTANGLE
boundary vectors into our `horizontalFov` / `verticalFov` — it is just gated on
`geo.spiceId`. `bodn2c` is wrapped (`packages/cspice-wasm/src/bindings.ts:600`)
and would turn `instrName` into the id that gate wants; `getfov`
(`bindings.ts:1111`) is already exercised against the Cassini ISS NAC in
`packages/cspice-wasm/src/geometry.test.ts:45`. So: accept `type: "Spice"` as a
sensor geometry, resolve `instrName` through `bodn2c`, and the existing
enrichment path does the rest.

Sensor fields we read from no path at all, in rough order of visual
consequence: `rangeTracking` (range follows the target rather than staying
fixed), `sideDivisions`, `frustumBaseLineWidth`, `gridOpacity`,
`footprintOpacity`, `onlyVisibleDuringObs`.

### 3. Cosmographia *does* have an observation model — ROADMAP says it doesn't

ROADMAP's sensor-footprint entry states that the `active` / `accumulate` /
`fadeSeconds` extensions have no Cosmographia precedent: "every sensor is
'always on' while rendered, never persists a stamp." The guide documents an
`observation` class whose whole purpose is the opposite:

```json
{ "class": "observation", "name": "...", "center": "...",
  "trajectoryFrame": {...}, "bodyFrame": {...},
  "geometry": { "type": "Observations", "sensor": "CAS_ISS_NAC",
                "groups": [ { "startTime": "...", "endTime": "...", "obsRate": 0 } ],
                "footprintColor": [...], "footprintOpacity": 0.8,
                "showResWithColor": false, "fillInObservations": false,
                "sideDivisions": 300, "alongTrackDivisions": 300,
                "shadowVolumeScaleFactor": 1.0 } }
```

Corroborated three ways: the *Geometry Types* page lists an `Observations`
geometry that references a sensor; the catalog-list example loads
`observations/obs_CASSINI_ISS_NAC-SATURN-0405240548.json` alongside its
sensor; and the guide carries a feature post on seeing actual instrument
observations. The ROADMAP claim is corrected in place.

What this changes for us:

- Our planned `active: [{ start, end }]` is Cosmographia's `groups`, plus an
  `obsRate`. Adopting the existing names costs nothing and buys catalog
  portability — which is the stated reason our sensor block mirrors theirs.
- `fillInObservations` is our `accumulate` under another name.
- **The observation is a separate catalog item, not a field on the sensor.**
  Cosmographia splits "what the instrument is" from "when it observed", with
  the observation pointing at the sensor by name. That is a better fit for
  issue #28's general observation model than hanging windows off the sensor
  geometry, and it means an observation timeline can be shipped and unloaded
  independently of the spacecraft that carries the instrument.
- `shadowVolumeScaleFactor` suggests Cosmographia does footprint occlusion
  with shadow volumes — worth knowing before issue #27 picks an approach.

### 4. An object's existence window is parsed and dropped

Cosmographia items carry `startTime` / `endTime` — the Cassini sensor above is
bounded to the mission. We declare both on `CatalogItem`
(`CatalogLoader.ts:107-108`) and use them in exactly one place: as the
fallback start for a composite arc (`CatalogLoader.ts:776`). Nothing on `Body`
or in the renderer consults them, so an object with an expiry renders at every
epoch.

Same shape as the bug in issue #5 (viewpoint `time` parsed and discarded),
which was worth fixing.

### 5. Two declared catalog fields that are read by nobody

- `trajectoryPlot.lineWidth` — declared at `CatalogLoader.ts:89`, absent from
  `parseTrajectoryPlot` (`CatalogLoader.ts:1374`). All four `cosmo-demos`
  scenes set `"lineWidth": 4`.
- `label.fadeSize` — declared at `CatalogLoader.ts:272`, referenced nowhere
  else in the repo. Cosmographia also has `label.showText`, which we do not
  declare at all; we read only `color` and `visible`
  (`CatalogLoader.ts:744-745`).

A field in the type that the parser ignores is a promise the schema does not
keep. Either wire them or drop them from the interface.

### 6. Catalog-file taxonomy — we already have it, but the docs deny it

The guide splits catalogs by role: a *SPICE data* catalog listing
`spiceKernels` (metakernels included — `kernels/cas_1997_v15.tm` and friends),
a *catalog list* catalog with a `require` array, and per-object spacecraft /
sensor / observation catalogs, with the rule that files load in dependency
order and SPICE data comes first.

We implement all of it: `require` and `spiceKernels` at both catalog and item
level (`CatalogLoader.ts:63`, `:69`, `:113`), a resolver that walks the
`require` graph parents-first with cycle detection and collects kernels
(`packages/core/src/catalog/CatalogResolver.ts`), and `.tm` expansion in the
viewer (`apps/viewer/src/lib/metakernel.ts`, wired at
`apps/viewer/src/lib/loader.ts:152-172`).

`docs/catalog-format.md` said the opposite — "Catalogs **do not** embed kernel
paths" — which is wrong and would have sent an author writing a
Cosmographia-shaped mission directory down the manual-drag-drop path. Fixed in
this change.

### 7. Smaller schema gaps

| Guide | Cosmolabe |
|---|---|
| Geometry types: `Mesh`, `Globe`, `Rings`, `ParticleSystem`, `KeplerianSwarm`, `TimeSwitched`, **SPICE DSK** | All but DSK. DSK shape models are the only way to draw a real comet/asteroid body from SPICE data rather than an art asset. |
| Two-step orientation: `rotationModel` **plus `intermediateFrame`** | No `intermediateFrame` anywhere. Our rotation models resolve in one step against an inertial frame. |
| Frame types shared by `trajectoryFrame` / `bodyFrame` / `intermediateFrame`: `Spice`, `ICRF`, `BodyFixed`, `TwoVector` (with `primaryAxis` / `primary` / `secondaryAxis` / `secondary`, vectors of type `RelativePosition`, `RelativeVelocity`, `ConstantVector`) | `BodyFrameSpec` matches this shape (`CatalogLoader.ts:133-140`); `trajectoryFrame` does not — see finding 1. |
| Other catalog kinds: annotations, visualizers, surface | We route `Visualizer` and `FeatureLabels` items (`CatalogLoader.ts:710`); no annotations. |

### 8. Viewer surfaces worth stealing

**A rendering-frame selector.** Cosmographia's camera is locked to a reference
frame centred on the central body, chosen from four kinds, switched from the
object context menu and from scripts (`setCameraToInertialFrame`,
`setCameraToBodyFixedFrame`, `trackObject`). Issue #13 wants to generalise our
SPICE-frame camera lock; this is the taxonomy to generalise it *to*, and its
menu placement — on the object, not in a global settings panel — is the part
that makes it usable.

**A SPICE error log.** The guide gives it a page of its own, and the scripting
API has `hideSpiceMessages()`, so it is a real window a user reads. We log
SPICE failures to the browser console, where a mission author authoring a
catalog will not look. Most of the guide's troubleshooting page — "no SPICE
data", "object is lost", catalog syntax errors, catalog load warnings — is
answerable from a log surface we already generate but do not show. Related:
issue #10 (schema validation warnings) has the same missing destination.

**Object context menu.** Right-click gives *Set as Center*, *Set as Fixed
Center*, *Track*, plus frame visualisation. We have body selection and a body
drawer, and no context menu. The three centring modes are distinct and all
useful: `Track` in particular is what makes the guide's documented flyby
recipe work — go to the spacecraft, track the target, drag it where you want
it, then run time forward.

**Command line and state URL.** `Cosmographia -u "url" -p script catalog
catalog ...` — a state URL, a script, and any number of catalogs. Our viewer
already deep-links a built-in demo by name — `?catalog=<name>`, handled at
`apps/viewer/src/App.svelte:165` — so the `?view=` half of ROADMAP's
shareable-state-URL entry is the piece still missing. `cosmo-demos` ships a
parser for the Cosmographia URL that shows its shape: 11 or 12 `&`-separated
fields, of which `x,y,z` and `qw,qx,qy,qz` are the camera.

**Scripting.** Issue #14 already plans `Cosmo()` parity. The guide groups the
API as: execution timing and annotations, time manipulation, selecting and
going to objects, camera position and orientation, and orientation-only moves.
An inventory drawn from the four `cosmo-demos` scripts and the guide's own
scripting examples:
`showFullScreen`, `pause`/`unpause`, `setTime`, `setTimeRate`, `wait`,
`fadeIn`, `displayNote`, `showObject`/`hideAllObjects`, `showTrajectory`,
`showLabels`/`hideLabels`, `hideToolBar`, `hideSpiceMessages`, `hideEcliptic`,
`hideCenterIndicator`, `hidePlanetOrbits`, `setCentralObject`, `selectObject`,
`gotoObject`, `trackObject`, `setCameraToInertialFrame`,
`setCameraToBodyFixedFrame`, `setCameraPosition`, `setCameraOrientation`,
`moveAwayFromCenter`, `moveToPov`, `dollyForward`, `circleCenterLeft`,
`circleCenterRight`, `circleCenterUp`, `showDirectionVector`,
`showBodyFixedFrame`, `showLatLongGrid`.

### 9. Keyboard shortcuts

From upstream Cosmographia's in-app help (the pre-SPICE program — the
SPICE-enhanced build may differ), against `apps/viewer/src/App.svelte:105-155`:

| Cosmographia | Cosmolabe |
|---|---|
| Space — pause | Space |
| ⌘L / ⇧⌘L / ⌘K / ⇧⌘K — time rate ×10, ×2, ÷10, ÷2 | ↑ / ↓, one rate step |
| ⌘J — reverse time | `r` |
| ⌘[ / ⌘] — step a day; ⇧⌘] — step a year | ← / → , one scrub step |
| ⌘F — find object | ⌘K command palette |
| ⌘G — go to selection; ESC — cancel | `f` fly to tracked |
| ⌘C — centre selection; ⌘B — fix viewpoint to centre | — |
| ⌘P / ⇧⌘P — planet orbits, selected orbit | `t` all trajectories |
| ⇧⌘C — screenshot to clipboard | Screenshot plugin, no key |
| ⌘U — copy viewpoint URL | — (ROADMAP: shareable state URL) |
| ⌘O / ⌘W — open / unload catalog | Drag-drop only |
| ⌘R — record video | — (ROADMAP: video recording) |
| ↑↓ tilt, ←→ roll | `Q`/`E` roll (`KeyboardControls.ts:36-37`) |

The pattern worth noting is not the individual bindings but that Cosmographia
gives time-rate and time-step *coarse and fine* variants of the same key. Our
single-step arrows make scrubbing a long mission tedious in a way the shortcut
table, not the time controls, is responsible for.

## What still needs the PDF

Things the search summaries could not settle, and which should be read before
anything above is turned into shipped schema:

- Defaults and units for every sensor and observation field
  (`obsRate` units, whether `range` is km, what `sideDivisions` divides).
- The full scripting function list with signatures — the inventory above is
  what four demo scripts happened to use.
- The complete settings enumeration (graphics, visual guides, interface),
  needed if we want a settings-panel parity pass.
- The exact four rendering-frame kinds and their switching semantics.
- `important-things-to-remember/` and `common-problems-and-possible-solutions/`
  in full: these are Cosmographia's own list of what authors get wrong, which
  is the best available specification for issue #10's validation messages.
- Whether `class: "observation"` items are addressable objects (selectable,
  centrable) or render-only.

## Sources

- [SPICE-enhanced Cosmographia User's Guide](https://cosmoguide.org/) — page inventory above; read as search summaries, not fetched
- [`claurel/cosmographia`](https://github.com/claurel/cosmographia) — upstream source and `data/help/`
- [`NablaZeroLabs/cosmo-demos`](https://github.com/NablaZeroLabs/cosmo-demos) — SPICE-enhanced Cosmographia tutorial scenes
- [NAIF Cosmographia](https://naif.jpl.nasa.gov/naif/cosmographia.html) — program and kernels (not reachable from this environment)
