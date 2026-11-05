# Public experiences and developer fixtures

[index.json](index.json) is the public lineup: two Explore entries, nine
Missions and one dedicated scripted tour. [dev-index.json](dev-index.json)
provides opt-in local technical discovery using the same source/index format.
Configure it as described in [catalog sources](../../../docs/catalog-sources.md#public-curation-and-developer-discovery).
It does not change the public Pages list or mission/embed sources.

## Retained capabilities

| Family | Purpose / prerequisites |
| --- | --- |
| `earth-moon`, `inner-planets-keplerian`, `solar-system` | Lightweight analytical propagation, distinct from the composed SPICE Solar System. Legacy sample geometry and Explorer arcs retained. |
| `base/` | Reusable composition library; SPICE kernels and analytical satellite models as authored. Includes bulk asteroid SPK ingestion. |
| `sensor-demo`, `oem-ingest`, `arrokoth-dsk` | Sensor geometry, Cassini text ephemeris (no spacecraft SPK) and DSK plate rendering. Keep their models, ephemerides and kernels. |
| `planetary-places`, `places/` | Complete named-place dataset and standalone technical scene, preserved without requiring new mission integration. |
| `mars-imagery-jezero`, `moon-imagery-apollo15` | Independent imagery over ellipsoids, **without terrain**. Mission terrain is not a replacement for these fallback tests. |
| Eight `atmosphere-*` scenes | Per-scenario visual regression, including eclipse, dusk, twilight, textures and Saturn shadows. Used by `scripts/visual-regression.mjs`. |
| Eight `geographic-vectors*` scenes | Vector rendering, geographic registration, terrain overlay and GPU workload regressions. |
| Seven `experiments/moon-*` scenes | Lunar cube, quantized/polar, imagery grid/NAC/registration and geographic comparisons; generated products may be needed. |
| Two `experiments/mars-*`, `mars-cube-imagery-experiment` | Surface-build and cube imagery experiments. The Jezero cube pair is explicitly local-only and excluded from production. |
| `rotation-demo`, `io-volcanos`, `fixtures/mission-activities` | Retained advanced examples / regression fixtures. No retirement is justified by this curation. |
| `ingenuity-analysis-tour` | Opt-in developer discovery: `developer/ingenuity-analysis-tour`. |

Install Git LFS before cloning. Follow [local asset setup](../../../docs/viewer-overview.md#local-setup-and-assets)
for models and mission kernels. Development asset resolution prefers complete
local managed products, then pinned hosted builds; a configured or pinned
product does not guarantee current-view coverage. Experiments with unpublished
products need their own build scripts. No new datasets are published here.

## Mission copy and viewpoint audit

- Solar System retains `base/solarsys` and adds an Earth–Moon viewpoint; the
  analytical `solar-system.json` and both inner-planet propagation variants stay
  intact. No duplicate body declarations were merged because their propagation
  and sample geometry differ.
- ISS uses its authored historical 2011 TLE, not a current station position.
- Ingenuity terrain and four imagery products have pinned published builds in
  `scripts/data-hosting/datasets.json`. Reconstruction is estimated, not full
  3D telemetry; datum, clock and frame uncertainty remain in the catalog.
- Curiosity's orbital-localized position, telemetry attitude, estimated local
  registration and unknown wheel clearance remain explicit. No viewpoint or
  geometry shift is used to imply registration.
- LRO keeps its `Track LRO` viewpoint, mission time, `MOON_ME_DE421` rotation and
  terrain frame. Its pinned surface products have bounded coverage/resolution.
- Mission viewpoints and data requirements remain authored; curation does not
  enlarge kernel coverage, terrain extent or physical accuracy.

## Serving audit and safe pruning

`BUNDLE_TEST_CATALOGS=1` copies the example tree independently of either index.
The current copy filter omits registered local-only catalogs/products; hosted
builds omit pinned dataset payloads and then rewrite references to the data
host. Public discovery lists only 12 entries even though many more files ship
for direct links and `require` composition. The developer index itself may be
served but is not configured as a public source; its local-only entries are
intentionally unavailable in production.

```sh
npm run check:catalogs > /tmp/catalog-source-inventory.json
node scripts/catalog-inventory.mjs --dist apps/viewer/dist > /tmp/catalog-bundle-inventory.json
```

The report validates both indexes, IDs, groups, targets, scripts and require
graphs, lists asset dependencies and their local presence / pinned build, and
reports bundle bytes, listed files, unlisted catalogs, omitted catalogs and
files outside the catalog references. The dependency scan covers static
resource paths; runtime tile templates, dynamic requests and external test
references are not proof of non-use. Missing local assets are reported, not
silently removed or treated as remote verification.

**No assets are deleted.** The demonstrably local-only Jezero cube catalogs
are already excluded by the dataset registry. Rotation and legacy analytical
samples remain useful examples; OEM, sensors, DSK, no-terrain imagery, places,
atmosphere and lunar comparisons have explicit retained uses. Files outside
catalog references require a separate audit of test scripts, loaders, models'
sidecar dependencies and existing URLs before pruning. There is no justified
new deletion from this curation alone.

## Validation

```sh
npm exec vitest -- run \
  scripts/catalog-inventory.test.mjs \
  apps/viewer/src/lib/__tests__/catalog-sources.test.ts \
  apps/viewer/src/lib/__tests__/catalog-nav.test.ts \
  apps/viewer/src/lib/__tests__/script-demo.test.ts \
  apps/viewer/src/lib/earth-moon-tour.integration.test.ts
```

This checks index contracts,
retained fixture families, independent imagery fallback, script parsing,
entry launch semantics and the real-kernel lunar orientation.

With the intended checkout serving a dedicated port, run
`CL_VIEWER_URL=http://127.0.0.1:5208/ node scripts/test-catalog-curation.mjs`.
Run the same harness against `vite preview` after a production-style build with
`BUNDLE_TEST_CATALOGS=1` and the public `VITE_CATALOG_SOURCES` configured. It
checks the six featured rows, 12 grouped choices, ISS selection and the full
unmodified public tour through completion, observing camera movement, lunar
tracking, body-fixed mode, and accelerated time. Screenshots go to `/tmp` by
default. This is a manual browser check; CI runs the inventory and regression
tests, and Pages retains a serving inventory artifact.

Local bundle review also found ignored checkout scratch products
`data/moon-terrain-cube-prev-g3-m12`, `data/moon-terrain-cube-simplified` and
`data/moon-terrain-cube-simplified-003`. They are outside the indexed catalog
reference graph and are copied by the broad existing bundle rule. These are
candidates for a separate packaging audit, not deletions in this change:
ignored local scene URLs and comparison tools may still use them. The inventory
also identifies unindexed shipped scene JSONs, so a checkout's ignored scenes
cannot be mistaken for the tracked public lineup.

Acceptance on 2026-11-05: 62 tests across the five focused files passed, as did
test typechecking, lint, source inventory and the production viewer build.
The loaded browser harness passed discovery, ISS selection and full tour
completion on both development and hosted-rewritten production preview.
Production rendering used `ANGLE Metal Renderer: Apple M4 Max`.
The local production-style inventory found 12 listed and 68 unlisted graph
catalogs, with only the two registered local-only catalogs omitted. Five
ignored MoonFall scenes also shipped. Its 1,241,246 files / 14.11 GiB reflect
this checkout's scratch data, not a measurement of the public deployment.
Individual mission asset readiness, every experimental scene's rendering and
the full atmosphere visual suite were not rerun; their fixtures and resource
paths remain intact. Hosted rewriting retained the existing unpublished
Mars fused-terrain / Rosetta-kernel allowances and did not verify new datasets.
