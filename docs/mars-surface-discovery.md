# Mars source discovery (issue #249)

This is an **offline-first, bounded source metadata planner**. It supplements
[#248](surface-data-plans.md); it does not download rasters, generate terrain,
reproject datums or certify an archive product as build-ready. The discovery
report is deterministic given a desired plan and an evidence-linked inventory.

## Run with checked-in evidence

```bash
npm run --silent discover:surface -- \
  docs/examples/surface-plans/jezero.plan.json \
  --inventory docs/examples/surface-plans/mars-jezero.inventory.json \
  --policy consistent \
  --out /tmp/jezero-discovery.json \
  --sources-out /tmp/jezero-source-descriptors.json

npm run --silent plan:surface -- \
  docs/examples/surface-plans/jezero.plan.json \
  --sources /tmp/jezero-source-descriptors.json
```

Use `--policy finest-imagery` or `--policy physical-accuracy` for alternate,
stable ranking biases. Default output lists no more than three candidate
**single source products per region/channel**. The returned JSON has product
IDs, evidence URLs, independent imagery/physical elevation sampling,
requested resolution and accuracy, overlap fraction when a footprint exists,
unknown coverage and reasons. It does **not** fuse/choose a build lock. The
`--sources-out` file uses the existing `SurfaceSourceDescriptor[]` validator
contract from #248. The estimator will keep unresolved coverage and absent
accuracy explicit.

The example plans are **synthetic regions**, not Mars mission landing
geometry. These four-entry Mars inventory files are deliberately small
research fixtures. They list MOLA gridded elevation, Viking MDIM2.1 imagery
and a published HiRISE stereo DTM with a corresponding separate orthoimage
for Jezero or Gale. MOLA's entry is a **collection-level lead**, not an
individual, buildable raster; consult the collection to resolve the actual
regional tiles. Viking's native acquisition quality varies; its nominal
published mosaic pixel size is not evidence of uniform native 232 m quality.
For HiRISE Jezero, the `ESP_023524_1985_RED_C_01_ORTHO` envelope comes
directly from the PDS label (`MINIMUM_LATITUDE`, `MAXIMUM_LATITUDE`,
`WESTERNMOST_LONGITUDE`, `EASTERNMOST_LONGITUDE`). Its `CORE_NULL`
means untested pixel validity, *not* a proof of full useful coverage.
The corresponding `DTEEC_023524_1985_023379_1985_U01` DTM is a separate
source with an independently unresolved footprint/datum/accuracy.

Evidence and labels:
- [Jezero DTM and matching orthoimages](https://hirise.lpl.arizona.edu/dtm/ESP_023524_1985)
- [Jezero orthoimage PDS label](https://hirise.lpl.arizona.edu/PDS/DTM/ESP/ORB_023500_023599/ESP_023524_1985_ESP_023379_1985/ESP_023524_1985_RED_C_01_ORTHO.LBL)
- [Gale DTM and associated images](https://hirise.lpl.arizona.edu/dtm/ESP_016520_1750)
- [Viking MDIM2.1 global mosaic](https://astrogeology.usgs.gov/search/map/mars_viking_colorized_global_mosaic_232m)
- [MOLA MEGDR documentation and tile/product naming](https://pds-geosciences.wustl.edu/missions/mgs/megdr.html)

## Source-evidence semantics

The `SurfaceDiscoveryRecord` references a validated #248
`SurfaceSourceDescriptor` and separate evidence about source type, footprint
status, timing, illumination and registration. Each candidate reports:
- `footprintFraction: null` for unknown extent; a numeric overlap ratio when
  an evidenced footprint is present. An envelope is **not** a valid mask.
- `verifiedValidFraction: null` unless the input explicitly represents a
  validated *valid-data* mask with `nodata: "none"`. Zero is not silently
  substituted for missing evidence.
- `meetsTarget: null` for unknown physical sampling or accuracy. A 1 m
  DEM tile interval does not assert 0.5 m elevation accuracy.
- Archive-relative absences mean **unknown products/coverage**, not proof the
  planet has no finer observation.

Source descriptors with mismatched frames or coordinates are not silently
transformed. The #248 v1 lock permits identity-only transformations and
requires complete verified coverage. Do not convert this exploratory report
to a build lock without inspecting labels, datums and masks.

## Optional PDS ODE REST metadata scouting

PDS Orbital Data Explorer has [documented REST metadata search endpoints](https://pilot.rsl.wustl.edu/Help/Api/GET-api-v1-search-products-metadata-target-mission-instrument-prodType-productIdentifier-minLat-maxLat-westernLon-easternLon-wkt-featureType-feature-sortKey-offset-pageSize-pageNum-outputFormat).
It catalogs PDS3 and PDS4, including [planetary spatial searches](https://ode.rsl.wustl.edu/mars/pagehelp/Content/Frequently_Asked_Questions/Differences_Between_ODEandPDS_api.htm).
Route/version assumptions differ between ODE deployments: verify an actual
endpoint URL in the official documentation before passing it to this CLI.
There is **no background polling** and no archive traffic in the normal viewer.

An explicit `--ode-template 'https://pilot.rsl.wustl.edu/.../mars/.../{pageSize}/.../{page}/json'`
makes up to **two sequential GET requests of 25 records each**.
Only ODE Mars HTTPS hosts are allowed; redirects are not followed.
The optional output lists ODE-observed product IDs/version/mission/instrument
and metadata errors, with *null* footprint, datum, GSD, mask and accuracy.
It does not automatically promote unknown search results to verified
source descriptors. Unsupported JSON envelopes, page repeats, HTTP errors
or service outages produce diagnostic partial results; no fabricated coverage.

The adapter also supports test fixtures through a supplied `fetchImpl` and
bounded page controls. For real work, cache reviewed metadata into an
evidence-linked inventory and rerun offline. Only known verified assets and
footprints should be pinned to a locked plan.

## Deliberate boundaries / follow-up for closing #249

This first pass is **not** the full source catalog or automatic best-coverage
mosaic selector. Follow-up work should:
1. Enrich CTX and HRSC/MOLA regional sources with verified **product** IDs,
   true projected footprints, nodata masks, photometry and native resolution.
2. Parse downloadable PDS labels or trusted ODE footprints for documented
   products, with coordinate/datum translation **explicit**, not inferred.
3. Union known valid-data masks for achieved/gap area and recommend compatible
   pairs/sets with actual download/work costs and clear registration limitations.
4. Promote curated records only through the #248 source validation and
   reproducible lockfile/build process. #250 consumes these same JSON reports.

No live ODE endpoint has been certified in this first pass; the opt-in path
is deliberately kept separate from default operations and returns diagnostics
when unavailable.
