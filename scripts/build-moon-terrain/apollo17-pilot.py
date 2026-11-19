#!/usr/bin/env python3
"""Prepare the registered Apollo 17 terrain and original/normalized NAC products."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

import numpy as np
from osgeo import gdal, osr
from scipy.ndimage import affine_transform, distance_transform_edt

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'terrain'))
import cube_imagery as cube

RADIUS = 1737400
FRAME = 'MOON_ME_DE421'
SITE = (20.190, 30.794)
DTM_ID = 'NAC_DTM_APOLLO17_1_E199N0308'
PHOTO_ID = 'NAC_PHO_E199N0308_M109032389L'
DTM_SHA256 = '159d409ad7ac96959b3b69ae5f42cfeec94f6a678e3c5773197594ec2c539ddb'
NATIVE_PHOTO_ANGLES = (183.2, 68.31)  # LROC product summary, azimuth and elevation in degrees
REFERENCE = (30, 0, 30)  # incidence, emission, phase
DARK_IF = 0.02
MAX_DISPLAY_GAIN = 4.0


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def native_geographic(ds):
    """Re-express the published EQC affine in degrees without resampling pixels."""
    srs = ds.GetSpatialRef()
    gt = ds.GetGeoTransform()
    if (srs.GetAttrValue('PROJECTION') != 'Equirectangular'
            or abs(srs.GetSemiMajor() - RADIUS) > 1e-6 or srs.GetInvFlattening() != 0 or srs.GetLinearUnits() != 1
            or srs.GetProjParm('central_meridian') != 180 or srs.GetProjParm('standard_parallel_1') != 20
            or any(srs.GetProjParm(key) for key in ('latitude_of_origin', 'false_easting', 'false_northing'))
            or gt[1] <= 0 or gt[5] >= 0 or gt[2] or gt[4]):
        raise ValueError('Expected the native Apollo 17 equirectangular grid')
    deg_per_m = math.degrees(1 / RADIUS)
    x_to_lon = deg_per_m / math.cos(math.radians(20))
    return (180 + gt[0] * x_to_lon, gt[1] * x_to_lon, 0, gt[3] * deg_per_m, 0, gt[5] * deg_per_m)


def special_mask(values):
    return ~np.isfinite(values) | (values.view(np.uint32) >= 0xff7ffffb)


def open_terrain(path):
    if digest(path) != DTM_SHA256:
        raise ValueError(f'Expected the pinned {DTM_ID} PDS payload')
    ds = gdal.Open(str(path))
    if ds.GetMetadataItem('PRODUCT_ID') != DTM_ID or ds.RasterCount != 1:
        raise ValueError('Unexpected Apollo 17 DTM')
    return ds


def prepare_terrain(path, output):
    ds = open_terrain(path)
    heights = ds.ReadAsArray()
    valid = ~special_mask(heights)
    # Pad so valid data touching a raster edge also feathers into the fallback.
    edge_m = distance_transform_edt(np.pad(valid, 1))[1:-1, 1:-1] * ds.GetGeoTransform()[1]
    weight = np.minimum(1, edge_m / 160).astype(np.float32)
    # Smoothstep keeps the normal continuous where the blend begins and ends.
    weight = weight * weight * (3 - 2 * weight)
    raster = create_raster(output, ds, 2)
    raster.SetGeoTransform(native_geographic(ds))
    raster.SetSpatialRef(ds.GetSpatialRef().CloneGeogCS())
    raster.SetMetadataItem('PRODUCT_ID', DTM_ID)
    raster.SetMetadataItem('PDS_SOURCE_SHA256', DTM_SHA256)
    raster.GetRasterBand(1).WriteArray(np.where(valid, heights, 0) * weight)
    raster.GetRasterBand(2).WriteArray(weight)
    raster.Close()
    print(f'DTM valid {int(valid.sum()):,}/{valid.size:,}; elevation {heights[valid].min():.2f} to {heights[valid].max():.2f} m')


def create_raster(path, src, bands):
    out = gdal.GetDriverByName('GTiff').Create(str(path), src.RasterXSize, src.RasterYSize,
                                               bands, gdal.GDT_Float32, ['TILED=YES', 'COMPRESS=DEFLATE', 'PREDICTOR=3'])
    out.SetGeoTransform(src.GetGeoTransform())
    out.SetProjection(src.GetProjection())
    return out


def empirical(incidence, emission, phase):
    """ISIS lronacpho 2019 LROC Empirical, phase in degrees."""
    mu0 = np.cos(np.radians(incidence))
    mu = np.cos(np.radians(emission))
    return mu0 / (mu + mu0) * np.exp(
        -1.479654495 - 0.000083528 * phase**2 + 0.012964707 * phase
        - 0.237774774 * np.sqrt(phase) + 0.556075496 * mu
        + 0.663671460 * mu0 - 0.439918609 * mu0**2)


def cast_shadows(heights, post_m, azimuth_deg, elevation_deg, bias_m=2):
    """Trace a directional horizon across the native DTM; only measured occluders count."""
    az = math.radians(azimuth_deg)
    dc, dr = math.sin(az), -math.cos(az)
    transpose = abs(dr) > abs(dc)
    if transpose:
        heights, dc, dr = heights.T, dr, dc
    flip = dc < 0
    if flip:
        heights, dc = heights[:, ::-1], -dc
    height, width = heights.shape
    shear = dr / dc
    offset = min(0., -shear * (width - 1))
    aligned = affine_transform(heights, [[1, shear], [0, 1]], offset=[offset, 0],
                               output_shape=(height + math.ceil(abs(shear) * width) + 1, width),
                               order=1, cval=np.nan)
    rise = math.tan(math.radians(elevation_deg)) * post_m / dc
    aligned -= np.arange(width, dtype=np.float32) * rise
    horizon = np.maximum.accumulate(np.where(np.isfinite(aligned), aligned, -np.inf)[:, ::-1], axis=1)[:, ::-1]
    shadows = np.zeros_like(aligned, dtype=np.uint8)
    shadows[:, :-1] = horizon[:, 1:] > aligned[:, :-1] + bias_m
    mask = affine_transform(shadows, [[1, -shear], [0, 1]], offset=[-offset, 0],
                            output_shape=heights.shape, order=0)
    if flip:
        mask = mask[:, ::-1]
    return mask.T if transpose else mask


def terrain_on_photo(terrain, photo, azimuth, elevation):
    # Both labels use the same map projection. Include solar occluders beyond the crop.
    gt = terrain.GetGeoTransform()
    px, dx, _, py, _, dy = photo.GetGeoTransform()
    margin = 3500
    xmin, xmax = px - margin, px + dx * photo.RasterXSize + margin
    ymin, ymax = py + dy * photo.RasterYSize - margin, py + margin
    x0, y0 = max(0, math.floor((xmin - gt[0]) / gt[1])), max(0, math.floor((ymax - gt[3]) / gt[5]))
    x1 = min(terrain.RasterXSize, math.ceil((xmax - gt[0]) / gt[1]))
    y1 = min(terrain.RasterYSize, math.ceil((ymin - gt[3]) / gt[5]))
    z = terrain.ReadAsArray(x0, y0, x1 - x0, y1 - y0)
    z[special_mask(z)] = np.nan
    shadow = cast_shadows(z, gt[1], azimuth, elevation)
    offset = [(py + dy / 2 - gt[3]) / gt[5] - y0 - .5, (px + dx / 2 - gt[0]) / gt[1] - x0 - .5]
    matrix = [[dy / gt[5], 0], [0, dx / gt[1]]]
    shape = (photo.RasterYSize, photo.RasterXSize)
    valid = affine_transform(np.isfinite(z).astype(np.uint8), matrix, offset, output_shape=shape, order=0)
    shadow = affine_transform(shadow, matrix, offset, output_shape=shape, order=0)
    return valid.astype(bool), shadow.astype(bool)


def bounds(ds):
    x, dx, _, y, _, dy = native_geographic(ds)
    return [x, y + dy * ds.RasterYSize, x + dx * ds.RasterXSize, y]


def prepare_imagery(args):
    terrain = open_terrain(args.dtm)
    photo = gdal.Open(str(args.photo))
    extent = bounds(photo)
    if photo.GetMetadataItem('PRODUCT_ID') != PHOTO_ID or photo.RasterCount != 4:
        raise ValueError(f'Expected the native four-band {PHOTO_ID} crop')
    values, phase, emission, incidence = photo.ReadAsArray()
    original = ~special_mask(values) & (values >= 0)
    angles = ((phase >= 15) & (phase <= 65) & (emission >= 0) & (emission <= 85)
              & (incidence >= 0) & (incidence <= 80))
    ground, shadow = terrain_on_photo(terrain, photo, *NATIVE_PHOTO_ANGLES)
    corrected = original & angles & ground & ~shadow & (values >= DARK_IF)
    if not corrected.any():
        raise ValueError('The crop has no usable corrected samples')
    normalized = np.full_like(values, np.nan)
    normalized[corrected] = (values[corrected] * empirical(*REFERENCE)
                             / empirical(incidence[corrected], emission[corrected], phase[corrected]))
    display_gain = min(MAX_DISPLAY_GAIN, 1 / max(float(values[original].max()), float(normalized[corrected].max())))
    args.work.mkdir(parents=True, exist_ok=True)
    raw = create_raster(args.work / 'normalized-if.tif', photo, 1)
    raw.GetRasterBand(1).SetNoDataValue(float('nan'))
    raw.GetRasterBand(1).WriteArray(normalized)
    raw.Close()
    source = {
        'kind': 'imagery', 'product': PHOTO_ID, 'productVersion': photo.GetMetadataItem('PDS_SOURCE_VERSION'),
        'url': photo.GetMetadataItem('PDS_SOURCE_URL'), 'attribution': 'NASA / LROC',
        'startUtc': photo.GetMetadataItem('START_TIME'), 'stopUtc': photo.GetMetadataItem('STOP_TIME'),
        'nativeWindow': photo.GetMetadataItem('PDS_NATIVE_WINDOW'), 'nativeCropSha256': digest(args.photo),
        'bounds': extent, 'mapPixelMeters': photo.GetGeoTransform()[1],
        'acquisitionPixelMeters': 0.54, 'displayLinearGain': display_gain,
        'terrainProduct': DTM_ID, 'terrainSha256': DTM_SHA256,
    }
    audit = {
        **source, 'samples': int(values.size), 'originalValid': int(original.sum()),
        'commonWithTerrain': int((original & ground).sum()),
        'outsidePhotometricDomain': int((original & ~angles).sum()),
        'modeledCastShadow': int((original & ground & shadow).sum()),
        'darkTail': int((original & (values < DARK_IF)).sum()),
        'normalizedValid': int(corrected.sum()),
        'anglesDegP01P50P99': {key: np.quantile(v[original], [.01, .5, .99]).tolist()
                               for key, v in [('phase', phase), ('emission', emission), ('incidence', incidence)]},
    }
    (args.work / 'imagery-audit.json').write_text(json.dumps(audit, indent=2) + '\n')
    print(json.dumps(audit, indent=2), flush=True)
    if args.prepare_only:
        return
    pack_imagery(args, photo, 'original', values, original, source, display_gain * 255)
    metadata = {**source, 'photometry': {
        'model': 'ISIS lronacpho LROC Empirical 2019 evaluated on archived per-pixel backplanes',
        'referenceDegrees': dict(zip(('incidence', 'emission', 'phase'), REFERENCE)),
        'acceptedDegrees': {'incidence': [0, 80], 'emission': [0, 85], 'phase': [15, 65]},
        'mask': 'PDS special pixels, missing DTM, modeled cast shadows and I/F below 0.02',
    }}
    pack_imagery(args, photo, 'normalized', normalized, corrected, metadata, display_gain * 255)


def prepare_browse(args):
    photo = gdal.Open(str(args.photo))
    if photo.GetMetadataItem('PRODUCT_ID') != PHOTO_ID or photo.RasterCount != 1:
        raise ValueError(f'Expected the official {PHOTO_ID} browse crop')
    values = photo.ReadAsArray()
    # Browse JPEG has no validity band and may ring around black missing pixels.
    # The high-Sun base image is used only as a baked fallback.
    valid = values > 5
    if not valid.any():
        raise ValueError('No valid browse imagery')
    source = {
        'kind': 'imagery', 'product': PHOTO_ID, 'attribution': 'NASA / LROC',
        'url': photo.GetMetadataItem('BROWSE_URL'),
        'nativeWindow': photo.GetMetadataItem('BROWSE_NATIVE_WINDOW'),
        'nativeCropSha256': digest(args.photo), 'bounds': bounds(photo),
        'mapPixelMeters': photo.GetGeoTransform()[1], 'acquisitionPixelMeters': 0.54,
        'encodingNote': 'LROC display-stretched browse JPEG. DN/255 used as unitless linear display intensity. DN ≤ 5 transparent.',
    }
    pack_imagery(args, photo, 'original', values, valid, source, 1)


def pack_imagery(args, photo, name, samples, valid, metadata, gain):
    args.work.mkdir(parents=True, exist_ok=True)
    registration = {
        'crsId': f'cosmolabe:cube-gnomonic-1/{FRAME}', 'pixelConvention': 'corner',
        'latitude': 'planetocentric', 'registrationErrorKm': None,
        'footprint': 'PDS native EQC window; archive bundle adjustment to the Apollo 17 DTM',
        'resampling': 'linear-light area-averaged premultiplied validity overviews, 2x2 cube quadrature, then 8-bit sRGB PNG',
    }
    region = cube.parse_cube_region(f'apollo17@{SITE[0]},{SITE[1]}:' + ','.join(f'{i}=2.3' for i in range(1, 16)))
    tiles = cube.select_tiles(0, [region])
    out = args.out / f'moon-imagery-cube-apollo17-{name}'
    if out.exists():
        raise ValueError(f'Expected a fresh output directory: {out}')
    display = np.where(valid, samples, 0) * gain
    if np.any(display > 255.00001):
        raise ValueError(f'{name}: display gain would clip measured values')
    prepared = args.work / f'{name}-weighted.tif'
    ds = create_raster(prepared, photo, 2)
    # Zero-origin EQC lets the existing cube builder vectorize sampling. The
    # Apollo EQC has a linear lon/lat affine, so this only changes coordinates.
    srs = osr.SpatialReference()
    srs.ImportFromProj4(f'+proj=eqc +lat_ts=0 +lon_0=0 +R={RADIUS} +units=m +no_defs')
    ds.SetSpatialRef(srs)
    ds.SetGeoTransform(tuple(math.radians(v) * RADIUS for v in native_geographic(photo)))
    ds.SetMetadataItem('COSMOLABE_PREMULTIPLIED_VALIDITY', '1')
    ds.GetRasterBand(1).WriteArray(display)
    ds.GetRasterBand(2).WriteArray(valid.astype(np.float32))
    ds.BuildOverviews('AVERAGE', [2**level for level in range(1, 12)])
    ds.Close()
    metadata = {**metadata, 'id': f'apollo17-{name}', 'validSamples': int(valid.sum())}
    args.out.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=f'{out.name}.build.', dir=args.out) as scratch:
        product = Path(scratch) / out.name
        job = argparse.Namespace(source=str(prepared), out=str(product), body='Moon', tile_size=256, gutter=4,
                                 supersample=2, workers=args.workers, region=[region['levels']], global_level=0, encode_srgb=True)
        builder = digest(Path(__file__))
        cube.run(job, 'raster', tiles, metadata, registration, 'srgb', extra={'processingSha256': builder})
        manifest = product / 'imagery.json'
        built = json.loads(manifest.read_text())
        inputs = 'DTM PHOTO' if args.command == 'imagery' else 'BROWSE_PHOTO'
        built['generator']['command'] = f'python scripts/build-moon-terrain/apollo17-pilot.py {args.command} {inputs} WORK VIEWER_DATA'
        built['generator']['builderSha256'] = builder
        built['generator'].pop('seconds')
        manifest.write_text(json.dumps(built, indent=1) + '\n')
        product.rename(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    terrain = sub.add_parser('terrain')
    terrain.add_argument('dtm', type=Path)
    terrain.add_argument('output', type=Path)
    imagery = sub.add_parser('imagery')
    imagery.add_argument('dtm', type=Path)
    imagery.add_argument('--prepare-only', action='store_true')
    browse = sub.add_parser('browse')
    for input_parser in (imagery, browse):
        input_parser.add_argument('photo', type=Path)
        input_parser.add_argument('work', type=Path)
        input_parser.add_argument('out', type=Path)
        input_parser.add_argument('--workers', type=int, default=2)
    args = parser.parse_args()
    gdal.UseExceptions()
    gdal.SetCacheMax(64 * 1024 * 1024)
    if args.command == 'terrain':
        prepare_terrain(args.dtm, args.output)
    elif args.command == 'imagery':
        prepare_imagery(args)
    else:
        prepare_browse(args)


if __name__ == '__main__':
    main()
