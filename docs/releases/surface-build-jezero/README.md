# Jezero pilot release preparation

Prepared for [the production-acceptance handoff](https://github.com/AaronPlave/cosmolabe/pull/287#issuecomment-6366251549) at implementation commit `0e41e6369b5c0bb49cad5868aeb3e1ca39aec69b`.

**Status: data publication authorized and attempted; stopped on public HTTP verification.** The terrain product is uploaded and all 161 data files match their hashes; its immutable prefix contains 163 objects / 13,976,621 bytes including completion metadata. Neither imagery product was uploaded. No verified publication receipt exists, and no catalog or deployment changed. See `publication-attempt.json` for the exact uploaded inventory counts, storage/domain binding, CORS responses and remaining host actions. The full public catalog remains a planned destination, not a verified publication. The receipt-bound production candidate must be generated after successful publication.

## Reviewed artifacts

- `publication-plan.json`: refreshed full inventory and hashes for build `67fcad0f749be705e94401070d04fc953c21a61ef83047987087ee547628c9ab`, lock `sha256:5c5fbc579f3b693facfd6aefc41b9358a682378c60edb59dc048a569f250c7b9`. All supported numerical/build gates passed. Confirmation identity: `6452b87375212a652903c625ec8787d088d5b3688ee59bc974b8092ddf550a99`.
- `catalog.original.json`: dedicated static experiment catalog, captured from the currently validated pilot and converted to explicit local product prefixes. Physical Mars ellipsoid and CPU grids, L13 mandatory fallback, L16 optional native detail, bounded native footprint, attribution, and the existing body-fixed native-detail viewpoint are retained. It contains Sun, Mars and a viewpoint, with no mission trajectories.
- `prefixes.json`: exact catalog-root-relative product mappings. Intended deployment location is **`test-catalogs/experiments/mars-surface-build-pilot.json`**. The source artifact lives here to keep the catalog out of the deployed viewer until separately approved.
- `catalog.planned.json`: reviewable public-URL rewrite of the original. Exactly four values change: terrain tileset, physical CPU grids, context imagery manifest, native imagery manifest. Viewpoint, ellipsoid, datum, visibility, bounds, descriptions and attribution are identical.
- `preparation.json`: schema validation and actual local-publication HTTP/apply/rollback results. This is explicitly local-only evidence.

The plan contains **219 data objects / 14,435,500 bytes**. The existing local publication has **225 storage objects / 14,449,636 bytes**, including inventories and completion metadata. Production counts must come from its actual receipt. Each public product root is `https://data.aaronplave.com/` followed by the exact immutable `prefix` in the plan.

All four locked sources declare USGS/NASA public-domain licensing with attribution “NASA/USGS MOLA, MEX HRSC and Mars 2020 TRN HiRISE”; immutable imagery manifests retain verified source provenance. Both imagery layers contain the same observed 512 m, 25 cm crop, not a global native Mars basemap. Absolute registration and illumination remain unknown. The measured maximum mixed-LOD CPU/rendered gap of 291.042 m and 30.24 m rendered clearance at nominal 50 m remain disclosed in [the acceptance record](../../surface-build-acceptance.md).

## Approval A: data publication only

Required owner decision, specified by the handoff:

> Authorize publishing the reviewed immutable #251 Jezero pilot products to the configured R2 bucket served by https://data.aaronplave.com. Do not modify or deploy any catalog or mission.

The user authorized this data-only next step in the session. The configured bucket/public-domain binding was verified using a pre-existing manifest before any writes. The first attempt stopped at the CORS gate. Do not resume writes until the host issues below are corrected. From the reviewed checkout, regenerate the preflight before resuming:

```sh
node scripts/build-surface.mjs work/surface-build/real-pilot-inputs/lock.json \
  --cache work/surface-build/real-executor-cache --publication-plan \
  > work/surface-build/publication-plan.json
```

Compare the regenerated plan's build, lock, products, hashes and identity with this reviewed plan; stop on changes. Use the regenerated identity with the existing explicit publication command:

```sh
node scripts/build-surface.mjs work/surface-build/real-pilot-inputs/lock.json \
  --cache work/surface-build/real-executor-cache --publish-r2 \
  --verify-url https://data.aaronplave.com \
  --verify-origin https://aaronplave.com \
  --verify-origin http://localhost:5173 \
  --verify-origin http://127.0.0.1:5187 \
  --confirm-publication 6452b87375212a652903c625ec8787d088d5b3688ee59bc974b8092ddf550a99 \
  > work/surface-build/production-publication-receipt.json
node scripts/surface-build/feedback.mjs \
  work/surface-build/real-pilot-report.json \
  work/surface-build/production-publication-receipt.json \
  work/surface-build/production-planner-feedback.json
```

Require a verified receipt with `localOnly:false`, matching identity, complete object hashes/counts/bytes, expected manifests, MIME types, immutable caching, allowed CORS and non-HTML missing-object 404s. The uploader refuses conflicting bytes and unexpected prefix contents. Stop on failure; leave unused prefixes unreferenced. Keep credentials out of artifacts and logs.

## Host corrections required before resuming

The actual HTTPS viewer origin `https://aaronplave.com` and `http://localhost:5173` are allowed. The pilot origin `http://127.0.0.1:5187` is rejected. Preserve existing CORS rules and add that pilot origin with read-only GET/HEAD access. The initial publisher incorrectly assumed `https://aaronplave.github.io`; repeatable `--verify-origin` now selects the actual origins and records them in the content-pinned receipt. Catalog preparation inherits those recorded origins by default. There is no requirement to add the unused GitHub origin.

Missing product URLs currently return `404 text/html`. The handoff explicitly requires non-HTML 404s; the surface publication verifier now enforces this for cube products as well. Configure the public data host to return status 404 with a non-HTML body/type for missing objects. No error is waived. The configured object read/write credentials return `AccessDenied` (403) for reading bucket CORS; no bucket policy, CDN configuration or routing was changed.

After correcting the host, resume the command above. It checks existing terrain bytes and reuses the identical immutable product, then publishes the two imagery products. Keep the current terrain prefix unreferenced until complete public verification succeeds; do not delete or overwrite it.

## Receipt-bound candidate and rehearsal

Only after the public receipt exists, prepare the actual candidate. Preparation freshly verifies public HTTP content:

```sh
node scripts/surface-build/catalog.mjs prepare \
  --lock work/surface-build/real-pilot-inputs/lock.json \
  --cache work/surface-build/real-executor-cache \
  --receipt work/surface-build/production-publication-receipt.json \
  --catalog docs/releases/surface-build-jezero/catalog.original.json \
  --catalog-rel test-catalogs/experiments/mars-surface-build-pilot.json \
  --prefixes docs/releases/surface-build-jezero/prefixes.json \
  --candidate work/surface-build/production-catalog-candidate.json
cp docs/releases/surface-build-jezero/catalog.original.json work/surface-build/production-catalog-rehearsal.json
node scripts/surface-build/catalog.mjs apply \
  --candidate work/surface-build/production-catalog-candidate.json \
  --catalog work/surface-build/production-catalog-rehearsal.json
node scripts/surface-build/catalog.mjs rollback \
  --candidate work/surface-build/production-catalog-candidate.json \
  --catalog work/surface-build/production-catalog-rehearsal.json
```

Require candidate `before` to equal the reviewed original and `after` to equal the reviewed planned catalog. Require rollback to restore the exact original JSON. The local rehearsal already passed these operations using the local receipt; it does not substitute for public receipt verification.

Run the ordinary viewer against the actual public URLs before deployment:

```sh
SURFACE_PUBLICATION_RECEIPT=work/surface-build/production-publication-receipt.json \
  node scripts/surface-build/serve-pilot.mjs
SURFACE_HOSTED=1 node scripts/test-surface-build-pilot.mjs \
  work/surface-build/real-pilot-report.json work/surface-build/production-browser
```

## Approval B: dedicated experiment exposure

After reviewing the verified production candidate, rollback, receipt and browser evidence, separately authorize a preview/deployment of **only** `test-catalogs/experiments/mars-surface-build-pilot.json`. No default entry-point, dataset-registry, Ingenuity or Curiosity migration is included. The dynamic local pilot route is not itself a deployed static catalog.

Repeat cold/warm loading, near/far LOD, opacity/hiding/fallback, physical picking, hover/Fly to alignment and network checks from the actual deployed/preview viewer origin against the public data host. Record URL, browser/GPU, captures, zero product errors and zero uncovered mandatory-base blocks. Keep #287 draft and #251 open until this acceptance is observed.

Rollback restores the prior deployed catalog pin (or removes this new experimental catalog if it was absent). Preserve the prior deployment artifact before exposure. Keep immutable products accessible; do not delete data as rollback. The JSON apply/rollback rehearsal restores the reviewed original; deployment rollback additionally restores the previous deployed file/absence. No live catalog or deployment was changed during preparation.
