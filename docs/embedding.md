# Embedding the Cosmolabe workspace

The standalone viewer's complete workspace — renderer, tool rail, timeline and
activity lanes, panels, event finder, measurements, camera controls — mounts into
any element of any web page. There is one implementation: the standalone app and
an embedded workspace run the same Svelte shell, and the host needs no Svelte,
no iframe and no access to viewer internals.

The host supplies mission data and application context (spacecraft state,
activities, time, selection). Cosmolabe owns mission visualization and spatial
analysis. Both sides use one set of state, control, timeline and provenance
semantics: `ViewerControl` (`@cosmolabe/control`), `MissionActivity` (#293) and
`PluginData`/`HostDataAdapter` (#179).

A complete, framework-free reference host lives in
[`examples/embed-host`](../examples/embed-host): two externally driven
spacecraft, host activities, two-way clock and selection, gaps, live updates,
resizing, scene switching and remounting.

## Build and install

```sh
npm run build:embed          # → apps/viewer/dist-embed/
(cd apps/viewer && npm pack) # → cosmolabe-viewer-<version>.tgz, installable anywhere
```

`dist-embed/` holds `cosmolabe.js` (ES module, Svelte and Three.js compiled in),
`cosmolabe.d.ts` (self-contained declarations) and `assets/` (workers, chunks,
`cspice.wasm`, `stars.bin`, fonts). Install the tarball, or depend on
`apps/viewer` with a `file:` dependency inside this repository.

Ordinary Vite consumers need one setting, because the package loads its workers
and WASM relative to its own module URL, which dependency pre-bundling would move:

```ts
// vite.config.ts of the host
export default { optimizeDeps: { exclude: ['@cosmolabe/viewer'] } };
```

Production builds need nothing: Vite emits the package's assets with the host's.
`scripts/test-embed-package.mjs` proves this end to end — pack, install into a
project outside the repository, typecheck against the shipped declarations,
build with a plain Vite config, serve and mount.

**Asset URLs.** Data assets resolve beside the module by default. To serve them
elsewhere (a CDN), copy `dist-embed/assets/` and pass `assetBaseUrl`; WASM and the
star catalog keep stable names for that purpose. JavaScript chunks and workers
always load relative to the module. Catalog-relative paths (models, textures,
kernels, `require`) resolve against the catalog's URL, or against `baseUrl` for a
catalog supplied as data.

## Mount, load, dispose

```ts
import { mountCosmolabe } from '@cosmolabe/viewer';

const viewer = await mountCosmolabe(container, {
  ui: { timeline: true, toolRail: true, analysisPanels: true, catalogBrowser: false, homeScreen: false },
  missionState: [sc1Source, sc2Source],
});
await viewer.loadCatalog({ json: catalog, baseUrl: document.baseURI }); // or a URL
viewer.control.setTime({ kind: 'et', et });
viewer.control.track('SC-1');
const off = viewer.control.on('time', ({ et, cause }) => { if (cause !== 'host') hostClock.set(et); });
await viewer.dispose();
```

- `loadCatalog` resolves once the scene's initial models, textures and trails
  have settled, and rejects — leaving the previous scene up — when it cannot load.
  When the scene loaded but a host owner's activities clash with its records, it
  rejects with `ActivityConflictError` (`conflicts: { owner, message }[]`); see
  [Activities](#activities).
- `ui` turns off major features: `timeline`, `toolRail`, `analysisPanels` (tool
  panels, inspector, probe), `catalogBrowser`, `homeScreen`, `shortcuts`. The
  catalog browser and home screen default off when embedded.
- **One workspace per page.** The viewer's stores are module singletons, so a
  second concurrent `mountCosmolabe` rejects. `dispose()` releases the renderer
  and its WebGL context, workers, SPICE, sources, subscriptions, panels,
  selection, activities and timeline state, and aborts in-flight loads; a later
  mount starts clean. Every handle a mount returned (`control`, `missionState`,
  `activities`, `loadCatalog`) throws once it is disposed, so a handle kept by
  mistake can never drive the next mount, and a load still in flight at
  disposal rejects without touching the next mount's scene.
- The workspace fills the container and follows it with a `ResizeObserver`
  (canvas, device-pixel ratio, floating panels, compact layout below 768 px).

### Host-page isolation

The workspace renders in a shadow root on the container. Its Tailwind reset and
component styles cannot reach the host page, and the host's styles cannot reach
it. Two rule kinds only work at document level and are placed in one
`<style data-cosmolabe>` element (removed on dispose): `@font-face` and
`@property`. Neither selects an element.

Embedded, the workspace never touches the URL, history or document title, adds no
page-wide drop handling and writes no `window` globals (the standalone page's
`window.cosmo` and `window.renderer` are its own). Keyboard shortcuts and camera
keys apply only while focus is inside the workspace (clicking it focuses it);
right-click, context menus, popovers, callouts and floating panels stay inside it
and move with it when the host page scrolls. Svelte's runtime registers one
inert document `reset` listener for its form bindings on first use and keeps it
for the page's life; it does not grow with remounts.

## Control and notifications

`viewer.control` is the standard `ViewerControl` with every optional capability
implemented. Subscriptions belong to the viewer, not to a scene: they survive
catalog loads and end with their disposer or the viewer's disposal.

| Event | Payload | Notes |
| --- | --- | --- |
| `time` | `{ et, cause }` | `cause` is `host` (this host's `setTime`/`seekActivity`), `viewer` (scrubber, keys, scripts) or `playback`. Seeks notify at once; playback is coalesced to four per second, trailing, so the last notification carries the clock's value. A `setTime` to the current time is a no-op. |
| `playback` | `{ playing, rate }` | On change only. |
| `select` | `{ name }` | Body selection, either side. |
| `load` / `ready` | `{ objects }` | Scene graph up / initial assets settled. |
| `activities` | `{ count }` | Catalog load or host update. |
| `activitySelect` | `{ id }` | Activity selection, either side; `null` when cleared. |

Reads added for hosts: `getObjectState(name, { time, frame, center })` returns
position (km) and attitude (scalar-first quaternion, v_body = q ⊗ v_frame ⊗ q*)
in any frame the scene can resolve, with availability and reasons — the same
evaluation the scene draws. A requested frame or centre that cannot be evaluated
is reported as unavailable with its reason (`error`, `unbound`, `dependency`),
never as available with a null value. Velocity is not part of the readout yet:
in a rotating frame it needs the frame's rate, which the frame registry does
not provide. `getTimelineWindow()` / `setTimelineWindow(start,
end)` navigate the timeline without touching the clock or the scene.

## External mission state

A body takes its state from a host source through ordinary catalog factories:

```json
{ "name": "SC-1", "center": "Earth", "class": "spacecraft",
  "trajectory":    { "type": "MissionState", "source": "sc1" },
  "rotationModel": { "type": "MissionState", "source": "sc1" },
  "geometry": { "type": "Mesh", "source": "spacecraft.gltf", "size": 0.4 } }
```

The catalog keeps owning models, labels, trails and sensors; the source supplies
samples. Sources outlive catalog loads and re-bind by ID. Add, replace and remove
them with `viewer.missionState` (`addSource`, `replaceSource`, `removeSource`,
`status`, `onChange`).

### The source contract

```ts
const source: MissionStateSource = {
  id: 'sc1',
  position: { timeScale: 'UTC', frame: 'J2000', center: 'Earth',
              positionUnits: 'km', velocityUnits: 'km/s', maxSampleSpacing: 30 },
  attitude: { timeScale: 'UTC', quaternionOrder: 'scalar-first', referenceFrame: 'J2000',
              bodyFrame: 'SC1_BUS', direction: 'reference-to-body', maxSampleSpacing: 30 },
  coverage: { position: { start: '2026-03-20T12:00:00Z', end: '2026-03-20T16:00:00Z' } },
  prefetch: { behind: 1800, ahead: 900 },   // seconds around the playhead
  maxSamples: 4000,                         // per channel
  staleAfterMs: 3000,
  async request(channel, { start, end }, signal) {
    const samples = await myArchive.fetch(channel, start, end, signal);   // backend-specific
    return adapter.supply({ window: { start: …, end: … }, samples }, provenance);
  },
  subscribe(sink) { /* sink.push / sink.setConnection / sink.extendCoverage */ return unsubscribe; },
};
```

Every convention is required; an unsupported or ambiguous declaration is an
error, never a default:

| Declaration | Values |
| --- | --- |
| `timeScale` | `TDB` (ET seconds past J2000) or `UTC` (ISO 8601 ending in `Z`, through core's leap-second-exact conversion; `23:59:60` accepted) |
| `frame`, `referenceFrame` | Any `FrameRegistry` frame resolvable in the scene (`J2000`, `ECLIPJ2000`, `IAU_MARS`, a SPICE frame…). `BODY_FIXED` is rejected: name the frame. |
| `center` | Must equal the catalog item's `center`; a mismatch is reported, not reinterpreted. A conflicting `trajectoryFrame` likewise. |
| units | `km`/`m`, `km/s`/`m/s` |
| `quaternionOrder` | `scalar-first` `[w,x,y,z]` or `scalar-last` `[x,y,z,w]` |
| `direction` | `reference-to-body`: v_body = q ⊗ v_ref ⊗ q* (SPICE C-matrix sense; CCSDS AEM `A2B` with A the reference). `body-to-reference` is its conjugate. Quaternions more than 1e-3 from unit length are rejected. |
| `maxSampleSpacing` | Widest spacing interpolated across (Hermite for position, SLERP for attitude); wider is a gap. |

`maxSamples` (integer ≥ 2), `prefetch.behind` / `prefetch.ahead` and
`staleAfterMs` (finite, ≥ 0) are validated; anything else rejects the source.

Batches cross the #179 boundary as `PluginData`: `HostDataAdapter.supply` for
host data, `exploratoryData` for host-side computations. Provenance
`classification: 'planned'` marks predicted state; predicted samples never
overwrite observed ones, and the inspector labels which is shown. A batch's
`window` is the interval it is complete for: inside it, missing samples are a real
gap; a later batch replaces what an earlier one said about its window, so late
and out-of-order deliveries apply by time. Batches are validated atomically.

Two samples are interpolated between only when (1) they are within
`maxSampleSpacing`, (2) one contiguous run of answered windows spans both — never
across a window nobody served, and an answer with no samples is an explicit break
and predicted data can neither reopen nor close what observed data said there
— and (3) they share authority (host / exploratory) and classification, so
observed and planned state, or host and exploratory data, are never blended.

### Coverage: never a held state

Outside its data a source's body has no position (`stateAt` is NaN) and no
attitude (`rotationAt` throws `StateUnavailableError`). Every consumer agrees,
through `Universe.stateAvailability`:

| Reason | Meaning |
| --- | --- |
| `pending` | Inside declared coverage, being fetched; or after the last sample of a connected live feed that is current |
| `before-coverage` / `after-coverage` | Outside what the source serves |
| `gap` | Loaded, but no samples within `maxSampleSpacing`, a window answered empty, or a provenance boundary |
| `stale` | After the last live sample; the feed has been silent longer than `staleAfterMs` |
| `disconnected` | After the last live sample; the host reported the link down |
| `unbound` | The catalog names a source the host has not supplied |
| `error` | The source was rejected against the catalog, or a request failed (retried after 2 s) |
| `dependency` | This body is fine; a body or frame it is placed relative to is not |

Without position the body, label, sensors and its trail segment are absent;
without attitude (position valid) the model is replaced by its position marker,
body axes and sensors are hidden, and body-locked camera modes have no frame. The
inspector's **State** section gives the reason.

### Sensors on host-supplied attitude

SPICE knows nothing of a host attitude, so a sensor on a spacecraft whose
`rotationModel` is `MissionState` is pointed by that attitude and a mounting the
catalog declares, in the spacecraft body frame (instrument +Z is the boresight,
+Y up, as in SPICE):

```json
{ "name": "SC-1 Imager", "center": "SC-1",
  "trajectory": { "type": "FixedPoint", "position": [0, 0, 0] },
  "geometry": { "type": "Sensor", "horizontalFov": 10, "verticalFov": 8,
                "mounting": { "boresight": [0, 0, 1], "up": [0, 1, 0] } } }
```

Without a mounting (or with an invalid one) such a sensor has no truthful
pointing: it is not drawn, and the instrument view shows **No pointing** with
the reason instead of an image — it is never aimed at its target as a stand-in.
SPICE frame kernels that relate an instrument frame to the host's `bodyFrame`
are not used for this yet.

### Orchestration

`stateAt`/`rotationAt` never do I/O: they read a bounded cache that the viewer
keeps filled around the playhead (`prefetch`). It requests only when the inner
half of that window is uncovered, so playback asks for chunks; requests that no
longer overlap the wanted window are aborted on seek; answers for aborted
requests or replaced sources are discarded, whatever the backend does with the
signal; retention evicts the samples farthest from the playhead and forgets that
they were loaded. An answer narrower than its request, or a failed one, is
backed off for 2 s rather than re-requested every frame. `replaceSource`
validates and subscribes the newcomer before releasing the old source: if its
`subscribe` throws, the old source keeps working. New data invalidates only the
bound bodies' trails, coalesced. The playback range is the timeline's: it starts from declared coverage (or the
loaded data) and grows as live coverage extends or the host seeks beyond it
(`setTimelineWindow` navigates it explicitly) — the scene is never rebuilt.

A Yamcs (or other ground-system) adapter is host code implementing `request`
and `subscribe` over its archive and live APIs; the reference host's
`TelemetryArchive` shows the seam.

### Activities

```ts
viewer.activities.replace('mission-plan', specs); // MissionActivitySpec[], ET or UTC
viewer.activities.remove('mission-plan');
```

Host activities use the existing store, lanes, inspector and navigation. Each
owner's records replace that owner's previous ones atomically, persist across
catalog loads, never touch catalog-owned records, and may not reuse another
owner's IDs. `replace` throws on a clash with the scene up; owners registered
before a `loadCatalog` whose catalog then holds the same IDs are not shown in
that scene — each owner is all in or all out — and the load rejects with
`ActivityConflictError` naming them. Their records stay registered;
`activities.replace` or `remove` resolves the clash. A selected activity whose record disappears is deselected; a later
record with the same ID is not reselected.

### Analysis tools

External spacecraft drive the 3D scene, inspector, measurements that read scene
geometry, and `getObjectState`. Event Finder searches run on SPICE kernels; a
search involving a body whose state comes from a host source reports that it is
unavailable rather than computing from other data. There is no second geometry
engine.

## Testing

- `packages/core/src/__tests__/mission-state.test.ts` — evaluation, frames,
  leap seconds, quaternion conventions, coverage, orchestration, retention.
- `apps/viewer/src/lib/__tests__/viewer-control.test.ts`, `embed-session.test.ts`
  — host notifications, coalescing, activity selection, CSS split, store reset.
- `node scripts/test-embed-host.mjs` — the reference host in a browser, against
  closed-form fixtures: frames, attitudes, gaps, activities, two-way sync, late
  answers, replacement, live/stale/disconnected, resize, scene switch, isolation,
  disposal (listeners, workers, WebGL contexts) and remount.
- `node scripts/test-embed-package.mjs` — the packed tarball in an independent
  project.
