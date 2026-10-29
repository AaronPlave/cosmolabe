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

The first feedback pass simplified labels and moved metadata into inspector Details. The later focused UX pass below supersedes that presentation. Curiosity discovery windows use a faint band and edge accent instead of solid drive bars or dashed borders. Chooser and previous/next fit the selected activity; grouped density marks zoom into their time bin without selecting an arbitrary member or seeking.

[Final browser results](review-feedback.json) cover all three catalogs and the concurrent fixture on desktop and 390px, plus grouped zoom over 10,000 records. The geometry-event → activity regression verifies body highlight cleanup and unchanged clock/camera selection. Zero JavaScript/HTTP errors occurred. Navigation cancellations are recorded separately. The existing scientific/source and physical-device limitations still apply.

All 639 viewer tests, five importer/refresh tests, test/viewer TypeScript checks, Svelte (zero errors/warnings), focused ESLint and the production viewer build pass. The metadata refresher was run twice on the real catalogs with no diff. Regression fixtures cover activities first/middle/last and nested fields, preserving unrelated bytes and numeric spellings with idempotent output.


## Focused activity navigation UX pass

The current captures use one compact row with a capitalized vehicle/type heading, previous/next, a 180px-capped selected-name picker and an accessible Fit activity icon. The plotted lane carries no duplicate kind label, standalone search box or status row. Search is inside a visible picker menu with count, empty state and selected indication. The menu keeps its search field visible while results scroll. Arrow keys/Enter choose results; Escape closes the menu and preserves scene selection.

The inspector now shows UTC bounds, duration (unknown for bounded drive windows), a short authority/source indication and opt-in technical provenance. Opening Details no longer dumps the disclaimer or raw ET; Source and technical details is a second disclosure. Numeric ET remains available through records/API.

[Flight 44 search](flight-44-search.png), [390px search](flight-44-search-390.png), and [Flight 44 inspector with Details expanded](flight-44-details.png) demonstrate the specifically reviewed case. All other captures above are refreshed across the three real catalogs and concurrent fixture. See [UX interaction results](ux-polish.json) for browser scope and errors. Physical mobile input and other browser engines remain untested.

Current main (`330de2e8`, including the lunar frame work) was integrated after GitHub reported import/export conflicts. Both activity metadata and main's surface-frame validation are retained. The integration passed the package build, viewer TypeScript/Svelte checks, 641 viewer tests and 83 focused activity/catalog/lunar-frame/importer tests. The complete desktop/390px browser smoke passed again with zero JavaScript/HTTP errors; the current captures/results reflect this integrated tree.


## Single aligned activity lane

Desktop activity controls now occupy the left gutter of the same grid row as the plotted marks, aligned to the shared transport time axis. There is no separate activity toolbar row. Narrow desktop gutters wrap the heading over the navigation controls while preserving plot width; phones stack the navigation above full-width marks. Actual overlapping activities still determine plot row count.

The refreshed captures include [900px Ingenuity](ingenuity-900.png) and [1100px MoonFall](moonfall-1100.png), plus the existing desktop/390px and Flight 44 examples. [Alignment measurements](single-lane.json) cover all three real catalogs and the concurrent fixture at 1440, 1100 and 900px: plot left/width match the shared track within one pixel, controls remain inside the gutter, and row height is the maximum of controls/plot rather than their sum. The existing navigation/search/inspector and dense-bin browser checks also pass at 390px, with zero JavaScript/HTTP errors. 75 focused shell/panel/activity tests, Svelte (zero errors/warnings), focused ESLint and the production viewer build pass. This is a layout-only change; activity data and navigation semantics are unchanged.


## Final focused overlap, touch and disclosure follow-ups

Seven coincident activities now produce three individual marks plus an explicit four-member aggregate on the capped fourth row. That aggregate opens the exact member picker; the browser selects every overflow member. Nested intervals retain their full union rather than shortening the fourth-row occupancy. Unit regressions cover these small-list cases independently of the 10,000-record density test. See [overlap capture](overlap-desktop.png).

True Playwright touch emulation (390px, hasTouch/isMobile, no mouse hover) passes on Ingenuity and Curiosity: tap picker result, tap activity mark, no transient event callout or retained scene preview, inspector remains visible above transport, and Play/Pause respond to taps. The inspector ends 49px above the transport in both cases. See [Ingenuity touch](ingenuity-touch-390.png), [Curiosity touch](curiosity-touch-390.png) and [focused results](focused-followups.json). Physical device touch remains untested. Activity selection/touch clears transient previews, and activity hover callouts are suppressed while the activity inspector is present.

Activity Details now directly reveals full source limitations and identifiers/version strings; the nested technical disclosure is removed. The compact default summary and no-raw-ET UI remain. This supersedes the double-disclosure presentation described in earlier stages above.

104 focused activity/layout/gesture/control tests pass, along with viewer TypeScript/Svelte, focused ESLint and the production viewer build. The complete desktop/390px browser acceptance (all real catalogs, concurrent fixture, seven-overlap fixture and 10,000-record stress case) passes with zero JavaScript/HTTP errors, plus the touch cases above. Existing source and scientific-rendering acceptance limits remain.
