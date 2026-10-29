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
- `node scripts/test-mission-activities.mjs http://127.0.0.1:5193/ work/issue-293` exercises the actual app: hidden trajectories, picker, previous/next, source edge seek, lane click, selected state, window zoom, keyboard input, desktop/390px layout, compact transport, same-session catalog replacement, event/profile coexistence and the 10,000-record stress catalog. Records are served through native catalog loading. The test uses the repository's immutable hosted-data rewrite for missing local scene assets.
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
