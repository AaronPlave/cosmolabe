# Jezero pilot publication and catalog review

**Data publication, authorized experimental catalog deployment and deployed-origin acceptance are complete.** The user authorized data-only publication, then approved accepting genuine HTML 404 responses after confirming the loaders reject unsuccessful status before decoding. No Cloudflare error-page rewrite is needed.

Build: `67fcad0f749be705e94401070d04fc953c21a61ef83047987087ee547628c9ab`.
Lock: `sha256:5c5fbc579f3b693facfd6aefc41b9358a682378c60edb59dc048a569f250c7b9`.
Publication confirmation: `6452b87375212a652903c625ec8787d088d5b3688ee59bc974b8092ddf550a99`.
Verified receipt: `665906d2fc1b47c6e65118ee498afc3fd90c0ac106f692dbf6b1a4575d4e971e`.

The public store contains **225 objects / 14,449,636 bytes**, including 219 emitted data objects / 14,435,500 bytes. All three products are verified at their immutable prefixes under `https://data.aaronplave.com/`. Existing terrain was reused; the context and native imagery products were uploaded. No immutable product was overwritten.

## Reviewable evidence

- `publication-plan.json`: exact reviewed source/output identity and data inventory, unchanged by this publication-verifier correction.
- `production-publication-receipt.json`: actual content-pinned receipt with `localOnly:false`, exact product identities/inventories/counts/bytes and verified origins.
- `production-planner-feedback.json`: receipt-bound published planner feedback, validated against the v1 JSON Schema.
- `production-catalog-candidate.json`: actual receipt-bound candidate, prepared with fresh public HTTP verification. Its `before` equals `catalog.original.json`; its `after` equals `catalog.planned.json` exactly.
- `production-acceptance.json`: concise publication/catalog/browser validation, completed deployment authorization and preview acceptance.
- `production-browser.json`, `production-cold-warm.json`: actual ordinary-browser checks from port 5174 against public R2 products, without request interception or test mode. Physical GPU: Apple M4 Max / ANGLE Metal. Screenshots: `public-restored.png`, `public-hover-footprint.png`, `public-fly-to-layer.png`.
- `publication-attempt.json`: historical partial attempts; superseded by the successful production receipt. `preparation.json` records the earlier local-only rehearsal.

The runtime checks cover L16 imagery over L11 terrain, opacity, optional-layer hiding and L13 fallback/restoration, CPU picking, hover alignment and the actual Fly to button, with zero page/product HTTP errors and zero uncovered mandatory-base blocks. Cold and warm browser reload checks separately record cache reuse. These are **local viewer origin → public R2** checks; they do not claim acceptance from the deployed viewer origin.

All four locked sources declare USGS/NASA public-domain licensing with attribution “NASA/USGS MOLA, MEX HRSC and Mars 2020 TRN HiRISE”; the immutable imagery manifests retain source provenance. Both image layers contain the same observed 512 m, 25 cm crop, not a global native Mars basemap. Absolute registration and illumination remain unknown. The existing maximum 291.042 m mixed-LOD CPU/rendered separation and 30.24 m rendered clearance at nominal 50 m remain disclosed in the [acceptance record](../../surface-build-acceptance.md).

## Verification correction

Require a genuine HTTP 404 for missing objects. Its body can be HTML: cube imagery, manifest and grid loaders check HTTP status before decoding. A missing resource returned as `200 OK`, HTML replacing any required object, wrong hashes/types/revisions, bad CORS or missing inventory still fail. Regressions cover real HTML 404 responses without image decoding, retained mandatory-base coverage, bounded retries, successful HTML error pages and actual HTTP publication/catalog workflow.

The configured data host now allows `https://aaronplave.com`, `http://localhost:5174` and `http://127.0.0.1:5174`. Port 5187 is not required. Verification origins are recorded in the signed-by-content receipt and inherited by catalog preparation. No bucket policy, CDN routing or error-page configuration was changed by the agent.

## Reproduce publication verification

The original data-only authorization remains in effect. Regenerate and compare the preflight before any repeated publication; stop if identities or bytes differ:

```sh
node scripts/build-surface.mjs work/surface-build/real-pilot-inputs/lock.json \
  --cache work/surface-build/real-executor-cache --publication-plan \
  > work/surface-build/publication-plan.json
node scripts/build-surface.mjs work/surface-build/real-pilot-inputs/lock.json \
  --cache work/surface-build/real-executor-cache --publish-r2 \
  --verify-url https://data.aaronplave.com \
  --verify-origin https://aaronplave.com \
  --verify-origin http://localhost:5174 \
  --verify-origin http://127.0.0.1:5174 \
  --confirm-publication 6452b87375212a652903c625ec8787d088d5b3688ee59bc974b8092ddf550a99 \
  > work/surface-build/republication-receipt.json
```

Already completed products are hash-checked and reused. Public verification covers every data object's bytes, MIME and immutable caching, complete inventories/revisions, CORS and real missing-object 404s. Credentials stay in the private environment, outside artifacts/logs/history.

## Catalog candidate and exact rollback

Intended catalog location: **`test-catalogs/experiments/mars-surface-build-pilot.json`**. The exact reviewed static artifact is now committed at `apps/viewer/test-catalogs/experiments/mars-surface-build-pilot.json` and shipped in the authorized preview. `prefixes.json` maps the three product IDs to their exact catalog-root-relative local prefixes.

The candidate changes exactly four URLs: terrain tileset, physical CPU grids, context manifest, native manifest. Physical ellipsoid/datum, body-fixed initial camera, visibility, source attribution, bounded native footprint and mandatory base coverage are identical. It contains Sun, Mars and a viewpoint; no mission trajectories. No dataset registry, default entry point, Ingenuity or Curiosity catalog is changed.

Actual candidate identity: `a3038a1e19e81bce59fd3938f4c7631df9cc3f853cc69e3e4d33f3820ee1a899`.
Before identity: `10e4efa8a1d17fc4d61bba3d5c6634ad8fdfd4a4cbc149e34f310088d3d94b2a`.
After identity: `49510c3254af426f1e5fedb35eb68942cdbef6443c590fe04b28637289af422f`.
Fresh public HTTP verification and apply/rollback on a disposable copy passed, restoring the exact original.

```sh
node scripts/surface-build/catalog.mjs prepare \
  --lock work/surface-build/real-pilot-inputs/lock.json \
  --cache work/surface-build/real-executor-cache \
  --receipt docs/releases/surface-build-jezero/production-publication-receipt.json \
  --catalog docs/releases/surface-build-jezero/catalog.original.json \
  --catalog-rel test-catalogs/experiments/mars-surface-build-pilot.json \
  --prefixes docs/releases/surface-build-jezero/prefixes.json \
  --candidate work/surface-build/rechecked-public-catalog-candidate.json
cp docs/releases/surface-build-jezero/catalog.original.json work/surface-build/catalog-copy.json
node scripts/surface-build/catalog.mjs apply \
  --candidate work/surface-build/rechecked-public-catalog-candidate.json --catalog work/surface-build/catalog-copy.json
node scripts/surface-build/catalog.mjs rollback \
  --candidate work/surface-build/rechecked-public-catalog-candidate.json --catalog work/surface-build/catalog-copy.json
```

## Local viewing

The running pilot is http://127.0.0.1:5174/?catalog=test-catalogs/experiments/mars-surface-build-pilot and now directly loads the public R2 products. Reproduce with:

```sh
PILOT_VIEWER_PORT=5174 \
  SURFACE_PUBLICATION_RECEIPT=docs/releases/surface-build-jezero/production-publication-receipt.json \
  node scripts/surface-build/serve-pilot.mjs
SURFACE_HOSTED=1 CL_VIEWER_URL=http://127.0.0.1:5174/ \
  node scripts/test-surface-build-pilot.mjs \
  work/surface-build/real-pilot-report.json work/surface-build/public-browser-recheck
```

## Authorized deployed preview

The user authorized catalog and deployment on 2026-10-23. [Open the production preview](https://data.aaronplave.com/previews/pr-287/48334d7134f9177c3974f26e7a1b95e4f476181690e0dbd0f1330a62946aac0e/index.html?catalog=test-catalogs/experiments/mars-surface-build-pilot). The main GitHub Pages site allows only main-branch deployment, so this branch is built into an isolated R2 preview rather than replacing that site. No environment policy was changed. The preview contains only viewer assets and the reviewed experimental catalog; it has no mission catalogs, default catalog migration or mission placement changes.

`preview-deployment.json` records the exact 24 objects / 5,082,847 bytes, SHA-256 hashes, MIME types, content-addressed prefix and URL. All files passed public HTTP hash/type/cache checks. Application assets use `no-store`; immutable scientific products retain their existing cache policy. The preview and Mars data share `https://data.aaronplave.com`; this acceptance does not replace the separately recorded cross-origin CORS verification for the main site and localhost.

`deployed-browser.json`, `deployed-cold-warm.json` and `deployed-*.png` record actual production-build Chromium acceptance on Apple M4 Max / ANGLE Metal. No interception, dev-source imports or test mode: near/far imagery, L16 over L11 geometry, mandatory-base coverage, opacity/hiding/L13 fallback/restoration, physical picking, hover alignment, actual layer Fly to, attribution, cold/warm loads and no page/product HTTP errors. The warm reload reused 136 of 147 requests from browser cache. Physical/source uncertainty and desktop-only hardware limits above still apply.

`preview-rollback.json` records a live rollback and restoration: hash-check the exact preview objects, delete only that new prefix, verify empty storage and public entry-point 404, then republish and publicly verify identical bytes. The main site and immutable scientific products stay intact. Prior deployed state was absence. No merge or issue closure is authorized; the PR remains draft and #251 open.

Rebuild the preview without bundling unrelated local catalogs:

```sh
npm run build
(cd apps/viewer && npx vite build --base=./ --outDir ../../work/surface-build/mars-appearance-final-preview --emptyOutDir)
mkdir -p work/surface-build/mars-appearance-final-preview/test-catalogs/experiments
cp apps/viewer/test-catalogs/experiments/mars-surface-build-pilot.json work/surface-build/mars-appearance-final-preview/test-catalogs/experiments/
node scripts/surface-build/deploy-preview.mjs plan work/surface-build/mars-appearance-final-preview work/surface-build/new-preview-plan.json
```

Check a new plan before publication. Reproduction may produce a different asset hash with a changed toolchain; the recorded release rejects any changed inventory. With the exact recorded build directory and existing private R2 credentials, publish or rollback the recorded preview:

```sh
node scripts/surface-build/deploy-preview.mjs publish work/surface-build/mars-appearance-final-preview docs/releases/surface-build-jezero/preview-deployment.json
node scripts/surface-build/deploy-preview.mjs rollback work/surface-build/mars-appearance-final-preview docs/releases/surface-build-jezero/preview-deployment.json
# Restore immediately after a rollback rehearsal:
node scripts/surface-build/deploy-preview.mjs publish work/surface-build/mars-appearance-final-preview docs/releases/surface-build-jezero/preview-deployment.json
```

Run production-browser checks with `CL_VIEWER_URL` set to the preview's `index.html` URL and `SURFACE_HOSTED=1` using `scripts/test-surface-build-pilot.mjs`. Run `scripts/test-surface-build-cold-warm.mjs VIEWER_URL OUT_DIR` with the full catalog query URL for cold/warm acceptance. These scripts use the ordinary runtime renderer/control interface; no Vite development module is needed.

## Ellipsoidal Mars Surface Appearance review

The [review finding](https://github.com/AaronPlave/cosmolabe/pull/287#issuecomment-6369592156) is fixed in this PR. Known oblate products now require matching body/grid datum and mesh/grid revision, a recognized builder/source record, the explicit radial-lattice reference radius and encoding, finite range, metre transforms and valid ground topology. Geometry is checked against the stored radial-offset range; elevation tint, contours, hillshade and rendered range picks retain the declared geodetic-normal datum. Generic 3D Tiles remain unsupported. Disabled controls distinguish loading, unsupported product, unsupported reference/encoding and failed validation.

`mars-appearance-acceptance.json` and `mars-appearance.json` record the automated and real-product proof: 72 focused tests, including 15 new oblate cases; full typecheck and changed-file lint; production-build M4 Max / Metal browser checks of actual elevation colors, contours, neutral gray, hillshade, displayed-height picking, styled native/coarse imagery fallback, off/on restoration and 390 px controls. All position/index/normal and CPU-grid buffer identities and bytes were preserved; styles issued no data requests. Independent sampled normal-height comparisons cover 297 source vertices, with maximum float32 attribute error 0.0000003042 km; radial offsets differ by kilometres. The rendered tint pick was approximately -2.235144 km normal height. `mars-*.png` show the real controls and rendering. No scientific product was rebuilt or overwritten.

The original preview inventory and rollback are retained as `preview-deployment-initial.json` and `preview-rollback-initial.json`; the original URL remains available. Current `preview-deployment.json`, `preview-rollback.json`, deployed browser/cold-warm evidence and captures refer to the updated appearance-capable preview. Its 24 objects total 5,082,847 bytes. Live rollback and exact restoration were repeated for this release.

Cold/warm native-detail checks now pause the clock and reapply the catalog's declared body-fixed viewpoint without animation. In free orbit the eye is fixed in world space while Mars rotates, so the tiny ROI can rotate out of view before loading completes. This timing dependence reproduced on both the original and updated builds; it is not evidence of an appearance regression. The driver records its paused-clock framing explicitly. The main imagery driver separately verifies L16 over L11 terrain, hover/Fly to and fallback; no camera or authored datum was changed for this review.

Reproduce the appearance check with:

```sh
node scripts/test-mars-surface-appearance.mjs 'VIEWER_URL_WITH_CATALOG_QUERY' work/surface-build/mars-appearance-browser
```

The current preview build directory is `work/surface-build/mars-appearance-final-preview`; use that directory with the recorded current preview inventory for exact publish/rollback commands. Rebuilding with a changed toolchain may require a new content-addressed preview plan. Existing coarse contour/relief quality, absolute source/illumination uncertainty and the CPU/rendered mixed-LOD discrepancy remain disclosed; this compatibility fix does not certify finer physical data or independent registration.
