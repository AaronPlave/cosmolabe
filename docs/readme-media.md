# Reproducing README media

The README shows the ordinary Svelte/Three.js viewer, including its UI. These
are promotional images, separate from `apps/viewer/test-screenshots/__goldens__`.
Never add `?test=1`: it disables effects and changes trajectory caching. No
models, positions, terrain heights, lighting or UI were fabricated for these
captures. Natural lighting is used throughout.

## Local prerequisites

From the repository root, install Node.js 20+, Git LFS and npm dependencies,
then retrieve the mission assets:

```sh
git lfs pull
npm install
bash scripts/fetch-kernels.sh
bash scripts/fetch-europa-clipper-kernels.sh
bash scripts/fetch-cassini-kernels.sh
bash scripts/fetch-lro-kernels.sh
npx playwright install chromium
```

The mission catalogs also need the LFS-managed spacecraft models, DDS maps and
lunar JPEGs under `apps/viewer/test-catalogs/`. Fetch scripts obtain ignored
kernels that a clone/LFS pull alone does not provide. The base Earth–Moon tour
uses the generic kernels and textures.

LRO streams lunar quantized-mesh terrain from `marshub.s3.amazonaws.com` and
WAC imagery from NASA Trek; both must be reachable. Mars requires the generated
`apps/viewer/test-catalogs/data/mars-terrain-fused/` directory. It is ignored by
git, not LFS-managed. Build it with the documented public DEM sources (GDAL
Python bindings and NumPy required):

```sh
(cd scripts/build-mars-terrain && bash 01-fetch-sources.sh && bash fused.sh)
node scripts/validate-terrain.mjs --preset mars-jezero-fused
```

See the [Mars build guide](../scripts/build-mars-terrain/README.md) for disk/RAM
requirements and datum conventions. An existing pyramid from another checkout
can instead be copied into the same relative directory, including `layer.json`,
`terrain-product.json`, `fusion.json` and the numbered tile directories. The
captures do not require publishing a dataset or credentials. The 2026-10-14
capture rebuilt the 711,467-tile pyramid from existing public-source DEMs and the
`--bias none` fused residual using the standard `fused.sh` tiling arguments.

Hosted catalogs use a separate deployment rewrite to published R2 datasets;
local source catalogs still use local relative paths. Do not assume the hosted
Mars dataset exists: check the pinned build in
[`datasets.json`](../scripts/data-hosting/datasets.json). See [data hosting](data-hosting.md).

## Capture

Start a dedicated dev server (the capture script imports the viewer's development
modules to set analysis/panel state):

```sh
npm --prefix apps/viewer run dev -- --host 127.0.0.1 --port 5199 --strictPort
```

In another terminal, from the repository root:

```sh
node scripts/capture-readme-media.mjs
# Or just one scene:
node scripts/capture-readme-media.mjs events
# Inspect candidate output without overwriting the published selection:
CL_CAPTURE_DIR=/tmp/cosmolabe-readme node scripts/capture-readme-media.mjs mars
```

`CL_VIEWER_URL` overrides the local dev URL, `CHROMIUM_PATH` selects a browser,
and `CL_ANGLE` selects its GPU backend (defaults to Metal on macOS and GL
elsewhere). Use a working hardware WebGL backend; SwiftShader is useful for
diagnostics but is not the published capture configuration.

The script uses a fresh browser page for every scene, 1920×1080 CSS pixels,
device scale 1, ordinary rendering and full-viewport Playwright screenshots.
JPEG quality 90 keeps scenes small; PNG preserves analysis UI text. It waits for
initial assets, visible terrain and empty terrain queues, then drains actual
imagery/network requests and waits for fonts and finite UI animations. A short
network-quiescence condition follows the final completed request; it is not a
fixed sleep after opening the catalog. Failed assets, tile requests, page errors
or HTTP errors stop capture instead of producing a new promotional image.
Inspect the result visually too: queue completion cannot prove good composition.

The adjacent `mission-*.capture.json` records ET, the resolved camera pose,
ViewerControl snapshot, asset outcomes and terrain metrics. Those summaries are
evidence of that run, not fixed performance targets. The authoritative recipes
are [`readme-captures.json`](readme-captures.json); the script adds no application
features or general screenshot framework.

## Selected scenes

All catalogs resolve under `test-catalogs/`. Numeric ET is seconds past J2000;
UTC is supplied for human navigation. Camera coordinates are km, in ECLIPJ2000
relative to the tracked body, except the tour's explicitly Moon-body-fixed pose.
Position/target/up/FOV triples are recorded exactly in the recipe and capture
sidecars. Playback is paused; grid, axes and sensor labels are off. Labels identify
only the primary participants. Panels use their normal default dock positions.

| Output | Catalog / entry | UTC | View and analysis |
| --- | --- | --- | --- |
| `mission-clipper.jpg` | `europa-clipper` | 2031-03-07 03:39:51.823 | Track/select Europa Clipper, close camera, one EIS NAC FOV; trajectories off. Europa and Jupiter remain in view. |
| `mission-lro.jpg` | `lro-moon` | 2025-01-15 00:21:00 | Track/select LRO above the lunar horizon; streamed terrain/imagery, no sensors or trails. |
| `mission-cassini.jpg` | `cassini-soi` | 2004-07-01 02:48:00 | Track Saturn, select Cassini; one Cassini trail, sensors off; ring shadows use natural lighting. |
| `mission-mars.jpg` | `ingenuity-jezero` | 2021-07-05 09:00:08 | Track Ingenuity with a close local-up camera over Jezero; experimental terrain/model positioning; no sensors or trails. |
| `mission-events.png` | `cassini-soi` | 2004-07-01 02:38:22.467 | Cassini → Saturn closest approach, 00:00–12:00 UTC search, 60 s step, default `NONE` aberration correction. Select the sole closest-approach result; also search distance below 100,000 and 150,000 km over the same window. Event Finder left dock; expanded six-hour timeline (00:00–06:00 UTC) with distance and range-rate plots. |
| `mission-measurements.png` | `cassini-soi` | 2004-07-01 02:38:22.467 | One entity-to-entity Cassini–Saturn distance; Measurements right dock and selected 3D readout. No body info panel. |
| `mission-tour.png` | `earth-moon-tour` | 2015-10-31 23:50:00 | Script panel shows an executed stationary excerpt of the catalog tour; body-fixed pose from its source, with playback paused. |

The Cassini closest-approach result is about **20,541.8 km altitude** above the
reference ellipsoid and approximately **80,246 km center distance**; the measurement readout
rounds the center distance to **80,246 km**. They describe different quantities.
The event search is recomputed from kernels, not inserted as a fake result. An
instant closest approach appears as a timeline marker, rather than an eclipse
interval. The selected marker is at the spacecraft on its trajectory. Two additional
`distance-range` searches produce interval lanes (approximately 1.6 and 3.5 hours)
for center distance below 100,000 and 150,000 km. Expanded distance and range-rate
profiles share the axis and event shading; their curves are sampled from the real
universe states, not drawn into the screenshot. The 310 px analysis region fits
all three lanes and both plots. The camera is untracked after event selection,
retaining Saturn as its coordinate origin, so its downward-offset aim keeps the
ring system clear of the timeline. Search definitions and recomputed results are
also recorded in the capture sidecar.

For the Mars recipe, a transient catalog variant omits only the optional
`astro.arcgis.com` CTX imagery layer, which failed requests during the original
capture. The remaining Viking, Jezero CTX and HiRISE layers come from the catalog's
NASA Trek URLs. Playwright fulfills the catalog JSON with that explicit layer
subset; all other data and the real renderer are unchanged. To reproduce manually,
save a sibling copy of `ingenuity-jezero.json`, remove that imagery entry and open
it in the viewer. Do not replace failed imagery with concept art or hide a failed
request in the capture report. Terrain/imagery service changes may require
revisiting this choice.

For manual composition, use the public `window.cosmo` ViewerControl binding for
time, tracking, frame, pose and layers. Open Events/Measurements through the rail,
set the parameters above, select the result/measurement, and expand/zoom the
timeline. The script uses the existing viewer state modules for these analysis
and shell settings because they are not all part of ViewerControl. A copied view
link carries searches/measurements but not panel arrangement or individual sensor
visibility. See [view state](view-state.md) and [scripting](scripting.md).

The primary gallery uses the scripted tour in place of the proposed Mars hero
composition. The Mars capture is delivered as supplementary experimental media:
its NASA grayscale imagery still has soft foreground detail at this viewpoint,
so it should not stand in for a finished terrain marketing image. Recheck it
after the imagery/depth work in #184, #186 and #189; no renderer changes were
made to improve promotional captures.

## Video decision and future replacement

The previous README video was downloaded and inspected across its full
20.167-second sequence: H.264, 1280×734, approximately 3.8 MB. It starts with
Clipper and sensor geometry over Europa, tracks/pulls away, then ends in a wide
view with dense trajectories. It is an authentic sensor/tracking example, so it
is retained as a labeled supplementary link rather than the first-screen hero.
The new first-screen event image explains the current mission-analysis workflow
and remains visible without autoplay or a video player. The Clipper gallery image
is a static fallback for the same subject.

A future replacement should record **the entire browser viewport**, not the
built-in WebGL-only VideoRecordPlugin. Reuse the `events` recipe, start with the
clean Saturn composition, open the prepared Event Finder, select closest approach,
scrub the six-hour timeline through the distance windows and closest-approach marker, then finish at the selected event.
Keep this to 12–15 seconds and retain `mission-events.png` as its poster. Encode
H.264/yuv420p MP4 with `-movflags +faststart`, keep the heavy video outside git,
and upload it to GitHub user attachments. Link the resulting CDN URL with a
caption describing those actions. Verify playback on GitHub; do not claim an
unuploaded local clip is published. The current link avoids relying on raw HTML
video/autoplay support in GitHub's README sanitizer.

## Review before publishing

Check every local README link/image, image dimensions and alt text. Review the
GitHub-rendered Markdown at desktop and narrow widths; the primary scenes are
full width so text is not reduced to half-width table thumbnails. Check the demo
and video links. On the published branch, confirm GitHub serves all new images
and the supplementary video link. Keep terrain capture acceptance separate from
in-flight renderer work (#184, #186, #189); recheck these images when that work
lands. No unfinished graticule, reference-geometry or Rosetta functionality is
advertised here.

## Validation recorded on 2026-10-14

- Base: `main` at `c312857`; application, renderer and test sources were unchanged.
- All seven recipes completed in ordinary Chromium rendering on ANGLE Metal
  (Apple M4 Max). Initial assets and terrain tiles reported zero failures;
  the capture driver rejected page/network errors. Mars used the declared NASA
  imagery subset.
- All 51 README link targets and six guide links were checked; local targets
  exist. The hosted demo returned HTTP 200 and the existing video downloaded
  successfully for review.
- GitHub's document Markdown API rendered the README; the local markup preview
  at 1440 px and 390 px had no broken images or page overflow. This verifies the
  markup and assets, not publication: a final check of the branch on github.com
  remains necessary after push.
- Package build, repository lint, capture-script syntax and `git diff --check`
  passed. The full suite reported 1,778 passing tests, seven skipped and one
  existing failure in `packages/cspice-wasm/src/gf-reporting.test.ts`:
  “keeps the first pass inside the first half while it runs”. That test assumes
  a four-day search exceeds CSPICE's 100 ms report throttle; the search completed
  before a mid-pass callback occurred. The test and its implementation match
  `main`; they were not changed as part of this documentation/media issue.
