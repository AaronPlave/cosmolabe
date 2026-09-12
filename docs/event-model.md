# Geometry / event finder model

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

## The SPICE boundary

`GeometryFinderProvider` exposes `gfdist`, `gfsep`, `gfoclt`, and `gfposc`.
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
