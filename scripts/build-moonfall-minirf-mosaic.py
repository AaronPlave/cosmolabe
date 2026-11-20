#!/usr/bin/env python3
"""Package the archived LRO Mini-RF south-pole δCPR mosaic."""
import argparse
import hashlib
from pathlib import Path

import numpy as np
from osgeo import gdal

from terrain.pack_science_raster import pack

SOURCE = {
    "product": "SouthDeltaCPR_mean80s_v3-offsetto49d.tif",
    "url": "https://doi.org/10.48732/VZJT-1634",
    "downloadUrl": "https://archive.data.jhu.edu/file.xhtml?fileId=16774&version=1.0",
    "reference": "Fassett et al. (2024), doi:10.3847/PSJ/ad0a61, Figure 7",
    "originalSha256": "477cc18f22f6a736cf996aeb6c49bdc23cc75b2a8825733b2f095e210faf7d91",
    "archiveSha256": "508ef63ee3515f3631fdf6e775f735aab5704eb9ae6feb05a52eb6f9898bc0d6",
    "originalResolutionM": 90,
    "statistic": "LRO Mini-RF monostatic S-band observed CPR minus fitted CPR at the local incidence angle, plus the archive's 0.42 reference offset at 49 degrees",
    "registration": "Authors orthorectified polar observations onto LOLA. The archive projection, paired backscatter grid, and local terrain comparisons support use in the MoonFall lunar mean-Earth frame. No scene-fit shift applied.",
    "license": "CC BY 4.0",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output must be a new directory")
    with args.archive.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != SOURCE["archiveSha256"]:
            parser.error("archive SHA-256 differs from the locked Johns Hopkins ZIP")
    gdal.UseExceptions()
    dataset = gdal.Open(f"/vsizip/{args.archive.resolve()}/{SOURCE['product']}")
    transform = dataset.GetGeoTransform()
    projection = dataset.GetSpatialRef().ExportToProj4().split()
    expected = {"+proj=stere", "+lat_0=-90", "+lon_0=0", "+x_0=0", "+y_0=0", "+R=1737400", "+k=1"}
    if not expected.issubset(projection) or transform != (-304080, 90, 0, 304080, 0, -90):
        parser.error("unexpected polar grid")
    band = dataset.GetRasterBand(1)
    values = band.ReadAsArray()
    valid = band.GetMaskBand().ReadAsArray() != 0
    if values.shape != (6940, 6757) or values.dtype != np.float32 or valid.sum() != 35287872:
        parser.error("unexpected δCPR grid or coverage")
    values[~valid] = np.nan
    west, step, _, north, _, _ = transform
    print(pack(args.output, values, (west, north, step), display_stride=3,
               polar_limit_deg=-80, source=SOURCE))


if __name__ == "__main__":
    main()
