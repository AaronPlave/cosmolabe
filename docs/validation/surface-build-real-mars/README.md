# Real Jezero surface-build pilot (#251)

The offline executor reuses the unchanged #50 MOLA/HRSC + HiRISE residual and
builds a 78-tile ellipsoidal terrain pyramid through L11. Independent context (L13) and native-detail (L16) imagery pyramids use the same
observed 512 m native 25 cm HiRISE ortho crop, with its provenance preserved.
The context base is mandatory and the native-detail layer is optional. Both use
area-averaged premultiplied DN/coverage overviews and 4×4 footprint sampling;
internal masks stay transparent and standalone manifests carry source provenance.
The requested pilot is approximately 24 m across. It is an explicit data-build
ROI, not a mission trajectory or a claim of DTM availability elsewhere.

The physical GPU run used Chromium/ANGLE Metal on **Apple M4 Max**. It exercised
regional, near, zoom-out and restored views, CPU picks, layer opacity/visibility
and restoration. Imagery reached L16 while geometry remained at L11. Hiding the optional layer revealed L13 context; restoring it returned to L16. Layer
controls preserved physical terrain mesh identities. There were no page or
product HTTP errors. This is desktop hardware evidence, not a phone/device test.
The bounded local viewer configuration limits Tailwind discovery to viewer source
and excludes generated datasets from its watcher; renderer/app source is unchanged.

| Native imagery, unlit | Native layer hidden; coarse context visible | Real Sun lighting restored |
| --- | --- | --- |
| ![Native HiRISE ortho over independent terrain](native-detail.png) | ![Coarse context after hiding optional native detail](hidden.png) | ![Native imagery under catalog Sun lighting](shaded.png) |

The near view is about 50 m above the source control. At that distance source
texels occupy several screen pixels; interpolation does not create finer physical
detail. Exact source coordinates, hashes, native-valid subsets, output availability
and measurements are in [the recorded evidence](../../benchmarks/surface-build-real-mars.json)
and [the real lock](../../examples/surface-plans/jezero-build.lock.json).

The acceptance checks prove source-grid alignment, native-cell/kernel validity,
continuous requested output coverage, agreement with an independently filtered
native DN/validity reference (including gutters), physical CPU access and independent image refinement. Shared source
provenance and source labels do not certify absolute ground geolocation. The
source mosaic's illumination is unknown; no angles or photometric corrections
are invented. Known coarse-boundary rendered/CPU separation remains recorded.
No R2 publication, deployment pin or mission placement change is included.

See [reproduction commands](../../surface-data-builds.md#handoff-resume-the-real-mars-pilot).
