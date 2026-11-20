# MoonFall south-pole science

The normal MoonFall catalog requires `moonfall-science.json`. Surface Layers
starts with all science layers off. Enable them independently, then use
Point Probe or select a named place to read their native samples. Point Probe
can select a mapped shadow region and show its exact boundary at close range.
The product uses the existing terrain depth, displacement and tile fades.
Science readings and coverage stay fixed as the simulation time changes.

## Permanent shadow

The [NASA PGDA release](https://pgda.gsfc.nasa.gov/products/90) contains 1,531
modeled PSR features larger than 1 km², derived from 20 m LOLA topography.
The regional overlay samples feature IDs at 160 m and the probe identifies
regions on an 80 m grid. Every source feature is packaged separately, preserving
its GID, source area, components and holes. The rasterizer used GEOS MakeValid
for the five invalid source shapes (57, 116, 158, 408 and 645). Their exact
stored outlines retain the release geometry. Outside the release footprint the
layer provides no classification. Areas between mapped features can contain
shadow smaller than the source threshold.

The selected outline uses the geographic renderer and retains the original
rings. The renderer skips polygon fill triangles and uses its finer polar
grids where a coarser index would exceed its draw budget. For Amundsen's GID 5,
the original polygon would require 35,732 primitives and 140 pages. The
exact outline uses 17,846 segments, a maximum of six admitted pages and
6.65 MB of packed data. The regional raster carries the overview.

## Temperature

The [Diviner team’s GeoTIFF](https://luna1.diviner.ucla.edu/~jpierre/diviner/level4_polar/additional_maps/polar_south_80_summer_max-float.tif)
contains summer-maximum bolometric brightness temperatures in K. It derives
from July 2009–February 2019 observations from the study described by
[Williams et al.](https://doi.org/10.1029/2019JE006028). The grid stores native
Float32 values at ~240 m spacing. Its 5,043,426 observed cells span 44.89–439.00 K.
The display saturates above 350 K. Missing cells stay transparent and have
no probe value.

The GeoTIFF's spherical south polar stereographic grid is centered at 0°E,
has zero false origin and uses a 1,737,400 m radius. Independently archived PDS
summer-noon bin centers agree within 1.25 m. The TIFF maximum equals the PDS
noon value within 0.0001 K at 232,507 cells and never falls below it. A shift
of one cell in either axis produces at least 299,281 violations and reduces
the matches below 18. This checks the delivered grid against the PDS table.
The LRO mission uses the DE421 mean-Earth frame. The independent LOLA ground
controls identified cold terrain at Shackleton, Haworth and Amundsen (95.03,
63.68 and 61.34 K at the shadow-region controls) and warmer terrain at
Connecting Ridge C2 (216.67 K), in agreement with the published interpretation.
Those tests establish registration for regional exploration. Ground accuracy
is limited by the Diviner footprint and geolocation.

## Radar registration

The original [Chandrayaan-1 Mini-SAR mosaic](https://ode.rsl.wustl.edu/moon0/pagehelp/Content/Missions_Instruments/ISRO_Chandrayaan-1/Forerunner_MRFFR/MOSCDR.htm)
contains calibrated same-sense/opposite-sense CPR. The PDS catalog describes
principal-axis inputs, while the instrument specification describes a
mean-Earth body-fixed frame. The mosaic label specifies a polar projection
without naming the final realization. In ~59 km square regions, a comparison
of its companion S1 total power against independent LOLA slope gave nominal
R² of 0.210 at Haworth, 0.007 at Amundsen and 0.056 at Cabeus. The best local
diagnostic offsets were (480, −160), (1280, −320) and (1120, 960) m
east/north. The latter two hit a search edge or fit weakly, so these results
cannot establish a common correction or positional uncertainty. The catalog
preserves the original mission locations.

### Regional S-band mosaic

The [Fassett et al. mosaic](https://doi.org/10.3847/PSJ/ad0a61) uses
orthorectified LRO Mini-RF monostatic S-band observations. Its δCPR subtracts
the fitted CPR at a pixel's local incidence angle and adds the observed 49°
median (0.42). The [Johns Hopkins ZIP](https://archive.data.jhu.edu/file.xhtml?fileId=16774&version=1.0)
matched the archive's MD5 `dcecd3b504c7fe85cc886795fb180bc2`. The GeoTIFF and
its companion δS1 backscatter share the native 90 m south-polar
stereographic grid with zero false origin, 0°E central meridian, and
1,737,400 m radius. The authors orthorectified the polar acquisitions against
LOLA topography.

As an independent check, we compared high-pass δS1 with local height and
slope from Barker's adjusted 80 m LOLA DEM in 35 km windows. In a search
over ±1,280 m on each axis at 160 m intervals, the delivered coordinates
gave the best fit at Shackleton, Haworth and Amundsen for all three tested
high-pass radii (160, 320 and 640 m). The Cabeus peak was at zero for two
radii and one interval east for the third. Local backscatter can vary
independently of terrain, so these results support the regional registration
without establishing positional accuracy. The build applies no coordinate shift.

The native raster contains 35,287,872 observed cells, 98.4% of the source-grid
centers south of 80°S and 34.4% south of 89°S. At the named centers Haworth
and Amundsen read 0.3760976 and 0.4326535. The fictional Polaris-C landing
site reads 0.7029259. Shackleton's center and the Polaris-A, B and D landing
sites have no valid cell. The display uses a 270 m overview and the probe
reads the native 90 m tiles. Source gaps and signed values are preserved.

### Targeted X-band observations

The [PDS Mini-RF bistatic archive](https://doi.org/10.17189/c3ym-tk17) provides
the two X-band CPR layers in MoonFall. Actual backplanes from 17 swaths showed why the ODE bounding
polygons alone are insufficient to infer coverage. The selected Haworth
(2022-12-19) and Amundsen (2021-09-08) X-band observations use the archived
per-pixel mean-Earth coordinates and DE421 kernels. In 35 km regions, their
height backplanes agree with the independently adjusted LOLA DEM at 46.81
and 46.29 m RMS. These are vertical comparison residuals. No horizontal shift
was applied. Direct use of the Haworth PDS4 oblique projection through GDAL
differed from that acquisition's own backplanes by about 16 km, so the build
uses the backplanes for both captures.

`scripts/build-moonfall-minirf.py CAPTURE SOURCE_DIRECTORY OUTPUT_DIRECTORY`
packs each capture independently. The 100 m products preserve raw CPR values
and only remap the actual south-polar return footprint. Example samples are
1.176714 within Haworth's PSR (87.608019°S, 9.001369°W) and 0.9484395 inside
Amundsen's PSR (83.681349°S, 91.269712°E). They come from distinct viewing
geometries. Surface Layers provides a jump to each sample and identifies the
acquisition date, bistatic geometry and swath gaps. Haworth's gazetteer
anchor lies outside the Haworth swath, and Amundsen's gazetteer anchor lies
outside the Amundsen swath.

## Reproduce and verify

- Build the PSR release with `python3 scripts/build-moonfall-psr.py --regional SOURCE_DIRECTORY OUTPUT_DIRECTORY`.
- Build Diviner with `python3 scripts/build-moonfall-diviner.py ORIGINAL_GEOTIFF OUTPUT_DIRECTORY`.
  The builder checks the GeoTIFF SHA-256. For the original public archive,
  this run required per-request OpenSSL compatibility for the legacy TLS
  endpoint. See [source inventory](moonfall-science-source-audit.md).
- Build the regional radar layer with
  `python3 scripts/build-moonfall-minirf-mosaic.py SouthPole-MiniRFDeltaGeotiffs-v3.zip OUTPUT_DIRECTORY`.
  The builder checks the source ZIP SHA-256.
- Run `scripts/audit-moonfall-science.py SOURCE_DIRECTORY --summer-max ORIGINAL_GEOTIFF --radar-s1 S1_IMG --lola-control LOLA_160M_TIF`
  to repeat the numerical and registration checks. The radar diagnostic uses
  `FSB_XXXXX_3S1_PJU_90S000_V1.IMG` from the same PDS mosaic directory and
  the first 160 m overview of Barker's adjusted 80 m DEM.
- The existing publisher verified the pinned
  [PSR build](https://data.aaronplave.com/science-raster/moon-psr/p1-96725d4371967879/science.json)
  and [Diviner build](https://data.aaronplave.com/science-raster/moon-diviner-summer-max/d1-90a09af641e79b00/science.json).
  It also verified the [Haworth](https://data.aaronplave.com/science-raster/moon-minirf-haworth/r1-7109289e364b5297/science.json)
  and [Amundsen](https://data.aaronplave.com/science-raster/moon-minirf-amundsen/r1-bd39f3a1b49193e9/science.json)
  CPR builds and the [regional δCPR mosaic](https://data.aaronplave.com/science-raster/moon-minirf-south-pole/m1-3f1c3cee679c1315b/science.json).

## Hardware Chrome results

Apple M4 Max, ANGLE Metal, 2880 × 1800 framebuffer, two dolly cycles over
4.9 seconds per row. CPU measures the whole renderer call. GPU uses WebGL2
timer queries. Refresh gaps are estimated against 60 Hz.

| Navigation | CPU median / p95 (ms) | GPU median / p95 (ms) | Missed refresh intervals |
| --- | ---: | ---: | ---: |
| 4–36 km, off | 12.4 / 18.6 | 2.25 / 5.44 | 4 |
| 4–36 km, regional PSR | 11.2 / 14.8 | 2.49 / 5.10 | 0 |
| 4–36 km, PSR and Diviner | 11.1 / 15.5 | 4.28 / 6.94 | 0 |
| 4–36 km, both and exact Shackleton outline | 11.2 / 14.7 | 3.98 / 6.25 | 0 |
| 67–600 km, off | 12.8 / 18.7 | 2.96 / 6.88 | 1 |
| 67–600 km, PSR and Diviner | 14.7 / 22.5 | 3.52 / 5.61 | 12 |

The normal production catalog preview loaded both pinned R2 products and the
existing lunar data. Opening the scene and panel requested zero science
objects. On enable, PSR and Diviner took 273 and 531 ms in the successful
replay. Navigation to Haworth and Amundsen used the existing Places controls.
Their named anchors showed 65.91869 K and 211.1613 K respectively. The
Amundsen PSR floor control is at a separate coordinate. Picking that floor
displayed 61.33898 K and selected GID 5. At Shackleton the GID 13 and
95.02922 K readings stayed fixed through a two-hour time seek. Equatorial
samples returned no data. Hiding both layers released their textures and
terrain proxies. The browser recorded no WebGL errors.

The later production replay enabled all four catalog layers from R2 and
used the **Jump to observation** and **Inspect with Point Probe** controls
for both swaths. Each reading matched the archived CPR at the target. The
other swath had no sample at each target, and both radar layers returned
no value at the Shackleton control. Both measured values survived a
two-hour simulation seek. The replay requested zero science assets at
startup and released the raster textures and proxies when hidden.

With all four products enabled near the Haworth observation, a separate
DPR-2 replay measured the following frame costs. Raster draws now skip
terrain meshes whose conservative projected bounds miss the product grid.

| Haworth navigation | CPU median / p95 (ms) | GPU median / p95 (ms) | Missed refresh intervals |
| --- | ---: | ---: | ---: |
| 4–36 km, off | 7.6 / 10.0 | 3.25 / 5.45 | 0 |
| 4–36 km, all layers | 7.8 / 8.8 | 3.69 / 6.31 | 0 |
| 67–600 km, off | 13.7 / 20.2 | 2.70 / 5.53 | 5 |
| 67–600 km, all layers | 15.5 / 24.1 | 3.22 / 6.62 | 16 |

The earlier four-layer orbital replay, before mesh clipping, missed 63
intervals with nine missed in its off replay. Both runs used the same
camera path and had zero WebGL errors.

With the regional mosaic added, the same DPR-2 replay measured zero missed
intervals at close range with layers off and with all five layers enabled.
At orbital distances the off replay missed 3 intervals and the five-layer
replay missed 22. Whole-frame CPU median/p95 was 7.6/10.5 ms off and
7.9/9.3 ms on close up, and 13.6/18.7 ms off and 15.7/24.9 ms on from
orbit. GPU median/p95 was 2.45/3.51 and 3.54/6.27 ms close up, and
3.06/6.72 and 2.87/6.04 ms from orbit. There were no WebGL errors.

A second orbital replay compared the incremental cost in the same Chrome
session. Over 4.9 seconds it recorded 291 frames with science off, 262 with
only the mosaic, 278 with the original four layers and 274 with all five.
The original four and all five measured 20.0 and 20.9 ms CPU p95 and
5.15 and 5.87 ms GPU p95. Orbital frame pacing varied across runs and did
not sustain 60 Hz in the enabled cases.

The production preview loaded all five products from the existing data host.
Opening the panel fetched no science assets. The mosaic's jump and Point
Probe returned 0.4963705 in Haworth's PSR. The named centers and Polaris-C
matched the source cells, and the Shackleton center, pole and equator
returned no sample. The readings stayed fixed through a two-hour simulation
seek. Hiding the mosaic unloaded it.
