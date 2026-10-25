#!/usr/bin/env python3
"""Compare original terrain sources without using Ingenuity observations.

CTX LVS is the published registration parent of HiRISE, not an independent
absolute truth. This audit measures the effect of removing the historical plane
against that parent over a systematic native-pixel sample of the full DTM.
"""
import argparse
import json
import math
from pathlib import Path
import numpy as np
from osgeo import gdal
from audit_ingenuity import geographic_transform, pin, sample_raster, stats

gdal.UseExceptions()


def compare(base, detail, reference, fusion):
    ds = gdal.Open(str(detail))
    gt = geographic_transform(ds)
    band = ds.GetRasterBand(1)
    # Original pixel centres, every 256 native pixels. Read native scanlines;
    # never use GDAL overviews or resample the detail before the comparison.
    xs = np.arange(128, ds.RasterXSize - 2, 256)
    ys = np.arange(128, ds.RasterYSize - 2, 256)
    raw = np.stack([band.ReadAsArray(0, int(y), ds.RasterXSize, 1)[0, xs] for y in ys])
    mask = np.stack([band.GetMaskBand().ReadAsArray(0, int(y), ds.RasterXSize, 1)[0, xs] for y in ys]) > 0
    mask &= np.isfinite(raw) & (np.abs(raw) < 1e5)
    if band.GetNoDataValue() is not None:
        mask &= raw != band.GetNoDataValue()
    lon, lat = np.meshgrid(gt[0] + (xs + .5) * gt[1], gt[3] + (ys + .5) * gt[5])
    lon, lat, raw = lon[mask], lat[mask], raw[mask].astype(float)
    parent = sample_raster(reference, lon, lat, cubic=True)
    baseline = sample_raster(base, lon, lat, cubic=True)
    reg = json.loads((Path(fusion) / 'fusion.json').read_text())['registration']
    centre = reg['centroid']
    k = ds.GetSpatialRef().GetSemiMajor() * math.pi / 180 / 1000
    east = (lon - centre['lonDeg']) * k * math.cos(math.radians(centre['latDeg']))
    north = (lat - centre['latDeg']) * k
    plane = reg['offsetM'] + east * reg['slopeEastMPerKm'] + north * reg['slopeNorthMPerKm']
    return dict(kind='terrain-registration-source-comparison',
                referenceUrl='https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/CTX/DTM_MOLAtopography_DeltaGeoid_20m_Jezero_F05X_v7pt1_Eqc_latTs0_lon0.tif',
                inputs={k: pin(p) for k, p in [('base', base), ('detail', detail), ('ctxLvs', reference)]},
                sampling=dict(method='Every 256th native pixel centre, starting at (128,128); original detail mask; cubic comparison kernels',
                              count=len(raw), excluded=int(mask.size-mask.sum()), observationInputs=[]),
                detailMinusCtxM=stats(raw-parent), planeRemovedDetailMinusCtxM=stats(raw-plane-parent),
                baseMinusCtxM=stats(baseline-parent), fittedPlaneM=stats(plane),
                decision='Keep original authored HiRISE heights; do not subtract the fitted plane to the lower-resolution global base.',
                rationale='The TRN production paper documents HiRISE vertical/tilt adjustment to CTX LVS, itself aligned to HRSC. Subtracting a new plane against another global raster would replace that control without an independent higher-quality reference. CTX comparison is corroboration of the published control chain, not independent absolute validation.',
                evidenceUrl='https://www.hou.usra.edu/meetings/lpsc2020/pdf/2020.pdf',
                limitations=['Native post spacing is not effective terrain resolution or vertical accuracy.',
                             'Systematic grid sample is not exhaustive validation.',
                             'CTX and HiRISE share registration provenance; absolute accuracy remains unknown.'])


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for name in ['base', 'detail', 'reference', 'fusion', 'out']:
        p.add_argument('--'+name, required=True, type=Path)
    a = p.parse_args()
    a.out.write_text(json.dumps(compare(a.base, a.detail, a.reference, a.fusion), indent=2)+'\n')
