"""Run with python3 -m unittest discover -s scripts/terrain -p test_pack_science_raster.py."""
import unittest

import numpy as np

from pack_science_raster import aggregate_overview


class OverviewTests(unittest.TestCase):
    def test_odd_stride_retains_signed_samples_and_partial_edge_cells(self):
        data = np.array([
            [0, np.nan, -6, np.nan],
            [np.nan, np.inf, np.nan, 10],
            [3, np.nan, 3, 20],
            [np.nan, np.nan, np.nan, 30],
        ], dtype=np.float32)
        overview = aggregate_overview(data, 3, categorical=False)
        np.testing.assert_allclose(overview[..., 0], [[0, 15], [np.nan, 30]])
        np.testing.assert_allclose(overview[..., 1], [[4 / 9, 2 / 3], [0, 1]])

    def test_even_stride_keeps_mixed_ids_and_holes_as_coverage_only(self):
        ids = np.array([
            [5, 13, 0, 0, 0],
            [5, 0, 0, 0, 13],
            [0, 0, 13, 13, 5],
        ], dtype=np.uint16)
        np.testing.assert_array_equal(
            aggregate_overview(ids, 2, categorical=True),
            [[0.75, 0, 0.5], [0, 1, 1]],
        )
        self.assertEqual(ids[0, 1], 13)
        self.assertEqual(ids[1, 1], 0)
