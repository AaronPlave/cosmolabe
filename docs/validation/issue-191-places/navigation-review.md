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


## Complete browsing and compact search controls

Removed the 100-result browsing cap through an explicit `limit: 'all'` index query while preserving numeric palette limits. All matches sort before incremental DOM rendering. The UI shows the match total and rendered count; scrolling appends rows and Show more supports keyboard browsing. Type, Origin and Sort live in one collapsed disclosure that persists through selection, including a summary of active options and an explanation of relevance. Body remains next to search. Navigate's initial desktop docked height is 50dvh; floating resize rectangles and compact sheet sizing remain authoritative. Expanded filter contents retain a minimum usable results viewport and scroll inside the panel.

Full workspace typecheck (including Svelte, zero warnings), 133 focused place-index/viewer-control/shell/geometry tests, all 41 viewer files / 544 tests, and changed-file lint pass. Physical Chrome/Metal verified totals, scrolling beyond 100, reaching and selecting the final alphabetically sorted Moon record, and retaining filter visibility through selection. The initial docked panel measured 450×288 px in a 1440×900 viewport, with a 218 px results region and dock scrollTop zero. Compact checks at 390×844 pass.


## Final review follow-up: scene gestures, disabled sources and search latency

Addresses [review 6353969283](https://github.com/AaronPlave/cosmolabe/pull/274#issuecomment-6353969283) and the two remaining edge cases from [review 6353025658](https://github.com/AaronPlave/cosmolabe/pull/274#issuecomment-6353025658).

Viewport geographic-label double-click now explicitly requests automatic Overhead framing, independently of retained form settings. It never changes the user's preset/range text. Explicit Navigate Fly/Jump still validates and uses shared Places/Coordinates settings. Browser acceptance uses actual label double-clicks after Surface/100m, invalid text and another-body manual range, compares the final camera eye/orientation against direct automatic Overhead coordinates, and checks that form settings remain unchanged. Existing three-preset Fly/Jump parity checks pass.

Geographic names displays **No name sources enabled** whenever all indexed logical sources are disabled. The status is independent of the master body checkbox; turning the master off/on preserves the hidden source choices. Browser checks cover all-hidden, mixed source states, body-off, restoring all four Moon Gazetteer chunks through one logical toggle, and scene replacement. No raw chunk controls were added.

Search uses one reused Intl.Collator for case-insensitive natural name ordering, deterministic reference ties and equal-diameter ties. Empty-query relevance avoids repeated normalization of names that cannot equal the empty query. Existing unknown-diameter-last semantics in both directions remain tested. Measurements use the shipped 11,139-place catalog in Chrome/Metal on Apple M4 Max: 10 warm-ups and 40 timed calls per case, full matches requested with `limit: 'all'`, p95 from sorted timings. Measured p95 spans 0.1–5.5 ms: all-body name ascending 4.8 ms, descending 5.3 ms, diameter descending 4.1 ms, ascending 4.5 ms, relevance 5.5 ms, Moon craters by name 0.8 ms, prefix query 0.1 ms. These measure synchronous index query/filter/sort time, not network or end-to-end rendering.

Evidence: [workflow acceptance](review-followup/results.json), [search latency](review-followup/search-latency.json), [GPU](review-followup/gpu.json), [layout](review-followup/layout.json), [uninterrupted workflow recording](review-followup/workflow.webm), [desktop search](review-followup/places-filters-focus.png), [compact search](review-followup/places-filters-focus-compact.png), [expanded filters](review-followup/places-filters-expanded.png), [disabled-source status](review-followup/display-no-sources.png), [selected-place desktop](review-followup/navigate-desktop.png) / [compact](review-followup/navigate-compact.png).

Slow zoom/reversals and contested-name handoffs were rerun at full 240/180/20-frame sampling for Mars and Moon, with no browser errors or churn/overlap assertion failures: [motion metrics](review-followup/motion-metrics.json), [uninterrupted motion recording](review-followup/label-motion.webm), [Mars](review-followup/mars-global.png) / [Moon](review-followup/moon-global.png). Physical-phone and human acceptance remain unclaimed.


CI run [39964410616](https://github.com/AaronPlave/cosmolabe/actions/runs/39964410616) at `a40b407` hit both job deadlines. Terrain never reached fixture tests: the Ubuntu raster mirror was still downloading libgdal at ten minutes. Build & Test passed 221 files / 2,637 tests, 11 converter regressions, the preceding geographic/planetary/label-motion gates, and full Moon browsing before its fifteen-minute cancellation cut off the remaining UI checks. Job budgets are now 20 minutes for terrain setup/fixtures and 25 minutes for cold browser setup plus all software-rendered gates. Assertions and sampling remain unchanged. This records a cancelled run, not a CI pass.


## Focused inspector and mission adoption review

Addresses [review 6366677754](https://github.com/AaronPlave/cosmolabe/pull/274#issuecomment-6366677754). Later UI sections supersede the earlier browse-above-inspector captures.

Browse and inspection are separate views within the existing Navigate panel. Selecting from the scene, Cmd-K or a results row hides browsing controls and opens the compact inspector. Back restores the same query, filters, sort and scroll position; informational clear remains independent of the active target. Browse has one flexible results scroller, with filters in a portaled popover. Inspection has one content scroller and a separate fixed action footer. Range controls expose Auto and approximate Fit feature alongside custom input; source-copy and framing controls have explicit pointer/focus/hover affordances.

Physical Chrome/Metal verified docked, 288px floating panels at 340 and 720px heights, and 390×844 compact sheets. Fly/Jump remains within the panel with expanded details; instrument body and Places outer scrollTop remain zero. Existing full Moon browsing, keyboard, shared camera parity and safe viewport double-click acceptance pass after adapting to focused inspection. [Inspector workflow results](inspector-missions/inspector-results.json), [navigation results](inspector-missions/navigation-results.json), [continuous practical recording](inspector-missions/inspector-flow.webm), [short inspector](inspector-missions/inspect-340.png), [tall inspector](inspector-missions/inspect-720.png), [compact inspector](inspector-missions/inspect-compact.png), [browse filters](inspector-missions/browse-filters.png), [compact browse](inspector-missions/browse-compact.png).

Source inclusion is separate from label visibility and shared by Cmd-K/Places through one search policy. Disabled sources cannot be selected/navigated or contribute drawing/picking. The UI pass covers hidden-only names remaining searchable, disabled/re-enabled Moon sources (all four chunks), independent same-body sources, unchanged camera on target release, and actual geographic catalog removeCatalog/replaceCatalog events rebuilding the index. Scene replacement remains covered by navigation acceptance. [Source controls](inspector-missions/source-inclusion.png). Focused core/vector/viewer tests cover filtering before caps, rendering inclusion preserving prior visibility, stale selection/target reconciliation, and mission catalog composition.

All six shipped mission catalogs were loaded directly, with their existing assets/trajectories and no substituted scene. Each exposes only its target body's Gazetteer, enables those names, finds an official feature and navigates it. Mission anchors are separate mission/user records with source details: MoonFall base/PSR landing are fictional; Apollo 15 uses NASA NSSDCA coordinates with no precision/accuracy claim; Dingo Gap reuses the existing scene overlay's approximate anchor; Ingenuity reuses vendored MMGIS airfield coordinates and omits areoid height from geodetic placement. Place navigation converts imported-datum geodetic coordinates to planetocentric before resolving against the actual scene shape.

[Mission results](inspector-missions/mission-results.json) and [continuous scene recording](inspector-missions/mission-scenes.webm) record exact surface status rather than assuming terrain readiness implies a physical sample. MoonFall and LRO reported terrain-backed targets; Apollo reported its terrain datum; MSL and Ingenuity used explicit reference-shape fallback during this pass. Jezero imagery is a reference-shape scene. Geographic import failures and browser errors were empty across all six. Observed label node counts were 0–6 at the captured regional views; MoonFall's 20km polar/night view contains terrain streaking and no ordinary labels, so artifact-free polar terrain rendering is not claimed by this integration pass. Repeating the same direct coordinate navigation against the original `f66508b` MoonFall catalog (zero Places records, no new geographic requires) reproduced the same streaking with the same terrain target/camera: [baseline screenshot](inspector-missions/moonfall-before-places.png), [baseline state](inspector-missions/moonfall-before-places-results.json). This is an existing terrain/rendering limitation, not introduced by the catalog composition.

Mission captures: [MoonFall](inspector-missions/moonfall-shackleton.png), [LRO](inspector-missions/lro-moon.png), [Apollo 15](inspector-missions/moon-imagery-apollo15.png), [MSL/Dingo Gap](inspector-missions/msl-dingo-gap.png), [Ingenuity](inspector-missions/ingenuity-jezero.png), [Jezero imagery](inspector-missions/mars-imagery-jezero.png).

Local validation: full workspace typecheck and Svelte (zero errors/warnings), all 41 viewer files / 545 tests, 31 core/vector tests, changed-file lint, and production viewer bundle pass. The existing bundle-size advisory remains. CI follow-up is intentionally outside this pass at the user's request; no final-head CI success is claimed.


## Terrain label anchoring and close-range review

Rechecked the top-level discussion and inline review threads: the latest review remains [6366677754](https://github.com/AaronPlave/cosmolabe/pull/274#issuecomment-6366677754), whose browse/inspect, source eligibility, framing and mission adoption work is recorded above. The additional user report concerns floating labels and loss of names near the ground.

Sakarya Vallis reproduces the cause in the actual Ingenuity scene's global Mars terrain: its unsupported areoid datum left labels on the source ellipsoid, **2.372 km above the rendered terrain** at this point. [Original diagnostics](terrain-labels/original-reference-diagnostics.json) identify the reference-shape fallback. Reference-position horizon/frustum checks could also discard a name before its terrain position was considered, especially with a camera inside the reference ellipsoid.

Heightless names now re-seat on the visible rendered surface through the existing probe/pin raycast path. This is explicitly a `rendered-surface` presentation anchor, not a physical areoid-to-ellipsoid conversion. Source coordinates, provenance, explicit source heights, physical navigation and terrain geometry are unchanged. Supported CPU samples/reference-shape fallback remain available without a rendered hit. Near-terrain admission uses a conservative relief envelope and resolves the surface point before close frustum checks. Projection follows the last completed anchor; bounded scheduling refreshes it as terrain changes. A warm regional cache avoids repeatedly raycasting offscreen provisional points. Ridge occlusion remains an immediate rejection.

`CL_GPU=hardware CL_RECORD=1 node scripts/test-place-label-terrain.mjs` passes cold ordinary-label admission and picking at 20 km, 1 km, 100 m and 20 m above the rendered point, plus a 100 m-high / 500 m-across oblique view. Selection and named targets are cleared so these checks do not depend on selection priority. The label stays visible below the source ellipsoid, and the probe's independent screen hit agrees with the label's anchor within the test's 10 m bound. This checks agreement with scene geometry, not scientific terrain or Gazetteer accuracy; these Gale/Sakarya captures use global terrain outside the scene's native Jezero imagery patch.

[Results and GPU identity](terrain-labels/results.json), [20 km](terrain-labels/sakarya-20km.png), [1 km](terrain-labels/sakarya-1km.png), [100 m](terrain-labels/sakarya-0.1km.png), [20 m](terrain-labels/sakarya-0.02km.png), [oblique](terrain-labels/sakarya-0.1km-oblique.png), [continuous recording](terrain-labels/terrain-labels.webm). Chrome reports ANGLE Metal / Apple M4 Max. The five 120-frame checks averaged about 16.7 ms per frame; label CPU p95 was 2.4–2.7 ms, including scheduled terrain work. The 2 ms scheduler permits one query to complete even if that query exceeds its budget.

Local validation: all **50 renderer test files / 505 tests** pass, including cold close-basin projection, retained-anchor refinement, ridge occlusion, explicit source-height preservation and unsupported-datum fallback. Full workspace typecheck/Svelte and changed-file lint pass. Existing Mars/Moon motion acceptance also passes at its explicit smoke sampling (90 orbit frames, 60 sweep frames, 6 FOV steps): [motion results](terrain-labels/mars-moon-motion.json). No browser errors were reported. CI remains outside this follow-up at the user's request.
