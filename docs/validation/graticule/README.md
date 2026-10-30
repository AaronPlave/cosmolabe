# Graticule validation — PR #163

One browser entry point exercises the current loaded viewer. Regression tests retain caption starvation, fixed geographic attachment, occlusion, coordinate precision, material/fade/disposal lifecycle, opacity, and state round trips. No historical implementation is extracted or injected.

## Run

From the repository root:

```sh
npm run build
npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5188 --strictPort
# In another terminal:
node scripts/graticule-validation.mjs --scenario=globe,controls
node scripts/graticule-validation.mjs --scenario=lunar,precision,integration
node scripts/graticule-validation.mjs --scenario=globe,controls --dpr=2
```

`--scenario=all` runs all five scenarios; the default is `globe`. Use `--help` for URL, output and catalog filters. Terrain scenarios require the shipped catalog assets and kernels. Missing assets or failed assertions produce a failing exit status; they are not replaced with synthetic mission geometry. macOS uses installed Chrome/ANGLE Metal; other platforms use Playwright Chromium, or set `CHROMIUM_PATH`. The report records the actual GPU.

Captures and detailed metrics go to ignored `work/graticule/` by default. Use `--output=/tmp/...` or a CI artifact directory to keep separate runs. Attach selected images to the PR when needed. Earlier committed evidence remains in Git history.

| Scenario | Retained browser checks |
| --- | --- |
| `globe` | Actual triangle registration at five close/return altitudes; caption decimal precision; <0.2 CSS-pixel registration error; grid/caption pixels inside the rendered silhouette, allowing one physical pixel of antialiasing at DPR 1/2. |
| `lunar` | Apollo and Shackleton presets, optional border ticks, <=8 queries, <=0.2 CSS-pixel alignment; both polar axes over 45 frames; overview/oblique readability and fixed-site samples. |
| `controls` | Keyboard/pointer/touch opacity, 0% hiding, pixel readback on restoration/dimming, streamed material hooks, preference reload, snapshot replay, 390px containment. |
| `precision` | Reported Ingenuity camera/ET on real loaded Mars terrain; independent float-target GPU readback against canonical CPU coordinates on Mars, Moon and Earth, retaining the 2 cm numerical-error bound. This is shader arithmetic, not source accuracy. |
| `integration` | Earth/Moon/Mars catalogs, Curiosity local-site presets, shared annotation obstacles, short optical/roll motion, grid disable/restore, texture reuse, playback, and compact manual-spacing controls. Missing terrain fails the run. |

The old carrier/layout/optical/motion fixture assertions for fixed anchors, path/zoom restoration, free-look, below-datum planning, UI exclusions, tessellation, query budgets and lifecycle remain in the automated suites below. Historical baseline comparisons, draped prototypes and superseded single-carrier layout expectations are removed. Browser setup, module resolution, error handling and reporting are shared by the five scenarios rather than copied across executables.

```sh
npx vitest run --maxWorkers=1 \
  packages/three/src/__tests__/{AdaptiveGraticule,GraticuleFrame,GraticuleShader,RenderedSurfaceQuery,grid-free-look}.test.ts \
  packages/control/src/grid.test.ts \
  apps/viewer/src/lib/__tests__/viewer-control.test.ts
```

## Results and limits

Cleanup verification: **119 tests in seven suites pass**. All five consolidated scenarios pass on Apple M4 Max / ANGLE Metal, including actual Earth, Shackleton, Apollo, Ingenuity and Curiosity catalogs. Globe and desktop/390px touch opacity checks also pass at DPR 2. Captures and detailed results remain local under the ignored output directory. No product code, regression thresholds or budgets changed in this cleanup.

Keep the PR draft. Continuous visual review for repeated coordinate values/abrupt site replacement, sustained simultaneous **visible** Places + 3D event callout + measurements + probe + contours, and extended mixed-LOD/local-mesh transitions remain open. Short motion samples and enabled tools do not establish those acceptance items. Removing generated evidence does not complete them. Sparse output is valid where geometry, occlusion or congestion cannot certify safe captions; device timings are diagnostics, not performance guarantees.
