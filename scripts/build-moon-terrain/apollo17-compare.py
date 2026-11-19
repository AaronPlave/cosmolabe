#!/usr/bin/env python3
"""Compare the pilot terrain shadow geometry with two held-out LROC images."""
import argparse
import gzip
from importlib.util import spec_from_file_location, module_from_spec
import json
import math
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory

import numpy as np
from osgeo import gdal
from PIL import Image, ImageDraw
from scipy.ndimage import binary_dilation, binary_erosion, binary_fill_holes, distance_transform_edt, find_objects, label
from scipy.stats import spearmanr
import spiceypy as spice

spec = spec_from_file_location('apollo17_pilot', Path(__file__).with_name('apollo17-pilot.py'))
pilot = module_from_spec(spec)
spec.loader.exec_module(pilot)

OBSERVATIONS = {
    'M109032389L': '2009-10-01T10:32:10',
    'M129086118L': '2010-05-21T13:00:54.5',
    'M131447374L': '2010-06-17T20:55:15.5',
}


def load_spice(kernels, scratch):
    for name in ('naif0012.tls', 'de440s.bsp', 'lro/moon_080317.tf.gz', 'lro/moon_pa_de421_1900_2050.bpc.gz'):
        path = kernels / name
        if path.suffix == '.gz':
            with gzip.open(path, 'rb') as source, (scratch / path.stem).open('wb') as out:
                shutil.copyfileobj(source, out)
            path = scratch / path.stem
        spice.furnsh(str(path))


def sun_at(utc):
    position = spice.spkpos('Sun', spice.str2et(utc), pilot.FRAME, 'LT+S', 'Moon')[0]
    lat, lon = map(math.radians, pilot.SITE)
    sl, cl, so, co = math.sin(lat), math.cos(lat), math.sin(lon), math.cos(lon)
    radial = np.array([cl * co, cl * so, sl])
    north = np.array([-sl * co, -sl * so, cl])
    east = np.array([-so, co, 0])
    sun = position - (pilot.RADIUS / 1000 - 2.642) * radial
    sun /= np.linalg.norm(sun)
    e, n, u = (sun @ axis for axis in (east, north, radial))
    return np.array([e, n, u]), math.degrees(math.atan2(e, n)) % 360, math.degrees(math.asin(u))


def average_valid(raster, values, valid, warp):
    band = gdal.GetDriverByName('MEM').Create('', raster.RasterXSize, raster.RasterYSize,
                                               1, gdal.GDT_Float32)
    band.SetGeoTransform(raster.GetGeoTransform())
    band.SetProjection(raster.GetProjection())
    band.GetRasterBand(1).SetNoDataValue(float('nan'))
    band.GetRasterBand(1).WriteArray(np.where(valid, values, np.nan))
    return gdal.Warp('', band, **warp).ReadAsArray()


def calibrated_holdout(path, original, reflectance, direct, valid, warp):
    """Compare relative errors on the same illuminated, well-conditioned samples."""
    ds = gdal.Open(str(path))
    values, phase, emission, incidence = ds.ReadAsArray()
    valid_native = (~pilot.special_mask(values) & (values >= pilot.DARK_IF) & (phase >= 15) & (phase <= 65)
                    & (emission >= 0) & (emission <= 85) & (incidence >= 0) & (incidence <= 80))
    measured = average_valid(ds, values, valid_native, warp)
    phase = average_valid(ds, phase, valid_native, warp)
    emission = average_valid(ds, emission, valid_native, warp)
    mask = (valid & (original > 0) & np.isfinite(reflectance) & np.isfinite(measured)
            & (direct > math.cos(math.radians(80))))
    if not mask.any():
        return {'samples': 0}
    angle = np.degrees(np.arccos(np.clip(direct[mask], 0, 1)))
    predictions = {
        'bakedTimesDiffuse': original[mask] * direct[mask],
        'normalizedTimesDiffuse': reflectance[mask] * direct[mask],
        'normalizedLrocEmpirical': reflectance[mask] * pilot.empirical(angle, emission[mask], phase[mask]) / pilot.empirical(*pilot.REFERENCE),
    }
    metrics = {}
    for model, prediction in predictions.items():
        residual = np.log(prediction / measured[mask])
        metrics[model] = {
            'medianAbsoluteLogErrorAfterOneGain': float(np.median(np.abs(residual - np.median(residual)))),
            'spearmanRho': float(spearmanr(prediction, measured[mask]).statistic),
        }
    return {'samples': int(mask.sum()), **metrics}


def shadow_contrast(observed, shadow, direct, valid):
    """Test visible darkness near modeled shadow boundaries without a global DN threshold."""
    connected, _ = label(shadow & valid)
    ratios = []
    for number, extent in enumerate(find_objects(connected), 1):
        region = tuple(slice(max(0, s.start - 10), min(size, s.stop + 10))
                       for s, size in zip(extent, connected.shape))
        component = connected[region] == number
        if component.sum() < 100:
            continue
        core = binary_erosion(component, iterations=2)
        adjacent = (binary_dilation(component, iterations=10) & ~shadow[region]
                    & valid[region] & (direct[region] > .05))
        if core.sum() >= 20 and adjacent.sum() >= 20:
            intensities = observed[region]
            nearby = np.median(intensities[adjacent])
            if nearby > 0:
                ratios.append(float(np.median(intensities[core]) / nearby))
    return {'components': len(ratios), 'darkerThanAdjacent': sum(value < 1 for value in ratios),
            'medianCoreToAdjacentSignal': float(np.median(ratios)) if ratios else None}


def compare(args):
    terrain = pilot.open_terrain(args.data / f'{pilot.DTM_ID}.IMG')
    maps = {}
    target_size = (920, 840)
    centre_x = pilot.RADIUS * math.cos(math.radians(20)) * math.radians(pilot.SITE[1] - 180)
    centre_y = pilot.RADIUS * math.radians(pilot.SITE[0])
    west = round(centre_x) - target_size[0]
    east = west + 2 * target_size[0]
    south = round(centre_y) - target_size[1]
    north = south + 2 * target_size[1]
    warp = dict(format='MEM', outputBounds=(west, south, east, north),
                width=target_size[0], height=target_size[1], resampleAlg='average')
    reflectance = gdal.Warp('', str(args.normalized), **warp).ReadAsArray() if args.normalized else None
    original = None
    if args.normalized:
        source = gdal.Open(str(args.data / 'M109032389L-native.tif'))
        values = source.GetRasterBand(1).ReadAsArray()
        original = average_valid(source, values, ~pilot.special_mask(values) & (values >= 0), warp)
    roi = gdal.Warp('', terrain, **warp)
    height = roi.ReadAsArray()
    good_terrain = ~pilot.special_mask(height)
    height[~good_terrain] = np.nan
    d_south, d_east = np.gradient(height, 2)
    norm = np.sqrt(1 + d_south**2 + d_east**2)
    base = None
    result = {}
    for id, utc in OBSERVATIONS.items():
        image = gdal.Open(str(args.data / (id + '-browse.tif')))
        observed = gdal.Warp('', image, **warp).ReadAsArray()
        # Exclude the browse swath edge. Interior hard shadows remain valid.
        footprint = binary_fill_holes(observed > 9)
        interior = distance_transform_edt(np.pad(footprint, 1))[1:-1, 1:-1] > 12
        if base is None:
            base = interior & good_terrain
        valid = base & interior & good_terrain
        direction, azimuth, elevation = sun_at(utc)
        incidence_cos = np.maximum(0, (-d_east * direction[0] + d_south * direction[1] + direction[2]) / norm)
        _, shadow = pilot.terrain_on_photo(terrain, roi, azimuth, elevation)
        direct = incidence_cos * ~shadow
        lit = valid & (observed > 15) & ~shadow & np.isfinite(incidence_cos)
        metric = {
            'utc': utc + 'Z', 'sunAzimuthDegrees': azimuth, 'sunElevationDegrees': elevation,
            'common2mSamples': int(valid.sum()), 'modeledCastFraction': float(shadow[valid].mean()),
            'litSpearmanRho': float(spearmanr(observed[lit], direct[lit]).statistic),
        }
        if reflectance is not None and id != 'M109032389L':
            raw = args.data / (id + '-native.tif')
            if raw.is_file():
                metric['calibratedHoldout'] = calibrated_holdout(raw, original, reflectance, direct, valid, warp)
        if id == 'M131447374L':
            # These are thresholds in a display image. Show how the agreement
            # changes with threshold and keep the underlying visual comparison.
            metric['darkProxy'] = {}
            metric['castComponentContrast'] = shadow_contrast(observed, shadow, direct, valid)
            if args.normalized and raw.is_file():
                ds = gdal.Open(str(raw))
                values = ds.GetRasterBand(1).ReadAsArray()
                measured = average_valid(ds, values, ~pilot.special_mask(values) & (values >= 0), warp)
                metric['calibratedCastComponentContrast'] = shadow_contrast(
                    measured, shadow, direct, valid & np.isfinite(measured))
            for limit in (24, 30, 36):
                dark = (observed <= limit) & valid
                simulated = shadow & valid
                metric['darkProxy'][str(limit)] = {
                    'observedFraction': float(dark.sum() / valid.sum()),
                    'intersectionOverUnion': float((dark & simulated).sum() / (dark | simulated).sum()),
                    'fractionOfDarkCaught': float((dark & simulated).sum() / dark.sum()) if dark.any() else None,
                }
        result[id] = metric
        photo_display = np.sqrt(observed / 255)
        diffuse_display = np.sqrt(np.where(valid & np.isfinite(direct), direct, 0) * .8)
        panels = [('LROC browse observation', photo_display), ('2 m DTM diffuse + cast shadow', diffuse_display)]
        if reflectance is not None:
            simulated = np.sqrt(np.where(valid & np.isfinite(direct * reflectance), direct * reflectance, 0) * 4)
            panels.append(('Normalized NAC × terrain illumination', simulated))
        maps[id] = panels
    assert all(m['common2mSamples'] > 100_000 for m in result.values()), 'Insufficient common valid terrain and imagery'
    assert result['M131447374L']['sunElevationDegrees'] < 13
    assert result['M109032389L']['sunElevationDegrees'] > 65
    print(json.dumps(result, indent=2))
    figure = Image.new('RGB', (1096, 720 if reflectance is None else 1064), '#151719')
    draw = ImageDraw.Draw(figure)
    for i, (id, panels) in enumerate(maps.items()):
        x = 10 + i * 364
        m = result[id]
        draw.text((x, 9), f'{id}   Sun {m["sunElevationDegrees"]:.1f}° at {m["sunAzimuthDegrees"]:.1f}°', fill='white')
        for row, (name, img) in enumerate(panels):
            top = 34 + row * 344
            panel = Image.fromarray(np.clip(np.rint(img * 255), 0, 255).astype(np.uint8))
            figure.paste(panel.resize((350, 320), Image.Resampling.LANCZOS), (x, top + 10))
            draw.text((x, top - 6), name, fill='white')
    figure.save(args.figure, quality=91)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('data', type=Path)
    parser.add_argument('kernels', type=Path)
    parser.add_argument('figure', type=Path)
    parser.add_argument('--normalized', type=Path, help='also evaluate a native normalized I/F raster against archived calibrated holdouts')
    args = parser.parse_args()
    gdal.UseExceptions()
    with TemporaryDirectory() as scratch:
        load_spice(args.kernels, Path(scratch))
        compare(args)


if __name__ == '__main__':
    main()
