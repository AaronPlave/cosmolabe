# Shareable viewer state (v1)

Choose **Copy view link** in the tool rail to copy the current catalog, epoch,
view, selection/tracking, field of view, playback rate/state, and reference layer
toggles. The same link includes configured Event Finder queries, the current draft,
and the selected event when present. Copy only writes to the clipboard; it leaves
the browser address and history untouched. Opening a shared link restores its
snapshot, including on reload or Back/Forward navigation. Playback, scrubbing,
and camera gestures do not create history entries. A catalog navigation clears the previous view
payload. A catalog-only history entry restores that catalog's default view.

The URL uses the existing `catalog` or configured-source `entry` protocol, plus
a `view` query parameter containing percent-encoded JSON. Source parameters are
preserved so source-backed entries can resolve in a new session. Uploaded local
files have no portable catalog identity and cannot be shared this way. There is
no upload or bookmark service. A link does not bundle catalogs, kernels, or files.

`ViewStateV1` lives in `@cosmolabe/control`. Its explicit `version: 1` describes:

- `catalog`: `{catalog: path}` or `{entry: "source/id"}` using catalog navigation.
- `time`: `{kind: "fixed", source: "ET", et: secondsPastJ2000}`,
  `{kind: "preserve"}`, or `{kind: "system", source: "UTC"}`. Copy always uses
  fixed ET, avoiding lossy calendar conversion. Preserve leaves the receiving
  simulation clock alone; system resolves the current UTC time through the host.
- `view`: a catalog-owned named viewpoint and FOV, when the camera actually
  matches it, or the existing control port's `ScriptCamera` pose. Pose fallback
  includes its own version, `ECLIPJ2000` axes, km units, and an explicit floating
  origin entity (null means the universe origin). The floating origin is separate
  from tracking: untracking retains the origin in this renderer.
- `navigation`: selected, tracked, and look-at entity names, plus camera mode.
- `playback`: playing and numeric rate, including paused and reverse playback.
- `display`: only trajectories, labels, grid, axes, sensors, and sensorLabels.

Restoration waits for catalog assets, validates entity/view/frame references, and
calls the same typed control methods used by the UI and scripts. An unavailable
catalog/source/entity/viewpoint or invalid payload shows an explanatory alert,
including on the home screen. Unsupported versions and coordinate frames fail
explicitly. Unknown additive fields are ignored and stripped when re-encoded.
The decoder does not interpret scripts, execute code, or restore plugin/UI stores.
Links are capped at 8 KiB, including URL overhead when copied.

## Camera and navigation scope

V1 composes catalog viewpoints (semantic viewpoints, #114) and the
`ViewerControl` navigation methods instead of defining replacement camera or
navigation models. Copy supports free orbit, body-fixed, and spacecraft-fixed
orbit cameras. Named-view detection excludes session-only saved viewpoints and
compares actual eye/up and coordinate origin, plus the target or, for a
viewpoint with `lookAt`, the look-at body, so moving away from a preset
produces an explicit pose link.

A catalog viewpoint is a relationship resolved where it is shown: at its own
`time` when it has one, and at the current time otherwise. Copy resolves it at
the link's time to compare, and restore applies a named view after seeking to
the link's time, so a timeless view such as "over Jezero" reproduces the pose
the sender saw. A viewpoint's own epoch still yields to the link's explicit
time. (Before #114, named views resolved once at catalog load; a link to a
timeless body-relative view may restore differently from what that older
viewer showed.)

#114 also provides a portable semantic form (`viewpointToJson` /
`validateViewpoint` in `@cosmolabe/core`) for views that are not in the
catalog, such as a Top / Sun / Velocity preset. V1 does not encode it yet;
adding it is an additive `view` kind beside `named` and `pose`.

Surface, surface-explorer, instrument, LVLH, and chase modes have additional
private parameters that the current port cannot capture faithfully. Copy rejects
those modes with a visible explanation. Semantic surface/instrument relationships,
alternate surface identity, and compact analysis queries can be composed here
when those underlying APIs are portable. The protocol must be extended or
versioned when camera semantics change; coordinates must never be reinterpreted
silently. V1 has no earlier protocol to migrate. When v2 is introduced, retain
the frozen v1 fixture and add an explicit migration or unsupported-version error.

## Event Finder context

The optional viewer-owned `events` extension has its own `version: 1`. It uses
core's `EventQuery` definitions and the same event-kind registry/parameter
validation as Event Finder. It includes all configured event searches, enabled
and timeline-visible flags, the current query/draft, concrete ET windows with
explicit/automatic provenance, step, aberration correction, and scalar params.
Runtime query IDs are canonicalized so reopening a link does not change its
identity simply because local counters advanced. Incomplete drafts remain
unsaved and are never executed automatically.

Completed, enabled searches are rerun against the receiving catalog's kernels.
Result lists and metrics are regenerated rather than embedded in the URL.
Disabled searches retain definitions/flags but their caches are not restored.
A selected result is represented by query index, instant or interval endpoints,
and categorical state. It must uniquely match a recomputed event within 1 ms;
missing/changed data yields an explanatory error instead of selecting a result
that happens to reuse the old positional ID. Event selection does not override
the separately saved mission epoch, camera, or body selection. Playback remains
paused while searches rebuild, then returns to the saved state. History
navigation cancels an in-progress restore. Copy is disabled during searches or
restoration so it cannot serialize a partial result context.

The extension accepts at most 16 query definitions and shares the existing
8 KiB URL limit. Oversized contexts produce a copy error instead of truncating
queries or results. No additional Event Finder-specific copy action is needed.

## Event and observation hooks

`viewStateAtEpoch(state, et, selected?)` composes an event/observation epoch and
selection with an existing view and pauses it. `viewLink(state, pageUrl)` in the
viewer serializes it through the same URL format. Hosts can also construct a
named viewpoint variant and call `applyViewState` through their control instance.
The rail captures current Event Finder context through this same URL format.
These APIs remain available for later observation/context actions. They carry no event result arrays or observation imagery.

## Verification

Pure schema/security/control tests run with `npm test`. The frozen URL in
`apps/viewer/test-permalinks/earth-moon-v1.url` is also tested in a real Chromium
session:

```sh
npm --prefix apps/viewer run dev
node scripts/test-view-permalinks.mjs
# Or: CL_VIEWER_URL=http://127.0.0.1:5199/ node scripts/test-view-permalinks.mjs
```

The browser test checks catalog/time/named view/selection, FOV, playback, reload,
copy, a fresh session with an untracked retained origin, Back/Forward, no gesture
history spam, restore errors, the compact rail Copy action, and a second frozen fixture with
a selected lunar event that reruns in both deterministic and ordinary worker
sessions. Driver pages use the
existing deterministic test rendering mode; a fresh session opens the actual
copied URL without test mode. Readiness is awaited without fixed settle delays.
