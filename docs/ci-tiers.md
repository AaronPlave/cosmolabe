# CI tiers (issue #288)

Our CI deliberately separates the always-on deterministic correctness gates
from expensive browser and terrain smoke. The GitHub Pages deployment remains
a separate push-to-main workflow.

## Fast PR CI

[`ci.yml`](../.github/workflows/ci.yml) runs **Fast PR CI** for every PR
targeting `main` and every push to `main` (also verifying the merged result).
It retains the previous LFS-pointer check, purity lint, ESLint, package build,
test/viewer/Svelte typechecking, and the Vitest suite, including
SPICE/geometry and deterministic surface-build planning. The GDAL executor
rebuild/publication cases in `scripts/surface-build.test.mjs` run in the targeted
Surface build executor job instead of making every unrelated PR install GDAL
and rebuild terrain. The original sparse LFS test-kernel set, cached LRO
download and Cosmographia data setup are preserved. Do not remove fixture-dependent tests to
improve CI time. Target ~2–4 minutes on warm runners, *measure rather than
impose a hard four-minute cutoff*.

The job's stable name is `Fast PR CI`. If branch protection is configured in
the future, require that name; do not require skipped optional jobs. When this
work was started, `main` had no enforced required status checks. This PR does
not change branch protection.

## Targeted PR checks

A path filter on PR changes runs independent, visible jobs:

| Job | Key triggers (conservative by design) |
| --- | --- |
| Terrain builder fixtures | Python terrain/builder tooling, terrain fixture/data/catalog/schema, surface plans; includes raster validity masks/filtering and source-kernel nodata regressions |
| Surface build executor | Locked executor, terrain/raster and publication tooling, shared scene/runtime dependencies, pilot catalogs/harness and surface-plan fixtures |
| StarField WebGL + viewer calibration | Shared scene engine/browser integration **or** StarField harness changes |
| Global geographic viewer smoke | Shared scene engine/browser integration **or** geographic harness changes |

Changes to the CI workflow, shared CI actions/scripts, package manifests,
lockfile, viewer Vite config, and relevant smoke infrastructure trigger all
four. The shared browser rule intentionally covers all core scene/math
implementation (`packages/core/src/**`), Three.js rendering, SPICE/frames,
viewer integration/state (`apps/viewer/src/lib/**`), viewer workers/entry points,
and all example catalog inputs. That triggers **both** browser suites when a
new scene/camera/trajectory/rotation/time integration file appears, without
maintaining a hand-written list of individual source files. Documentation,
viewer CSS and UI-only components remain outside this shared browser rule, so
those changes can use just the fast gate. The surface executor additionally
tracks the imagery-layer and body-info controls used by its hosted acceptance.
A suite-specific harness change triggers that suite independently. Prefer a few extra runs over false negatives.

The surface executor installs GDAL/NumPy and Chromium, explicitly verifies the
Python imports, runs all surface-build planning/rebuild/publication regressions,
then runs the hosted synthetic Skyfall acceptance through HTTP publication,
planner feedback, catalog pinning and rollback. It uploads reports and browser
logs/screenshots even on failure. This fixture does not publish to production
or use R2 credentials. The other terrain and browser jobs retain #288's split;
no separate surface-only change detector or unconditional executor was restored.
The mask/kernel fixture filter includes its imported worker and source-kernel
helpers, so helper-only changes select both relevant jobs. The shared setup
also retains the surface pilot's Ubuntu mirror workaround before browser
installation; this does not add another check or change the job selection.

Targeted jobs are **not required statuses**; they may be legitimately skipped.
A failing targeted run is still a regression to fix before merging. The
geographic PR smoke uses the existing `CL_SMOKE=1, CL_FRAMES=1` preset;
StarField PR calibration uses `CL_STAR_SMOKE=1`. Neither uses a fake graphics
implementation: Playwright runs headless Chromium/SwiftShader.

## Nightly and manual full smoke

[`nightly-smoke.yml`](../.github/workflows/nightly-smoke.yml) runs at
04:23 UTC daily on the latest `main`. Select **Actions → Nightly full smoke
→ Run workflow** to invoke it against a chosen branch (including a feature
branch for full PR verification). GitHub exposes manual dispatch only after
the new workflow exists on `main`: run the first full suite immediately after
merging, inspect its artifacts, and keep issue #288 open until it passes.
Its jobs run:

- Complete Python terrain builder fixtures
- StarField WebGL/readback and full normal-viewer calibration
- Full geographic global viewer smoke (not the shortened PR preset)
- Visual regression for `earth-moon`, `atmosphere-earth`, and `cassini-soi`

The visual set uses already committed golden PNGs, fixed catalog scenes,
frozen epochs, deterministic software rendering, and explicit initial-asset
readiness in `visual-regression.mjs`. In CI, missing/timed-out
initial assets fail the scene instead of yielding a partial golden; unrecognized
or empty `VR_SCENES` selections fail rather than becoming no-op runs. It
*never* auto-creates or updates goldens in CI. Expand this curated set only after verifying the next scene is
stable on the runner. Visual failures provide `*-actual.png` and `*-diff.png`
in the job's uploaded artifacts. StarField and geographic jobs upload
screenshots, metrics and viewer server logs, including on failure. Artifacts
expire after seven days; each job's summary links the workflow run and its
checked commit. Failed scheduled workflows appear as failed GitHub Actions
runs. Enable GitHub Actions failure notifications/watch the workflow so nightly
failures are not ignored.

`scripts/ci/run-viewer-smoke.sh` is shared between PR and nightly to avoid
drifting browser launch and asset-wait behavior. The composite action
`.github/actions/ci-setup` shares Node/npm and sparse LFS setup. No
unconditional full LFS checkout or Rosetta rebuild is performed.

To run the same browser checks locally after `npm ci` and
`npm run build`, install Chromium (`npx playwright install chromium`)
and run `bash scripts/ci/run-viewer-smoke.sh stars full` or
`bash scripts/ci/run-viewer-smoke.sh geographic full`.
For visual checks run `VR_SCENES=earth-moon,atmosphere-earth,cassini-soi
node scripts/visual-regression.mjs`. For all terrain fixtures use
`bash scripts/ci/run-terrain-fixtures.sh` on Ubuntu with GDAL/NumPy installed.
For the targeted surface job after package build and Chromium/GDAL installation,
run `npx vitest run --project scripts scripts/surface-build.test.mjs` and
`node scripts/surface-build/acceptance.mjs work/surface-build/skyfall-ci /usr/bin/python3`.
The fast gate runs that file separately with
`--testNamePattern '^finite locked surface build planning'` while excluding it
from the other Vitest invocation, so only its expensive GDAL cases move out of
the always-on job.

## Duration baseline and follow-up

Before this split, recent successful Build & Test jobs were 5.7 min (#270),
6.2 min (#283), 8.8 min (#275), and 12.8 min (#274), with geographic/browser
smoke accounting for 3.3–9.3 min (issue #288). The additional terrain job
used about 1.5–2.1 min of mostly parallel runner time.

After this PR runs on representative UI-only, shared-renderer, and terrain
changes, record warm **Fast PR CI**, targeted-job and nightly durations in
the PR/issue. Do not claim a performance win before those runs finish; investigate
any regression and preserve correctness coverage.
