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
| `require` | Array of other catalog URLs to load first, resolved relative to this file |
| `spiceKernels` | Array of kernel URLs (or `{ url, size, label }`) this scene needs. Also accepted per item. |

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
| `trajectoryFrame` | string | Reference frame the trajectory is expressed in (e.g. `"J2000"`, `"EclipticJ2000"`, `"ICRF"`). |
| `bodyFrame` | string | Reference frame of the body's orientation. |
| `label` | object | `{ "color": [r, g, b], "text": "..." }` for the on-screen label |
| `trajectoryPlot` | object | Orbit-trail config: `{ "color", "fade", "duration", "visible" }` |
| `items` | array | Children — bodies whose `center` is implicitly this one |

## Trajectories

Ten types, picked by `trajectory.type`:

| Type | When to use | Key fields |
|---|---|---|
| `FixedPoint` | A body that doesn't move | `position: [x, y, z]` (km) |
| `FixedSpherical` | Surface point given as lat/lon | `latitude`, `longitude`, `radius` |
| `Keplerian` | Closed-form analytic orbit | `semiMajorAxis`, `eccentricity`, `inclination`, `ascendingNode`, `argOfPeriapsis`, `meanAnomaly`, `epoch`, optional `period` |
| `Builtin` | JPL DE ephemeris for solar-system bodies | `name` (e.g. `"Earth"`, `"Mars"`) |
| `Spice` | High-precision SPK kernel ephemeris | `target`, `center`, `frame` |
| `InterpolatedStates` | Tabulated state vectors (e.g. sim output) | `source` (`.xyzv` URL) **or** inline `samples` array |
| `ChebyshevPoly` | Pre-fit Chebyshev coefficients | `coefficients`, `interval` |
| `TLE` | NORAD two-line elements (SGP4/SDP4) | `line1`, `line2` |
| `LinearCombination` | Weighted sum of other trajectories | `terms: [{ trajectory, weight }]` |
| `Composite` | Time-switched arcs of different sources | `arcs: [{ startEt, endEt, trajectory }]` |

**TLE objects** must set `trajectoryFrame: "J2000"` since SGP4 outputs are TEME but the renderer expects J2000-relative positions.

## Rotation models

Six types, picked by `rotationModel.type`:

| Type | Purpose |
|---|---|
| `Uniform` | Constant rotation rate. Fields: `period`, `inclination`, `ascendingNode`, `meridianAngle` |
| `Fixed` | A constant orientation. Fields: `quaternion: [x, y, z, w]` |
| `FixedEuler` | A constant orientation given as Euler angles. Fields: `axes: "XYZ"`, `angles: [a, b, c]` |
| `Interpolated` | Tabulated quaternion samples, SLERP-interpolated. Fields: `samples: [[et, x, y, z, w], …]` |
| `Spice` | SPICE CK kernel. Fields: `frame`, `center` |
| `Nadir` | Spacecraft pointed at a target body's nadir vector. Fields: `target`, `center` |

`Builtin` is also accepted as a rotation type for legacy IAU body rotations.

## Geometry

What gets drawn at the body's position. Picked by `geometry.type`:

| Type | What it draws | Key fields |
|---|---|---|
| `Globe` | Textured sphere; optionally with streaming terrain | `radius`, `baseMap`, `normalMap`, `nightMap`, `atmosphere`, `terrain` |
| `Mesh` | A 3D model (GLTF, OBJ, CMOD) | `source`, `size`, `meshRotation` |
| `Sensor` | Instrument FOV cone | `target`, `shape` (`circular` / `elliptical` / `rectangular`), `horizontalFov`, `verticalFov`, `frustumColor`, `frustumOpacity` |
| `Rings` | Planetary rings | `innerRadius`, `outerRadius`, `texture` |
| `Axes` | Reference frame axes | `length` |
| `KeplerianSwarm` | Many bodies sharing a parent (asteroid belt, debris cloud) | `bodies: []` |
| `ParticleSystem` | Plumes, exhaust, dust | (renderer-specific) |
| `TimeSwitched` | Different geometry at different times | `arcs: [{ startEt, endEt, geometry }]` |

### `Globe.terrain`

Streaming terrain over the basemap. Supports three sources:

```json
"terrain": { "type": "tiles", "url": "...", "tileFormat": "qm" }
"terrain": { "type": "ion", "assetId": 1, "accessToken": "..." }
"terrain": { "type": "imagery", "imagery": { "url": "...{z}/{y}/{x}.jpeg", "levels": 8 } }
```

## Frames

Reference frames, used in `trajectoryFrame` and `bodyFrame`:

- **Inertial (4):** `EclipticJ2000` (default), `EquatorJ2000` / `J2000`, `EquatorB1950`, `ICRF`
- **`BodyFixed`** — rotates with a body
- **`TwoVector`** — defined by two reference vectors (e.g. an LVLH-like frame)

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
| Distance | `m`, `km` (default), `au` |
| Duration | `s`, `min`, `h`, `d`, `y` |
| Mass | `g`, `kg`, `Mearth` |

Examples: `"1.5h"`, `"42164km"`, `"1au"`.

One parser serves both quantities, so **`m` always means metres**, never
minutes. Cosmographia's catalogs write durations with `m` for minutes, `a` for
years and `ms` for milliseconds; write `min`, `y` and fractional `s` here
instead. An unrecognised suffix is ignored and the bare number is used — km for
a distance, seconds for a duration — so `"90 m"` is 0.09 seconds, not 90
minutes. See [cosmographia-parity.md](cosmographia-parity.md) §1.4.

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

## More examples

The `apps/viewer/test-catalogs/` directory contains end-to-end catalogs you can copy from:

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

There are two ways to get kernels in front of a catalog, and they compose.

**Named in the catalog.** A catalog may list the kernels its scene needs, at
the top level or on any individual item:

```json
{
  "version": "1.0",
  "name": "Cassini",
  "require": ["spacecraft_cassini.json", "sensors/iss_nac.json"],
  "spiceKernels": ["kernels/cas_2004_v27.tm", "kernels/naif0012.tls"]
}
```

`loadCatalogFromUrl(...)` walks the `require` graph dependencies-first,
resolves every path against the catalog that named it, and returns the
de-duplicated kernel list alongside the catalogs. The viewer furnishes them,
expanding `.tm` meta-kernels into their `KERNELS_TO_LOAD` entries on the way.
This is the shape a Cosmographia mission directory already has — a SPICE-data
catalog, a catalog list, and per-object files — so those load as authored.

**Furnished separately.** Kernels can also be dropped into the demo viewer or
loaded with `Spice.loadKernel(...)` before `CatalogLoader.load(...)`, and a
catalog that names none of its own works that way. Keeping a catalog
kernel-free is what lets the same scene be replayed against different kernel
sets (development predicts vs. reconstructed ephemerides).

Either way the catalog parses without the kernels; a `"trajectory": { "type":
"Spice", … }` only fails when it is evaluated at render time.
