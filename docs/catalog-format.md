# Catalog format

A **catalog** is a JSON file that describes a 3D mission scene — which bodies are present, where they are, how they rotate, what they look like, and how the camera sees them. It is the primary configuration format for Cosmolabe.

You write a catalog once; the viewer renders it. There is no code path to wire up bodies, trajectories, or instruments in TypeScript unless you want to.

> **Background.** The format originated with NASA JPL's [Cosmographia](https://naif.jpl.nasa.gov/naif/cosmographia.html), a desktop visualization app. Cosmolabe reimplements it for the browser, so existing Cosmographia catalogs (for example the ones shipped with Cassini, Dawn, MRO mission packages) load unmodified — but you do **not** need any prior Cosmographia knowledge to write one. This document covers everything you need.

## A 30-second example

```json
{
  "name": "Earth + ISS",
  "defaultTime": "2025-01-01T00:00:00Z",
  "items": [
    {
      "name": "Earth",
      "class": "planet",
      "trajectory": { "type": "Builtin", "name": "Earth" },
      "geometry": { "type": "Globe", "radius": 6378, "baseMap": "earth.jpg" },
      "items": [
        {
          "name": "ISS",
          "class": "spacecraft",
          "center": "Earth",
          "trajectoryFrame": "J2000",
          "trajectory": {
            "type": "TLE",
            "line1": "1 25544U 98067A   25001.50000000  .00010000  00000-0  18000-3 0  9990",
            "line2": "2 25544  51.6400  90.0000 0005000 100.0000 260.0000 15.50000000400000"
          },
          "trajectoryPlot": { "color": "#ffcc00", "duration": "1.5h" }
        }
      ]
    }
  ]
}
```

Drop this file into the viewer (or pass it to `CatalogLoader.load()`) and you get an Earth globe with ISS orbiting it, rendered at the configured time.

## Top-level structure

| Field | Meaning |
|---|---|
| `name` | Display name for the scene |
| `version` | Optional schema version string |
| `defaultTime` | ISO-8601 timestamp the scene opens at |
| `defaultViewpoint` | Name of a `Viewpoint` item to start the camera on |
| `items` | Array of bodies, viewpoints, and visualizers |

Each entry in `items` is either:

- A **body** (the default — no `type` field, or any other type the loader doesn't otherwise recognize),
- A **`Viewpoint`** — a named camera preset, or
- A **`Visualizer`** / **`FeatureLabels`** — overlay metadata (lat-lon labels, surface annotations).

Bodies can nest other bodies via their own `items` array, which is how you build hierarchy (Sun → Earth → Moon).

## Body fields

| Field | Type | Notes |
|---|---|---|
| `name` | string | Required. Used as the body's lookup key (`universe.getBody('LRO')`). |
| `class` | string | `star`, `planet`, `dwarf planet`, `moon`, `spacecraft`, `asteroid`, `comet`, `location` — controls default styling |
| `center` | string | Name of the parent body whose state coordinates are relative to. Defaults to the Sun. |
| `trajectory` | object | How position evolves over time. See [Trajectories](#trajectories). |
| `rotationModel` | object | How orientation evolves over time. See [Rotation models](#rotation-models). |
| `geometry` | object | What gets drawn at the body's position. See [Geometry](#geometry). |
| `trajectoryFrame` | string | Frame the trajectory is expressed in, by name (e.g. `"J2000"`, `"EclipticJ2000"`, `"ICRF"`, `"TEME"`, `"IAU_MARS"`, `"BodyFixed"`). See [Frames](#frames). Defaults to `EclipticJ2000`. Also accepted on each `arcs[]` entry. A `Spice` trajectory is queried in this frame too; there is no `frame` inside the trajectory. |
| `bodyFrame` | string | The inertial frame a `Uniform`, `Fixed` or `FixedEuler` rotation is stated in, when the rotation model does not name one with `inertialFrame`. Other rotation types are oriented by their own frame and do not read it. |
| `label` | object | `{ "color": [r, g, b], "visible": false }` for the on-screen label |
| `trajectoryPlot` | object | Orbit-trail config: `{ "color", "fade", "duration", "lead", "opacity", "visible", "sampleCount", "lineWidth" }`. `visible` belongs here, not inside `trajectory`. |
| `naifId` | number | NAIF ID, for SPICE radius lookup |
| `mass` | number or string | kg, or with a unit suffix (see [Values and units](#values-and-units)) |
| `radii` | array | `[a, b, c]` triaxial radii in km (overrides SPICE and `geometry`) |
| `arcs` | array | Mission phases, each `{ "startTime", "endTime", "center", "trajectoryFrame", "trajectory", "showLine", "numKeySamples" }`; the same as a `Composite` trajectory |
| `startTime` / `endTime` | string | Bounds of the first and last `arcs` entry when they leave them out. On an item without `arcs` they are accepted (Cosmographia writes them) but do not yet limit when the body is shown. |
| `spiceKernels` | array | Kernels this item needs, added to the catalog's list |
| `items` | array | Children — bodies whose `center` is implicitly this one |

## Trajectories

Picked by `trajectory.type`:

| Type | When to use | Key fields |
|---|---|---|
| `FixedPoint` | A body that doesn't move | `position: [x, y, z]` (km) |
| `FixedSpherical` | Surface point given as lat/lon | `latitude`, `longitude`, `radius` |
| `Keplerian` | Closed-form analytic orbit | `semiMajorAxis`, `eccentricity`, `inclination`, `ascendingNode`, `argOfPeriapsis` (or `argumentOfPeriapsis`), `meanAnomaly`, `epoch`, optional `period` |
| `Builtin` | JPL DE ephemeris for solar-system bodies | `name` (e.g. `"Earth"`, `"Mars"`) |
| `Spice` | High-precision SPK kernel ephemeris | `target`, `center`; the frame is the item's `trajectoryFrame` |
| `InterpolatedStates` | Tabulated state vectors (e.g. sim output) | `source` (`.xyzv` URL) **or** inline `samples: [{ et, position, velocity }]` |
| `OEM` | A CCSDS Orbit Ephemeris Message (needs an LSK) | `source` (the OEM file) |
| `ChebyshevPoly` | Pre-fit Chebyshev coefficients | `source` (a `.cheb` file), optional `period` |
| `TLE` | NORAD two-line elements (SGP4/SDP4) | `line1`, `line2`, optional `windowDays` |
| `LinearCombination` | Weighted sum of two trajectories | `trajectories: [a, b]`, `weights: [wa, wb]`, optional `period` |
| `Composite` | Time-switched arcs of different sources | `arcs: [{ startTime, endTime, center, trajectoryFrame, trajectory }]` (`segments` is accepted for `arcs`) |
| `Waypoints` | A surface track through timed lat/lon/alt points | `referenceRadius`, `epoch`, `waypoints: [{ t, lat, lon, alt }]`, optional `useAbsoluteAlt` |
| `TASS17`, `L1`, `Gust86`, `MarsSat` | Analytic theories for the moons of Saturn, Jupiter, Uranus and Mars | `satellite` (defaults to `name`, then the item's name) |

A Keplerian orbit propagates with the center's GM, from a built-in table of the Sun and planets. A `period` (days, or with a unit suffix such as `"11.97h"`) overrides it, and is required for a center the table does not list.

Some trajectory types know their own frame, and that frame is used whatever `trajectoryFrame` says: **TLE** output is TEME, **FixedSpherical** and **Waypoints** are body-fixed to the item's `center`, an **OEM** file's `REF_FRAME` is its frame, and a **Spice** trajectory is in the frame it is queried in. TLE items no longer need `trajectoryFrame: "J2000"` (it is ignored), and TEME is now rotated into J2000 with precession and nutation instead of being treated as J2000. That rotation is about 20 arcminutes by 2026, or tens of km at LEO.

## Rotation models

Picked by `rotationModel.type`:

| Type | Purpose |
|---|---|
| `Builtin` | A solar-system body's IAU body-fixed frame. Optional `name` (default `IAU_<BODY>`). See [Planets and moons](#planets-and-moons). |
| `Uniform` | Constant rotation rate. Fields: `period`, `inclination`, `ascendingNode`, `meridianAngle` |
| `Fixed` | A constant orientation. Fields: `quaternion: [w, x, y, z]`, or `inclination`, `ascendingNode`, `meridianAngle`; optional `inertialFrame` |
| `FixedEuler` | A constant orientation given as Euler angles. Fields: `sequence: "XYZ"`, `angles: [a, b, c]` (degrees); optional `inertialFrame` |
| `Interpolated` | Tabulated quaternions, SLERP-interpolated. Fields: `source` (a `.q` file) or inline `records: [{ "et": …, "q": [w, x, y, z] }, …]`; optional `inertialFrame` |
| `Spice` | Any SPICE frame (CK, PCK or frame kernel). Fields: `bodyFrame` (default `IAU_<BODY>`), `inertialFrame` (default: the item's `trajectoryFrame`) |
| `Nadir` | Spacecraft pointed at a target body's nadir vector. Fields: `target`, `center`, optional `inertialFrame` |
| `SurfaceUp` | A surface vehicle whose +X axis follows local up on its parent. No fields |

`Uniform` also takes `epoch`, and `ascension`/`declination` (the pole's RA/Dec directly) in place of `inclination`/`ascendingNode`.

### Planets and moons

Use `{ "type": "Builtin" }` for any body that has an IAU orientation model. When a PCK with the body's data is loaded (`base/naif.json` loads `pck00011.tpc`), the globe is oriented by SPICE's `IAU_<BODY>` frame at the current epoch. That frame includes the pole, the prime meridian, pole precession, and the nutation and libration terms in the PCK. It is the same transform that sub-points, footprints and event searches use, so the rendered globe and the analysis cannot disagree. Without SPICE, or when the loaded kernels have no orientation data for the body, `Builtin` falls back to a constant-rate IAU model for the Sun, the major planets, the Moon and Pluto. That model is within about 1° of the PCK (about 2° for the Moon, whose libration it leaves out). Moons have no fallback, so they stay unrotated without a PCK.

Keep `Uniform` for bodies with no IAU model: synthetic objects, most asteroids, and chaotic rotators like Hyperion. Its `inclination` and `ascendingNode` place the pole at RA = `ascendingNode` − 90° and Dec = 90° − `inclination`, in the J2000 **equatorial** frame unless `inertialFrame` says otherwise. Do not copy a planet's axial tilt relative to its orbit into `inclination`: that is measured from a different plane. For Jupiter it puts the pole about 25° from where it belongs.

## Geometry

What gets drawn at the body's position. Picked by `geometry.type`:

| Type | What it draws | Key fields |
|---|---|---|
| `Globe` | Textured sphere; optionally with streaming terrain | `radius` or `radii`, `baseMap`, `normalMap`, `displacementMap` (+ `displacementScale`, `displacementBias`), `bumpMap` (+ `bumpScale`), `atmosphere`, `terrain`, `surfaceTiles` |
| `Mesh` | A 3D model (GLTF, OBJ, CMOD) | `source`, `size` (or `scale`), `meshRotation` (`[w, x, y, z]`), `meshOffset` |
| `Sensor` | Instrument FOV cone | `target`, `spiceId`, `shape` (`rectangular` / `elliptical`), `horizontalFov`, `verticalFov`, `range`, `orientation`, `frustumColor`, `frustumOpacity` |
| `Rings` | Planetary rings | `innerRadius`, `outerRadius`, `texture` |

Any geometry also takes `emissive: true` (self-lit, e.g. the Sun), `castShadow: true`, and `surfaceLock` (keep a surface body on the terrain: `true`, `"aboveTerrain"` or `{ "mode": "aboveTerrain" }`).

Sensor fields sit directly on the geometry, not in a nested `sensor` object. Cosmographia's `Axes`, `KeplerianSwarm`, `ParticleSystem` and `TimeSwitched` geometry types load, but no renderer draws them yet: the body gets the default placeholder.

### Asset paths

Relative paths in `Mesh.source`, a Globe's `baseMap`, `normalMap`, `displacementMap`, `bumpMap` and tile `template`/`topLayer`, `terrain.url`, `terrain.imagery[].url`, `surfaceTiles[].url` and `Rings.texture` resolve against **the catalog file that contains them**. This matches how `require` and `spiceKernels` already resolve. A catalog at `…/scenes/main.json` that says `"source": "../models/spacecraft.glb"` loads `…/models/spacecraft.glb`, wherever the viewer itself is hosted. Absolute URLs and root-relative paths (`/tiles/`) are used as written.

### `Globe.terrain`

Streaming terrain over the basemap. Supports three sources:

```json
"terrain": { "type": "quantized-mesh", "url": "..." }
"terrain": { "type": "cesium-ion", "cesiumIonAssetId": 1, "cesiumIonToken": "..." }
"terrain": { "type": "3dtiles", "url": "..." }
"terrain": { "type": "imagery", "imagery": { "url": "...{z}/{y}/{x}.jpeg", "levels": 8 } }
```

`imagery` may be one layer or an array of them, draped over the terrain. The tuning keys (`errorTarget`, `maxCacheBytes`, `referenceRadiusOffsetKm`, `skirtScale`, `fadeDurationMs`, …) are listed with the rest of the accepted keys in `packages/core/src/catalog/CatalogSchema.ts`.

## Frames

Frames are named, and every name resolves through one registry (`Universe.frames`, a `FrameRegistry`). Each frame knows its rotation to ICRF at any epoch, and a conversion between two frames is composed from those rotations. `Universe.absolutePositionOf` applies the right rotation on every leg of the parent chain, so a J2000 moon of an ecliptic planet, a TEME satellite and a surface point all land in the ecliptic scene frame without any rotation done in the app. Names are case-insensitive.

| Frame | Aliases | Kind | SPICE path | SPICE-free path |
|---|---|---|---|---|
| `ECLIPJ2000` | `EclipticJ2000`, `ecliptic` | inertial (the scene frame, and the default) | fixed matrix | same |
| `EME2000` | `J2000`, `EquatorJ2000`, `equatorial` | inertial | fixed matrix | same |
| `ICRF` | `GCRF` | inertial | identity to EME2000, as in SPICE | same |
| `EME2000_IERS` | | inertial | FK5 J2000 with the IERS 2003 frame bias (~23 mas from ICRF); for data from bias-aware producers | same |
| `B1950`, `FK4`, `ECLIPB1950`, `GALACTIC` | `EquatorB1950` | inertial | SPICE's fixed matrices | same |
| `MOD`, `TOD`, `TEME` | `TETE` (TOD) | inertial, time-dependent | IAU-1976 precession, IAU-1980 nutation | same (SPICE has no TEME) |
| `ITRF` | `ITRF93`, `ITRF2000`…`ITRF2020`, `ECEF`, `TDR` | Earth-fixed | SPICE `ITRF93` when a binary Earth PCK is loaded | TEME + GMST, with UT1 ≈ UTC (≤ 0.4 km at the surface) |
| `IAU_<BODY>` | | body-fixed | the body's own `rotationModel`, else SPICE's PCK frame | the body's own `rotationModel` |
| `BodyFixed` | `body-fixed` | body-fixed to the item's current `center` | resolves to `IAU_<CENTER>` | same |
| any SPICE frame | | per SPICE | `pxform` (CK, TK and dynamic frames, `MOON_ME`, …) | not resolvable |

The static inertial frames use their fixed matrices even when SPICE is loaded. They are identical to SPICE's built-in definitions (the tests check this to 1e-12) and keep `pxform` off the per-frame path. EME2000 and ICRF are distinct names with an identity rotation between them. SPICE treats `J2000` as ICRF-aligned, and every JPL ephemeris is delivered that way, so applying the ~23 mas frame bias would offset SPICE-driven planets by about 17 km at 1 AU. What "EME2000" means depends on who wrote the file. From JPL and SPICE tools it is SPICE's J2000, which is ICRF-aligned; from Orekit, STK or GMAT it is FK5 J2000, which carries the bias. For the second kind, set `"trajectoryFrame": "EME2000_IERS"`: on an OEM whose `REF_FRAME` is EME2000 or ICRF, that declaration refines the file's label rather than being reported as a mismatch.

Rendered accuracy is pinned end to end in `spice-oracle.test.ts`: positions after the renderer's floating-origin, scale and float32 step are checked against SPICE. Error is float32 rounding relative to the tracked body, about 1e-7 of the distance (tens of metres across the Saturn system from Cassini).

When a catalog frame reaches SPICE (a `Spice` or `Builtin` trajectory, a `Spice` rotation), it goes out in SPICE's spelling (`EclipticJ2000` → `ECLIPJ2000`, `EME2000` → `J2000`). Frames SPICE cannot know (TEME, declared frames) are queried in J2000 and labelled as such.

Cosmographia's structured form `"trajectoryFrame": { "type": "BodyFixed", "body": "Mars" }` is accepted on items and arcs. It means `IAU_MARS`, the named body's frame, which need not be the center. Without `body` it means `BodyFixed`. When SPICE has no definition of such a frame (for example `IAU_CASSINI`), a `Spice` trajectory is fetched in J2000 instead, which is still exact.

A frame nothing can resolve is reported once when the catalog loads, and positions in it are then used unrotated. With SPICE loaded, a name SPICE does not recognize is reported too. Arc frames are checked, and so are `IAU_<BODY>` frames with no body or SPICE frame behind them.

### Declaring frames

A catalog can declare frames that are fixed relative to another frame (the equivalent of a SPICE TK frame). Declared frames are registered before any item loads:

```json
"frames": [
  { "name": "PAD_39A_TOPO", "base": "IAU_EARTH", "quaternion": [0.7071, 0, 0, 0.7071] },
  { "name": "INSTRUMENT_REF", "base": "EME2000", "matrix": [1, 0, 0, 0, 0, -1, 0, 1, 0] }
]
```

`quaternion` (`[w, x, y, z]`) or row-major `matrix` gives the rotation that takes vectors in the new frame into `base`. The frame's kind (inertial or body-fixed) follows its base. Apps can do the same through `universe.frames.defineFixedFrame(...)`, or pass any `FrameDefinition` to `universe.frames.register(...)`.

### State-dependent frames

LVLH, RIC/RSW, RTN, VNC and similar frames are **not** registry frames, and naming one as a `trajectoryFrame` is rejected with a warning. Their orientation is built from a spacecraft's position and velocity relative to a central body, so it depends on another body's state as well as on the epoch. They are therefore a different kind of object from the frames above, which are all "a rotation to ICRF at an epoch". Use `TwoVectorFrame` (`bodyFrame: { "type": "TwoVector", … }`) for orientation defined this way.

## Viewpoints

Named camera presets. Each is an item with `"type": "Viewpoint"`:

```json
{
  "name": "Track LRO",
  "type": "Viewpoint",
  "center": "LRO",
  "distance": 500,
  "latitude": 20,
  "longitude": 0,
  "time": "2025-01-15T00:00:00Z"
}
```

`distance` is in kilometers from `center`, and `latitude`/`longitude` place the
camera over that point on the centre body's surface.

`time` is optional. When it is set, going to the viewpoint **also seeks the
clock to that moment** — from the Viewpoint menu, from `defaultViewpoint` on
load, and from the visual-regression capture hook alike. It is read like every
other catalog date (see *Values and units* below), so it is UTC whether or not
it carries a `Z`. The camera's `latitude`/`longitude` offset is oriented using
the centre body's attitude *at that same epoch*, so a viewpoint named for a
flyby months away from `defaultTime` still looks at the face it names.

A viewpoint with no `time` leaves the clock exactly where it was — it is a
camera preset and nothing more. This is the difference between "show me the
rings from the side" and "show me the Huygens landing".

An unparseable `time` is reported on the console and then ignored, rather than
being silently rounded to J2000: a viewpoint that quietly jumps to the year 2000
looks like a working scene aimed at empty space.

Reference one in `defaultViewpoint` to open on it. If that viewpoint declares a
`time`, it wins over the catalog's `defaultTime` — the scene opens at the moment
the viewpoint names.

## Values and units

The loader accepts numeric values with unit suffixes:

| Quantity | Suffixes |
|---|---|
| Distance | `mm`, `cm`, `m`, `km` (default), `au` |
| Duration | `ms`, `s`, `min`, `h`, `d`, `y` |
| Mass | `g`, `kg`, `Mearth` |

Examples: `"1.5h"`, `"42164km"`, `"1au"`.

**Colors** can be `[r, g, b]` floats in `[0, 1]`, hex strings (`"#ffcc00"`), or named CSS colors.

**Dates** can be ISO-8601 (`"2025-01-01T00:00:00Z"`) or Julian-day numbers.

### How epochs are read

Every date in a catalog is **UTC**, whether or not it carries a `Z`. A naive
string like `"2004-07-01T02:48:00"` is read as UTC, not as the viewer's local
time, so a catalog renders the same scene in every timezone.

Two paths convert a date to ephemeris time, and they agree:

- **With a leapseconds kernel furnished** (`naif0012.tls`), SPICE `str2et` reads
  the string. This is authoritative and accepts forms JS does not — day-of-year
  (`"2004-183T02:48:00"`), `JD` prefixes, era suffixes.
- **Without SPICE**, core converts using its own leap-second table. This is
  exact to the millisecond against `str2et` across the table's range
  (1972 onward), so a SPICE-free build is not seconds off the SPICE one.

Two things to know:

- **`J2000` is noon TDB, not noon UTC.** ET `0` is `2000-01-01T11:58:55.816Z`.
  An epoch written as `"2000-01-01T12:00:00Z"` is ET `64.184`, not `0`.
- **The SPICE-free path cannot read day-of-year form.** It warns and falls back
  to J2000 rather than failing silently — but J2000 is almost certainly not what
  the catalog meant, so either furnish an LSK or write the epoch as ISO 8601.

Epochs before 1972 use the SPICE-free table's clamp and are off by about a
second; furnish an LSK if a pre-1972 epoch has to be exact.

## Unknown keys

JSON accepts any key, so a misspelled or misplaced one used to be dropped without a word, and the scene still rendered, just without what the key asked for. The loader now checks every node against the keys the code actually reads for that node type, and prints a console warning for each key that isn't one. The warning names the key, the node that owns it, its JSON path, and the most likely fix:

```
[Cosmolabe] catalog "MoonFall": unknown key "visible" on Builtin trajectory of "Earth" ($.items[4].trajectory) is not read and has no effect. Did you mean "visible" in trajectoryPlot?
```

An unknown trajectory or rotation `type` is reported the same way, unless a custom factory handles it. Its fields are not checked, and neither are the fields of a geometry type that no renderer here knows, since they belong to code the loader cannot see. `validateCatalog(json)` returns the same diagnostics without printing them, for an editor or a CI check. The shipped catalogs are tested to produce none.

## More examples

The `apps/viewer/test-catalogs/` directory contains end-to-end catalogs you can copy from. They are listed on the viewer's home screen and catalog browser by `test-catalogs/index.json`; see [catalog-sources.md](catalog-sources.md) for how a deployment chooses which catalogs it offers.

| File | What it shows |
|---|---|
| `iss.json` | Minimal TLE-driven Earth + ISS — no SPICE kernels needed |
| `lro-moon.json` | LRO at the Moon with high-res Moon textures |
| `cassini-soi.json` | Cassini at Saturn-Orbit-Insertion with rings, sensor frustums, multiple viewpoints |
| `europa-clipper.json` | Multi-body Jupiter system + Galilean moons |
| `iss.json` / `sensor-demo.json` | Sensor / Mesh geometry examples |
| `solar-system.json` | Inner solar system tour (Builtin trajectories) |
| `msl-dingo-gap.json` | Surface-level rover scene (experimental) |

## SPICE kernels

Catalogs **do not** embed kernel paths. SPICE kernels are loaded separately, either via drag-drop in the demo viewer or by calling `Spice.loadKernel(...)` before invoking `CatalogLoader.load(...)`. A catalog that uses `"trajectory": { "type": "Spice", … }` will fail to evaluate at render time if the required kernel hasn't been loaded — but the catalog itself parses fine.

This separation lets the same catalog be reused with different kernel sets (e.g. development predicts vs. reconstructed ephemerides).
