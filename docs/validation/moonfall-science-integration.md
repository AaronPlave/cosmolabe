# MoonFall south-pole science

The normal MoonFall catalog requires `moonfall-science.json`. Surface Layers
starts with all three science layers off. Enable and adjust them independently, then use
Point Probe or select a named place to read their native samples. Point Probe
can select a mapped shadow region and show its exact boundary at close range.
The product uses the existing terrain depth, displacement and tile fades.
Science readings and coverage stay fixed as the simulation time changes.

## Permanent shadow

The [NASA PGDA release](https://pgda.gsfc.nasa.gov/products/90) contains 1,531
modeled PSR features larger than 1 km², derived from 20 m LOLA topography.
The 160 m overview uses the fraction of an aligned 2 × 2 block of native
80 m samples that are inside any mapped region. That fraction scales opacity.
Point Probe identifies individual regions on the original 80 m grid. Every source feature is packaged separately, preserving
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
sites have no valid cell. The 270 m display uses the mean of finite native 90 m values in each
3 × 3 block, with opacity proportional to its observed fraction. Empty
blocks stay transparent. PSR and radar overview blocks use the native grid
origin, and partial edge blocks clip to the original footprint. Point Probe
uses native 90 m tiles, including signed values and nodata. The revised
radar overview retains 19,476 partially observed cells missed by the old
center sample. The PSR overview retains coverage in 34,600 additional cells.

### Targeted X-band observations

The [PDS Mini-RF bistatic archive](https://doi.org/10.17189/c3ym-tk17) provides
the two separately hosted X-band CPR products tested during development.
The normal MoonFall catalog uses the regional S-band mosaic. Actual backplanes
from 17 swaths showed why the ODE bounding
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
geometries. Haworth's gazetteer
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
  [PSR build](https://data.aaronplave.com/science-raster/moon-psr/p2-79496e2f44a49200/science.json)
  and [Diviner build](https://data.aaronplave.com/science-raster/moon-diviner-summer-max/d1-90a09af641e79b00/science.json).
  It also verified the [Haworth](https://data.aaronplave.com/science-raster/moon-minirf-haworth/r1-7109289e364b5297/science.json)
  and [Amundsen](https://data.aaronplave.com/science-raster/moon-minirf-amundsen/r1-bd39f3a1b49193e9/science.json)
  CPR builds and the [regional δCPR mosaic](https://data.aaronplave.com/science-raster/moon-minirf-south-pole/m2-49f0257b30403126/science.json).

The revised PSR and radar builds change only their overviews. Every native
tile and exact-geometry file has the previous build's SHA-256. The Diviner
stride-one rebuild reproduced its previous manifest byte for byte.
Point Probe displays the shortest decimal that round-trips to the native
Float32. The text precision describes the stored value.

The production catalog requested zero science files at startup. Enabling
all three layers, changing radar opacity, then jumping to the Haworth
observation and picking the ground showed GID 2, 63.67955 K and δCPR
0.49637052. Selecting the GID drew the exact boundary. All 1,531 IDs occur
in the native shadow grid. The Amundsen GID 5 geometry retained 67 holes,
and a control inside one returned no mapped region. Native readings at
Shackleton, Haworth, Amundsen, Connecting Ridge and Polaris A–D agreed
with the original rasters and stayed fixed through a two-hour time seek.
At the Polaris bases only C had a radar sample (0.7029259). Named Places
showed the same precision as Point Probe. Hiding the layers removed the
products and terrain proxies. The browser reported zero WebGL errors.

## Hardware Chrome results

Apple M4 Max, ANGLE Metal, DPR 2, 2880 × 1800 framebuffer. Two fixed-orientation
dolly cycles per 4.9-second measurement near Haworth. CPU is whole renderer
time. GPU is WebGL2 elapsed time. The selected outline is Haworth GID 2.

| Path | Layers | CPU median / p95 (ms) | GPU median / p95 (ms) | Frames | Frame interval p95 (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| 4–36 km | Off | 7.7 / 9.0 | 2.41 / 5.92 | 294 | 17.6 |
| 4–36 km | PSR | 7.4 / 8.3 | 1.51 / 1.98 | 294 | 17.5 |
| 4–36 km | Diviner | 7.3 / 8.0 | 2.83 / 4.61 | 295 | 17.6 |
| 4–36 km | δCPR | 7.4 / 8.3 | 2.41 / 4.08 | 294 | 17.5 |
| 4–36 km | All three | 7.3 / 8.1 | 4.04 / 5.05 | 294 | 17.5 |
| 4–36 km | All three + exact outline | 7.4 / 8.2 | 4.60 / 7.13 | 295 | 17.5 |
| 4–36 km | Off, repeat | 7.1 / 8.0 | 3.77 / 5.47 | 295 | 17.5 |
| 67–600 km | Off | 12.1 / 16.5 | 2.82 / 7.16 | 294 | 17.6 |
| 67–600 km | PSR | 14.2 / 21.7 | 2.49 / 7.34 | 272 | 22.9 |
| 67–600 km | Diviner | 14.5 / 19.4 | 2.50 / 3.68 | 281 | 20.2 |
| 67–600 km | δCPR | 14.4 / 18.6 | 2.45 / 4.70 | 287 | 19.1 |
| 67–600 km | All three | 13.9 / 18.9 | 3.31 / 5.59 | 285 | 19.5 |
| 67–600 km | All three + exact outline | 14.1 / 18.5 | 5.72 / 11.11 | 287 | 19.2 |
| 67–600 km | Off, repeat | 13.7 / 18.4 | 2.13 / 5.63 | 288 | 18.9 |

At close range, all three and the off runs delivered 294–295 frames, with
0–1 gaps estimated to span multiple 60 Hz refreshes. With all three from
orbit, CPU p95 was 0.5 ms over the repeated off run and 2.4 ms over the first.
The all-layer orbital run delivered three fewer frames than repeated off.
The terrain update alone accounted for 11.4 ms CPU p95 with all three on and
11.1 ms repeated off. Raster traversal plus submission accounted for 0.2 ms
CPU p95. The first off run had lower terrain cost. The selected outline run
had a higher GPU tail, 11.11 ms p95, with similar pacing to the repeated
off run.

The polar raster drape allows one 24-bit depth step for rounding differences
between the terrain and raster shaders. In an oblique DPR-2 Chrome replay at
Polaris-C, the change restored 144,516–151,326 Diviner pixels and 68,136–79,403
Mini-RF pixels across seven camera positions. The depth-disabled comparison
still exposed 14,900–31,807 Mini-RF pixels that the fixed shader kept hidden.
