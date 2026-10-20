"""Independent numerical fixtures for cube-tile's explicit source conversions.

Run: PYTHONDONTWRITEBYTECODE=1 python3 scripts/terrain/test_cube_ellipsoid.py
"""
import math
import argparse
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import dem
from osgeo import gdal, osr


class EllipsoidConversion(unittest.TestCase):
    def tearDown(self):
        dem._T.clear()

    def test_normal_height_on_strongly_flattened_body(self):
        a, c = 100000.0, 50000.0
        dem._T.update(radius=a, cube_ellipsoid=(a, c), cube_source_convention='ellipsoid-normal')
        for height in (-2000.0, 0.0, 2000.0):
            for lat in (-90, -65, -35, 0, 35, 65, 90):
                phi = math.radians(lat)
                e2 = 1 - c * c / (a * a)
                n = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
                # Independent forward geodetic formula supplies the expected
                # Cartesian point and ray; the builder solves the inverse problem.
                x, z = (n + height) * math.cos(phi), (n * (1 - e2) + height) * math.sin(phi)
                radial_lat = math.degrees(math.atan2(z, x))
                with patch.object(dem, 'field_heights', lambda lon, la, sp: height + 10 * (la - lat)):
                    offset = dem.cube_field_heights(np.array([0.0]), np.array([radial_lat]), 0.1)[0]
                self.assertAlmostEqual(offset + a, math.hypot(x, z), places=5)
                if abs(lat) == 35 and height:
                    zero_r = 1 / math.sqrt((math.cos(math.radians(radial_lat)) / a) ** 2 + (math.sin(math.radians(radial_lat)) / c) ** 2)
                    self.assertGreater(abs(math.hypot(x, z) - zero_r - height), 100)

    def test_areoid_is_added_before_geodetic_interpretation(self):
        dem._T.update(radius=100000.0, cube_source_convention='areoid-radial',
                      areoid=(np.array([[100, 200, 300, 400], [10, 20, 30, 40]]), (-180, 90, 0, 90, 0, -90), 2, 90000))
        with patch.object(dem, 'field_heights', lambda lon, lat, sp: np.full(lon.shape, -4000.0)):
            # Exact pixel centre: radius 90200 - 4000, not ellipsoid radius - 4000.
            got = dem.cube_field_heights(np.array([-135.0]), np.array([45.0]), 1)[0]
            self.assertEqual(got, -13800.0)
            seam = dem.cube_field_heights(np.array([-180.0, 180.0]), np.array([0.0, 0.0]), 1)
            self.assertEqual(seam[0], seam[1])

    def test_emitted_flattened_lattice_and_metadata(self):
        with tempfile.TemporaryDirectory(prefix='cube-oblate-') as tmp:
            a, c, height = 100000.0, 50000.0, -1000.0
            srs = osr.SpatialReference()
            srs.SetFromUserInput(f'+proj=longlat +R={a}')
            gt = (-180, 1, 0, 90, 0, -1)
            base = os.path.join(tmp, 'base.tif')
            dem.write_tif(base, np.full((180, 360), height, np.float32), gt, srs.ExportToWkt())
            dem.write_tif(os.path.join(tmp, 'residual.tif'), np.zeros((180, 360), np.float32), gt, srs.ExportToWkt())
            with open(os.path.join(tmp, 'fusion.json'), 'w') as f:
                json.dump({'base': {'path': base}, 'detail': {'path': base}, 'verticalDatum': 'synthetic ellipsoid-normal metres'}, f)
            out = os.path.join(tmp, 'product')
            dem.cmd_cube_tile(argparse.Namespace(base=base, fusion=tmp, out=out, global_level=0, region=[],
                skirt_cells=0.1, simplify=0, ellipsoid=[a, c], workers=1, source_convention='ellipsoid-normal',
                areoid=None, body='Fixture', frame='FIXTURE_FIXED'))
            manifest = json.loads(Path(out, 'cpu-grids.json').read_text())
            product = json.loads(Path(out, 'terrain-product.json').read_text())
            tileset = json.loads(Path(out, 'tileset.json').read_text())
            self.assertEqual(manifest['datum'], product['datum'])
            self.assertEqual(manifest['source']['version'], tileset['asset']['tilesetVersion'])
            self.assertEqual(manifest['coordinates']['frame'], 'FIXTURE_FIXED')
            self.assertEqual(manifest['coordinates']['sourceLatitude'], 'planetographic')
            worst = 0
            for face in dem.CUBE_FACES:
                points, tri, extras = dem.read_glb_mesh(os.path.join(out, face, '0', '0', '0.glb'))
                surface = points[:dem.GRID ** 2]
                # Closest point to an ellipsoid via its Lagrange multiplier,
                # independent of the builder's latitude fixed-point solver.
                axes2 = np.array([a * a, a * a, c * c])
                lo = np.full(len(surface), -c * c * 0.2)
                hi = np.zeros(len(surface))
                for _ in range(64):
                    lam = (lo + hi) / 2
                    q = surface * axes2 / (axes2 + lam[:, None])
                    outside = (q * q / axes2).sum(1) > 1
                    lo, hi = np.where(outside, lam, lo), np.where(outside, hi, lam)
                q = surface * axes2 / (axes2 + ((lo + hi) / 2)[:, None])
                error = np.abs(-np.linalg.norm(surface - q, axis=1) - height)
                worst = max(worst, float(error.max()))
            self.assertLess(worst, 0.01)  # float32 local glTF coordinates, metres


if __name__ == '__main__':
    unittest.main()
