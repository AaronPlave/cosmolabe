# Ingenuity production publication and release acceptance

The five reviewed products are published at `https://data.aaronplave.com` and the
hosted production candidate passed acceptance. The final merged commit, Pages
run and public-site verification are recorded in PR #292 after deployment.

The immutable scientific build is
`56588b0ff3d445016722c38497d5b59e0d4e9f15e2a9e1dcb4dd72ba2905e10e`.
The regenerated publication identity is
`63894ab8a6241fc78b254a3972cf386231fd75642998539f06c0946931d1e4d1`.
The actual [publication receipt](publication-receipt.json) has identity
`06a6853700130f9abd5ef7a7cf2dbeacd9964bdc84988a21a18df834cc1e9136`.

| Product | Dataset ID | Published revision |
| --- | --- | --- |
| Terrain and CPU grids | `terrain-3846907d293e9e5d0b0243ce` | `3846907d293e9e5d0b0243cefc2ed446` |
| Viking | `imagery-04513d4681559e949e39e30f` | `04513d4681559e949e39e30fcaaaec3f` |
| Global CTX | `imagery-11f675fe48a13579126bb3cd` | `11f675fe48a13579126bb3cd85c3cb42` |
| Jezero CTX | `imagery-ab90c8bd749d673d3f786918` | `ab90c8bd749d673d3f7869185cbf5040` |
| Jezero HiRISE | `imagery-4992e13935cc9898d6522634` | `4992e13935cc9898d65226349f2cf222` |

The receipt records every full product identity, prefix and inventory hash.
Product objects total **5,103 / 1,243,309,388 bytes**. Including ten publication
metadata objects, storage totals **5,113 / 1,243,529,124 bytes**. No previous
versions, unrelated mission products, source pixels, masks, terrain registration
or estimated flight trajectories were changed.

## Verification and promotion

The existing surface publisher uploaded these exact completed products and
verified them over public HTTP. [Independent verification](independent-remote-verification.json)
then checked every product object against the reviewed inventory's SHA-256 and
byte count, MIME type, immutable cache header and production CORS response.
Every product passed origin probes for `https://aaronplave.com`,
`https://aaronplave.github.io` and `http://localhost:5173`, genuine missing-object
404s and cold shallow/intermediate/deep LOD samples. These requests reached
Cloudflare. Existing matching prefixes can be reverified and reused safely;
publication never authorizes overwriting different content.

The checked-in mission catalog retains its local paths. The five verified
`datasets.json` pins let the normal deployment rewrite replace exactly six
mission URLs. The candidate matches the reviewed catalog identity
`9e50d346411f74aa69f4b815e160948d869c1f1e388357bf7b58dd64b50449ed`
for those six replacements. The production rewrite additionally hosts the
already pinned kernels, as before. All 72 flight records and mission metadata
remain unchanged. [Artifact checks](artifact-contract.json) confirm the five
product directories are absent from the Pages artifact and the MoonFall catalog
matches its normal unchanged rewrite.

A bounded imagery experiment referenced an already local-only dataset but was
missing from that dataset's catalog exclusions. It is now excluded alongside
the existing local-only experiment; a regression covers both catalogs. No new
unpublished-product waiver was added.

Hosted testing exposed a transport failure after HTTP 200 headers: the CPU grid
body could reset outside the existing retry boundary. The viewer now supplies a
complete-response fetch adapter, so the existing four-attempt retry covers the
body while retaining the same concurrency slot. The numerical grid implementation,
scientific build hash, decoding and sampling remain unchanged. Regressions cover
successful recovery and permanent failure after four attempts. The deployment
verifier also retries transport/body failures with a four-attempt limit. Its
status, content and CORS assertions are unchanged.

## Browser and performance acceptance

[Structured acceptance](acceptance.json) records Chrome on physical Apple M4 Max
Metal. Full hosted mission acceptance passed global coverage and the original
CTX hole, independent imagery refinement, all layer controls, measurements,
physical picking, Fly to, 15 flight phases, 15 corridors / 2,216 rendered corridor
frames, camera clearance, optional/base outages and explicit recovery. Sampling
now requires sustained idle after camera motion before checking pixels; the
source-hole assertion and scientific tolerances remain unchanged.

A fresh browser context with cache disabled and service workers blocked loaded
the actual production build and all five R2 products. All 72 flight selections
reached their own time intervals. The candidate's CPU frame p95 was approximately
2.3 ms in its 120-frame CPU sample. Trajectory toggles for flights 1, 12 and 72
were visible above ground and changed zero pixels below terrain. MoonFall passed
close/far/lit rendering and all initial assets loaded. Eight Mars/Moon navigation
scenarios passed the existing per-call and per-frame navigation p99 < 4 ms gates.
See the structured results for individual frame costs.

The 960 MiB imagery setting is a residency target. Maximum reported layer GPU
allocation in the full mission was **1,025,801,326 bytes**; maximum recorded
protected overage was **39,847,248 bytes**. A genuinely cold 48 MiB fixture
reported **67,650,556 bytes** of layer GPU allocation, a **22,544,724-byte**
transition reservation, zero protected overage and complete mandatory base
coverage. These are layer counters, not whole-process VRAM measurements. Separate
GPU frame timing was not measured. Other browsers/devices remain untested.
Absolute source accuracy and complete observed 3D flight telemetry remain unknown.

Selected unmodified captures are in [captures](captures/). Raw timing/history
captures remain outside the repository; the compact results preserve acceptance
thresholds, source identities and representative evidence.

## Reproduce

From the release checkout, use the retained completed lock and cache rather than
rebuilding with different dependencies:

```sh
node scripts/build-surface.mjs "$LOCK" --cache "$CACHE" --publication-plan > "$OUT/plan.json"
node scripts/verify-surface-publication.mjs "$OUT/plan.json" \
  docs/validation/ingenuity-jezero/production-release/publication-receipt.json \
  "$OUT/remote-verification.json"
node scripts/test-hosted-ingenuity.mjs https://aaronplave.com/cosmolabe/ \
  "$OUT/public-browser" \
  docs/validation/ingenuity-jezero/production-release/publication-receipt.json
```

The full mission script uses development module imports. To repeat hosted mission
acceptance, prepare a temporary hosted catalog with `catalogCandidate()` and
`applyCatalogCandidate()` from `scripts/surface-build/publication.mjs`, using the
verified receipt and retained lock/cache. Restore the original raw catalog bytes
afterward. Run the existing mission, trajectory, MoonFall and navigation scripts
against the candidate. The production-build browser script above requires no
catalog interception or local-data fallback.

## Rollback

The [captured baseline](rollback-baseline.json) is deployment **7299234925**, commit
`0bf7018bb03ab6aa6a53c424692f9d44f75c36cf`, successful Pages run **40098058428**.
The actual previous [public catalog](previous-production-catalog.json) and
[dataset pins](previous-production-datasets.json) are preserved separately.
Production uses `DATA_BASE_URL=https://data.aaronplave.com` and the GitHub Pages
environment permits only `main`. Bucket management CORS/cache policies were not
readable with the object credentials; effective headers were verified publicly.

A [Git rollback drill](git-rollback-drill.json) reversed the complete release
first-parent diff in a temporary index and required the exact baseline tree
`eb92b16fe898880b06e22db57ebca38778e9290b`. Local catalog/pin apply/rollback and
raw backup restoration were also checked. No production rollback was performed.

If this deployment must be rolled back:

1. Confirm current production/main still corresponds to this release. Investigate
   concurrent changes before undoing anything.
2. Create a rollback branch from current `main`, then `git revert -m 1 MERGE_SHA`,
   where `MERGE_SHA` is the release merge recorded in PR #292. Verify the restored
   tree, catalog and pins against the captured baseline.
3. Review and merge the rollback PR into `main` through the normal repository
   process. Monitor the Pages workflow to successful deployment; directly
   dispatching a rollback branch would violate the deployment environment policy.
4. Verify the public catalog and pins match the backup, then use a cold browser
   to verify the previous application works.

Leave all newly published immutable R2 objects intact for diagnosis and reuse.
