# LRO lunar cube migration (#240)

`lro-moon.json` now uses the same full-lattice, skirted cube terrain,
matching CPU grids and global WAC + south-pole NAC imagery as MoonFall.
No simplification override or culling policy changes are introduced.
The normal deploy-time rewrite selects:

- Terrain and CPU grids: `cube-fused-79895697c6b6-g3-m12-b6747ec9d`.
- Imagery: `cube-imagery-composite-3f34a19541af7710`.

Local catalog paths remain local. `scripts/data-hosting/lib/hosted-catalogs.mjs`
rewrites them using the existing pinned dataset registry during deployment;
no special LRO rewrite or runtime interception is required.

The existing LRO SPK, clock, frame/instrument kernels, mission epoch,
viewpoints, model, Nadir attitude and seven instruments are preserved. The
Moon uses `MOON_ME_DE421` with the already included lunar FK and binary PCK.
Absolute reconstructed spacecraft positions are not clamped or rebaked.
See [the #238 audit](../lunar-frames/README.md): this frame convention does
not establish an absolute terrain/imagery geolocation error bound. That
operational alignment acceptance remains unverified, even though the
frame implementation is present.

## Catalog inventory and retirement decision

| Catalog | Consumers / defined purpose | Decision |
| --- | --- | --- |
| `lro-moon` | Real reconstructed orbiter; instrument-window and mission-place tests | Migrate surface, preserve mission |
| `moonfall-shackleton` | Synthetic surface flights, clearance, activity, contour and navigation regressions | Retain |
| `experiments/moon-terrain-geographic` | `capture-cube-terrain.mjs`, `capture-cube-imagery.mjs`: quantized-mesh comparison | Retain diagnostic fixture |
| `experiments/moon-terrain-polar` | Same capture scripts: polar-layout comparison | Retain diagnostic fixture |
| `experiments/moon-terrain-cube` | Same capture scripts; `test-surface-navigation-live.mjs`: terrain-only and navigation control | Retain diagnostic fixture |
| `experiments/moon-terrain-cube-imagery-grid` | `capture-cube-imagery.mjs`: grid/face orientation | Retain diagnostic fixture |
| `experiments/moon-terrain-cube-imagery-registration` | Same script: image registration control | Retain diagnostic fixture |
| `experiments/moon-terrain-cube-imagery-nac` | Same script; `test-cube-surface-appearance.mjs`: regional imagery/style comparison | Retain diagnostic fixture |
| `experiments/moon-terrain-cube-imagery-adoption` | Same script: adoption/outage comparison and synthetic instrument reference | Retain diagnostic fixture |

No catalog is demonstrably redundant yet: the experiment paths exercise
comparisons that a production LRO scene cannot replace. Retirement is
conditional on equivalent coverage and verified hosted acceptance. Historical
commands and comparison evidence therefore remain valid. Do not delete these
fixtures, published builds, geographic/quantized-mesh support or irregular-body
mesh support as part of this migration.

## Validation

```sh
npx vitest run --project scripts scripts/lro-cube.test.mjs scripts/data-hosting/__tests__/data-hosting.test.mjs
npx vitest run --project packages packages/core/src/__tests__/lunar-frame-alignment.test.ts
node scripts/test-hosted-lro.mjs VIEWER_URL work/lro-cube
node scripts/test-instrument-window.mjs
```

The hosted browser check requires a normally built viewer with bundled example
catalogs and the normal deployment rewrite, plus `https://data.aaronplave.com`
reachable from the browser. The host allows `http://localhost:5173`; arbitrary
local ports are rejected by CORS. Build/rewrite with:

```sh
HOSTED_DATA=1 BUNDLE_TEST_CATALOGS=1 npm --prefix apps/viewer run build
node scripts/build-hosted-catalogs.mjs --dist apps/viewer/dist --base-url https://data.aaronplave.com --allow-unpublished terrain/mars-terrain-fused --allow-unpublished kernels/rosetta
```

### Hosted acceptance on 2026-10-31

The [retained metrics](hosted-acceptance.json) passed against a local production
preview using the real immutable hosted products, without request interception.
Two independent cold contexts blocked service workers and disabled the browser
cache: one deterministic `?test=1` session and one normal-rendering session.
Both used Apple M4 Max / ANGLE Metal. All six views settled without budget
limitation, page/console errors, transport failures, asset failures, terrain/CPU
failures, imagery failures, GPU errors or uncovered mandatory-base blocks.

| Session | Terrain GLBs | CPU height grids | Imagery payloads |
| --- | ---: | ---: | ---: |
| Deterministic | 250 | 224 | 392 |
| Normal rendering | 250 | 223 | 402 |

The four mission views were retained. Moon Overview, Lunar North Pole and the
new Shackleton close-up each asserted a real rendered terrain pick and a CPU
grid triangle intersection in `MOON_ME_DE421`. The close-up is five kilometres
above CPU ground at 89.67°S, 129.78°E and reached imagery level 12. At this mission
epoch its crater-floor view is dark; this is not a sunlit-terrain acceptance claim.

The LROC WAC feed's actual camera ray intersected the adopted CPU terrain at
about 82.7 km. This uses the catalog's target-pointing fallback, **not reconstructed
CK attitude or an operational observation**. The existing drawn frustum still
reports reference-surface clipping; its perimeter is not certified as a
terrain-conforming footprint. CPU hits explicitly remain `coarse`, with an
unknown mesh-deviation bound. No source uncertainty or absolute alignment bound
is inferred from these intersections.

Normal-rendering captures: [orbital Moon](normal-Moon-Overview.png),
[Shackleton close-up](normal-Shackleton-Close-up.png), and
[LROC WAC feed](normal-LROC-WAC.png).

The earlier execution's CONNECT 403 limitation has been superseded for this
local production-preview run. This is not a deployment. Before closing #240,
still verify all seven instruments, terrain/imagery interruption and recovery,
missing orientation kernels, and the #238 alignment acceptance on the actual
deployed viewer. Run the instrument-window check as documented in that script.

## Lunar drawing regression

The migration exposed two drawing failures: saved annotations without an explicit
frame resolve to `IAU_MOON`, and the New layer form also omitted the current
frame. Surface clicks in `MOON_ME_DE421` were consequently refused. New authored
layers now retain the selected surface frame, and drawing targets only compatible
layers. Old annotations retain their original coordinates and frame; drawing
creates a compatible annotation layer when needed.

```sh
node scripts/test-lunar-drawing.mjs VIEWER_URL OUTPUT_DIR
```

On 2026-10-31, this regression passed against the local PR viewer in Chrome with
Apple M4 Max / ANGLE Metal: actual lunar terrain clicks created points both with
a preexisting implicit-IAU annotation layer and in a layer made through New layer.
The existing annotation remained unchanged, all layers survived reload, and no
page errors occurred. The script writes screenshots and metrics. This is a
drawing-flow check, not the broader deployed/near-surface acceptance above.
See the [new-layer drawing capture](drawing-new-layer.png).

## Rollback

Revert the `lro-moon.json` change to restore the previous `moon_v14`
quantized-mesh terrain, NASA Trek imagery and `IAU_MOON` rotation together.
No published objects or pinned dataset entries are modified or deleted here.
Retain old hosted builds until replacement acceptance has passed; the legacy
experiment comparisons remain available for investigation.
