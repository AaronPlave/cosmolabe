# Jezero pilot publication and catalog review

**Data publication is complete. Catalog deployment and deployed-origin acceptance remain pending.** The user authorized data-only publication, then approved accepting genuine HTML 404 responses after confirming the loaders reject unsuccessful status before decoding. No Cloudflare error-page rewrite is needed.

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
- `production-acceptance.json`: concise publication/catalog/browser validation and remaining approval.
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

Intended catalog location: **`test-catalogs/experiments/mars-surface-build-pilot.json`**. The static artifact stays in this release directory until separately authorized for exposure. `prefixes.json` maps the three product IDs to their exact catalog-root-relative local prefixes.

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

## Local viewing and remaining approval

The running pilot is http://127.0.0.1:5174/?catalog=test-catalogs/experiments/mars-surface-build-pilot and now directly loads the public R2 products. Reproduce with:

```sh
PILOT_VIEWER_PORT=5174 \
  SURFACE_PUBLICATION_RECEIPT=docs/releases/surface-build-jezero/production-publication-receipt.json \
  node scripts/surface-build/serve-pilot.mjs
SURFACE_HOSTED=1 CL_VIEWER_URL=http://127.0.0.1:5174/ \
  node scripts/test-surface-build-pilot.mjs \
  work/surface-build/real-pilot-report.json work/surface-build/public-browser-recheck
```

**Approval B is still required:** authorize exposure/deployment of only the reviewed experimental catalog at `test-catalogs/experiments/mars-surface-build-pilot.json`. Review `production-catalog-candidate.json` and preserve the previous deployed file or its absence before exposure. Deployment rollback restores that previous file/absence; immutable published data remains accessible and is not deleted. The rehearsal restores the source catalog JSON; it does not itself exercise a live deployment rollback.

After approval, validate the actual deployed/preview viewer origin against public R2: cold/warm loads, near/far LOD, controls/fallback, physical picks, hover/Fly to, provenance, CORS/cache/network and zero uncovered base blocks. Attach URL, browser/GPU evidence and rollback rehearsal. Keep #287 draft and #251 open until this acceptance is observed; no merge or issue closure is authorized yet.
