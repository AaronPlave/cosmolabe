#!/usr/bin/env python3
"""Build MoonFall science products from two archived LRO Mini-RF X-band bistatic swaths."""
import argparse
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from osgeo import gdal, osr

from terrain.pack_science_raster import pack

ARCHIVE = "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_minirf_bistatic/data_derived/"
CAPTURES = {
    "haworth": {
        "stem": "lxt_2022353145644_{}_79s311_v1",
        "directory": "2022_353_1",
        "sha256": {
            "cpr.img": "6f97960c7f9e7f7fa57e812b4a1ea3d3bd829b9c37963a64a7cce06b2ac5ff50",
            "cpr.xml": "f2b136b8122f391eb0cc53410467d9fc2c1582fd3288c6edbcac473bb00f6879",
            "ddr.img": "3c7a4cc8a21dfd62a40bcc3c4de7d7c0a4603b338fdbbb71f9b3b3222f68d1c8",
            "ddr.xml": "e012d1be7644e6d4ccb5b14ac9c9d286452c411118b4635fffe2bcabedc21b12",
        },
    },
    "amundsen": {
        "stem": "lxt_2021251222651_{}_78s040_v1",
        "directory": "2021_251_2",
        "sha256": {
            "cpr.img": "121bedb6d15d29902827857b91fe21674ec00672a50d029537d37fb6365fbbe5",
            "cpr.xml": "b0a0de631483d9cc23ad7719715669fd00bf2033a36ea46dbd96f23c36cd3c42",
            "ddr.img": "48684fc2613446f477e9d2b3b83867a8f59dadaddc39c6d620eadc6e9dd2067c",
            "ddr.xml": "647fcb0f346bf2fdc266689a97adf846961dcc8449495fabd1d24cb12cc0f55e",
        },
    },
}
STEP = 100
RADIUS = 1_737_400
NODATA = -1e32


def south_polar_xy(lat, lon):
    r = 2 * RADIUS * np.tan(np.radians((90 + lat) / 2))
    return r * np.sin(np.radians(lon)), r * np.cos(np.radians(lon))


def reproject(cpr, latitude, longitude, work_dir):
    # The DDR explicitly supplies a longitude and latitude per CPR pixel.
    # Using those backplanes avoids depending on an oblique-CRS reader for
    # the Haworth acquisition. The PDS label identifies ME and the DE421
    # kernels used by the DDR. Output addresses are polar stereographic.
    loc = (latitude >= -90) & (latitude < 0) & (abs(longitude) <= 360)
    valid = loc & (latitude <= -80) & np.isfinite(cpr) & (cpr != np.float32(NODATA))
    x, y = south_polar_xy(np.where(loc, latitude, 0).astype(float),
                          np.where(loc, longitude, 0).astype(float))
    x[~loc] = y[~loc] = NODATA
    bounds = [np.floor(axis[valid].min() / STEP) * STEP for axis in (x, y)]
    bounds += [np.ceil(axis[valid].max() / STEP) * STEP for axis in (x, y)]
    height, width = cpr.shape
    coords_path = str(work_dir / "geolocation.tif")
    coords = gdal.GetDriverByName("GTiff").Create(coords_path, width, height, 2, gdal.GDT_Float64)
    for idx, axis in enumerate((x, y), 1):
        band = coords.GetRasterBand(idx)
        band.WriteArray(axis)
        band.SetNoDataValue(NODATA)
    coords.Close()
    reference = osr.SpatialReference()
    reference.ImportFromProj4(f"+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R={RADIUS} +units=m +no_defs")
    wkt = reference.ExportToWkt()

    source = gdal.GetDriverByName("MEM").Create("", width, height, 3, gdal.GDT_Float64)
    for idx, arr in enumerate((np.where(valid, cpr, NODATA), x, y), 1):
        band = source.GetRasterBand(idx)
        band.WriteArray(arr)
        band.SetNoDataValue(NODATA)
    source.SetMetadata({
        "SRS": wkt, "X_DATASET": coords_path, "Y_DATASET": coords_path, "X_BAND": "1", "Y_BAND": "2",
        "PIXEL_OFFSET": "0", "LINE_OFFSET": "0", "PIXEL_STEP": "1", "LINE_STEP": "1",
        "GEOREFERENCING_CONVENTION": "PIXEL_CENTER",
    }, "GEOLOCATION")
    destination = gdal.Warp("", source, format="MEM", geoloc=True, dstSRS=wkt,
                            outputBounds=bounds, xRes=STEP, yRes=STEP, srcNodata=NODATA,
                            dstNodata=NODATA, resampleAlg="near", errorThreshold=0)
    value, mapped_x, mapped_y = destination.ReadAsArray()
    west, _, _, north, _, _ = destination.GetGeoTransform()
    r, c = np.nonzero(value != NODATA)
    distance = np.hypot(west + STEP * (c + .5) - mapped_x[r, c], north - STEP * (r + .5) - mapped_y[r, c])
    # Half the diagonal of a 100 m polar pixel, allowing for the <1% change
    # of scale between the two projections at 80–90°S.
    unsupported = distance > 72
    value[r[unsupported], c[unsupported]] = NODATA
    return np.where(value == NODATA, np.nan, value).astype(np.float32), (west, north, STEP)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", choices=CAPTURES)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output must be a new directory")
    capture = CAPTURES[args.capture]
    inputs = {}
    for key, digest in capture["sha256"].items():
        quantity, extension = key.split(".")
        path = args.source / f"{capture['stem'].format(quantity)}.{extension}"
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                parser.error(f"unexpected SHA-256 for {path.name}")
        inputs[key] = path
    gdal.UseExceptions()
    cpr = gdal.Open(str(inputs["cpr.xml"])).ReadAsArray()
    ddr = np.memmap(inputs["ddr.img"], mode="r", dtype="<f4", shape=(11, *cpr.shape))
    with TemporaryDirectory() as work:
        data, grid = reproject(cpr, ddr[0], ddr[1], Path(work))
    print(pack(args.output, data, grid, display_stride=2, polar_limit_deg=-79.97, legacy_overview=True, source={
        "product": capture["stem"].format("cpr"),
        "url": f"{ARCHIVE}{capture['directory']}/{inputs['cpr.xml'].name}",
        "reference": "NASA PDS LRO Mini-RF Bistatic DDR, DOI 10.17189/c3ym-tk17",
        "originalSha256": capture["sha256"],
        "originalResolutionM": STEP,
        "registration": "Native DDR geolocation backplanes (ME, DE421); nearest source sample without gap filling.",
        "quantity": "Dimensionless X-band bistatic circular polarization ratio",
    }))


if __name__ == "__main__":
    main()
