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

## Sources, and how far to trust each

| Source | What it covers | Trust |
|---|---|---|
| **`CosmographiaUsersGuide_v8.pdf`** — *Cosmographia-SPICE User's Guide*, Park & Alam, revised by Acton & Semenov, 14 Aug 2015, 44 pp. | **Catalog files only**: SPICE-data, spacecraft, sensor, observation, natural-body and load catalogs; arcs; loading rules; troubleshooting; three complete worked examples (Cassini). | **First-hand.** Read in full. Every field description and default in §1 below is quoted from it. |
| cosmoguide.org pages, via web search | The GUI: camera, rendering frames, visual attributes, settings panels, scripting, command line, SPICE log. The PDF covers none of this. | **Second-hand** — page summaries, not verbatim pages. §2 below is flagged accordingly. |
| [`claurel/cosmographia`](https://github.com/claurel/cosmographia) `data/help/*.html` | Upstream (pre-SPICE) in-app help. | Read in full; authoritative for the base program only. |
| [`NablaZeroLabs/cosmo-demos`](https://github.com/NablaZeroLabs/cosmo-demos) | Four working SPICE-enhanced scenes. | Primary evidence of catalogs in the field. |
| This repository | — | Every Cosmolabe claim below is cited `file:line` and was checked. |

The PDF is narrower than its title suggests: it is the catalog-authoring
manual, and it says nothing about the viewer's UI. Its own contents are

> I. Introduction · II. SPICE catalog file specifications — (1) SPICE data,
> (2) spacecraft, (3) sensor, (4) observation, (5) natural body, (6) load,
> (7) arcs, (8) important things to remember, (9) common problems ·
> III. Complete examples — Cassini orbiter, arcs, natural body

and its own warning is worth keeping in mind while reading anything below:
"The user will likely find a number of non-intuitive aspects of operation, and
some documentation that is incomplete or otherwise inadequate."

## 1. Catalog schema — measured against the guide

### 1.1 `trajectoryFrame` has an object form, and we silently misread it

Every sensor and every observation in the guide declares its frame as an
object, not a string:

```json
"trajectoryFrame": { "type": "BodyFixed", "body": "Cassini" }   // sensor
"trajectoryFrame": { "type": "BodyFixed", "body": "Saturn" }    // observation
"bodyFrame":       { "type": "Spice", "name": "IAU_SATURN" }    // natural body
```

The guide is explicit that these are load-bearing: a sensor's
`trajectoryFrame.body` "must be identical" to its parent spacecraft's name,
and an observation's must equal the sensor's target — that is how footprints
stay fixed on the target surface.

We accept the object form for `bodyFrame` (`CatalogLoader.ts:101`, parsed as
`BodyFrameSpec` at `:133-140`) but type `trajectoryFrame` as a bare string
(`CatalogLoader.ts:97`). Two things then go wrong, neither loudly:

- The three-bucket classification compares by identity —
  `item.trajectoryFrame === 'J2000'`, `=== 'BodyFixed'`
  (`CatalogLoader.ts:729-732`). An object matches neither, so the item falls
  through to the ecliptic default instead of being body-fixed.
- The same value is handed on as a SPICE frame *name* —
  `item.trajectoryFrame ?? 'ECLIPJ2000'` at `CatalogLoader.ts:803`, `:850`,
  `:888`, `:1109`, `:1143`, `:1220`.

Every sensor in a stock Cosmographia catalog hits this. It is also the shape
the *cosmo-demos* scenes use for orbits — `{"type":"Spice","name":"IAU_EARTH"}`
— so the failure is not confined to sensors.

This is ROADMAP's *Generalised inertial-frame handling* entry, with one thing
worth carrying into the design: **the named-frame registry needs no new
schema.** Cosmographia already spells a named frame this way and we already
parse that shape on the neighbouring field. Accepting the object form on
`trajectoryFrame` is the smaller half of that work and can land first.

### 1.2 Sensors: `type: "Spice"` + `instrName`, which we do not implement

The guide's sensor block, verbatim in structure:

```json
{ "class": "sensor", "name": "CAS_ISS_NAC", "parent": "Cassini",
  "startTime": "1997-10-15 09:26:08.390 UTC",
  "endTime":   "2015-08-01 01:58:52.000 UTC",
  "center": "Cassini",
  "trajectoryFrame": { "type": "BodyFixed", "body": "Cassini" },
  "geometry": { "type": "Spice", "instrName": "CASSINI_ISS_NAC",
                "target": "Saturn", "range": 45000, "rangeTracking": true,
                "frustumColor": [0,1,1], "frustumOpacity": 0.3,
                "gridOpacity": 1, "footprintOpacity": 0.8,
                "sideDivisions": 3000, "onlyVisibleDuringObs": false } }
```

Three separate incompatibilities:

- **The geometry type is `Spice`, and we only build frustums for `Sensor`.**
  `UniverseRenderer.ts:1936` gates on `geometryType === 'Sensor'`. A stock
  sensor catalog loads, creates a body, and draws no instrument — with no
  diagnostic, because an unrecognised geometry type is not an error anywhere
  in the loader.
- **The class is `sensor`, and we key on `instrument`.** All 18 sensors in
  `apps/viewer/test-catalogs/` are `"class": "instrument"`; the renderer
  suppresses the body sphere only for that value
  (`UniverseRenderer.ts:2005`), and `LabelManager.ts:305` places instrument
  labels specially. A Cosmographia sensor would also get a sphere drawn at it.
- **`instrName` appears nowhere in this repository.** Where FOV angles are
  absent, `SensorFrustum` defaults the horizontal FOV to 10°
  (`SensorFrustum.ts:52`) rather than reporting that it has none.

The fix is smaller than it looks. `UniverseRenderer.enrichSensorFromSpice()`
already calls `getfov`, derives `shape` from the FOV shape word, and converts
CIRCLE / ELLIPSE / RECTANGLE boundary vectors into `horizontalFov` /
`verticalFov` — it is gated on `geo.spiceId`. `bodn2c`
(`packages/cspice-wasm/src/bindings.ts:600`) turns `instrName` into that id;
`getfov` (`bindings.ts:1111`) is already exercised against the Cassini ISS NAC
in `packages/cspice-wasm/src/geometry.test.ts:45`. Accept `type: "Spice"` and
`class: "sensor"`, resolve the name, and the existing path does the rest.

Sensor fields we read from no path at all, with the guide's definitions and
defaults — worth having exactly right, because two of them do not mean what
the names suggest:

| Field | Guide's definition | Default |
|---|---|---|
| `rangeTracking` | Frustum length is set dynamically to the spacecraft–target distance; when true, `range` is ignored | — (recommended `true`) |
| `range` | Fixed frustum length in km | — |
| `gridOpacity` | Opacity of the frustum's *grid lines* | not stated |
| `footprintOpacity` | Opacity of the **outline at the far end of the frustum** — not a mark on the surface | not stated |
| `sideDivisions` | Points plotted per frustum side; 0 or 1 crashes Cosmographia | **125** |
| `onlyVisibleDuringObs` | Frustum, grids and footprint drawn only during the observation windows of a matching observation catalog | — |

### 1.3 Observations are a first-class item — and ROADMAP said they weren't

ROADMAP's sensor-footprint entry said the `active` / `accumulate` /
`fadeSeconds` extensions had no Cosmographia precedent: "every sensor is
'always on' while rendered, never persists a stamp." §4 of the guide is an
entire catalog class for exactly that:

```json
{ "class": "observation", "name": "CASSINI_ISS_NAC_OBSERVATION",
  "startTime": "...", "endTime": "...",
  "center": "Saturn",
  "trajectoryFrame": { "type": "BodyFixed", "body": "Saturn" },
  "bodyFrame":       { "type": "BodyFixed", "body": "Saturn" },
  "geometry": { "type": "Observations", "sensor": "CAS_ISS_NAC",
                "groups": [ { "startTime": "2004-05-24 05:48:03.043 UTC",
                              "endTime":   "2004-05-24 05:48:08.643 UTC",
                              "obsRate": 0 }, … ],
                "footprintColor": [1,0.5,0], "footprintOpacity": 0.4,
                "showResWithColor": false,
                "sideDivisions": 125, "alongTrackDivisions": 500,
                "shadowVolumeScaleFactor": 1.75,
                "fillInObservations": false } }
```

The semantics, from the guide:

- `groups` are the *actual* observation windows. The item's own
  `startTime`/`endTime` are only a lifetime and must span them.
- `obsRate` is **seconds between footprints**; `0` draws a continuous swath
  instead of a series of discrete footprints.
- `fillInObservations` fills the footprints with colour versus drawing them as
  outlines. It is **not** a persistence flag; an earlier draft of these notes,
  written before the guide could be read, guessed that it was. Corrected here
  and in ROADMAP.
- `shadowVolumeScaleFactor` scales the shadow volume used to render filled-in
  observations; the guide says raise it "on oblong bodies". So Cosmographia
  paints the surface with a shadow-volume method, which is a data point for
  issue #27 before it picks an approach.
- `showResWithColor` colours footprints by spacecraft–target distance, with a
  `colorScheme` parameter the guide declines to document.
- Footprints live in the target's **body-fixed** frame, which is what makes a
  swath stay painted where it was taken.

What this changes for us:

- Our planned `active: [{ start, end }]` is Cosmographia's `groups`, minus the
  rate. Adopting their names costs nothing and buys portability — the stated
  reason our sensor block mirrors theirs in the first place.
- Persistence is not a flag in Cosmographia: an observation *is* the persisted
  thing, and `onlyVisibleDuringObs` on the sensor is how the live frustum is
  tied to those same windows. Our `accumulate` is closest to `obsRate: 0`.
- **The observation is a separate item, not a field on the sensor**, linked by
  name. That is a better fit for issue #28 than hanging windows off the sensor
  geometry: an observation timeline can be loaded and unloaded independently
  of the spacecraft carrying the instrument, and the guide recommends one file
  per observation set for exactly that reason.
- A sensor is a sensor-*target* pair — "each sensor-target pair is treated by
  Cosmographia as one object", so ISS-Saturn and ISS-Titan are two catalog
  files. Any observation model we build inherits that assumption from the
  catalogs it reads.

### 1.4 Durations: `m` means minutes, and to us it means metres

The guide gives one unit vocabulary for every duration in a catalog: years
(`y` or `a`), days (`d`), hours (`h`), **minutes (`m`)**, seconds (`s`),
milliseconds (`ms`).

`parseValueWithUnit` (`CatalogLoader.ts:352-377`) is shared between distances
and durations, and resolves `m` as metres — `num * 0.001`. It has no case for
`a` or `ms`, and the `default` branch returns the number unchanged, i.e. as
seconds. So:

| Catalog says | Cosmographia means | We produce |
|---|---|---|
| `"duration": "90 m"` | 90 minutes | 0.09 seconds |
| `"duration": "1 a"` | 1 year | 1 second |
| `"lead": "500 ms"` | 0.5 seconds | 500 seconds |

`"90 m"` is the natural way to write a LEO orbit period, and a trail duration
of 0.09 s renders as nothing at all. The root cause is one switch serving two
unit systems; the fix is to resolve durations and distances separately, at
which point `m` can mean minutes in a duration and metres in a distance the
way both formats intend.

`docs/catalog-format.md` also advertised `mm` and `cm` distance suffixes and
an `ms` duration suffix, none of which that switch implements. Corrected in
this change.

### 1.5 Arcs: the guide's own shape is misdated by our loader

Cosmographia's arcs example (guide §III, Example 2) writes the boundaries
implicitly — the first arc's start comes from the item, each arc runs to its
`endTime`, and the final arc has none because it runs to the end:

```json
"startTime": "1997-10-15 09:26:08.390 UTC",
"arcs": [
  { "endTime": "2004-07-01 02:48:00.000 UTC", "center": "Sun",    "trajectory": {…}, "bodyFrame": {…} },
  {                                            "center": "Saturn", "trajectory": {…}, "bodyFrame": {…} }
]
```

`buildArcsTrajectory` (`CatalogLoader.ts:770-796`) resolves a missing arc
start to `item.startTime` — *not* to the previous arc's end — and a missing
arc end to `start + 365.25 days`. So the second arc here is dated
1997-10-15 → 1998-10-15: the eleven-year Saturn tour is given a one-year
window ending before it begins. `CompositeTrajectory.arcAt` clamps
out-of-range times to the last arc, so positions survive by luck in the
two-arc case, but `CompositeTrajectory.endTime` is now 1998
(`CompositeTrajectory.ts:28`), and that value feeds the trail bounds and cache
windows (`UniverseRenderer.ts:2169-2173`, `:2701-2709`) — the trajectory line
disappears outside 1997–1998. With three or more arcs, every middle arc gets
the same 1997→1998 window and becomes unreachable.

Nothing in `apps/viewer/test-catalogs/` catches this: every arc in every
catalog we ship writes both `startTime` and `endTime` explicitly.

`ArcSpec.bodyFrame` is also declared (`CatalogLoader.ts:120`) and never read — the guide's example sets it on each arc.

### 1.6 Declared fields that no code reads

Beyond `ArcSpec.bodyFrame`:

| Field | Guide's meaning | Where it dies |
|---|---|---|
| `trajectoryPlot.lineWidth` | Trail width in pixels, default 1.0 | Declared `CatalogLoader.ts:89`, absent from `parseTrajectoryPlot` (`:1374`) |
| `label.fadeSize` | Distance in km at which the label fades from opaque to transparent; default is Cosmographia's guess at the orbit's size | Declared `CatalogLoader.ts:272`, referenced nowhere |
| `label.showText` | Whether the label text is drawn, default true | Not declared at all; we read only `color` and `visible` (`:744-745`) |
| `density` | Body density in g/cm³ | Not in the schema |

A field in the type that the parser ignores is a promise the schema does not
keep. Either wire them or drop them.

### 1.7 Smaller mismatches

- **`sampleCount`.** Guide: default 100, range 100–200000. We clamp to
  100–50000 (`CatalogLoader.ts:1382`), so a catalog asking for 100000
  samples silently gets less than half of them.
- **`alongTrackDivisions`.** Guide default 1000; observation-only field, not
  in our schema.
- **`class` vocabulary.** Guide: `planet`, `satellite`, `asteroid`, `dwarf
  planet`, `reference point`, `other`, plus `spacecraft`, `sensor`,
  `observation`. We document `moon` where they say `satellite` and `location`
  where they say `reference point`. Only `star`, `spacecraft` and `instrument`
  actually drive behaviour today, so this is mostly cosmetic — except for
  `sensor`, per §1.2.
- **Mesh formats.** Guide: `.3ds` and `.cmod`. We support `.cmod` plus GLTF
  and OBJ, and no `.3ds` — the Cassini example's model would not load.

### 1.8 Things I checked that are already right

Recorded so the next reader does not re-check them: `require` resolution and
ordering, `spiceKernels` at catalog and item level with `.tm` meta-kernel
expansion (`CatalogResolver.ts`, `apps/viewer/src/lib/metakernel.ts`),
relative-path resolution against the declaring catalog, `meshRotation` read as
SPICE-order `[w,x,y,z]` (`BodyMesh.ts:232-241`), `fade` in the same direction
the guide gives (0 opaque, 1 most faded), `mass` with the `Mearth` suffix,
`Globe.radii` as a tri-axial triple, `Rings.innerRadius`/`outerRadius`/
`texture`, and hex colour strings alongside RGB triples.

### 1.9 The guide's linking rules, as a validation spec

§8 lists the cross-file identities Cosmographia relies on. This is a
ready-made specification for issue #10, better than anything we would invent:

| Must be identical |
|---|
| spacecraft `items:name` = sensor `items:parent` = sensor `items:center` = sensor `trajectoryFrame:body` = sensor `bodyFrame:body` |
| sensor `items:name` = observation `geometry:sensor` |
| sensor `geometry:target` = observation `items:center` = observation `trajectoryFrame:body` = observation `bodyFrame:body` |

| Must be *different* versions of each other |
|---|
| `items:center` (Cosmographia name) vs `trajectory:center` (SPICE name) |

Plus: parameters are case-sensitive; load order is SPICE data → spacecraft →
natural bodies → sensors → observations, and a `require` list must respect it.
Our resolver already orders dependencies-first, so a Cosmographia `load` file
works — but nothing checks any of the identities above, and the guide's own
troubleshooting section says a mismatch shows up as a "cannot be found" error,
which is precisely the class of error we currently swallow.

## 2. Viewer behaviour — second-hand, from the online guide

The PDF does not cover the GUI. These come from cosmoguide.org page summaries
and the upstream in-app help, and are unverified against a primary source.

**A SPICE error surface.** The PDF *does* describe the symptom first-hand: when
data are missing, "a 'No Spice Data' warning with the full or abbreviated list
of SPICE names of bodies and/or frames will appear across the top of the
Cosmographia window and the object associated with this gap may jump to the
Sun (as default)", with the reasons readable in a "Spice Log" under the File
menu. Two ideas we lack: a banner that names the bodies and frames with no
data, and a log the author can open. We write both to the browser console,
where a mission author will not look. Issue #10's validation warnings need the
same destination. The guide's list of usual causes is a good first message
catalogue: missing CK for articulating instruments, CK gaps, wrong `bodyFrame`
name, wrong `instrName`.

**Load warnings rather than load failures.** "Cosmographia will not crash due
to any syntax error in catalog files"; it warns on redefinition of existing
bodies and on inconsistent SPICE frames in two-step orientation definitions,
and loads anyway. That is the posture issue #10 should copy.

**A rendering-frame selector.** The camera is locked to a reference frame
centred on the central body, chosen from four kinds, switched from the object
context menu and from scripts (`setCameraToInertialFrame`,
`setCameraToBodyFixedFrame`, `trackObject`). Issue #13 wants to generalise our
SPICE-frame camera lock; this is the taxonomy to generalise to, and its
placement on the object rather than in a settings panel is the part that makes
it usable.

**Object context menu** — *Set as Center*, *Set as Fixed Center*, *Track*,
plus frame visualisation. We have selection and a body drawer and no context
menu. `Track` is what makes the documented flyby recipe work: go to the
spacecraft, track the target, drag it where you want it, run time forward.

**Command line and state URL.** `Cosmographia -u "url" -p script catalog
catalog ...`. Our viewer already deep-links a built-in demo by name
(`?catalog=<name>`, `apps/viewer/src/App.svelte:165`), so `?view=` is the
remaining half of ROADMAP's shareable-state-URL entry; `cosmo-demos` ships a
parser showing the URL's shape (11–12 `&`-separated fields, of which `x,y,z`
and `qw,qx,qy,qz` are the camera).

**Scripting.** Issue #14 plans `Cosmo()` parity. Grouped as: execution timing
and annotations, time manipulation, selecting and going to objects, camera
position and orientation, orientation-only moves. Inventory seen in the
`cosmo-demos` scripts and the guide's examples: `showFullScreen`,
`pause`/`unpause`, `setTime`, `setTimeRate`, `wait`, `fadeIn`, `displayNote`,
`showObject`/`hideAllObjects`, `showTrajectory`, `showLabels`/`hideLabels`,
`hideToolBar`, `hideSpiceMessages`, `hideEcliptic`, `hideCenterIndicator`,
`hidePlanetOrbits`, `setCentralObject`, `selectObject`, `gotoObject`,
`trackObject`, `setCameraToInertialFrame`, `setCameraToBodyFixedFrame`,
`setCameraPosition`, `setCameraOrientation`, `moveAwayFromCenter`, `moveToPov`,
`dollyForward`, `circleCenterLeft`, `circleCenterRight`, `circleCenterUp`,
`showDirectionVector`, `showBodyFixedFrame`, `showLatLongGrid`.

**Keyboard shortcuts**, from upstream Cosmographia's in-app help (pre-SPICE;
the SPICE build may differ), against `apps/viewer/src/App.svelte:105-155`:

| Cosmographia | Cosmolabe |
|---|---|
| Space — pause | Space |
| ⌘L / ⇧⌘L / ⌘K / ⇧⌘K — time rate ×10, ×2, ÷10, ÷2 | ↑ / ↓, one rate step |
| ⌘J — reverse time | `r` |
| ⌘[ / ⌘] — step a day; ⇧⌘] — step a year | ← / →, one scrub step |
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
gives coarse and fine variants of the same time key. Our single-step arrows
make scrubbing a long mission tedious in a way the shortcut table, not the
time controls, is responsible for.

## 3. Still unread

The online guide's other pages remain the only source for the GUI, and the
PDF's own scope note says the templates and the on-line documentation carry
directives it does not show. Specifically still second-hand or unknown:

- The geometry-type list beyond `Globe` / `Mesh` / `Rings` — the online pages
  mention SPICE DSK, `ParticleSystem`, `KeplerianSwarm`, `TimeSwitched`; the
  PDF describes only the first three.
- Two-step orientation (`rotationModel` + `intermediateFrame`), which the PDF
  mentions only through its load-warning text. We have no `intermediateFrame`.
- `TwoVector` frame details, and the full frame-type vocabulary.
- The `colorScheme` parameter behind `showResWithColor`.
- The four rendering-frame kinds and their switching semantics.
- The full scripting function list with signatures.
- Whether an `observation` item is selectable and centrable, or render-only.

## Sources

- *Cosmographia-SPICE User's Guide*, version 8.0, 14 August 2015 — the PDF read for §1
- [SPICE-enhanced Cosmographia User's Guide](https://cosmoguide.org/) — the online guide, source for §2
- [`claurel/cosmographia`](https://github.com/claurel/cosmographia) — upstream source and `data/help/`
- [`NablaZeroLabs/cosmo-demos`](https://github.com/NablaZeroLabs/cosmo-demos) — SPICE-enhanced tutorial scenes
- [NAIF Cosmographia](https://naif.jpl.nasa.gov/naif/cosmographia.html) — program and kernels
