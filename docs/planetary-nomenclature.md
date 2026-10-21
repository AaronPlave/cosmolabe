# Planetary named-place source proof (#191)

The initial nomenclature ingest path is deliberately **static and offline**. A catalog author downloads per-body placemark KML/KMZ, runs the optional standard-library converter, and references its **ordinary GeoJSON** outputs through the existing `geographicLayers` contract. The deployed viewer needs no GIS service, dynamic USGS calls, special nomenclature schema, or Python runtime. This is a **data/format proof**, not yet named-place search or the 3D geographic-name layer.

## Download and convert

1. Download **point/center nomenclature** for a single body from the [USGS/IAU planetary nomenclature downloads](https://planetarynames.wr.usgs.gov/GIS_Downloads). Do **not** choose extent/boundary files and then interpret those polygons as authoritative feature rims.
2. Verify the selected file's published **latitude kind, longitude sign/domain, reference shape**, version and attribution from its source documentation. KML by itself does not establish correct planetary coordinate conventions. The converter **preserves** longitude/latitude values as source coordinates; it does not infer or silently flip them.
3. Run the converter with explicit conventions. For an east-positive planetocentric Mars point file using `0..360` longitudes, for example:

```bash
python3 scripts/convert-planetary-nomenclature.py \
  /path/to/MARS_nomenclature_center_pts.kmz \
  --output-catalog /path/to/mars-names/mars-places.json \
  --body Mars \
  --latitude planetocentric \
  --longitude-direction east \
  --longitude-domain 0..360 \
  --ellipsoid-radii-km 3396.19 3396.19 3376.2 \
  --layer-id mars:usgs:places \
  --attribution 'USGS/IAU Gazetteer of Planetary Nomenclature' \
  --source-url 'https://planetarynames.wr.usgs.gov/GIS_Downloads'
```

For a **Moon** source using an explicitly verified spherical reference convention, use `--body Moon --sphere-radius-km 1737.4` instead of the ellipsoid argument, and set its actual latitude/longitude options. The radius is a declared **reference sphere**, not a terrain height. These numeric examples are not evidence that a particular archive uses these conventions: verify before importing.

4. The command writes a `mars-places.json` catalog and numbered `mars-places-001.geojson` files beside it. A catalog can `require` the generated catalog, or a scene can load it alongside its normal body catalog. Keep the GeoJSON files beside their referencing catalog. The viewer already handles catalog-relative static URLs, HTTPS/CORS and supported local multi-file/directory opening. It will not automatically discover arbitrary files on disk. You can also host the catalog and GeoJSON on an ordinary static asset server.
5. Check the converter's `features` and `skipped` summary. **Skipped non-point placemarks are intentional.** If the source has unexpectedly few entries, examine its KML structure before using the result. Conversion failing due to a size limit is not permission to silently drop records.

The companion catalog uses the same `geographicCoordinates` and `geographicLayers` definitions documented in [geographic-layers.md](geographic-layers.md). It defaults `display.visible` to `false`, because thousands of points are not an acceptable automatic global visualization. Place search and a dedicated density-controlled geographic-name toggle will be implemented in the later #191 slices; generic geographic-layer inspection is tracked by #198.

## Output semantics

- Each feature is a GeoJSON `Point` with a 2D `[source longitude, source latitude]` coordinate tuple, `properties.name`, optional `properties.featureClass`, and `properties.sourceFields` copied from KML `<ExtendedData>` simple values. Catalog provenance records the input filename/SHA-256, optional original URL, attribution and converter version.
- `properties.coordinateRole` is `source-placemark-anchor`. A point is **not** a feature's exact extent, authoritative rim, elevation, surveyed landing location or terrain sample. KML altitude is intentionally discarded because an arbitrary third coordinate lacks an unambiguous planetary vertical datum.
- IDs prefer `Feature_ID`, `Gazetteer_ID`, `ID` or KML Placemark `id`; otherwise a deterministic hash of name/type/coordinates is used. The existing geographic layer ID namespaces these feature IDs. Missing identifiers are stable against **row reordering**, but a renamed or moved feature changes its fallback ID. Duplicate IDs are **skipped and counted**, not silently renumbered.
- A user/mission site layer may use the **same** geographic model with ordinary GeoJSON points and `properties.name`; mission-specific provenance stays with its layer. The future place index will distinguish official nomenclature from mission/user sites rather than claiming that every geographic feature is an official name.

## Safety, limits, and support

Only single-KML-document `.kml` or `.kmz` point placemarks are supported. KML `MultiGeometry`, `LineString`, `Polygon`, network links, extrusions, styling and XML descriptions are not interpreted. KML archive resources are not fetched. The converter rejects DTD/entity declarations, ZIP path traversal, symlinks, oversized and extreme-ratio members; it limits input (32 MiB archive/16 MiB decoded XML), archive entries, record count, field count and field length. Malformed coordinates and unsupported geometry are counted and skipped; a wholly unusable source fails.

The converter chunks its results to stay below the geographic loader's **2 MiB and 5,000-feature per-layer ceilings**, plus the **8 MiB per-catalog limit**. If even a split body source exceeds the catalog budget, conversion fails explicitly; separate regional catalogs are a follow-up, rather than raising general-purpose renderer bounds without profiling. Existing viewer GeoJSON load guards, worker budgets and structured error reporting still apply to generated files.

## Testing and remaining verification

```bash
python3 -m unittest discover -s scripts/__tests__ -p 'test_convert_planetary_nomenclature.py' -v
```

These tests exercise namespace-bearing KML, both `<SimpleData>`/`<Data>` metadata layouts, `.kmz` archive handling, coordinate preservation, KML Z omission, stable IDs, output chunking and hostile input rejection. They use **synthetic** samples; **real full-body USGS Mars and Moon KMZ inspection and browser acceptance testing remain an explicit follow-up/gate before declaring Gazetteer support production-ready**. Record tested archive SHA-256, actual names/counts, source coordinate semantics, converted bytes/chunks, loaded/skipped features, elapsed load time and viewer memory/label performance. Ensure Jezero/Shackleton land correctly before wiring Fly/Jump from #190.

The following slices are not part of this converter: shared place index and UX (#191/#198), Fly/Jump integration (#190), in-scene name density/occlusion (#191/#56), and general-purpose runtime KML/KMZ adapters (#201). Reuse the converter's metadata, not a second independent place feature model.