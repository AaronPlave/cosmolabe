# Issue #251 acceptance matrix

PR #287 implements the finite executor contract. The graphical planner (#250),
arbitrary-location runtime delivery (#136), mission catalog migration (#246/247),
and general renderer/navigation work remain separate issues. None is substituted
for a missing executor requirement below.

| Original requirement | Status and implementation | Evidence / remaining action |
| --- | --- | --- |
| Validate locked source identities, rights, transforms and finite DAG before work | Implemented: `plan.mjs`, shared #248 schemas, full SHA-256 bindings including detached datum, overviews and XYZ/fusion dependencies | `surface-build.test.mjs`: tampering, missing/changed files, unsupported transforms, rights and finite tiling checks; dry run performs no fetch/write |
| Preserve #50 fusion and scientific height semantics | Implemented: unchanged pinned fusion; explicit areoid radius plus radial height to ellipsoidal geometry/CPU data | Real pilot source validation: 390 conversion probes, 73 shared-provenance controls; masks/kernel and datum tests |
| Independent physical terrain, context and native imagery | Implemented with #272 cube registration, pixel gutters and independent source controls | Real Jezero and synthetic Skyfall fixture; imagery refines beyond geometry without changing terrain IDs or CPU picks |
| Native masks, checksums and image registration | Implemented: native subset + interpolation halo audit, mask-aware premultiplied filtering, independent source/output registration reference | `test_raster_imagery.py`, projected/masked rebuild and missing finest-coverage regressions; invalid external masks rejected |
| Geometry seams, faces/poles/antimeridian, CPU/rendered comparison | Implemented numerical gates and measured diagnostics; measured CPU/rendered differences are retained in planner report | Every build runs `validate-cube-terrain.mjs`; real foundation includes 96 boundary rays. Up to 291 m mixed-LOD separation remains disclosed, not relabeled as an executor failure or silently repaired |
| Immutable publisher and exact inventory verification | Implemented over #137 storage/uploader/verifier, preflight all products, explicit R2 confirmation, hash-check partial objects, verify every emitted object over HTTP | Local hosted-style full publication, re-publication, corrupt/missing-object rejection. Real R2 upload is **externally gated by owner authorization**, exact commands below; no credentials used by build/dry-run/preflight |
| Safe catalog rewrite, pin and rollback | Implemented with #137 `rewriteCatalog`; receipt must match build and pass fresh HTTP verification before candidate preparation | Tests apply/rollback an offline catalog copy and reject concurrent edits, changed receipts, bad/partial hosted products; candidate never deploys |
| Actual-versus-planned machine-readable planner feedback | Implemented: report v2 plus standalone `planner-feedback.json` (contract v1) | Requested geometries, native GSD/accuracy, confirmed valid masks, continuous ROI proofs where available, emitted levels/availability, bytes/objects, sources/transfers, time and sampled resources; publication is separately receipt-bound |
| Changed source/transform/region creates new identity | Implemented: whole-build lock identity and per-product transitive input identity | Source, transform/taper and region identity regressions; region-only execution reuses matching terrain and global context, stable publication prefixes prevent duplicate upload |
| Interrupted/incomplete work and immutable resume | Implemented: exclusive `.building` reservation, completion only after gates, complete inventory verification | Interrupted build cannot publish; explicit clean restart succeeds and reuses verified matching products; repeated publication is immutable |
| Shared global context without unrelated rebuilds | Implemented for independent imagery products. One authoritative terrain/CPU product per plan | Regional rebuild regression verifies context and terrain reuse; shared product prefixes are identical across builds |
| Composable regional terrain geometry/CPU patches | **Unsupported, explicit failure:** unknown `terrain.patches` rejected. Geometry ownership and transitions are not assumed | `surface-build.test.mjs` capability regression; no claim of reusable geometry patches layered over a global terrain product |
| Representative Skyfall/Mars end-to-end fixture including unavailable high-resolution DTM | Implemented synthetic fixture (allowed by original issue), global XYZ context + bounded regional image, independent terrain density, no-DTM region at 40–42E | Source-native image density and visibility/fallback, physical picks, hosted URLs and explicit `native-target-unavailable` planner diagnostic. Synthetic colors/heights are identified as diagnostic data, never observations |
| Illumination/absolute accuracy/source uncertainty | Explicitly unknown where upstream evidence is absent | Standalone source provenance and report retain unknown accuracy/illumination; source-grid preservation and shared-provenance checks are not absolute geolocation certification |

## Explicit publication procedure

Building, preflight and local tests require no production credentials. Inspect the
locked build and **review** the exact source/output inventories first:

```sh
node scripts/build-surface.mjs LOCK.json --cache CACHE --publication-plan > publication-plan.json
```

A production publication is an owner-initiated manual step. Only after authorizing
that step, configure the existing #137 `R2_ACCOUNT_ID` (or `R2_ENDPOINT`),
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` outside command history.
Use the exact `identity` in the preflight artifact as `REVIEWED_IDENTITY`:

```sh
node scripts/build-surface.mjs LOCK.json --cache CACHE --publish-r2 \
  --verify-url https://data.aaronplave.com \
  --confirm-publication REVIEWED_IDENTITY > publication-receipt.json
```

The command refuses a missing/mismatched confirmation **before reading
credentials**. It rechecks completion and all local bytes, uses immutable product
prefixes, verifies existing partial objects by hash, runs #137's HTTP/header/revision
checks and then checks the entire published inventory/each object's SHA-256,
CORS, content type and immutable cache policy. A failed upload or verification
produces no usable receipt and cannot prepare a catalog candidate. The receipt
records the build/lock/publication identities, host, prefixes and verified counts.
An upload failure can leave an unreferenced immutable prefix; retry only when its
existing objects match. Never overwrite corrupt content under an existing ID.

For local reproduction replace `--publish-r2 --confirm-publication …` with
`--publish-local --local-dir STORE` and use the local storage HTTP endpoint:

```sh
node scripts/surface-build/serve-publication.mjs STORE 5188
# In another terminal:
node scripts/build-surface.mjs LOCK.json --cache CACHE --publish-local \
  --local-dir STORE --verify-url http://127.0.0.1:5188 > local-receipt.json
```

## Offline catalog pin and rollback

Prepare a local catalog copy with paths under `/test-catalogs/data/<product-id>/`.
`prefixes.json` maps each verified product ID to `data/<product-id>/`. These are
explicit source prefixes for the existing #137 deployment rewrite; unrelated
URLs, trajectories, fidelity and layer controls are preserved.

```sh
node scripts/surface-build/catalog.mjs prepare --lock LOCK.json --cache CACHE \
  --receipt publication-receipt.json --catalog catalog-copy.json \
  --catalog-rel test-catalogs/fixture.json --prefixes prefixes.json \
  --candidate NEW-catalog-candidate.json
node scripts/surface-build/catalog.mjs apply \
  --candidate NEW-catalog-candidate.json --catalog catalog-copy.json
# Exact rollback, refusing intervening catalog edits:
node scripts/surface-build/catalog.mjs rollback \
  --candidate NEW-catalog-candidate.json --catalog catalog-copy.json
```

`prepare` freshly verifies the exact HTTP inventory; it refuses an incomplete,
changed or mismatched receipt. `apply`/`rollback` check optimistic content
identities and only change the explicitly named local file. No command above
changes deployed catalogs. Deployment and a production-host browser check require
separate explicit authorization after reviewing the candidate and rollback file.
The prior products are retained.

## Planner report and coverage semantics

`report.json` v2 contains `plannerFeedback`; the same object is written as
`planner-feedback.json`, [contract v1 JSON Schema](../scripts/surface-build/planner-feedback.schema.json). `publishedFeedback(report, receipt)` produces
the receipt-bound published view without mutating the completed build. The CLI equivalent is `node scripts/surface-build/feedback.mjs REPORT.json PUBLICATION-RECEIPT.json NEW-FEEDBACK.json`. Generated
bytes are `resources.actual.outputBytes`; `publishedBytes` is null until a verified
publication receipt exists. Receipt `objects`/`bytes` count emitted product data; `storageObjects`/`storageBytes` include the uploader's inventory and completion manifest as well. The full stored object set must match exactly.

Source footprints are declarations; verified native masks are separate evidence.
Only the raster adapter currently proves continuous finest-image coverage for
its bounded, single-face requested ROI. XYZ output addresses and global root
availability are **not** proofs of continuous source-native coverage. Regions
with insufficient native fidelity retain coarser data only under the locked
fallback policy and receive a machine-readable diagnostic. Physical accuracy
can remain null even when native pixel spacing is known.

Source bindings and pinned response files are reused without network downloads;
original asset bytes and bundled response bytes are reported separately. Elapsed
execution time and sampled scratch/RSS are measured. Exact physical peak RAM and
disk are unknown; summed process RSS can double-count shared pages. Runtime
texture/geometry implications remain in the planned browser estimate and browser
capture receipts, not invented from published byte counts.

## End-to-end fixture reproduction

```sh
node scripts/surface-build/acceptance.mjs work/surface-build/skyfall-acceptance /usr/bin/python3
```

Use `/opt/homebrew/bin/python3` on this macOS workspace. The command creates
synthetic assets with content pins, builds all three products, starts a local
static object-store endpoint, publishes and verifies all bytes, prepares/applies
a catalog candidate, loads that catalog over HTTP without Playwright route
interception, exercises source controls and the unavailable-DTM site, and rolls
the offline catalog back. Child servers terminate when the run finishes. Outputs
include `acceptance.json`, `report.json`, `published-planner-feedback.json`,
`publication.json`, the catalog candidate and physical/software GPU browser
metadata/screenshots. CI runs the same procedure with Chromium/SwiftShader and
uploads the report/candidate/browser artifacts; macOS local evidence uses Metal.

The representative fixture uses diagnostic synthetic rasters, including an
explicit bounded source and higher-frequency color pattern, rather than claiming
new Mars observations or a mission trajectory. Its native image interval is
20.85 km, geometry output interval ~26.53 km, physical regional DEM native
interval 74 km, and image output interval ~13.27 km. The separate pinned Jezero
run proves actual 25 cm observed-source preservation and explicit datum conversion.

## Exact remaining owner action for the reviewed real build

No production credentials were read and no production upload occurred. After explicitly authorizing publication and configuring the #137 R2 environment, run from this checkout:

```sh
node scripts/build-surface.mjs work/surface-build/real-pilot-inputs/lock.json \
  --cache work/surface-build/real-executor-cache --publish-r2 \
  --verify-url https://data.aaronplave.com \
  --confirm-publication 7e2ae1325fc1e063632ff73a23c432ab670c8f5149244872185c7171eb074e1e \
  > work/surface-build/production-publication-receipt.json
```

This confirmation applies to build `e9dd1d51ec2db28daa709b3a4871ad7a9781ca6b1274e5a2f88dba2c6ba29e04`. Implementation or input changes require a fresh preflight and reviewed identity. The resulting receipt must pass fresh hosted HTTP verification before preparing the offline catalog candidate. The local test receipt is explicitly `localOnly: true` and is not evidence of R2 publication. Review the candidate and rollback, then explicitly authorize any deployment and verify the production-origin browser load. These external steps remain open; no separate implementation PR is proposed.
