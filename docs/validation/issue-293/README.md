# Mission activity validation (#293)

Validated 2026-10-29 in the native viewer on an isolated local Vite server (5193). Source/provenance and importer policy: [mission-activities.md](../../mission-activities.md).

## Scope and sources

- All 72 Ingenuity flight records match original index event epochs exactly, including flights 1, 71 and 72. No paths, estimated 3D samples, terrain, frames, viewpoint definitions or trajectory event epochs changed (deep comparison against the base catalog).
- MoonFall supplies 12 explicitly authored named demo hops and 12 instantaneous landings across four vehicles. Its original generator says these are **not the mission's plan**; no operational schedule was established. Labels and timing come from the existing authored sortie definitions, not arbitrary curve segmentation.
- Curiosity supplies two NASA-reported genuine drives with bounded discovery windows and unknown actual operational timestamps/durations. The wider windows accommodate the source dates' unspecified timezone. Poses never infer human-named operations.
- Concurrent fixture includes overlapping aircraft flight and rover drive, plus manual descent/landing without any associated trajectory or scene object.

## Checks

- All 638 native viewer tests passed (50 files); focused core/catalog/control/importer tests passed (179 tests), including malformed-calendar and importer parity regressions.
- Package build, viewer production build, test/viewer TypeScript checks, Svelte checks (zero errors/warnings), focused ESLint, and `git diff --check` passed.
- `node scripts/test-mission-activities.mjs http://127.0.0.1:5193/ work/issue-293` exercises the actual app: hidden trajectories, picker, previous/next, source edge seek, lane click, selected state, window zoom, keyboard input, desktop/390px layout, compact transport, same-session catalog replacement, event/profile coexistence and the 10,000-record stress catalog. Records are served through native catalog loading. The current test uses Vite's native local-first fallback for missing managed files, without browser URL rewriting.
- At 390px every catalog has document width 390, no document scroll, and one compact activity chooser. Expanded multi-vehicle rows scroll inside the lane region; its mobile maximum is 30vh.
- Performance samples use 120 animation frames with playback enabled. The activity model and UI bound dense mark/option counts. Frame measurements and GPU identity are summarized below; raw output remains under ignored `work/issue-293/`.

## Captures

- [Ingenuity desktop](ingenuity-desktop.png) and [390px](ingenuity-390.png).
- [MoonFall compact 390px](moonfall-compact-390.png).
- [Curiosity bounded drive window 390px](curiosity-390.png).
- [Concurrent flight/drive/manual-descent fixture with event/profile lanes](concurrent-desktop.png).

## Limits

The browser run logged failed hosted terrain/imagery requests (cross-origin asset failures); it deliberately proves activity independence when those scene assets are unavailable. These screenshots and frame measurements are timeline acceptance, **not new terrain, imagery, localization or full mission-rendering verification**. No application JavaScript errors occurred. Physical touch, Safari, Firefox and mobile GPU performance were not tested. Curiosity's exact drive epochs and actual MoonFall operational activities remain source limitations, exposed in the records and viewer.

## Measured browser run

- GPU: ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version); context antialias: true.
- Four-record baseline: mean 18.54 ms, p95 17.60 ms.
- 10,000 records: mean 16.61 ms, p95 17.70 ms; 168 visible activity marks, 2 chooser options after search.
- Failed asset requests: 48; JavaScript errors: 0.

## Native local-first data loading follow-up

The Vite fallback now prefers existing files and proxies missing managed files from their registry-pinned deployed build, on the same local origin. The reported Ingenuity CPU-grid URL at `http://localhost:5173/test-catalogs/data/ingenuity-cube/terrain-3846907d293e9e5d0b0243ce/cpu-grids.json` returned 200 for GET and HEAD, with valid JSON whose SHA-256 matches the existing copy in the main checkout. No catalogs are rewritten in the browser smoke test anymore.

An isolated-cache Vite server on port 5194 passed the complete desktop/390px mission-activity smoke across all three mission catalogs, the concurrent fixture, and 10,000 records. See [native fallback results](native-fallback.json): zero JavaScript errors, zero HTTP errors; aborted tile requests during navigation are recorded separately. This supersedes the initial asset-unavailability limitation above for this interaction smoke, while preserving the stated scientific/source and device limits. A 504 from a shared Vite dependency cache was isolated; two transient upstream 502s led to a tested, single bounded retry for CDN/socket failures. Real 404s and persistent errors remain visible.

The 41 data-hosting tests include actual Vite GET/HEAD routing and local-file precedence, custom base paths, remote pin selection, gzip/binary/range streaming, credential exclusion, local-only mode, real upstream 404s, and bounded transient-error recovery. Viewer TypeScript/Svelte checks, config lint and the production viewer build passed.


## PR feedback follow-up

The captures above now show the simplified navigation surface: short activity/date labels, a single status, and complete activity times/provenance/source/limitations/ET in inspector Details. Curiosity discovery windows use a faint band and edge accent instead of solid drive bars or dashed borders. Chooser and previous/next fit the selected activity; grouped density marks zoom into their time bin without selecting an arbitrary member or seeking.

[Final browser results](review-feedback.json) cover all three catalogs and the concurrent fixture on desktop and 390px, plus grouped zoom over 10,000 records. The geometry-event → activity regression verifies body highlight cleanup and unchanged clock/camera selection. Zero JavaScript/HTTP errors occurred. Navigation cancellations are recorded separately. The existing scientific/source and physical-device limitations still apply.

All 639 viewer tests, five importer/refresh tests, test/viewer TypeScript checks, Svelte (zero errors/warnings), focused ESLint and the production viewer build pass. The metadata refresher was run twice on the real catalogs with no diff. Regression fixtures cover activities first/middle/last and nested fields, preserving unrelated bytes and numeric spellings with idempotent output.
