"""Flight estimates retain observations and expose summary conflicts."""
import sys
sys.dont_write_bytecode = True
import unittest
import numpy as np
from reconstruct_ingenuity import path_schedule
from import_ingenuity_log import parse_table
from audit_ingenuity_pds import geometry
from pathlib import Path


class ReconstructionTests(unittest.TestCase):
    def test_archived_pds_frame_chain_reproduces_the_documented_site3_position(self):
        label=Path(__file__).resolve().parents[2]/'docs/validation/ingenuity-jezero/evidence/flight-12-pds-label.xml'
        position,utc,sclk=geometry(label)
        np.testing.assert_allclose(position,[-685.176,-600.487,-10.574],atol=.0005)
        self.assertTrue(utc.startswith('2021-08-16T12:59:10.'))
        self.assertAlmostEqual(sclk,682390538.5789139)

    def test_preserves_path_knots_and_smooth_stationary_ascent(self):
        points = np.array([[77.4,18.4],[77.401,18.4],[77.401,18.401]])
        t, xy, alt, metrics = path_schedule(points, 100, 10, 4)
        self.assertTrue(np.all(np.diff(t)>0))
        self.assertEqual(t[0], 0)
        self.assertEqual(t[-1], 100)
        np.testing.assert_array_equal(xy[[0,-1]], points[[0,-1]])
        for p in points:
            self.assertTrue(np.any(np.all(xy == p, axis=1)))
        self.assertEqual(alt[0], 0)
        self.assertEqual(alt[-1], 0)
        self.assertEqual(alt.max(), 10)
        self.assertTrue(np.all(alt>=0))
        self.assertLessEqual(metrics['modeledMaxGroundspeedMS'], 4)
        climbing = t < metrics['climbDurationS']
        np.testing.assert_array_equal(xy[climbing], np.repeat(points[:1], climbing.sum(), axis=0))

    def test_duplicates_and_hover_do_not_generate_repeated_epochs(self):
        points = np.array([[77.4,18.4]]*20)
        t, xy, alt, metrics = path_schedule(points,39.1,3,0)
        self.assertTrue(np.all(np.diff(t)>0))
        self.assertEqual(metrics['modeledMaxGroundspeedMS'],0)
        self.assertEqual(alt.max(),3)

    def test_conflicting_zero_speed_does_not_erase_observed_horizontal_path(self):
        points = np.array([[77.4,18.4],[77.401,18.4],[77.4,18.4]])
        t, xy, alt, metrics = path_schedule(points,32,12,0)
        self.assertGreater(metrics['modeledMaxGroundspeedMS'],0)
        self.assertTrue(np.any(np.all(xy == points[1], axis=1)))

    def test_missing_log_rows_fail_closed(self):
        with self.assertRaisesRegex(ValueError,'72 NASA'):
            parse_table(' 1 58 2021 0 0 3 ~10 0 0 39.1 Wright Brothers Field')


if __name__ == '__main__':
    unittest.main()
