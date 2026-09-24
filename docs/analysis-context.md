# Analysis context and configured items

Cosmolabe's analysis surfaces share one concrete context rather than keeping
their own observer/target selections, time windows, or playheads. The portable
model lives in `packages/core/src/geometry/analysis.ts`; the viewer's reactive
adapter lives in `apps/viewer/src/lib/analysis.svelte.ts`.

## Analysis context

`AnalysisContext` is a snapshot containing:

- bodies by semantic role (`observer`, `target`, `front`, `back`, and so on);
- the default reference frame and SPICE aberration correction;
- the analysis time window and current simulation time;
- derived scalar geometry quantities at known epochs; and
- geometry event results.

The viewer builds this snapshot with `analysisContext()`. Its time and window
come directly from viewer state, so the timeline, event finder, measurement
surfaces, and 3D presentation consume the same playhead and span. Core does not
own reactive state and does not depend on Svelte.

## Configured analysis items

`ConfiguredAnalysisItem` is a discriminated union with two deliberately
different members:

- `ConfiguredEventQuery` describes a discrete/interval search and resolves to
  the existing `EventQuery` calculation boundary.
- `ConfiguredContinuousProfile` describes a quantity to sample as a time
  series. It is not an event and does not manufacture event results.

Every item has a stable `id`, a label, `enabled` calculation state, and
`visible` presentation state. Those flags belong to the item rather than a
timeline lane, allowing multiple timeline and explorer consumers to use the
same configuration. Result `queryId` values use the configured item ID; result
IDs remain identities only within one execution.

Bodies, windows, frame, and aberration correction may be omitted from a
configured item. `resolveEventQuery()` and `resolveContinuousProfile()` apply
the active context defaults. Item values win role by role, so two items can
compare different targets while inheriting the same observer, or can replace
the relationship and time window entirely. This is the intended entry point
for eclipse/occultation work in #58 and profile sampling/rendering in #65.

## Viewer integration

The event finder creates one configured query and updates it in place as its
form changes. Running the finder resolves that item through the current context
and stores results under its stable ID. The timeline reads
`visibleTimelineEvents()`, which includes results only for event-query items
that are both enabled and visible. Disabling or hiding one item does not alter
any other event or profile configuration.

Scene changes clear configured items and their derived data because their body
names, kernel coverage, and epochs belong to the previous catalog. Display and
analysis features can add items through `createConfiguredEventQuery()` or
`createConfiguredProfile()` without adding another global observer/target pair.

## Event lanes on the timeline

The collapsed timeline shows every visible event result merged into one strip
of marks on the transport track. Expanding it adds one lane per enabled
`event-query` item (`components/shell/EventLane.svelte`), above the profile
rows and on the same axis. A lane's eye toggle flips the item's shared
`visible` flag, so the track, the event finder and the lane agree; hidden lanes
stay listed, dimmed, so they can be shown again. Clicking a mark calls the same
`selectEvent` the track's marks use. The lane's readout names the event under
the ghost playhead or the playhead, or else counts the results.

## Continuous profiles on the timeline

Profiles render as rows in the timeline's expanded depth
(`components/shell/ProfileLanes.svelte`, one `ProfileRow.svelte` per item), in
the order of the `continuous-profile` items in `analysis.items`. There is no
built-in set: each row names its own `quantity` — `range`, `relative-speed`,
`range-rate` or `phase-angle` to start with (`lib/profile-sampling.ts`) — and
may pin any role or leave it to inherit the shared relationship. Rows are
added, configured, hidden, reordered and removed from a popover on the row
label (`updateConfiguredProfile()`, `setConfiguredItemVisible()`,
`moveConfiguredProfile()`, `removeConfiguredItem()`).

## Timeline presentation and interaction

Every analysis row — event lane or profile — has its identity in one
left-aligned header column (shared `tl-*` styles in `app.css`): the name,
then a unit for profiles (`Distance · km`), then the relationship in quieter
text, with expand / hide controls at the column's right edge on hover. On a
phone the header is overlaid at the plot's top-left.

Compact profile rows carry no axis chrome. The expand toggle gives a row
about 110 px and three faint gridlines with values (`gridValues`). The
analysis region's height is the content's by default; the dock's top edge is a
resize handle (capped at 60 % of the viewport, double-click toggles a large
height and back), kept in `timeline.laneHeight`.

Gestures on the rows (`timelineGestures`) give each surface one job: the
transport track scrubs; on the rows a click seeks, a background drag pans the
view, and a drag that starts on the playhead — a thin line with a ~10 px grab
target — scrubs. A sideways or Shift wheel pans anywhere; a plain wheel zooms
about the pointer. Hovering an event on the track, a lane or a profile tick —
snapped to an edge, or anywhere inside an interval — previews it
(`timeline.previewEventId`, an `eventKey` that includes the query) and shows a
callout with the same copy as the scene's event callouts
(`eventCalloutLines`). The range popover offers Fit results, Fit selected and
Fit mission; jumping the playhead (`setTime`) keeps the zoom.


reads the same zoomed window (`vs.scrubMin`/`scrubMax`), playhead (`vs.et`)
and ghost playhead (`timeline.hoverEt` in `lib/timeline.svelte.ts`) as the
track. Rows hold no time state, and share their gestures with the event lanes
(`timelineGestures`): hover previews an instant everywhere on the
axis without moving time, a click seeks, a drag pans the shared window, and the
wheel zooms it about the pointer; a sideways or Shift wheel pans, on the track
too. Dragging the transport track still scrubs — the track is the playhead's,
the rows are for navigating the axis. On touch, a horizontal drag on a row
pans, a vertical one scrolls the lane region, and a tap seeks. Visible event results are drawn faintly on each row,
and a hover snaps subtly to an event edge and cross-highlights that event on
the track, so a closest approach visibly sits on the distance minimum.

Sampling is a display sampling of `Universe.absolutePositionOf` across the
visible window, about one sample per two pixels, and is unrelated to any
geometry-finder step. It needs no SPICE kernels, so profiles work on Keplerian,
TLE and sampled-trajectory catalogs. Readouts are computed exactly at the
hovered or current instant rather than read off the nearest sample.
