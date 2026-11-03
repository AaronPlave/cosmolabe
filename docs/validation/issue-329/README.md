# Altitude and terrain-clearance validation (#329)

Event Finder's **Altitude / terrain clearance** event kind shares one bounded
numerical service with ViewerControl, scripts, embedding and Ask. Highest/Lowest
optimizes the selected radial sphere height, ellipsoid height or physical terrain
clearance; Closest Approach instead minimizes center-to-center distance.

## Reproduce

Start the viewer from this checkout and verify the listening process owns it.
Use a physical GPU for browser acceptance; no external model/provider is needed.
The MoonFall and Ingenuity catalogs require their pinned local terrain products.
The scripts fail on missing data rather than substitute authored heights.

```sh
npm run build
npm run typecheck
npm run lint
npx vitest run packages/control/src apps/viewer/src/lib/__tests__/trajectory-analysis.test.ts apps/viewer/src/lib/__tests__/event-query.test.ts scripts/ask-capability-contract.test.mjs
node scripts/test-trajectory-extrema-visual.mjs http://127.0.0.1:5198/ work/issue-329/moonfall
node scripts/test-ingenuity-extrema-visual.mjs http://127.0.0.1:5198/ work/issue-329/ingenuity
```

For just asynchronous readiness, append `--readiness-only` to the Ingenuity
command. It holds the real CPU manifest, opens Event Finder with AGL selected,
then releases metadata and requires Search to enable without changing the form.
Full scripts generate detailed JSON receipts and screenshots in the output
directory; these are transient outputs, not committed reference fixtures.

## Acceptance coverage

- Native form: explicit metric/datum choice; availability reasons; independent
  time window, mission kind and selected-activity restrictions; empty scopes.
- Single/all-object searches: highest/lowest ordering, shared API results,
  partial/cancel behavior, source/activity/kernel invalidation and view-link replay.
- Standard result selection: epoch, actual object/activity, tracked object,
  paused playback, timeline readiness and explicit camera framing.
- Modern scripts/Ask: capability discovery, shared query execution, measured
  result identity and state verification through result-to-visualization tools.
- Desktop and 390px layouts: independent measurement/calculation disclosures,
  enclosing selected outline, partial warning, internal panel scrolling and
  external-selection reveal without scrolling the dock.
- Real Ingenuity Flight 12: physical CPU terrain query, matching source/frame/
  datum/revisions, activity/epoch navigation and reconstruction notes.

## Reviewed science record

| Fact | Verified value |
| --- | --- |
| Synthetic MoonFall candidate | Polaris-D, Long traverse to Sverdrup, 310.909149287 m |
| Real-data example | Ingenuity Flight 12, `ingenuity:flight:12` |
| Sampled clearance candidate | 10.087050759310046 m |
| Epoch | 2021-08-16T12:54:31.810Z; ET 682390540.9944946 |
| Frame | IAU_MARS, shared by terrain and resolved body-fixed trajectory |
| Datum | Ellipsoid radii 3396.19 × 3396.19 × 3376.2 km; geodetic-normal heights |
| CPU/geometry revision | `cube-fused-e7a6cf73d237-g2-m15-b66ee59ba` |
| Product identity | `3846907d293e9e5d0b0243cefc2ed446335e6624772cf6194930ac3c70c24395` |
| Coverage | Sampled-complete for this flight; not whole-mission certification |
| Method | 24,753 evaluations; step 0.08461034297943115 s; refinement 0.005 s |
| Trajectory classification | Unknown; estimated flight reconstruction, not 3D telemetry |
| Source uncertainty / global height error | Both unknown; separate quantities |

Pinned metadata SHA-256: CPU grids
`9a104638aa9f6adc74b8af7d8bf736514e702a76d088ff90d7a590d9138fc4cf`;
geometry tileset
`e796dab0256ce7fa80e0f4de8a26b7f650bb4bc50da1cc7e261eedf33735f90e`.

## Limits and validation results

Candidates are sampled and locally refined, not certified global extrema.
Missing finest CPU terrain stays unavailable; AGL never falls back to a reference
surface. Partial searches cannot establish an overall winner. Ingenuity horizontal
paths derive from NASA/MMGIS observations; altitude/interior timing are modeled,
and absolute frame, height and clock accuracy remain uncertain. Other intervals
may have missing trajectory or terrain coverage.

Loaded acceptance passed on physical Apple M4 Max / Chrome Metal with no page
errors. The exact vehicle-epoch marker glyph can be opacity-hidden; timeline
readiness is verified separately, without claiming visible marker pixels.
Against main `ef0f9563`, 273 targeted regressions, build, lint and all
typechecks pass. Native/modern MoonFall, delayed Ingenuity readiness and loading
layout browser checks pass. Exact final-head CI is tracked on the PR. A local full-viewer inventory assertion can fail when five
ignored experimental catalogs are present; CI uses the tracked catalog inventory.
Local extrema/threshold expansion remains separate in #338.

## Representative captures

[Native form and candidates](trajectory-form.png) ·
[Expanded selected result](trajectory-expanded-single.png) ·
[Real Flight 12 and sources](ingenuity-flight12.png) ·
[Expanded Flight 12 at 390px](ingenuity-flight12-compact.png)
