# Hosting large data products

The viewer's GitHub Pages site is limited to 1 GB, and the data the demos need
has outgrown it: the fused Mars terrain is ~5.9 GB in ~711 k files, and the
SPICE kernels are ~1.1 GB. These live in an object store instead — Cloudflare R2
behind a custom domain — and the deployed catalogs point there. Nothing large
goes in git or in the Pages artifact.

Local catalogs keep their local paths
(`kernels/…`, `/test-catalogs/data/…`), `npm run dev` serves them from
`apps/viewer/test-catalogs/`, and the Vite middleware still gunzips `.terrain`
files on the fly. Run `scripts/fetch-all.sh` to populate the full local mission
kernel set. Small deterministic test kernels are committed in Git; only two
oversized test fixtures remain in LFS.

## How the pieces fit

```
scripts/data-hosting/datasets.json   what is managed, and which build is pinned
scripts/publish-data.mjs             upload one build, verify it, pin it
scripts/build-hosted-catalogs.mjs    deploy time: rewrite dist/ catalogs, prune hosted data
scripts/verify-hosted-data.mjs       deploy time: smoke-test everything dist/ depends on
```

- **`datasets.json`** lists each managed product (`terrain/mars-terrain-fused`,
  `kernels/cassini`, …) with its local directory, the catalog-relative prefix it
  occupies, and a `build` id. `build: null` means unpublished.
- **Remote layout** is immutable and versioned:
  `terrain/<name>/<build>/{layer.json,<z>/<x>/<y>.terrain,manifest.json,inventory.jsonl.gz,…}`
  and `kernels/<name>-<build>/{manifest.json,<kernel files>}`.
- **Hosted catalogs** are generated at deploy time, not checked in.
  `build-hosted-catalogs.mjs` resolves every string in a built catalog against the
  catalog's own location, the way the viewer does, and rewrites only those that land
  inside a published dataset's prefix to `<DATA_BASE_URL>/<remote prefix>…`. NASA
  imagery URLs, textures and models are untouched. Hosted data is then removed from
  `dist/`, and `dist/hosted-data.json` records what the deployment depends on.
  It fails if a catalog references a dataset with no published build
  (`--allow-unpublished` overrides).
- **Deploy gate.** `.github/workflows/deploy-pages.yml` switches on the repository
  variable `DATA_BASE_URL`. Unset, the workflow behaves as before (fetch kernels
  from NAIF, ship them in the artifact). Set, it skips the NAIF fetch, rewrites the
  catalogs, and runs `verify-hosted-data.mjs` — a missing object, a size mismatch or
  a missing CORS header fails the build before anything is deployed.

## One-time setup (Cloudflare)

1. **Bucket.** Create an R2 bucket (Standard storage), e.g. `cosmolabe-data`.
2. **Custom domain.** Bucket → Settings → Custom Domains → connect e.g.
   `data.example.org` (the zone must be on Cloudflare). This puts Cloudflare's CDN
   in front of the bucket. Use the `r2.dev` URL only for smoke tests.
3. **CORS** (Bucket → Settings → CORS policy). Read-only; list your Pages origin
   and local dev, or `*` if the datasets are intentionally reusable:
   ```json
   [
     {
       "AllowedOrigins": ["https://<owner>.github.io", "http://localhost:5173"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```
   The browser only needs the origin of the page (`https://<owner>.github.io`, no path).
4. **Cache rule.** Cloudflare's default cache skips extensions it doesn't know,
   and `.terrain` is one. Add a Cache Rule for the data hostname:
   *Cache eligibility: Eligible for cache*, *Edge TTL: Use cache-control header
   if present*. The objects carry `Cache-Control: public, max-age=31536000, immutable`,
   so tiles then come from the edge and don't count as R2 reads.
5. **API token.** R2 → Manage API tokens → Create: *Object Read & Write*, scoped
   to this one bucket. Note the access key id, secret and your account id.
6. **GitHub.** Repository variable `DATA_BASE_URL` = `https://data.example.org`
   — set it only after the first publish below, since the workflow then requires
   every dataset the catalogs reference to be published.

## Publishing

Credentials come from the environment (never from files in the repo):

```sh
export R2_ACCOUNT_ID=…  R2_ACCESS_KEY_ID=…  R2_SECRET_ACCESS_KEY=…  R2_BUCKET=cosmolabe-data
export DATA_BASE_URL=https://data.example.org     # used to verify the upload
```

```sh
npm run publish:data -- list
npm run publish:data -- terrain/mars-terrain-fused --build mola-hrsc-jezero-v1
npm run publish:data -- kernels/cassini --build 2026-10-02
# or, straight after rebuilding the pyramid:
scripts/build-mars-terrain/fused.sh --publish mola-hrsc-jezero-v1
```

What a publish does, in order:

1. Inventories the source directory (size, SHA-256, gzip flag per file) and
   validates it — terrain: `layer.json` format and relative `tiles` template, uniform
   tile encoding, `tileCount` in `terrain-product.json` matches the files on disk,
   sample tiles are at least a quantized-mesh header; kernels: DAF/`KPL/` headers
   match the file type (this catches an HTML error page or an LFS pointer saved
   under a kernel name). Nothing is uploaded if this fails.
2. Refuses if `<prefix>manifest.json` already exists — a completed build is
   never overwritten. Pick a new `--build` id.
3. Uploads with bounded concurrency (`--concurrency`, default 16) and retries,
   setting `Content-Type`, `Cache-Control: public, max-age=31536000, immutable`, and
   `Content-Encoding: gzip` on gzip `.terrain` tiles (not on `*.gz` kernels, which the
   viewer gunzips itself). Keys already present with the right size are skipped, so
   re-running the same command resumes an interrupted upload.
4. Uploads `inventory.jsonl.gz`, then `layer.json`, then `manifest.json` last.
   A build without `manifest.json` is incomplete and unreferenced.
5. Verifies through `DATA_BASE_URL`: manifest, `layer.json`, shallow / mid-level /
   deepest sample tiles (status, CORS for the Pages origin and localhost,
   `Content-Encoding: gzip`, immutable cache header, body is raw quantized-mesh once
   the client has inflated it), a plain non-HTML 404 for a missing object, and for
   kernels the size of every file.
6. Only then writes the build id into `datasets.json`. Commit that change; it is
   what catalogs pin. Roll back by pointing `build` at the previous id.

`--dry-run` stops after step 1. `--no-verify` / `--no-pin` upload without pinning.
Old builds are not deleted automatically; remove superseded prefixes from the
Cloudflare dashboard (or any S3 client) once nothing pins them.

`--local-dir <dir>` publishes into a directory instead of R2; the tests use it.

### Kernel manifests

`kernels/<name>-<build>/manifest.json` records, per file: filename, kernel type,
size, SHA-256, whether it is gzipped, the upstream NAIF URL (resolved from the
`scripts/fetch-*.sh` script that downloads it), the repository path for small
kernels that are committed instead of fetched, and the file's modification time
as `retrievedAt`. At manifest level it records the fetch scripts' SHA-256s and the
git commit. Coverage intervals are not computed yet (that needs CSPICE at publish
time).

Kernel sets are published as they are on disk: `kernels/generic` is the
top-level files in `apps/viewer/test-catalogs/kernels/` (leap seconds, `pck00011`,
`de440s`, asteroid, `jup348`/`sat459`), and each mission set is its own subdirectory.
Catalogs pin the dated directory, so replacing a kernel is a new build, and a
demo can't change behaviour underneath its users.

### Adding a dataset

Add an entry to `datasets.json` (`kind`, `name`, `localDir`, `catalogPrefix`,
`build: null`; kernel sets also list their `fetchScripts`). For a new terrain
product such as MoonFall (#48), the directory only needs to be a
`quantized-mesh-1.0` pyramid with a relative `layer.json` `tiles` template. A test
checks that every kernel/terrain path in the example catalogs belongs to a managed
dataset, so a new mission directory can't be forgotten.

## Checking a deployment

Locally, `apps/viewer/test-catalogs/` may hold gigabytes of terrain and kernels, and
Vite copies its whole `publicDir` into `dist/`. Build with `HOSTED_DATA=1` to skip
every dataset pinned in `datasets.json` during that copy (CI never has them, so it
doesn't need the flag). `HOSTED_DATA_SKIP=<dataset-id>,…` also skips datasets that
aren't pinned yet, e.g. one that is still uploading:

```sh
(cd apps/viewer && HOSTED_DATA=1 HOSTED_DATA_SKIP=terrain/mars-terrain-fused VITE_BASE=/ npx vite build)
```

```sh
node scripts/build-hosted-catalogs.mjs --dist apps/viewer/dist --base-url "$DATA_BASE_URL"
node scripts/verify-hosted-data.mjs   --dist apps/viewer/dist --origin https://<owner>.github.io [--deep]
```

`--deep` downloads and hashes every kernel instead of comparing sizes.

The tests (`npm test`, project `scripts`) cover the HTTP behaviour against a local
server that serves stored headers the way R2 should: gzip tiles decode through
ordinary `fetch` and the real quantized-mesh decoder, and a host that drops
`Content-Encoding`, omits CORS, or answers 404 with HTML is flagged. They can't
exercise Cloudflare itself — the first real publish does, via step 5 above.

## Cost estimate

Assumptions: R2 Standard, using the rates Cloudflare publishes for R2 (storage
$0.015/GB-month after 10 GB free; Class A operations — writes and lists —
$4.50 per million after 1 M free per month; Class B — reads — $0.36 per million
after 10 M free; **no egress charge**). Check the current pricing page before
relying on these numbers.

| Item | Size / count | Monthly cost |
|---|---|---|
| Mars fused terrain (one build) | ~5.9 GB, ~711 k objects | within the free 10 GB |
| Pinned kernel sets | ~1.1 GB, tens of objects | within the free 10 GB |
| Moon terrain (#48, today) | ~0.6 GB | within the free 10 GB |
| **Storage today** | **~7.6 GB** | **$0** |
| First publish of the terrain | ~711 k Class A | $0 (inside 1 M free) |
| A second terrain build in the same month | +~711 k Class A, +5.9 GB stored | ≈ $2 one-off (Class A overage) + ≈ $0.05/month while both builds are kept |
| Reads | a session near Jezero fetches hundreds to a few thousand tiles; CDN-cached hits don't reach R2 | $0 until >10 M uncached reads/month, then $0.36 per extra million |
| Egress | — | $0 |

So the steady-state bill is effectively zero; the things that move it are keeping
many superseded 6 GB terrain builds (delete old prefixes) and republishing the
pyramid several times a month. A custom domain on Cloudflare adds no charge on
the free plan.

## Not in this change / follow-ups

- **Packed archives** (PMTiles-style, per-zoom bundles) are deliberately not part
  of the first implementation: they need a range-request loader and change the
  quantized-mesh path. Measure first — full upload duration, request count and
  bytes for orbit-to-ground views, CDN hit rate, refinement latency — and only then
  consider several spatial/versioned archives.
- **Imagery** (`imagery/<dataset>/<build>/…`) has a reserved place in the layout but
  no managed dataset yet; the catalogs still use NASA's tile services.
- **Catalog assets via LFS** (textures, models; tens of MB) stay in the Pages
  artifact.
- **Kernel coverage intervals** in the kernel manifests.
- **Moving the whole Examples catalog/index to the host** can use the existing
  catalog-source mechanism ([catalog-sources.md](catalog-sources.md)) later.
