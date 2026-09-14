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
