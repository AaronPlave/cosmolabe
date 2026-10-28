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
    def test_point_and_area_geotiffs_preserve_the_same_gdal_pixel_centres(self):
        from worker import raster
        from audit_ingenuity import sample_raster
        radius=3396190
        k=180/(np.pi*radius)
        with tempfile.TemporaryDirectory() as folder:
            srs=osr.SpatialReference();srs.ImportFromProj4('+proj=eqc +lat_ts=0 +lon_0=0 +R=3396190 +units=m +no_defs')
            grid=(100,1,0,200,0,-1)
            values=np.arange(1024,dtype=np.float32).reshape(32,32)
            source={'projection':'Mars-EQC-0-0','nodata':'none','metadata':{'rasterGsdM':1}}
            for interpretation in ['Point','Area']:
                path=Path(folder)/(interpretation+'.tif')
                ds=gdal.GetDriverByName('GTiff').Create(str(path),32,32,1,gdal.GDT_Float32)
                ds.SetGeoTransform(grid);ds.SetProjection(srs.ExportToWkt());ds.SetMetadataItem('AREA_OR_POINT',interpretation)
                ds.GetRasterBand(1).WriteArray(values);ds=None
                result=raster(path,radius,source)
                self.assertEqual(result['areaOrPoint'],interpretation)
                self.assertEqual(result['nativeGrid'],list(grid))
                actual=sample_raster(path,np.array([110.5,111.5])*k,np.array([189.5,188.5])*k,cubic=True)
                np.testing.assert_allclose(actual,[values[10,10],values[11,11]],atol=1e-9)
                # A native void must still fail the same validity gate.
                ds=gdal.Open(str(path),gdal.GA_Update);ds.GetRasterBand(1).SetNoDataValue(float(values[10,10]));ds=None
                with self.assertRaisesRegex(AssertionError,'invalid pixels'):
                    raster(path,radius,source)

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
