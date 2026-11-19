"""Offline checks for the Apollo 17 raster and normalization conventions."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import unittest

import numpy as np
from osgeo import gdal, osr

spec = spec_from_file_location('apollo17_pilot', Path(__file__).with_name('apollo17-pilot.py'))
pilot = module_from_spec(spec)
spec.loader.exec_module(pilot)


class Apollo17ProcessingTest(unittest.TestCase):
    def test_affine_matches_the_published_native_projection(self):
        native = osr.SpatialReference()
        native.ImportFromProj4('+proj=eqc +lon_0=180 +lat_ts=20 +R=1737400 +units=m')
        raster = gdal.GetDriverByName('MEM').Create('', 16, 16)
        raster.SetSpatialRef(native)
        raster.SetGeoTransform((-4252681, .5, 0, 613441.5, 0, -.5))
        geographic = native.CloneGeogCS()
        geographic.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        transform = osr.CoordinateTransformation(native, geographic)
        affine = pilot.native_geographic(raster)
        for col, row in [(0, 0), (0.5, 0.5), (16, 16)]:
            x, y = gdal.ApplyGeoTransform(raster.GetGeoTransform(), col, row)
            expected = transform.TransformPoint(x, y)[:2]
            np.testing.assert_allclose(gdal.ApplyGeoTransform(affine, col, row), expected, atol=1e-11, rtol=0)

    def test_pds_special_values_and_empirical_response(self):
        sentinels = np.arange(0xff7ffffb, 0xff800000, dtype=np.uint32).view(np.float32)
        self.assertTrue(pilot.special_mask(sentinels).all())
        self.assertEqual(pilot.special_mask(np.array([-.12, .12, np.nan], dtype=np.float32)).tolist(),
                         [False, False, True])
        # Fixed checks at reference geometry and a darker, more oblique geometry.
        reference = pilot.empirical(30, 0, 30)
        self.assertAlmostEqual(reference, 0.0875983228, places=9)
        self.assertGreater(reference, pilot.empirical(73, 22, 61))

    def test_shadow_follows_azimuth_on_a_known_terrain(self):
        height = np.zeros((20, 28), dtype=np.float32)
        height[:, 17] = 8
        shadow = pilot.cast_shadows(height, 2, 90, 18, bias_m=.1)
        self.assertTrue(shadow[10, 10:17].all())
        self.assertFalse(shadow[10, 17:].any())
        self.assertFalse(shadow[10, :5].any())
        np.testing.assert_array_equal(pilot.cast_shadows(height[:, ::-1], 2, 270, 18, bias_m=.1),
                                      shadow[:, ::-1])


if __name__ == '__main__':
    unittest.main()
