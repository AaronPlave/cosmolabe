#!/usr/bin/env python3
"""Package the Diviner team's observed south-polar summer-maximum grid."""
import argparse
import hashlib
from pathlib import Path

import numpy as np
from osgeo import gdal

from terrain.pack_science_raster import pack

SOURCE = {
    "product": "polar_south_80_summer_max-float.tif",
    "url": "https://www.diviner.ucla.edu/data",
    "downloadUrl": "https://luna1.diviner.ucla.edu/~jpierre/diviner/level4_polar/additional_maps/polar_south_80_summer_max-float.tif",
    "reference": "Williams et al. (2019), doi:10.1029/2019JE006028",
    "originalSha256": "ba4a1b6275402d6b0c1000ceb0208ad63d37665afaeb902ab6f108c67c0a0c67",
    "originalResolutionM": 240,
    "period": "2009-07-05 through 2019-02-17",
    "statistic": "Maximum of south-polar summer bolometric brightness temperature bins",
    "registration": "LRO ME / DE421 mission frame; match to PDS summer-noon bin centers verified at <=1.25 m. This is grid agreement, not footprint geolocation accuracy.",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output must be a new directory")
    with args.source.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != SOURCE["originalSha256"]:
            parser.error("source SHA-256 differs from the locked Diviner GeoTIFF")
    gdal.UseExceptions()
    ds = gdal.Open(str(args.source))
    west, step, skew_x, north, skew_y, dy = ds.GetGeoTransform()
    projection = ds.GetSpatialRef().ExportToProj4().split()
    expected = {"+proj=stere", "+lat_0=-90", "+lon_0=0", "+x_0=0", "+y_0=0", "+R=1737400", "+k=1"}
    if not expected.issubset(projection) or step != -dy or skew_x or skew_y:
        parser.error("unexpected polar grid")
    data = ds.ReadAsArray()
    if data.shape != (2533, 2533) or np.isfinite(data).sum() != 5043426:
        parser.error("unexpected Diviner grid or missing data")
    print(pack(args.output, data, (west, north, step), display_stride=1, polar_limit_deg=-79.97, source=SOURCE))


if __name__ == "__main__":
    main()
