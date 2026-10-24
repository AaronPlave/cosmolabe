#!/usr/bin/env python3
"""Mask/fallback and anti-aliasing regressions on observed-raster code paths."""
from pathlib import Path
import sys
import tempfile
import unittest
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'surface-build'))
from worker import prepare_imagery, reject_external_masks, valid_subset
from validate_imagery import validate_large_native
import cube_imagery as cube
from osgeo import gdal,osr
import numpy as np

gdal.UseExceptions()

class RasterImageryTests(unittest.TestCase):
    def test_native_window_reference_catches_shifted_large_source_output(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source=root/'original.tif'
            y,x=np.mgrid[:1024,:1024]
            self.create(source,(20+(x*.1+y*.15)%200).astype(np.uint8))
            cube.R_KM=3396.19;tiles=[]
            for xx,yy in [(65535,65535),(65536,65535),(65535,65536),(65536,65536)]:
                key=f'px/17/{xx}/{yy}';tiles.append(key)
                path=root/'tiles'/f'{key}.png';path.parent.mkdir(parents=True,exist_ok=True)
                cube.write_image(str(path),cube.nac_tile(str(source),'px',17,xx,yy,128,2,4))
            meta={'tileSize':128,'gutter':2,'maxLevel':17,'tiles':tiles,'generator':{'supersample':4}}
            result=validate_large_native(gdal.Open(str(source)),meta,root/'imagery.json',None)
            self.assertGreaterEqual(result['checkedPixels'],64)
            self.assertLessEqual(result['maximumErrorDn'],.501)
            self.assertGreater(result['checkedGutterPixels'],0)
            path=root/'tiles'/f'{tiles[0]}.png';image=gdal.Open(str(path)).ReadAsArray().transpose(1,2,0)
            image[66,66,0]=min(255,int(image[66,66,0])+5);cube.write_image(str(path),image)
            with self.assertRaisesRegex(AssertionError,'registration'):
                validate_large_native(gdal.Open(str(source)),meta,root/'imagery.json',None)

    def create(self,path,data,mask=None,external=False):
        srs=osr.SpatialReference();srs.ImportFromProj4('+proj=eqc +lat_ts=0 +lon_0=0 +R=3396190 +units=m +no_defs')
        h,w=data.shape
        ds=gdal.GetDriverByName('GTiff').Create(str(path),w,h,1,gdal.GDT_Byte)
        ds.SetGeoTransform((-w/2,1,0,h/2,0,-1));ds.SetProjection(srs.ExportToWkt())
        ds.GetRasterBand(1).WriteArray(data)
        if mask is not None:
            gdal.SetConfigOption('GDAL_TIFF_INTERNAL_MASK','NO' if external else 'YES')
            try: ds.GetRasterBand(1).CreateMaskBand(gdal.GMF_PER_DATASET)
            finally: gdal.SetConfigOption('GDAL_TIFF_INTERNAL_MASK',None)
            ds.GetRasterBand(1).GetMaskBand().WriteArray(mask)
        ds=None

    def test_internal_mask_outside_native_subset_stays_transparent_and_falls_back(self):
        with tempfile.TemporaryDirectory() as d:
            src=Path(d)/'masked.tif';filtered=Path(d)/'filtered.tif'
            a=np.full((1024,1024),80,np.uint8);a[:,:512]=250
            mask=np.full(a.shape,255,np.uint8);mask[:,:512]=0
            self.create(src,a,mask)
            ds=gdal.Open(str(src),gdal.GA_Update);ds.BuildOverviews('AVERAGE',[2,4,8,16]);ds=None
            ds=gdal.Open(str(src));self.assertIsNone(ds.GetRasterBand(1).GetNoDataValue())
            # Evidence is deliberately only in the valid eastern part; invalid
            # pixels outside this declared subset must still fall through.
            gt=tuple(v*180/np.pi/3396190 if i in (0,1,3,5) else v for i,v in enumerate(ds.GetGeoTransform()))
            unit=180/np.pi/3396190
            geo={'type':'FeatureCollection','features':[{'type':'Feature','id':'valid','geometry':{'type':'Polygon','coordinates':[[[100*unit,-50*unit],[150*unit,-50*unit],[150*unit,50*unit],[100*unit,50*unit],[100*unit,-50*unit]]]}}]}
            proof=valid_subset(ds,{'metadata':{'validData':{'geometry':geo,'extent':'known-valid-subset'}}},gt)
            self.assertGreater(proof['features'][0]['nativeCells'],0)
            reject_external_masks(src);prepare_imagery(src,filtered);cube.R_KM=3396.19
            for path in (src,filtered):
                value,alpha=cube.raster_tile(str(path),'px',14,8192,8191,32,2,4)
                self.assertEqual(float(alpha[4:-4,4:-4].max()),0,'invalid byte values must never become opaque')
                np.testing.assert_allclose(value[alpha>0],80,atol=1e-5)
                fallback=alpha*value+(1-alpha)*20
                np.testing.assert_allclose(fallback[4:-4,4:-4],20)
            image=cube.nac_tile(str(filtered),'px',14,8192,8191,32,2,4)
            png=Path(d)/'emitted.png';cube.write_image(str(png),image)
            emitted=gdal.Open(str(png)).ReadAsArray()
            np.testing.assert_array_equal(emitted[1,4:-4,4:-4],0)
            np.testing.assert_allclose(emitted[1,4:-4,4:-4]/255*emitted[0,4:-4,4:-4]+(1-emitted[1,4:-4,4:-4]/255)*20,20)
            self.assertTrue(np.any((image[...,1]>0)&(image[...,1]<255)),'filtered mask edge must preserve partial coverage')
            value,alpha=cube.raster_tile(str(filtered),'px',14,8192,8192,32,2,4)
            self.assertGreater(float(alpha.max()),.99)
            np.testing.assert_allclose(value[alpha>.99],80,atol=1e-5)
            # A footprint partially outside the raster must normalize only its
            # covered samples, rather than brighten the covered part.
            value,alpha=cube.raster_tile(str(filtered),'px',13,4096,4096,32,2,4)
            self.assertTrue(np.any((alpha>0)&(alpha<1)))
            np.testing.assert_allclose(value[alpha>0],80,atol=1e-5)
            ext=Path(d)/'external.tif' ;self.create(ext,a,mask,external=True)
            with self.assertRaisesRegex(AssertionError,'external mask dependencies'):reject_external_masks(ext)

    def test_coarse_checkerboard_matches_area_reference_and_adjacent_lods(self):
        with tempfile.TemporaryDirectory() as d:
            src=Path(d)/'checker.tif';filtered=Path(d)/'filtered.tif'
            a=(20+200*(np.indices((1024,1024)).sum(axis=0)%2)).astype(np.uint8)
            self.create(src,a);receipt=prepare_imagery(src,filtered)
            self.assertIn(4,receipt['overviewFactors']);cube.R_KM=3396.19
            means=[]
            for level in (14,15):
                xy=2**(level-1)
                result,alpha=cube.raster_tile(str(filtered),'px',level,xy,xy,32,2,4)
                reference,ra=cube.raster_tile(str(src),'px',level,xy,xy,32,2,64)
                self.assertGreater(float(alpha.min()),.999)
                self.assertLess(float(np.max(np.abs(result-reference))),1)
                np.testing.assert_allclose(result,120,atol=.001)
                means.append(float(result.mean()))
            self.assertLess(abs(means[0]-means[1]),.001,'coarse LOD transition must preserve the area average')
            raw,_=cube.raster_tile(str(src),'px',14,8192,8192,32,2,1)
            self.assertGreater(float(np.std(raw)),10,'fixture must expose single-sample aliasing')

if __name__=='__main__':unittest.main()
