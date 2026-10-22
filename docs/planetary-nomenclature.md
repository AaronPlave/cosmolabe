# Planetary named places (#191)

Open **Catalog → Mars and Moon places**, then use the command palette (Ctrl/Command K) to search **Jezero**, **Shackleton**, or **Alpha**. Select a result to open **Navigate → Places**, inspect its provenance, **Fly to**, **Jump to**, or **Copy coordinates**. Body/type filters, word prefixes, accent folding and catalog-provided aliases work in the existing palette. The tracked body sorts first. Names are indexed even when their drawings are hidden.

The shipped scene loads ordinary, preconverted static GeoJSON through the existing `geographicLayers` loader. There is no account, GIS backend, Gazetteer API dependency, runtime KML parser, Python dependency, or required build/conversion step for viewers. Its body positions are illustrative; its example mission/user site is explicitly synthetic, not a claim about a real mission observation.

## Named targets and release

Navigating to a place keeps its stable reference and name with the shared surface target; the HUD shows the name, with resolved coordinates, convention and height source in its tooltip. The name survives landing and terrain refinement. Generic coordinate and picked-surface targets continue to show coordinates. “Surface orbit” describes the existing surface pivot in the HUD; it does not introduce another camera mode.

The HUD target × and the geographic Escape layer share `releaseSurfaceTarget()`: release the pivot to the tracked body center, clear the active named-target highlight, and preserve camera position, time, tracking and independent place inspection. Escape first blurs focused text entry (without clearing it), respects existing tools/popovers, then stops an active flight, dismisses visible inspectors, then releases the target; a selected-only place can be dismissed without creating or releasing a camera target. Replacing a target, navigating to another body, or reloading the scene drops the old target association.

## Geographic names and source semantics

Open **Display → Labels → Geographic names** to enable geographic names separately for Mars and Moon. These toggles are independent of body labels and graticules, and are enabled initially in the Places demo. Other catalogs remain opt-in unless they declare `defaultGeographicNames`, an array of body names. By body controls visibility per body. Advanced / data sources groups Gazetteer storage chunks into one logical source toggle with attribution and count; mission/user sources stay distinct. Hidden sources remain searchable. A selected place retains a highlighted name independently of those toggles. Navigate has a single rail entry with **Places** (in-panel name search and body filter) and **Coordinates** (the shared coordinate form). The selected-place summary displays and copies hemisphere-marked planetocentric coordinates for Navigate’s default input. One Place details disclosure holds provenance, original conventions, normalized planetographic coordinates and indicative extent. The body filter follows tracking until explicitly changed. The results list also filters by feature type and, in mixed catalogs, official versus mission/user origin. Type choices follow the current body/origin; unavailable types reset. Sort makes the default relevance ranking explicit and also offers name A–Z/Z–A or indicative diameter largest/smallest. Source diameters appear on result rows; unknown diameters sort last in either size order. Explicit sorting applies before the result cap. Clearing place information leaves an active camera target intact. Clicking a geographic name selects the same imported feature through the shared scene-picking channel; double-clicking uses the same channel to Fly to that place. Probe and measurement gestures retain their existing precedence.

Names use a visualization priority independent of scientific diameter. All relevant spatial cells are projected and ranked before admitting at most **512 candidates total** and **32 placements**. Whole-globe layout uses generous spacing, yielding a handful of major names; regional/local tiers enter as their projected extent grows. The selected place wins ordinary-name collisions. Body labels, measurement/probe/event callouts and shell panels reserve space first; contours avoid place labels. Names are centered text with a dark halo, no filled cards.

Stable place references own DOM nodes, placement eligibility and opacity. Apparent size enters at 100% and exits below 75% of the threshold; accepted names retain contested placement with a 20-point takeover margin. Entering names need at least 12 px extra collision clearance. A replacement reserves its slot while the predecessor fades, then enters, without overlapping text. Ordinary omissions fade and retained IDs reserve candidate admission. Only accepted, at least half-opaque names are pickable. Each fade lasts 250 ms; proven backside/LOS occlusion and external annotation collisions evict immediately. Cheap projection follows camera motion every frame. Physical sampling/LOS uses a **2 ms work scheduler** with at least one query making progress, prioritizing selected and retained names then oldest checks. Under budget pressure an accepted name retains its last completed visibility, never a fabricated occlusion. Unchecked new names remain hidden. Results refresh after 200 ms or a 0.2% camera-distance tolerance; a deferred query can extend that age until scheduled. Metrics include cumulative enters/exits and collision handoffs, LOS checks/deferred checks and projection candidates.

| Default feature type/extent | Class | Importance | Enter threshold (projected pixels) |
| --- | --- | --- | --- |
| Mountains/valleys/chasmata ≥100 km | major | 90 | 24 |
| Smaller mountains/valleys/chasmata | regional | 65 | 70 |
| Mare/terra/regio/planum/planitia ≥1000 km | major | 80 | 45 |
| Smaller terrain regions | regional | 60 | 100 |
| Craters ≥150 km | regional | 45 | 120 |
| Other nomenclature / small craters | local | 25 | 70 |
| Mission/user sites | site | 55 | 100 |

These are cartographic defaults authored by this viewer, **not Gazetteer importance claims**. Optional GeoJSON properties `labelImportance` (0–100), `labelClass` (`major|regional|local|site`) and `labelMinPixels` (4–2000) override visualization only. A point without diameter uses 0.5% of body radius solely for apparent-size eligibility, never as geometry. Olympus Mons and Valles Marineris are major features eligible globally when front-facing; Jezero and Shackleton are small craters and enter regionally/locally when large enough on screen. The synthetic Alpha user site enters locally; any selected place bypasses LOD but still obeys physical occlusion and higher-priority annotations.

Anchors use the same normalized geographic coordinates and physical terrain sampling as other surface consumers. A resident terrain sample with a supported vertical datum provides the anchor. Otherwise the declared reference shape is an explicit fallback. Source heights, when supplied with the required datum, remain source heights. Unsupported areoid heights are not silently reinterpreted as ellipsoid elevations. Labels do not inherit visual terrain exaggeration. The selected-place details describe this fallback; the source point is never presented as a surveyed landing location, measured terrain elevation or authoritative feature boundary.

Fly and Jump consume #270’s shared `goToCoordinates` → `navigateToSurfaceTarget` path, including its surface pivot, terrain refinement and clearance-aware arc. Copy coordinates returns a hemisphere-marked planetocentric latitude/longitude pair pasteable into Navigate’s defaults (choose the indicated body). Same-body navigation retains selection; navigation to another body clears details and highlight together. Flight endpoints follow body motion/rotation, the normal origin switch applies on arrival, manual input interrupts a flight, and subsequent body navigation clears the place target. Both tabs share the session’s view preset and range, including the body-scale automatic range and normal flight duration. A positive source diameter offers explicit suggested feature framing in Place details; it never silently changes the default view or defines geometry.

## Static catalog workflows

The example is [`apps/viewer/test-catalogs/planetary-places.json`](../apps/viewer/test-catalogs/planetary-places.json). It requires `places/mars.json` and `places/moon.json`, each of which references adjacent GeoJSON chunks. Any scene with matching body names can require either companion catalog. See [geographic-layers.md](geographic-layers.md) for the shared coordinate and provenance contract.

- **Catalog-relative files:** retain the declaring catalog's relative paths and load the scene normally.
- **Hosted HTTPS:** host the JSON/GeoJSON as static files. Cross-origin hosts must permit the viewer origin through CORS. `require` and layer sources resolve relative to their declaring catalog, not the viewer page.
- **Local multiple files:** open the scene, required catalog JSONs and all referenced GeoJSON files together. Include referenced textures/models if the scene uses them. The supported flat-file workflow requires unambiguous basenames.
- **Local directory:** open/drop the containing directory to retain relative paths. Missing exact directory paths do not fall through to another same-named file or a network fallback.

Missing, malformed, CORS-blocked, timed-out and oversized geographic files are optional-source failures. They retain diagnostics in Places and the geographic layer store; other valid sources and the body scene still load. The entire geographic `require` graph shares a **15-second deadline**, 64 source attempts and a 16 MiB scene byte budget. Per-catalog limits remain 16 layers/8 MiB; each source remains below 2 MiB/5,000 features. Sources are parsed sequentially in disposable workers. The place index keeps at most 20,000 named points and reports overflow instead of silently claiming full search coverage.

## Verified USGS snapshots

Source: [USGS/IAU Gazetteer GIS Downloads](https://planetarynames.wr.usgs.gov/GIS_Downloads), retrieved **2026-10-21**. These are rolling downloads; the webpage says nightly generation, while the packaged metadata contains older publication/maintenance dates. The archive SHA-256 identifies the tested snapshot; an old metadata publication date is not treated as a current release version. Attribution: **USGS/IAU Gazetteer of Planetary Nomenclature** (USGS Astrogeology, on behalf of the IAU WGPSN, supported by NASA).

The [USGS KML guidance](https://planetarynames.wr.usgs.gov/Page/Website#CoordinateSystems) declares **east-positive, planetocentric, −180..180 coordinates**. The actual KML `<Point><coordinates>` values conform. Its `center_lon` metadata field can instead contain 0..360 values: it must not replace the point geometry. The packaged `.prj` declares Mars 2000 equatorial radius 3396.19 km/inverse flattening 169.8944472236118 (polar radius 3376.2 km), and a Moon 2000 sphere of 1737.4 km.

| Snapshot | Archive bytes | KML bytes | Placemark records | Converted points | Skips | GeoJSON bytes / chunks |
|---|---:|---:|---:|---:|---|---:|
| `MARS_nomenclature_center_pts.kmz` | 2,613,250 | 2,577,370 | 2,052 | 2,051 | 1 exact duplicate Bohar, feature 16054 | 1,558,267 / 1 |
| `MOON_nomenclature_center_pts.kmz` | 11,718,225 | 11,682,362 | 9,087 | 9,087 | 0 | 7,196,489 / 4 |

Archive SHA-256:

```text
Mars 3175bcd14991fe875ab0ca2d04db2e5cb1fc2f15b10271fca91ccc92cf6091b7
Moon 03f6c18254f35e1a83421825341d522b0cca73e90da000bf68c6fff4284ce40e
```

Each archive contains one KML, one `.prj` and one metadata XML, stored without ZIP compression. Field layout is `<ExtendedData><SchemaData><SimpleData name="…">`; real fields include `clean_name`, `type`, `diameter`, `link`, approval, origin, bounds and quadrangle metadata. Names come from `<name>`. Gazetteer `link` URLs provide durable feature IDs; the KML Placemark IDs are generated row numbers.

Concrete anchors from these snapshots:

| Place | Gazetteer ID | Source east longitude | Source planetocentric latitude | Indicative diameter, km |
|---|---:|---:|---:|---:|
| Jezero | 14300 | 77.6873 | 18.4082 | 47.521198 |
| Shackleton | 5450 | 129.78 | −89.67 | 20.924982 |

The normalized Jezero latitude shown in the viewer is **geodetic**, approximately 18.61185°, on the declared Mars ellipsoid. That difference from source planetocentric latitude is intentional. Original coordinates and metadata remain in the imported feature. Small real-source KML excerpts exercise these records and negative longitudes in offline CI. Full static snapshots, sizes, per-chunk hashes and provenance are recorded in [`places/sources.json`](../apps/viewer/test-catalogs/places/sources.json).

Moon currently fits just below the converter's conservative 7.5 MB budget. Future full-body snapshots may grow beyond it: conversion must fail explicitly instead of dropping records or relaxing renderer budgets. Split larger datasets into independently loaded regional catalogs after profiling.

## Optional offline converter

Authors refreshing static data can download the exact per-body **center point** archive and run the standard-library converter. Direct runtime KMZ ingestion is deliberately omitted: static GeoJSON reuses existing load guards/workers and avoids shipping another archive/XML parser in the viewer. Broader interchange belongs to #201.

```bash
python3 scripts/convert-planetary-nomenclature.py \
  /path/to/MARS_nomenclature_center_pts.kmz \
  --output-catalog /path/to/places/mars.json \
  --body Mars --latitude planetocentric --longitude-direction east \
  --longitude-domain=-180..180 \
  --ellipsoid-radii-km 3396.19 3396.19 3376.2 \
  --layer-id mars:usgs:places \
  --attribution 'USGS/IAU Gazetteer of Planetary Nomenclature' \
  --source-url 'https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MARS_nomenclature_center_pts.kmz'
```

For Moon, use its actual archive URL, `--body Moon --sphere-radius-km 1737.4 --layer-id moon:usgs:places` with the same latitude/longitude options. Other sources require independently verified conventions. `--longitude-domain=-180..180` needs the equals sign because its value begins with a minus sign.

Conversion fails conspicuously if valid points fall into the other longitude domain. Review every skip count. Z is omitted because arbitrary KML altitude lacks a planetary vertical datum. Unsupported/malformed/non-point placemarks are counted, not reduced to invented centroids. DTD/entity declarations are rejected at the decoded XML parser boundary, including UTF-16; archive traversal, symlinks, excessive size/ratio/entries, XML depth/elements, field lengths and record counts are bounded. Input/output path collisions are rejected before writing.

`properties.placeRef` combines dataset identity (`--layer-id`) and durable feature identity, independent of numbered transport chunks. Source reordering or insertion can change a feature's chunk without changing its logical place reference. Generic source IDs are retained when supplied; otherwise the deterministic name/type/coordinate hash changes if the record is renamed or moved. Duplicate IDs are skipped and counted. Keep `--layer-id` stable when refreshing the same dataset.

## Validation

```bash
python3 -m unittest discover -s scripts/__tests__ -p test_convert_planetary_nomenclature.py -v
npx vitest run packages/core/src/__tests__/places.test.ts \
  packages/three/src/controls/__tests__/camera-navigation.test.ts \
  packages/three/src/__tests__/geographic-interaction.test.ts
CL_VIEWER_URL=http://127.0.0.1:5189/ node scripts/test-planetary-places.mjs
```

Python, TypeScript regressions and the normal-viewer browser smoke run in CI. The browser test loads the actual full snapshots through workers; tests search/selection, Fly/Jump equivalence, clipboard, body/type filtering, geographic label picking and compact presentation; then exercises a real temporary cross-origin HTTPS server with CORS, flat-file/directory opening, and isolated optional-source failures. It writes screenshots and `metrics.json` with source counts/skips, import/worker round trips, index construction time, heap usage, main-thread long tasks, label candidates/CPU, renderer CPU and frame intervals. `CL_GPU=hardware` uses Chrome/Metal at a 3840×2160 drawing buffer for physical-GPU evidence; SwiftShader smoke timings are not hardware performance claims.
