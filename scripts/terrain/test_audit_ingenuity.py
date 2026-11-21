"""Independent interpolation and fail-closed source checks for the #246 audit."""
import tempfile
import unittest
import sys
from pathlib import Path

sys.dont_write_bytecode = True

import numpy as np
from osgeo import gdal, osr

import audit_ingenuity as audit


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)/'source.tif'
        ds = gdal.GetDriverByName('GTiff').Create(str(self.path), 12, 12, 1, gdal.GDT_Float32)
        srs = osr.SpatialReference()
        srs.ImportFromProj4('+proj=longlat +R=3396190 +no_defs')
        ds.SetProjection(srs.ExportToWkt())
        ds.SetGeoTransform((70, .01, 0, 20, 0, -.01))
        y, x = np.mgrid[:12, :12]
        ds.GetRasterBand(1).WriteArray(3*x+7*y-2500)
        ds = None

    def test_pixel_centres_and_fractional_linear_field(self):
        x, y = np.array([2., 4.25, 7.7]), np.array([6., 3.4, 8.1])
        for cubic in [False, True]:
            result = audit.sample_raster(self.path, 70+(x+.5)*.01, 20-(y+.5)*.01, cubic)
            np.testing.assert_allclose(result, 3*x+7*y-2500, atol=1e-8)

    def test_rejects_nodata_in_kernel_even_at_zero_weight(self):
        ds = gdal.Open(str(self.path), gdal.GA_Update)
        b = ds.GetRasterBand(1)
        b.SetNoDataValue(-9999)
        b.WriteArray(np.array([[-9999]], dtype=np.float32), 1, 1)
        ds = b = None
        with self.assertRaisesRegex(ValueError, 'invalid interpolation support'):
            audit.sample_raster(self.path, np.array([70.025]), np.array([19.975]), True)

    def test_rejects_incomplete_source_support(self):
        with self.assertRaisesRegex(ValueError, 'incomplete source support'):
            audit.sample_raster(self.path, np.array([69.9]), np.array([19.95]))

    def test_radial_point_is_at_declared_radius_and_angle(self):
        p = audit.radial_xyz(np.array([0, 90, 77.4]), np.array([0, 0, 18.4]), np.array([10, 20, 3394000]))
        np.testing.assert_allclose(np.linalg.norm(p, axis=1), [10, 20, 3394000], atol=1e-8)
        np.testing.assert_allclose(p[:2], [[10, 0, 0], [0, 20, 0]], atol=1e-12)
        self.assertGreater(np.linalg.norm(p[2]-audit.legacy_xyz(77.4, 18.4, -2500)), 10000)

    def test_nonfinite_statistics_are_an_error(self):
        with self.assertRaisesRegex(ValueError, 'nonfinite'):
            audit.stats([float('nan')])
        self.assertEqual(audit.stats([]), {'n': 0})

    def test_areoid_rejects_wrong_label_before_reading_unpinned_image(self):
        label = Path(self.tmp.name)/'MEGA90N000EB.LBL'
        label.write_text('unverified datum')
        with self.assertRaisesRegex(ValueError, 'official MEG016 label'):
            audit.areoid_radius(label, np.array([77.4]), np.array([18.4]))


if __name__ == '__main__':
    unittest.main()
