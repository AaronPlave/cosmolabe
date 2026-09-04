# Visual regression (Layer 4)

Headless screenshot regression for the viewer. Catches **render-only** bugs the
numeric test layers (in `packages/core/src/__tests__/`) can't see — ring-plane
tilt, triaxial-ellipsoid (oblateness) scaling, texture/material orientation.

The numeric layers (SPICE oracle, golden fingerprints, invariants) are the
primary regression net and run in plain `vitest`. This visual layer is the
belt-and-suspenders for the GPU pipeline and runs separately because it needs a
browser + a built viewer + the scene's SPICE kernels.

**Not run in CI**, deliberately: it needs a browser, a full package + viewer
build (~4 min), and the scenes' LFS-backed kernels. So this gate carries exactly
the authority of whoever last ran it by hand — say so when citing it in a PR.

## How it works

`scripts/visual-regression.mjs` builds the packages and the viewer, then drives
the build in headless Chromium (software WebGL via SwiftShader, for
cross-machine determinism). It loads each scene with `?catalog=<name>&test=1`.
The `?test=1` flag (see `apps/viewer/src/lib/loader.ts`) strips GPU-variant
noise — antialias, bloom, starfield — pauses the clock at the catalog's
`defaultTime`, and installs `window.__cosmolabe`, whose `capture(viewpoint)`
renders one synchronous frame and returns a PNG. Frames are pixel-diffed
(`pixelmatch`) against the goldens in `__goldens__/`.

### The build is part of the run

Don't skip it. A production viewer build resolves `@cosmolabe/*` to each
package's `dist/` — the `exports` map only points at `src` under the
`development` condition — so a stale `packages/<pkg>/dist` makes this gate
photograph library code that is not the code under test, silently. That is how
the two `cassini-soi` goldens came to encode a frame no version of this codebase
produces (see below). `vitest` does not share the hazard; it resolves `src`.

The viewer is also built with `VITE_BASE` cleared, so its asset paths are
root-relative and match the `vite preview` the script spawns. A Pages build
(`VITE_BASE=/cosmolabe/`) hard-codes `/cosmolabe/assets/...`, which preview
answers with the SPA fallback — a `200 text/html` where the browser wanted a
module script — and the app never boots. The script detects both that and a
plain 404 on the entry script, and fails in under a second naming the URL,
rather than after a two-minute ready timeout.

### Ink and power

Every capture reports the fraction of the frame that is drawn on at all ("ink").
These scenes are mostly empty space, and a fraction-of-frame diff budget means
nothing without it:

| golden | ink | share of ink the 0.5% budget represents |
|---|---|---|
| `cassini-soi--SOI_2004-07-01_` | 10.68% | 4.7% |
| `cassini-soi--Ring_Plane_View` | 4.02% | 12.4% |
| `earth-moon--Earth_Close` | 3.16% | 15.8% |
| `oem-ingest` | 2.55% | 19.6% |

Two checks come out of that number:

- A golden with **less ink than the budget cannot fail**, and that is reported as
  a failure in its own right rather than a pass. The original `earth-moon.png`
  was 99.86% black: 0.14% ink against a 0.5% budget, so it had been passing
  since it was added without testing anything.
- A large **ink gap between golden and actual** means the two frames don't
  contain the same amount of scene, which points at the capture (unfilled
  trajectory caches, a failed fetch, a stale `packages/<pkg>/dist`) rather than
  at moved geometry. The failure message says so.

Capture-to-capture noise is currently **0.000%** on all four scenes on one
machine — `?test=1` pauses the clock, so there is nothing left to drift. The
0.5% default budget is headroom for a different machine's SwiftShader, not for
scene noise.

## One-time setup

```sh
npm --prefix apps/viewer i           # picks up playwright / pixelmatch / pngjs devDeps
npx playwright install chromium
```

The scenes fetch their SPICE kernels at load time (some large + LFS-backed) —
ensure `git lfs pull` has run.

## Run the check

```sh
npm --prefix apps/viewer run test:visual
```

On failure it writes `<scene>-actual.png` and `<scene>-diff.png` next to this
README for inspection. Against an already-running server, set
`CL_VIEWER_URL=http://localhost:5173` (which also skips the build — see above).

## Generate / update goldens

Rewriting an existing golden and creating a new one are separate flags on
purpose. A run that silently created whatever golden was missing meant a renamed
scene or viewpoint self-baselined: the new picture became the truth with no diff
and no warning.

```sh
npm --prefix apps/viewer run test:visual:update            # rewrite existing goldens
CREATE_VISUAL_GOLDENS=1 npm --prefix apps/viewer run test:visual   # add a new scene's golden
```

Review the resulting `__goldens__/*.png` before committing, and account for the
move in the commit message: name the epoch or geometry that changed, and name
something in the frame that must **not** have moved as the check that it is a
real change and not a blanket blessing.

A viewpoint name the catalog does not define now throws out of `capture()`
instead of photographing whatever the camera was already pointing at.

## Tunables (env)

| var | default | meaning |
|-----|---------|---------|
| `VR_THRESHOLD` | `0.1` | pixelmatch per-pixel color threshold |
| `VR_MAX_DIFF` | `0.005` | max fraction of differing pixels before failing |
| `VR_SETTLE_MS` | `6000` | wait after scene-ready for async textures/tiles to stream |
| `VR_INK_LEVEL` | `24` | luminance (0-255) above which a pixel counts as drawn |
| `VR_SKIP_BUILD` | — | `1` trusts the existing build; fast iteration only |
| `UPDATE_VISUAL_GOLDENS` | — | `1` rewrites goldens that already exist |
| `CREATE_VISUAL_GOLDENS` | — | `1` writes goldens that do not exist yet |
| `CL_VIEWER_URL` | — | use a running server instead of building + spawning `vite preview` |

Goldens are committed PNGs; `-actual`/`-diff` artifacts are not (see
`.gitignore`).
