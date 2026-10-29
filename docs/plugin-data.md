# Plugin data authority and provenance

A host integration (for example astrolabe) produces mission state; cosmolabe
consumes it. Viewer geometry remains available without that service. These paths
use `PluginData<T>` from `@cosmolabe/core`, a discriminated union of adapter-issued
`HostData<T>` and `ExploratoryData<T>`. Authority identifies the delivery path;
classification independently describes authoritative, reconstructed, planned,
exploratory or synthetic content. Planned host data is still host-supplied.

The integration owns a `HostDataAdapter` and supplies its products to plugins.
Plugins use `exploratoryData` for their own computations. An inaccessible unique
symbol on `HostData` prevents a plugin from satisfying that type with an object
literal containing `authority: 'host'`. Do not expose the adapter itself through
renderer/plugin contexts. As with other TypeScript contracts, assertions, `any`
and hostile JavaScript are outside this boundary; this is not a security sandbox.
`HostDataAdapter` is exported, so the type guarantees adapter issuance but does not
authenticate a real host: any code importing `@cosmolabe/core` can construct one.
Separately authored plugins are kept honest by the integration keeping adapters
out of their reach, not by the type system.

```ts
import { HostDataAdapter, type ContactWindow } from '@cosmolabe/core';
import { CommLinkPlugin } from '@cosmolabe/three';

// Host integration code, after receiving the service response:
const adapter = new HostDataAdapter('astrolabe');
const contacts: ContactWindow[] = [
  { spacecraft: 'SC', station: 'DSN-Goldstone', startEt: 100, endEt: 500 },
];
const plugin = new CommLinkPlugin();
plugin.setContactWindows(adapter.supply(contacts, {
  id: 'contact-plan-v1', kind: 'analysis', classification: 'planned',
  validity: { startEt: 0, endEt: 1000 },
  parents: [{ id: 'mission-package', kind: 'package', source: 'astrolabe' }],
}));
```

`DataProvenance.parents` retains the chain from catalog source/package through
entity contribution to trajectory, attitude, surface, observation or analysis
product. Nodes can carry source identifiers/URLs, versions, ET validity bounds,
citations and licenses; kernel nodes can identify SPK/CK/DSK inputs. Multiple
parents represent combined inputs. Each contact window may also carry its own
provenance. Preserve these nodes when adapting data rather than flattening them
into a display label. This first implementation exposes the model for hosts and
future inspectors; it does not automatically recover provenance from legacy
catalogs or add a package inspector.

Plugins may receive typed products via `onDataUpdate`; hosts call it with changed
product keys, just as they deliver scalar `onResourceUpdate` values. Scalar
resources do not confer authority. Existing plugin state keys remain compatible.

## Communication strategies

`CommLinkPlugin.setContactWindows` accepts only adapter-issued host data. A
present schedule governs rendering, even when local geometry disagrees. An empty
schedule means no contacts. Outside the supplied provenance validity interval,
links stay hidden; stale data is never silently replaced by exploratory geometry.
Window endpoints and validity bounds are inclusive ET seconds.

With no host schedule, `setLinks` configures candidate pairs and time bounds.
Inside those bounds the plugin uses `hasLineOfSight`, evaluated in physical km
through `Universe.absolutePositionOf`, independently of display scale and camera
origin. It checks the segment against each other body's physical triaxial
ellipsoid (`radii`), oriented by the body's rotation model, or axis-aligned with
the scene frame when it has none, so a station on an oblate body's surface is not
falsely blocked. It does not model terrain, station elevation masks, antenna pointing, refraction or light time.
Missing/non-finite states hide a link. `setContactWindows(undefined)` explicitly
restores this fallback. `plugin.data` exposes the chosen authority and provenance;
in fallback mode its payload is `{ candidateWindows }`, a different type from the
host `ContactWindow[]`, because those intervals are candidate bounds, not computed
contact windows. A link whose occulting body's position is unavailable is hidden
(intentionally conservative). Supplied windows are copied and frozen on
`setContactWindows`; mutating the host's original array afterwards has no effect.
A host link is also hidden while either endpoint is outside its existence window
or has no ephemeris at the current ET, independently of local LOS. `candidateWindows`
is a frozen snapshot. Per-window line objects and per-frame occluder lookups scale
linearly with the schedule and body count. Measured on the plugin alone (no GPU
draw cost): 20 exploratory links against 50 ellipsoid occulters take about
0.18 ms/frame; a 2000-window host schedule builds in about 9 ms and costs about
0.02 ms/frame, though it holds 2000 lines. One line per endpoint pair is a
possible follow-up.

## Visual semantics

The plugin palette `PLUGIN_DATA_COLORS` reserves the blue accent exclusively for
**computed here** (exploratory) products. Host products use neutral gray. Red is
reserved strictly for faults, never for a normal maneuver, contact, category,
selection or authority level. A host-supplied fault can still be red; authority
and fault status are different concepts. Hosts rendering plugin products should
apply these same roles and label the authority explicitly.

Communication links follow authority colors, ignoring the deprecated `CommLink.color`
override so a host schedule cannot look computed here. Maneuver arrows default to
neutral gray rather than red/orange; callers of other legacy color overrides are
responsible for observing these semantics. These plugin data roles do not redefine
third-party component libraries' unrelated hover/selection token names.
