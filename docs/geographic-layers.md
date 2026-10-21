# Planetary geographic vector data

`geographicLayers` loads static GeoJSON as body-scoped scene data. This is the
data/import contract for #196; it does not draw features. Renderers, inspectors
and later editing tools consume `universe.geographicLayers`. No GIS service,
account, built-in dataset or SPICE engine is required for import.

Add this to a catalog that loads the body (directly or through `require`):

```json
{
  "name": "Jezero operations",
  "require": ["../bodies/mars.json"],
  "geographicCoordinates": {
    "latitude": "planetocentric",
    "longitudeDirection": "east",
    "longitudeDomain": "0..360",
    "referenceShape": {
      "kind": "ellipsoid",
      "radiiKm": [3396.19, 3396.19, 3376.2]
    },
    "height": {
      "unit": "m",
      "datum": "ellipsoid",
      "convention": "radial"
    }
  },
  "geographicLayers": [{
    "id": "mars:jezero:science",
    "name": "Science targets and traverse",
    "body": "Mars",
    "source": "vectors/science.geojson",
    "display": { "visible": true, "color": "#ffcc00", "opacity": 0.8 },
    "provenance": { "mission": "Mars 2020", "productVersion": "1" }
  }]
}
```

Each layer may override `coordinates`; otherwise it inherits only its own
catalog's `geographicCoordinates`, never another catalog's convention. URL
sources resolve relative to the catalog that declares them, including catalogs
loaded by `require`. Ordinary static HTTPS endpoints work subject to browser CORS.
Any failed source produces a structured error record and a console diagnostic;
other layers and the rest of the catalog continue loading.

For local data, use **Open local catalog…** or drag/drop and select the catalog
JSON **together with** the referenced `.geojson` (or GeoJSON `.json`) files and
any required catalogs/assets. A catalog with only `geographicLayers` is valid.
Files retain directory-selection or dropped-directory paths. Both `require` and
geographic source paths require an exact match relative to the catalog that
declares them when meaningful directory paths are available. A same-basename
file in another directory never substitutes for a missing relative path. Only
genuinely flat selections, with no directory information, may fall back to a
unique selected basename. This selection metadata is preserved separately from
synthetic identities assigned to duplicate flat filenames. No shared basename aliases are
created for different files. Ambiguous or missing geographic sources fail that
layer without fetching a replacement from the network. Unresolved/ambiguous
required catalogs and dependency cycles fail the load before replacing the scene.
Standalone GeoJSON requires a companion catalog: the viewer reports this rather
than guessing a body or adopting Earth coordinates. This descriptor is also the
explicit opt-in to the planetary GeoJSON extension. No new import UI is needed.

## Surface layers panel

The viewer's **Surface layers** tool (rail, or "Surface layers" in the command
palette) is the one place to manage a scene's surface data, grouped by body:
each body's streamed imagery stack (the same controls as the info panel's
Imagery section, not a second manager) and its geographic vector layers.
Physical terrain appearance stays in the info panel.

Each vector layer shows visibility, colour, feature count, validation issues
(skipped features, import notes), and where it came from: **Catalog** or
**Imported file**, both read-only. Session changes are presentation only; the
imported data is never modified. Expanding a layer shows its ID, source URL or
file, catalog, coordinate convention, style defaults, provenance and import
diagnostics. *Isolate* shows only that vector layer on its body (imagery is
untouched); *Show all vectors* restores the rest. Failed sources are listed
with their errors.

Choosing a layer lists its features: search matches names and every scalar
property value; a property filter offers categories (for string fields with at
most 24 values), numeric ranges, booleans or text; **In view** keeps features
with a vertex or anchor on screen; **Filter scene too** draws only the
matching features. The list is virtualized (only visible rows are rendered)
and searches an in-memory index built once per layer, bounded by the import
limits. There is no GIS backend.

Selection is shared with the scene. Clicking a feature in 3D selects it, opens
the panel on its layer and scrolls to it; clicking a row selects it in the
scene. Selecting never moves the camera. Double-click a row, press Enter, or
use **Fly to** to fly over the feature's extent, or **Frame** to cut there,
through the shared navigation (docs/navigation.md). Bodies that are not globes
disable both, with the reason. Arrow keys move the selection in the list;
Escape clears it. One callout names the selected feature in the scene; it
hides past the horizon.

The rules that keep list, scene and details consistent:

- Hiding a layer, or a scene filter that excludes the selected feature, clears
  the selection and says why. Selecting a feature of a hidden layer from the
  list shows that layer first.
- A list-only filter does not change the scene. A scene selection outside it
  stays selected and the list says it is outside the current filter.
- Visibility, filters and selection reset when a scene loads. Closing the
  panel removes any scene filter.

The details show the feature's name, geometry, position (a Point's own
coordinates, or its extent's centre and extent) in the **layer's declared
convention**, the convention itself, the stable reference `layerId /
featureId`, its source and its properties under readable labels. A property is
a link only when it is an `http(s)` URL, and opens without access to the
viewer. *Coordinates* copies a Point's exact source numbers with their
convention; the properties header copies the unmodified source geometry.

## Coordinate interpretation

RFC 7946 GeoJSON itself means Earth WGS84. Planetary GeoJSON is an explicit
extension here; even Earth datasets must declare the descriptor. All tuples are
`[longitude, latitude]` or `[longitude, latitude, Z]` with angles in degrees.

Supported horizontal shapes are a physical sphere (`kind: "sphere", radiusKm`)
and an oblate ellipsoid (`kind: "ellipsoid", radiiKm: [a,a,c]`, `c <= a`). Supply
the dataset's reference shape, not an exaggerated renderer radius. Latitude is
`planetocentric` (radial) or `planetographic` (normal); longitude is explicitly
`east`/`west` and `0..360`/`-180..180`. Values outside that declared domain are
invalid; endpoints wrap to canonical east-positive `[-180,180)`. Original values
are retained. Edges crossing the seam keep their geometry topology; downstream
renderers must unwrap/split edges rather than connect across the long way.

Z needs an explicit `height` with `unit: "m" | "km"`, the matching reference
datum (`reference-sphere` or `ellipsoid`) and `convention: "radial"` for centric
latitude or `"geodetic-normal"` for graphic latitude. Areoid/unknown datums,
triaxial/prolate shapes, arbitrary CRS transforms and GeoJSON `crs` members are
rejected. Omit `height` for a purely 2D dataset. A missing Z remains 2D even when
other positions carry a Z; it is never assigned zero height above terrain.

Normalized vertices use the shared `BodyFixedPosition` contract: geodetic
`latDeg`, east-positive `lonDeg` and optional absolute `heightKm` above the
declared reference datum, in the layer's `IAU_<BODY>` frame. The conversion uses
the same core coordinate functions re-exported by the terrain sampler. For 3D
vertices `geographicAbsolutePosition` returns physical Cartesian km. For 2D
vertices it returns `null`: a consumer must resolve a physical surface.
`@cosmolabe/three`'s `geographicPositionOnSurface` bridges an available
`PhysicalSurface.sampleElevation` with matching body/frame/reference shape; it
returns `null` for unavailable/unsupported surfaces rather than using a display
mesh or assuming an ellipsoid is measured terrain. It does not create a
`SurfacePoint`/pick result or claim a terrain resolution.

## Data and ownership

Only `FeatureCollection` is accepted, with Point, MultiPoint, LineString,
MultiLineString, Polygon and MultiPolygon geometries. Null/empty/unsupported
geometries, nonfinite numbers, invalid dimensions, unclosed/degenerate/crossing
rings and holes outside/touching/intersecting the exterior or one another produce
per-feature diagnostics and `skippedFeatures`. A malformed feature is skipped
as a whole; valid parts of an invalid Multi geometry are not silently retained.
Ring winding is preserved. Polygon topology is checked in a seam-unwrapped
longitude/latitude plane, not on arbitrary spherical arcs. Exactly 180-degree
edges and pole-enclosing/global rings are ambiguous in this v1 contract; split
those regions into smaller polygons before importing.

Layer IDs are author-assigned, globally stable within a scene. A feature reference
is `(layer.id, feature.id)`. Source string IDs become `string:<id>`, numeric IDs
become `number:<id>`, preserving the distinction between `7` and `"7"`. Duplicate
IDs are diagnosed. Missing IDs use `index:<sourceIndex>` with a warning; those
are stable for the same source ordering only. Supply explicit IDs for references
that must survive dataset revisions. Original IDs, geometry, properties and
foreign feature members remain available in `feature.original`. JavaScript
IEEE-754 numbers are retained without conversion through float32; unsafe integer
properties warn about precision, while unsafe numeric feature IDs are rejected.
Use strings for exact integers beyond JavaScript's safe range.

A layer retains its definition, display defaults, declared conventions, source
identity, catalog identity and producer provenance. Hosted layers are
`ownership: "catalog"`; imported local layers are `ownership: "transient"`.
Neither modifies catalog JSON or represents a user-authored edit. Future editing
must keep its changes separate from imported source data. Data is plain,
serializable TypeScript/JSON with no renderer/framework objects.

`Universe.loadCatalog` installs preloaded geographic data from its `resolveFile`
option. Async hosts can instead call `loadGeographicLayers(catalog, {catalogUrl,
signal})` and pass its records to `universe.loadCatalog(catalog, {source:
catalogUrl, geographicLayers: records})`. Browser hosts can supply a worker parser;
the viewer does so for every imported layer. `geographicLayers.loads` includes
errors; `.layers`, `.get(id)` expose ready data. `geographic:changed` fires on
catalog installation. Replacing the same catalog source drops its former
definitions; later catalogs override the same layer ID. `removeCatalog(source)`
releases that owner's records, revealing any earlier definition. Disposal clears
all layers and diagnostics along with the scene. Sources own no GPU resources,
blob URLs, background subscriptions or persistent worker instances.
For programmatic catalogs without a source URL, ownership uses the catalog name
or, for unnamed catalogs, object identity; pass `source` for a persistent identity
across newly parsed revisions.

## Resource limits

Hard per-source ceilings: 2 MiB decoded UTF-8, 5,000 features, 50,000 visited
vertices (including rejected features), 1,000,000 polygon edge comparisons and
JSON nesting depth 32. Callers can lower these through `limits`. Limits are
checked before JSON traversal; HTTP bodies are streamed with an actual decoded
byte cap, regardless of Content-Length. A catalog has at most 16 layers and an
8 MiB source-text budget; the viewer additionally caps a scene import at 64
sources/16 MiB. Reads/parses are sequential to bound peak memory. Source fetches
and parser workers have 15-second timeouts. In the viewer, the entire optional
geographic phase also shares one 15-second deadline across all catalogs in the
require graph. At the deadline, pending reads/workers are cancelled and remaining
layers receive error diagnostics; already imported layers and the base scene can
still load. A source exceeding a work/size budget
fails as a whole; previously accepted features from it are not presented as a
complete layer. Worker termination releases parser memory on completion, error,
timeout or cancellation. Starting another scene load cancels pending geographic
imports. Cancelled older loads cannot close or reset the active load's progress.
Local `.geojson` files are size-checked before reading. Large `.json` files are
classified with a bounded-memory stream of their root `type` before reading the
full text: the geographic byte ceiling applies to GeoJSON, while legitimate
catalog JSON retains its existing size behavior.

The `FeatureLabels` Cosmographia placeholder remains ignored by `CatalogLoader`;
it is not a geographic layer definition, and is not converted into this model.
Named-place/nomenclature search (#191) may later reference these features by ID,
without creating another nomenclature schema. These layers do not introduce
mission observations (#28), raster imagery (#123), or surface picks (#127).

The representative Jezero and lunar seam datasets under core's test fixtures
are synthetic test data, not a bundled science product or an authoritative map.
Run `node scripts/test-geographic-import.mjs` against a running viewer dev server
for the real browser worker/local-file/scene-replacement smoke check.
