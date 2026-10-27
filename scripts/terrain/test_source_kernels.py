#!/usr/bin/env python3
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'surface-build'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from source_kernels import verify
from osgeo import gdal,osr
import numpy as np

gdal.UseExceptions()


class SourceKernelTests(unittest.TestCase):
    def test_all_used_kernels_are_valid_and_native_void_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'base.tif';manifest=root/'cpu-grids.json'
            srs=osr.SpatialReference();srs.ImportFromProj4('+proj=longlat +R=3396190 +no_defs')
            ds=gdal.GetDriverByName('GTiff').Create(str(source),32,16,1,gdal.GDT_Float32);ds.SetGeoTransform((-180,11.25,0,90,0,-11.25));ds.SetProjection(srs.ExportToWkt());ds.GetRasterBand(1).SetNoDataValue(-32768);ds.GetRasterBand(1).Fill(1000);ds=None
            manifest.write_text(json.dumps({'grid':{'width':65},'tiles':[[f,0,0,0] for f in ['px','nx','py','ny','pz','nz']]}))
            audit=verify(source,manifest)
            self.assertEqual(audit['invalidUsedKernels'],0)
            self.assertEqual(audit['levels'][0]['vertexAndNormalSamples'],6*65*65*5)
            ds=gdal.Open(str(source),gdal.GA_Update);a=ds.ReadAsArray();a[8,16]=-32768;ds.GetRasterBand(1).WriteArray(a);ds=None
            with self.assertRaisesRegex(AssertionError,'sample kernel contains nodata'):verify(source,manifest)


if __name__=='__main__':unittest.main()
