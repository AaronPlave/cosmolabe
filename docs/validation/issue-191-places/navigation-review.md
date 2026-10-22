# Named target and navigation UX review

Addresses [review 6349039846](https://github.com/AaronPlave/cosmolabe/pull/274#issuecomment-6349039846) and [review 6348083645](https://github.com/AaronPlave/cosmolabe/pull/274#issuecomment-6348083645).

A named navigation action now adds the exact place reference/name to the existing shared surface-target presentation. The HUD uses the name, with resolved coordinates/conventions in its tooltip. Terrain refinement preserves it. Generic coordinates and actual picked-surface targets continue to display coordinates; the camera and resolver remain #270's implementation.

Active camera targets and informational selection are distinct. HUD × and the geographic Escape layer call the same release action: clear the active target association/highlight, release the pivot to the tracked body center, and preserve camera position/time/body tracking. An independent inspected place survives target release. Closing place information keeps an active target, indicated by the HUD. Escape retains existing modal, pointer-tool/probe/measurement priorities; focused text entry first blurs, then the ladder stops a flight, dismisses inspectors, then releases geographic context before broader camera reset. Scene unbinding clears the target.

There is one Navigate rail tool, with Places and Coordinates modes. Both use the same session view preset/range and common Fly/Jump components, default range and duration. The coordinate row displays and copies planetocentric latitude with hemisphere formatting. One collapsed Place details section contains source coordinates, provenance, taxonomy and an explicit suggested feature framing action. The body filter follows tracking until explicitly selected. The named HUD remains named during flight and after landing/refinement.

Display groups body/sensor/geographic names under Labels. Geographic names has a master toggle, By body, and Advanced / data sources. All chunks of each Gazetteer are grouped by shared provenance into one logical toggle with attribution and indexed feature count; mission/user sources retain their own identity. Hidden data stays searchable.

## Evidence

[Continuous browser recording](navigation/navigation.mp4) · [Acceptance results](navigation/results.json) · [Arena Colles named target](navigation/arena-named-target.png) · [Navigate desktop](navigation/navigate-desktop.png) / [390×844](navigation/navigate-compact.png) · [Coordinates desktop](navigation/coordinates-desktop.png) / [390×844](navigation/coordinates-compact.png) · [Display desktop](navigation/display-desktop.png) / [390×844](navigation/display-compact.png) · [Named target on real terrain](navigation/named-terrain.png).

Chrome/Metal on Apple M4 Max, 1440×900 desktop recording, with 390×844 compact viewport segments. The uninterrupted recording includes name double-click/Fly, immediate named flight HUD, target release, focused-search Escape, tracking-following and explicit body filters, grouped Gazetteer visibility, clipboard round trips for northern Jezero and southern Hellas, and actual camera eye/orientation comparisons across both tabs. Automatic overhead altitude, explicit oblique range and surface eye height are covered; both Fly and Jump land equivalently with matching body/preset/range. Places and Coordinates share button placement, emphasis, icons, form submission, validation and compact minimization. One collapsed Place details section is asserted by default. The named Shackleton target survived **six real terrain revisions**, and the final physical probe returned `terrain`.

The non-terrain acceptance sequence also passes locally on SwiftShader and remains a CI gate. Full Gazetteer browser workflow passes with no browser errors. All **41 viewer test files / 544 tests**, build, all type checks, Svelte (zero warnings), lint and production bundling pass. Production bundling retains the existing large-chunk advisory. Final exact-head CI is reported in the PR.

The previous run's Build & Test job passed, but terrain fixtures hit the job deadline while installing raster packages on the moving Ubuntu image. That fixture job is now pinned to Ubuntu 24.04, matching the browser job. This does not convert the cancelled run into a pass.

Reproduce with the viewer at port 5194:

```sh
CL_VIEWER_URL=http://127.0.0.1:5194/ CL_GPU=hardware CL_RECORD=1 CL_TERRAIN=1 node scripts/test-place-targets.mjs
```

Physical-phone and human acceptance remain unclaimed.

## Results list resizing

The unselected Places results fill the remaining panel height, with search and body controls held above their own scroll region. Up to 100 results are available instead of the previous 12. Selection switches to an internally scrolling inspector; Coordinates retains its usual panel-body scrolling.

Physical Chrome/Metal checks: real grip resizing from a 300×720 panel to a wider, shorter panel reduced the list from 527 to 167 px. Docked and compact list heights were 643 and 156 px. The list reached the panel's bottom padding in every layout, the dock/panel body did not scroll behind it, and selection details remained reachable in a short panel. Svelte checks (zero warnings), 70 shell/geometry tests and changed-component lint passed.

[Large panel](navigation/results-tall.png) · [Resized panel](navigation/results-short-wide.png) · [Compact](navigation/results-compact.png) · [Measured geometry](navigation/results-resize.json).

## List filters and keyboard focus

Places adds Type filtering using the same indexed feature classes as Cmd/K, displayed with readable category names. Mixed catalogs additionally expose Origin: official nomenclature or mission/user sites. Body, type, origin and name combine before the result cap; origin/type do not exclude otherwise matching items merely because they ranked below the first page. Type options follow body/origin and reset when unavailable. Filters are shown with the results rather than adding rows to selected-place details.

The content/list scroll regions reserve two pixels for the shared outside focus ring, preserving its rounded outline on all sides. Physical Chrome/Metal checks cover desktop and 390×844 focus, combined filters, empty results, origin separation, type reset, and existing navigation lifecycle checks with no browser errors. Seven core index regressions, build, Svelte (zero warnings) and changed-file lint pass.

[Focused desktop input and filters](navigation/places-filters-focus.png) · [Compact](navigation/places-filters-focus-compact.png) · [Acceptance](navigation/filter-results.json).

## Explicit ordering and indicative diameter

Sort exposes the existing Relevance order (tracked body, exact name, cartographic importance, then diameter) and explicit Name A–Z/Z–A and Diameter largest/smallest orders. Explicit sorts apply to all matching records before the 100-result cap, across bodies when All bodies is chosen. Unknown diameters follow known values in both diameter directions; equal sizes use stable alphabetical ties. These choices affect search results only, not label-renderer priority.

Result metadata displays source-reported indicative diameter in metres or kilometres, rounded to three significant digits, or “Diameter unknown.” The tooltip states that it does not define a feature boundary. Eight core index regressions, build, Svelte (zero warnings), changed-file lint and the physical Chrome/Metal acceptance workflow pass, including name/diameter ordering, unknown extent, combined filtering and compact layout.

[Desktop](navigation/places-sort.png) · [Compact](navigation/places-sort-compact.png) · [Acceptance](navigation/sort-results.json).

## Demo starts with geographic names enabled

The Places demo declares `defaultGeographicNames: ["Mars", "Moon"]`. The viewer applies this initial setting before binding Display state; reusable source catalogs and scenes without the declaration remain opt-in. A later entry-catalog declaration overrides required-catalog defaults. Display controls still change visibility normally, and reopening the demo restores its authored setting.

Physical Chrome/Metal verification confirmed visible labels without place selection, checked master/per-body controls, manual off, reload restoring both bodies, and the same imported data staying off when the declaration is absent. Build/all type checks, 98 catalog-schema/viewer-control tests and changed-file lint pass. [Initial Display state](navigation/demo-default-on.png) · [Acceptance](navigation/default-results.json).
