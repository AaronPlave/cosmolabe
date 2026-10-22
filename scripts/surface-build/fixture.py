#!/usr/bin/env python3
"""Tiny synthetic assets; not real Skyfall geometry, Mars source data or DTM coverage."""
import sys
from pathlib import Path
import numpy as np
from osgeo import gdal, osr

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
osr.UseExceptions()
srs = osr.SpatialReference()
srs.ImportFromProj4('+proj=longlat +a=3396190 +b=3396190 +no_defs')
for name, width, height, grid in [('base', 360, 180, (-180, 1, 0, 90, 0, -1)),
                                  ('detail', 32, 32, (-20, 1.25, 0, 20, 0, -1.25))]:
    ds = gdal.GetDriverByName('GTiff').Create(str(out / f'{name}.tif'), width, height, 1, gdal.GDT_Float32)
    ds.SetGeoTransform(grid)
    ds.SetProjection(srs.ExportToWkt())
    ds.GetRasterBand(1).Fill(1000)
    ds = None
for name, colour, dimension in [('context', [25, 50, 75, 255], 32), ('detail-image', [180, 70, 20, 255], 512)]:
    ds = gdal.GetDriverByName('MEM').Create('', dimension, dimension, 4, gdal.GDT_Byte)
    for i, value in enumerate(colour):
        if name == 'detail-image' and i < 3:
            yy,xx=np.indices((dimension,dimension))
            pattern=((xx//4+yy//4)%2)*40
            ds.GetRasterBand(i + 1).WriteArray((value+pattern).astype(np.uint8))
        else:
            ds.GetRasterBand(i + 1).Fill(value)
    gdal.GetDriverByName('PNG').CreateCopy(str(out / f'{name}.png'), ds)

# Controlled MEG016-layout datum fixture, not an observed MOLA product. Keep the
# official detached layout to exercise GDAL's PDS reader and paired staging.
np.full((2880, 5760), 190, dtype='>i2').tofile(out / 'MEGA90N000EB.IMG')
(out / 'MEGA90N000EB.LBL').write_text('''PDS_VERSION_ID = PDS3
RECORD_TYPE = FIXED_LENGTH
RECORD_BYTES = 11520
FILE_RECORDS = 2880
^IMAGE = "MEGA90N000EB.IMG"
OBJECT = IMAGE
 NAME = AREOID_RADIUS
 LINES = 2880
 LINE_SAMPLES = 5760
 SAMPLE_TYPE = MSB_INTEGER
 SAMPLE_BITS = 16
 SCALING_FACTOR = 1
 OFFSET = 3396000
END_OBJECT = IMAGE
OBJECT = IMAGE_MAP_PROJECTION
 MAP_PROJECTION_TYPE = "SIMPLE CYLINDRICAL"
 A_AXIS_RADIUS = 3396.0 <KM>
 B_AXIS_RADIUS = 3396.0 <KM>
 C_AXIS_RADIUS = 3396.0 <KM>
 CENTER_LATITUDE = 0.0
 CENTER_LONGITUDE = 180.0
 POSITIVE_LONGITUDE_DIRECTION = "EAST"
 MAP_RESOLUTION = 16.0 <PIXEL/DEGREE>
 MAP_SCALE = 3.705 <KM/PIXEL>
 LINE_PROJECTION_OFFSET = 1440.5
 SAMPLE_PROJECTION_OFFSET = 2880.5
 COORDINATE_SYSTEM_NAME = "PLANETOCENTRIC"
END_OBJECT = IMAGE_MAP_PROJECTION
END
''')
