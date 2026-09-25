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

The collapsed timeline's transport track is an overview of every visible
event result: each configured query gets a sub-band a few pixels tall, so
overlapping results from different queries do not share pixels, and selected
or previewed results rise to full height. Past three families the overview
becomes a density instead. Expanding the timeline adds one lane per enabled
`event-query` item (`components/shell/EventLane.svelte`), above the profile
rows and on the same axis. A lane's eye toggle flips the item's shared
`visible` flag, so the track, the event finder and the lane agree; hidden lanes
stay listed, dimmed, so they can be shown again. Clicking a mark calls the same
`selectEvent` the track's marks use. The lane's readout is compact state at
the inspected instant: how many of its events are active (`activeEventsAtTime`),
or one active event's duration, or else the result count. It never shows an
event's name; the hover callout does that.

Several events can be active at once, and all of them are: the track, the lanes
and the event list mark every event the playhead is inside. Selection is
stronger than activity, and preview is temporary. `activeEventAtTime` (singular)
only picks one where only one fits, such as the scene's single explanatory
overlay.

Events speak one visual vocabulary on every surface: shape carries
temporality (an instant is a line, an interval a span), and colour carries kind
and occultation state (`data-ev-kind` / `data-ev-state` → `--ev` in `app.css`).
That includes the events drawn faintly behind profile traces. There, a
profile shows by default only the events between its own two bodies. A
selected or previewed event appears on every profile, so a profile never turns
into a barcode of every family.

A configured category is removed with `removeConfiguredQuery(id)`: from the
Event Finder's category list, or from the lane's hover controls. Removing a
category drops its item and cached results, which also removes its lane. It
clears a selection or preview of one of its results. If the category was being
edited, the form moves to a neighbouring category, or to a fresh search when
none is left. Categories are reordered among themselves with
`moveConfiguredEventQuery(id, delta)`, using the ↑ ↓ buttons on hover in the
category list; interleaved profile items keep their places. Category order is
lane order, overview band order and list order. On the timeline, a default
label's kind name is shortened ("Range", "Occultation"); the Event Finder keeps
the explicit names.

A selected result has a × that clears the selection without re-seeking.
Clicking the row again still re-focuses the event. Escape clears an event
selection before it closes any panel.

## Continuous profiles on the timeline

Profiles render as rows in the timeline's expanded depth
(`components/shell/ProfileLanes.svelte`, one `ProfileRow.svelte` per item), in
the order of the enabled `continuous-profile` items in `analysis.items`.
Disabled items are not drawn; hidden ones stay listed, dimmed, with their eye
toggle. There is no built-in set: each row names its own `quantity` — `range`,
`relative-speed`, `range-rate` or `phase-angle` to start with
(`lib/profile-sampling.ts`) — and may pin any role or leave it to inherit the
shared relationship. A small "Profiles +" section header, which stays in view
while the region scrolls, adds rows. The popover on a row's label configures,
hides, moves or removes it (`updateConfiguredProfile()`,
`setConfiguredItemVisible()`, `moveConfiguredProfile()`, `removeConfiguredItem()`).

## Timeline presentation and interaction

On a desktop the expanded timeline is one three-column grid:

- **Label gutter:** what the row is.
- **Shared time axis:** how it varies.
- **Readout rail:** its value at the inspected time.

The transport lays itself out on the same columns. Its controls sit over the
gutter, the track is the axis column, and the clock heads the rail. The rows'
columns are the track's measured extent (`--tl-gutter`, `--tl-axis`), so every
row lines up with the track. A label reads `Distance · Earth → Mars`; units
belong to the values and scale labels, not the label. Rail values are
right-aligned under the clock in tabular mono, and switch to the ghost's value,
marked as a preview, while hovering. Readouts use the `--text-readout` token
(12 px); only the clock is sized up (13 px). Timeline text uses three type
roles only:
primary (`.tl-primary`), secondary (`.tl-secondary`) and numeric (`.tl-num`).
On a phone the axis takes the full width and labels overlay the plots.

Event lanes are compact. A profile row has exactly two modes, set only by its
own expand toggle (`profileRowHeight`): normal (about 46 px, trace and value)
and expanded (about 116 px, with three labelled gridlines). How many profiles
exist never changes how a row is presented.

The analysis region's height has three states, remembered for the session
per layout:

- **Automatic (default):** it fits its rows up to about 38 % of the viewport,
  then scrolls.
- **Fit to content:** double-click the dock's top edge. The region is
  content-sized, capped only at the scene-preserving 58 % of the viewport, and
  keeps fitting as rows are added or removed.
- **Manual:** drag the top edge.

Collapse and expand are a small tab centred on the dock's top edge; the rest of
that edge is the resize grip. A phone keeps a full-size button instead.
Collapsed, the dock is a dense overview. It has less padding, a taller event
strip, and no bound labels, so the axis gets the width. Expanded, the window's
bounds and span sit in a caption under the track, for example
`2030-10-14 · Full mission · 3.6 yr ▾ · 2034-05-29`, and the clock is one
line at the head of the rail.

The dock is one interaction plane (`timelineSurface` in `lib/timeline.svelte.ts`),
not a set of per-row handlers. The pointer belongs to the shared axis, so the
same hovered instant (`timeline.hoverEt`) holds while the pointer moves from
the track down through the lanes, and the wheel zooms about the pointer
anywhere over the axis. The row under the pointer (`timeline.hoverRow`) is
tracked separately. It only changes local emphasis (the inspected row's trace,
value dot and a small value tip) and which events a hover snaps to. The dock
draws one ghost line and one playhead through every row. A playhead outside
the zoomed window is not drawn anywhere, rather than pinned to an edge.

Cursor state comes from the surface as `data-tl-cursor` on the dock
(`playhead`, `scrub`, `pan`). Every plot reads it, so it overrides the plots'
own crosshair.

Each surface has one job:

- **Transport track:** scrubs.
- **Analysis plots:** a click seeks, and a background drag pans the view.
- **Playhead:** a drag that starts on it scrubs. It is a thin line with a
  ~14 px grab target.
- **Wheel:** a sideways or Shift wheel pans; a plain wheel zooms.
- **Minimap under the track:** a neutral viewport that can be dragged to pan
  while zoomed.
- **Touch:** a horizontal drag pans, a vertical one scrolls the lane region,
  and a tap seeks.

Hover previews and click selects, on every surface:

- **Timeline hover:** hovering an event on the track, a lane or a profile span
  previews it (`timeline.previewEventId`, an `eventKey` that includes the
  query), whether snapped to an edge or anywhere inside an interval. It shows a
  callout with the scene callouts' copy (`eventCalloutLines`) and previews the
  event in the scene through `previewEvent`.
- **Previews from elsewhere:** a preview started in the Event Finder's list or
  in the scene highlights the timeline's marks. It also puts the ghost on the
  event (`timeline.linkedEt`), so the profiles read out there.

The range control offers Fit results, Fit selected and Fit mission. Jumping the
playhead (`setTime`) keeps the zoom.

Sampling is a display sampling of `Universe.absolutePositionOf` across the
visible window, about one sample per pixel (capped at 1600), and is unrelated to any
geometry-finder step. It needs no SPICE kernels, so profiles work on Keplerian,
TLE and sampled-trajectory catalogs. Readouts are computed exactly at the
hovered or current instant rather than read off the nearest sample. The
cursor's dot is placed by interpolating the drawn series
(`seriesValueAt`), so it always sits on the visible line, even where the
display sampling smooths a fast oscillation.
