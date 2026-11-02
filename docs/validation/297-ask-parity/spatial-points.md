# Default Ask semantic points

Review [6578748042](https://github.com/AaronPlave/cosmolabe/pull/334#issuecomment-6578748042)
is implemented in the same shared control registry as the other #297 domains.
`getSpatialContext` provides a bounded entity/parent/epoch/state/shape/convention
read, existing editable target, selected feature and native geographic draw status.
`getObjectState`, `projectGroundPoint` and `getProbePoint` supply targeted reads;
`pinGroundPoint` and `clearProbePoint` use the existing native Point Probe owner.

Projection uses the entity's actual state in its active parent's fixed frame,
then the existing renderer surface cast and SurfacePoint conversion. It never
samples the camera pixel or substitutes a named flight site. Entity attitude is
unnecessary for radial projection; parent-frame availability is required.
Missing scene, entity, parent, source coverage, valid position, supported physical
reference shape or fixed frame refuses placement and preserves any earlier pin.
A physical-terrain request requires a terrain hit with a sample describing that
hit. A missing physical surface can be offered explicitly as reference-only.

Reference placement uses the declared sphere/oblate ellipsoid, not a visual
radius. Rendered placement can refine through the native streamed-terrain path;
explicit reference placement stays fixed. A pin is an epoch-stamped snapshot,
not a moving vehicle tracker. Display precision is explicitly distinct from
position accuracy. Native observation expires after camera/viewport/time changes
and full-screen instrument coverage. `drawn` does not guarantee unoccluded pixels.

Transient pinning uses reversible display permission. Persistent layer creation
and edits require exact-call authoring approval in the Ask panel. New compatible
layers are allowed. Saving a probe uses Draw's existing frame-equivalence and
coordinate-convention conversion; geodetic probe latitude is not copied directly
into a planetocentric annotation. Approved generated user feature IDs are public;
private frame labels, source locations, arbitrary errors and imported properties
remain withheld from the provider.

Live checks on 2026-11-02 used actual default Fixed Ask, the configured Sonnet
provider, public Cassini/Ingenuity fixtures and Chrome's Metal renderer. The owned
5797 listener belonged to this checkout. The harness asserted call-ID-matched
model-visible spatial results, actual selected geometry/native draw groups,
entity-to-pin direction at placement epoch, approval separation and unchanged
clock/playback/camera ownership. Playback continued normally throughout.

- `place a point on the top of saturn` asked north pole versus visible-disc top
  before any write. Clarifying the north pole created an approved compatible
  layer, added and selected a point at 90°N using the viewer's IAU_SATURN shape
  and conventions, and confirmed the native drawing group.
- `place a pick marker on the ground where ingenuity currently is` created a
  transient probe without authoring approval. The initial model read could not
  confirm draw visibility and said so. Later native readback and the screenshot
  showed the pin; no camera movement was requested to force visibility.
- The literal `can you place a point then` created an approved persistent point.
  A further explicit save-and-select request verified selection, convention
  conversion and readback of the existing pinned location. Two features remained;
  the second saved the terrain-refined pin rather than silently moving the first.

See [compact evidence](spatial-acceptance.json), [Saturn screenshot](saturn-point-panel.png)
and [Ingenuity screenshot](ground-pin-panel.png). Complete provider dumps stay
local. A final Haiku Cassini smoke also succeeded with the expanded 107-operation
registry: 12 calls, 166,692 processed tokens, four repaired schema/coverage
refusals. The pre-request token admission check can admit a request whose final
usage crosses its threshold; this was not a strict 150,000-token total ceiling.
Model/cache variability prevents a fixed round-count or cost guarantee.

Deterministic validation includes missing coverage, wrong scene/frame, zero
position, unsupported shape, no physical terrain, UI-originated probe readback,
privacy/result bounds and display-versus-authoring permissions. Viewer: 55 files /
751 tests; control: 14 files / 193 tests; native semantic surface: 3 tests; proxy:
34 tests. TypeScript, Svelte (zero warnings), production/embed builds, changed-file
ESLint, purity and generated capability coverage checks passed.

Repeat only with explicit live inference authorization and a viewer started with
`VITE_ASK_ENDPOINT=http://127.0.0.1:8798`:

```sh
ASK_MISSION_LIVE=1 node scripts/test-ask-spatial-points.mjs
```
