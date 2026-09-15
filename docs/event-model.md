# Geometry / event finder model

Event queries can be used directly by calculation-only consumers. Viewer
surfaces that need durable identity, enable/visibility state, or shared context
wrap them as configured analysis items; see [Analysis context and configured
items](./analysis-context.md).

Every geometry search in Cosmolabe — closest approach, range thresholds,
occultations, eclipses, FOV access, phase angle, latitude crossings — is
expressed as one **query** type and answered with one **event** type. Adding a
new kind of search is a bounded change: a kind definition, and nothing else.
It does not bring its own results list, timeline overlay, selection plumbing,
or 3D wiring.

The model lives in `@cosmolabe/core` under `src/geometry/events/` and is
re-exported from the package root.

## The pieces

| Piece | Responsibility |
| --- | --- |
| `EventQuery` | What to search for: kind, bodies by role, time window, step, aberration correction, kind-specific `params`. |
| `GeometryEvent` | What was found: an `InstantEvent` or an `IntervalEvent`, carrying the bodies involved, a label, and display `metrics`. |
| `EventKind` | How one kind of search maps its roles and params onto GF calls and events. The only per-kind code. |
| `closestApproachKind`, `distanceRangeKind`, `occultationKind` | The kinds that ship today, over `gfdist` and `gfoclt`. |
| `EventKindRegistry` | The set of searches the application offers. Drives the "what can I search for?" picker. |
| `EventSearch` | Validates, applies kind defaults, dispatches, sorts, and converts thrown errors into structured faults. |
| `GeometryFinderProvider` | The boundary to SPICE GF. Above it is Cosmolabe's; below it is CSPICE's. |
| `focus.ts` | Turns a selected event into simulation time + bodies to identify, plus the timeline's span/culling predicates. |

## Instants and intervals

`GeometryEvent` is a discriminated union on `temporality`. A closest approach
is an instant; an occultation is an interval. Code that does not care about the
difference uses the accessors rather than branching:

```ts
eventStart(event); eventEnd(event); eventDuration(event); eventMidpoint(event);
compareEvents(a, b);   // chronological, handles a mixed list
```

## Roles, not positional bodies

Bodies are assigned to shared **roles** — `observer`, `target`, `front`,
`back`, `center`, `illuminator`, `secondary` — rather than to per-kind field
names. A kind declares the roles it consumes and how to label them:

```ts
roles: [
  { role: 'observer', label: 'Observer' },
  { role: 'front',    label: 'Occulting body' },
  { role: 'back',     label: 'Occulted body' },
]
```

A UI that can render a picker for a role list can configure *any* kind, which
is what keeps the configuration UI from going event-type-specific. Roles may be
optional (`required: false`) and may carry a `default`.

`EVENT_ROLES` fixes the canonical order of the roles, and is the single source
of truth for both the `EventRole` union and anything role-ordered — notably
`eventBodies`, whose output drives 3D highlighting. Ordering by a participant
object's own key order would make highlighting depend on how that object
happened to be built.

## Params, declared the same way

Roles cover *which bodies*; `EventKind.params` covers everything else a kind
needs — a threshold, a relation, a scope — declared as `EventParamSpec`s rather
than left as an opaque bag:

```ts
params: [
  { kind: 'choice', key: 'relation', label: 'Condition', default: '<',
    options: [{ value: '<', label: 'Closer than' }, { value: '>', label: 'Farther than' }] },
  { kind: 'number', key: 'distanceKm', label: 'Distance', unit: 'km', default: 1_000_000 },
]
```

That is what lets one configuration form drive every kind: a UI that renders a
body picker per role and one input per param can configure a kind it has never
heard of, which is the same bargain the role list makes. `EventSearch` fills in
the declared defaults before `run` and before the kind's own `validate`, so a
query that carries no params at all still runs the kind's intended search, and
adding a parameter does not invalidate queries written before it existed.
`defaultParams(kind)` is the same set, for seeding a form.

Values themselves are still the kind's business: `validate` is where a
threshold is checked for sign and a relation for membership.

A kind also carries a one-sentence `description`, for the same reason: "distance
/ range" does not explain itself from its label, and a UI cannot write the
sentence for a kind it has never heard of.

Which body a user *means* by "this event" is also a property of the kind, not
of the model — an occultation is about the occulted body, an access window
about the observer. A kind declares that once as `primaryRole`, and
`EventSearch` stamps it onto every event the kind returns that does not name
its own. `focusForEvent` only falls back to a built-in role preference for
events where neither said.

## Faults vs. no results

"We looked and found nothing" and "we could not look" are different answers and
callers should show them differently:

```ts
const result = await search.run(query);
if (!result.ok)          showFault(result.fault);       // invalid-window, missing-body, provider-error…
else if (!result.events.length) showEmptyState(query);  // the search ran; nothing matched
```

`EventSearch` applies the shared checks — known kind, required roles filled, a
finite forward window, a finite positive step — so a kind's own `validate` only
handles its `params`. `missing-body` faults carry the `role`, so a picker can
point at the offending field.

The step check is deliberately weak. A GF step is a sampling step, not a span
the confinement window has to contain: GF samples the window's endpoints, so a
step longer than the window still resolves a condition that changes across it,
coarsely. Rejecting those would block legitimate searches over short analysis
windows. A kind whose geometry needs a tighter step enforces that in its own
`validate`.

What the step does govern is *completeness*, not validity: an event that both
begins and ends between two samples is missed, so a step below the duration of
the briefest event of interest is how you avoid missing events. That is a
choice the caller makes, not a constraint the model enforces.

## Timeline and 3D integration

Selecting an event always does the same two things: move simulation time, and
make the bodies involved identifiable in the 3D view. That is expressed as pure
functions over the model, so `@cosmolabe/core` stays UI-free:

```ts
const focus = focusForEvent(event, 'start');  // 'start' | 'end' | 'middle'
applyEventFocus(focus, {
  setTime: (et) => viewerState.setTime(et),
  selectBody: (name) => viewerState.selectBody(name),
  highlightBodies: (names) => /* … */,
});
```

`focusForEvent` resolves the `primary` body to select from the event's
`primaryRole`, and hands intervals back their full span so a timeline can frame
the event rather than merely seeking to it. `EventFocusTarget`'s optional
members mean a host with no highlight channel still gets time and selection
sync.

For drawing, `eventTimelineSpan(event, minWidth)` widens instants and very
brief intervals so they stay clickable at a coarse zoom, `eventOverlaps` is the
culling predicate, and `eventNearest` answers "what is happening now?".

The viewer draws interval results as selectable spans on that shared axis. A
selected solar eclipse uses the renderer's existing analytical eclipse-shadow
system for surface lighting and adds an explanatory observer sightline plus
spherical-body umbra/penumbra tangent boundaries. GFOCLT remains authoritative
for the event and its ellipsoid-based classification; the overlay is exact for
spheres and an explanatory approximation for oblate bodies. A non-solar
occultation draws the foreground body's observer-relative apparent tangent cone
instead of incorrectly presenting the alignment as a physical shadow. The
volumes use translucent surfaces, smooth boundary rings, and sparse tangent
guides; they remain to scale, so the penumbra can legitimately sit almost on
the umbra when the observer is close to an occulter far from the Sun. This is
selected-event geometry, not a persistent shadow-display mode: the selection
remains intact when the user scrubs elsewhere, but its overlay is visible only
while the playhead is inside that event's interval. Enabled cached occultation
results also become the active overlay automatically when playback or scrubbing
enters their interval. Selection remains navigation/detail state and only
breaks ties if active intervals overlap; it is not a visibility gate.

For a non-solar occultation, the tangent construction begins at the observer
because apparent size is viewpoint-dependent. Only the guide rays occupy the
observer-to-foreground span; the shaded occulted region begins at the
foreground body's exact tangency ring and continues toward the hidden
background body. Umbra and penumbra colors describe those physical regions and
do not change with the selected event's partial/full/annular classification.

## The SPICE boundary

`GeometryFinderProvider` exposes `gfdist`, `gfsep`, `gfoclt`, `gfposc`, and one
optional non-GF member, `range`.
Kinds compose these; they never reimplement the geometry. The signatures mirror
CSPICE's `gf*_c` routines, so a synchronous `Spice` instance satisfies the
interface structurally with no adapter. The worker-backed
`@cosmolabe/cspice-wasm` engine answers asynchronously and takes scalar bounds
instead of a confinement window, so it is bridged:

```ts
const provider = cspiceWasmGeometryFinder(engine);
```

That bridge searches each confinement window independently, so adjacent
intervals are not coalesced the way native GF window arithmetic would.

`range` is the exception to "GF only", and it exists because GF answers *when* a
condition held and never *how far*: the distance at a closest approach — the
number the result is actually about — is one `spkpos` away and nowhere in a
`gf*` result. Providers that can do that lookup expose it; kinds annotate their
events with it when present and omit the metric when absent, so a provider
without it still searches. `cspiceWasmGeometryFinder` wires it up when the
engine offers `spkpos`, and the viewer's adapter measures it with SPICE's own
`vnorm`.

## Where a search runs

CSPICE's GF routines are synchronous, and a fine step over a long window is
genuinely expensive — so a search on the main thread freezes the viewer for as
long as it runs: no camera, no scrubbing, not even a spinner. The viewer
therefore runs its searches in the SPICE worker it already keeps for trajectory
caches (`SpiceCacheWorker.geometrySearch()`), whose instance has the catalog's
kernels furnished, so a search pays for no loading of its own.

```ts
const search = cacheWorker.geometrySearch();
const result = await new EventSearch({ registry, provider: search.provider }).run(query);
search.cancel();  // rejects everything still pending or yet to be called
```

The provider passes its arguments through untouched to the same heritage
adapter over the same kernels, so the worker path's results are the main-thread
path's results — the choice is about where the time is spent. Where there is no
worker (test mode, kernel-free catalogs) the viewer falls back to the
main-thread provider, which is the same code path it always was.

`cancel()` is what makes a long search survivable rather than merely
non-freezing: a superseded or cancelled search stops making calls instead of
running to completion and having its answer discarded. A CSPICE call already
under way is not interrupted — the worker is single-threaded and CSPICE is
synchronous, so there is no point at which it could be — but the calls after it
do not run, and the viewer is not waiting on it either way. Calls rejected this
way throw `GeometrySearchCancelled`, which is how a caller tells "you stopped
this" from "this failed"; `EventSearch` reports it as a `provider-error` fault,
so a cancelling caller checks its own flag rather than showing that fault.

Worker kernels are the one way the two paths can diverge: the viewer furnishes
SPK, LSK and text PCK into the worker, which is what the shipped kinds' `gfdist`
searches read. A kind that needs attitude, frame or instrument kernels has to
widen that set (`WORKER_KERNEL_EXTS` in the viewer's loader) or it will find
nothing off-thread that the main thread would have found.

## The kinds that ship

Three kinds ship. Closest approach and distance/range use `gfdist` with
`observer`/`target`; eclipse/occultation uses `gfoclt` with
`observer`/`front`/`back`:

| Kind | Yields | Params |
| --- | --- | --- |
| `closest-approach` | Instants — GF's own `LOCMIN`/`ABSMIN` distance extrema, refined by CSPICE rather than sampled in the UI. | `scope` (every local minimum, or the deepest), `maxRangeKm` (optional filter). |
| `distance-range` | Intervals for `<`/`>`, instants for `=`. | `relation`, `distanceKm`. |
| `occultation` | Classified partial, full, and annular intervals from `GFOCLT`; using the Sun as `back` gives eclipse/shadow windows. | `state` (all classified states, or one state). |

A closest approach carries the range at the instant. A range window carries its
threshold, its duration, and the extreme range *inside* it — the endpoints sit
on the threshold by construction, so the interesting number is how close it got
(or how far it went), found with one nested extremum search. All three distance
metrics need the provider's `range`; without it the events still list.

FOV access, phase angle, and latitude/longitude crossings are further rows in
that table, not further subsystems.

## Adding a kind

```ts
const closestApproach: EventKind<{ /* … */ }> = {
  kind: 'closest-approach',
  label: 'Closest approach',
  temporality: 'instant',
  roles: [
    { role: 'observer', label: 'Observer' },
    { role: 'target', label: 'Target' },
  ],
  defaultStep: 3600,
  defaultAbcorr: 'NONE',
  primaryRole: 'target',
  validate: (query) => /* params only */ undefined,
  run: async (query, ctx) => {
    // query.step / query.abcorr / query.bodies already have defaults applied.
    const windows = await ctx.provider.gfdist(/* … */);
    return windows.map((w) => ({ id: ctx.nextEventId(), /* … */ }));
  },
};

registry.register(closestApproach);
```

`run` receives a `ResolvedEventQuery` — defaults already applied — and mints
ids through `ctx.nextEventId()`. Those ids are positional and unique within one
result set; the same query run twice mints the same ids, so treat them as an
address within a result rather than an identity for the event across searches.
Throw to fail; `EventSearch` wraps it as a `provider-error` fault.

Set `primaryRole` on the kind when one role is what its events are "about", so
selection does not fall back to a guess.

## Relationship to `EventFinder`

`geometry/EventFinder.ts` predates this model: a thin, synchronous wrapper that
returns bare `TimeWindow[]` with no body, label, or metric information, and one
method per event type. It still works and is still exported. New searches
should be `EventKind`s instead, so they inherit the list, timeline, selection,
and fault handling rather than each growing their own.
