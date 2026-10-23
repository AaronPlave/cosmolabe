#!/usr/bin/env bash
# Prerequisite: python3-gdal and python3-numpy from Ubuntu apt, with /usr/bin/python3.
set -euo pipefail
/usr/bin/python3 scripts/terrain/test_cube_ellipsoid.py
/usr/bin/python3 scripts/terrain/dem.py selftest
