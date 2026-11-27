#!/usr/bin/env python3
"""Coarse global cube terrain with real relief, for imagery-independence fixtures (#136).

The point of these products is that their geometry is *coarse*: imagery over them must
reach source-native detail without any terrain tile being added for imagery's sake.
They are local, gitignored validation fixtures, not published terrain products.

  mars   MOLA MEGDR 16 px/deg median topography (MEGT90N000EB, metres above the MEG016
         areoid) on the IAU 2000 Mars ellipsoid with the #245 areoid-radial convention
         (MEGA90N000EB areoid radius). Global level 5: ~2.6 km vertex spacing.
  earth  ETOPO 2022 60-arc-second surface elevation (EGM2008 geoid heights, used as
         heights above WGS84 — a ≤ ±110 m datum approximation stated here, irrelevant
         at this vertex spacing) with the ellipsoid-normal convention. Global level 4.

Sources (public, no auth):
  https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/
  https://www.ngdc.noaa.gov/thredds/fileServer/global/ETOPO2022/60s/60s_surface_elev_netcdf/

dem.py needs a fusion directory; a zero residual is produced by fusing the base with an
exact crop of itself, so no detail source changes any height.
Run with a Python that has GDAL (e.g. /usr/bin/python3.12 with python3-gdal).
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()
ROOT = Path(__file__).resolve().parents[2]
DEM = str(ROOT / 'scripts/terrain/dem.py')

BODIES = {
    'mars': dict(radius=3396190.0, polar=3376200.0, body='Mars', frame='IAU_MARS', level=5, convention='areoid-radial',
                 gcs='GEOGCS["Mars 2000 sphere",DATUM["D_Mars_2000_Sphere",SPHEROID["Mars_2000_Sphere_IAU_IAG",3396190,0]],PRIMEM["Reference_Meridian",0],UNIT["degree",0.0174532925199433]]'),
    'earth': dict(radius=6378137.0, polar=6356752.314245, body='Earth', frame='IAU_EARTH', level=4, convention='ellipsoid-normal',
                  gcs=None),
}


def write_geographic(path, array, gt, wkt, nodata=None):
    drv = gdal.GetDriverByName('GTiff')
    h, w = array.shape
    dtype = gdal.GDT_Int16 if array.dtype == np.int16 else gdal.GDT_Float32
    ds = drv.Create(str(path), w, h, 1, dtype, options=['BLOCKYSIZE=1', 'INTERLEAVE=BAND'])
    ds.SetGeoTransform(gt)
    ds.SetProjection(wkt)
    band = ds.GetRasterBand(1)
    if nodata is not None:
        band.SetNoDataValue(nodata)
    band.WriteArray(array)
    ds.FlushCache()


def mars_base(src, work):
    ds = gdal.Open(str(Path(src) / 'MEGT90N000EB.LBL'))
    label = (Path(src) / 'MEGT90N000EB.LBL').read_text()
    assert (ds.RasterXSize, ds.RasterYSize) == (5760, 2880) and 'PLANETOCENTRIC' in label and 'WESTERNMOST_LONGITUDE        = 0.0' in label
    a = ds.GetRasterBand(1).ReadAsArray().astype(np.int16)
    # Column 0 is 0°E; roll so column 0 is 180°W.
    a = np.ascontiguousarray(np.concatenate([a[:, 2880:], a[:, :2880]], axis=1))
    out = work / 'mars-megt16.tif'
    write_geographic(out, a, (-180, 1 / 16, 0, 90, 0, -1 / 16), BODIES['mars']['gcs'])
    return out, str(Path(src) / 'MEGA90N000EB.LBL')


def earth_base(src, work):
    path = Path(src) / 'ETOPO_2022_v1_60s_surface.nc'
    try:
        ds = gdal.Open(f'NETCDF:"{path}":z')
        gt = ds.GetGeoTransform()
        a = ds.GetRasterBand(1).ReadAsArray().astype(np.float32)
        if gt[5] > 0:  # netCDF rows run south → north
            a = a[::-1]
            gt = (gt[0], gt[1], 0, gt[3] + gt[5] * ds.RasterYSize, 0, -gt[5])
    except RuntimeError:
        # GDAL builds without netCDF-4/HDF5: read the CF grid directly (pixel-is-area cell centres).
        import h5py
        with h5py.File(path, 'r') as f:
            lat, lon, a = f['lat'][:], f['lon'][:], f['z'][:].astype(np.float32)
        dlon, dlat = float(lon[1] - lon[0]), float(lat[1] - lat[0])
        if dlat > 0:
            a, lat, dlat = a[::-1], lat[::-1], -dlat
        gt = (float(lon[0]) - dlon / 2, dlon, 0, float(lat[0]) - dlat / 2, 0, dlat)
    assert abs(gt[0] + 180) < 1e-6 and abs(gt[3] - 90) < 1e-6, gt
    srs = osr.SpatialReference(); srs.ImportFromEPSG(4326)
    out = work / 'earth-etopo60.tif'
    write_geographic(out, np.ascontiguousarray(a), gt, srs.ExportToWkt())
    return out, None


def zero_fusion(base, work, python):
    """Fuse the base with an exact 2°×2° crop of itself: residual 0 everywhere."""
    ds = gdal.Open(str(base))
    gt = ds.GetGeoTransform()
    x0, y0 = int((0 - gt[0]) / gt[1]), int((gt[3] - 2) / -gt[5])
    n = int(round(2 / gt[1]))
    crop = ds.GetRasterBand(1).ReadAsArray(x0, y0, n, n).astype(np.float32)
    detail = work / 'self-crop.tif'
    write_geographic(detail, crop, (gt[0] + x0 * gt[1], gt[1], 0, gt[3] + y0 * gt[5], 0, gt[5]), ds.GetProjection(), nodata=float('nan'))
    fused = work / 'fused'
    if not (fused / 'fusion.json').exists():
        subprocess.run([python, DEM, 'fuse', '--base', str(base), '--detail', str(detail), '--out', str(fused), '--bias', 'none',
                        '--vertical-datum', 'zero-residual fixture: detail is an exact crop of the base'], check=True)
    return fused


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('body', choices=sorted(BODIES))
    p.add_argument('--source', required=True, help='directory holding the downloaded source files')
    p.add_argument('--work', required=True, help='scratch directory for converted rasters and the zero fusion')
    p.add_argument('--out', help='output product directory (default apps/viewer/test-catalogs/data/<body>-coarse-cube)')
    p.add_argument('--level', type=int, help='global cube level (default per body)')
    p.add_argument('--workers', type=int, default=min(8, os.cpu_count() or 1))
    a = p.parse_args()
    b = BODIES[a.body]
    work = Path(a.work); work.mkdir(parents=True, exist_ok=True)
    out = Path(a.out or ROOT / f'apps/viewer/test-catalogs/data/{a.body}-coarse-cube')
    if out.exists():
        raise SystemExit(f'Output already exists: {out}; choose a fresh --out')
    base, areoid = (mars_base if a.body == 'mars' else earth_base)(a.source, work)
    fused = zero_fusion(base, work, sys.executable)
    cmd = [sys.executable, DEM, 'cube-tile', '--base', str(base), '--fusion', str(fused), '--out', str(out),
           '--ellipsoid', str(b['radius']), str(b['polar']), '--body', b['body'], '--frame', b['frame'],
           '--source-convention', b['convention'], '--global-level', str(a.level if a.level is not None else b['level']),
           '--workers', str(a.workers)]
    if areoid:
        cmd += ['--areoid', areoid]
    subprocess.run(cmd, check=True)
    subprocess.run([sys.executable, DEM, 'cube-error', str(out), '--workers', str(a.workers)], check=True)
    (out / 'fixture.json').write_text(json.dumps({'purpose': 'coarse-terrain imagery fixture (#136)', 'body': b['body'],
                                                    'globalLevel': a.level if a.level is not None else b['level'], 'base': base.name}, indent=2))
    print(f'wrote {out}')


if __name__ == '__main__':
    main()
