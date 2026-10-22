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
for name, colour, dimension in [('context', [25, 50, 75, 255], 32), ('detail-image', [180, 70, 20, 255], 256)]:
    ds = gdal.GetDriverByName('MEM').Create('', dimension, dimension, 4, gdal.GDT_Byte)
    for i, value in enumerate(colour):
        ds.GetRasterBand(i + 1).Fill(value)
    gdal.GetDriverByName('PNG').CreateCopy(str(out / f'{name}.png'), ds)
