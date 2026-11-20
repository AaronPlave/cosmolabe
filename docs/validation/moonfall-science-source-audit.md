# MoonFall south-pole science source audit

This records the initial source investigation and the three-feature renderer
baseline for [#308](https://github.com/AaronPlave/cosmolabe/issues/308).
The [integration validation](moonfall-science-integration.md) covers the full
Barker release, the author-published Diviner summer maximum, and the newer radar
registration checks.

## LOLA permanently shadowed regions

[Barker et al. (2023)](https://doi.org/10.3847/PSJ/acf3e1) derived the map using
horizons from the adjusted LOLA DEM and 720 Sun positions at the solar
declination of maximum southern illumination over the 18.6-year precession
cycle. The polygons represent a modeled permanent-shadow reference.
The [PGDA release](https://pgda.gsfc.nasa.gov/products/90) asks users to cite the
paper and supplies the >1 km² subset, `LPSR_80S_20MPP_ADJ_1km2`. It contains
1,531 features, with 3,200 interior rings, and the original attributes
`gid`, `area_km2`, and `name`. GEOS flagged five self-intersections in source
features 57, 116, 158, 408, and 645, all outside the 65 km circle about the
pole. The full source has a square extent reaching corners equatorward of 80°S.

The PRJ describes a south polar stereographic projection on a 1,737,400 m
sphere, with longitude zero and no false origin. The publication identifies
DE421 mean Earth as the frame for the polar products. Invert the projection
into east-positive, planetocentric `MOON_ME_DE421` coordinates with zero frame
rotation. The rounded coordinate controls in the paper's PSR uncertainty section
at projected (−39, −39) km and (−273, −273) km agreed with GDAL to 0.62 m and
0.12 m, respectively. These residuals measure projection agreement against
rounded coordinates. The paper describes PSR boundary and area uncertainty from
DEM gaps and interpolation.

The [LROC companion Mazarico PSR vector](https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_POLE_PSR_SOUTH)
uses an earlier independent shadow model and the same projected axes. Both
products contain the Shackleton, Haworth, Amundsen and Region 5 controls, and
both exclude the geographic pole. Nearest modeled boundary distances at those
four points differed by 18–86 m. That compares two models at specific points.
The linked [Moon Trek service UUID](https://trek.nasa.gov/moon/TrekServices/ws/index/getLayerServices?uuid=f0d436fb-c2a8-4c33-ba1c-afdf55bbd688)
returned the global WAC mosaic. The LROC companion vector supplied the PSR
comparison.

The viewer subset selects whole source features within 16 km of Shackleton's
center in the source plane. It contains GIDs 13, 921 and 1266, with 12 polygon
components, four holes and 4,586 ring positions. The build uses inverse
projection without cutting rings at the longitude seam. It drops consecutive
duplicate positions and serializes coordinates to nine decimal places. An
independent spherical stereographic forward calculation matched each retained
vertex against the source projected coordinate to 0.000016 m. This measures
conversion error. The importer uses a projected X-range sweep for ring
intersections and retains its one-million-comparison work limit.

The larger near-pole selection with Haworth and Amundsen needed 146 renderer
pages in one group, against a limit of 16. The selected subset used eight pages
at admission. Reproduce the content-addressed Pages asset with
`python3 scripts/build-moonfall-psr.py SOURCE_DIRECTORY apps/viewer/test-catalogs/places`.
Its SHA-256 is
`295d61bce287e2be53a2c32f26faab51639fcc78c86b942428188b6b8c567b0b`.

In the normal local MoonFall route, Chrome on Apple M4 Max ANGLE Metal reached
initial assets in 4.87 s. The PSR layer requested zero bytes at startup and
while opening Surface Layers. The first toggle made one successful GeoJSON
request and admitted all three features in 0.45 s. Selecting GID 13 showed
its 233.422 km² source area and Fly to worked. Enabled/disabled framebuffer
comparisons at 42 km and 4 km showed 5,154 and 2,506 pixels changing by over
22 on at least one RGB channel. The closer camera was aimed at a
near-antimeridian source vertex. Both ranges used streaming terrain and
produced no vector or WebGL diagnostics. Hiding and showing the layer again
reused the loaded data. Navigate → Places → Jump to reached both Haworth and
Amundsen from the shipped gazetteer.

The Pages bundle and hosted-catalog rewrite retained the same PSR asset
hash and relative catalog URL. A local production build at `/cosmolabe/`
loaded the pinned R2 terrain, WAC/NAC imagery and lunar kernels from the
allowed `http://localhost:5173` origin. The layer was off through initial
readiness at 8.58 s, then drew all three features 0.49 s after enable.
A two-hour time seek retained GID 13 selection, the same geometry and
its streaming terrain drape. The public Pages site has its previous catalog.

### Polar renderer review

An identical 4.9 s fixed-orientation dolly from 4 to 36 km and back was
replayed on Apple M4 Max Chrome (ANGLE Metal, 2880 × 1800 framebuffer).
CPU time encloses the renderer call. GPU time uses WebGL2 timer queries,
with the vector pass measured in a separate replay. Missed refresh
intervals are estimated from callback gaps at 60 Hz.

| Version and layer state | CPU frame median / p95 (ms) | GPU frame median / p95 (ms) | GPU vector median / p95 (ms) | Missed refresh intervals |
| --- | ---: | ---: | ---: | ---: |
| Original, off | 10.2 / 12.9 | 4.65 / 9.08 | — | 0 |
| Original, on | 11.0 / 91.2 | 22.77 / 57.05 | 22.99 / 31.38 | 93 |
| Revised, off | 10.1 / 14.2 | 3.15 / 8.52 | — | 2 |
| Revised, on | 11.2 / 16.8 | 6.26 / 11.53 | 5.73 / 6.48 | 0 |

The polar cap supplies a scissor bound when it fits inside the viewport.
Close views of this cap can fill the viewport. Polar detail grids narrow
the candidate lists there and preserve each primitive's source chart.
The three detail levels use three, four and five pages. The eight-page
geographic index remains the bounded fallback. At 42 km the default terrain
scissor covered about 48% of the viewport.

Fixed-orientation captures at 2, 4, 6, 8, 12, 24, 42 and 90 km exercised
different selected terrain tiles. At 42 km, independent radial intersections
put 101 missing stroke samples on the nearest rendered terrain to within
0.4 mm. Disabling depth testing, enabling both faces and disabling tile fades
left the gap. The longitude padding limit was discarding those fragments.
Selecting by the polar footprint and applying its padding limit restored
all 101 samples with the existing depth test, stroke widths and source
geometry. At the same camera pose, forcing fine and coarse terrain selected
38 and four meshes, respectively. The repaired outline was present at all
sampled vertices with a rendered terrain hit in both views. The Surface
Layers title and layer view identify the Shackleton subset explicitly.

## Diviner summer-noon bolometric temperature

The selected [PDS polar cumulative product](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_pcp/diurnal/ltim/pols/)
is `PCP_AVG_TBOL_POLS_SUM_LTIM49_240` v1. It is an observation-derived average
bolometric brightness temperature (K), for southern summer and local solar time
12:00–12:15, from nadir observations acquired 2009-07-05 through 2019-02-17.
The bin has no relationship to the viewer clock. The published 240 m sampling
is distinct from the approximately 140 m cross-track and 400 m along-track
measurement footprint at 50 km altitude. See [Williams et al. (2019)](https://doi.org/10.1029/2019JE006028)
and the [Diviner data product specification](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/document/Diviner_RDR_SIS.pdf).

The archive is a sparse numeric table. Empty cells are omitted and the PDS4
label marks −9998 and −9999 invalid/unknown. The downloaded file has 3,345,210
unique finite observations, 16.570862–329.516968 K, matching the label. The
actual reported centers span 89.992093°S–79.995579°S. The two axes each have
2,533 rounded reported centers with a mean step of 240.036 m. Multiplying
the published normalized X/Y columns by 1,737,400 m agrees with forward
projection of the latitude/longitude columns in the same table to 0.016 m. The
archive describes the LRO ME system in general, but the PCP label supplies
neither an ephemeris realization nor independent terrain tie points. The
specification's explicit DE421 keyword describes the GDR family. The table
column closure measures internal consistency.

I used the PDS summer-noon statistic because it is independently identified and
downloadable. The [UCLA polar map link](https://luna1.diviner.ucla.edu/~jpierre/diviner/level4_polar/)
failed TLS validation, and the
[Landis et al. supporting-data repository](https://doi.org/10.25810/gkdf-n764)
publishes a south-pole annual maximum bolometric temperature CSV at roughly
300 m spacing. The DOI and the direct CU Scholar page returned HTTP 403,
including in Chrome, so the source coordinates and bytes could not be checked.
The selected PCP values describe one
local-time bin and cannot establish an annual maximum or long-term ice
stability.

An alternate original, [Diviner GDR `DGDR_TBOL_AVG_POLS_20150122D_240_IMG` v5.0](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_gdr_l3/2015/polar/img/),
explicitly names DE421 in its PDS3 label. It is a 240 m daytime mean for
2015-01-22 through 2015-02-19. The PDS3 affine agrees with the PDS4 outer
corner of (−457440, +457440) m. The 3812 × 3812 little-endian Int16 array
uses 0.02 K per count, zero offset, and −32768 for missing data. It has
8,147,504 valid samples in the full square grid and zero valid pixels
poleward of 88°S. This frame-identified GDR leaves the Shackleton area empty,
so it cannot cover Shackleton. A range check of 15 day/night 2015 GDR grids
across six months likewise found zero valid samples poleward of 88°S.

The [PDS south Polar Resource Product v2](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/)
provides annual maxima from model fits on a Kaguya-derived triangular mesh.
Its original label and table header were inspected. The archive describes
planetocentric coordinates and a Moon-centered frame, without a specific frame
realization. The [Kaguya LALT archive specification](https://darts.isas.jaxa.jp/app/pdap/selene/help/en/LALT_Format_en_V01.pdf)
identifies DE421 ME for its geolocated LALT data. The precise upstream grid
revision and registration of the derived PRP mesh remain open. I checked
40,800 original PRP triangle records from bytes 308448210–317016209 of
`dlre_prp_south.tab` against the independently adjusted
[Barker 80 m LOLA DEM](https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_80MPP_ADJ.TIF).
For triangle centers within a 13 km square around each site and inside the
retrieved strip, I compared their radial heights to the nine LOLA samples at
0 and ±160 m in both axes. At the archived coordinates, the height RMS
residual was 118 m across 689 Shackleton triangles and 492 m across 867
Connecting Ridge C2 triangles. A local diagnostic translation of 300 m west
improved Shackleton. Connecting Ridge C2 showed weaker correspondence and
the best result within the diagnostic search was at its 1.3 km east limit.
Differences in terrain resolution affect this comparison. It fails to
establish a common registration correction. No offset was applied.

For comparing thermal extremes
around the mission sites, the maximum of the observed summer local-time means
would be more useful than a single noon bin. Williams et al. show that peak
temperature can occur well away from noon and compare the thermal cycle at
Connecting Ridge C2 with an independently identified LOLA ridge. The noon
table has 172.406174 K at that coordinate in its nominal grid. The comparison
supplies no positional residuals that establish grid-scale registration.
See [Williams et al. Figure 10](https://doi.org/10.1029/2019JE006028).

## Chandrayaan-1 Mini-SAR CPR

The [PDS mosaic archive](https://pds-geosciences.wustl.edu/lunar/ch1-orb-l-mrffr-1-pdr-v1/ch1mrf_0xxx/data/sar/mosaics/)
supplies `FSB_XXXXX_3CP_PJU_90S000_V1` v1.0, a calibrated, dimensionless S-band
same-sense/opposite-sense polarization ratio from 2009-01-07 through
2009-04-15. Increased CPR can arise from surface roughness. The mission archive
lists 150 m radar resolution. The mapped product stores a 75 m grid in an
8107 × 8107 little-endian Float32 array. Preserve the original scale 1 and
offset 0 and mask PDS/ISIS special values by bit pattern. Only `0xff7ffffb`
occurred among the five PDS3 special constants. Finite signed numerical
samples remain source values. See the
[Forerunner product specification](https://pds-geosciences.wustl.edu/lunar/ch1-orb-l-mrffr-1-pdr-v1/ch1mrf_0xxx/document/dp_sis/mrffr_dp_sis.htm).

PDS4 gives the projected upper-left outer corner as (−304125, +304125) m.
GDAL's PDS3 affine agrees. Pixel centers are a half cell inward; the pole
falls on a four-pixel junction. The mission format specification identifies
ME and lists the DE421 lunar orientation and matching frame kernel. This
supports the nominal frame. The archive and the independent
[Neish et al. (2011)](https://doi.org/10.1029/2010JE003647) paper support
the numerical decoding. The whole raster mean was 0.3138855 over
54,423,655 valid cells, consistent with the independently published 0.31.
This still leaves product-specific ground control open. No archive tie-point
residual for this exact mosaic was located. [Xu et al. (2025)](https://doi.org/10.3390/rs17040613)
document localized geocoding problems in historical SAR sources. Their
correction statistics apply to their processing, and their research data are
available by request.

A candidate from a different instrument is
[Fassett et al.'s orthorectified Mini-RF product](https://doi.org/10.3847/PSJ/ad0a61).
The [90 m south-pole archive](https://archive.data.jhu.edu/file.xhtml?fileId=16774&version=1.0)
contains incidence-normalized δCPR with an offset to the nominal 49°
geometry. Automated download returned HTTP 403. A browser-supplied copy
matched the published checksum, and the delivered projection, coverage and
independent terrain checks are documented in the
[integration validation](moonfall-science-integration.md#regional-s-band-mosaic).
The Chandrayaan-1 Mini-SAR samples remain distinct from this LRO product.

| Projected pixel centers | Valid / total | Valid fraction |
| --- | ---: | ---: |
| Entire square raster | 54,423,655 / 65,723,449 | 82.81% |
| Poleward of 80°S | 48,035,708 / 51,616,304 | 93.06% |
| Poleward of 88°S | 834,459 / 2,054,632 | 40.61% |
| Poleward of 89°S | 53,118 / 513,544 | 10.34% |

## Archive sample controls

These are source-bin lookups using the nominal published coordinates. The
thermal values are rounded here for readability. The numerical audit emits
the full source values. The [USGS nomenclature](https://planetarynames.wr.usgs.gov/)
and Williams et al.'s Figure 1 supplied the named controls. Polaris coordinates
come from the authored schedule. The four Polaris entries represent five
distinct final landing positions because Polaris-B lands at two locations.

| Control | Diviner K | Mini-SAR CPR | Barker PSR GID |
| --- | ---: | ---: | --- |
| Shackleton center | 82.93 | No observation | 13 |
| Haworth PSR control | No observation | 0.198605 | 2 |
| Amundsen PSR control | No observation | 0.361328 | 5 |
| Haworth gazetteer anchor (87.45°S, 5.17°W) | No observation | 0.292700 | 2 |
| Amundsen gazetteer anchor (84.4398°S, 83.0691°E) | No observation | 0.352707 | — |
| Region 5 | No observation | 0.255186 | 306 |
| Polaris-A final landings | 191.24 | No observation | — |
| Polaris-B final landings | 91.81, 263.43 | No observation | — |
| Polaris-C final landings | 83.68 | No observation | 13 |
| Polaris-D final landings | No observation | No observation | — |

A dash means the control falls outside this PSR subset. The >1 km² threshold
and model uncertainty constrain that result. These lookups describe spatial
coincidence with fictional operations. A useful CPR comparison needs regional
coverage beyond the Shackleton close-up, such as Haworth or Region 5.

## Reproduce the source checks

Download originals into an empty scratch directory with the local names below.
Retain the four LOLA shapefile components together. In the scratch directory,
link `FSB_XXXXX_3CP_PJU_90S000_V1.IMG` to `cpr.img` for the case-sensitive PDS3
reference. Verify the SHA-256 digests with `shasum -a 256`. Run
`python3 scripts/audit-moonfall-science.py SOURCE_DIRECTORY` with GDAL Python
bindings, NumPy and Node available. The audit was run with GDAL 3.13 and
NumPy 2.4.6. It reads the complete numeric tables and uses the existing
MoonFall schedule for landing probes.

| Local file | Archive basename or link | SHA-256 |
| --- | --- | --- |
| `psr.shp` | [SHP](https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LPSR_80S_20MPP_ADJ_1km2.SHP) | `39a9906545188ea4d9b844d34f946de7a6721993f778076d85778650cbbfb741` |
| `psr.shx` | [SHX](https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LPSR_80S_20MPP_ADJ_1km2.SHX) | `3bc10378025d62ded5805e2eebe4c016e461a8c6fe661f15367e4019f2b85827` |
| `psr.dbf` | [DBF](https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LPSR_80S_20MPP_ADJ_1km2.DBF) | `23c3e3a01cde8d8c2114196f7430c46c24505c1a6e75fcdb522670d8efcc62da` |
| `psr.prj` | [PRJ](https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LPSR_80S_20MPP_ADJ_1km2.PRJ) | `793b80952f23fbff90f48f9e13868b6b7fc5dc07ba0b1633b124c3db52462854` |
| `psr-reference.zip` | [LROC reference ZIP](https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/EXTRAS/BROWSE/NAC_POLE/NAC_POLE_PSR_SOUTH/NAC_POLE_PSR_SOUTH.ZIP) | `0274cb887bc108f0bb4e3c650beede9829c1cf0be1ce21b5f3e8256a2c29d250` |
| `diviner.tab` | [TAB](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_pcp/diurnal/ltim/pols/pcp_avg_tbol_pols_sum_ltim49_240.tab) | `35348174fb3d973fe3d43fa7777cb4a10055361c6313675f35b181079bad5ca3` |
| `diviner.lbl` | [LBL](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_pcp/diurnal/ltim/pols/pcp_avg_tbol_pols_sum_ltim49_240.lbl) | `4523de3cc856cd1943d4d9e8f4e2f69f223c13be39a9d87453c7a7492227a718` |
| `diviner.xml` | [XML](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_pcp/diurnal/ltim/pols/pcp_avg_tbol_pols_sum_ltim49_240.xml) | `73e2a55db6743b5bbb5116fae9c51aa77a07743042b0284ea2bf8804fbbfd7b1` |
| `cpr.img` | [IMG](https://pds-geosciences.wustl.edu/lunar/ch1-orb-l-mrffr-1-pdr-v1/ch1mrf_0xxx/data/sar/mosaics/fsb_xxxxx_3cp_pju_90s000_v1.img) | `abaae42a9cf3bcde8008762b41ccaa9b117530d4cb69f9dc6bd50a575715a47f` |
| `cpr.lbl` | [LBL](https://pds-geosciences.wustl.edu/lunar/ch1-orb-l-mrffr-1-pdr-v1/ch1mrf_0xxx/data/sar/mosaics/fsb_xxxxx_3cp_pju_90s000_v1.lbl) | `e8d6936938a6fa87539b709d408884ea34c306bbc0986fe6a116cd2d75bb1dfd` |
| `cpr.xml` | [XML](https://pds-geosciences.wustl.edu/lunar/ch1-orb-l-mrffr-1-pdr-v1/ch1mrf_0xxx/data/sar/mosaics/fsb_xxxxx_3cp_pju_90s000_v1.xml) | `411942324e804596fc3e44eb7d65fda46ed63b4dd17757197dc932ea0b5853a7` |

The alternate GDR IMG, LBL and XML SHA-256 digests were
`ea1861ca79a0edce91629ba8528f29ff4646cd9dce380e47646ca7d32ff5c7ae`,
`3bf92358121dad70fe609f2fa0006f7c1a1c4394ac44dcda877386ad54846565`,
and `26e17222874a8c5c770cb393eb47b709694c18e7c0ad877e03e42280e324b747`.
The [NASA catalog designates the Mini-SAR archive public](https://data.nasa.gov/dataset/ch1-orb-moon-mini-rf-5-polar-mosaic-calibrated-data-rec-v1-0-7afa2)
and points to the U.S. Government works policy. The Diviner files quoted here
are from the public NASA PDS archive, with attribution to the UCLA Diviner
team and the corresponding product paper.

## Existing MoonFall build and viewer

The deployed MoonFall catalog declares `MOON_ME_DE421` for the Moon and its
terrain. Live HTTP checks returned the terrain, WAC, NAC, and stretched PSR
NAC manifests with HTTP 200 and the viewer origin allowed. The pinned revisions
were `cube-fused-79895697c6b6-g3-m12-b6747ec9d`,
`cube-imagery-base-8382ea2b8d3b8ff4`, `cube-imagery-nac-48f50054db064666`, and
`cube-imagery-raster-997ebce1d5066c40`. The last is acquired imagery with a
display stretch.

In Chrome using ANGLE Metal on the Apple M4 Max, the deployed demo reached
imagery level 6 at 13.1 seconds in one cold run. At that moment it reported
55 imagery blocks, 67 imagery requests, and 1,537,106 imagery bytes, while
the model loading screen was still visible. A cold retry reached the
Surface Layers control at 23.2 seconds with no failed requests. The local
route exposed Surface Layers with terrain and WAC/NAC visible at 5.8 seconds.
Those measurements describe different readiness points in single runs.

The current surface plan validates IAU frames and two channels, imagery and
elevation. The finite executor runs from a locked inventory through checksummed
output and an immutable publication receipt. The catalog rewriter can map
new dataset prefixes once they have a publication pin. The missing #307 piece
is a numeric science product in this path with explicit frame evidence, a
documented valid mask and per-source native sampling. The missing #285 piece is
a consumer that binds numeric tiles to the existing body-fixed cube addressing,
queues and residency budget. The optical compositor currently uses RGBA texture
pages, filtered samples and optical lighting. Science display needs a
mask-aware numerical sampler and an unlit palette contribution on the same
terrain mesh. Numeric queries need to report the source value or lack of
observation independently of the camera LOD and palette. Use Surface Layers
for controls and existing surface/feature selections for probes.

GitHub Pages deploys off `main`. The PSR GeoJSON is bundled with the catalog
as a content-addressed static Pages asset, like the existing Places files.
Its live URL and the changed catalog depend on an authorized main deployment.

## Later candidates

- M³ surface-exposed ice detections, [Li et al. (2018)](https://doi.org/10.1073/pnas.1802345115).
  The publication and supporting information are indexed. A reusable published
  detection mask and its coordinates remain to be verified.
- [LRO Mini-RF](https://pds-geosciences.wustl.edu/missions/lro/mrf.htm) and
  [KPLO ShadowCam](https://pds.shadowcam.im-ldi.com/). Archives identified.
  A specific independently registered product remains to be evaluated for each.
- [LOLA topography, roughness and elevation uncertainty](https://pgda.gsfc.nasa.gov/products/90),
  [polar illumination](https://pgda.gsfc.nasa.gov/products/69), and
  [Artemis regional products](https://pgda.gsfc.nasa.gov/products/104).
  Original provider downloads are indexed. Exact product bytes and
  suitability for integration remain to be checked.
- [LEND](https://pds-geosciences.wustl.edu/missions/lro/lend.htm) neutron-derived
  hydrogen and [LAMP](https://pds-geosciences.wustl.edu/missions/lro/lamp.htm)
  ultraviolet products. Archives identified. South-pole derived products,
  coverage and registration remain to be audited.
