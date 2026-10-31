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

The hosted browser check requires a viewer built with the normal deployment
rewrite and `https://data.aaronplave.com` reachable. It verifies the served
catalog against that rewrite, observes real hosted requests, captures the four
mission views, records picking/terrain/imagery state and repeats after reload.
It does not certify near-surface, outage recovery or absolute alignment.
Run the instrument-window check against the viewer as documented in that script.

In this execution environment the production host fails at CONNECT with HTTP
403 from the enforced proxy policy. No live hosted or browser acceptance is
claimed. Before closing #240, verify orbital and near-surface picks, all seven
instruments, terrain/imagery interruption and recovery, missing orientation
kernels, and the #238 alignment acceptance on the actual deployed viewer. Keep
screenshots and metrics from that run. Passing local rewrite tests is insufficient.

## Rollback

Revert the `lro-moon.json` change to restore the previous `moon_v14`
quantized-mesh terrain, NASA Trek imagery and `IAU_MOON` rotation together.
No published objects or pinned dataset entries are modified or deleted here.
Retain old hosted builds until replacement acceptance has passed; the legacy
experiment comparisons remain available for investigation.
